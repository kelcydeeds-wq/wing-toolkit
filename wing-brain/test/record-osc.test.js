// Tests for scripts/record-osc.mjs and src/wing/osc.js's replayRecording().
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeOscTransport, replayRecording } from '../src/wing/osc.js';
import { parseArgs, loadRecording, recordFromTransport } from '../scripts/record-osc.mjs';

/* -------------------------------- CLI ------------------------------------ */

test('parseArgs reads recording and replay flags', () => {
  const rec = parseArgs(['--host', '10.0.0.5', '--port', '2223', '--out', 'foo.jsonl']);
  assert.equal(rec.host, '10.0.0.5');
  assert.equal(rec.port, 2223);
  assert.equal(rec.out, 'foo.jsonl');
  assert.equal(rec.mock, false);

  const replay = parseArgs(['--replay', 'foo.jsonl', '--mock', '--speed', '4']);
  assert.equal(replay.replay, 'foo.jsonl');
  assert.equal(replay.mock, true);
  assert.equal(replay.speed, 4);
});

test('parseArgs defaults speed to 1x', () => {
  assert.equal(parseArgs([]).speed, 1);
});

/* ------------------------------ recording --------------------------------- */

test('recordFromTransport writes one JSONL line per message and stops on abort', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-record-'));
  const outPath = path.join(tmp, 'rec.jsonl');
  const controller = new AbortController();

  const recordPromise = recordFromTransport(transport, outPath, { signal: controller.signal, log: () => {} });
  transport.send('/ch/1/mute', [1]);
  transport.send('/ch/2/fader', [-6]);
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  const { count, outPath: returnedPath } = await recordPromise;

  assert.equal(count, 2);
  assert.equal(returnedPath, outPath);
  const records = loadRecording(outPath);
  assert.equal(records.length, 2);
  assert.equal(records[0].address, '/ch/1/mute');
  assert.deepEqual(records[0].args, [1]);
  assert.equal(records[1].address, '/ch/2/fader');
  assert.deepEqual(records[1].args, [-6]);
  assert.equal(typeof records[0].t, 'number');
});

test('recordFromTransport captures nothing when the signal is already aborted', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-record-'));
  const outPath = path.join(tmp, 'rec.jsonl');
  const controller = new AbortController();
  controller.abort();

  const { count } = await recordFromTransport(transport, outPath, { signal: controller.signal, log: () => {} });
  assert.equal(count, 0);
});

/* ------------------------------- loadRecording ---------------------------- */

test('loadRecording round-trips what was written, skipping blank lines', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-record-'));
  const file = path.join(tmp, 'rec.jsonl');
  fs.writeFileSync(file,
    JSON.stringify({ t: 0, address: '/a', args: [1] }) + '\n\n' +
    JSON.stringify({ t: 10, address: '/b', args: ['x'] }) + '\n'
  );
  const records = loadRecording(file);
  assert.equal(records.length, 2);
  assert.equal(records[0].address, '/a');
  assert.equal(records[1].address, '/b');
});

/* ------------------------------ replayRecording ---------------------------- */

test('replayRecording resends every record in order at high speed', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  const seen = [];
  transport.subscribe(/.*/, (values, address) => seen.push({ address, values }));

  const records = [
    { t: 0, address: '/ch/1/mute', args: [1] },
    { t: 50, address: '/ch/2/fader', args: [-6] },
    { t: 120, address: '/ch/3/config/name', args: ['Test'] }
  ];
  const start = Date.now();
  await replayRecording(transport, records, { speedMultiplier: 500 });
  const elapsed = Date.now() - start;

  assert.deepEqual(seen.map((s) => s.address), ['/ch/1/mute', '/ch/2/fader', '/ch/3/config/name']);
  assert.deepEqual(seen[1].values, [-6]);
  assert.deepEqual(seen[2].values, ['Test']);
  assert.ok(elapsed < 1000, `high speed multiplier should replay fast, took ${elapsed}ms`);
});

test('replayRecording calls onEvent with record, index, and total', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  const records = [{ t: 0, address: '/a', args: [1] }, { t: 0, address: '/b', args: [2] }];
  const seen = [];
  await replayRecording(transport, records, {
    speedMultiplier: 1000,
    onEvent: (rec, i, total) => seen.push([rec.address, i, total])
  });
  assert.deepEqual(seen, [['/a', 0, 2], ['/b', 1, 2]]);
});

test('replayRecording against an empty list resolves immediately without error', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  await replayRecording(transport, []);
});

/* ---------------------------- record -> replay e2e -------------------------- */

test('a recorded session can be loaded and replayed against a fresh mock transport', async () => {
  const recorder = makeOscTransport({ mode: 'mock' });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-record-e2e-'));
  const outPath = path.join(tmp, 'session.jsonl');
  const controller = new AbortController();

  const recordPromise = recordFromTransport(recorder, outPath, { signal: controller.signal, log: () => {} });
  recorder.send('/ch/1/config/name', ['Pastor Mic']);
  recorder.send('/ch/1/fader', [-3]);
  await new Promise((r) => setTimeout(r, 10));
  controller.abort();
  await recordPromise;

  const player = makeOscTransport({ mode: 'mock' });
  const received = [];
  player.subscribe(/.*/, (values, address) => received.push({ address, values }));
  await replayRecording(player, loadRecording(outPath), { speedMultiplier: 1000 });

  assert.deepEqual(received, [
    { address: '/ch/1/config/name', values: ['Pastor Mic'] },
    { address: '/ch/1/fader', values: [-3] }
  ]);
  assert.deepEqual(await player.get('/ch/1/config/name'), ['Pastor Mic']);
});
