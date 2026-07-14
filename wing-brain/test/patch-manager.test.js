// Tests for src/wing/patch-manager.js — the defensive snapshot/restore
// safety net around per-driver test-signal injection (routing model section
// 2). Uses MockOscTransport throughout (fast, no network) but toggles
// `config.mode` between 'mock'/'live' to exercise the live-only safety
// gates -- injectTestSignal only cares what cfg.mode says, not what kind of
// transport it's actually talking to.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeOscTransport } from '../src/wing/osc.js';
import { PatchManager } from '../src/wing/patch-manager.js';

function tmpDataDir(prefix = 'wing-patch-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function baseConfig(overrides = {}) {
  return {
    mode: 'mock',
    testSignal: { source: 'usb_sweep', injectionChannelGrp: 'A', injectionChannelNum: 39, confirmed: true },
    physicalOutputs: [],
    ...overrides
  };
}

function confirmedOutput(overrides = {}) {
  return {
    id: 'side_fills_out', label: 'Side Fills',
    wing: { grp: 'B', num: 1, confirmed: true },
    ...overrides
  };
}

/* ------------------------------ readCurrentSource -------------------------- */

test('readCurrentSource returns null when wing.grp/num are not configured', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  const pm = new PatchManager({ config: baseConfig(), transport, dataDir: tmpDataDir() });
  const result = await pm.readCurrentSource({ id: 'x', wing: { grp: null, num: null } });
  assert.equal(result, null);
});

test('readCurrentSource reads the /io/out/<grp>/<num>/conn/grp+in pair', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  transport.send('/io/out/B/1/conn/grp', ['A']);
  transport.send('/io/out/B/1/conn/in', [12]);
  const pm = new PatchManager({ config: baseConfig(), transport, dataDir: tmpDataDir() });
  const result = await pm.readCurrentSource(confirmedOutput());
  assert.deepEqual(result, { grp: 'A', in: 12 });
});

/* ------------------------------ injectTestSignal gates ---------------------- */

test('injectTestSignal throws if the physical output has no wing.grp/num configured, in any mode', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  const pm = new PatchManager({ config: baseConfig(), transport, dataDir: tmpDataDir() });
  await assert.rejects(
    () => pm.injectTestSignal({ id: 'x', wing: { grp: null, num: null, confirmed: true } }),
    /no wing\.grp\/num configured/
  );
});

test('injectTestSignal in LIVE mode refuses an unconfirmed physical output address', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  const cfg = baseConfig({ mode: 'live' });
  const pm = new PatchManager({ config: cfg, transport, dataDir: tmpDataDir() });
  await assert.rejects(
    () => pm.injectTestSignal(confirmedOutput({ wing: { grp: 'B', num: 1, confirmed: false } })),
    /wing\.confirmed is false/
  );
});

test('injectTestSignal in LIVE mode refuses an unconfirmed global test-signal source', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  const cfg = baseConfig({ mode: 'live', testSignal: { source: 'usb_sweep', injectionChannelGrp: 'A', injectionChannelNum: 39, confirmed: false } });
  const pm = new PatchManager({ config: cfg, transport, dataDir: tmpDataDir() });
  await assert.rejects(() => pm.injectTestSignal(confirmedOutput()), /testSignal\.confirmed is false/);
});

test('injectTestSignal in LIVE mode refuses to repatch when the original source cannot be read', async () => {
  const transport = makeOscTransport({ mode: 'mock' }); // nothing seeded -- get() returns null
  const cfg = baseConfig({ mode: 'live' });
  const pm = new PatchManager({ config: cfg, transport, dataDir: tmpDataDir() });
  await assert.rejects(() => pm.injectTestSignal(confirmedOutput()), /could not read its current patch source/);
});

test('MOCK mode skips the confirmed/original-source gates entirely', async () => {
  const transport = makeOscTransport({ mode: 'mock' }); // nothing seeded, output unconfirmed
  const cfg = baseConfig(); // mode: mock
  const pm = new PatchManager({ config: cfg, transport, dataDir: tmpDataDir() });
  const output = confirmedOutput({ wing: { grp: 'B', num: 1, confirmed: false } });
  await assert.doesNotReject(() => pm.injectTestSignal(output));
});

/* ------------------------------ snapshot + restore -------------------------- */

test('injectTestSignal snapshots the original source to disk BEFORE repatching, then sends the injection addresses', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  transport.send('/io/out/B/1/conn/grp', ['X']);
  transport.send('/io/out/B/1/conn/in', [7]);
  const dataDir = tmpDataDir();
  const pm = new PatchManager({ config: baseConfig(), transport, dataDir });

  await pm.injectTestSignal(confirmedOutput());

  const snapPath = path.join(dataDir, 'patch-snapshot.json');
  assert.ok(fs.existsSync(snapPath), 'snapshot file should exist');
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  assert.deepEqual(snap.side_fills_out.original, { grp: 'X', in: 7 });

  assert.deepEqual(await transport.get('/io/out/B/1/conn/grp'), ['A']);
  assert.deepEqual(await transport.get('/io/out/B/1/conn/in'), [39]);
});

test('restorePatch reverts a physical output to its snapshotted original and clears the entry', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  transport.send('/io/out/B/1/conn/grp', ['X']);
  transport.send('/io/out/B/1/conn/in', [7]);
  const dataDir = tmpDataDir();
  const pm = new PatchManager({ config: baseConfig(), transport, dataDir });
  const output = confirmedOutput();

  await pm.injectTestSignal(output);
  const restored = pm.restorePatch(output);

  assert.equal(restored, true);
  assert.deepEqual(await transport.get('/io/out/B/1/conn/grp'), ['X']);
  assert.deepEqual(await transport.get('/io/out/B/1/conn/in'), [7]);

  const snap = JSON.parse(fs.readFileSync(path.join(dataDir, 'patch-snapshot.json'), 'utf8'));
  assert.equal('side_fills_out' in snap, false, 'snapshot entry cleared after restore');
});

test('restorePatch is a safe no-op when nothing is pending for that output', () => {
  const transport = makeOscTransport({ mode: 'mock' });
  const pm = new PatchManager({ config: baseConfig(), transport, dataDir: tmpDataDir() });
  assert.equal(pm.restorePatch(confirmedOutput()), false);
});

test('hasPendingPatches reflects whether a snapshot is on disk', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  transport.send('/io/out/B/1/conn/grp', ['X']);
  transport.send('/io/out/B/1/conn/in', [7]);
  const pm = new PatchManager({ config: baseConfig(), transport, dataDir: tmpDataDir() });

  assert.equal(pm.hasPendingPatches(), false);
  await pm.injectTestSignal(confirmedOutput());
  assert.equal(pm.hasPendingPatches(), true);
  pm.restorePatch(confirmedOutput());
  assert.equal(pm.hasPendingPatches(), false);
});

test('restoreAll reverts every pending output and clears the whole snapshot in one call', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  transport.send('/io/out/B/1/conn/grp', ['X1']); transport.send('/io/out/B/1/conn/in', [1]);
  transport.send('/io/out/C/2/conn/grp', ['X2']); transport.send('/io/out/C/2/conn/in', [2]);
  const dataDir = tmpDataDir();
  const cfg = baseConfig({
    physicalOutputs: [
      confirmedOutput(),
      confirmedOutput({ id: 'center_fill_out', wing: { grp: 'C', num: 2, confirmed: true } })
    ]
  });
  const pm = new PatchManager({ config: cfg, transport, dataDir });

  await pm.injectTestSignal(cfg.physicalOutputs[0]);
  await pm.injectTestSignal(cfg.physicalOutputs[1]);
  assert.equal(pm.hasPendingPatches(), true);

  const restored = pm.restoreAll();
  assert.deepEqual(new Set(restored), new Set(['side_fills_out', 'center_fill_out']));
  assert.equal(pm.hasPendingPatches(), false);
  assert.deepEqual(await transport.get('/io/out/B/1/conn/grp'), ['X1']);
  assert.deepEqual(await transport.get('/io/out/C/2/conn/grp'), ['X2']);
});

test('restoreAll is a safe no-op when nothing is pending', () => {
  const pm = new PatchManager({ config: baseConfig(), transport: makeOscTransport({ mode: 'mock' }), dataDir: tmpDataDir() });
  assert.deepEqual(pm.restoreAll(), []);
});

test('a corrupt snapshot file is treated as empty rather than crashing', () => {
  const dataDir = tmpDataDir();
  fs.writeFileSync(path.join(dataDir, 'patch-snapshot.json'), '{not valid json');
  const pm = new PatchManager({ config: baseConfig(), transport: makeOscTransport({ mode: 'mock' }), dataDir });
  assert.equal(pm.hasPendingPatches(), false);
  assert.deepEqual(pm.restoreAll(), []);
});
