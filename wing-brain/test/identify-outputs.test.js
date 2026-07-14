// Tests for scripts/identify-outputs.mjs — read-only main/mtx name+mute
// confirmation, used to fill in config/default.json's outputs[].wing.num
// "TODO: confirm at audit" markers without running the full state dump.
import { test } from 'node:test';
import assert from 'node:assert';
import { parseArgs, identifyOutputs, formatTable, seedMockOutputs } from '../scripts/identify-outputs.mjs';
import { makeOscTransport } from '../src/wing/osc.js';

test('parseArgs reads --mock, --host, --port, --timeout, --matrix-count', () => {
  const args = parseArgs(['--mock', '--host', '10.0.0.5', '--port', '2223', '--timeout', '500', '--matrix-count', '4']);
  assert.equal(args.mock, true);
  assert.equal(args.host, '10.0.0.5');
  assert.equal(args.port, 2223);
  assert.equal(args.timeoutMs, 500);
  assert.equal(args.matrixCount, 4);
});

test('parseArgs defaults mock to false', () => {
  assert.equal(parseArgs([]).mock, false);
});

test('identifyOutputs --mock reports every seeded main/mtx name and mute state', async () => {
  const { rows } = await identifyOutputs({ mock: true, timeoutMs: 200, matrixCount: 2 });
  const main1 = rows.find((r) => r.kind === 'main' && r.index === 1);
  assert.equal(main1.name, 'Main L');
  assert.equal(main1.mute, 0);
  const mtx1 = rows.find((r) => r.kind === 'matrix' && r.index === 1);
  assert.equal(mtx1.name, 'Side Fills');
});

test('identifyOutputs degrades unanswered addresses to null instead of hanging or throwing', async () => {
  const { rows } = await identifyOutputs({ mock: true, timeoutMs: 200, matrixCount: 8 });
  const unseeded = rows.find((r) => r.kind === 'matrix' && r.index === 8);
  assert.equal(unseeded.name, null);
  assert.equal(unseeded.mute, null);
});

test('formatTable renders a fixed-width table including unanswered rows', () => {
  const table = formatTable([
    { kind: 'main', index: 1, name: 'Main L', mute: 0 },
    { kind: 'main', index: 2, name: null, mute: null }
  ]);
  assert.match(table, /Main L/);
  assert.match(table, /\(no reply\)/);
  assert.match(table, /live/);
  assert.match(table, /\?/);
});

test('seedMockOutputs seeds a plausible main+fill layout for a fresh mock transport', () => {
  const transport = makeOscTransport({ mode: 'mock' });
  seedMockOutputs(transport);
  assert.deepEqual(transport.store.get('/main/1/name'), ['Main L']);
  assert.deepEqual(transport.store.get('/main/3/name'), ['Sub']);
});
