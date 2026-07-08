// session.js — the guided measurement session state machine.
//
// A session walks: for each position → for each output → sweep, extract IR,
// compute delay + magnitude. When all positions are done: spatial average,
// EQ + delay recommendations, wait for human Apply.
//
// Modes:
//   'verify'  — one position (config room.verifyPosition), all outputs,
//               compares against stored baseline, writes nothing.
//   'full'    — all positions, all outputs, produces recommendations.

import { makeESS, makeBlip, scaleBuffer, extractIR, findDelay, magnitudeResponse,
         polarity, rmsDbfs, isClipped, estimateSnrDb, peakDbfs }
  from '../dsp/measure.js';
import { spatialAverage, targetOnGrid, recommendEQ, recommendDelays }
  from '../dsp/tune.js';
import { buildAnalysisPayload, claudeTune, validate } from './advisor.js';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DATA_DIR = 'data';
const MAX_SESSION_HISTORY = 5;
const LOW_CONFIDENCE_THRESHOLD = 3;
const LOW_SNR_THRESHOLD_DB = 15;

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
    this.results = [];   // { positionId, outputId, delayMs, confidence, polarity, freqs, magDb, levelDbfs }
    this.state = 'idle'; // idle | waiting_position | measuring | preflight | review | done
    this.recommendations = null;
    this.preflightResults = [];

    const s = config.audio.sweep;
    const { sweep, inverse } = makeESS({ ...s, sampleRate: config.audio.sampleRate });
    this.sweep = sweep;
    this.inverse = inverse;
    this.captureSeconds = s.seconds + s.padSeconds;

    const pf = config.audio.preflight || {};
    this.blip = makeBlip({
      freq: pf.blipFreq ?? 1000, seconds: pf.blipSeconds ?? 1,
      sampleRate: config.audio.sampleRate, levelDbfs: s.levelDbfs
    });
    this.blipCaptureSeconds = pf.captureSeconds ?? ((pf.blipSeconds ?? 1) + 0.4);
  }

  snapshot() {
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
      currentRecordId: this.currentRecordId ?? null
    };
  }

  start(mode) {
    if (this.state !== 'idle' && this.state !== 'done' && this.state !== 'review') {
      throw new Error('session already running');
    }
    this.mode = mode;
    this.results = [];
    this.recommendations = null;
    this.currentRecordId = null;
    this.startedAt = new Date().toISOString();
    this.positions = mode === 'verify'
      ? this.room.positions.filter((p) => p.id === this.room.verifyPosition)
      : [...this.room.positions];
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
      for (const output of this.cfg.outputs.filter((o) => o.enabled !== false)) {
        this.emit('measuring', { position: pos.label, output: output.label });
        if (this.audio.setScenario) this.audio.setScenario(output.id, pos, output.sources); // mock hook
        await this.wing.soloOutput(output.id, this.cfg.outputs);
        await pause(400); // let mutes settle

        let sweep = await this.runSweep(output);
        if (sweep.delay.confidence < LOW_CONFIDENCE_THRESHOLD) {
          this.emit('info', { message: `Low confidence on ${output.label} at ${pos.label} — retrying sweep once…` });
          const retry = await this.runSweep(output);
          if (retry.delay.confidence > sweep.delay.confidence) sweep = retry;
        }
        const { ref, mic, delay, ir, freqs, magDb } = sweep;

        const predicted = this.predictArrivalMs(output.id, pos);
        if (predicted !== null && Math.abs(delay.ms - predicted) > 8) {
          this.emit('warning', {
            message: `Geometry mismatch at ${pos.label} / ${output.label}: measured ${delay.ms.toFixed(1)} ms vs predicted ${predicted.toFixed(1)} ms. Wrong position, wrong output soloed, or routing issue?`,
            position: pos.id, output: output.id
          });
        }
        if (delay.confidence < LOW_CONFIDENCE_THRESHOLD) {
          this.emit('warning', {
            message: `Low confidence on ${output.label} at ${pos.label} even after retry — check mic/routing, retake recommended.`,
            position: pos.id, output: output.id
          });
        }
        const clipped = isClipped(mic);
        if (clipped) {
          this.emit('warning', {
            message: `Clipped capture on ${output.label} at ${pos.label} — mic input near 0 dBFS. Lower the sweep level or mic preamp gain and retake.`,
            position: pos.id, output: output.id
          });
        }
        const snrDb = estimateSnrDb(mic, this.cfg.audio.sampleRate);
        if (snrDb < LOW_SNR_THRESHOLD_DB) {
          this.emit('warning', {
            message: `Low signal-to-noise on ${output.label} at ${pos.label} (~${snrDb} dB) — check mic gain, routing, or ambient noise.`,
            position: pos.id, output: output.id
          });
        }

        const result = {
          positionId: pos.id, positionWeight: pos.weight ?? 1,
          zone: pos.zone || 'main',
          outputId: output.id,
          delayMs: delay.ms, confidence: Math.round(delay.confidence),
          polarity: polarity(ir),
          levelDbfs: Math.round(rmsDbfs(mic) * 10) / 10,
          snrDb, clipped,
          freqs: Array.from(freqs), magDb: Array.from(magDb)
        };
        this.results.push(result);
        this.emit('trace', result);
      }
      await this.wing.unmuteAll(this.cfg.outputs);

      this.posIndex++;
      if (this.posIndex >= this.positions.length) {
        await this.finish();
      } else {
        this.state = 'waiting_position';
        this.emit('session', this.snapshot());
      }
    } catch (err) {
      this.state = 'waiting_position'; // allow retake of this position
      this.emit('error', { message: String(err.message || err) });
      this.emit('session', this.snapshot());
    }
  }

  /**
   * Play/capture one sweep and run the delay + IR + magnitude pipeline.
   * Applies the output's sweepTrimDb (e.g. subs run quieter than mains) —
   * extractIR peak-normalizes the recovered IR, so the trim does not skew
   * the magnitude/delay results, only the captured levelDbfs and headroom.
   */
  async runSweep(output) {
    const sweep = scaleBuffer(this.sweep, output?.sweepTrimDb);
    const { ref, mic } = await this.audio.playAndCapture(sweep, this.captureSeconds);
    const delay = findDelay(ref, mic, this.cfg.audio.sampleRate);
    const ir = extractIR(mic, this.inverse, this.cfg.audio.sampleRate);
    const { freqs, magDb } = magnitudeResponse(ir, this.cfg.audio.sampleRate);
    return { ref, mic, delay, ir, freqs, magDb };
  }

  /**
   * Pre-flight: play a short blip on each enabled output and confirm signal
   * returns before committing to a full guided session. Does not touch
   * this.results — purely a go/no-go check, reported per output on the UI.
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
      for (const output of this.cfg.outputs.filter((o) => o.enabled !== false)) {
        this.emit('preflight_progress', { outputId: output.id, label: output.label, status: 'testing' });
        if (this.audio.setScenario) this.audio.setScenario(output.id, probePos, output.sources);
        await this.wing.soloOutput(output.id, this.cfg.outputs);
        await pause(300);

        const blip = scaleBuffer(this.blip, output.sweepTrimDb);
        const { mic } = await this.audio.playAndCapture(blip, this.blipCaptureSeconds);
        const peak = Math.round(peakDbfs(mic) * 10) / 10;
        const snrDb = estimateSnrDb(mic, this.cfg.audio.sampleRate);
        const pass = peak >= minPeak && snrDb >= minSnr;

        const result = { outputId: output.id, label: output.label, pass, peakDbfs: peak, snrDb, status: pass ? 'pass' : 'fail' };
        this.preflightResults.push(result);
        this.emit('preflight_progress', result);
      }
      await this.wing.unmuteAll(this.cfg.outputs);
    } finally {
      this.state = 'idle';
      this.emit('session', this.snapshot());
      const failed = this.preflightResults.filter((r) => !r.pass);
      if (failed.length) {
        this.emit('warning', {
          message: `Pre-flight: ${failed.map((f) => f.label).join(', ')} returned no usable signal — check routing/amp/patch before starting a full tune.`
        });
      } else if (this.preflightResults.length) {
        this.emit('info', { message: `Pre-flight OK — all ${this.preflightResults.length} outputs returned signal.` });
      }
    }
  }

  /** Retake the previous position. */
  retake() {
    if (this.posIndex > 0 && this.state === 'waiting_position') {
      this.posIndex--;
      this.results = this.results.filter((r) => r.positionId !== this.positions[this.posIndex].id);
      this.emit('session', this.snapshot());
    }
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

    this.emit('info', { message: 'Measurements done — sending analysis to Claude for tuning…' });
    const payload = buildAnalysisPayload({
      config: this.cfg, room: this.room, results: this.results, localRec
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


  /** Direct-path arrival prediction from room geometry (ms). Null if unknown. */
  predictArrivalMs(outputId, pos) {
    const output = this.cfg.outputs.find((o) => o.id === outputId);
    const srcIds = output?.sources || [outputId];
    const spks = (this.room.speakers || []).filter((x) => srcIds.includes(x.id));
    if (!spks.length || pos.x === undefined) return null;
    // Nearest source dominates the first arrival (matters for shared-channel fills)
    const d = Math.min(...spks.map((s) =>
      Math.hypot(s.x - pos.x, s.y - pos.y, (s.z ?? 0) - (pos.z ?? 1.2))));
    return (d / 343) * 1000;
  }

  buildRecommendations() {
    const g = this.cfg.guardrails;
    const perOutput = {};

    for (const output of this.cfg.outputs) {
      const rs = this.results.filter((r) => r.outputId === output.id);
      if (!rs.length) continue;

      const grid = rs[0].freqs;
      const weighted = rs.filter((r) => r.positionWeight > 0);
      const { avg, varDb } = spatialAverage(
        (weighted.length ? weighted : rs).map((r) => ({ magDb: Float64Array.from(r.magDb), weight: r.positionWeight || 1 }))
      );
      const target = targetOnGrid(this.cfg.targetCurve.points, Float64Array.from(grid));
      const filters = recommendEQ({
        freqs: Float64Array.from(grid), avg, varDb, target, guardrails: g,
        band: output.band
      });

      perOutput[output.id] = {
        label: output.label,
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
      results: this.results, outputs: this.cfg.outputs, guardrails: this.cfg.guardrails
    });
    const zoneReport = this.buildZoneReport();
    return { perOutput, delays, zoneReport, applied: false };
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

  buildVerifyReport() {
    const baseline = fs.existsSync(this.baselinePath)
      ? JSON.parse(fs.readFileSync(this.baselinePath, 'utf8'))
      : null;
    const report = { outputs: [], baselineFound: !!baseline };
    for (const output of this.cfg.outputs) {
      const r = this.results.find((x) => x.outputId === output.id);
      if (!r) continue;
      const entry = {
        label: output.label,
        delayMs: Math.round(r.delayMs * 10) / 10,
        levelDbfs: r.levelDbfs,
        polarity: r.polarity,
        confidence: r.confidence,
        drift: null
      };
      if (baseline) {
        const b = baseline.outputs?.find((x) => x.label === output.label);
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

  /** Human tapped Apply — the only path that writes to the console. */
  async apply() {
    if (this.state !== 'review' || !this.recommendations) return;
    for (const output of this.cfg.outputs) {
      const rec = this.recommendations.perOutput[output.id];
      const delay = this.recommendations.delays[output.id];
      if (!rec) continue;
      await this.wing.applyTuning(output, rec.filters, delay?.addDelayMs ?? 0);
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
