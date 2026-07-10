// Tests for src/config/settings.js — the Settings API's validation, merge,
// and atomic-persistence rules.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeDeep, writeJsonAtomic, validateConfig, validateRoomPatch, activeTargetCurve } from '../src/config/settings.js';

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

test('the shipped default config validates clean against the real room (referencePositionId cross-check included)', () => {
  assert.deepEqual(validateConfig(goodConfig(), room), []);
});

/* --------------------------- activeTargetCurve ---------------------------- */

test('activeTargetCurve resolves the curve named by selectedTargetCurve', () => {
  const cfg = goodConfig();
  assert.equal(activeTargetCurve(cfg).name, 'general');
  cfg.selectedTargetCurve = 'bethel';
  assert.equal(activeTargetCurve(cfg).name, 'bethel');
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
  cfg.targetCurves.general.points = [[100, 0], [50, 1], [200, 2]];
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

test('accepts multiple named target curves and validates each entry', () => {
  const cfg = goodConfig();
  cfg.targetCurves.flat = { name: 'flat', points: [[20, 0], [20000, 0]] };
  assert.deepEqual(validateConfig(cfg), []);
  cfg.targetCurves.broken = { name: 'broken', points: [[20, 0]] };
  assert.ok(validateConfig(cfg).some((e) => /targetCurves\.broken/.test(e)));
});

test('rejects selectedTargetCurve pointing at a curve that does not exist', () => {
  const cfg = goodConfig();
  cfg.selectedTargetCurve = 'nonexistent';
  assert.ok(validateConfig(cfg).some((e) => /selectedTargetCurve/.test(e)));
});

test('rejects a targetCurves entry whose name does not match its map key', () => {
  const cfg = goodConfig();
  cfg.targetCurves.general.name = 'mismatched';
  assert.ok(validateConfig(cfg).some((e) => /targetCurves\.general\.name/.test(e)));
});

test('rejects an empty targetCurves object', () => {
  const cfg = goodConfig();
  cfg.targetCurves = {};
  assert.ok(validateConfig(cfg).some((e) => /targetCurves/.test(e)));
});

/* ---------------------------- loudnessMonitor ---------------------------- */

test('rejects a loudnessMonitor.referencePositionId that is not free text but also not a real room position', () => {
  const cfg = goodConfig();
  cfg.loudnessMonitor.referencePositionId = 'not-a-real-position';
  assert.ok(validateConfig(cfg, room).some((e) => /referencePositionId/.test(e)));
});

test('accepts any non-empty referencePositionId when no room is supplied for cross-checking', () => {
  const cfg = goodConfig();
  cfg.loudnessMonitor.referencePositionId = 'not-a-real-position';
  assert.deepEqual(validateConfig(cfg), [], 'without room, only the type is checked, not room membership');
});

test('rejects loudnessMonitor.softMarginDb >= hardMarginDb', () => {
  const cfg = goodConfig();
  cfg.loudnessMonitor.softMarginDb = 6;
  cfg.loudnessMonitor.hardMarginDb = 5;
  assert.ok(validateConfig(cfg).some((e) => /softMarginDb must be less than hardMarginDb/.test(e)));
});

test('rejects a malformed loudnessMonitor.integrationWindow', () => {
  const cfg = goodConfig();
  cfg.loudnessMonitor.integrationWindow = '10 seconds';
  assert.ok(validateConfig(cfg).some((e) => /integrationWindow/.test(e)));
});

test('accepts loudnessMonitor.quietTargetDb = null (disabled) and rejects it when >= targetDb', () => {
  const cfg = goodConfig();
  cfg.loudnessMonitor.quietTargetDb = null;
  assert.deepEqual(validateConfig(cfg), []);
  cfg.loudnessMonitor.quietTargetDb = cfg.loudnessMonitor.targetDb;
  assert.ok(validateConfig(cfg).some((e) => /quietTargetDb: must be less than targetDb/.test(e)));
});

test('rejects loudnessMonitor.sustainedSeconds out of range', () => {
  const cfg = goodConfig();
  cfg.loudnessMonitor.sustainedSeconds = -1;
  assert.ok(validateConfig(cfg).some((e) => /sustainedSeconds/.test(e)));
});

test('requires loudnessMonitor to be present at all', () => {
  const cfg = goodConfig();
  delete cfg.loudnessMonitor;
  assert.ok(validateConfig(cfg).some((e) => /loudnessMonitor: must be an object/.test(e)));
});

test('accepts audio.splDbOffset = null (uncalibrated) and rejects an out-of-range offset', () => {
  const cfg = goodConfig();
  cfg.audio.splDbOffset = null;
  assert.deepEqual(validateConfig(cfg), []);
  cfg.audio.splDbOffset = 500;
  assert.ok(validateConfig(cfg).some((e) => /splDbOffset/.test(e)));
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
