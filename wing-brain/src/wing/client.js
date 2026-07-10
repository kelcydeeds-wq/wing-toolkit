// client.js — Wing console interface for the System Tune feature (live + mock).
//
// The tune module needs very little from the console: route the measurement
// signal to one output at a time, read back current output EQ/delay, and —
// only after an explicit Apply tap — write recommended EQ/delay to outputs.
// The actual OSC connection (send/get/subscribe) lives in wing/osc.js — a
// generic transport with no tune-specific knowledge, shared with the audit
// scripts (dump-wing-state, apply-remap, the traffic recorder). This module
// is just a thin, tune-shaped API on top of it.
//
// Live OSC addresses confirmed against the official Wing OSC spec (church
// visit 2026-07-10) -- see scripts/wing-schema.mjs for the full address map
// and the reply-shape note. This module only ever targets main/mtx outputs,
// which have 6 numbered EQ bands and no low/high shelf letters.

import { makeOscTransport } from './osc.js';

const MAX_EQ_BANDS = 6; // main/mtx: numbered bands only, no l/h shelf

export function makeWing(config) {
  return config.mode === 'mock' ? new MockWing(config) : new LiveWing(config);
}

/* ------------------------------- LIVE ---------------------------------- */

class LiveWing {
  constructor(config) {
    this.osc = makeOscTransport(config);
    this.ready = this.osc.ready;
  }

  /** OSC path prefix for an output's Wing target (main bus vs matrix). */
  path(output) {
    const t = output.wing || {};
    return t.type === 'mtx' ? `/mtx/${t.num}` : `/main/${t.num}`;
  }

  /** Route measurement source to exactly one output, others muted. */
  async soloOutput(outputId, outputs) {
    await this.ready;
    for (const out of outputs) {
      if (out.enabled === false) continue;
      this.osc.send(`${this.path(out)}/mute`, [out.id === outputId ? 0 : 1]);
    }
  }

  async unmuteAll(outputs) {
    await this.ready;
    for (const out of outputs) {
      if (out.enabled === false) continue;
      this.osc.send(`${this.path(out)}/mute`, [0]);
    }
  }

  /** Apply recommended filters + delay to an output. Only called from Apply tap. */
  async applyTuning(output, filters, addDelayMs) {
    await this.ready;
    this.osc.send(`${this.path(output)}/delay`, [addDelayMs]);
    filters.forEach((f, i) => {
      const band = i + 1;
      if (band > MAX_EQ_BANDS) {
        console.warn(`[wing] ${output.id}: filter #${band} has no EQ band on this bus (max ${MAX_EQ_BANDS}) -- skipped: ${f.freq} Hz`);
        return;
      }
      const base = `${this.path(output)}/eq`;
      this.osc.send(`${base}/${band}f`, [f.freq]);
      this.osc.send(`${base}/${band}g`, [f.gainDb]);
      this.osc.send(`${base}/${band}q`, [f.q]);
    });
    this.osc.send(`${this.path(output)}/eq/on`, [1]);
  }

  close() { this.osc.close(); }
}

/* ------------------------------- MOCK ---------------------------------- */

class MockWing {
  constructor() {
    this.state = { solo: null, applied: [] };
  }
  async soloOutput(outputId) {
    this.state.solo = outputId;
    log(`[mockWing] solo output → ${outputId}`);
  }
  async unmuteAll() {
    this.state.solo = null;
    log('[mockWing] all outputs unmuted');
  }
  async applyTuning(output, filters, addDelayMs) {
    this.state.applied.push({ output: output.id, filters, addDelayMs, at: Date.now() });
    log(`[mockWing] APPLY ${output.id}: +${addDelayMs} ms, ${filters.length} filters`);
  }
  close() {}
}

const log = (...a) => console.log(...a);
