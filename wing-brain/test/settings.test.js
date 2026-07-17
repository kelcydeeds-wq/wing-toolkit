// Tests for src/config/settings.js — the Settings API's validation, merge,
// and atomic-persistence rules.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mergeDeep, writeJsonAtomic, validateConfig, validateRoomPatch, activeTargetCurve,
  roomBounds, isWithinRoomBounds, validateSpeakersArray, validatePositionsArray
} from '../src/config/settings.js';

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

test('accepts system.crossoverHz within the sane 40-300 Hz range', () => {
  for (const good of [40, 80, 100, 300]) {
    const cfg = goodConfig();
    cfg.system.crossoverHz = good;
    assert.deepEqual(validateConfig(cfg), [], `crossoverHz=${good} should validate clean`);
  }
});

test('rejects system.crossoverHz outside the sane 40-300 Hz range', () => {
  for (const bad of [0, 39, 301, 1000, 'abc', null]) {
    const cfg = goodConfig();
    cfg.system.crossoverHz = bad;
    assert.ok(validateConfig(cfg).some((e) => /system\.crossoverHz/.test(e)), `crossoverHz=${bad} should fail`);
  }
});

test('rejects a missing system section', () => {
  const cfg = goodConfig();
  delete cfg.system;
  assert.ok(validateConfig(cfg).some((e) => /system\.crossoverHz/.test(e)));
});

test('rejects a band with lo >= hi', () => {
  const cfg = goodConfig();
  cfg.buses[0].band = [16000, 40];
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

test('rejects duplicate bus ids and bad routing', () => {
  const cfg = goodConfig();
  cfg.buses[1].id = cfg.buses[0].id;
  assert.ok(validateConfig(cfg).some((e) => /duplicate id/.test(e)));

  const cfg2 = goodConfig();
  cfg2.buses[0].wing.type = 'bus';
  assert.ok(validateConfig(cfg2).some((e) => /wing\.type/.test(e)));
});

test('rejects two buses claiming the same routing address (type+num), even across different types', () => {
  const cfg = goodConfig();
  // buses[0] is "mains" (main/1), buses[1] is "sub" (main/2) -- collide them.
  cfg.buses[1].wing.type = cfg.buses[0].wing.type;
  cfg.buses[1].wing.num = cfg.buses[0].wing.num;
  const errors = validateConfig(cfg);
  assert.ok(errors.some((e) => /wing:.*already used by bus "mains"/.test(e)), errors.join(' | '));

  // A bus keeping ITS OWN existing routing (re-saved unchanged) must not
  // trip this -- only a genuine second claimant should.
  const cfg2 = goodConfig();
  assert.deepEqual(validateConfig(cfg2), []);
});

test('rejects duplicate physical output ids and an unknown sourceBusId', () => {
  const cfg = goodConfig();
  cfg.physicalOutputs[1].id = cfg.physicalOutputs[0].id;
  assert.ok(validateConfig(cfg).some((e) => /duplicate id/.test(e)));

  const cfg2 = goodConfig();
  cfg2.physicalOutputs[0].sourceBusId = 'not_a_real_bus';
  assert.ok(validateConfig(cfg2).some((e) => /sourceBusId/.test(e)));
});

test('rejects a positive sweep trim (trims attenuate, never boost)', () => {
  const cfg = goodConfig();
  cfg.buses[0].sweepTrimDb = 3;
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
  cfg.buses[0].band = [500, 100];
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

test('accepts audio.sweep.targetSplDb within 40-120 dB SPL and rejects outside it', () => {
  const cfg = goodConfig();
  cfg.audio.sweep.targetSplDb = 90;
  assert.deepEqual(validateConfig(cfg), []);
  cfg.audio.sweep.targetSplDb = 30;
  assert.ok(validateConfig(cfg).some((e) => /targetSplDb/.test(e)));
  cfg.audio.sweep.targetSplDb = 130;
  assert.ok(validateConfig(cfg).some((e) => /targetSplDb/.test(e)));
});

test('rejects audio.sweep.maxLevelDbfs outside -60..-6, or below levelDbfs (it is a ceiling, not a floor)', () => {
  const cfg = goodConfig();
  cfg.audio.sweep.maxLevelDbfs = -4;
  assert.ok(validateConfig(cfg).some((e) => /maxLevelDbfs/.test(e)));
  cfg.audio.sweep.maxLevelDbfs = -65;
  assert.ok(validateConfig(cfg).some((e) => /maxLevelDbfs/.test(e)));
  cfg.audio.sweep.levelDbfs = -18;
  cfg.audio.sweep.maxLevelDbfs = -30; // below levelDbfs
  assert.ok(validateConfig(cfg).some((e) => /maxLevelDbfs/.test(e)));
  cfg.audio.sweep.maxLevelDbfs = -6;
  assert.deepEqual(validateConfig(cfg), []);
});

test('rejects audio.sweep.minSnrMarginDb / ambientCheckSeconds outside their sane ranges', () => {
  const cfg = goodConfig();
  cfg.audio.sweep.minSnrMarginDb = -5;
  assert.ok(validateConfig(cfg).some((e) => /minSnrMarginDb/.test(e)));
  cfg.audio.sweep.minSnrMarginDb = 20;
  cfg.audio.sweep.ambientCheckSeconds = 0;
  assert.ok(validateConfig(cfg).some((e) => /ambientCheckSeconds/.test(e)));
  cfg.audio.sweep.ambientCheckSeconds = 1;
  assert.deepEqual(validateConfig(cfg), []);
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

/* ------------------------------- roomBounds ------------------------------- */

test('roomBounds computes the bounding box of room.walls', () => {
  const b = roomBounds(room);
  assert.ok(b);
  assert.equal(b.minX, 0);
  assert.equal(b.maxX, 18.5);
  assert.equal(b.minY, -7);
  assert.equal(b.maxY, 14);
});

test('roomBounds returns null when walls are missing or empty', () => {
  assert.equal(roomBounds({}), null);
  assert.equal(roomBounds({ walls: [] }), null);
  assert.equal(roomBounds(null), null);
});

test('isWithinRoomBounds accepts points inside the wall bbox and rejects points outside', () => {
  assert.equal(isWithinRoomBounds(9.25, 3, room), true);
  assert.equal(isWithinRoomBounds(-5, 3, room), false);
  assert.equal(isWithinRoomBounds(9.25, 100, room), false);
});

test('isWithinRoomBounds skips the check (returns true) when walls are unknown', () => {
  assert.equal(isWithinRoomBounds(99999, -99999, {}), true);
});

/* --------------------------- validateSpeakersArray ------------------------ */

test('validateSpeakersArray accepts the shipped room.speakers', () => {
  assert.deepEqual(validateSpeakersArray(room.speakers, room), []);
});

test('validateSpeakersArray rejects duplicate ids', () => {
  const speakers = [room.speakers[0], { ...room.speakers[1], id: room.speakers[0].id }];
  assert.ok(validateSpeakersArray(speakers, room).some((e) => /duplicate id/.test(e)));
});

test('validateSpeakersArray rejects x/y outside room bounds, accepts when walls unknown', () => {
  const speakers = [{ id: 's1', x: -500, y: 3, z: 5 }];
  assert.ok(validateSpeakersArray(speakers, room).some((e) => /outside the room's wall bounds/.test(e)));
  assert.deepEqual(validateSpeakersArray(speakers, {}), [], 'no walls known — bounds check skipped');
});

test('validateSpeakersArray rejects a negative or absurd z', () => {
  assert.ok(validateSpeakersArray([{ id: 's1', x: 1, y: 1, z: -1 }], room).some((e) => /\.z:/.test(e)));
  assert.ok(validateSpeakersArray([{ id: 's1', x: 1, y: 1, z: 999 }], room).some((e) => /\.z:/.test(e)));
});

test('validateSpeakersArray requires an array', () => {
  assert.ok(validateSpeakersArray(null, room).some((e) => /must be an array/.test(e)));
});

/* -------------------------- validatePositionsArray ------------------------ */

test('validatePositionsArray accepts the shipped room.positions', () => {
  assert.deepEqual(validatePositionsArray(room.positions, room), []);
});

test('validatePositionsArray rejects an unknown zone', () => {
  const positions = [{ ...room.positions[0], zone: 'nowhere' }];
  assert.ok(validatePositionsArray(positions, room).some((e) => /zone/.test(e)));
});

test('validatePositionsArray rejects a negative weight', () => {
  const positions = [{ ...room.positions[0], weight: -1 }];
  assert.ok(validatePositionsArray(positions, room).some((e) => /weight/.test(e)));
});

test('validatePositionsArray rejects an empty label', () => {
  const positions = [{ ...room.positions[0], label: '' }];
  assert.ok(validatePositionsArray(positions, room).some((e) => /label/.test(e)));
});

/* --------------------- validateRoomPatch: widened behavior ---------------- */

test('validateRoomPatch accepts a valid speakers-array patch', () => {
  assert.deepEqual(validateRoomPatch({ speakers: room.speakers }, room), []);
});

test('validateRoomPatch accepts a valid positions-array patch', () => {
  assert.deepEqual(validateRoomPatch({ positions: room.positions }, room), []);
});

test('validateRoomPatch surfaces errors from a bad speakers-array patch', () => {
  const errors = validateRoomPatch({ speakers: [{ id: 's1', x: 1, y: 1, z: -1 }] }, room);
  assert.ok(errors.some((e) => /\.z:/.test(e)));
});

test('validateRoomPatch still rejects unknown top-level keys alongside the new ones', () => {
  const errors = validateRoomPatch({ width: 25 }, room);
  assert.ok(errors.some((e) => /only verifyPosition, speakers, positions are editable/.test(e)));
});
