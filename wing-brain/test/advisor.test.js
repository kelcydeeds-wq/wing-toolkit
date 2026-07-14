// Tests for src/tune/advisor.js — the guardrail clamp (validate) must survive
// hostile or malformed advisor responses, and the payload builder must respect
// zone weights. No network calls here; claudeTune itself is exercised only for
// its no-key fast path.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { buildAnalysisPayload, claudeTune, validate } from '../src/tune/advisor.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
const g = config.guardrails;

/* ------------------- validate() clamping ------------------- */

test('validate clamps hostile gains, Q, and filter count to guardrails', () => {
  const hostile = {
    summary: 'x',
    outputs: {
      mains: {
        filters: Array.from({ length: 40 }, (_, i) => ({
          type: 'peq', freq: 100 + i * 5, gainDb: i % 2 ? 40 : -60, q: 100, reason: 'r'.repeat(500)
        })),
        note: 'n'.repeat(1000)
      }
    },
    delays: { mains: { addDelayMs: 99999 } }
  };
  const v = validate(hostile, config);
  const filters = v.outputs.mains.filters;
  assert.ok(filters.length <= g.maxFiltersPerOutput, 'filter count capped');
  for (const f of filters) {
    assert.ok(f.gainDb <= g.maxBoostDb && f.gainDb >= -g.maxCutDb, `gain ${f.gainDb} escapes clamp`);
    assert.ok(f.q <= g.maxQ, `q ${f.q} escapes clamp`);
    assert.ok(f.reason.length <= 80, 'reason truncated');
  }
  assert.ok(v.outputs.mains.note.length <= 200, 'note truncated');
  assert.equal(v.delays.mains.addDelayMs, 200, 'delay hard-capped at 200 ms');
});

test('validate drops malformed filters instead of crashing', () => {
  const malformed = {
    outputs: {
      mains: {
        filters: [
          { type: 'peq', freq: 'DROP TABLE', gainDb: 3 },     // non-numeric freq
          { type: 'peq', freq: 200, gainDb: NaN },            // NaN gain
          { type: 'peq', freq: Infinity, gainDb: 2 },         // infinite freq
          { type: 'weird', freq: 250, gainDb: -3, q: 2 },     // unknown type → coerced to peq
          null, undefined, 42, 'string'                        // garbage entries
        ].filter((x) => x !== null && x !== undefined && typeof x === 'object')
      }
    }
  };
  const v = validate(malformed, config);
  const filters = v.outputs.mains.filters;
  assert.equal(filters.length, 1, 'only the coercible filter survives');
  assert.equal(filters[0].type, 'peq', 'unknown filter type coerced to peq');
});

test('validate enforces per-output band and the no-boost-below floor', () => {
  const advice = {
    outputs: {
      sub: {
        filters: [
          { type: 'peq', freq: 1000, gainDb: -4, q: 2 },  // way outside sub band → dropped
          { type: 'peq', freq: 60, gainDb: 3, q: 2 },     // boost below noBoostBelowHz → dropped
          { type: 'peq', freq: 55, gainDb: -4, q: 2 }     // legit sub cut → kept
        ]
      }
    }
  };
  const v = validate(advice, config);
  const filters = v.outputs.sub.filters;
  assert.equal(filters.length, 1);
  assert.equal(filters[0].freq, 55);
  assert.ok(filters[0].gainDb < 0);
});

test('validate ignores advisor-invented outputs and negative/garbage delays', () => {
  const advice = {
    outputs: { not_a_real_output: { filters: [{ type: 'peq', freq: 100, gainDb: -3, q: 2 }] } },
    delays: { mains: { addDelayMs: -50 }, side_fills: { addDelayMs: 'lots' }, _note: 'x' }
  };
  const v = validate(advice, config);
  assert.equal(v.outputs.not_a_real_output, undefined, 'unknown output ignored');
  assert.equal(v.delays.mains.addDelayMs, 0, 'negative delay floored at 0');
  assert.equal(v.delays.side_fills.addDelayMs, 0, 'non-numeric delay coerced to 0');
});

test('validate tolerates a completely empty advisor response', () => {
  const v = validate({}, config);
  assert.deepEqual(v.warnings, []);
  assert.equal(typeof v.summary, 'string');
});

/* ------------------- payload builder ----------------------- */

function fakeResults() {
  const freqs = Array.from({ length: 64 }, (_, i) => 20 * Math.pow(1000, i / 63));
  const rows = [];
  for (const bus of config.buses) {
    rows.push({
      outputId: bus.id, positionId: 'p1', positionWeight: 1, zone: 'main',
      delayMs: 20, confidence: 12, polarity: 1, levelDbfs: -20,
      freqs, magDb: freqs.map(() => 0)
    });
    rows.push({
      outputId: bus.id, positionId: 'p7', positionWeight: 0, zone: 'balcony',
      delayMs: 60, confidence: 12, polarity: 1, levelDbfs: -30,
      freqs, magDb: freqs.map(() => 50) // wildly different — must not skew the average
    });
  }
  return rows;
}

test('buildAnalysisPayload excludes weight-0 positions from the averaged curves', () => {
  const payload = buildAnalysisPayload({
    config, room: { name: 'r', positions: [], speakers: [] },
    results: fakeResults(), localRec: null
  });
  for (const [id, o] of Object.entries(payload.outputs)) {
    for (const [, db] of o.avgResponseDb) {
      assert.ok(Math.abs(db) < 1, `${id} average contaminated by weight-0 curve (${db} dB)`);
    }
  }
});

test('buildAnalysisPayload downsamples curves to ~48 points and includes guardrails', () => {
  const payload = buildAnalysisPayload({
    config, room: { name: 'r', positions: [], speakers: [] },
    results: fakeResults(), localRec: null
  });
  const first = Object.values(payload.outputs)[0];
  assert.ok(first.avgResponseDb.length <= 48);
  assert.deepEqual(payload.guardrails, config.guardrails);
});

/* --------------------- claudeTune -------------------------- */

test('claudeTune returns null without an API key (offline fallback path)', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal(await claudeTune({}), null);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});
