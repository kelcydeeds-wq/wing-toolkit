// Tests for src/dsp/tune.js — delay alignment rules, zone-weighted averaging,
// band-limited EQ. Guardrail LIMITS come from config/default.json and are not
// modified here; these tests pin the BEHAVIOR against those limits.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { spatialAverage, targetOnGrid, recommendEQ, recommendDelays }
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
  const filters = recommendEQ({
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
  const filters = recommendEQ({
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
  const filters = recommendEQ({
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
  const filters = recommendEQ({
    freqs: grid, avg, varDb: flat(), target: target(), guardrails: g, band: [40, 16000]
  });
  const shelf = filters.find((f) => f.type === 'hshelf');
  assert.ok(shelf, 'bright system should get an HF shelf recommendation');
  assert.ok(shelf.gainDb < 0, 'shelf should cut, not boost');
  for (const f of filters.filter((x) => x.type === 'peq')) {
    assert.ok(f.freq <= g.eqAutoMaxHz, `parametric at ${f.freq} Hz above eqAutoMaxHz`);
  }
});
