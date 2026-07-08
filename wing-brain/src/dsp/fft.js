// fft.js — minimal in-place radix-2 complex FFT. Zero dependencies.
// Interleaved [re, im, re, im, ...] Float64Arrays, size must be a power of two.

export function fft(buf, inverse = false) {
  const n = buf.length / 2;
  if (n & (n - 1)) throw new Error('FFT size must be a power of two');

  // Bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = buf[2 * i]; buf[2 * i] = buf[2 * j]; buf[2 * j] = t;
      t = buf[2 * i + 1]; buf[2 * i + 1] = buf[2 * j + 1]; buf[2 * j + 1] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 1 : -1) * 2 * Math.PI) / len;
    const wRe = Math.cos(ang), wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = buf[2 * (i + k)], aIm = buf[2 * (i + k) + 1];
        const bRe = buf[2 * (i + k + len / 2)], bIm = buf[2 * (i + k + len / 2) + 1];
        const tRe = bRe * curRe - bIm * curIm;
        const tIm = bRe * curIm + bIm * curRe;
        buf[2 * (i + k)] = aRe + tRe;
        buf[2 * (i + k) + 1] = aIm + tIm;
        buf[2 * (i + k + len / 2)] = aRe - tRe;
        buf[2 * (i + k + len / 2) + 1] = aIm - tIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
  if (inverse) for (let i = 0; i < buf.length; i++) buf[i] /= n;
  return buf;
}

/** Real signal → interleaved complex spectrum of given size (zero-padded). */
export function rfft(x, size) {
  const buf = new Float64Array(size * 2);
  for (let i = 0; i < Math.min(x.length, size); i++) buf[2 * i] = x[i];
  return fft(buf, false);
}

export function ifft(buf) {
  return fft(buf, true);
}
