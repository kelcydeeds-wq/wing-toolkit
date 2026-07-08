// session.js — the guided measurement session state machine.
//
// A session walks: for each position → for each output → sweep, extract IR,
// compute delay + magnitude. When all positions are done: spatial average,
// EQ + delay recommendations, wait for human Apply.
//
// Modes:
//   'verify'  — one position (config room.verifyPosition), all outputs,
//               compares against stored baseline, writes nothing.
//   'full'    — all positions, all outputs, produces recommendations.

import { makeESS, extractIR, findDelay, magnitudeResponse, polarity, rmsDbfs }
  from '../dsp/measure.js';
import { spatialAverage, targetOnGrid, recommendEQ, recommendDelays }
  from '../dsp/tune.js';
import fs from 'node:fs';
import path from 'node:path';

const BASELINE_PATH = path.resolve('data/baseline.json');

export class TuneSession {
  constructor({ config, room, audio, wing, emit }) {
    this.cfg = config;
    this.room = room;
    this.audio = audio;
    this.wing = wing;
    this.emit = emit; // (event, payload) → websocket broadcast

    this.mode = null;
    this.positions = [];
    this.posIndex = 0;
    this.results = [];   // { positionId, outputId, delayMs, confidence, polarity, freqs, magDb, levelDbfs }
    this.state = 'idle'; // idle | waiting_position | measuring | review | done
    this.recommendations = null;

    const s = config.audio.sweep;
    const { sweep, inverse } = makeESS({ ...s, sampleRate: config.audio.sampleRate });
    this.sweep = sweep;
    this.inverse = inverse;
    this.captureSeconds = s.seconds + s.padSeconds;
  }

  snapshot() {
    return {
      state: this.state,
      mode: this.mode,
      positions: this.positions.map((p, i) => ({
        ...p, status: i < this.posIndex ? 'done' : i === this.posIndex ? 'current' : 'pending'
      })),
      posIndex: this.posIndex,
      results: this.results.map(({ freqs, magDb, ...meta }) => meta), // meters only, traces sent separately
      recommendations: this.recommendations
    };
  }

  start(mode) {
    if (this.state !== 'idle' && this.state !== 'done' && this.state !== 'review') {
      throw new Error('session already running');
    }
    this.mode = mode;
    this.results = [];
    this.recommendations = null;
    this.positions = mode === 'verify'
      ? this.room.positions.filter((p) => p.id === this.room.verifyPosition)
      : [...this.room.positions];
    this.posIndex = 0;
    this.state = 'waiting_position';
    this.emit('session', this.snapshot());
  }

  /** Phone tapped Ready at the current mic position. */
  async ready() {
    if (this.state !== 'waiting_position') return;
    this.state = 'measuring';
    const pos = this.positions[this.posIndex];
    this.emit('session', this.snapshot());

    try {
      for (const output of this.cfg.outputs) {
        this.emit('measuring', { position: pos.label, output: output.label });
        if (this.audio.setScenario) this.audio.setScenario(output.id, pos); // mock hook
        await this.wing.soloOutput(output.id, this.cfg.outputs);
        await pause(400); // let mutes settle

        const { ref, mic } = await this.audio.playAndCapture(this.sweep, this.captureSeconds);

        const delay = findDelay(ref, mic, this.cfg.audio.sampleRate);
        if (delay.confidence < 3) {
          this.emit('warning', {
            message: `Low confidence on ${output.label} at ${pos.label} — check mic/routing, retake recommended.`,
            position: pos.id, output: output.id
          });
        }
        const ir = extractIR(mic, this.inverse, this.cfg.audio.sampleRate);
        const { freqs, magDb } = magnitudeResponse(ir, this.cfg.audio.sampleRate);

        const result = {
          positionId: pos.id, positionWeight: pos.weight ?? 1,
          outputId: output.id,
          delayMs: delay.ms, confidence: Math.round(delay.confidence),
          polarity: polarity(ir),
          levelDbfs: Math.round(rmsDbfs(mic) * 10) / 10,
          freqs: Array.from(freqs), magDb: Array.from(magDb)
        };
        this.results.push(result);
        this.emit('trace', result);
      }
      await this.wing.unmuteAll(this.cfg.outputs);

      this.posIndex++;
      if (this.posIndex >= this.positions.length) {
        this.finish();
      } else {
        this.state = 'waiting_position';
        this.emit('session', this.snapshot());
      }
    } catch (err) {
      this.state = 'waiting_position'; // allow retake of this position
      this.emit('error', { message: String(err.message || err) });
      this.emit('session', this.snapshot());
    }
  }

  /** Retake the previous position. */
  retake() {
    if (this.posIndex > 0 && this.state === 'waiting_position') {
      this.posIndex--;
      this.results = this.results.filter((r) => r.positionId !== this.positions[this.posIndex].id);
      this.emit('session', this.snapshot());
    }
  }

  finish() {
    if (this.mode === 'verify') {
      this.recommendations = this.buildVerifyReport();
      this.state = 'done';
    } else {
      this.recommendations = this.buildRecommendations();
      this.state = 'review';
    }
    this.emit('session', this.snapshot());
  }

  buildRecommendations() {
    const g = this.cfg.guardrails;
    const perOutput = {};
    const delaysByOutput = {};

    for (const output of this.cfg.outputs) {
      const rs = this.results.filter((r) => r.outputId === output.id);
      if (!rs.length) continue;
      delaysByOutput[output.id] = rs.map((r) => r.delayMs);

      const grid = rs[0].freqs;
      const { avg, varDb } = spatialAverage(
        rs.map((r) => ({ magDb: Float64Array.from(r.magDb), weight: r.positionWeight }))
      );
      const target = targetOnGrid(this.cfg.targetCurve.points, Float64Array.from(grid));
      const filters = recommendEQ({
        freqs: Float64Array.from(grid), avg, varDb, target, guardrails: g,
        band: output.band
      });

      perOutput[output.id] = {
        label: output.label,
        filters,
        avg: Array.from(avg), varDb: Array.from(varDb),
        target: Array.from(target), freqs: grid,
        polarityIssue: rs.some((r) => r.polarity < 0)
      };
    }

    const delays = recommendDelays(delaysByOutput, this.cfg.outputs[0].id);
    return { perOutput, delays, applied: false };
  }

  buildVerifyReport() {
    const baseline = fs.existsSync(BASELINE_PATH)
      ? JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
      : null;
    const report = { outputs: [], baselineFound: !!baseline };
    for (const output of this.cfg.outputs) {
      const r = this.results.find((x) => x.outputId === output.id);
      if (!r) continue;
      const entry = {
        label: output.label,
        delayMs: Math.round(r.delayMs * 10) / 10,
        levelDbfs: r.levelDbfs,
        polarity: r.polarity,
        confidence: r.confidence,
        drift: null
      };
      if (baseline) {
        const b = baseline.outputs?.find((x) => x.label === output.label);
        if (b) {
          entry.drift = {
            delayMs: Math.round((r.delayMs - b.delayMs) * 10) / 10,
            levelDb: Math.round((r.levelDbfs - b.levelDbfs) * 10) / 10
          };
        }
      }
      report.outputs.push(entry);
    }
    return report;
  }

  /** Save current verify results as the new baseline. */
  saveBaseline() {
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(this.buildVerifyReport(), null, 2));
    this.emit('info', { message: 'Baseline saved.' });
  }

  /** Human tapped Apply — the only path that writes to the console. */
  async apply() {
    if (this.state !== 'review' || !this.recommendations) return;
    for (const output of this.cfg.outputs) {
      const rec = this.recommendations.perOutput[output.id];
      const delay = this.recommendations.delays[output.id];
      if (!rec) continue;
      await this.wing.applyTuning(output, rec.filters, delay?.addDelayMs ?? 0);
    }
    this.recommendations.applied = true;
    this.state = 'done';
    this.emit('session', this.snapshot());
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
