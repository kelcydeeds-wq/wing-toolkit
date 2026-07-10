// Tests for src/config/settings.js — the Settings API's validation, merge,
// and atomic-persistence rules.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeDeep, writeJsonAtomic, validateConfig, validateRoomPatch } from '../src/config/settings.js';

const goodConfig = () => JSON.parse(fs.readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
const room = JSON.parse(fs.readFileSync(new URL('../config/room.json', import.meta.url), 'utf8'));

/* ------------------------------- mergeDeep ------------------------------- */

test('mergeDeep merges nested objects without dropping sibling keys', () => {
  const base = { wing: { host: '1.2.3.4', port: 2223 }, mode: 'mock' };
  const merged = mergeDeep(base, { wing: { host: '5.6.7.8' } });
  assert.equal(merged.wing.host, '5.6.7.8');
  assert.equal(merged.wing.port, 2223, 'untouched sibling survives');
  assert.equal(merged.mode, 'mock');
  assert.equal(base.wing.host, '1.2.3.4', 'base is not mutated');
});

test('mergeDeep replaces arrays wholesale (no index splicing)', () => {
  const base = { outputs: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const merged = mergeDeep(base, { outputs: [{ id: 'x' }] });
  assert.deepEqual(merged.outputs, [{ id: 'x' }]);
});

test('mergeDeep replaces scalars and handles null/undefined bases', () => {
  assert.equal(mergeDeep({ a: 1 }, { a: 2 }).a, 2);
  assert.deepEqual(mergeDeep(undefined, { a: 1 }), { a: 1 });
  assert.deepEqual(mergeDeep(null, { a: 1 }), { a: 1 });
  assert.equal(mergeDeep({ a: { b: 1 } }, { a: 'flat' }).a, 'flat', 'scalar patch replaces object');
});

/* ---------------------------- writeJsonAtomic ---------------------------- */

test('writeJsonAtomic writes valid JSON and leaves no temp file behind', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-settings-'));
  const file = path.join(dir, 'cfg.json');
  writeJsonAtomic(file, { hello: 'world' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hello: 'world' });
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'no temp files left after rename');
});

test('writeJsonAtomic overwrites an existing file in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-settings-'));
  const file = path.join(dir, 'cfg.json');
  writeJsonAtomic(file, { v: 1 });
  writeJsonAtomic(file, { v: 2 });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, 2);
});

/* ------------------------------ validateConfig --------------------------- */

test('the shipped default config validates clean', () => {
  assert.deepEqual(validateConfig(goodConfig()), []);
});

test('rejects out-of-range ports', () => {
  for (const bad of [0, -1, 70000, 1.5, 'abc']) {
    const cfg = goodConfig();
    cfg.wing.port = bad;
    assert.ok(validateConfig(cfg).some((e) => /wing\.port/.test(e)), `port ${bad} should fail`);
  }
});

test('rejects an unknown mode', () => {
  const cfg = goodConfig();
  cfg.mode = 'production';
  assert.ok(validateConfig(cfg).some((e) => /mode/.test(e)));
});

test('rejects a band with lo >= hi', () => {
  const cfg = goodConfig();
  cfg.outputs[0].band = [16000, 40];
  assert.ok(validateConfig(cfg).some((e) => /band/.test(e)));
});

test('rejects sweep level hotter than -6 dBFS', () => {
  const cfg = goodConfig();
  cfg.audio.sweep.levelDbfs = -3;
  assert.ok(validateConfig(cfg).some((e) => /levelDbfs/.test(e)));
  cfg.audio.sweep.levelDbfs = 0;
  assert.ok(validateConfig(cfg).some((e) => /levelDbfs/.test(e)));
});

test('rejects guardrails outside sane caps', () => {
  const cases = [
    ['maxCutDb', 40], ['maxBoostDb', 20], ['maxFiltersPerOutput', 99],
    ['maxFiltersPerOutput', 2.5], ['minQ', -1], ['noBoostBelowHz', 5000],
    ['fillPrecedenceMs', 100]
  ];
  for (const [key, value] of cases) {
    const cfg = goodConfig();
    cfg.guardrails[key] = value;
    assert.ok(validateConfig(cfg).some((e) => e.includes(`guardrails.${key}`)), `${key}=${value} should fail`);
  }
});

test('rejects minQ >= maxQ even when both are individually in range', () => {
  const cfg = goodConfig();
  cfg.guardrails.minQ = 4;
  cfg.guardrails.maxQ = 3;
  assert.ok(validateConfig(cfg).some((e) => /minQ must be less than maxQ/.test(e)));
});

test('rejects duplicate output ids and bad routing', () => {
  const cfg = goodConfig();
  cfg.outputs[1].id = cfg.outputs[0].id;
  assert.ok(validateConfig(cfg).some((e) => /duplicate id/.test(e)));

  const cfg2 = goodConfig();
  cfg2.outputs[0].wing.type = 'bus';
  assert.ok(validateConfig(cfg2).some((e) => /wing\.type/.test(e)));
});

test('rejects a positive sweep trim (trims attenuate, never boost)', () => {
  const cfg = goodConfig();
  cfg.outputs[0].sweepTrimDb = 3;
  assert.ok(validateConfig(cfg).some((e) => /sweepTrimDb/.test(e)));
});

test('rejects a target curve with non-ascending frequencies', () => {
  const cfg = goodConfig();
  cfg.targetCurve.points = [[100, 0], [50, 1], [200, 2]];
  assert.ok(validateConfig(cfg).some((e) => /ascending/.test(e)));
});

test('reports multiple errors at once with path-specific messages', () => {
  const cfg = goodConfig();
  cfg.wing.port = 0;
  cfg.audio.sweep.levelDbfs = 0;
  cfg.outputs[0].band = [500, 100];
  const errors = validateConfig(cfg);
  assert.ok(errors.length >= 3, `expected at least 3 errors, got: ${errors.join(' | ')}`);
});

test('accepts an optional targetCurves list and validates each entry', () => {
  const cfg = goodConfig();
  cfg.targetCurves = [cfg.targetCurve, { name: 'flat', points: [[20, 0], [20000, 0]] }];
  assert.deepEqual(validateConfig(cfg), []);
  cfg.targetCurves.push({ name: '', points: [[20, 0]] });
  assert.ok(validateConfig(cfg).some((e) => /targetCurves\[2\]/.test(e)));
});

/* ---------------------------- validateRoomPatch -------------------------- */

test('room patch accepts a known verify position', () => {
  assert.deepEqual(validateRoomPatch({ verifyPosition: room.positions[0].id }, room), []);
});

test('room patch rejects an unknown position id', () => {
  const errors = validateRoomPatch({ verifyPosition: 'nope' }, room);
  assert.ok(errors.some((e) => /not a known position/.test(e)));
});

test('room patch rejects geometry edits — only verifyPosition is API-editable', () => {
  const errors = validateRoomPatch({ verifyPosition: room.positions[0].id, width: 25 }, room);
  assert.ok(errors.some((e) => /only verifyPosition/.test(e)));
});
