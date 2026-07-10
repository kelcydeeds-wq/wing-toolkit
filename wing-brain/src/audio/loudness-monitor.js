// loudness-monitor.js — continuous LEQ (equivalent-level) monitoring off the
// reference mic capture channel, independent of System Tune sessions.
//
// Reuses the tune module's dBFS math (rmsDbfs from dsp/measure.js) rather
// than inventing a second level calculation — the only new pieces here are
// the rolling LEQ window, the sustained-threshold debounce, and the dBFS ->
// dB SPL calibration offset.
//
// >>> LIVE continuous capture is a TODO(church) stub — see LoudnessMonitor's
//     _defaultFrameSource(). Mock mode simulates a slowly drifting level
//     with occasional spikes, same philosophy as audio/io.js's mock room. <<<
//
// Deliberately NOT coupled to TuneSession — services happen far more often
// than full tune sessions, and this must keep running through all of them.

import { rmsDbfs } from '../dsp/measure.js';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DATA_DIR = 'data';
const MAX_LOUDNESS_HISTORY = 5;
const BROADCAST_HZ = 1.5;           // throttle websocket pushes to ~1-2 Hz
const MOCK_FRAME_SECONDS = 0.5;     // mock capture chunk size
const MAX_RECORD_SECONDS = 4 * 3600; // auto-rotate a very long always-on run into records

export const STATUS = { OK: 'ok', QUIET: 'quiet', WARN: 'warn', ALERT: 'alert' };

/** Parse an integration-window spec like "LEQ10" into seconds. Falls back to
 *  10s for anything unparseable rather than throwing — a monitor should
 *  degrade, not crash, on a bad config value. */
export function parseIntegrationWindowSeconds(spec) {
  const m = /^LEQ(\d+)$/i.exec(String(spec || '').trim());
  return m ? Number(m[1]) : 10;
}

/**
 * One-time calibration: on install day, take a known SPL meter reading at
 * the reference position and compare it against the system's simultaneous
 * dBFS reading. The difference is a constant offset added to every future
 * dBFS reading to report dB SPL.
 */
export function computeSplOffset(measuredDbfs, splMeterReadingDb) {
  return splMeterReadingDb - measuredDbfs;
}

export function dbfsToSpl(dbfs, offsetDb) {
  return dbfs + (offsetDb ?? 0);
}

const round1 = (x) => Math.round(x * 10) / 10;

/**
 * Rolling energy-average (LEQ) over a fixed time window, fed audio frames as
 * they arrive. Time advances purely from frame durations (frame.length /
 * sampleRate) — never wall-clock — so a test can drive this with synthetic
 * frames and get identical, deterministic results to a live capture stream.
 */
export class LeqAccumulator {
  constructor({ sampleRate, windowSeconds }) {
    this.sampleRate = sampleRate;
    this.windowSeconds = windowSeconds;
    this.chunks = [];      // { sumSq, n, tEnd }
    this.elapsedSeconds = 0;
    this.totalSumSq = 0;
    this.totalN = 0;
  }

  /** Push one frame (Float64Array) of the reference mic channel. Returns the
   *  current rolling LEQ in dBFS. */
  push(frame) {
    const dur = frame.length / this.sampleRate;
    let sumSq = 0;
    for (let i = 0; i < frame.length; i++) sumSq += frame[i] * frame[i];

    this.elapsedSeconds += dur;
    this.chunks.push({ sumSq, n: frame.length, tEnd: this.elapsedSeconds });
    this.totalSumSq += sumSq;
    this.totalN += frame.length;

    const cutoff = this.elapsedSeconds - this.windowSeconds;
    while (this.chunks.length && this.chunks[0].tEnd <= cutoff) {
      const c = this.chunks.shift();
      this.totalSumSq -= c.sumSq;
      this.totalN -= c.n;
    }
    return this.leqDbfs();
  }

  leqDbfs() {
    if (this.totalN <= 0) return -Infinity;
    return 10 * Math.log10(this.totalSumSq / this.totalN + 1e-20);
  }
}

/**
 * Tracks how long the level has continuously been over/under each threshold
 * and only flips status once that has held for `sustainedSeconds` straight —
 * a single transient spike (or a brief dip mid-alert) does not fire a status
 * change on its own. `elapsedSeconds` should be the same audio-clock the
 * LeqAccumulator reports, so status timing is driven by audio time too.
 */
export class LevelClassifier {
  constructor({ targetDb, softMarginDb, hardMarginDb, quietTargetDb = null, sustainedSeconds }) {
    this.targetDb = targetDb;
    this.softMarginDb = softMarginDb;
    this.hardMarginDb = hardMarginDb;
    this.quietTargetDb = quietTargetDb;
    this.sustainedSeconds = sustainedSeconds;
    this.status = STATUS.OK;
    this._overSoftSince = null;
    this._overHardSince = null;
    this._underQuietSince = null;
  }

  /** Returns { status, changed } — changed is true only on the update where
   *  status actually flips, so callers can log transitions exactly once. */
  update(levelDb, elapsedSeconds) {
    const overHard = levelDb >= this.targetDb + this.hardMarginDb;
    const overSoft = levelDb >= this.targetDb + this.softMarginDb;
    const underQuiet = this.quietTargetDb !== null && levelDb < this.quietTargetDb;

    this._overHardSince = overHard ? (this._overHardSince ?? elapsedSeconds) : null;
    this._overSoftSince = overSoft ? (this._overSoftSince ?? elapsedSeconds) : null;
    this._underQuietSince = underQuiet ? (this._underQuietSince ?? elapsedSeconds) : null;

    const sustained = (since) => since !== null && (elapsedSeconds - since) >= this.sustainedSeconds;

    let next = STATUS.OK;
    if (sustained(this._overHardSince)) next = STATUS.ALERT;
    else if (sustained(this._overSoftSince)) next = STATUS.WARN;
    else if (sustained(this._underQuietSince)) next = STATUS.QUIET;

    const changed = next !== this.status;
    this.status = next;
    return { status: next, changed };
  }
}

/**
 * Synthetic reference-mic frame for mock mode: a slow random walk in dBFS
 * plus occasional short spikes, so the meter and threshold logic are fully
 * exercisable with zero hardware. Mutates `state` in place (levelDbfs,
 * spikeRemaining, spikeBoostDb) so repeated calls drift continuously.
 */
export function mockLoudnessFrame(state, sampleRate, seconds) {
  state.levelDbfs = Math.max(-40, Math.min(-3, state.levelDbfs + (Math.random() - 0.5) * 0.6));
  if (state.spikeRemaining > 0) {
    state.spikeRemaining--;
  } else if (Math.random() < 0.01) {
    state.spikeRemaining = 3 + Math.floor(Math.random() * 4);
    state.spikeBoostDb = 4 + Math.random() * 6;
  }
  const boostDb = state.spikeRemaining > 0 ? (state.spikeBoostDb || 0) : 0;
  const targetDbfs = state.levelDbfs + boostDb;

  const n = Math.max(1, Math.floor(seconds * sampleRate));
  const frame = new Float64Array(n);
  for (let i = 0; i < n; i++) frame[i] = Math.random() * 2 - 1;
  // Rescale so the frame's actual RMS lands exactly on targetDbfs, rather
  // than relying on the raw noise's incidental level.
  const gain = Math.pow(10, (targetDbfs - rmsDbfs(frame)) / 20);
  for (let i = 0; i < n; i++) frame[i] *= gain;
  return frame;
}

/** List saved loudness records, newest first. Mirrors listSessionHistory's
 *  shape/pattern in tune/session.js so the report UI can reuse conventions. */
export function listLoudnessHistory(dataDir = DEFAULT_DATA_DIR) {
  const dir = path.resolve(dataDir, 'loudness');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort().reverse()
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

function pruneLoudnessHistory(dir) {
  if (!fs.existsSync(dir)) return;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  const excess = files.length - MAX_LOUDNESS_HISTORY;
  for (let i = 0; i < excess; i++) fs.unlinkSync(path.join(dir, files[i]));
}

function makeRecordId() {
  return new Date().toISOString().replace(/[:.]/g, '-') + '__loudness';
}

/**
 * Orchestrator: owns the LEQ/classifier pipeline and (via start()) a timer
 * that feeds it frames — mock mode generates synthetic frames, live mode is
 * a TODO(church) stub until continuous capture off the SoundGrid device is
 * implemented. `pushFrame()` is the actual per-frame logic and is exposed
 * publicly so tests can drive the whole pipeline deterministically without
 * touching timers at all — every internal clock is audio-time, not
 * wall-clock, so pushing frames directly in a test loop is equivalent to
 * a live run.
 */
export class LoudnessMonitor {
  constructor({ config, room, emit, dataDir = DEFAULT_DATA_DIR, frameSource } = {}) {
    this.cfg = config;
    this.room = room;
    this.emit = emit || (() => {});
    this.dataDir = dataDir;
    this.historyDir = path.resolve(dataDir, 'loudness');
    this._frameSourceOverride = frameSource;
    this.running = false;
    this._timer = null;
  }

  get lm() { return this.cfg.loudnessMonitor || {}; }

  start() {
    if (this.running || !this.lm.enabled) return;
    this.running = true;
    const sampleRate = this.cfg.audio.sampleRate;
    const windowSeconds = parseIntegrationWindowSeconds(this.lm.integrationWindow);
    this.leq = new LeqAccumulator({ sampleRate, windowSeconds });
    this.classifier = new LevelClassifier({
      targetDb: this.lm.targetDb, softMarginDb: this.lm.softMarginDb,
      hardMarginDb: this.lm.hardMarginDb, quietTargetDb: this.lm.quietTargetDb ?? null,
      sustainedSeconds: this.lm.sustainedSeconds
    });
    this._resetRecord();
    this._lastEmit = -Infinity;

    const frameSource = this._frameSourceOverride || this._defaultFrameSource(sampleRate);
    this._timer = setInterval(() => {
      const frame = frameSource();
      if (frame) this.pushFrame(frame);
    }, MOCK_FRAME_SECONDS * 1000);
  }

  stop() {
    if (!this.running) return;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.running = false;
    this._saveRecord();
  }

  _defaultFrameSource(sampleRate) {
    if (this.cfg.mode === 'mock') {
      const state = { levelDbfs: -30, spikeRemaining: 0, spikeBoostDb: 0 };
      return () => mockLoudnessFrame(state, sampleRate, MOCK_FRAME_SECONDS);
    }
    // TODO(church): tap the reference mic capture channel continuously (a
    // long-running sox/ASIO stream, not the one-shot playAndCapture() used
    // for sweeps) and hand frames here. Idle (no-op) until that's wired up
    // against the real SoundGrid device.
    return () => null;
  }

  _resetRecord() {
    this.startedAt = new Date().toISOString();
    this.startedAtSeconds = this.leq.elapsedSeconds;
    this.readings = [];
    this.transitions = [];
    this.secondsInStatus = { ok: 0, quiet: 0, warn: 0, alert: 0 };
  }

  /**
   * Feed one frame of reference-mic audio through the pipeline: update LEQ,
   * evaluate sustained-threshold status, accumulate the record, and (at
   * BROADCAST_HZ) push a throttled 'loudness' websocket event. Public and
   * timer-independent — this is the one method tests need to call.
   */
  pushFrame(frame) {
    if (!this.running || !frame?.length) return null;
    const dt = frame.length / this.leq.sampleRate;
    const leqDbfs = this.leq.push(frame);
    const levelDb = dbfsToSpl(leqDbfs, this.cfg.audio.splDbOffset);
    const { status, changed } = this.classifier.update(levelDb, this.leq.elapsedSeconds);

    this.secondsInStatus[status] = (this.secondsInStatus[status] || 0) + dt;
    const rounded = round1(levelDb);
    if (changed) this.transitions.push({ t: round1(this.leq.elapsedSeconds), status });
    this.readings.push({ t: round1(this.leq.elapsedSeconds), levelDb: rounded, status });

    const now = this.leq.elapsedSeconds;
    let broadcasted = false;
    if (now - this._lastEmit >= 1 / BROADCAST_HZ) {
      this._lastEmit = now;
      this.emit('loudness', {
        levelDb: rounded, status,
        targetDb: this.lm.targetDb, softMarginDb: this.lm.softMarginDb, hardMarginDb: this.lm.hardMarginDb,
        quietTargetDb: this.lm.quietTargetDb ?? null,
        referencePositionId: this.lm.referencePositionId
      });
      broadcasted = true;
    }

    if (now - this.startedAtSeconds >= MAX_RECORD_SECONDS) {
      this._saveRecord();
      this._resetRecord();
    }
    return { levelDb: rounded, status, changed, broadcasted };
  }

  /** Current raw dBFS reading (pre-calibration), for the Settings page's
   *  "Calibrate" flow. Null before the first frame has landed. */
  currentDbfs() {
    return this.leq && this.leq.totalN > 0 ? this.leq.leqDbfs() : null;
  }

  /** Last known level/status, for a freshly-connecting websocket client. */
  snapshot() {
    if (!this.readings?.length) return null;
    const last = this.readings[this.readings.length - 1];
    return {
      levelDb: last.levelDb, status: last.status,
      targetDb: this.lm.targetDb, softMarginDb: this.lm.softMarginDb, hardMarginDb: this.lm.hardMarginDb,
      quietTargetDb: this.lm.quietTargetDb ?? null,
      referencePositionId: this.lm.referencePositionId
    };
  }

  buildRecord() {
    const levels = this.readings.map((r) => r.levelDb).filter(Number.isFinite);
    return {
      id: makeRecordId(),
      startedAt: this.startedAt,
      endedAt: new Date().toISOString(),
      referencePositionId: this.lm.referencePositionId,
      targetDb: this.lm.targetDb,
      avgDb: levels.length ? round1(levels.reduce((a, b) => a + b, 0) / levels.length) : null,
      peakDb: levels.length ? round1(Math.max(...levels)) : null,
      secondsInStatus: { ...this.secondsInStatus },
      transitions: this.transitions
    };
  }

  _saveRecord() {
    if (!this.readings || !this.readings.length) return; // nothing measured, nothing to log
    const rec = this.buildRecord();
    fs.mkdirSync(this.historyDir, { recursive: true });
    fs.writeFileSync(path.join(this.historyDir, `${rec.id}.json`), JSON.stringify(rec, null, 2));
    pruneLoudnessHistory(this.historyDir);
    this.emit('loudnessHistory', listLoudnessHistory(this.dataDir));
    return rec.id;
  }
}
