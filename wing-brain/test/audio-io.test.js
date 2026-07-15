// Tests for src/audio/io.js's pure helper functions: ASIO device matching,
// stereo interleaving for playback, and channel de-interleaving for capture.
// LiveAudioIO itself (the naudiodon-backed duplex stream) is NOT exercised
// here -- naudiodon is a native addon that must be built from source with
// the Steinberg ASIO SDK and can only be verified against real ASIO
// hardware, neither of which is available in this environment. It's
// imported lazily (dynamic import inside LiveAudioIO._open(), never at
// module load time) specifically so this file -- and the whole test suite
// -- never needs it installed. MockAudioIO is unchanged and already
// covered by every dsp/session test that runs in mock mode.
import { test } from 'node:test';
import assert from 'node:assert';
import { findAsioDevice, interleaveStereo, extractChannels } from '../src/audio/io.js';

/* ------------------------------ findAsioDevice ------------------------------ */

const SAMPLE_DEVICES = [
  { id: 0, name: 'Microphone (Realtek Audio)', hostAPIName: 'MME' },
  { id: 1, name: 'IN 1-2 (BEHRINGER WING-USB)', hostAPIName: 'MME' },
  { id: 2, name: 'ASIO WING-USB', hostAPIName: 'ASIO' },
  { id: 3, name: 'ASIO4ALL v2', hostAPIName: 'ASIO' }
];

test('findAsioDevice matches by case-insensitive substring within ASIO-hosted devices only', () => {
  const found = findAsioDevice(SAMPLE_DEVICES, 'wing-usb');
  assert.equal(found.id, 2, 'should match the ASIO device, not the same-named MME one');
});

test('findAsioDevice ignores non-ASIO devices even with an exact name match', () => {
  // "IN 1-2 (BEHRINGER WING-USB)" exists under MME but there's no ASIO
  // device with that exact name -- must not fall back to the MME entry.
  assert.throws(() => findAsioDevice(SAMPLE_DEVICES, 'IN 1-2 (BEHRINGER WING-USB)'), /No ASIO device matching/);
});

test('findAsioDevice throws a diagnosable error listing every ASIO device seen', () => {
  assert.throws(() => findAsioDevice(SAMPLE_DEVICES, 'nonexistent device'), (err) => {
    assert.match(err.message, /No ASIO device matching "nonexistent device"/);
    assert.match(err.message, /ASIO WING-USB/);
    assert.match(err.message, /ASIO4ALL v2/);
    return true;
  });
});

test('findAsioDevice reports when there are no ASIO devices at all, not an empty list', () => {
  const noAsio = SAMPLE_DEVICES.filter((d) => d.hostAPIName !== 'ASIO');
  assert.throws(() => findAsioDevice(noAsio, 'anything'), /is the ASIO driver installed/);
});

/* ---------------------------- interleaveStereo ------------------------------ */

test('interleaveStereo duplicates a mono signal onto both channels', () => {
  const mono = new Float64Array([0.5, -0.25, 1.0]);
  const buf = interleaveStereo(mono);
  assert.equal(buf.length, mono.length * 2 * 4);
  for (let i = 0; i < mono.length; i++) {
    const l = buf.readFloatLE(i * 8);
    const r = buf.readFloatLE(i * 8 + 4);
    assert.ok(Math.abs(l - mono[i]) < 1e-6);
    assert.equal(l, r, 'both channels must carry the identical sample');
  }
});

test('interleaveStereo handles an empty buffer without throwing', () => {
  const buf = interleaveStereo(new Float64Array(0));
  assert.equal(buf.length, 0);
});

/* ----------------------------- extractChannels ------------------------------ */

/** Build a synthetic interleaved Float32 buffer: frame i, channel c (0-indexed)
 *  = valueFn(i, c). Mirrors what a real multi-channel ASIO capture looks like. */
function buildInterleaved(frames, channelCount, valueFn) {
  const buf = Buffer.alloc(frames * channelCount * 4);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channelCount; c++) {
      buf.writeFloatLE(Math.fround(valueFn(i, c)), (i * channelCount + c) * 4);
    }
  }
  return buf;
}

test('extractChannels pulls the configured 1-indexed reference/mic channels out of a wider interleaved block', () => {
  // 6-channel capture (as if the interface exposes many more channels than
  // we need); reference on channel 1, mic on channel 2, other channels are
  // decoys that must be ignored.
  const raw = buildInterleaved(4, 6, (i, c) => (c === 0 ? i + 0.1 : c === 1 ? -(i + 0.1) : 999 + c));
  const { ref, mic } = extractChannels(raw, 6, 1, 2);
  assert.equal(ref.length, 4);
  assert.equal(mic.length, 4);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(ref[i] - (i + 0.1)) < 1e-5);
    assert.ok(Math.abs(mic[i] - -(i + 0.1)) < 1e-5);
  }
});

test('extractChannels works when reference/mic are non-adjacent, higher-numbered channels', () => {
  const raw = buildInterleaved(3, 8, (i, c) => c * 10 + i);
  const { ref, mic } = extractChannels(raw, 8, 5, 7); // 1-indexed -> 0-indexed 4 and 6
  for (let i = 0; i < 3; i++) {
    assert.equal(ref[i], 4 * 10 + i);
    assert.equal(mic[i], 6 * 10 + i);
  }
});

test('extractChannels handles reference and mic being the same channel (degenerate config) without crashing', () => {
  const raw = buildInterleaved(2, 2, (i, c) => i + c);
  const { ref, mic } = extractChannels(raw, 2, 1, 1);
  assert.deepEqual(Array.from(ref), Array.from(mic));
});

test('extractChannels round-trips with interleaveStereo for a simple 2-channel case', () => {
  const mono = new Float64Array([0.1, 0.2, 0.3, -0.4]);
  const buf = interleaveStereo(mono);
  const { ref, mic } = extractChannels(buf, 2, 1, 2);
  for (let i = 0; i < mono.length; i++) {
    assert.ok(Math.abs(ref[i] - mono[i]) < 1e-6);
    assert.ok(Math.abs(mic[i] - mono[i]) < 1e-6);
  }
});
