// io.js — audio playback/capture abstraction.
//
// LIVE mode: plays the sweep out the SoundGrid device and records two channels
//   (reference loopback + measurement mic). Implemented by shelling out to sox
//   for portability; swap for naudiodon/PortAudio if preferred once on the mini PC.
//   >>> Must be verified against the SoundGrid ASIO device at the church session. <<<
//
// MOCK mode: simulates a small PA in a reverberant room so the full workflow can
//   be developed and demoed without hardware. Different outputs get different
//   delays, tilts, resonances and a sub with a room mode — enough realism that
//   the analysis and recommendation code paths are genuinely exercised.

import { spawn } from 'node:child_process';
import { fftConvolve } from '../dsp/measure.js';

export function makeAudioIO(config) {
  return config.mode === 'mock' ? new MockAudioIO(config) : new LiveAudioIO(config);
}

/* ------------------------------- LIVE ---------------------------------- */

class LiveAudioIO {
  constructor(config) {
    this.cfg = config.audio;
  }

  /**
   * Play `sweep` (Float64Array) on the configured output while capturing
   * `captureSeconds` of 2-channel input. Returns { ref, mic } Float64Arrays.
   * TODO(church): verify device names via `sox --help` / list-devices on the
   * mini PC, confirm channel mapping for reference loopback vs. mic.
   */
  async playAndCapture(sweep, captureSeconds) {
    const sr = this.cfg.sampleRate;
    const playBuf = floatToWavBuffer(sweep, sr, 1);

    const rec = spawn('sox', [
      '-t', 'waveaudio', this.cfg.inputDevice,       // TODO(church): device string
      '-t', 'raw', '-r', String(sr), '-e', 'float', '-b', '32', '-c', '2', '-',
      'trim', '0', String(captureSeconds)
    ]);
    const chunks = [];
    rec.stdout.on('data', (d) => chunks.push(d));

    await playWav(playBuf, this.cfg.outputDevice);
    await new Promise((res) => rec.on('close', res));

    const raw = Buffer.concat(chunks);
    const n = Math.floor(raw.length / 8); // 2ch float32
    const ref = new Float64Array(n), mic = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      ref[i] = raw.readFloatLE(i * 8);
      mic[i] = raw.readFloatLE(i * 8 + 4);
    }
    return { ref, mic };
  }
}

function playWav(buf, device) {
  return new Promise((res, rej) => {
    const p = spawn('sox', ['-t', 'wav', '-', '-t', 'waveaudio', device]);
    p.on('close', (c) => (c === 0 ? res() : rej(new Error('sox play failed'))));
    p.stdin.end(buf);
  });
}

function floatToWavBuffer(x, sampleRate, channels) {
  const data = Buffer.alloc(x.length * 4);
  for (let i = 0; i < x.length; i++) data.writeFloatLE(x[i], i * 4);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(3, 20); // float
  header.writeUInt16LE(channels, 22); header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 4, 28);
  header.writeUInt16LE(channels * 4, 32); header.writeUInt16LE(32, 34);
  header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/* ------------------------------- MOCK ---------------------------------- */

class MockAudioIO {
  constructor(config) {
    this.cfg = config.audio;
    this.sr = config.audio.sampleRate;
    this.currentOutput = 'main_l';
    this.currentPosition = { x: 9, y: 17 };
  }

  setScenario(outputId, position) {
    this.currentOutput = outputId;
    this.currentPosition = position;
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
    const ir = this.roomIR(this.currentOutput, this.currentPosition);
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

  /** Synthetic IR: distance delay + direct spike + a few reflections + tonal color. */
  roomIR(outputId, pos) {
    const sr = this.sr;
    const speakers = {
      main_l: { x: 5, y: 1 },
      main_r: { x: 13, y: 1 },
      sub: { x: 9, y: 0.5 }
    };
    const spk = speakers[outputId] || speakers.main_l;
    const dist = Math.hypot(pos.x - spk.x, pos.y - spk.y);
    const delaySamp = Math.floor((dist / 343) * sr);

    const len = delaySamp + Math.floor(0.5 * sr);
    const ir = new Float64Array(len);
    ir[delaySamp] = 1.0;

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
