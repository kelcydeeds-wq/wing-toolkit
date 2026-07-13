// Tests for src/audio/loudness-advisor.js — the sanitizer (validate) must
// survive hostile/malformed responses, the trend downsampler must bucket
// correctly, and the payload builder must shape scalars the way Claude
// expects. No network calls here; claudeLoudnessRead itself is exercised
// only for its no-key fast path (mirrors test/advisor.test.js).
import { test } from 'node:test';
import assert from 'node:assert';
import { downsampleTrend, buildLoudnessPayload, claudeLoudnessRead, validate } from '../src/audio/loudness-advisor.js';

/* ------------------------------ validate() ------------------------------- */

test('validate passes through a well-formed response unchanged', () => {
  const v = validate({ read: 'dynamics', note: 'Looks like normal song dynamics.', confidence: 'high' });
  assert.deepEqual(v, { read: 'dynamics', note: 'Looks like normal song dynamics.', confidence: 'high' });
});

test('validate coerces an unknown read/confidence to safe defaults instead of dropping the response', () => {
  const v = validate({ read: 'nonsense', note: 'x', confidence: 'extreme' });
  assert.equal(v.read, 'unclear');
  assert.equal(v.confidence, 'low');
});

test('validate truncates an overlong note and defaults a missing one to empty string', () => {
  const long = validate({ read: 'drift', note: 'x'.repeat(1000), confidence: 'medium' });
  assert.ok(long.note.length <= 160);
  const missing = validate({ read: 'drift', confidence: 'medium' });
  assert.equal(missing.note, '');
});

test('validate returns null for a non-object (e.g. claudeLoudnessRead already failed)', () => {
  assert.equal(validate(null), null);
  assert.equal(validate(undefined), null);
  assert.equal(validate('a string'), null);
  assert.equal(validate(42), null);
});

/* ---------------------------- downsampleTrend ----------------------------- */

test('downsampleTrend buckets readings into ~stepSeconds-wide averaged bins', () => {
  const readings = [
    { t: 0, levelDb: 90 }, { t: 1, levelDb: 90 },   // bucket 0 (0-5s): avg 90
    { t: 5, levelDb: 96 }, { t: 6, levelDb: 96 }     // bucket 1 (5-10s): avg 96
  ];
  const trend = downsampleTrend(readings, 10, { windowSeconds: 10, stepSeconds: 5 });
  assert.equal(trend.length, 2);
  assert.equal(trend[0].db, 90);
  assert.equal(trend[1].db, 96);
});

test('downsampleTrend excludes readings older than the window', () => {
  const readings = [
    { t: 0, levelDb: 60 },   // way outside a 10s window ending at t=100
    { t: 95, levelDb: 90 }
  ];
  const trend = downsampleTrend(readings, 100, { windowSeconds: 10, stepSeconds: 5 });
  assert.equal(trend.length, 1);
  assert.equal(trend[0].db, 90);
});

test('downsampleTrend returns an empty array for no readings in window', () => {
  assert.deepEqual(downsampleTrend([], 100), []);
});

/* -------------------------- buildLoudnessPayload --------------------------- */

test('buildLoudnessPayload shapes scalars and embeds the downsampled trend', () => {
  const readings = [{ t: 0, levelDb: 93 }, { t: 5, levelDb: 94 }];
  const payload = buildLoudnessPayload({
    currentDb: 94.567, targetDb: 90, marginState: 'amber', overageDurationSec: 8.4,
    readings, nowSeconds: 10, serviceElapsedMin: 12.345
  });
  assert.equal(payload.currentDb, 94.6);
  assert.equal(payload.targetDb, 90);
  assert.equal(payload.marginState, 'amber');
  assert.equal(payload.overageDurationSec, 8);
  assert.equal(payload.serviceElapsedMin, 12.3);
  assert.ok(Array.isArray(payload.recentTrend));
  assert.equal(payload.currentSongLabel, null);
  assert.equal(payload.isWorshipSection, null);
});

test('buildLoudnessPayload carries through optional song context when provided', () => {
  const payload = buildLoudnessPayload({
    currentDb: 90, targetDb: 90, marginState: 'red', overageDurationSec: 10,
    readings: [], nowSeconds: 10, serviceElapsedMin: 5,
    currentSongLabel: 'Way Maker', isWorshipSection: true
  });
  assert.equal(payload.currentSongLabel, 'Way Maker');
  assert.equal(payload.isWorshipSection, true);
});

/* ------------------------------ claudeLoudnessRead -------------------------- */

test('claudeLoudnessRead returns null without an API key (offline path — never blocks the raw alert)', async () => {
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    assert.equal(await claudeLoudnessRead({}), null);
  } finally {
    if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
  }
});
