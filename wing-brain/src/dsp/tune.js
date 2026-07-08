// tune.js — turns measurements into guarded recommendations.
// Philosophy (see MASTER_BUILD_PLAN): rigorous below 300 Hz, tilt-only above,
// cut-biased, never boost into a null, human taps Apply.

/** Interpolate the target curve (log-f linear-dB) onto a freqs grid. */
export function targetOnGrid(targetPoints, freqs) {
  const pts = targetPoints.map(([f, d]) => [Math.log10(f), d]).sort((a, b) => a[0] - b[0]);
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const lf = Math.log10(freqs[i]);
    if (lf <= pts[0][0]) { out[i] = pts[0][1]; continue; }
    if (lf >= pts[pts.length - 1][0]) { out[i] = pts[pts.length - 1][1]; continue; }
    for (let k = 0; k < pts.length - 1; k++) {
      if (lf >= pts[k][0] && lf <= pts[k + 1][0]) {
        const t = (lf - pts[k][0]) / (pts[k + 1][0] - pts[k][0]);
        out[i] = pts[k][1] + t * (pts[k + 1][1] - pts[k][1]);
        break;
      }
    }
  }
  // Normalize target to 0 mean over 200–2k so it compares to normalized measurements
  let ref = 0, n = 0;
  for (let i = 0; i < freqs.length; i++) {
    if (freqs[i] >= 200 && freqs[i] <= 2000) { ref += out[i]; n++; }
  }
  ref /= Math.max(n, 1);
  for (let i = 0; i < freqs.length; i++) out[i] -= ref;
  return out;
}

/**
 * Weighted spatial average of magnitude responses + per-point variance.
 * measurements: [{ magDb: Float64Array, weight }] sharing one freqs grid.
 */
export function spatialAverage(measurements) {
  const len = measurements[0].magDb.length;
  const avg = new Float64Array(len);
  const varDb = new Float64Array(len);
  let wSum = 0;
  for (const m of measurements) wSum += m.weight;
  for (let i = 0; i < len; i++) {
    let s = 0;
    for (const m of measurements) s += m.weight * m.magDb[i];
    avg[i] = s / wSum;
  }
  for (let i = 0; i < len; i++) {
    let v = 0;
    for (const m of measurements) v += m.weight * Math.pow(m.magDb[i] - avg[i], 2);
    varDb[i] = Math.sqrt(v / wSum); // weighted std dev in dB
  }
  return { avg, varDb };
}

/**
 * Recommend parametric EQ for one output.
 * Deviations = avg - target. Below eqAutoMaxHz: parametric correction of the
 * largest stable deviations. Above: a single gentle shelf/tilt suggestion only.
 * High position-variance regions (likely position-dependent nulls/combs) are skipped.
 */
export function recommendEQ({ freqs, avg, varDb, target, guardrails, band = [40, 16000] }) {
  const g = guardrails;

  // Work only inside this output's band, renormalized within it so a sub
  // isn't judged (or "corrected") in a region it doesn't reproduce.
  const inBand = (i) => freqs[i] >= band[0] && freqs[i] <= band[1];
  let mAvg = 0, mTgt = 0, n = 0;
  for (let i = 0; i < freqs.length; i++) if (inBand(i)) { mAvg += avg[i]; mTgt += target[i]; n++; }
  mAvg /= Math.max(n, 1); mTgt /= Math.max(n, 1);

  const dev = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) dev[i] = (avg[i] - mAvg) - (target[i] - mTgt);

  const filters = [];
  const used = new Uint8Array(freqs.length);
  const chosen = []; // center freqs, for spacing enforcement

  const lowIdx = [];
  for (let i = 0; i < freqs.length; i++) {
    if (inBand(i) && freqs[i] <= g.eqAutoMaxHz && freqs[i] >= g.minFilterHz) lowIdx.push(i);
  }

  while (filters.length < g.maxFiltersPerOutput) {
    let best = -1, bestAbs = 1.0;
    for (const i of lowIdx) {
      if (used[i]) continue;
      if (varDb[i] > g.nullVarianceDb) continue;
      if (chosen.some((fc) => Math.abs(Math.log2(freqs[i] / fc)) < g.minFilterSpacingOct)) continue;
      if (Math.abs(dev[i]) > bestAbs) { bestAbs = Math.abs(dev[i]); best = i; }
    }
    if (best < 0) break;

    const fc = freqs[best];
    const isCut = dev[best] > 0;

    // Boost guards: never below noBoostBelowHz, never near unstable regions,
    // never sharper than maxBoostQ (narrow boosts ring).
    if (!isCut && (fc < g.noBoostBelowHz || varDb[best] > g.nullVarianceDb / 2)) {
      used[best] = 1; continue;
    }

    let lo = best, hi = best;
    while (lo > 0 && Math.sign(dev[lo - 1]) === Math.sign(dev[best]) &&
           Math.abs(dev[lo - 1]) > bestAbs * 0.5) lo--;
    while (hi < freqs.length - 1 && Math.sign(dev[hi + 1]) === Math.sign(dev[best]) &&
           Math.abs(dev[hi + 1]) > bestAbs * 0.5) hi++;
    const bwOct = Math.max(0.1, Math.log2(freqs[hi] / freqs[lo]));
    let q = clamp(1.41 / bwOct, g.minQ, g.maxQ);
    if (!isCut) q = Math.min(q, g.maxBoostQ);

    const gain = isCut
      ? -Math.min(bestAbs, g.maxCutDb)
      : Math.min(bestAbs, g.maxBoostDb);

    filters.push({ type: 'peq', freq: round(fc), gainDb: round1(gain), q: round1(q),
                   reason: isCut ? 'room buildup' : 'stable dip (guarded boost)' });
    chosen.push(fc);
    for (let i = lo; i <= hi; i++) used[i] = 1;
  }

  // High region tilt: only if the band actually extends up there
  if (band[1] >= 8000) {
    let hiDev = 0, n2 = 0;
    for (let i = 0; i < freqs.length; i++) {
      if (freqs[i] >= 4000 && freqs[i] <= 12000) { hiDev += dev[i]; n2++; }
    }
    hiDev /= Math.max(n2, 1);
    if (Math.abs(hiDev) > 1.5) {
      filters.push({
        type: 'hshelf', freq: 6000, q: 0.7,
        gainDb: round1(clamp(-hiDev, -g.maxCutDb, g.maxBoostDb)),
        reason: 'broad HF tilt toward target'
      });
    }
  }

  return filters;
}

/**
 * Delay alignment: reference output (usually mains) stays at 0,
 * every other output gets delayed so arrivals match at the weighted listening area.
 * delays: { outputId: msAtEachPosition[] } — we align on the primary position set.
 */
export function recommendDelays(perOutputDelaysMs, referenceOutputId) {
  const avg = {};
  for (const [id, arr] of Object.entries(perOutputDelaysMs)) {
    avg[id] = arr.reduce((a, b) => a + b, 0) / arr.length;
  }
  const refMs = avg[referenceOutputId];
  // Latest arrival defines zero-added-delay; everyone else waits for it.
  const latest = Math.max(...Object.values(avg));
  const rec = {};
  for (const [id, ms] of Object.entries(avg)) {
    rec[id] = { measuredMs: round1(ms), addDelayMs: round1(latest - ms) };
  }
  rec._reference = referenceOutputId;
  rec._note = refMs !== undefined ? 'aligned to latest arrival' : 'reference missing';
  return rec;
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const round = (x) => Math.round(x);
const round1 = (x) => Math.round(x * 10) / 10;
