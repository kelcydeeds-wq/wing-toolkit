// measure.js — measurement DSP core
// Exponential sine sweep (ESS, Farina method) generation + inverse filter,
// impulse response extraction, dual-channel transfer function, delay finding.
//
// Everything is plain Float64Array in/out. Sample rate comes from config.

import { rfft, ifft } from './fft.js';

/** Next power of two >= n */
export function nextPow2(n) {
  return 1 << Math.ceil(Math.log2(n));
}

/**
 * Generate an exponential sine sweep and its amplitude-compensated inverse.
 * Returns { sweep, inverse } — convolving (recorded ⊛ inverse) yields the IR.
 */
export function makeESS({ f1 = 20, f2 = 20000, seconds = 6, sampleRate = 48000, levelDbfs = -18 }) {
  const N = Math.floor(seconds * sampleRate);
  const sweep = new Float64Array(N);
  const w1 = 2 * Math.PI * f1;
  const w2 = 2 * Math.PI * f2;
  const K = (seconds * w1) / Math.log(w2 / w1);
  const L = seconds / Math.log(w2 / w1);
  const amp = Math.pow(10, levelDbfs / 20);

  for (let i = 0; i < N; i++) {
    const t = i / sampleRate;
    sweep[i] = amp * Math.sin(K * (Math.exp(t / L) - 1));
  }
  // Short fades to avoid clicks
  const fade = Math.floor(0.005 * sampleRate);
  for (let i = 0; i < fade; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    sweep[i] *= g;
    sweep[N - 1 - i] *= g;
  }

  // Inverse filter: time-reversed sweep with +6 dB/oct amplitude compensation
  const inverse = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / sampleRate;
    // Envelope compensates the pink energy distribution of the ESS
    const gain = Math.exp(-t / L);
    inverse[i] = sweep[N - 1 - i] * gain;
  }
  return { sweep, inverse };
}

/**
 * Short windowed tone burst for a pre-flight "is this output alive" check.
 * Deliberately simple (not a sweep) — this only needs to prove signal makes
 * it out the speaker and back into the mic, not measure a transfer function.
 */
export function makeBlip({ freq = 1000, seconds = 1, sampleRate = 48000, levelDbfs = -18 } = {}) {
  const N = Math.floor(seconds * sampleRate);
  const blip = new Float64Array(N);
  const amp = Math.pow(10, levelDbfs / 20);
  for (let i = 0; i < N; i++) blip[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  const fade = Math.floor(0.01 * sampleRate);
  for (let i = 0; i < fade && i < N; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / fade);
    blip[i] *= g;
    blip[N - 1 - i] *= g;
  }
  return blip;
}

/** Return a level-scaled copy of a signal buffer, `trimDb` relative gain (0 = unchanged). */
export function scaleBuffer(x, trimDb) {
  if (!trimDb) return x;
  const gain = Math.pow(10, trimDb / 20);
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * gain;
  return out;
}

/** FFT-based linear convolution. */
export function fftConvolve(a, b) {
  const outLen = a.length + b.length - 1;
  const size = nextPow2(outLen);
  const A = rfft(a, size);
  const B = rfft(b, size);
  const X = new Float64Array(size * 2);
  for (let i = 0; i < size; i++) {
    X[2 * i]     = A[2 * i] * B[2 * i] - A[2 * i + 1] * B[2 * i + 1];
    X[2 * i + 1] = A[2 * i] * B[2 * i + 1] + A[2 * i + 1] * B[2 * i];
  }
  const t = ifft(X);
  const res = new Float64Array(outLen);
  for (let i = 0; i < outLen; i++) res[i] = t[2 * i];
  return res;
}

/**
 * Find delay of `mic` relative to `ref` by cross-correlation peak.
 * Returns { samples, ms, confidence } — confidence is peak/rms of correlation.
 * Because both channels share one capture clock, PC/interface latency cancels.
 */
export function findDelay(ref, mic, sampleRate, maxDelayMs = 500) {
  const maxLag = Math.floor((maxDelayMs / 1000) * sampleRate);
  const size = nextPow2(ref.length + maxLag);
  const R = rfft(ref, size);
  const M = rfft(mic, size);
  const X = new Float64Array(size * 2);
  for (let i = 0; i < size; i++) {
    // conj(R) * M
    X[2 * i]     = R[2 * i] * M[2 * i] + R[2 * i + 1] * M[2 * i + 1];
    X[2 * i + 1] = R[2 * i] * M[2 * i + 1] - R[2 * i + 1] * M[2 * i];
  }
  const corr = ifft(X);
  let best = 0, bestLag = 0, sumSq = 0;
  for (let lag = 0; lag < maxLag; lag++) {
    const v = Math.abs(corr[2 * lag]);
    sumSq += v * v;
    if (v > best) { best = v; bestLag = lag; }
  }
  const rms = Math.sqrt(sumSq / maxLag) || 1e-12;
  return {
    samples: bestLag,
    ms: (bestLag / sampleRate) * 1000,
    confidence: best / rms
  };
}

/** Extract impulse response from a recorded ESS via inverse-filter convolution. */
export function extractIR(recorded, inverse, sampleRate, irSeconds = 1.0) {
  const conv = fftConvolve(recorded, inverse);
  // The linear IR sits at the point where the sweep fully overlaps the inverse.
  const start = inverse.length - 1;
  const len = Math.min(Math.floor(irSeconds * sampleRate), conv.length - start);
  const ir = new Float64Array(len);
  for (let i = 0; i < len; i++) ir[i] = conv[start + i];
  // Normalize
  let peak = 0;
  for (const v of ir) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < len; i++) ir[i] /= peak;
  return ir;
}

/**
 * Fractional-octave-smoothed magnitude response from an IR.
 * Returns { freqs: Float64Array, magDb: Float64Array } over 20..20k, log-spaced points.
 */
export function magnitudeResponse(ir, sampleRate, { points = 240, smoothOct = 1 / 6 } = {}) {
  const size = nextPow2(Math.max(ir.length, 8192));
  const spec = rfft(ir, size);

  const bins = size / 2;
  const binHz = sampleRate / size;
  const rawDb = new Float64Array(bins);
  for (let i = 1; i < bins; i++) {
    const re = spec[2 * i], im = spec[2 * i + 1];
    rawDb[i] = 10 * Math.log10(re * re + im * im + 1e-20);
  }

  const freqs = new Float64Array(points);
  const magDb = new Float64Array(points);
  const logF1 = Math.log10(20), logF2 = Math.log10(20000);
  for (let p = 0; p < points; p++) {
    const f = Math.pow(10, logF1 + (p / (points - 1)) * (logF2 - logF1));
    freqs[p] = f;
    // Smooth over ±smoothOct/2 octaves, energy average
    const fLo = f * Math.pow(2, -smoothOct / 2);
    const fHi = f * Math.pow(2, smoothOct / 2);
    const bLo = Math.max(1, Math.floor(fLo / binHz));
    const bHi = Math.min(bins - 1, Math.ceil(fHi / binHz));
    let sum = 0, n = 0;
    for (let b = bLo; b <= bHi; b++) { sum += Math.pow(10, rawDb[b] / 10); n++; }
    magDb[p] = 10 * Math.log10(sum / Math.max(n, 1) + 1e-20);
  }
  // Normalize to 0 dB mean over 200–2k (stable reference band)
  let ref = 0, n = 0;
  for (let p = 0; p < points; p++) {
    if (freqs[p] >= 200 && freqs[p] <= 2000) { ref += magDb[p]; n++; }
  }
  ref /= Math.max(n, 1);
  for (let p = 0; p < points; p++) magDb[p] -= ref;
  return { freqs, magDb };
}

/** Simple polarity estimate: sign of the IR's dominant early peak. */
export function polarity(ir) {
  let idx = 0, mag = 0;
  const scan = Math.min(ir.length, 4800); // first 100 ms
  for (let i = 0; i < scan; i++) {
    if (Math.abs(ir[i]) > mag) { mag = Math.abs(ir[i]); idx = i; }
  }
  return ir[idx] >= 0 ? 1 : -1;
}

/** Broadband level of a recording in dBFS RMS. */
export function rmsDbfs(x) {
  let s = 0;
  for (const v of x) s += v * v;
  return 10 * Math.log10(s / x.length + 1e-20);
}

/** Peak sample level in dBFS. */
export function peakDbfs(x) {
  let peak = 0;
  for (const v of x) { const a = Math.abs(v); if (a > peak) peak = a; }
  return 20 * Math.log10(peak + 1e-20);
}

/** True when a capture is at (or suspiciously near) digital full scale. */
export function isClipped(x, thresholdDbfs = -0.5) {
  return peakDbfs(x) >= thresholdDbfs;
}

/**
 * Signal-to-noise estimate for a sweep capture, in dB.
 * Windowed RMS over the capture; the quietest windows are the noise floor
 * (pad silence before/after the sweep), the loudest are the signal. Robust to
 * where exactly the sweep lands inside the capture.
 */
export function estimateSnrDb(x, sampleRate, { windowSeconds = 0.05 } = {}) {
  const win = Math.max(64, Math.floor(windowSeconds * sampleRate));
  const rms = [];
  for (let start = 0; start + win <= x.length; start += win) {
    let s = 0;
    for (let i = start; i < start + win; i++) s += x[i] * x[i];
    rms.push(Math.sqrt(s / win));
  }
  if (rms.length < 4) return 0;
  rms.sort((a, b) => a - b);
  const noise = rms[Math.floor(rms.length * 0.1)] + 1e-12;   // 10th percentile window
  const signal = rms[Math.floor(rms.length * 0.9)];          // 90th percentile window
  return Math.round(20 * Math.log10(signal / noise) * 10) / 10;
}
