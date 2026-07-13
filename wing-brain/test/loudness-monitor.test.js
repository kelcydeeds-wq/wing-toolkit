// Tests for src/audio/loudness-monitor.js — LEQ math, sustained-threshold
// classification, calibration math, mock frame generation, and the
// LoudnessMonitor orchestrator (frame-driven, no timers needed since every
// internal clock is audio-time, not wall-clock).
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rmsDbfs } from '../src/dsp/measure.js';
import {
  STATUS, parseIntegrationWindowSeconds, computeSplOffset, dbfsToSpl,
  LeqAccumulator, LevelClassifier, mockLoudnessFrame, LoudnessMonitor, listLoudnessHistory
} from '../src/audio/loudness-monitor.js';

/* --------------------------- integration window -------------------------- */

test('parseIntegrationWindowSeconds parses "LEQ10"-style specs, falls back to 10s otherwise', () => {
  assert.equal(parseIntegrationWindowSeconds('LEQ10'), 10);
  assert.equal(parseIntegrationWindowSeconds('leq30'), 30);
  assert.equal(parseIntegrationWindowSeconds('LEQ5'), 5);
  assert.equal(parseIntegrationWindowSeconds('garbage'), 10);
  assert.equal(parseIntegrationWindowSeconds(undefined), 10);
});

/* ------------------------------ calibration ------------------------------ */

test('computeSplOffset + dbfsToSpl round-trip: applying the offset reproduces the SPL meter reading', () => {
  const measuredDbfs = -22.4;
  const splReading = 94.2;
  const offset = computeSplOffset(measuredDbfs, splReading);
  assert.ok(Math.abs(dbfsToSpl(measuredDbfs, offset) - splReading) < 1e-9);
});

test('dbfsToSpl treats a null/undefined offset as uncalibrated (0 dB, reports raw dBFS)', () => {
  assert.equal(dbfsToSpl(-20, null), -20);
  assert.equal(dbfsToSpl(-20, undefined), -20);
});

/* -------------------------------- LEQ math -------------------------------- */

test('LeqAccumulator computes correct energy-average dBFS for a constant-level signal', () => {
  const sampleRate = 1000;
  const leq = new LeqAccumulator({ sampleRate, windowSeconds: 2 });
  const unity = new Float64Array(sampleRate).fill(1); // 1s @ amplitude 1 -> 0 dBFS RMS
  const result = leq.push(unity);
  assert.ok(Math.abs(result - 0) < 1e-6, `expected ~0 dBFS, got ${result}`);
});

test('LeqAccumulator averages energy (not dB) across frames of different levels', () => {
  const sampleRate = 1000;
  const leq = new LeqAccumulator({ sampleRate, windowSeconds: 10 });
  const loud = new Float64Array(sampleRate).fill(1);   // 0 dBFS
  const silent = new Float64Array(sampleRate).fill(0); // silence
  leq.push(loud);
  const result = leq.push(silent);
  // Energy average of [1,1,...] and [0,0,...] (equal sample counts) = 0.5 -> 10*log10(0.5)
  const expected = 10 * Math.log10(0.5);
  assert.ok(Math.abs(result - expected) < 1e-6, `expected ${expected}, got ${result}`);
});

test('LeqAccumulator rolls old chunks out of the window as elapsed time advances', () => {
  const sampleRate = 1000;
  const leq = new LeqAccumulator({ sampleRate, windowSeconds: 2 });
  const loud = new Float64Array(sampleRate).fill(1);   // 0 dBFS, 1s
  const silent = new Float64Array(sampleRate).fill(0); // silence, 1s

  leq.push(loud);            // t=1: window = [loud]
  const atEdge = leq.push(silent); // t=2: window = [loud, silent], still within 2s window
  assert.ok(Math.abs(atEdge - 10 * Math.log10(0.5)) < 1e-6);

  const afterDrop = leq.push(silent); // t=3: loud chunk (tEnd=1) now <= cutoff(1) -> dropped
  assert.ok(afterDrop < -100, `expected the loud chunk to have rolled out of the window, got ${afterDrop}`);
});

test('LeqAccumulator.elapsedSeconds advances purely from frame duration, never wall-clock', () => {
  const leq = new LeqAccumulator({ sampleRate: 48000, windowSeconds: 10 });
  leq.push(new Float64Array(24000)); // 0.5s
  leq.push(new Float64Array(12000)); // 0.25s
  assert.ok(Math.abs(leq.elapsedSeconds - 0.75) < 1e-9);
});

/* --------------------------- sustained threshold --------------------------- */

test('LevelClassifier does not fire on a short transient spike', () => {
  const c = new LevelClassifier({ targetDb: 90, softMarginDb: 2, hardMarginDb: 5, sustainedSeconds: 8 });
  let last;
  last = c.update(96, 0);   // spike: over soft margin (92) immediately
  assert.equal(last.status, STATUS.OK);
  last = c.update(96, 2);   // still only 2s in
  assert.equal(last.status, STATUS.OK);
  last = c.update(88, 3);   // drops back under target -- transient over, timer resets
  assert.equal(last.status, STATUS.OK);
  last = c.update(96, 3.5);
  last = c.update(96, 5);   // only 1.5s since it went back over -- still not sustained
  assert.equal(last.status, STATUS.OK, 'a brief spike followed by a dip must not fire a warning');
});

test('LevelClassifier fires warn/alert once overage is genuinely sustained, and reports the transition once', () => {
  const c = new LevelClassifier({ targetDb: 90, softMarginDb: 2, hardMarginDb: 5, sustainedSeconds: 8 });
  let transitions = 0;
  for (let t = 0; t <= 7.9; t += 1) {
    const r = c.update(93, t); // over soft margin (92), under hard margin (95)
    if (r.changed) transitions++;
  }
  assert.equal(c.status, STATUS.OK, 'not sustained for 8s yet');
  const atThreshold = c.update(93, 8);
  assert.equal(atThreshold.status, STATUS.WARN);
  assert.equal(atThreshold.changed, true);
  transitions += atThreshold.changed ? 1 : 0;
  const again = c.update(93, 9);
  assert.equal(again.changed, false, 'status stays WARN, must not re-fire the transition every tick');
  assert.equal(transitions, 1);
});

test('LevelClassifier escalates from warn to alert when hard margin is sustained', () => {
  const c = new LevelClassifier({ targetDb: 90, softMarginDb: 2, hardMarginDb: 5, sustainedSeconds: 4 });
  for (let t = 0; t <= 4; t += 1) c.update(93, t); // sustained soft-margin overage
  assert.equal(c.status, STATUS.WARN);
  for (let t = 5; t <= 9; t += 1) c.update(97, t); // now over hard margin (95), sustained from t=5
  assert.equal(c.status, STATUS.ALERT);
});

test('LevelClassifier supports an optional sustained "too quiet" floor, disabled by default (null)', () => {
  const disabled = new LevelClassifier({ targetDb: 90, softMarginDb: 2, hardMarginDb: 5, sustainedSeconds: 3, quietTargetDb: null });
  for (let t = 0; t <= 10; t++) disabled.update(50, t); // way below any sane target
  assert.equal(disabled.status, STATUS.OK, 'quiet warning must be off when quietTargetDb is null');

  const enabled = new LevelClassifier({ targetDb: 90, softMarginDb: 2, hardMarginDb: 5, sustainedSeconds: 3, quietTargetDb: 75 });
  for (let t = 0; t <= 3; t++) enabled.update(60, t);
  assert.equal(enabled.status, STATUS.QUIET);
});

/* ----------------------------- mock frame source ---------------------------- */

test('mockLoudnessFrame produces a frame whose measured RMS matches the drifting state exactly', () => {
  const state = { levelDbfs: -20, spikeRemaining: 0, spikeBoostDb: 0 };
  const orig = Math.random;
  let calls = 0;
  Math.random = () => {
    calls++;
    if (calls === 1) return 0.5; // drift roll: (0.5-0.5)*0.6 = 0 -> no change
    if (calls === 2) return 0.5; // spike trigger roll: 0.5 >= 0.01 -> no spike
    return orig();
  };
  try {
    const frame = mockLoudnessFrame(state, 48000, 0.1);
    assert.ok(Math.abs(state.levelDbfs - (-20)) < 1e-9, 'no drift this call');
    assert.equal(state.spikeRemaining, 0);
    assert.ok(Math.abs(rmsDbfs(frame) - (-20)) < 1e-6);
  } finally {
    Math.random = orig;
  }
});

test('mockLoudnessFrame occasionally spikes well above the drifting baseline', () => {
  const state = { levelDbfs: -20, spikeRemaining: 0, spikeBoostDb: 0 };
  const orig = Math.random;
  let calls = 0;
  Math.random = () => {
    calls++;
    if (calls === 1) return 0.5;   // no drift
    if (calls === 2) return 0.005; // < 0.01 -> triggers a spike
    if (calls === 3) return 0.5;   // spikeRemaining = 3 + floor(0.5*4) = 5
    if (calls === 4) return 0.5;   // spikeBoostDb = 4 + 0.5*6 = 7
    return orig();
  };
  try {
    const frame = mockLoudnessFrame(state, 48000, 0.1);
    assert.equal(state.spikeRemaining, 5);
    assert.ok(Math.abs(rmsDbfs(frame) - (-13)) < 1e-6, 'frame should measure at baseline + boost (-20 + 7 = -13 dBFS)');
  } finally {
    Math.random = orig;
  }
});

/* ------------------------------ LoudnessMonitor ---------------------------- */

function baseConfig(overrides = {}) {
  return {
    mode: 'mock',
    audio: { sampleRate: 1000, splDbOffset: null },
    loudnessMonitor: {
      enabled: true, referencePositionId: 'p1', targetDb: 90, softMarginDb: 2,
      hardMarginDb: 5, sustainedSeconds: 2, integrationWindow: 'LEQ10', quietTargetDb: null,
      ...overrides
    }
  };
}

// Every monitor that ever calls start()+stop() MUST get a temp dataDir --
// stop() persists a record unconditionally, and the default dataDir is the
// real data/ folder relative to cwd (see docs/DECISIONS.md's test-pollution
// history for tune sessions; the same footgun applies here).
function tmpDataDir(prefix = 'wing-loudness-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('LoudnessMonitor.pushFrame is a no-op until start() has been called', () => {
  const events = [];
  const monitor = new LoudnessMonitor({ config: baseConfig(), room: {}, emit: (e, p) => events.push([e, p]), dataDir: tmpDataDir() });
  const result = monitor.pushFrame(new Float64Array(100).fill(1));
  assert.equal(result, null);
  assert.equal(events.length, 0);
});

test('LoudnessMonitor.start() does nothing when loudnessMonitor.enabled is false', () => {
  const monitor = new LoudnessMonitor({ config: baseConfig({ enabled: false }), room: {}, dataDir: tmpDataDir() });
  monitor.start();
  assert.equal(monitor.running, false);
});

test('LoudnessMonitor broadcasts a throttled "loudness" event and reflects sustained status', () => {
  const events = [];
  const cfg = baseConfig();
  const monitor = new LoudnessMonitor({ config: cfg, room: {}, emit: (e, p) => events.push([e, p]), dataDir: tmpDataDir() });
  monitor.start();
  try {
    const overFrame = new Float64Array(1000).fill(Math.pow(10, 93 / 20)); // ~93 dBFS RMS, 1s @ sr=1000
    for (let i = 0; i < 4; i++) monitor.pushFrame(overFrame); // 4s, sustainedSeconds=2
    const loudnessEvents = events.filter(([e]) => e === 'loudness');
    assert.ok(loudnessEvents.length >= 1, 'should have broadcast at least once');
    const last = loudnessEvents[loudnessEvents.length - 1][1];
    assert.equal(last.status, STATUS.WARN);
  } finally {
    monitor.stop();
  }
});

test('LoudnessMonitor.currentDbfs() reflects the raw (pre-calibration) LEQ reading', () => {
  const monitor = new LoudnessMonitor({ config: baseConfig(), room: {}, dataDir: tmpDataDir() });
  assert.equal(monitor.currentDbfs(), null, 'no reading before start');
  monitor.start();
  try {
    monitor.pushFrame(new Float64Array(1000).fill(1)); // 0 dBFS
    assert.ok(Math.abs(monitor.currentDbfs() - 0) < 1e-6);
  } finally {
    monitor.stop();
  }
});

test('LoudnessMonitor.snapshot() reflects splDbOffset calibration in reported level', () => {
  const cfg = baseConfig();
  cfg.audio.splDbOffset = 115; // -20 dBFS + 115 = 95 dB SPL
  const monitor = new LoudnessMonitor({ config: cfg, room: {}, emit: () => {}, dataDir: tmpDataDir() });
  monitor.start();
  try {
    monitor.pushFrame(new Float64Array(1000).fill(Math.pow(10, -20 / 20)));
    const snap = monitor.snapshot();
    assert.ok(Math.abs(snap.levelDb - 95) < 1e-6);
  } finally {
    monitor.stop();
  }
});

test('LoudnessMonitor persists a summary record on stop(), listable via listLoudnessHistory', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-loudness-'));
  const monitor = new LoudnessMonitor({ config: baseConfig(), room: {}, emit: () => {}, dataDir: tmp });
  monitor.start();
  monitor.pushFrame(new Float64Array(1000).fill(1));      // loud, 0 dBFS
  monitor.pushFrame(new Float64Array(1000).fill(0.0001)); // quiet
  monitor.stop();

  const history = listLoudnessHistory(tmp);
  assert.equal(history.length, 1);
  assert.equal(history[0].referencePositionId, 'p1');
  assert.ok(history[0].avgDb !== null);
  assert.ok(history[0].peakDb !== null);
  assert.ok('secondsInStatus' in history[0]);
});

test('LoudnessMonitor prunes history to the most recent 5 records', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-loudness-prune-'));
  for (let i = 0; i < 7; i++) {
    const monitor = new LoudnessMonitor({ config: baseConfig(), room: {}, emit: () => {}, dataDir: tmp });
    monitor.start();
    monitor.pushFrame(new Float64Array(1000).fill(1));
    monitor.stop();
    await new Promise((r) => setTimeout(r, 5)); // ensure distinct millisecond timestamps
  }
  assert.equal(listLoudnessHistory(tmp).length, 5);
});

test('listLoudnessHistory returns an empty array when nothing has been saved', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-loudness-empty-'));
  assert.deepEqual(listLoudnessHistory(tmp), []);
});

test('LoudnessMonitor.stop() before any frame is pushed does not write a record', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-loudness-nostart-'));
  const monitor = new LoudnessMonitor({ config: baseConfig(), room: {}, emit: () => {}, dataDir: tmp });
  monitor.start();
  monitor.stop();
  assert.deepEqual(listLoudnessHistory(tmp), []);
});

/* ------------------------- Claude annotation layer -------------------------- */
// Event-driven: one call per alert EPISODE (a sustained-threshold transition
// into warn/alert), never per frame/second. Entirely fire-and-forget --
// pushFrame() must return before the (stubbed) Claude call resolves, proving
// the raw alert is never delayed by this layer.

function overFrame(db, n = 1000) {
  return new Float64Array(n).fill(Math.pow(10, db / 20));
}

test('a sustained warn transition triggers exactly one claudeReadFn call with a well-shaped payload', async () => {
  const calls = [];
  const claudeReadFn = async (payload) => { calls.push(payload); return { read: 'dynamics', note: 'Looks like a chorus peak.', confidence: 'medium' }; };
  const monitor = new LoudnessMonitor({ config: baseConfig(), room: {}, emit: () => {}, dataDir: tmpDataDir(), claudeReadFn });
  monitor.start();
  try {
    for (let i = 0; i < 4; i++) monitor.pushFrame(overFrame(93)); // sustainedSeconds=2, over soft margin (92)
    // The trigger itself is synchronous (queued inside pushFrame), but the
    // stubbed claudeReadFn call is deferred to a microtask -- wait for it
    // before inspecting `calls`, exactly like production code never does.
    await monitor.waitForPendingReads();
    assert.equal(calls.length, 1, 'exactly one call for the whole sustained episode, not one per frame');
    const p = calls[0];
    assert.equal(p.marginState, 'amber');
    assert.equal(p.targetDb, 90);
    assert.ok(p.currentDb >= 90);
    assert.ok(p.overageDurationSec >= 0);
    assert.ok(Array.isArray(p.recentTrend));
    assert.equal(p.currentSongLabel, null);
  } finally {
    monitor.stop();
  }
});

test('pushFrame returns before the Claude call resolves — the raw alert is never delayed', async () => {
  let releaseClaudeCall;
  const gate = new Promise((r) => { releaseClaudeCall = r; });
  const claudeReadFn = async () => { await gate; return { read: 'dynamics', note: 'fine', confidence: 'low' }; };
  const monitor = new LoudnessMonitor({ config: baseConfig(), room: {}, emit: () => {}, dataDir: tmpDataDir(), claudeReadFn });
  monitor.start();
  try {
    let lastResult;
    for (let i = 0; i < 4; i++) lastResult = monitor.pushFrame(overFrame(93));
    // The transition already happened and was returned synchronously...
    assert.equal(lastResult.status, STATUS.WARN);
    // ...while the Claude call is still gated shut (deliberately unresolved).
    const transition = monitor.transitions.find((t) => t.status === STATUS.WARN);
    assert.equal(transition.claudeRead, undefined, 'no annotation yet — the call has not resolved');
    releaseClaudeCall();
    await monitor.waitForPendingReads();
    assert.deepEqual(transition.claudeRead, { read: 'dynamics', note: 'fine', confidence: 'low' });
  } finally {
    monitor.stop();
  }
});

test('a claudeReadFn failure resolves to claudeRead: null and never throws', async () => {
  const claudeReadFn = async () => { throw new Error('network blip'); };
  const events = [];
  const monitor = new LoudnessMonitor({ config: baseConfig(), room: {}, emit: (e, p) => events.push([e, p]), dataDir: tmpDataDir(), claudeReadFn });
  monitor.start();
  try {
    for (let i = 0; i < 4; i++) monitor.pushFrame(overFrame(93));
    await monitor.waitForPendingReads();
    const transition = monitor.transitions.find((t) => t.status === STATUS.WARN);
    assert.equal(transition.claudeRead, null);
    assert.ok(!events.some(([e]) => e === 'loudnessRead'), 'no annotation event fired on failure');
  } finally {
    monitor.stop();
  }
});

test('emits a loudnessRead event only when a real annotation comes back', async () => {
  const claudeReadFn = async () => ({ read: 'ramp', note: 'Climbing steadily for a while.', confidence: 'high' });
  const events = [];
  const monitor = new LoudnessMonitor({ config: baseConfig(), room: {}, emit: (e, p) => events.push([e, p]), dataDir: tmpDataDir(), claudeReadFn });
  monitor.start();
  try {
    for (let i = 0; i < 4; i++) monitor.pushFrame(overFrame(93));
    await monitor.waitForPendingReads();
    const read = events.find(([e]) => e === 'loudnessRead');
    assert.ok(read, 'loudnessRead event should have fired');
    assert.equal(read[1].status, STATUS.WARN);
    assert.equal(read[1].read, 'ramp');
    assert.equal(read[1].note, 'Climbing steadily for a while.');
  } finally {
    monitor.stop();
  }
});

test('does not trigger a Claude call on frames that keep the same status (no re-fire per frame)', async () => {
  let callCount = 0;
  const claudeReadFn = async () => { callCount++; return { read: 'dynamics', note: 'ok', confidence: 'low' }; };
  const monitor = new LoudnessMonitor({ config: baseConfig(), room: {}, emit: () => {}, dataDir: tmpDataDir(), claudeReadFn });
  monitor.start();
  try {
    for (let i = 0; i < 4; i++) monitor.pushFrame(overFrame(93)); // enters WARN once
    for (let i = 0; i < 4; i++) monitor.pushFrame(overFrame(93)); // stays WARN
    await monitor.waitForPendingReads();
    assert.equal(callCount, 1);
  } finally {
    monitor.stop();
  }
});

test('does not trigger a Claude call for OK or QUIET transitions, only warn/alert', async () => {
  let callCount = 0;
  const claudeReadFn = async () => { callCount++; return { read: 'dynamics', note: 'ok', confidence: 'low' }; };
  const monitor = new LoudnessMonitor({ config: baseConfig(), room: {}, emit: () => {}, dataDir: tmpDataDir(), claudeReadFn });
  monitor.start();
  try {
    monitor.pushFrame(overFrame(60)); // well under target, no alert
    monitor.pushFrame(overFrame(60));
    await monitor.waitForPendingReads();
    assert.equal(callCount, 0);
  } finally {
    monitor.stop();
  }
});

test('escalating from warn to alert fires a second Claude call for the new episode', async () => {
  let callCount = 0;
  const claudeReadFn = async () => { callCount++; return { read: 'drift', note: 'holding hot', confidence: 'high' }; };
  // LEQ1: a 1s rolling window on 1s frames means each frame's LEQ is
  // effectively just that frame's own level (the prior frame ages out
  // before the next is read) -- otherwise the default LEQ10 window would
  // blend the 93 and 97 dB frames together into one smeared average and
  // the hard-margin crossing would never cleanly happen within this test.
  const cfg = baseConfig({ integrationWindow: 'LEQ1' });
  const monitor = new LoudnessMonitor({ config: cfg, room: {}, emit: () => {}, dataDir: tmpDataDir(), claudeReadFn });
  monitor.start();
  try {
    // sustainedSeconds=2 with 1s frames needs 3 consecutive over-margin
    // frames to fire (elapsedSeconds - since >= 2 first holds on the 3rd).
    for (let i = 0; i < 3; i++) monitor.pushFrame(overFrame(93)); // -> WARN
    for (let i = 0; i < 3; i++) monitor.pushFrame(overFrame(97)); // -> ALERT (hard margin, its own fresh timer)
    await monitor.waitForPendingReads();
    assert.equal(callCount, 2, 'warn and alert are separate episodes, each gets its own read');
  } finally {
    monitor.stop();
  }
});

test('buildRecord tallies alertReadCounts per episode, including unavailable reads', async () => {
  const tmp = tmpDataDir();
  let n = 0;
  const reads = ['dynamics', 'dynamics', null]; // null simulates a failed/unavailable call
  const claudeReadFn = async () => {
    const r = reads[n++];
    return r ? { read: r, note: 'x', confidence: 'low' } : null;
  };
  // Short window + short sustain so each 93/60 dB frame reads cleanly
  // (see the comment in the escalation test above for why LEQ1 matters
  // whenever a test alternates levels within what would otherwise be one
  // blended LEQ10 window).
  const cfg = baseConfig({ sustainedSeconds: 1, integrationWindow: 'LEQ1' });
  const monitor = new LoudnessMonitor({ config: cfg, room: {}, emit: () => {}, dataDir: tmp, claudeReadFn });
  monitor.start();
  try {
    // Episode 1: warn
    for (let i = 0; i < 2; i++) monitor.pushFrame(overFrame(93));
    // Back to ok
    for (let i = 0; i < 2; i++) monitor.pushFrame(overFrame(60));
    // Episode 2: warn again
    for (let i = 0; i < 2; i++) monitor.pushFrame(overFrame(93));
    // Back to ok
    for (let i = 0; i < 2; i++) monitor.pushFrame(overFrame(60));
    // Episode 3: warn again, this one fails
    for (let i = 0; i < 2; i++) monitor.pushFrame(overFrame(93));
    await monitor.waitForPendingReads();

    const rec = monitor.buildRecord();
    assert.deepEqual(rec.alertReadCounts, { dynamics: 2, unavailable: 1 });
  } finally {
    monitor.stop();
  }
});

test('getSongContext is threaded into the payload when provided', async () => {
  const calls = [];
  const claudeReadFn = async (payload) => { calls.push(payload); return null; };
  const getSongContext = () => ({ currentSongLabel: 'Way Maker', isWorshipSection: true });
  const monitor = new LoudnessMonitor({
    config: baseConfig(), room: {}, emit: () => {}, dataDir: tmpDataDir(), claudeReadFn, getSongContext
  });
  monitor.start();
  try {
    for (let i = 0; i < 4; i++) monitor.pushFrame(overFrame(93));
    await monitor.waitForPendingReads();
    assert.equal(calls[0].currentSongLabel, 'Way Maker');
    assert.equal(calls[0].isWorshipSection, true);
  } finally {
    monitor.stop();
  }
});

test('a genuinely over-target reading still reports WARN/ALERT status even when Claude reads it as dynamics — the annotation never overrules the measurement', async () => {
  const claudeReadFn = async () => ({ read: 'dynamics', note: 'probably just a big chorus, ignore', confidence: 'high' });
  const monitor = new LoudnessMonitor({ config: baseConfig(), room: {}, emit: () => {}, dataDir: tmpDataDir(), claudeReadFn });
  monitor.start();
  try {
    let last;
    for (let i = 0; i < 4; i++) last = monitor.pushFrame(overFrame(93));
    await monitor.waitForPendingReads();
    assert.equal(last.status, STATUS.WARN, 'status stays WARN regardless of what Claude annotates it with');
  } finally {
    monitor.stop();
  }
});
