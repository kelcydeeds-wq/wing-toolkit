// Tests for scripts/dump-wing-state.mjs and scripts/wing-schema.mjs.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  channelStrip, busStrip, mainStrip, matrixStrip, leafAddresses, ioInputFields, readValue,
  CHANNEL_COUNT, MAIN_COUNT
} from '../scripts/wing-schema.mjs';
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
  assert.deepEqual(ch1.values['/ch/1/name'], ['Pastor Mic']);

  const ch3 = dump.channels.find((c) => c.index === 3);
  assert.equal(ch3.values['/ch/3/name'], null, 'unseeded address should be null, not throw or hang');
});

test('dumpWingState resolves channel gain via the two-step io/in/<grp>/<in> lookup', async () => {
  const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wing-dump-')), 'dump.json');
  const { dump } = await dumpWingState({ mock: true, timeoutMs: 200, concurrency: 16, out: outPath });

  const ch1 = dump.channels.find((c) => c.index === 1);
  assert.deepEqual(ch1.values['/ch/1/in/conn/grp'], ['A'], 'seeded patch group should be captured');
  assert.ok(Number.isInteger(ch1.values['/ch/1/in/conn/in']?.[0]), 'seeded patch input slot should be captured');
  const slot = ch1.values['/ch/1/in/conn/in'][0];
  assert.deepEqual(ch1.values[`/io/in/A/${slot}/g`], [31], 'gain should be resolved from the patched io slot, not a channel address');
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
  assert.deepEqual(ch30.values['/ch/30/tags'], ['#D1'], 'DCA membership (tags string) should be captured');
  assert.deepEqual(ch30.values['/ch/30/send/1/on'], [1], 'bus send on/off should be captured');
  assert.deepEqual(ch30.values['/ch/30/send/1/lvl'], [-8], 'bus send level should be captured');

  const bus1 = dump.buses.find((b) => b.index === 1);
  assert.deepEqual(bus1.values['/bus/1/name'], ['Vox Reverb']);
});

/* -------------------- corrected address-builder regression -------------------- */
// Locks the Wing OSC address map to the official spec (church visit
// 2026-07-10) so a future edit can't silently drift back to the guessed
// addresses that caused the sub to go unmeasured in mock mode.

test('channelStrip builds the corrected flat-leaf address set', () => {
  const s = channelStrip(1);
  assert.equal(s.name, '/ch/1/name');
  assert.equal(s.col, '/ch/1/col');
  assert.equal(s.sourceGrp, '/ch/1/in/conn/grp');
  assert.equal(s.sourceIn, '/ch/1/in/conn/in');
  assert.equal(s.fader, '/ch/1/fdr');
  assert.equal(s.mute, '/ch/1/mute');
  assert.equal(s.hpfOn, '/ch/1/flt/lc');
  assert.equal(s.hpfFreq, '/ch/1/flt/lcf');
  assert.equal(s.dynAttack, '/ch/1/dyn/att');
  assert.equal(s.dynRelease, '/ch/1/dyn/rel');

  const band1 = s.eq.find((b) => b.band === 1);
  assert.equal(band1.freq, '/ch/1/eq/1f');
  assert.equal(band1.gain, '/ch/1/eq/1g');
  assert.equal(band1.q, '/ch/1/eq/1q');
  const low = s.eq.find((b) => b.band === 'l');
  assert.equal(low.freq, '/ch/1/eq/lf');
  assert.equal(low.gain, '/ch/1/eq/lg');
  assert.equal(low.q, '/ch/1/eq/lq');
  assert.equal(low.type, '/ch/1/eq/leq');
  const high = s.eq.find((b) => b.band === 'h');
  assert.equal(high.freq, '/ch/1/eq/hf');
  assert.equal(high.gain, '/ch/1/eq/hg');
  assert.equal(high.q, '/ch/1/eq/hq');
  assert.equal(high.type, '/ch/1/eq/heq');
  assert.equal(s.eq.length, 6, 'channel EQ = 4 numbered bands + low/high shelf');

  const send1 = s.sends.find((x) => x.bus === 1);
  assert.equal(send1.on, '/ch/1/send/1/on');
  assert.equal(send1.level, '/ch/1/send/1/lvl');

  const main1 = s.mainSends.find((x) => x.main === 1);
  assert.equal(main1.on, '/ch/1/main/1/on');
  assert.equal(main1.level, '/ch/1/main/1/lvl');
});

test('busStrip/mainStrip/matrixStrip use 6 flat numbered EQ bands, no shelf letters', () => {
  for (const strip of [busStrip(1), mainStrip(1), matrixStrip(1)]) {
    assert.equal(strip.eq.length, 6);
    assert.ok(strip.eq.every((b) => typeof b.band === 'number'), 'no l/h shelf bands on bus/main/mtx');
    const band1 = strip.eq.find((b) => b.band === 1);
    assert.equal(band1.freq, `${strip.path}/eq/1f`);
    assert.equal(band1.gain, `${strip.path}/eq/1g`);
    assert.equal(band1.q, `${strip.path}/eq/1q`);
  }
});

test('mainStrip is numbered 1-4, never "lr"', () => {
  const m1 = mainStrip(1);
  assert.equal(m1.path, '/main/1');
  assert.equal(m1.fader, '/main/1/fdr');
  assert.equal(m1.mute, '/main/1/mute');
  assert.equal(MAIN_COUNT, 4);
});

test('ioInputFields builds the gain/phantom-invert address from a patched grp/in pair', () => {
  const io = ioInputFields('A', 3);
  assert.equal(io.gain, '/io/in/A/3/g');
  assert.equal(io.phantomInvert, '/io/in/A/3/vph');
});

test('readValue prefers the raw last element of a 3-tuple reply, passes through single-element arrays and non-arrays', () => {
  assert.equal(readValue(['1', 1, 1]), 1, 'prefers raw numeric over display string');
  assert.equal(readValue(['-58.5', 0.26875, -58.5]), -58.5);
  assert.equal(readValue(['6:1']), '6:1', 'single-element array (mock/write) passes through');
  assert.equal(readValue(null), null);
  assert.equal(readValue(undefined), undefined);
  assert.equal(readValue(42), 42);
});
