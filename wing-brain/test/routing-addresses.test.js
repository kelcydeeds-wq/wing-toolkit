// Regression guard for the routing revamp: the Wing-native picker (Workstream
// 2) changed only the INPUT widget, not the stored {type, num} routing, so the
// OSC addresses produced downstream MUST be byte-identical to the pre-revamp
// behavior. These tests pin that mapping: a bus stored as {type:'mtx', num:6}
// must still drive /mtx/6/... and never leak to /main/..., and vice versa.
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import { makeWing } from '../src/wing/client.js';
import { makeOscTransport } from '../src/wing/osc.js';

/** A real LiveWing wired to a recording mock OSC transport (no UDP socket, no
 *  aux injector configured -> isolation uses bus mute addresses). */
function liveWingWithMockTransport() {
  const transport = makeOscTransport({ mode: 'mock' });
  const config = { mode: 'live', wing: { host: '127.0.0.1', port: 2223 } };
  const wing = makeWing(config, { transport, dataDir: os.tmpdir() });
  return { wing, transport };
}

test('applyTuning drives /mtx/<n>/... for an mtx-routed bus and never leaks to /main', async () => {
  const { wing, transport } = liveWingWithMockTransport();
  await wing.applyTuning({ id: 'fill', wing: { type: 'mtx', num: 6 } }, [{ freq: 1000, gainDb: -3, q: 1.4 }], 5.2);
  const addrs = transport.log.map((m) => m.address);
  for (const a of ['/mtx/6/dly/mode', '/mtx/6/dly/dly', '/mtx/6/dly/on', '/mtx/6/eq/1f', '/mtx/6/eq/1g', '/mtx/6/eq/1q', '/mtx/6/eq/on']) {
    assert.ok(addrs.includes(a), `expected ${a} in ${addrs.join(', ')}`);
  }
  assert.ok(!addrs.some((a) => a.startsWith('/main/')), 'must not touch any /main address');
});

test('applyTuning drives /main/<n>/... for a main-routed bus and never leaks to /mtx', async () => {
  const { wing, transport } = liveWingWithMockTransport();
  await wing.applyTuning({ id: 'mains', wing: { type: 'main', num: 1 } }, [{ freq: 100, gainDb: 2, q: 1 }], 0);
  const addrs = transport.log.map((m) => m.address);
  assert.ok(addrs.includes('/main/1/eq/1f'));
  assert.ok(addrs.includes('/main/1/dly/dly'));
  assert.ok(!addrs.some((a) => a.startsWith('/mtx/')), 'must not touch any /mtx address');
});

test('soloOutputs isolates via each bus mute address (mtx unmuted, main muted)', async () => {
  const { wing, transport } = liveWingWithMockTransport();
  const buses = [
    { id: 'mains', wing: { type: 'main', num: 1 } },
    { id: 'fill', wing: { type: 'mtx', num: 6 } }
  ];
  await wing.soloOutputs(['fill'], buses);
  const byAddr = Object.fromEntries(transport.log.map((m) => [m.address, m.args]));
  assert.deepEqual(byAddr['/mtx/6/mute'], [0], 'soloed bus unmuted');
  assert.deepEqual(byAddr['/main/1/mute'], [1], 'other bus muted');
});

test('continuous params (delay value, EQ freq/gain/Q) arrive at the exact addresses; mode is "MS"', async () => {
  const { wing, transport } = liveWingWithMockTransport();
  await wing.applyTuning({ id: 'fill', wing: { type: 'mtx', num: 2 } }, [{ freq: 800, gainDb: -1.5, q: 2 }], 3);
  const byAddr = Object.fromEntries(transport.log.map((m) => [m.address, m.args]));
  assert.deepEqual(byAddr['/mtx/2/dly/mode'], ['MS']);
  assert.deepEqual(byAddr['/mtx/2/dly/dly'], [3]);
  assert.deepEqual(byAddr['/mtx/2/eq/1f'], [800]);
  assert.deepEqual(byAddr['/mtx/2/eq/1g'], [-1.5]);
  assert.deepEqual(byAddr['/mtx/2/eq/1q'], [2]);
});
