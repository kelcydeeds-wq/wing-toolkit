// Tests for scripts/apply-remap.mjs.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeOscTransport } from '../src/wing/osc.js';
import { parseArgs, copyChannel, applyRemap } from '../scripts/apply-remap.mjs';

function seedSourceChannel(transport, index) {
  transport.send(`/ch/${index}/name`, ['Kick In']);
  transport.send(`/ch/${index}/fdr`, [-4]);
  transport.send(`/ch/${index}/mute`, [0]);
  transport.send(`/ch/${index}/tags`, ['#D2,#M3']); // member of DCA 2 + mute group 3
  transport.send(`/ch/${index}/send/5/on`, [1]);
  transport.send(`/ch/${index}/send/5/lvl`, [-6]);
}

const baseMove = { from: 8, to: 4, name: 'Kick In', category: 'Drums', changed: true,
  references: { dca: [2], muteGroups: [3], sends: [{ bus: 5, level: -6 }], userKeys: [] } };

/* -------------------------------- CLI ----------------------------------- */

test('parseArgs defaults to dry-run and reads all flags', () => {
  const defaults = parseArgs(['--remap', 'plan.json']);
  assert.equal(defaults.execute, false, 'dry-run must be the default');
  assert.equal(defaults.remap, 'plan.json');

  const full = parseArgs(['--remap', 'plan.json', '--execute', '--mock', '--clear-source', '--timeout', '500']);
  assert.equal(full.execute, true);
  assert.equal(full.mock, true);
  assert.equal(full.clearSource, true);
  assert.equal(full.timeoutMs, 500);
});

/* ----------------------------- copyChannel ------------------------------ */

test('dry-run reads the source channel but writes nothing', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  seedSourceChannel(transport, 8);
  const logs = [];

  const result = await copyChannel(transport, baseMove, { execute: false, timeoutMs: 200, log: (m) => logs.push(m) });

  assert.equal(result.status, 'dry-run');
  assert.equal(await transport.get('/ch/4/name'), null, 'destination must be untouched in dry-run');
  assert.ok(logs.some((l) => /would write/.test(l)));
  assert.ok(logs.some((l) => /would assign DCA 2/.test(l)));
});

test('execute copies settings to the destination, renames, and applies references', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  seedSourceChannel(transport, 8);

  const result = await copyChannel(transport, baseMove, { execute: true, timeoutMs: 200, log: () => {} });

  assert.equal(result.status, 'applied');
  assert.deepEqual(await transport.get('/ch/4/name'), ['Kick In']);
  assert.deepEqual(await transport.get('/ch/4/fdr'), [-4]);
  assert.deepEqual(await transport.get('/ch/4/tags'), ['#D2,#M3'], 'DCA + mute-group membership copied via the tags string');
  assert.deepEqual(await transport.get('/ch/4/send/5/on'), [1]);
  assert.deepEqual(await transport.get('/ch/4/send/5/lvl'), [-6]);
});

test('execute leaves the source channel untouched unless --clear-source is set', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  seedSourceChannel(transport, 8);

  await copyChannel(transport, baseMove, { execute: true, timeoutMs: 200, log: () => {} });
  assert.deepEqual(await transport.get('/ch/8/name'), ['Kick In'], 'source name unchanged by default');

  const transport2 = makeOscTransport({ mode: 'mock' });
  seedSourceChannel(transport2, 8);
  await copyChannel(transport2, baseMove, { execute: true, timeoutMs: 200, clearSource: true, log: () => {} });
  assert.deepEqual(await transport2.get('/ch/8/name'), [''], '--clear-source blanks the source name');
  assert.deepEqual(await transport2.get('/ch/8/mute'), [1], '--clear-source mutes the source');
});

test('renames even when the source channel never answered its name address', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  // No seed at all -- every source read is null.
  const result = await copyChannel(transport, baseMove, { execute: true, timeoutMs: 100, log: () => {} });
  assert.equal(result.status, 'applied');
  assert.deepEqual(await transport.get('/ch/4/name'), ['Kick In'], 'name is forced from the plan even with no source data');
});

test('a verify mismatch is reported as verify-failed with the offending address', async () => {
  // A transport whose get() lies about one specific address after it's written,
  // simulating a console that silently rejected that particular write.
  const real = makeOscTransport({ mode: 'mock' });
  seedSourceChannel(real, 8);
  const flaky = {
    ready: real.ready,
    send: (address, args) => real.send(address, args),
    get: async (address, opts) => {
      if (address === '/ch/4/fdr') return [-999]; // never matches what was written
      return real.get(address, opts);
    }
  };

  const result = await copyChannel(flaky, baseMove, { execute: true, timeoutMs: 200, log: () => {} });
  assert.equal(result.status, 'verify-failed');
  assert.ok(result.mismatches.some((m) => m.address === '/ch/4/fdr'));
});

/* ------------------------------ applyRemap ------------------------------- */

function writeRemapPlan(tmp, moves) {
  const p = path.join(tmp, 'remap.json');
  fs.writeFileSync(p, JSON.stringify({ moves, warnings: [], generatedAt: new Date(0).toISOString() }));
  return p;
}

test('applyRemap is a no-op when the plan has no changed moves', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-apply-'));
  const remapPath = writeRemapPlan(tmp, [{ from: 1, to: 1, name: 'Pastor Mic', category: 'x', changed: false }]);
  const { results, aborted } = await applyRemap({ remap: remapPath, execute: true, timeoutMs: 200 });
  assert.deepEqual(results, []);
  assert.equal(aborted, false);
});

test('applyRemap applies every changed move in order against an injected transport', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  seedSourceChannel(transport, 8);
  transport.send('/ch/35/name', ['Choir Mic 1']);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-apply-'));
  const remapPath = writeRemapPlan(tmp, [
    { from: 35, to: 3, name: 'Choir Mic 1', category: 'Pastor + vocals', changed: true, references: { dca: [], muteGroups: [], sends: [], userKeys: [] } },
    baseMove
  ]);

  const { results, aborted } = await applyRemap({ remap: remapPath, execute: true, timeoutMs: 200 }, { transportOverride: transport });
  assert.equal(aborted, false);
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.status === 'applied'));
  assert.deepEqual(await transport.get('/ch/3/name'), ['Choir Mic 1']);
  assert.deepEqual(await transport.get('/ch/4/name'), ['Kick In']);
});

test('applyRemap stops at the first verify failure and does not attempt the remaining moves', async () => {
  const real = makeOscTransport({ mode: 'mock' });
  seedSourceChannel(real, 8);
  real.send('/ch/35/name', ['Choir Mic 1']);
  let writesToCh4 = 0;
  const flaky = {
    ready: real.ready,
    send: (address, args) => { if (address.startsWith('/ch/4/')) writesToCh4++; real.send(address, args); },
    get: async (address, opts) => (address === '/ch/4/fdr' ? [-999] : real.get(address, opts))
  };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-apply-'));
  const remapPath = writeRemapPlan(tmp, [
    baseMove, // this one fails verification (writes to ch4)
    { from: 35, to: 3, name: 'Choir Mic 1', category: 'Pastor + vocals', changed: true, references: { dca: [], muteGroups: [], sends: [], userKeys: [] } }
  ]);

  const { results, aborted } = await applyRemap({ remap: remapPath, execute: true, timeoutMs: 200 }, { transportOverride: flaky });
  assert.equal(aborted, true);
  assert.equal(results.length, 1, 'should not proceed to the second move after the first fails');
  assert.equal(results[0].status, 'verify-failed');
  assert.equal(await real.get('/ch/3/name'), null, 'the second (untried) move must not have been applied');
});

test('applyRemap dry-run never writes even when the plan has moves', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  seedSourceChannel(transport, 8);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-apply-'));
  const remapPath = writeRemapPlan(tmp, [baseMove]);

  const { results, aborted } = await applyRemap({ remap: remapPath, execute: false, timeoutMs: 200 }, { transportOverride: transport });
  assert.equal(aborted, false);
  assert.equal(results[0].status, 'dry-run');
  assert.equal(await transport.get('/ch/4/name'), null);
});
