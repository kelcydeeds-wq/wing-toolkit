// io.js — audio playback/capture abstraction.
//
// LIVE mode: opens ONE full-duplex ASIO stream (naudiodon, built on
// PortAudio) so playback and capture share a single audio clock/callback --
// that shared clock is what actually makes "PC/interface latency cancels in
// cross-correlation" true (see dsp/measure.js's findDelay()). A previous
// implementation used sox with `-t waveaudio` (Windows MME) via two
// independent play/record processes -- MME has well-documented large fixed
// buffering (commonly 200-500ms) and, since it's two unrelated processes,
// no shared-clock guarantee at all. That combination is what produced a
// real 300-500ms "delay" reading at church that had nothing to do with
// acoustics. See docs/DECISIONS.md for the full diagnosis.
//
// naudiodon is a native addon that must be BUILT FROM SOURCE with the
// Steinberg ASIO SDK to get real ASIO support on Windows (the SDK can't be
// legally redistributed as a prebuilt binary) -- `npm install` on the brain
// box needs Visual Studio Build Tools (Desktop C++ workload), Python, and
// internet access for the SDK download step. It is imported LAZILY here
// (dynamic import inside LiveAudioIO, never at module load time) so mock
// mode and the whole test suite work with zero dependency on it being
// installed or buildable on any given machine -- only constructing a LIVE
// AudioIO ever touches it.
//
// >>> TODO(church): config.audio.inputDevice/outputDevice currently hold
//     the old MME-era device name ("IN 1-2 (BEHRINGER WING-USB)"). ASIO
//     typically exposes a whole interface as ONE bidirectional device with
//     a different name (often just "ASIO" + the interface name) -- these
//     values are almost certainly wrong until confirmed live against
//     naudiodon.getDevices() on the real console network. <<<
//
// MOCK mode: simulates a small PA in a reverberant room so the full workflow
// can be developed and demoed without hardware. Unchanged by this rework --
// it never touches real audio hardware, so none of the above applies to it.

import { fftConvolve } from '../dsp/measure.js';

export function makeAudioIO(config) {
  return config.mode === 'mock' ? new MockAudioIO(config) : new LiveAudioIO(config);
}

/* ------------------------------- LIVE ---------------------------------- */

const BYTES_PER_SAMPLE = 4; // Float32

/**
 * Pick the ASIO device whose name contains `nameHint` (case-insensitive).
 * Throws with the list of every ASIO device actually seen if nothing
 * matches -- fails loudly with a diagnosable message rather than silently
 * opening the wrong interface. `devices` is whatever naudiodon.getDevices()
 * returns (or an equivalent plain array in tests).
 */
export function findAsioDevice(devices, nameHint) {
  const asioDevices = (devices || []).filter((d) => /asio/i.test(d.hostAPIName || ''));
  const hint = String(nameHint || '').toLowerCase();
  const match = asioDevices.find((d) => d.name.toLowerCase().includes(hint));
  if (!match) {
    const seen = asioDevices.length
      ? asioDevices.map((d) => d.name).join(', ')
      : '(no ASIO devices found at all -- is the ASIO driver installed and the interface powered on?)';
    throw new Error(`No ASIO device matching "${nameHint}". ASIO devices seen: ${seen}`);
  }
  return match;
}

/** Interleave a mono Float64Array sweep into a stereo Float32 Buffer (both
 *  channels carry the same signal -- there's no per-channel output config,
 *  and the console's incoming USB tap is a stereo pair). */
export function interleaveStereo(mono) {
  const buf = Buffer.alloc(mono.length * 2 * BYTES_PER_SAMPLE);
  for (let i = 0; i < mono.length; i++) {
    const v = Math.fround(mono[i]);
    buf.writeFloatLE(v, i * 2 * BYTES_PER_SAMPLE);
    buf.writeFloatLE(v, i * 2 * BYTES_PER_SAMPLE + BYTES_PER_SAMPLE);
  }
  return buf;
}

/**
 * De-interleave a captured raw Float32 buffer into the two channels
 * (1-indexed) configured as reference/mic. Works for any channelCount >=
 * max(refChannel, micChannel) -- the interface may expose far more input
 * channels than the two we actually read, and PortAudio/naudiodon can only
 * open "the first N channels" of a device, not an arbitrary offset, so the
 * caller opens N = max(refChannel, micChannel) channels and this picks the
 * two of interest out of that block.
 */
export function extractChannels(raw, channelCount, refChannel, micChannel) {
  const frameBytes = channelCount * BYTES_PER_SAMPLE;
  const n = frameBytes > 0 ? Math.floor(raw.length / frameBytes) : 0;
  const ref = new Float64Array(n), mic = new Float64Array(n);
  const refOffset = (refChannel - 1) * BYTES_PER_SAMPLE;
  const micOffset = (micChannel - 1) * BYTES_PER_SAMPLE;
  for (let i = 0; i < n; i++) {
    const base = i * frameBytes;
    ref[i] = raw.readFloatLE(base + refOffset);
    mic[i] = raw.readFloatLE(base + micOffset);
  }
  return { ref, mic };
}

class LiveAudioIO {
  constructor(config) {
    this.cfg = config.audio;
    this._stream = null;
    this._channelCount = null;
    this._readyPromise = this._open();
    // Attach a handler immediately so a device-lookup failure at
    // construction time (e.g. dev machine with no ASIO hardware) doesn't
    // crash the process as an unhandled rejection before anything ever
    // calls playAndCapture() (which awaits this same promise and surfaces
    // the real error there, on the first actual measurement attempt).
    this._readyPromise.catch((err) => console.error('[audio] live audio failed to initialize:', err.message));
  }

  async _open() {
    let naudiodon;
    try {
      naudiodon = (await import('naudiodon')).default ?? await import('naudiodon');
    } catch (err) {
      throw new Error(
        `naudiodon failed to load (${err.message}). Live audio needs it built from source with ` +
        `ASIO support -- run "npm install" on a machine with Visual Studio Build Tools (Desktop ` +
        `C++ workload), Python, and internet access (the ASIO SDK downloads during install). ` +
        `See docs/DECISIONS.md for the full requirement.`
      );
    }
    this._naudiodon = naudiodon;

    const devices = naudiodon.getDevices();
    let device;
    try {
      device = findAsioDevice(devices, this.cfg.inputDevice);
    } catch {
      device = findAsioDevice(devices, this.cfg.outputDevice); // let this one's error propagate if it also fails
    }

    this._channelCount = Math.max(this.cfg.referenceInputChannel, this.cfg.micInputChannel);
    this._stream = new naudiodon.AudioIO({
      inOptions: {
        deviceId: device.id, channelCount: this._channelCount,
        sampleFormat: naudiodon.SampleFormatFloat32, sampleRate: this.cfg.sampleRate,
        closeOnError: false
      },
      outOptions: {
        deviceId: device.id, channelCount: 2,
        sampleFormat: naudiodon.SampleFormatFloat32, sampleRate: this.cfg.sampleRate,
        closeOnError: false
      }
    });
    this._stream.start();
    return device;
  }

  /**
   * Play `sweep` (mono) while capturing `captureSeconds` of input, through
   * the ONE already-open full-duplex stream opened in _open() -- input and
   * output share the same ASIO callback loop for the lifetime of this
   * object, they are never reopened per call.
   */
  async playAndCapture(sweep, captureSeconds) {
    await this._readyPromise;
    const nCaptureFrames = Math.floor(captureSeconds * this.cfg.sampleRate);
    const frameBytes = this._channelCount * BYTES_PER_SAMPLE;

    const chunks = [];
    let framesCaptured = 0;
    const onData = (chunk) => { chunks.push(chunk); framesCaptured += Math.floor(chunk.length / frameBytes); };
    this._stream.on('data', onData);

    this._stream.write(interleaveStereo(sweep));
    while (framesCaptured < nCaptureFrames) await sleep(20);
    this._stream.removeListener('data', onData);

    const raw = Buffer.concat(chunks);
    return extractChannels(raw, this._channelCount, this.cfg.referenceInputChannel, this.cfg.micInputChannel);
  }

  /**
   * Capture `seconds` of mic input WITHOUT writing any playback signal --
   * used by the tune session's auto-SNR safety net to measure the ambient
   * noise floor before a sweep. Same duplex stream, same channel
   * extraction as playAndCapture(), just no write().
   */
  async captureAmbient(seconds) {
    await this._readyPromise;
    const nCaptureFrames = Math.floor(seconds * this.cfg.sampleRate);
    const frameBytes = this._channelCount * BYTES_PER_SAMPLE;

    const chunks = [];
    let framesCaptured = 0;
    const onData = (chunk) => { chunks.push(chunk); framesCaptured += Math.floor(chunk.length / frameBytes); };
    this._stream.on('data', onData);

    while (framesCaptured < nCaptureFrames) await sleep(20);
    this._stream.removeListener('data', onData);

    const raw = Buffer.concat(chunks);
    const { mic } = extractChannels(raw, this._channelCount, this.cfg.referenceInputChannel, this.cfg.micInputChannel);
    return { mic };
  }

  close() {
    try { this._stream?.quit(() => {}); } catch { /* best effort */ }
  }
}

/* ------------------------------- MOCK ---------------------------------- */

class MockAudioIO {
  constructor(config) {
    this.cfg = config.audio;
    this.sr = config.audio.sampleRate;
    this.currentOutput = 'main_l';
    this.currentPosition = { x: 9, y: 17 };
    // TEST-ONLY HOOK (piece 3: crossover summation check) -- not a config or
    // UI setting, just a Set a test can poke directly to prove the FAIL path
    // of detectCrossoverCancellation() through the real mock room model: add
    // a speakerId here and its direct-path spike in roomIR() below comes out
    // inverted, genuinely cancelling against an in-phase source at the same
    // position/delay. No operator-facing affordance reads or writes this.
    this.invertedPolarity = new Set();
  }

  setScenario(outputId, position, sources) {
    this.currentOutput = outputId;
    this.currentPosition = position;
    this.currentSources = sources || [outputId];
  }

  async playAndCapture(sweep, captureSeconds) {
    const sr = this.sr;
    const n = Math.floor(captureSeconds * sr);

    // Reference channel: the sweep itself with a constant interface latency —
    // identical on both channels, so it must cancel in the delay math.
    const interfaceLatency = Math.floor(0.012 * sr);

    const ref = new Float64Array(n);
    for (let i = 0; i < Math.min(sweep.length, n - interfaceLatency); i++) {
      ref[i + interfaceLatency] = sweep[i];
    }

    // Mic channel: sweep convolved with a synthetic room IR for this output/position
    // Multi-source outputs (shared-channel fills): both boxes emit, IRs sum
    let ir = null;
    for (const src of (this.currentSources || [this.currentOutput])) {
      const one = this.roomIR(src, this.currentPosition);
      if (!ir) ir = one;
      else {
        const len = Math.max(ir.length, one.length);
        const sum = new Float64Array(len);
        sum.set(ir); for (let i = 0; i < one.length; i++) sum[i] += one[i];
        ir = sum;
      }
    }
    const wet = fftConvolve(sweep, ir);
    const mic = new Float64Array(n);
    for (let i = 0; i < Math.min(wet.length, n - interfaceLatency); i++) {
      mic[i + interfaceLatency] = wet[i] * 0.5;
    }
    // Mild noise floor
    for (let i = 0; i < n; i++) mic[i] += (Math.random() - 0.5) * 1e-4;

    await sleep(300); // pretend it took a moment
    return { ref, mic };
  }

  /** Mock ambient-noise probe: just the same mild noise floor term
   *  playAndCapture() adds, with no sweep/room convolution -- a realistic
   *  "quiet room" reading for the auto-SNR safety net's default path. */
  async captureAmbient(seconds) {
    const n = Math.floor(seconds * this.sr);
    const mic = new Float64Array(n);
    for (let i = 0; i < n; i++) mic[i] += (Math.random() - 0.5) * 1e-4;
    await sleep(150);
    return { mic };
  }

  /** Synthetic IR: distance delay + direct spike + a few reflections + tonal color. */
  roomIR(outputId, pos) {
    const sr = this.sr;
    const speakers = {
      main_l: { x: 5.9, y: -0.8, z: 5.0 },
      main_r: { x: 12.7, y: -0.8, z: 5.0 },
      sub:    { x: 9.3, y: -0.8, z: 5.5 },
      fill_l: { x: 1.5, y: 0, z: 1.0 },
      fill_c: { x: 9.6, y: 0, z: 1.0 },
      fill_r: { x: 17.3, y: 0, z: 1.0 }
    };
    const spk = speakers[outputId] || speakers.main_l;
    const dist = Math.hypot(pos.x - spk.x, pos.y - spk.y, (spk.z ?? 0) - (pos.z ?? 1.2));
    const delaySamp = Math.floor((dist / 343) * sr);

    const len = delaySamp + Math.floor(0.5 * sr);
    const ir = new Float64Array(len);
    // TEST-ONLY: this.invertedPolarity (see constructor) flips the direct-path
    // spike's sign for a deliberately mis-polarized source in tests.
    ir[delaySamp] = (this.invertedPolarity?.has(outputId) ? -1 : 1) * 1.0;

    // Early reflections
    const refl = [[0.007, 0.4], [0.019, 0.3], [0.031, -0.25], [0.044, 0.2]];
    for (const [t, g] of refl) {
      const idx = delaySamp + Math.floor(t * sr);
      if (idx < len) ir[idx] += g;
    }
    // Simple exponential tail
    const tailStart = delaySamp + Math.floor(0.05 * sr);
    for (let i = tailStart; i < len; i++) {
      ir[i] += (Math.random() - 0.5) * 0.15 * Math.exp(-(i - tailStart) / (0.18 * sr));
    }

    // Tonal color: sub only passes lows w/ a 55 Hz room mode; mains get a
    // 250 Hz buildup and a gentle HF rolloff — gives the recommender real work.
    if (outputId === 'sub') {
      onePoleLP(ir, 120, sr);
      addResonance(ir, 55, 6, sr);
    } else {
      addResonance(ir, 250, 4, sr);
      addResonance(ir, 125, 3, sr);
      onePoleLP(ir, 14000, sr);
    }
    return ir;
  }
}

function addResonance(ir, freq, gainDb, sr) {
  // Crude: add a decaying sinusoid at the resonant frequency
  const g = (Math.pow(10, gainDb / 20) - 1) * 0.15;
  const decay = 0.25 * sr;
  let start = 0;
  for (let i = 0; i < ir.length; i++) if (Math.abs(ir[i]) > 0.5) { start = i; break; }
  for (let i = start; i < ir.length; i++) {
    const t = i - start;
    ir[i] += g * Math.sin((2 * Math.PI * freq * t) / sr) * Math.exp(-t / decay);
  }
}

function onePoleLP(x, fc, sr) {
  const a = Math.exp((-2 * Math.PI * fc) / sr);
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    y = (1 - a) * x[i] + a * y;
    x[i] = y;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
