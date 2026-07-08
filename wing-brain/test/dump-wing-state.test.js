// Tests for scripts/dump-wing-state.mjs and scripts/wing-schema.mjs.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { channelStrip, busStrip, leafAddresses, CHANNEL_COUNT } from '../scripts/wing-schema.mjs';
import { dumpWingState, parseArgs } from '../scripts/dump-wing-state.mjs';

/* ------------------------------ schema ------------------------------ */

test('leafAddresses flattens a strip to a unique list of string OSC addresses', () => {
  const strip = channelStrip(1);
  const addrs = leafAddresses(strip);
  assert.ok(addrs.length > 20, 'a channel strip should have many fields');
  assert.ok(addrs.every((a) => typeof a === 'string' && a.startsWith('/ch/1/')));
  assert.equal(new Set(addrs).size, addrs.length, 'no duplicate addresses');
});

test('channel and bus strips do not collide on address paths', () => {
  const chAddrs = new Set(leafAddresses(channelStrip(1)));
  const busAddrs = new Set(leafAddresses(busStrip(1)));
  for (const a of busAddrs) assert.ok(!chAddrs.has(a), `bus address ${a} collides with a channel address`);
});

/* --------------------------- CLI parsing ----------------------------- */

test('parseArgs reads --mock, --host, --port, --out, --timeout, --concurrency', () => {
  const args = parseArgs(['--mock', '--host', '10.0.0.5', '--port', '2223', '--out', 'foo.json', '--timeout', '500', '--concurrency', '4']);
  assert.equal(args.mock, true);
  assert.equal(args.host, '10.0.0.5');
  assert.equal(args.port, 2223);
  assert.equal(args.out, 'foo.json');
  assert.equal(args.timeoutMs, 500);
  assert.equal(args.concurrency, 4);
});

test('parseArgs defaults mock to false and applies sane timeout/concurrency defaults', () => {
  const args = parseArgs([]);
  assert.equal(args.mock, false);
  assert.ok(args.timeoutMs > 0);
  assert.ok(args.concurrency > 0);
});

/* --------------------------- mock dump ------------------------------- */

test('dumpWingState --mock produces a complete, well-formed dump with realistic seeded data', async () => {
  const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wing-dump-')), 'dump.json');
  const { dump } = await dumpWingState({ mock: true, timeoutMs: 200, concurrency: 16, out: outPath });

  assert.ok(fs.existsSync(outPath), 'dump should be written to the requested path');
  const onDisk = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  assert.deepEqual(onDisk, dump, 'file contents should match the returned dump');

  assert.equal(dump.channels.length, CHANNEL_COUNT);
  assert.equal(dump.meta.mock, true);

  const ch1 = dump.channels.find((c) => c.index === 1);
  assert.deepEqual(ch1.values['/ch/1/config/name'], ['Pastor Mic']);

  const ch3 = dump.channels.find((c) => c.index === 3);
  assert.equal(ch3.values['/ch/3/config/name'], null, 'unseeded address should be null, not throw or hang');
});

test('dumpWingState degrades gracefully — every value is either an array or null, never undefined/throws', async () => {
  const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wing-dump-')), 'dump.json');
  const { dump } = await dumpWingState({ mock: true, timeoutMs: 200, concurrency: 16, out: outPath });

  for (const section of [dump.channels, dump.buses, dump.mains, dump.matrices, dump.dcas, dump.userKeys]) {
    for (const strip of section) {
      for (const [address, value] of Object.entries(strip.values)) {
        assert.ok(value === null || Array.isArray(value), `${address} resolved to an unexpected shape: ${JSON.stringify(value)}`);
      }
    }
  }
});

test('dumpWingState captures DCA and mute-group assignments and bus sends for the seeded channel', async () => {
  const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wing-dump-')), 'dump.json');
  const { dump } = await dumpWingState({ mock: true, timeoutMs: 200, concurrency: 16, out: outPath });

  const ch30 = dump.channels.find((c) => c.index === 30);
  assert.deepEqual(ch30.values['/ch/30/grp/dca/1'], [1], 'DCA assignment should be captured');
  assert.deepEqual(ch30.values['/ch/30/mix/1/on'], [1], 'bus send on/off should be captured');
  assert.deepEqual(ch30.values['/ch/30/mix/1/level'], [-8], 'bus send level should be captured');

  const bus1 = dump.buses.find((b) => b.index === 1);
  assert.deepEqual(bus1.values['/bus/1/config/name'], ['Vox Reverb']);
});
