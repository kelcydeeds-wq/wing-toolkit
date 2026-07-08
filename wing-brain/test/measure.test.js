// Sanity tests for the DSP core — run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert';
import { makeESS, findDelay, extractIR, magnitudeResponse } from '../src/dsp/measure.js';

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
