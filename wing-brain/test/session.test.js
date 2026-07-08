// Tests for the measurement-loop hardening in src/tune/session.js:
// auto-retry once on low confidence, clip detection, and per-sweep SNR.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { TuneSession } from '../src/tune/session.js';
import { makeESS, fftConvolve } from '../src/dsp/measure.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
const room = JSON.parse(fs.readFileSync(new URL('../config/room.json', import.meta.url), 'utf8'));

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
  const oneOutputCfg = { ...config, outputs: [config.outputs[0]] };
  const session = new TuneSession({ config: oneOutputCfg, room, audio, wing: fakeWing(), emit });

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
  const oneOutputCfg = { ...config, outputs: [config.outputs[0]] };
  const session = new TuneSession({ config: oneOutputCfg, room, audio, wing: fakeWing(), emit });

  session.start('verify');
  await session.ready();

  assert.equal(session.results.length, 1, 'measurement still proceeds — operator decides whether to retake');
  assert.ok(log.some((e) => e.event === 'warning' && /even after retry/.test(e.payload.message)));
});

test('does not retry when the first sweep is already confident', async () => {
  let call = 0;
  const audio = { playAndCapture: async () => { call++; return cleanCapture(20); } };
  const { log, emit } = collectEvents();
  const oneOutputCfg = { ...config, outputs: [config.outputs[0]] };
  const session = new TuneSession({ config: oneOutputCfg, room, audio, wing: fakeWing(), emit });

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
  const oneOutputCfg = { ...config, outputs: [config.outputs[0]] };
  const session = new TuneSession({ config: oneOutputCfg, room, audio, wing: fakeWing(), emit });

  session.start('verify');
  await session.ready();

  assert.equal(session.results[0].clipped, true);
  assert.ok(log.some((e) => e.event === 'warning' && /Clipped capture/.test(e.payload.message)));
});

test('stores a per-sweep SNR estimate and does not warn on a clean capture', async () => {
  const audio = { playAndCapture: async () => cleanCapture(20) };
  const { log, emit } = collectEvents();
  const oneOutputCfg = { ...config, outputs: [config.outputs[0]] };
  const session = new TuneSession({ config: oneOutputCfg, room, audio, wing: fakeWing(), emit });

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
  const oneOutputCfg = { ...config, outputs: [config.outputs[0]] };
  const session = new TuneSession({ config: oneOutputCfg, room, audio, wing: fakeWing(), emit });

  session.start('verify');
  await session.ready();

  assert.ok(session.results[0].snrDb < 15, `expected low SNR, got ${session.results[0].snrDb}`);
  assert.ok(log.some((e) => e.event === 'warning' && /signal-to-noise/.test(e.payload.message)));
});
