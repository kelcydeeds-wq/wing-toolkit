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
// soloOutput()/unmuteAll() operate on BUSES and act on exactly the list
// they're given -- enabled-filtering is session.js's job (activeBuses()),
// not client.js's, so these tests pass an already-filtered bus list.

const buses = [
  { id: 'mains', wing: { type: 'main', num: 1 } },
  { id: 'sub', wing: { type: 'main', num: 2 } },
  { id: 'center_fill', wing: { type: 'mtx', num: 2 } }
];

test('LiveWing.soloOutput mutes every other bus and unmutes the soloed one (main + mtx paths)', async () => {
  const srv = fakeConsole();
  await srv.ready;
  const wing = makeWing({ mode: 'live', wing: { host: '127.0.0.1', port: srv.boundPort() } });
  try {
    await wing.ready;
    await wing.soloOutput('mains', buses);
    await wait(100);

    const byAddress = Object.fromEntries(srv.received.map((m) => [m.address, m.args[0]]));
    assert.equal(byAddress['/main/1/mute'], 0, 'soloed bus unmuted');
    assert.equal(byAddress['/main/2/mute'], 1, 'other main muted');
    assert.equal(byAddress['/mtx/2/mute'], 1, 'matrix bus muted via /mtx path');
  } finally {
    wing.close(); srv.close();
  }
});

test('LiveWing.unmuteAll unmutes every bus passed to it', async () => {
  const srv = fakeConsole();
  await srv.ready;
  const wing = makeWing({ mode: 'live', wing: { host: '127.0.0.1', port: srv.boundPort() } });
  try {
    await wing.ready;
    await wing.unmuteAll(buses);
    await wait(100);

    const addresses = srv.received.map((m) => m.address);
    assert.ok(addresses.includes('/main/1/mute'));
    assert.ok(addresses.includes('/main/2/mute'));
    assert.ok(addresses.includes('/mtx/2/mute'));
    assert.ok(srv.received.every((m) => m.args[0] === 0));
  } finally {
    wing.close(); srv.close();
  }
});

// When testSignal.auxChannel is configured, isolation MUST happen via the
// injected signal's own per-bus source switch, never by muting bus masters --
// see client.js sourceSwitchAddress() for why (a linked main/sub pair means
// muting one silently mutes the other on the real console).
test('LiveWing.soloOutput uses source-side switching (never mutes) when testSignal.auxChannel is set', async () => {
  const srv = fakeConsole();
  await srv.ready;
  const wing = makeWing({ mode: 'live', wing: { host: '127.0.0.1', port: srv.boundPort() }, testSignal: { auxChannel: 1 } });
  try {
    await wing.ready;
    await wing.soloOutput('sub', buses); // buses = mains(main/1), sub(main/2), center_fill(mtx/2)
    await wait(100);

    const byAddress = Object.fromEntries(srv.received.map((m) => [m.address, m.args[0]]));
    assert.equal(byAddress['/aux/1/main/1/on'], 0, 'mains source switched off');
    assert.equal(byAddress['/aux/1/main/2/on'], 1, 'sub source switched on');
    assert.equal(byAddress['/aux/1/send/MX2/on'], 0, 'center_fill (matrix) source switched off');
    assert.ok(!('/main/1/mute' in byAddress), 'mains bus mute never touched -- this is the whole point');
    assert.ok(!('/main/2/mute' in byAddress), 'sub bus mute never touched -- avoids the mainlink trap');
    assert.ok(!('/mtx/2/mute' in byAddress), 'matrix bus mute never touched');
  } finally {
    wing.close(); srv.close();
  }
});

test('LiveWing.unmuteAll turns off every source switch and unmutes every bus when auxChannel is set', async () => {
  const srv = fakeConsole();
  await srv.ready;
  const wing = makeWing({ mode: 'live', wing: { host: '127.0.0.1', port: srv.boundPort() }, testSignal: { auxChannel: 1 } });
  try {
    await wing.ready;
    await wing.unmuteAll(buses);
    await wait(100);

    const byAddress = Object.fromEntries(srv.received.map((m) => [m.address, m.args[0]]));
    assert.equal(byAddress['/aux/1/main/1/on'], 0);
    assert.equal(byAddress['/aux/1/main/2/on'], 0);
    assert.equal(byAddress['/aux/1/send/MX2/on'], 0);
    assert.equal(byAddress['/main/1/mute'], 0, 'still defensively unmutes bus masters');
    assert.equal(byAddress['/main/2/mute'], 0);
    assert.equal(byAddress['/mtx/2/mute'], 0);
  } finally {
    wing.close(); srv.close();
  }
});

// soloOutputs() (piece 3: crossover summation check) solos a SET of buses at
// once -- every bus in `busIds` stays live, every other bus is isolated.
// soloOutput() is now a one-line delegation to soloOutputs([busId]), so these
// tests exercise the same underlying mechanism the tests above already cover
// for the single-bus case.

test('LiveWing.soloOutputs mutes only the buses outside the given set (main + mtx paths)', async () => {
  const srv = fakeConsole();
  await srv.ready;
  const wing = makeWing({ mode: 'live', wing: { host: '127.0.0.1', port: srv.boundPort() } });
  try {
    await wing.ready;
    await wing.soloOutputs(['mains', 'sub'], buses);
    await wait(100);

    const byAddress = Object.fromEntries(srv.received.map((m) => [m.address, m.args[0]]));
    assert.equal(byAddress['/main/1/mute'], 0, 'mains (in the set) unmuted');
    assert.equal(byAddress['/main/2/mute'], 0, 'sub (in the set) unmuted');
    assert.equal(byAddress['/mtx/2/mute'], 1, 'center_fill (not in the set) muted');
  } finally {
    wing.close(); srv.close();
  }
});

test('LiveWing.soloOutputs uses source-side switching for every bus in the set when testSignal.auxChannel is set', async () => {
  const srv = fakeConsole();
  await srv.ready;
  const wing = makeWing({ mode: 'live', wing: { host: '127.0.0.1', port: srv.boundPort() }, testSignal: { auxChannel: 1 } });
  try {
    await wing.ready;
    await wing.soloOutputs(['mains', 'sub'], buses);
    await wait(100);

    const byAddress = Object.fromEntries(srv.received.map((m) => [m.address, m.args[0]]));
    assert.equal(byAddress['/aux/1/main/1/on'], 1, 'mains source switched on');
    assert.equal(byAddress['/aux/1/main/2/on'], 1, 'sub source switched on');
    assert.equal(byAddress['/aux/1/send/MX2/on'], 0, 'center_fill source switched off');
    assert.ok(!('/main/1/mute' in byAddress), 'mains bus mute never touched');
    assert.ok(!('/main/2/mute' in byAddress), 'sub bus mute never touched');
  } finally {
    wing.close(); srv.close();
  }
});

test('MockWing.soloOutputs tracks the full solo set, collapsing state.solo to a single id only when the set has exactly one member', async () => {
  const wing = makeWing({ mode: 'mock' });

  await wing.soloOutputs(['mains', 'sub'], buses);
  assert.deepEqual(wing.state.soloSet, ['mains', 'sub']);
  assert.equal(wing.state.solo, null, 'multi-bus set has no single solo id');

  await wing.soloOutputs(['sub'], buses);
  assert.deepEqual(wing.state.soloSet, ['sub']);
  assert.equal(wing.state.solo, 'sub', 'single-bus set still populates state.solo, matching soloOutput()');

  await wing.unmuteAll(buses);
  assert.equal(wing.state.solo, null);
  assert.equal(wing.state.soloSet, null);
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
    assert.ok(close(byAddress['/main/1/dly/dly'], 12.5), 'delay value written to /dly/dly (ms)');
    assert.equal(byAddress['/main/1/dly/mode'], 'MS', 'delay units forced to milliseconds');
    assert.equal(byAddress['/main/1/dly/on'], 1, 'delay enabled');
    assert.ok(close(byAddress['/main/1/eq/1f'], 100));
    assert.ok(close(byAddress['/main/1/eq/1g'], -3));
    assert.ok(close(byAddress['/main/1/eq/1q'], 1.4));
    assert.ok(close(byAddress['/main/1/eq/2f'], 6000));
    assert.ok(close(byAddress['/main/1/eq/2g'], -2));
    assert.ok(close(byAddress['/main/1/eq/2q'], 0.7));
    assert.equal(byAddress['/main/1/eq/on'], 1);
  } finally {
    wing.close(); srv.close();
  }
});

test('LiveWing.applyTuning skips (and warns about) filters beyond the 6-band main/mtx EQ topology', async () => {
  const srv = fakeConsole();
  await srv.ready;
  const wing = makeWing({ mode: 'live', wing: { host: '127.0.0.1', port: srv.boundPort() } });
  try {
    await wing.ready;
    const output = { id: 'main_l', wing: { type: 'main', num: 1 } };
    const filters = Array.from({ length: 7 }, (_, i) => ({ type: 'peq', freq: 100 + i, gainDb: -1, q: 1 }));
    await wing.applyTuning(output, filters, 0);
    await wait(100);

    const addresses = srv.received.map((m) => m.address);
    assert.ok(addresses.includes('/main/1/eq/6f'), 'band 6 (the last valid band) should be written');
    assert.ok(!addresses.includes('/main/1/eq/7f'), 'band 7 has no address on this bus and must be skipped');
  } finally {
    wing.close(); srv.close();
  }
});

test('MockWing tracks solo state and applied tuning in memory, matching the mock contract', async () => {
  const wing = makeWing({ mode: 'mock' });
  await wing.soloOutput('mains', buses);
  assert.equal(wing.state.solo, 'mains');

  await wing.unmuteAll(buses);
  assert.equal(wing.state.solo, null);

  const filters = [{ type: 'peq', freq: 100, gainDb: -2, q: 1.2 }];
  await wing.applyTuning({ id: 'mains' }, filters, 5);
  assert.equal(wing.state.applied.length, 1);
  assert.equal(wing.state.applied[0].bus, 'mains');
  assert.equal(wing.state.applied[0].addDelayMs, 5);
  assert.deepEqual(wing.state.applied[0].filters, filters);
});
