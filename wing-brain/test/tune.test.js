// Tests for src/dsp/tune.js — delay alignment rules, zone-weighted averaging,
// band-limited EQ. Guardrail LIMITS come from config/default.json and are not
// modified here; these tests pin the BEHAVIOR against those limits.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { spatialAverage, targetOnGrid, recommendEQ, recommendDelays, detectPassband, crossoverSharedRegion,
         detectCrossoverCancellation }
  from '../src/dsp/tune.js';
import { activeTargetCurve } from '../src/config/settings.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
const g = config.guardrails;

/* ------------------------- helpers ------------------------- */

const grid = (() => {
  // log grid 20 Hz → 20 kHz, 128 points — mirrors magnitudeResponse output shape
  const n = 128, out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = 20 * Math.pow(1000, i / (n - 1));
  return out;
})();

const flat = () => new Float64Array(grid.length);

function resultRow({ outputId, positionId, delayMs, weight = 1 }) {
  return { outputId, positionId, delayMs, positionWeight: weight };
}

/* ---------------------- fill alignment --------------------- */

test('mains/subs align to the latest arrival; nobody gets negative delay', () => {
  const outputs = [
    { id: 'main_l', role: 'main' }, { id: 'main_r', role: 'main' }, { id: 'sub', role: 'sub' }
  ];
  const results = [
    resultRow({ outputId: 'main_l', positionId: 'p1', delayMs: 20 }),
    resultRow({ outputId: 'main_r', positionId: 'p1', delayMs: 22 }),
    resultRow({ outputId: 'sub', positionId: 'p1', delayMs: 25 })
  ];
  const rec = recommendDelays({ results, outputs, guardrails: g });
  assert.equal(rec.sub.addDelayMs, 0, 'latest arrival (sub) defines zero');
  assert.equal(rec.main_l.addDelayMs, 5);
  assert.equal(rec.main_r.addDelayMs, 3);
  for (const o of outputs) assert.ok(rec[o.id].addDelayMs >= 0);
});

test('fill gets main-first precedence: delayed to land fillPrecedenceMs after first main', () => {
  const outputs = [
    { id: 'main_l', role: 'main' },
    { id: 'fill_c', role: 'fill', alignPositions: ['p1'] }
  ];
  const results = [
    resultRow({ outputId: 'main_l', positionId: 'p1', delayMs: 30 }),
    resultRow({ outputId: 'fill_c', positionId: 'p1', delayMs: 10 })
  ];
  const rec = recommendDelays({ results, outputs, guardrails: g });
  // fill arrives 20 ms early; add 20 + precedence
  assert.equal(rec.fill_c.addDelayMs, 20 + g.fillPrecedenceMs);
  assert.match(rec.fill_c.rule, /main-first/);
});

test('fill delay is never negative even when the fill already arrives late', () => {
  const outputs = [
    { id: 'main_l', role: 'main' },
    { id: 'fill_c', role: 'fill', alignPositions: ['p1'] }
  ];
  const results = [
    resultRow({ outputId: 'main_l', positionId: 'p1', delayMs: 10 }),
    resultRow({ outputId: 'fill_c', positionId: 'p1', delayMs: 40 })
  ];
  const rec = recommendDelays({ results, outputs, guardrails: g });
  assert.equal(rec.fill_c.addDelayMs, 0);
});

test('shared-channel fill spread >4 ms triggers the compromise warning', () => {
  const outputs = [
    { id: 'main_l', role: 'main' },
    { id: 'fill_sides', role: 'fill', alignPositions: ['p2', 'p3'] }
  ];
  const results = [
    resultRow({ outputId: 'main_l', positionId: 'p2', delayMs: 30 }),
    resultRow({ outputId: 'main_l', positionId: 'p3', delayMs: 30 }),
    // fill arrives 5 ms earlier at p2 than p3 → spread 5 ms > 4 ms
    resultRow({ outputId: 'fill_sides', positionId: 'p2', delayMs: 10 }),
    resultRow({ outputId: 'fill_sides', positionId: 'p3', delayMs: 15 })
  ];
  const rec = recommendDelays({ results, outputs, guardrails: g });
  assert.equal(rec.fill_sides.spreadMs, 5);
  assert.ok(rec.fill_sides.spreadNote, 'spread over 4 ms must carry a warning note');
  assert.match(rec.fill_sides.spreadNote, /shared channel/);
});

test('shared-channel fill spread <=4 ms carries no warning', () => {
  const outputs = [
    { id: 'main_l', role: 'main' },
    { id: 'fill_sides', role: 'fill', alignPositions: ['p2', 'p3'] }
  ];
  const results = [
    resultRow({ outputId: 'main_l', positionId: 'p2', delayMs: 30 }),
    resultRow({ outputId: 'main_l', positionId: 'p3', delayMs: 30 }),
    resultRow({ outputId: 'fill_sides', positionId: 'p2', delayMs: 12 }),
    resultRow({ outputId: 'fill_sides', positionId: 'p3', delayMs: 15 })
  ];
  const rec = recommendDelays({ results, outputs, guardrails: g });
  assert.equal(rec.fill_sides.spreadNote, null);
});

test('disabled outputs and weight-0 positions are excluded from alignment', () => {
  const outputs = [
    { id: 'main_l', role: 'main' },
    { id: 'dead', role: 'main', enabled: false },
    { id: 'fill_c', role: 'fill', alignPositions: ['p1'] }
  ];
  const results = [
    resultRow({ outputId: 'main_l', positionId: 'p1', delayMs: 20 }),
    resultRow({ outputId: 'main_l', positionId: 'balc', delayMs: 90, weight: 0 }), // must not skew average
    resultRow({ outputId: 'dead', positionId: 'p1', delayMs: 500 }),
    resultRow({ outputId: 'fill_c', positionId: 'p1', delayMs: 20 })
  ];
  const rec = recommendDelays({ results, outputs, guardrails: g });
  assert.equal(rec.dead, undefined, 'disabled output gets no recommendation');
  assert.equal(rec.main_l.measuredMs, 20, 'weight-0 position excluded from main average');
});

/* ----------------- zone-weighted averaging ----------------- */

test('spatialAverage: weight-0 measurements contribute nothing', () => {
  const a = flat().fill(0), b = flat().fill(10), junk = flat().fill(100);
  const { avg } = spatialAverage([
    { magDb: a, weight: 1 }, { magDb: b, weight: 1 }, { magDb: junk, weight: 0 }
  ]);
  assert.ok(Math.abs(avg[0] - 5) < 1e-9, `expected 5, got ${avg[0]}`);
});

test('spatialAverage: weights actually weight (2:1)', () => {
  const a = flat().fill(0), b = flat().fill(9);
  const { avg } = spatialAverage([{ magDb: a, weight: 2 }, { magDb: b, weight: 1 }]);
  assert.ok(Math.abs(avg[0] - 3) < 1e-9);
});

test('spatialAverage: variance is zero for identical curves, grows with disagreement', () => {
  const a = flat().fill(4), b = flat().fill(4);
  const same = spatialAverage([{ magDb: a, weight: 1 }, { magDb: b, weight: 1 }]);
  assert.ok(same.varDb.every((v) => v < 1e-9));
  const c = flat().fill(0), d = flat().fill(8);
  const diff = spatialAverage([{ magDb: c, weight: 1 }, { magDb: d, weight: 1 }]);
  assert.ok(diff.varDb[0] > 3.9 && diff.varDb[0] < 4.1); // std dev of {0,8} = 4
});

/* ------------------- band-limited EQ ----------------------- */

const target = () => targetOnGrid(activeTargetCurve(config).points, grid);

test('recommendEQ never places filters outside the output band (sub case)', () => {
  const avg = flat();
  // Big bumps at 60 Hz (in sub band) and 500 Hz + 3 kHz (outside it)
  for (let i = 0; i < grid.length; i++) {
    if (Math.abs(Math.log2(grid[i] / 60)) < 0.2) avg[i] = 8;
    if (Math.abs(Math.log2(grid[i] / 500)) < 0.2) avg[i] = 8;
    if (Math.abs(Math.log2(grid[i] / 3000)) < 0.2) avg[i] = 8;
  }
  const { filters } = recommendEQ({
    freqs: grid, avg, varDb: flat(), target: target(), guardrails: g, band: [25, 120]
  });
  assert.ok(filters.length > 0, 'sub-band bump should produce a filter');
  for (const f of filters) {
    assert.ok(f.freq >= 25 && f.freq <= 120, `filter at ${f.freq} Hz escapes sub band`);
    assert.notEqual(f.type, 'hshelf', 'no HF shelf on a sub');
  }
});

test('recommendEQ skips high-variance regions (position-dependent nulls)', () => {
  const avg = flat(); const varDb = flat();
  for (let i = 0; i < grid.length; i++) {
    if (Math.abs(Math.log2(grid[i] / 80)) < 0.25) {
      avg[i] = 10;
      varDb[i] = g.nullVarianceDb + 2; // unstable — do not EQ
    }
  }
  const { filters } = recommendEQ({
    freqs: grid, avg, varDb, target: target(), guardrails: g, band: [40, 16000]
  });
  // Unstable region spans 80 Hz ±0.25 oct ≈ 67–95 Hz — despite the 10 dB bump
  // there, no parametric filter may be centered inside it.
  assert.ok(!filters.some((f) => f.type === 'peq' && f.freq >= 67 && f.freq <= 95),
    'no parametric filter centered in the unstable region');
});

test('recommendEQ never boosts below noBoostBelowHz and clamps gains to limits', () => {
  const avg = flat();
  for (let i = 0; i < grid.length; i++) {
    if (Math.abs(Math.log2(grid[i] / 63)) < 0.2) avg[i] = -15;  // deep dip below noBoost line
    if (Math.abs(Math.log2(grid[i] / 200)) < 0.2) avg[i] = 20;  // huge bump
  }
  const { filters } = recommendEQ({
    freqs: grid, avg, varDb: flat(), target: target(), guardrails: g, band: [40, 16000]
  });
  for (const f of filters) {
    if (f.gainDb > 0) {
      assert.ok(f.freq >= g.noBoostBelowHz, `boost at ${f.freq} Hz below noBoostBelowHz`);
      assert.ok(f.gainDb <= g.maxBoostDb + 1e-9);
      assert.ok(f.q <= g.maxBoostQ + 1e-9, 'boost Q capped');
    } else {
      assert.ok(-f.gainDb <= g.maxCutDb + 1e-9, 'cut clamped');
    }
  }
  assert.ok(filters.length <= g.maxFiltersPerOutput);
});

test('recommendEQ full-range output can get an HF tilt shelf; parametrics stay below eqAutoMaxHz', () => {
  const avg = flat();
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] >= 4000) avg[i] = 5; // bright top end vs downward-tilt target
  }
  const { filters } = recommendEQ({
    freqs: grid, avg, varDb: flat(), target: target(), guardrails: g, band: [40, 16000]
  });
  const shelf = filters.find((f) => f.type === 'hshelf');
  assert.ok(shelf, 'bright system should get an HF shelf recommendation');
  assert.ok(shelf.gainDb < 0, 'shelf should cut, not boost');
  for (const f of filters.filter((x) => x.type === 'peq')) {
    assert.ok(f.freq <= g.eqAutoMaxHz, `parametric at ${f.freq} Hz above eqAutoMaxHz`);
  }
});

/* ------------------- auto-detected passband (piece 1) ----------------- */

test('detectPassband: flat response over a known range with falloff outside recovers close to that range', () => {
  const magDb = flat().fill(-20); // floor well below the -10 dB threshold everywhere
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] >= 100 && grid[i] <= 4000) magDb[i] = 0; // flat plateau
  }
  const { lo, hi } = detectPassband({ freqs: grid, magDb, band: [100, 4000] });
  // Log-grid resolution (~4.7%/step over 128 pts, 20 Hz-20 kHz) means the
  // recovered edges land within one bin of the true step transition.
  assert.ok(Math.abs(Math.log2(lo / 100)) < 0.1, `lo=${lo} not close to 100`);
  assert.ok(Math.abs(Math.log2(hi / 4000)) < 0.1, `hi=${hi} not close to 4000`);
});

test('detectPassband: real peak outside the currently-configured band is still found, not clamped to band edges', () => {
  const magDb = flat().fill(-30); // floor
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] >= 40 && grid[i] <= 300) magDb[i] = -8;      // modest bump inside the CONFIGURED band
    if (grid[i] >= 400 && grid[i] <= 2500) magDb[i] = 0;     // the ACTUAL (louder) peak, outside it
  }
  // Configured band only covers the modest bump, not the real peak.
  const { lo, hi } = detectPassband({ freqs: grid, magDb, band: [40, 300] });
  assert.ok(lo >= 350 && lo <= 450, `expected lo near the real peak plateau (~400), got ${lo}`);
  assert.ok(hi >= 2000 && hi <= 3000, `expected hi near the real peak plateau (~2500), got ${hi}`);
});

test('detectPassband: degenerate/noisy data (edges collapse to the same rounded Hz value) falls back to the current band', () => {
  // Two adjacent bins close enough together that they round to the same
  // integer Hz -- the lo/hi edges collapse to a single point, which is the
  // "nonsense" result the function must guard against rather than return.
  const freqs = Float64Array.from([999.6, 1000.4]);
  const magDb = Float64Array.from([0, 0]);
  const result = detectPassband({ freqs, magDb, band: [900, 1100] });
  assert.deepEqual(result, { lo: 900, hi: 1100 }, 'falls back to the current band unchanged');
});

/* ------------------- crossover shared-region guarding (piece 2) ----------------- */

test('crossoverSharedRegion: returns [0.6x, 1.5x] of the crossover frequency', () => {
  assert.deepEqual(crossoverSharedRegion(100), [60, 150]);
  assert.deepEqual(crossoverSharedRegion(80), [48, 120]);
});

test('recommendEQ: sharedRegion suppresses independent filter placement inside the crossover handoff region', () => {
  const region = crossoverSharedRegion(100); // [60, 150]
  const avg = flat();
  for (let i = 0; i < grid.length; i++) {
    if (Math.abs(Math.log2(grid[i] / 100)) < 0.15) avg[i] = 8; // bump centered in the region
  }
  const without = recommendEQ({
    freqs: grid, avg, varDb: flat(), target: target(), guardrails: g, band: [40, 16000]
  });
  assert.ok(without.filters.some((f) => f.freq >= region[0] && f.freq <= region[1]),
    'sanity: without sharedRegion this bump WOULD get an independent filter inside what becomes the shared region');

  const withRegion = recommendEQ({
    freqs: grid, avg, varDb: flat(), target: target(), guardrails: g, band: [40, 16000], sharedRegion: region
  });
  assert.ok(!withRegion.filters.some((f) => f.freq >= region[0] && f.freq <= region[1]),
    'no independent filter placed inside the shared crossover handoff region');
});

test('recommendEQ: sharedRegionDeviationDb reflects the region average of the same dev array used for filter placement', () => {
  const band = [40, 16000];
  const region = crossoverSharedRegion(100); // [60, 150]
  const avg = flat();
  const targetFlat = flat(); // all-zero target -> dev == avg - mAvg
  let regionCount = 0, bandCount = 0;
  for (let i = 0; i < grid.length; i++) {
    const inBand = grid[i] >= band[0] && grid[i] <= band[1];
    const inRegion = grid[i] >= region[0] && grid[i] <= region[1];
    if (inBand) {
      bandCount++;
      if (inRegion) { avg[i] = 10; regionCount++; }
    }
  }
  const mAvg = (regionCount * 10) / bandCount; // rest of the band is 0, so this is the full in-band mean
  const expected = Math.round((10 - mAvg) * 10) / 10;

  const { sharedRegionDeviationDb } = recommendEQ({
    freqs: grid, avg, varDb: flat(), target: targetFlat, guardrails: g, band, sharedRegion: region
  });
  assert.equal(sharedRegionDeviationDb, expected);
});

test('recommendEQ: sharedRegionDeviationDb is null when sharedRegion is omitted', () => {
  const { sharedRegionDeviationDb } = recommendEQ({
    freqs: grid, avg: flat(), varDb: flat(), target: target(), guardrails: g, band: [40, 16000]
  });
  assert.equal(sharedRegionDeviationDb, null);
});

test('recommendEQ: omitting sharedRegion behaves exactly as before (zero regression for existing callers)', () => {
  const avg = flat();
  for (let i = 0; i < grid.length; i++) {
    if (Math.abs(Math.log2(grid[i] / 60)) < 0.2) avg[i] = 8;
  }
  const { filters } = recommendEQ({
    freqs: grid, avg, varDb: flat(), target: target(), guardrails: g, band: [25, 120]
  });
  assert.ok(filters.length > 0, 'unchanged behavior: sub-band bump still produces a filter with no sharedRegion supplied');
});

/* ---------------- crossover summation cancellation detection (piece 3) ---------------- */

test('detectCrossoverCancellation: combined louder than both individuals everywhere in-region -> PASS', () => {
  const subMagDb = flat().fill(-3);
  const mainsMagDb = flat().fill(-3);
  const combinedMagDb = flat().fill(2); // well above either individual, everywhere
  const result = detectCrossoverCancellation({
    freqs: grid, subMagDb, mainsMagDb, combinedMagDb, crossoverHz: 100
  });
  assert.equal(result.pass, true);
  assert.equal(result.dipFreqHz, null);
  assert.equal(result.dipDepthDb, null);
});

test('detectCrossoverCancellation: a deep notch in the combined trace only (sub/main stay flat there) -> FAIL at that frequency/depth', () => {
  const subMagDb = flat().fill(-3);
  const mainsMagDb = flat().fill(-3);
  const combinedMagDb = flat().fill(2);
  // Find the grid bin closest to the crossover frequency (100 Hz) -- the
  // deliberate notch goes there so the recovered dipFreqHz can be checked
  // against a known value.
  let notchIdx = 0, best = Infinity;
  for (let i = 0; i < grid.length; i++) {
    const d = Math.abs(Math.log2(grid[i] / 100));
    if (d < best) { best = d; notchIdx = i; }
  }
  combinedMagDb[notchIdx] = -10; // deep dip, present ONLY in the combined trace
  const result = detectCrossoverCancellation({
    freqs: grid, subMagDb, mainsMagDb, combinedMagDb, crossoverHz: 100
  });
  assert.equal(result.pass, false);
  assert.ok(Math.abs(result.dipFreqHz - grid[notchIdx]) < 1,
    `dip should land at the known notch frequency (~100 Hz), got ${result.dipFreqHz}`);
  // expectedMin(-3) - combined(-10) = 7 dB deficit
  assert.equal(result.dipDepthDb, 7);
});

test('detectCrossoverCancellation: deficit exactly at thresholdDb still passes (threshold is inclusive)', () => {
  const subMagDb = flat().fill(0);
  const mainsMagDb = flat().fill(0);
  const combinedMagDb = flat().fill(-3); // deficit of exactly 3 dB everywhere in-region
  const result = detectCrossoverCancellation({
    freqs: grid, subMagDb, mainsMagDb, combinedMagDb, crossoverHz: 100, thresholdDb: 3
  });
  assert.equal(result.pass, true);
});
