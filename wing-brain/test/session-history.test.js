// Tests for the review-screen upgrades in src/tune/session.js:
// per-position trace overlay data, and the last-5-sessions history store.
//
// Every session in this file is pointed at a throwaway temp dataDir, never
// the app's real data/ directory — these tests must not pollute a real
// operator's session history on disk.
import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TuneSession, listSessionHistory } from '../src/tune/session.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
const room = JSON.parse(fs.readFileSync(new URL('../config/room.json', import.meta.url), 'utf8'));

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-brain-test-history-'));
after(() => fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true }));

function fakeAudio() { return { playAndCapture: async () => ({ ref: new Float64Array(10), mic: new Float64Array(10) }) }; }
function fakeWing() { return { soloOutput: async () => {}, unmuteAll: async () => {}, applyTuning: async () => {} }; }

function populatedSession(dataDir = TMP_DATA_DIR) {
  const session = new TuneSession({ config, room, audio: fakeAudio(), wing: fakeWing(), emit: () => {}, dataDir });
  session.mode = 'full';
  session.positions = room.positions.filter((p) => p.weight > 0);
  const freqs = Array.from({ length: 32 }, (_, i) => 20 * Math.pow(1000, i / 31));
  for (const bus of config.buses) {
    for (const pos of session.positions) {
      session.results.push({
        positionId: pos.id, positionWeight: pos.weight, zone: pos.zone,
        outputId: bus.id, delayMs: 20, confidence: 12, polarity: 1,
        levelDbfs: -20, snrDb: 25, clipped: false,
        freqs, magDb: freqs.map(() => 0)
      });
    }
  }
  return session;
}

/* ------------------- per-position overlay ------------------- */

test('buildRecommendations attaches a labeled per-position curve for each output', () => {
  const session = populatedSession();
  const rec = session.buildRecommendations();
  for (const output of config.buses) {
    const o = rec.perOutput[output.id];
    assert.ok(o, `missing perOutput entry for ${output.id}`);
    assert.equal(o.positions.length, session.positions.length);
    for (const p of o.positions) {
      const expected = session.positions.find((x) => x.id === p.positionId);
      assert.equal(p.label, expected.label, 'overlay entry should carry the human-readable position label');
      assert.equal(p.magDb.length, o.freqs.length, 'overlay curve must share the output grid');
    }
  }
});

/* ---------------------- session history ---------------------- */

test('saveSessionRecord persists a downloadable record and lists it in history', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP_DATA_DIR, 'save-'));
  const session = populatedSession(dataDir);
  session.recommendations = session.buildRecommendations();
  const id = session.saveSessionRecord();

  assert.ok(fs.existsSync(path.join(dataDir, 'sessions', `${id}.json`)));
  const history = listSessionHistory(dataDir);
  const entry = history.find((h) => h.id === id);
  assert.ok(entry, 'saved session should appear in history');
  assert.equal(entry.mode, 'full');
  assert.equal(entry.applied, false);
});

test('overwriteSessionRecord updates the same file in place (Apply does not create a new history entry)', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP_DATA_DIR, 'overwrite-'));
  const session = populatedSession(dataDir);
  session.recommendations = session.buildRecommendations();
  const id = session.saveSessionRecord();
  const countBefore = listSessionHistory(dataDir).length;

  session.recommendations.applied = true;
  session.overwriteSessionRecord();

  const history = listSessionHistory(dataDir);
  assert.equal(history.length, countBefore, 'apply should not add a second history entry');
  const entry = history.find((h) => h.id === id);
  assert.equal(entry.applied, true);
});

test('history is pruned to the 5 most recent sessions, oldest dropped first', async () => {
  const dataDir = fs.mkdtempSync(path.join(TMP_DATA_DIR, 'prune-'));
  const ids = [];
  for (let i = 0; i < 7; i++) {
    const session = populatedSession(dataDir);
    session.recommendations = session.buildRecommendations();
    ids.push(session.saveSessionRecord());
    await new Promise((r) => setTimeout(r, 5)); // ensure distinct millisecond timestamps
  }
  const history = listSessionHistory(dataDir);
  assert.equal(history.length, 5, 'only the 5 most recent sessions should be kept');
  const keptIds = new Set(history.map((h) => h.id));
  assert.ok(!keptIds.has(ids[0]) && !keptIds.has(ids[1]), 'the two oldest sessions should have been pruned');
  assert.ok(keptIds.has(ids[6]), 'the most recent session should be kept');
});

test('listSessionHistory returns an empty array for a directory with nothing saved', () => {
  const dataDir = fs.mkdtempSync(path.join(TMP_DATA_DIR, 'empty-'));
  assert.deepEqual(listSessionHistory(dataDir), []);
});
