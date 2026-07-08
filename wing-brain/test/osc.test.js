// Tests for the extracted OSC transport (src/wing/osc.js) and the tune-shaped
// wing client built on top of it (src/wing/client.js). Task 5 goal: extracting
// the transport must not change what actually goes out over the wire — these
// tests bind a real UDP listener standing in for a Wing console and assert
// on the exact bytes the client sends, so a behavior change would fail here.
//
// Every UDP-backed test wraps its body in try/finally so a failed assertion
// still closes both sockets — an open dgram socket keeps the whole
// `node --test` process alive indefinitely (see package.json's
// --test-force-exit for the belt-and-suspenders backstop).
import { test } from 'node:test';
import assert from 'node:assert';
import osc from 'osc';
import { makeOscTransport } from '../src/wing/osc.js';
import { makeWing } from '../src/wing/client.js';

/** A minimal fake console: a UDP listener that records every message it
 *  receives and can be told to auto-reply (echo) to query messages. */
function fakeConsole({ autoReply = false } = {}) {
  const received = [];
  const port = new osc.UDPPort({ localAddress: '127.0.0.1', localPort: 0 });
  const ready = new Promise((res) => port.on('ready', res));
  port.on('message', (msg, timeTag, info) => {
    // osc.js decodes with metadata:false by default, so msg.args are already
    // plain values (numbers/strings), not {type,value}-wrapped.
    received.push({ address: msg.address, args: msg.args || [] });
    if (autoReply) {
      port.send({ address: msg.address, args: [{ type: 'i', value: 42 }] }, info.address, info.port);
    }
  });
  port.open();
  return { received, ready, port, close: () => port.close(), boundPort: () => port.socket.address().port };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------- OSC transport --------------------------- */

test('LiveOscTransport.send puts the exact address and args on the wire', async () => {
  const srv = fakeConsole();
  await srv.ready;
  const transport = makeOscTransport({ mode: 'live', wing: { host: '127.0.0.1', port: srv.boundPort() } });
  try {
    await transport.ready;
    transport.send('/main/1/mute', [1]);
    transport.send('/main/1/eq/1/f', [1000.5]);
    await wait(100);

    assert.deepEqual(srv.received[0], { address: '/main/1/mute', args: [1] });
    assert.deepEqual(srv.received[1], { address: '/main/1/eq/1/f', args: [1000.5] });
  } finally {
    transport.close(); srv.close();
  }
});

test('LiveOscTransport.get() resolves with the console reply', async () => {
  const srv = fakeConsole({ autoReply: true });
  await srv.ready;
  const transport = makeOscTransport({ mode: 'live', wing: { host: '127.0.0.1', port: srv.boundPort() } });
  try {
    await transport.ready;
    const values = await transport.get('/main/1/fader');
    assert.deepEqual(values, [42]);
  } finally {
    transport.close(); srv.close();
  }
});

test('LiveOscTransport.get() times out to null instead of hanging when nothing replies', async () => {
  const srv = fakeConsole(); // no auto-reply
  await srv.ready;
  const transport = makeOscTransport({ mode: 'live', wing: { host: '127.0.0.1', port: srv.boundPort() } });
  try {
    await transport.ready;
    const start = Date.now();
    const values = await transport.get('/unknown/address', { timeoutMs: 150 });
    assert.equal(values, null);
    assert.ok(Date.now() - start < 1000, 'should resolve promptly on timeout, not hang');
  } finally {
    transport.close(); srv.close();
  }
});

test('LiveOscTransport.subscribe fires only for matching addresses and unsubscribe stops delivery', async () => {
  const srv = fakeConsole();
  await srv.ready;
  const transport = makeOscTransport({ mode: 'live', wing: { host: '127.0.0.1', port: srv.boundPort() } });
  try {
    await transport.ready;
    // Echo everything back so the client-under-test receives inbound traffic.
    srv.port.on('message', (msg, tt, info) => {
      srv.port.send({ address: msg.address, args: msg.args }, info.address, info.port);
    });

    const seen = [];
    const unsub = transport.subscribe('/main/1/mute', (values, address) => seen.push({ values, address }));
    transport.send('/main/1/mute', [1]);
    transport.send('/main/2/mute', [1]); // should not match
    await wait(100);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].address, '/main/1/mute');

    unsub();
    transport.send('/main/1/mute', [0]);
    await wait(100);
    assert.equal(seen.length, 1, 'no further deliveries after unsubscribe');
  } finally {
    transport.close(); srv.close();
  }
});

test('MockOscTransport: get() returns what was last sent, null if never sent', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  await transport.ready;
  assert.equal(await transport.get('/main/1/mute'), null);
  transport.send('/main/1/mute', [1]);
  assert.deepEqual(await transport.get('/main/1/mute'), [1]);
});

test('MockOscTransport: subscribe/unsubscribe and the traffic log', async () => {
  const transport = makeOscTransport({ mode: 'mock' });
  const seen = [];
  const unsub = transport.subscribe('/main/1/mute', (values) => seen.push(values));
  transport.send('/main/1/mute', [1]);
  transport.send('/main/2/mute', [1]);
  assert.deepEqual(seen, [[1]]);
  unsub();
  transport.send('/main/1/mute', [0]);
  assert.deepEqual(seen, [[1]], 'no delivery after unsubscribe');
  assert.equal(transport.log.length, 3, 'every send() is logged regardless of subscribers');
});

/* --------------------------- wing/client.js --------------------------- */

const outputs = [
  { id: 'main_l', enabled: true, wing: { type: 'main', num: 1 } },
  { id: 'main_r', enabled: true, wing: { type: 'main', num: 2 } },
  { id: 'fill_c', enabled: true, wing: { type: 'mtx', num: 2 } },
  { id: 'disabled_out', enabled: false, wing: { type: 'main', num: 9 } }
];

test('LiveWing.soloOutput mutes every other enabled output and unmutes the soloed one (main + mtx paths)', async () => {
  const srv = fakeConsole();
  await srv.ready;
  const wing = makeWing({ mode: 'live', wing: { host: '127.0.0.1', port: srv.boundPort() } });
  try {
    await wing.ready;
    await wing.soloOutput('main_l', outputs);
    await wait(100);

    const byAddress = Object.fromEntries(srv.received.map((m) => [m.address, m.args[0]]));
    assert.equal(byAddress['/main/1/mute'], 0, 'soloed output unmuted');
    assert.equal(byAddress['/main/2/mute'], 1, 'other main muted');
    assert.equal(byAddress['/mtx/2/mute'], 1, 'matrix output muted via /mtx path');
    assert.equal('/main/9/mute' in byAddress, false, 'disabled output is skipped entirely');
  } finally {
    wing.close(); srv.close();
  }
});

test('LiveWing.unmuteAll unmutes every enabled output', async () => {
  const srv = fakeConsole();
  await srv.ready;
  const wing = makeWing({ mode: 'live', wing: { host: '127.0.0.1', port: srv.boundPort() } });
  try {
    await wing.ready;
    await wing.unmuteAll(outputs);
    await wait(100);

    const addresses = srv.received.map((m) => m.address);
    assert.ok(addresses.includes('/main/1/mute'));
    assert.ok(addresses.includes('/main/2/mute'));
    assert.ok(addresses.includes('/mtx/2/mute'));
    assert.ok(!addresses.includes('/main/9/mute'));
    assert.ok(srv.received.every((m) => m.args[0] === 0));
  } finally {
    wing.close(); srv.close();
  }
});

test('LiveWing.applyTuning writes delay and one filter block per EQ band', async () => {
  const srv = fakeConsole();
  await srv.ready;
  const wing = makeWing({ mode: 'live', wing: { host: '127.0.0.1', port: srv.boundPort() } });
  try {
    await wing.ready;
    const output = { id: 'main_l', wing: { type: 'main', num: 1 } };
    const filters = [
      { type: 'peq', freq: 100, gainDb: -3, q: 1.4 },
      { type: 'hshelf', freq: 6000, gainDb: -2, q: 0.7 }
    ];
    await wing.applyTuning(output, filters, 12.5);
    await wait(100);

    const byAddress = Object.fromEntries(srv.received.map((m) => [m.address, m.args[0]]));
    // OSC 'f' args are 32-bit floats — a value like 1.4 round-trips with
    // float32 rounding error, so compare with tolerance, not exact equality.
    const close = (a, b) => Math.abs(a - b) < 1e-4;
    assert.ok(close(byAddress['/main/1/delay'], 12.5));
    assert.equal(byAddress['/main/1/eq/1/type'], 'peq');
    assert.ok(close(byAddress['/main/1/eq/1/f'], 100));
    assert.ok(close(byAddress['/main/1/eq/1/g'], -3));
    assert.ok(close(byAddress['/main/1/eq/1/q'], 1.4));
    assert.equal(byAddress['/main/1/eq/1/on'], 1);
    assert.equal(byAddress['/main/1/eq/2/type'], 'shv', 'hshelf maps to the shv filter type');
    assert.equal(byAddress['/main/1/eq/2/f'], 6000);
  } finally {
    wing.close(); srv.close();
  }
});

test('MockWing tracks solo state and applied tuning in memory, matching the pre-refactor mock contract', async () => {
  const wing = makeWing({ mode: 'mock' });
  await wing.soloOutput('main_l', outputs);
  assert.equal(wing.state.solo, 'main_l');

  await wing.unmuteAll(outputs);
  assert.equal(wing.state.solo, null);

  const filters = [{ type: 'peq', freq: 100, gainDb: -2, q: 1.2 }];
  await wing.applyTuning({ id: 'main_l' }, filters, 5);
  assert.equal(wing.state.applied.length, 1);
  assert.equal(wing.state.applied[0].output, 'main_l');
  assert.equal(wing.state.applied[0].addDelayMs, 5);
  assert.deepEqual(wing.state.applied[0].filters, filters);
});
