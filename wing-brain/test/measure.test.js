// Sanity tests for the DSP core — run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeESS, findDelay, extractIR, magnitudeResponse, isClipped, estimateSnrDb,
         makeBlip, scaleBuffer, peakDbfs }
  from '../src/dsp/measure.js';

test('cross-correlation finds a known delay and cancels shared latency', () => {
  const sr = 48000;
  const { sweep } = makeESS({ seconds: 2, sampleRate: sr });
  const shared = 600;            // pretend interface latency on BOTH channels
  const acoustic = 480;          // 10 ms acoustic flight time — the real answer

  const n = sweep.length + shared + acoustic + 1000;
  const ref = new Float64Array(n), mic = new Float64Array(n);
  for (let i = 0; i < sweep.length; i++) {
    ref[i + shared] = sweep[i];
    mic[i + shared + acoustic] = sweep[i] * 0.5;
  }
  const d = findDelay(ref, mic, sr);
  assert.ok(Math.abs(d.samples - acoustic) <= 2, `expected ~${acoustic}, got ${d.samples}`);
  assert.ok(d.confidence > 10, 'confidence should be high on clean signal');
});

test('IR extraction + magnitude response run end to end', () => {
  const sr = 48000;
  const { sweep, inverse } = makeESS({ seconds: 2, sampleRate: sr });
  const ir0 = new Float64Array(4800); ir0[0] = 1; ir0[960] = 0.4; // direct + one reflection
  // recorded = sweep convolved with ir0 (naive short conv fine at this size)
  const rec = new Float64Array(sweep.length + ir0.length);
  for (let i = 0; i < sweep.length; i++) {
    rec[i] += sweep[i];
    rec[i + 960] += 0.4 * sweep[i];
  }
  const ir = extractIR(rec, inverse, sr, 0.3);
  const { freqs, magDb } = magnitudeResponse(ir, sr);
  assert.equal(freqs.length, magDb.length);
  assert.ok(freqs[0] >= 19 && freqs[freqs.length - 1] <= 20001);
});

test('isClipped detects near-full-scale peaks and passes normal levels', () => {
  const quiet = new Float64Array(1000).map(() => (Math.random() - 0.5) * 0.1);
  assert.equal(isClipped(quiet), false);
  const hot = new Float64Array(quiet); hot[500] = 0.999;
  assert.equal(isClipped(hot), true);
});

test('estimateSnrDb reads high for a clean tone over silence, low for noise-only', () => {
  const sr = 48000;
  const n = sr; // 1 s
  const clean = new Float64Array(n);
  // silence, then a strong tone in the middle third, then silence again
  for (let i = Math.floor(n / 3); i < Math.floor(2 * n / 3); i++) {
    clean[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sr);
  }
  const snrClean = estimateSnrDb(clean, sr);
  assert.ok(snrClean > 20, `expected high SNR, got ${snrClean}`);

  const noiseOnly = new Float64Array(n).map(() => (Math.random() - 0.5) * 1e-4);
  const snrNoisy = estimateSnrDb(noiseOnly, sr);
  assert.ok(snrNoisy < snrClean, 'noise-only capture should read lower SNR than a clean tone');
});

test('makeBlip produces a short, faded, level-scaled tone burst', () => {
  const sr = 48000;
  const blip = makeBlip({ freq: 1000, seconds: 1, sampleRate: sr, levelDbfs: -18 });
  assert.equal(blip.length, sr);
  assert.ok(Math.abs(blip[0]) < 1e-6, 'fade-in should start near zero');
  assert.ok(Math.abs(blip[blip.length - 1]) < 1e-6, 'fade-out should end near zero');
  const peak = peakDbfs(blip);
  assert.ok(peak > -19 && peak < -17, `expected peak near -18 dBFS, got ${peak}`);
});

test('scaleBuffer applies relative gain and passes through unchanged at 0 dB / undefined', () => {
  const x = new Float64Array([0.1, -0.2, 0.3]);
  assert.strictEqual(scaleBuffer(x, undefined), x, 'no trim should return the same buffer, no copy');
  assert.strictEqual(scaleBuffer(x, 0), x, '0 dB trim should return the same buffer, no copy');
  const down6 = scaleBuffer(x, -6);
  const expectedGain = Math.pow(10, -6 / 20);
  for (let i = 0; i < x.length; i++) {
    assert.ok(Math.abs(down6[i] - x[i] * expectedGain) < 1e-9);
  }
  assert.notStrictEqual(down6, x, 'trimmed buffer must be a new array, not a mutation');
});
