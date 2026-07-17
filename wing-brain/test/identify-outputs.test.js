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

test('identifyOutputs --mock reports mute state but NO names (mock has no console names)', async () => {
  const { rows } = await identifyOutputs({ mock: true, timeoutMs: 200, matrixCount: 2 });
  const main1 = rows.find((r) => r.kind === 'main' && r.index === 1);
  assert.equal(main1.name, null, 'mock must never fabricate a name');
  assert.equal(main1.mute, 0);
  const mtx1 = rows.find((r) => r.kind === 'matrix' && r.index === 1);
  assert.equal(mtx1.name, null, 'mock must never fabricate a name');
  assert.equal(mtx1.mute, 0);
});

test('identifyOutputs --mock fabricates no name on ANY row', async () => {
  const { rows } = await identifyOutputs({ mock: true, timeoutMs: 200, matrixCount: 8 });
  for (const r of rows) assert.equal(r.name, null, `row ${r.kind} ${r.index} must have no fabricated name`);
});

test('identifyOutputs degrades unanswered addresses to null instead of hanging or throwing', async () => {
  const { rows } = await identifyOutputs({ mock: true, timeoutMs: 200, matrixCount: 8 });
  const unseeded = rows.find((r) => r.kind === 'matrix' && r.index === 8);
  assert.equal(unseeded.name, null);
  assert.equal(unseeded.mute, null);
});

test('formatTable renders a fixed-width table including unanswered rows', () => {
  // 'ZZ-TESTNAME' is an obviously-synthetic test token, not a realistic
  // fabricated console label — the formatter only cares that SOME name renders.
  const table = formatTable([
    { kind: 'main', index: 1, name: 'ZZ-TESTNAME', mute: 0 },
    { kind: 'main', index: 2, name: null, mute: null }
  ]);
  assert.match(table, /ZZ-TESTNAME/);
  assert.match(table, /\(no reply\)/);
  assert.match(table, /live/);
  assert.match(table, /\?/);
});

test('seedMockOutputs seeds mute states only — never a name', () => {
  const transport = makeOscTransport({ mode: 'mock' });
  seedMockOutputs(transport);
  assert.deepEqual(transport.store.get('/main/1/mute'), [0]);
  assert.deepEqual(transport.store.get('/main/4/mute'), [1]);
  // No name address may be seeded, on any strip.
  for (const addr of transport.store.keys()) {
    assert.ok(!addr.endsWith('/name'), `mock must not seed a name address (${addr})`);
  }
});
