// session.js — the guided measurement session state machine.
//
// A session walks: for each position → for each physical output → sweep,
// extract IR, compute delay + magnitude. When all positions are done:
// spatial average, EQ + delay recommendations, wait for human Apply.
//
// ROUTING MODEL: measurement happens per PHYSICAL OUTPUT (config.
// physicalOutputs) so each driver's own geometry/health can be checked, but
// every result is tagged with its source BUS id (outputId = bus.id) — that's
// the only thing recommendEQ/recommendDelays ever see, and the only thing
// apply() ever writes to. A bus with multiple physical outputs (e.g. stereo
// "mains" -> main_l_out + main_r_out) gets its correction from spatialAverage
// pooling ALL of their result rows together — no special-casing needed,
// spatialAverage doesn't care whether multiple rows sharing one outputId came
// from different mic positions, different physical outputs, or both.
//
// Shared-driver physical outputs (config.physicalOutputs[].sharedDrivers,
// e.g. one "Side Fills" output driving two boxes via a passive split) can't
// be isolated electronically — only by the operator physically unplugging a
// cable. runSharedDriverWizard()/wizardContinue()/wizardConfirm() implement
// that guided flow; the two individual-driver sweeps it produces are kept
// OUT of `results` (so they never pollute the bus correction) and instead
// feed a driver-health comparison (polarity/level/response deviation).
//
// Modes:
//   'verify'  — one position (config room.verifyPosition), all physical
//               outputs (no wizard — fast check), compares against baseline.
//   'full'    — all positions, all physical outputs, wizard for shared
//               drivers, produces recommendations.

import { makeESS, makeBlip, scaleBuffer, extractIR, findDelay, magnitudeResponse,
         polarity, rmsDbfs, isClipped, estimateSnrDb, peakDbfs }
  from '../dsp/measure.js';
import { spatialAverage, targetOnGrid, recommendEQ, recommendDelays }
  from '../dsp/tune.js';
import { buildAnalysisPayload, claudeTune, validate } from './advisor.js';
import { activeTargetCurve } from '../config/settings.js';
import { splToDbfs } from '../audio/loudness-monitor.js';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DATA_DIR = 'data';
const MAX_SESSION_HISTORY = 5;
const LOW_CONFIDENCE_THRESHOLD = 3;
const LOW_SNR_THRESHOLD_DB = 15;
const DEFAULT_MIN_SNR_MARGIN_DB = 20;
const DEFAULT_AMBIENT_CHECK_SECONDS = 1;
const MIN_SWEEP_LEVEL_DBFS = -60;
const MAX_SWEEP_LEVEL_DBFS = -6;

/**
 * Effective base sweep level in dBFS. When audio.splDbOffset has been
 * calibrated (see loudness-monitor.js's one-time Calibrate flow), computes
 * the dBFS needed to hit audio.sweep.targetSplDb via splToDbfs -- the exact
 * inverse of the loudness monitor's own dbfsToSpl -- so every sweep reuses
 * that one calibration automatically, with no per-sweep/per-position manual
 * SPL reading. Falls back to the fixed audio.sweep.levelDbfs when
 * uncalibrated. Exported so Settings can show the same computed value.
 */
export function computeSweepLevelDbfs(audioCfg) {
  const s = audioCfg.sweep;
  if (audioCfg.splDbOffset === null || audioCfg.splDbOffset === undefined) {
    return { levelDbfs: s.levelDbfs, calibrated: false };
  }
  const needed = splToDbfs(s.targetSplDb, audioCfg.splDbOffset);
  const levelDbfs = Math.min(MAX_SWEEP_LEVEL_DBFS, Math.max(MIN_SWEEP_LEVEL_DBFS, needed));
  return { levelDbfs, calibrated: true, uncappedLevelDbfs: needed };
}

/** List saved session records, newest first. At most MAX_SESSION_HISTORY
 *  files ever exist, so reading each one fully for its metadata is cheap.
 *  `dataDir` defaults to the app's real data dir; tests pass a temp dir so
 *  they never touch the operator's actual session history on disk. */
export function listSessionHistory(dataDir = DEFAULT_DATA_DIR) {
  const dir = path.resolve(dataDir, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort().reverse()
    .map((f) => {
      const rec = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return {
        id: rec.id, mode: rec.mode, room: rec.room,
        startedAt: rec.startedAt, finishedAt: rec.finishedAt,
        source: rec.recommendations?.source ?? null,
        applied: rec.recommendations?.applied ?? false
      };
    });
}

/** Delete session record files beyond the newest MAX_SESSION_HISTORY. */
function pruneSessionHistory(sessionsDir) {
  if (!fs.existsSync(sessionsDir)) return;
  const files = fs.readdirSync(sessionsDir).filter((f) => f.endsWith('.json')).sort();
  const excess = files.length - MAX_SESSION_HISTORY;
  for (let i = 0; i < excess; i++) fs.unlinkSync(path.join(sessionsDir, files[i]));
}

export class TuneSession {
  constructor({ config, room, audio, wing, emit, dataDir = DEFAULT_DATA_DIR }) {
    this.cfg = config;
    this.dataDir = dataDir;
    this.baselinePath = path.resolve(dataDir, 'baseline.json');
    this.sessionsDir = path.resolve(dataDir, 'sessions');
    this.room = room;
    this.audio = audio;
    this.wing = wing;
    this.emit = emit; // (event, payload) → websocket broadcast

    this.mode = null;
    this.positions = [];
    this.posIndex = 0;
    this.results = [];             // bus-layer rows only -- feed recommendations
    this.driverHealthResults = []; // shared-driver individual sweeps -- health-check only, never corrected
    this.driverHealthReports = []; // { physicalOutputId, positionId, driverA, driverB, ..., flags[] }
    this.state = 'idle';           // idle | waiting_position | measuring | wizard | preflight | review | done
    this.wizard = null;            // active shared-driver wizard step, or null
    this.recommendations = null;
    this.preflightResults = [];

    const s = config.audio.sweep;
    const { levelDbfs: effectiveLevelDbfs, calibrated: sweepLevelCalibrated } = computeSweepLevelDbfs(config.audio);
    this.sweepLevelCalibrated = sweepLevelCalibrated;
    this.baseSweepLevelDbfs = effectiveLevelDbfs;
    const { sweep, inverse } = makeESS({ ...s, levelDbfs: effectiveLevelDbfs, sampleRate: config.audio.sampleRate });
    this.sweep = sweep;
    this.inverse = inverse;
    this.captureSeconds = s.seconds + s.padSeconds;

    const pf = config.audio.preflight || {};
    this.blipSeconds = pf.blipSeconds ?? 1;
    this.blipLevelDbfs = s.levelDbfs;
    this.blipCaptureSeconds = pf.captureSeconds ?? (this.blipSeconds + 0.4);
  }

  /**
   * Build a test tone centered inside a bus's configured band, not a fixed
   * broadband frequency — a sub (e.g. band [25, 120]) will never pass a
   * generic 1 kHz blip, that's the crossover doing its job, not a routing
   * failure. Frequency is the band's geometric mean, nudged in from the
   * edges so a steep filter right at the crossover point doesn't attenuate
   * the tone. `seconds` override is used by the wizard's shorter confidence blip.
   */
  blipForOutput(bus, { seconds } = {}) {
    const [lo, hi] = bus.band || [20, 20000];
    const mid = Math.sqrt(lo * hi);
    const freq = Math.min(Math.max(mid, lo * 1.2), hi * 0.8);
    return makeBlip({
      freq, seconds: seconds ?? this.blipSeconds,
      sampleRate: this.cfg.audio.sampleRate, levelDbfs: this.blipLevelDbfs
    });
  }

  activePhysicalOutputs() {
    return this.cfg.physicalOutputs.filter((o) => o.enabled !== false);
  }

  /** Every bus fed by at least one active physical output — what
   *  soloOutput()/unmuteAll() operate on. */
  activeBuses() {
    const busIds = new Set(this.activePhysicalOutputs().map((o) => o.sourceBusId));
    return this.cfg.buses.filter((b) => busIds.has(b.id));
  }

  busFor(physicalOutput) {
    return this.cfg.buses.find((b) => b.id === physicalOutput.sourceBusId);
  }

  snapshot() {
    const w = this.wizard;
    const wizardDrivers = w?.physicalOutput.sharedDrivers?.drivers || [];
    return {
      state: this.state,
      mode: this.mode,
      positions: this.positions.map((p, i) => ({
        ...p, status: i < this.posIndex ? 'done' : i === this.posIndex ? 'current' : 'pending'
      })),
      posIndex: this.posIndex,
      results: this.results.map(({ freqs, magDb, ...meta }) => meta), // meters only, traces sent separately
      recommendations: this.recommendations,
      preflightResults: this.preflightResults,
      currentRecordId: this.currentRecordId ?? null,
      wizard: w ? {
        physicalOutputId: w.physicalOutputId,
        label: w.physicalOutput.label,
        step: w.step,                                  // 'instruct' | 'confirm'
        isCombinedStep: w.driverIndex >= wizardDrivers.length,
        currentDriverLabel: w.driverIndex < wizardDrivers.length ? wizardDrivers[w.driverIndex].label : 'both',
        allDriverLabels: wizardDrivers.map((d) => d.label),
        driverIndex: w.driverIndex
      } : null,
      pendingPatches: this.wing.hasPendingPatches ? this.wing.hasPendingPatches() : false
    };
  }

  start(mode) {
    if (this.state !== 'idle' && this.state !== 'done' && this.state !== 'review') {
      throw new Error('session already running');
    }
    this.mode = mode;
    this.results = [];
    this.driverHealthResults = [];
    this.driverHealthReports = [];
    this.wizard = null;
    this.recommendations = null;
    this.currentRecordId = null;
    this.startedAt = new Date().toISOString();
    this.positions = mode === 'verify'
      ? this.room.positions.filter((p) => p.id === this.room.verifyPosition)
      : [...this.room.positions];
    // Skip positions the operator has disabled (e.g. a spot that's
    // temporarily unreachable/irrelevant) -- mirrors activePhysicalOutputs()'s
    // `enabled !== false` pattern so undefined/missing still means enabled.
    this.positions = this.positions.filter((p) => p.enabled !== false);
    this.posIndex = 0;
    this.state = 'waiting_position';
    this.emit('session', this.snapshot());
  }

  /** Phone tapped Ready at the current mic position. */
  async ready() {
    if (this.state !== 'waiting_position') return;
    this.state = 'measuring';
    const pos = this.positions[this.posIndex];
    this.emit('session', this.snapshot());

    try {
      for (const physicalOutput of this.activePhysicalOutputs()) {
        const bus = this.busFor(physicalOutput);
        if (!bus) {
          this.emit('warning', { message: `${physicalOutput.label}: sourceBusId "${physicalOutput.sourceBusId}" not found in config.buses — skipped` });
          continue;
        }
        if (physicalOutput.sharedDrivers?.count > 1) {
          await this.runSharedDriverWizard(physicalOutput, bus, pos);
        } else {
          await this.measureOnePhysicalOutput(physicalOutput, bus, pos);
        }
        this.state = 'measuring';
      }
      await this.wing.unmuteAll(this.activeBuses());

      this.posIndex++;
      if (this.posIndex >= this.positions.length) {
        await this.finish();
      } else {
        this.state = 'waiting_position';
        this.emit('session', this.snapshot());
      }
    } catch (err) {
      this.state = 'waiting_position'; // allow retake of this position
      this.wizard = null;
      this.emit('error', { message: String(err.message || err) });
      this.emit('session', this.snapshot());
    }
  }

  /**
   * Play/capture one sweep and run the delay + IR + magnitude pipeline for a
   * BUS (the sweep always plays through whichever bus is currently soloed).
   * Applies the bus's sweepTrimDb (e.g. subs run quieter than mains) —
   * extractIR peak-normalizes the recovered IR, so the trim does not skew
   * the magnitude/delay results, only the captured levelDbfs and headroom.
   */
  async runSweep(bus) {
    const trimmed = scaleBuffer(this.sweep, bus?.sweepTrimDb);
    const { raiseDb, noiseFloorDbfs } = await this.checkAmbientAndMaybeRaise(bus);
    const sweep = raiseDb > 0 ? scaleBuffer(trimmed, raiseDb) : trimmed;
    if (raiseDb > 0) {
      this.emit('info', {
        message: `${bus.label}: ambient noise ~${noiseFloorDbfs.toFixed(1)} dBFS — auto-raised sweep level by ${raiseDb.toFixed(1)} dB to keep a clean margin.`
      });
    }
    const { ref, mic } = await this.audio.playAndCapture(sweep, this.captureSeconds);
    const delay = findDelay(ref, mic, this.cfg.audio.sampleRate);
    const ir = extractIR(mic, this.inverse, this.cfg.audio.sampleRate);
    const { freqs, magDb } = magnitudeResponse(ir, this.cfg.audio.sampleRate);
    return { ref, mic, delay, ir, freqs, magDb };
  }

  /**
   * Auto-SNR safety net: capture ~1s of ambient noise on the mic channel
   * and, if the planned sweep level wouldn't clear it by minSnrMarginDb,
   * report how much to raise the sweep by (capped at maxLevelDbfs). Zero
   * operator involvement -- runs before every sweep attempt, including the
   * low-confidence retry in measureOnePhysicalOutput().
   *
   * Feature-detected on `audio.captureAmbient` (like `audio.setScenario`)
   * rather than reusing playAndCapture for the probe -- a dedicated method
   * keeps this fully opt-in for any AudioIO/test double that doesn't
   * implement it, instead of silently consuming an extra scripted
   * playAndCapture() call every test double would otherwise need to expect.
   */
  async checkAmbientAndMaybeRaise(bus) {
    if (!this.audio.captureAmbient) return { raiseDb: 0, noiseFloorDbfs: null };
    const s = this.cfg.audio.sweep;
    const marginDb = s.minSnrMarginDb ?? DEFAULT_MIN_SNR_MARGIN_DB;
    const maxLevelDbfs = s.maxLevelDbfs ?? MAX_SWEEP_LEVEL_DBFS;
    const ambientSeconds = s.ambientCheckSeconds ?? DEFAULT_AMBIENT_CHECK_SECONDS;

    const { mic } = await this.audio.captureAmbient(ambientSeconds);
    const noiseFloorDbfs = rmsDbfs(mic);

    const plannedLevelDbfs = this.baseSweepLevelDbfs + (bus?.sweepTrimDb ?? 0);
    const neededLevelDbfs = noiseFloorDbfs + marginDb;
    if (neededLevelDbfs <= plannedLevelDbfs) return { raiseDb: 0, noiseFloorDbfs };
    const targetLevelDbfs = Math.min(neededLevelDbfs, maxLevelDbfs);
    const raiseDb = Math.max(0, targetLevelDbfs - plannedLevelDbfs);
    return { raiseDb, noiseFloorDbfs };
  }

  /**
   * Measure ONE physical output at ONE position: solo its bus, attempt
   * per-driver test-signal injection (falls back to bus solo/mute alone if
   * injection isn't confirmed/available yet — see PatchManager), sweep,
   * always restore the patch if it was injected, then report + store the
   * result. Used both by the normal per-output loop and by the wizard's
   * individual/combined steps (via `opts`).
   */
  async measureOnePhysicalOutput(physicalOutput, bus, pos, opts = {}) {
    const { driverVariant = null, speakerIdOverride = null, excludeFromCorrection = false } = opts;
    const label = driverVariant ? `${physicalOutput.label} (${driverVariant})` : physicalOutput.label;
    const speakerId = speakerIdOverride || physicalOutput.speakerId;

    this.emit('measuring', { position: pos.label, output: label });
    if (this.audio.setScenario) this.audio.setScenario(speakerId || bus.id, pos, [speakerId || bus.id]);
    await this.wing.soloOutput(bus.id, this.activeBuses());

    let injected = false;
    try {
      await this.wing.injectTestSignal(physicalOutput);
      injected = true;
    } catch (err) {
      this.emit('info', { message: `${physicalOutput.label}: test-signal injection unavailable (${err.message}) — measuring via normal bus routing.` });
    }
    await pause(400); // let mutes/patch settle

    let sweep = await this.runSweep(bus);
    if (sweep.delay.confidence < LOW_CONFIDENCE_THRESHOLD) {
      this.emit('info', { message: `Low confidence on ${label} at ${pos.label} — retrying sweep once…` });
      const retry = await this.runSweep(bus);
      if (retry.delay.confidence > sweep.delay.confidence) sweep = retry;
    }
    const { mic, delay, ir, freqs, magDb } = sweep;

    if (injected) {
      try {
        await this.wing.restorePatch(physicalOutput);
      } catch (err) {
        this.emit('error', {
          message: `${physicalOutput.label}: FAILED to restore its original patch — use "Restore All Patches" in Settings immediately. (${err.message})`
        });
      }
    }

    const predicted = speakerId ? this.predictArrivalMs(speakerId, pos) : null;
    if (predicted !== null && Math.abs(delay.ms - predicted) > 8) {
      this.emit('warning', {
        message: `Geometry mismatch at ${pos.label} / ${label}: measured ${delay.ms.toFixed(1)} ms vs predicted ${predicted.toFixed(1)} ms. Wrong position, wrong output soloed, or routing issue?`,
        position: pos.id, output: physicalOutput.id
      });
    }
    if (delay.confidence < LOW_CONFIDENCE_THRESHOLD) {
      this.emit('warning', {
        message: `Low confidence on ${label} at ${pos.label} even after retry — check mic/routing, retake recommended.`,
        position: pos.id, output: physicalOutput.id
      });
    }
    const clipped = isClipped(mic);
    if (clipped) {
      this.emit('warning', {
        message: `Clipped capture on ${label} at ${pos.label} — mic input near 0 dBFS. Lower the sweep level or mic preamp gain and retake.`,
        position: pos.id, output: physicalOutput.id
      });
    }
    const snrDb = estimateSnrDb(mic, this.cfg.audio.sampleRate);
    if (snrDb < LOW_SNR_THRESHOLD_DB) {
      this.emit('warning', {
        message: `Low signal-to-noise on ${label} at ${pos.label} (~${snrDb} dB) — check mic gain, routing, or ambient noise.`,
        position: pos.id, output: physicalOutput.id
      });
    }

    const result = {
      positionId: pos.id, positionWeight: pos.weight ?? 1, zone: pos.zone || 'main',
      outputId: bus.id,                 // BUS layer id -- the only thing recommendations/apply() ever key on
      physicalOutputId: physicalOutput.id,
      driverVariant,                    // null (normal) | driver label | 'combined'
      delayMs: delay.ms, confidence: Math.round(delay.confidence),
      polarity: polarity(ir),
      levelDbfs: Math.round(rmsDbfs(mic) * 10) / 10,
      snrDb, clipped,
      freqs: Array.from(freqs), magDb: Array.from(magDb)
    };

    if (excludeFromCorrection) this.driverHealthResults.push(result);
    else this.results.push(result);
    this.emit('trace', result);
    return result;
  }

  /**
   * Guided wizard for a shared-driver physical output (e.g. one "Side
   * Fills" output driving two boxes via a passive split) — the console
   * can't isolate them electronically, only the operator physically
   * unplugging a cable can. Suspends the caller (the position loop in
   * ready()) until the whole instruct/confirm/sweep sequence completes for
   * every individual driver PLUS one combined sweep; wizardContinue()/
   * wizardConfirm() (driven by separate websocket actions from the UI) do
   * the actual stepping and resolve the returned promise when done.
   */
  runSharedDriverWizard(physicalOutput, bus, pos) {
    return new Promise((resolve, reject) => {
      this.wizard = {
        physicalOutputId: physicalOutput.id, physicalOutput, bus, pos,
        driverIndex: 0, step: 'instruct', driverResults: [],
        _resolve: resolve, _reject: reject
      };
      this.state = 'wizard';
      this.emit('session', this.snapshot());
    });
  }

  /** UI tapped Continue on an instruction screen — plays the confidence
   *  blip (operator listens with their own ears; no capture/analysis) and
   *  advances to the confirm step. */
  async wizardContinue() {
    if (this.state !== 'wizard' || !this.wizard || this.wizard.step !== 'instruct') return;
    const w = this.wizard;
    const drivers = w.physicalOutput.sharedDrivers.drivers;
    const isCombinedStep = w.driverIndex >= drivers.length;
    const label = isCombinedStep ? 'both drivers' : drivers[w.driverIndex].label;
    this.emit('info', { message: `Playing confidence tone for ${label}…` });
    const blip = this.blipForOutput(w.bus, { seconds: 1.5 });
    await this.audio.playAndCapture(blip, 1.9); // playback only -- operator confirms by ear
    w.step = 'confirm';
    this.emit('session', this.snapshot());
  }

  /** UI answered the "did you hear ONLY <driver>?" question. `heard=false`
   *  replays the instructions (per spec: "No = replay instructions") rather
   *  than failing the wizard — cabling mistakes are common and cheap to fix. */
  async wizardConfirm(heard) {
    if (this.state !== 'wizard' || !this.wizard || this.wizard.step !== 'confirm') return;
    const w = this.wizard;

    if (!heard) {
      w.step = 'instruct';
      this.emit('info', { message: 'Recheck the connection, then press Continue to replay the tone.' });
      this.emit('session', this.snapshot());
      return;
    }

    const drivers = w.physicalOutput.sharedDrivers.drivers;
    const isCombinedStep = w.driverIndex >= drivers.length;

    try {
      if (isCombinedStep) {
        const result = await this.measureOnePhysicalOutput(w.physicalOutput, w.bus, w.pos, { driverVariant: 'combined' });
        this.checkDriverHealth(w.physicalOutput, w.pos, w.driverResults, result);
        const resolve = w._resolve;
        this.wizard = null;
        this.state = 'measuring';
        this.emit('session', this.snapshot());
        resolve();
      } else {
        const driver = drivers[w.driverIndex];
        const result = await this.measureOnePhysicalOutput(w.physicalOutput, w.bus, w.pos, {
          driverVariant: driver.label, speakerIdOverride: driver.speakerId, excludeFromCorrection: true
        });
        w.driverResults.push(result);
        w.driverIndex++;
        w.step = 'instruct';
        this.state = 'wizard';
        this.emit('session', this.snapshot());
      }
    } catch (err) {
      this.emit('error', { message: String(err.message || err) });
      w.step = 'instruct';
      this.state = 'wizard';
      this.emit('session', this.snapshot());
    }
  }

  /**
   * Compare the two individual-driver sweeps from a completed wizard run:
   * polarity mismatch, level mismatch, and the single largest per-band
   * response deviation. Flags anything beyond a few dB — this is
   * truth-telling about driver health, never fed into the bus correction
   * (buildRecommendations only ever reads `results`, not `driverHealthResults`).
   */
  checkDriverHealth(physicalOutput, pos, individualResults, combinedResult) {
    if (individualResults.length < 2) return;
    const [a, b] = individualResults;
    const flags = [];
    if (a.polarity !== b.polarity) {
      flags.push(`polarity mismatch (${a.driverVariant}: ${a.polarity > 0 ? '+' : '−'}, ${b.driverVariant}: ${b.polarity > 0 ? '+' : '−'})`);
    }
    const levelDiffDb = Math.abs(a.levelDbfs - b.levelDbfs);
    if (levelDiffDb > 3) flags.push(`level differs by ${levelDiffDb.toFixed(1)} dB between ${a.driverVariant} and ${b.driverVariant}`);

    let maxResponseDevDb = 0, maxResponseDevHz = 0;
    const len = Math.min(a.freqs.length, b.freqs.length);
    for (let i = 0; i < len; i++) {
      const dev = Math.abs(a.magDb[i] - b.magDb[i]);
      if (dev > maxResponseDevDb) { maxResponseDevDb = dev; maxResponseDevHz = a.freqs[i]; }
    }
    if (maxResponseDevDb > 3) {
      flags.push(`response differs by ${maxResponseDevDb.toFixed(1)} dB near ${Math.round(maxResponseDevHz)} Hz between ${a.driverVariant} and ${b.driverVariant}`);
    }

    const report = {
      physicalOutputId: physicalOutput.id, positionId: pos.id,
      driverA: a.driverVariant, driverB: b.driverVariant,
      levelDiffDb: Math.round(levelDiffDb * 10) / 10,
      maxResponseDevDb: Math.round(maxResponseDevDb * 10) / 10,
      maxResponseDevHz: Math.round(maxResponseDevHz),
      flags
    };
    this.driverHealthReports.push(report);
    this.emit(flags.length ? 'warning' : 'info', {
      message: flags.length
        ? `${physicalOutput.label} driver health: ${flags.join('; ')}`
        : `${physicalOutput.label} driver health OK — ${a.driverVariant}/${b.driverVariant} match within tolerance.`
    });
  }

  /**
   * Pre-flight: play a short blip on each enabled physical output and
   * confirm signal returns before committing to a full guided session.
   * Shared-driver outputs are NOT walked through the wizard here — this is
   * a fast go/no-go check, not a health audit; it tests the combined signal
   * automatically like any other output. Does not touch this.results —
   * purely a go/no-go check, reported per output on the UI.
   */
  async preflightCheck() {
    if (!['idle', 'done', 'review'].includes(this.state)) {
      throw new Error('cannot pre-flight while a session is running');
    }
    const pf = this.cfg.audio.preflight || {};
    const minPeak = pf.minPeakDbfs ?? -50;
    const minSnr = pf.minSnrDb ?? 12;
    const probePos = this.room.positions.find((p) => p.id === this.room.verifyPosition)
      || this.room.positions[0] || { x: 0, y: 0, z: 1.2 };

    this.state = 'preflight';
    this.preflightResults = [];
    this.emit('session', this.snapshot());

    try {
      for (const physicalOutput of this.activePhysicalOutputs()) {
        const bus = this.busFor(physicalOutput);
        if (!bus) continue;
        const speakerId = physicalOutput.speakerId;
        this.emit('preflight_progress', { outputId: physicalOutput.id, label: physicalOutput.label, status: 'testing' });
        if (this.audio.setScenario) this.audio.setScenario(speakerId || bus.id, probePos, [speakerId || bus.id]);
        await this.wing.soloOutput(bus.id, this.activeBuses());

        let injected = false;
        try { await this.wing.injectTestSignal(physicalOutput); injected = true; }
        catch { /* fall back to bus solo/mute only -- same behavior as before injection existed */ }
        await pause(300);

        const blip = scaleBuffer(this.blipForOutput(bus), bus.sweepTrimDb);
        const { mic } = await this.audio.playAndCapture(blip, this.blipCaptureSeconds);

        if (injected) {
          try { await this.wing.restorePatch(physicalOutput); }
          catch (err) {
            this.emit('error', { message: `${physicalOutput.label}: FAILED to restore its original patch — use "Restore All Patches" in Settings immediately. (${err.message})` });
          }
        }

        const peak = Math.round(peakDbfs(mic) * 10) / 10;
        const snrDb = estimateSnrDb(mic, this.cfg.audio.sampleRate);
        const clipped = isClipped(mic);
        const pass = peak >= minPeak && !clipped && snrDb >= minSnr;

        const result = { outputId: physicalOutput.id, label: physicalOutput.label, pass, peakDbfs: peak, snrDb, clipped, status: pass ? 'pass' : 'fail' };
        this.preflightResults.push(result);
        this.emit('preflight_progress', result);
      }
      await this.wing.unmuteAll(this.activeBuses());
    } finally {
      this.state = 'idle';
      this.emit('session', this.snapshot());
      const failed = this.preflightResults.filter((r) => !r.pass);
      const clipped = failed.filter((r) => r.clipped);
      const noSignal = failed.filter((r) => !r.clipped);
      if (clipped.length) {
        this.emit('warning', {
          message: `Pre-flight: ${clipped.map((f) => f.label).join(', ')} clipped — mic input near/above 0 dBFS. Lower the amp trim or preamp gain before starting a full tune.`
        });
      }
      if (noSignal.length) {
        this.emit('warning', {
          message: `Pre-flight: ${noSignal.map((f) => f.label).join(', ')} returned no usable signal — check routing/amp/patch before starting a full tune.`
        });
      }
      if (!failed.length && this.preflightResults.length) {
        this.emit('info', { message: `Pre-flight OK — all ${this.preflightResults.length} outputs returned signal.` });
      }
    }
  }

  /** Retake the previous position. */
  retake() {
    if (this.posIndex > 0 && this.state === 'waiting_position') {
      this.posIndex--;
      const retakenId = this.positions[this.posIndex].id;
      this.results = this.results.filter((r) => r.positionId !== retakenId);
      this.driverHealthResults = this.driverHealthResults.filter((r) => r.positionId !== retakenId);
      this.driverHealthReports = this.driverHealthReports.filter((r) => r.positionId !== retakenId);
      this.emit('session', this.snapshot());
    }
  }

  /** "Restore All Patches" escape hatch — reads the on-disk snapshot and
   *  reverts every pending repatch, regardless of session state. Safe to
   *  call any time, including when nothing is pending (no-op). */
  restoreAllPatches() {
    const restored = this.wing.restoreAllPatches ? this.wing.restoreAllPatches() : [];
    this.emit('info', {
      message: restored.length ? `Restored ${restored.length} patch(es) to their original source.` : 'No pending patches to restore.'
    });
    this.emit('session', this.snapshot());
    return restored;
  }

  async finish() {
    if (this.mode === 'verify') {
      this.recommendations = this.buildVerifyReport();
      this.saveSessionRecord();
      this.state = 'done';
      this.emit('session', this.snapshot());
      return;
    }
    const localRec = this.buildRecommendations();
    localRec.source = 'local';
    if (localRec.excludedLowConfidenceCount) {
      this.emit('warning', {
        message: `${localRec.excludedLowConfidenceCount} measurement(s) excluded from correction — confidence stayed low even after retry. They're kept in the downloadable session record but never fed into an EQ/delay recommendation.`
      });
    }
    for (const label of localRec.busesWithNoUsableData) {
      this.emit('warning', {
        message: `${label}: every measurement at every position was low-confidence — no correction generated for this bus. Retake when the room is quieter.`
      });
    }

    this.emit('info', { message: 'Measurements done — sending analysis to Claude for tuning…' });
    const payload = buildAnalysisPayload({
      config: this.cfg, room: this.room, results: this.confidenceFilteredResults(), localRec
    });
    this.lastAnalysisPayload = payload; // exposed for export/debug

    const advice = await claudeTune(payload);
    if (advice) {
      const v = validate(advice, this.cfg);
      // Merge Claude's filters/delays over the local scaffold (keeps curves for charts)
      for (const [id, o] of Object.entries(localRec.perOutput)) {
        if (v.outputs[id]) {
          o.filters = v.outputs[id].filters;
          o.note = v.outputs[id].note;
        }
      }
      for (const [id, d] of Object.entries(v.delays)) {
        if (localRec.delays[id]) localRec.delays[id].addDelayMs = d.addDelayMs;
      }
      localRec.source = 'claude';
      localRec.summary = v.summary;
      localRec.warnings = v.warnings;
      this.emit('info', { message: 'Claude tuning received.' });
    } else {
      this.emit('warning', { message: 'Claude unavailable — using local recommender (offline fallback).' });
    }

    this.recommendations = localRec;
    this.saveSessionRecord();
    this.state = 'review';
    this.emit('session', this.snapshot());
  }


  /** Direct-path arrival prediction from room geometry (ms). Null if unknown
   *  speakerId, or a shared-driver output outside the wizard (no single
   *  speaker to predict against — skip the check rather than guess). */
  predictArrivalMs(speakerId, pos) {
    if (!speakerId) return null;
    const spk = (this.room.speakers || []).find((x) => x.id === speakerId);
    if (!spk || pos.x === undefined) return null;
    const d = Math.hypot(spk.x - pos.x, spk.y - pos.y, (spk.z ?? 0) - (pos.z ?? 1.2));
    return (d / 343) * 1000;
  }

  /** Rows whose delay confidence cleared LOW_CONFIDENCE_THRESHOLD, even after
   *  the one automatic retry in measureOnePhysicalOutput(). A row that never
   *  clears it is real data — kept in `results` / the downloadable session
   *  record for the operator to see — but must never be able to pull a bus's
   *  EQ or delay correction off target, so nothing that feeds a
   *  recommendation reads `results` directly; it goes through this filter. */
  confidenceFilteredResults() {
    return this.results.filter((r) => r.confidence >= LOW_CONFIDENCE_THRESHOLD);
  }

  /**
   * Corrections are built per BUS, pooling every result row tagged with
   * that bus's id — regardless of whether those rows came from different mic
   * positions, different physical outputs sharing the bus (stereo mains), or
   * a wizard's combined sweep. spatialAverage() doesn't need to know which.
   * Low-confidence rows are excluded before any of this ever sees them (see
   * confidenceFilteredResults()) — a bus left with zero usable rows simply
   * gets no perOutput/delays entry, so apply() silently skips it rather than
   * writing a correction built from noise.
   */
  buildRecommendations() {
    const g = this.cfg.guardrails;
    const perOutput = {};
    const usable = this.confidenceFilteredResults();
    const excludedLowConfidenceCount = this.results.length - usable.length;
    const busesWithNoUsableData = [];

    for (const bus of this.cfg.buses) {
      const rs = usable.filter((r) => r.outputId === bus.id);
      if (!rs.length) {
        if (this.results.some((r) => r.outputId === bus.id)) busesWithNoUsableData.push(bus.label);
        continue;
      }

      const grid = rs[0].freqs;
      const weighted = rs.filter((r) => r.positionWeight > 0);
      const { avg, varDb } = spatialAverage(
        (weighted.length ? weighted : rs).map((r) => ({ magDb: Float64Array.from(r.magDb), weight: r.positionWeight || 1 }))
      );
      const target = targetOnGrid(activeTargetCurve(this.cfg).points, Float64Array.from(grid));
      const filters = recommendEQ({
        freqs: Float64Array.from(grid), avg, varDb, target, guardrails: g,
        band: bus.band
      });

      perOutput[bus.id] = {
        label: bus.label,
        filters,
        avg: Array.from(avg), varDb: Array.from(varDb),
        target: Array.from(target), freqs: grid,
        polarityIssue: rs.some((r) => r.polarity < 0),
        // Per-position curves for the review screen's "show all positions"
        // overlay toggle — same freqs grid as avg/target above.
        positions: rs.map((r) => ({
          positionId: r.positionId,
          label: this.positions.find((p) => p.id === r.positionId)?.label ?? r.positionId,
          magDb: r.magDb
        }))
      };
    }

    const delays = recommendDelays({
      results: usable, outputs: this.cfg.buses, guardrails: this.cfg.guardrails
    });
    const zoneReport = this.buildZoneReport();
    return {
      perOutput, delays, zoneReport,
      driverHealth: this.driverHealthReports.length ? this.driverHealthReports : null,
      excludedLowConfidenceCount, busesWithNoUsableData,
      applied: false
    };
  }


  /** Per-zone average level deltas vs main floor, in coarse bands — truth-telling,
   *  not correction. Balcony zones are excluded from system EQ by design. */
  buildZoneReport() {
    const bands = [[60, 250, 'low'], [250, 2000, 'mid'], [2000, 12000, 'high']];
    const zones = {};
    for (const r of this.results) {
      (zones[r.zone] ||= []).push(r);
    }
    if (!zones.main) return null;
    const bandAvg = (rs, lo, hi) => {
      let s2 = 0, n = 0;
      for (const r of rs) {
        r.freqs.forEach((f, i) => { if (f >= lo && f < hi) { s2 += r.magDb[i]; n++; } });
      }
      return s2 / Math.max(n, 1);
    };
    const report = {};
    for (const [zone, rs] of Object.entries(zones)) {
      if (zone === 'main') continue;
      report[zone] = {};
      for (const [lo, hi, name] of bands) {
        const delta = bandAvg(rs, lo, hi) - bandAvg(zones.main, lo, hi);
        report[zone][name] = Math.round(delta * 10) / 10;
      }
    }
    return Object.keys(report).length ? report : null;
  }

  /** Verify report keys on PHYSICAL outputs (not buses) — the point is
   *  confirming every individual driver still works, which a bus-level
   *  aggregate could mask (e.g. one blown fill speaker). */
  buildVerifyReport() {
    const baseline = fs.existsSync(this.baselinePath)
      ? JSON.parse(fs.readFileSync(this.baselinePath, 'utf8'))
      : null;
    const report = { outputs: [], baselineFound: !!baseline };
    for (const physicalOutput of this.cfg.physicalOutputs) {
      const r = this.results.find((x) => x.physicalOutputId === physicalOutput.id);
      if (!r) continue;
      const entry = {
        label: physicalOutput.label,
        delayMs: Math.round(r.delayMs * 10) / 10,
        levelDbfs: r.levelDbfs,
        polarity: r.polarity,
        confidence: r.confidence,
        drift: null
      };
      if (baseline) {
        const b = baseline.outputs?.find((x) => x.label === physicalOutput.label);
        if (b) {
          entry.drift = {
            delayMs: Math.round((r.delayMs - b.delayMs) * 10) / 10,
            levelDb: Math.round((r.levelDbfs - b.levelDbfs) * 10) / 10
          };
        }
      }
      report.outputs.push(entry);
    }
    return report;
  }

  /** Full downloadable record of this session — everything measured + recommended. */
  buildSessionRecord(id) {
    return {
      id: id ?? this.currentRecordId ?? makeSessionId(this.mode),
      mode: this.mode,
      room: this.room.name,
      startedAt: this.startedAt ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      positions: this.positions.map(({ id, label, zone, weight }) => ({ id, label, zone, weight })),
      results: this.results,
      driverHealthResults: this.driverHealthResults,
      driverHealthReports: this.driverHealthReports,
      recommendations: this.recommendations
    };
  }

  /** Persist a new session record, prune history to the last N, notify clients. */
  saveSessionRecord() {
    const rec = this.buildSessionRecord();
    this.currentRecordId = rec.id;
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    fs.writeFileSync(path.join(this.sessionsDir, `${rec.id}.json`), JSON.stringify(rec, null, 2));
    pruneSessionHistory(this.sessionsDir);
    this.emit('sessionHistory', listSessionHistory(this.dataDir));
    return rec.id;
  }

  /** Rewrite the current session's record in place (e.g. after Apply). */
  overwriteSessionRecord() {
    if (!this.currentRecordId) return;
    const rec = this.buildSessionRecord(this.currentRecordId);
    fs.writeFileSync(path.join(this.sessionsDir, `${this.currentRecordId}.json`), JSON.stringify(rec, null, 2));
    this.emit('sessionHistory', listSessionHistory(this.dataDir));
  }

  /** Save current verify results as the new baseline. */
  saveBaseline() {
    fs.mkdirSync(path.dirname(this.baselinePath), { recursive: true });
    fs.writeFileSync(this.baselinePath, JSON.stringify(this.buildVerifyReport(), null, 2));
    this.emit('info', { message: 'Baseline saved.' });
  }

  /** Human tapped Apply — the only path that writes to the console.
   *  Correction always targets the BUS layer; physical outputs are never
   *  individually EQ'd/delayed (see docs/DECISIONS.md "routing model"). */
  async apply() {
    if (this.state !== 'review' || !this.recommendations) return;
    for (const bus of this.cfg.buses) {
      const rec = this.recommendations.perOutput[bus.id];
      const delay = this.recommendations.delays[bus.id];
      if (!rec) continue;
      await this.wing.applyTuning(bus, rec.filters, delay?.addDelayMs ?? 0);
    }
    this.recommendations.applied = true;
    this.overwriteSessionRecord();
    this.state = 'done';
    this.emit('session', this.snapshot());
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSessionId(mode) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}__${mode || 'session'}`;
}
