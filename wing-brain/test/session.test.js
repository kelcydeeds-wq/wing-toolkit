// Tests for the measurement-loop hardening in src/tune/session.js:
// auto-retry once on low confidence, clip detection, and per-sweep SNR.
import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TuneSession, computeSweepLevelDbfs } from '../src/tune/session.js';
import { makeESS, fftConvolve, peakDbfs, rmsDbfs } from '../src/dsp/measure.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
const room = JSON.parse(fs.readFileSync(new URL('../config/room.json', import.meta.url), 'utf8'));

// finish() persists a session record to disk — point every session in this
// file at a throwaway temp dir so tests never touch the operator's real
// data/sessions/ history.
const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-brain-test-'));
after(() => fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true }));
function newSession(opts) { return new TuneSession({ ...opts, dataDir: TMP_DATA_DIR }); }

// "sub" is a 1:1 bus->physicalOutput pair in the shipped config (unlike
// "mains", which has two physical outputs) — the simplest fixture for tests
// that just want exactly one measurement per position.
function oneOutputConfig() {
  const bus = config.buses.find((b) => b.id === 'sub');
  const physicalOutput = config.physicalOutputs.find((o) => o.id === 'sub_out');
  return { ...config, buses: [bus], physicalOutputs: [physicalOutput] };
}

const sr = config.audio.sampleRate;
const { sweep, inverse } = makeESS({ ...config.audio.sweep, sampleRate: sr });
const captureSeconds = config.audio.sweep.seconds + config.audio.sweep.padSeconds;

/** Build a clean, high-confidence ref/mic pair with a fixed acoustic delay. */
function cleanCapture(delayMs = 20) {
  const delaySamp = Math.floor((delayMs / 1000) * sr);
  const n = Math.floor(captureSeconds * sr);
  const ref = new Float64Array(n), mic = new Float64Array(n);
  for (let i = 0; i < sweep.length && i + 100 < n; i++) ref[i + 100] = sweep[i];
  const ir = new Float64Array(delaySamp + 10);
  ir[delaySamp] = 1.0;
  const wet = fftConvolve(sweep, ir);
  for (let i = 0; i < wet.length && i + 100 < n; i++) mic[i + 100] = wet[i] * 0.4;
  return { ref, mic };
}

/** Silent mic — zero correlation with the reference, so delay confidence is exactly 0. */
function noiseCapture() {
  const n = Math.floor(captureSeconds * sr);
  const ref = new Float64Array(n), mic = new Float64Array(n);
  for (let i = 0; i < sweep.length && i + 100 < n; i++) ref[i + 100] = sweep[i];
  return { ref, mic };
}

function fakeWing() {
  return { soloOutput: async () => {}, unmuteAll: async () => {} };
}

function collectEvents() {
  const log = [];
  const emit = (event, payload) => log.push({ event, payload });
  return { log, emit };
}

test('auto-retries once on low confidence, uses the better attempt, and does not warn if retry recovers', async () => {
  let call = 0;
  const audio = { playAndCapture: async () => (call++ === 0 ? noiseCapture() : cleanCapture(20)) };
  const { log, emit } = collectEvents();
  const session = newSession({ config: oneOutputConfig(), room, audio, wing: fakeWing(), emit });

  session.start('verify');
  await session.ready();

  assert.equal(call, 2, 'should retry exactly once after a low-confidence first attempt');
  assert.equal(session.results.length, 1);
  assert.ok(session.results[0].confidence >= 3, 'kept result should be the higher-confidence retry');
  assert.ok(!log.some((e) => e.event === 'warning' && /Low confidence/.test(e.payload.message)),
    'no low-confidence warning once retry recovers');
  assert.ok(log.some((e) => e.event === 'info' && /retrying sweep/.test(e.payload.message)),
    'retry should be surfaced to the operator');
});

test('warns (not silently drops) when confidence is still low after the retry', async () => {
  const audio = { playAndCapture: async () => noiseCapture() }; // always noisy
  const { log, emit } = collectEvents();
  const session = newSession({ config: oneOutputConfig(), room, audio, wing: fakeWing(), emit });

  session.start('verify');
  await session.ready();

  assert.equal(session.results.length, 1, 'measurement still proceeds — operator decides whether to retake');
  assert.ok(log.some((e) => e.event === 'warning' && /even after retry/.test(e.payload.message)));
});

test('does not retry when the first sweep is already confident', async () => {
  let call = 0;
  const audio = { playAndCapture: async () => { call++; return cleanCapture(20); } };
  const { log, emit } = collectEvents();
  const session = newSession({ config: oneOutputConfig(), room, audio, wing: fakeWing(), emit });

  session.start('verify');
  await session.ready();

  assert.equal(call, 1, 'a clean sweep should not trigger a retry');
  assert.ok(!log.some((e) => e.event === 'info' && /retrying/.test(e.payload.message)));
});

test('flags a clipped capture and includes clipped:true in the stored result', async () => {
  const audio = {
    playAndCapture: async () => {
      const { ref, mic } = cleanCapture(20);
      mic[500] = 1.0; // slam one sample to full scale
      return { ref, mic };
    }
  };
  const { log, emit } = collectEvents();
  const session = newSession({ config: oneOutputConfig(), room, audio, wing: fakeWing(), emit });

  session.start('verify');
  await session.ready();

  assert.equal(session.results[0].clipped, true);
  assert.ok(log.some((e) => e.event === 'warning' && /Clipped capture/.test(e.payload.message)));
});

test('stores a per-sweep SNR estimate and does not warn on a clean capture', async () => {
  const audio = { playAndCapture: async () => cleanCapture(20) };
  const { log, emit } = collectEvents();
  const session = newSession({ config: oneOutputConfig(), room, audio, wing: fakeWing(), emit });

  session.start('verify');
  await session.ready();

  assert.equal(typeof session.results[0].snrDb, 'number');
  assert.ok(session.results[0].snrDb > 15, 'clean synthetic capture should read a healthy SNR');
  assert.ok(!log.some((e) => e.event === 'warning' && /signal-to-noise/.test(e.payload.message)));
});

test('warns on low SNR (quiet capture near the noise floor)', async () => {
  const audio = {
    playAndCapture: async () => {
      const n = Math.floor(captureSeconds * sr);
      const ref = new Float64Array(n), mic = new Float64Array(n);
      for (let i = 0; i < sweep.length && i + 100 < n; i++) ref[i + 100] = sweep[i];
      // Mic signal barely above a comparable noise floor everywhere -> low SNR,
      // but still correlated enough for decent delay confidence.
      const ir = new Float64Array(110); ir[100] = 1.0;
      const wet = fftConvolve(sweep, ir);
      for (let i = 0; i < wet.length && i + 100 < n; i++) mic[i + 100] = wet[i] * 1e-4;
      for (let i = 0; i < n; i++) mic[i] += (Math.random() - 0.5) * 6e-5;
      return { ref, mic };
    }
  };
  const { log, emit } = collectEvents();
  const session = newSession({ config: oneOutputConfig(), room, audio, wing: fakeWing(), emit });

  session.start('verify');
  await session.ready();

  assert.ok(session.results[0].snrDb < 15, `expected low SNR, got ${session.results[0].snrDb}`);
  assert.ok(log.some((e) => e.event === 'warning' && /signal-to-noise/.test(e.payload.message)));
});

/* -------------------- sweep level trim ---------------------- */

test('runSweep applies a negative output trim so playback level drops, without skewing the measured curve', async () => {
  let lastSweepPeak = null;
  const audio = {
    playAndCapture: async (sweepBuf) => {
      lastSweepPeak = peakDbfs(sweepBuf);
      return cleanCapture(20);
    }
  };
  const bus = oneOutputConfig().buses[0];
  const session = newSession({ config: oneOutputConfig(), room, audio, wing: fakeWing(), emit: () => {} });

  await session.runSweep({ ...bus, sweepTrimDb: -6 });
  const trimmedPeak = lastSweepPeak;
  await session.runSweep({ ...bus, sweepTrimDb: undefined }); // no trim

  const fullPeak = lastSweepPeak;
  assert.ok(Math.abs((fullPeak - trimmedPeak) - 6) < 0.1,
    `expected the -6 dB trim to lower playback peak by ~6 dB, saw ${fullPeak} vs ${trimmedPeak}`);
});

/* ------------------------ pre-flight ------------------------- */

/** Build a capture buffer with real silence padding around the blip, so the
 *  windowed-RMS noise floor in estimateSnrDb has something genuine to read —
 *  mirrors what MockAudioIO does by sizing the buffer off captureSeconds,
 *  not off the blip itself. */
function echoCapture(blip, captureSeconds, gain = 0.5) {
  const n = Math.floor(captureSeconds * sr);
  const mic = new Float64Array(n);
  for (let i = 0; i < blip.length && i + 100 < n; i++) mic[i + 100] = blip[i] * gain;
  return mic;
}

test('preflightCheck reports pass for every enabled physical output when signal returns', async () => {
  const audio = {
    setScenario: () => {},
    playAndCapture: async (blip, captureSeconds) => {
      // Simulate a live loudspeaker: mic hears a scaled, slightly delayed copy of the blip.
      const mic = echoCapture(blip, captureSeconds);
      return { ref: blip, mic };
    }
  };
  const { log, emit } = collectEvents();
  const session = newSession({ config, room, audio, wing: fakeWing(), emit });

  await session.preflightCheck();

  const enabledCount = config.physicalOutputs.filter((o) => o.enabled !== false).length;
  assert.equal(session.preflightResults.length, enabledCount);
  assert.ok(session.preflightResults.every((r) => r.pass), 'every output with a live return should pass');
  assert.equal(session.state, 'idle', 'preflight should leave the session idle when finished');
  assert.ok(log.some((e) => e.event === 'info' && /Pre-flight OK/.test(e.payload.message)));
});

test('preflightCheck flags a specific physical output with no return signal', async () => {
  // Only the "live" bus's physical output returns anything; give the live
  // one an actual echo by keying off which BUS was soloed via a stateful
  // wing mock (soloOutput receives a bus id, not a physical-output id).
  let currentBus = null;
  const wing = {
    soloOutput: async (id) => { currentBus = id; },
    unmuteAll: async () => {}
  };
  const audioStateful = {
    setScenario: () => {},
    playAndCapture: async (blip, captureSeconds) => {
      const n = Math.floor(captureSeconds * sr);
      const mic = currentBus === 'sub' ? echoCapture(blip, captureSeconds) : new Float64Array(n);
      return { ref: blip, mic };
    }
  };
  const liveBus = config.buses.find((b) => b.id === 'sub');
  const liveOut = { ...config.physicalOutputs.find((o) => o.id === 'sub_out') };
  const deadBus = { ...config.buses.find((b) => b.id === 'center_fill'), id: 'dead_bus' };
  const deadOut = { ...config.physicalOutputs.find((o) => o.id === 'center_fill_out'), id: 'dead_out', sourceBusId: 'dead_bus' };
  const twoOutputCfg = { ...config, buses: [liveBus, deadBus], physicalOutputs: [liveOut, deadOut] };
  const { log, emit } = collectEvents();
  const session = newSession({ config: twoOutputCfg, room, audio: audioStateful, wing, emit });

  await session.preflightCheck();

  const live = session.preflightResults.find((r) => r.outputId === 'sub_out');
  const dead = session.preflightResults.find((r) => r.outputId === 'dead_out');
  assert.equal(live.pass, true);
  assert.equal(dead.pass, false);
  assert.ok(log.some((e) => e.event === 'warning' && /returned no usable signal/.test(e.payload.message)));
});

test('blipForOutput picks a test tone inside the bus\'s configured band, not a fixed broadband frequency', () => {
  const session = newSession({ config, room, audio: fakeWing(), wing: fakeWing(), emit: () => {} });
  for (const bus of config.buses) {
    const [lo, hi] = bus.band;
    const blip = session.blipForOutput(bus);
    // Recover the tone's dominant frequency via a zero-crossing count over
    // a clean stretch of the (windowed) blip, rather than re-deriving the
    // exact formula blipForOutput uses internally.
    let crossings = 0;
    for (let i = 1; i < blip.length; i++) {
      if (blip[i - 1] <= 0 && blip[i] > 0) crossings++;
    }
    const freq = crossings / (blip.length / sr);
    assert.ok(freq > lo && freq < hi, `${bus.id}: test tone ${freq.toFixed(0)} Hz should sit inside band [${lo}, ${hi}]`);
  }
});

test('preflightCheck fails a clipped capture even though its peak clears minPeakDbfs', async () => {
  const audio = {
    setScenario: () => {},
    playAndCapture: async (blip, captureSeconds) => {
      const mic = echoCapture(blip, captureSeconds, 50); // absurd gain -> clipped, like the sub-resonance bug
      return { ref: blip, mic };
    }
  };
  const { log, emit } = collectEvents();
  const session = newSession({ config: oneOutputConfig(), room, audio, wing: fakeWing(), emit });

  await session.preflightCheck();

  const result = session.preflightResults[0];
  assert.equal(result.clipped, true);
  assert.equal(result.pass, false, 'a clipped reading must not be reported as a pass, regardless of peak level');
  assert.ok(log.some((e) => e.event === 'warning' && /clipped/.test(e.payload.message)));
});

test('preflightCheck refuses to run while a session is already in progress', async () => {
  const audio = { playAndCapture: async () => cleanCapture(20) };
  const session = newSession({ config: oneOutputConfig(), room, audio, wing: fakeWing(), emit: () => {} });
  session.start('verify'); // state -> waiting_position
  await assert.rejects(() => session.preflightCheck(), /cannot pre-flight while a session is running/);
});

/* -------------------- low-confidence exclusion from correction -------------------- */
// A 300-500ms "delay" is not physically plausible for a real room -- it's the
// signature of findDelay() locking onto noise instead of a real correlation
// peak (its search window defaults to 500ms). The system already warns on
// this; these tests cover the harder guarantee: a low-confidence reading can
// never make it into what apply() actually writes to the console.

test('a low-confidence measurement is excluded from the correction, but stays in the raw session record', async () => {
  const audio = { playAndCapture: async () => noiseCapture() }; // always noisy -> stays low-confidence after retry
  const session = newSession({ config: oneOutputConfig(), room, audio, wing: fakeWing(), emit: () => {} });
  session.start('full');
  await session.ready(); // one position measured

  assert.equal(session.results.length, 1, 'the raw (untrusted) measurement is still recorded');
  const rec = session.buildRecommendations();
  assert.equal(rec.perOutput.sub, undefined, 'no correction built for a bus whose only data point was low-confidence');
  assert.equal(rec.excludedLowConfidenceCount, 1);
  assert.deepEqual(rec.busesWithNoUsableData, ['Sub']);
});

test('one low-confidence position among several does not block a bus that has other good data', async () => {
  // Branch on which POSITION is being measured (not a raw call counter --
  // the low-confidence retry itself adds a second playAndCapture call within
  // the same position, so a naive "first call is noisy" mock would let the
  // retry quietly rescue position 1 instead of keeping it genuinely noisy).
  let pos = 0;
  const audio = { playAndCapture: async () => (pos === 0 ? noiseCapture() : cleanCapture(20)) };
  const session = newSession({ config: oneOutputConfig(), room, audio, wing: fakeWing(), emit: () => {} });
  session.start('full');
  await session.ready(); // position 0: noisy on both the initial try and the retry
  pos = 1;
  await session.ready(); // position 1: clean

  const rec = session.buildRecommendations();
  assert.ok(rec.perOutput.sub, 'the bus still gets a correction from its one good measurement');
  assert.equal(rec.excludedLowConfidenceCount, 1);
  assert.deepEqual(rec.busesWithNoUsableData, []);
});

test('finish() warns about excluded measurements and buses left with no usable data', async () => {
  const audio = { playAndCapture: async () => noiseCapture() };
  const log = [];
  const session = newSession({
    config: oneOutputConfig(), room: { ...room, positions: room.positions.filter((p) => p.id === room.verifyPosition) },
    audio, wing: fakeWing(), emit: (event, payload) => log.push({ event, payload })
  });
  session.start('full');
  await session.ready(); // last position -> finish() runs automatically

  assert.ok(log.some((e) => e.event === 'warning' && /excluded from correction/.test(e.payload.message)));
  assert.ok(log.some((e) => e.event === 'warning' && /Sub: every measurement/.test(e.payload.message)));
});

test('recommendDelays only ever sees confidence-filtered rows (a noisy reading cannot skew the bus delay average)', async () => {
  // Branch on which POSITION is being measured, not a raw call counter --
  // the retry adds a second call within position 0, which would otherwise
  // rescue it back to clean and defeat the point of this test.
  let pos = 0;
  // Position 0 noisy (would-be bogus delay near the 500ms search ceiling if
  // it were allowed through), positions 1-2 clean 20ms-delay readings.
  const audio = { playAndCapture: async () => (pos === 0 ? noiseCapture() : cleanCapture(20)) };
  const session = newSession({ config: oneOutputConfig(), room, audio, wing: fakeWing(), emit: () => {} });
  session.start('full');
  await session.ready(); pos = 1;
  await session.ready(); pos = 2;
  await session.ready();

  const rec = session.buildRecommendations();
  assert.equal(rec.excludedLowConfidenceCount, 1, 'the noisy position should have been excluded');
  // measuredMs is the averaged arrival time that fed the alignment math --
  // if the noisy reading had leaked in, this would be dragged toward
  // wherever its noise-driven correlation peak landed (up to ~500ms).
  // With only the clean 20ms readings, it should sit right at ~20ms.
  assert.ok(Math.abs(rec.delays.sub.measuredMs - 20) < 2,
    `measuredMs should reflect only the clean ~20ms measurements, got ${rec.delays.sub.measuredMs}ms`);
});

/* -------------------- level-aware sweep control -------------------- */
// config.audio.sweep.targetSplDb + splDbOffset (one-time loudness-monitor
// calibration) compute a representative sweep level automatically -- no
// live/manual SPL reading per sweep or per position. Separately, an
// auto-SNR safety net captures ~1s of ambient noise before every sweep and
// raises the level (capped at maxLevelDbfs) if it wouldn't clear the noise
// floor by minSnrMarginDb. The auto-SNR check is feature-detected on
// audio.captureAmbient (see checkAmbientAndMaybeRaise's doc comment) so
// every plain `{ playAndCapture }` test double above this section is
// completely unaffected -- no extra scripted call to account for.

test('computeSweepLevelDbfs falls back to the fixed levelDbfs when splDbOffset is uncalibrated', () => {
  const r = computeSweepLevelDbfs({ splDbOffset: null, sweep: { levelDbfs: -18, targetSplDb: 90 } });
  assert.deepEqual(r, { levelDbfs: -18, calibrated: false });
});

test('computeSweepLevelDbfs computes dBFS from targetSplDb + splDbOffset once calibrated', () => {
  // dbfsToSpl(-24, 114) === 90 -> splToDbfs(90, 114) === -24
  const r = computeSweepLevelDbfs({ splDbOffset: 114, sweep: { levelDbfs: -18, targetSplDb: 90 } });
  assert.equal(r.calibrated, true);
  assert.ok(Math.abs(r.levelDbfs - -24) < 1e-9);
});

test('computeSweepLevelDbfs clamps the computed level into the safe -60..-6 dBFS band', () => {
  const tooQuiet = computeSweepLevelDbfs({ splDbOffset: 200, sweep: { levelDbfs: -18, targetSplDb: 90 } }); // needed = -110
  assert.equal(tooQuiet.levelDbfs, -60);
  const tooLoud = computeSweepLevelDbfs({ splDbOffset: -100, sweep: { levelDbfs: -18, targetSplDb: 90 } }); // needed = 190
  assert.equal(tooLoud.levelDbfs, -6);
});

test('TuneSession builds its sweep buffer at the target-SPL-derived level once calibrated', () => {
  const cfg = { ...oneOutputConfig(), audio: { ...config.audio, splDbOffset: 114, sweep: { ...config.audio.sweep, targetSplDb: 90 } } };
  const session = newSession({ config: cfg, room, audio: { playAndCapture: async () => cleanCapture(20) }, wing: fakeWing(), emit: () => {} });

  assert.equal(session.sweepLevelCalibrated, true);
  assert.ok(Math.abs(session.baseSweepLevelDbfs - -24) < 1e-6);
  assert.ok(Math.abs(peakDbfs(session.sweep) - -24) < 0.5,
    'built sweep buffer amplitude should reflect the computed target-SPL level');
});

test('TuneSession falls back to the fixed levelDbfs when uncalibrated (splDbOffset null)', () => {
  const cfg = oneOutputConfig(); // config/default.json ships splDbOffset: null
  const session = newSession({ config: cfg, room, audio: { playAndCapture: async () => cleanCapture(20) }, wing: fakeWing(), emit: () => {} });

  assert.equal(session.sweepLevelCalibrated, false);
  assert.equal(session.baseSweepLevelDbfs, config.audio.sweep.levelDbfs);
});

test('auto-SNR check raises the sweep level when a loud ambient noise floor would swamp it', async () => {
  let captured = { peak: null };
  // oneOutputConfig() uses the "sub" bus, which carries a -6 dB sweepTrimDb --
  // the planned level for THIS bus is levelDbfs + sweepTrimDb, not the raw
  // config value.
  const plannedLevelDbfs = config.audio.sweep.levelDbfs + config.buses.find((b) => b.id === 'sub').sweepTrimDb;
  const audio = {
    captureAmbient: async (seconds) => {
      // Loud ambient noise: ~-30 dBFS RMS, well above the -24 dBFS planned sweep level.
      const n = Math.floor(seconds * sr);
      const mic = new Float64Array(n);
      const gain = Math.pow(10, -25 / 20);
      for (let i = 0; i < n; i++) mic[i] = (Math.random() * 2 - 1) * gain;
      return { mic };
    },
    playAndCapture: async (sweepBuf) => {
      captured.peak = peakDbfs(sweepBuf);
      return cleanCapture(20);
    }
  };
  const { log, emit } = collectEvents();
  const session = newSession({ config: oneOutputConfig(), room, audio, wing: fakeWing(), emit });

  session.start('verify');
  await session.ready();

  assert.ok(captured.peak > plannedLevelDbfs + 1,
    `sweep level should have been auto-raised above the planned ${plannedLevelDbfs} dBFS, got ${captured.peak}`);
  assert.ok(captured.peak <= config.audio.sweep.maxLevelDbfs + 0.1, 'raise must stay capped at maxLevelDbfs');
  assert.ok(log.some((e) => e.event === 'info' && /auto-raised sweep level/.test(e.payload.message)));
});

test('auto-SNR check does not raise the sweep level when ambient noise is already well clear', async () => {
  const plannedLevelDbfs = config.audio.sweep.levelDbfs + config.buses.find((b) => b.id === 'sub').sweepTrimDb;
  let captured = { peak: null };
  const audio = {
    captureAmbient: async () => ({ mic: new Float64Array(48000).fill(0) }), // silence
    playAndCapture: async (sweepBuf) => { captured.peak = peakDbfs(sweepBuf); return cleanCapture(20); }
  };
  const { log, emit } = collectEvents();
  const session = newSession({ config: oneOutputConfig(), room, audio, wing: fakeWing(), emit });

  session.start('verify');
  await session.ready();

  assert.ok(Math.abs(captured.peak - plannedLevelDbfs) < 0.5, 'sweep level should stay at its planned level');
  assert.ok(!log.some((e) => e.event === 'info' && /auto-raised sweep level/.test(e.payload.message)));
});

test('auto-SNR check is a no-op for audio implementations without captureAmbient (backward compatible)', async () => {
  let calls = 0;
  const audio = { playAndCapture: async () => { calls++; return cleanCapture(20); } };
  const session = newSession({ config: oneOutputConfig(), room, audio, wing: fakeWing(), emit: () => {} });

  session.start('verify');
  await session.ready();

  assert.equal(calls, 1, 'no extra ambient-probe call when captureAmbient is not implemented');
});
