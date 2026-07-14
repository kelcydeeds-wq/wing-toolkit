// client.js — Wing console interface for the System Tune feature (live + mock).
//
// The tune module needs very little from the console: route the measurement
// signal to one BUS at a time, read back current bus EQ/delay, and — only
// after an explicit Apply tap — write recommended EQ/delay to buses. The
// actual OSC connection (send/get/subscribe) lives in wing/osc.js — a
// generic transport with no tune-specific knowledge, shared with the audit
// scripts (dump-wing-state, apply-remap, the traffic recorder). This module
// is just a thin, tune-shaped API on top of it.
//
// ROUTING MODEL (two layers — see docs/DECISIONS.md for the full rationale):
//   Layer 1, buses  — the logical mix buses (Main 1 stereo mains, a mono sub
//     bus, mono fill buses). Live modules (mutes, loudness, EQ, delay) read
//     and write ONLY this layer. soloOutput/unmuteAll/applyTuning below all
//     take a BUS object, never a physical output.
//   Layer 2, physical outputs — individual output sockets, each pointing at
//     a source bus. Dumb patches only: applyTuning() never targets one.
//     Per-driver test injection (injectTestSignal/restorePatch below) is the
//     only thing that ever touches a physical output's OWN address, and it
//     goes through PatchManager's snapshot/restore safety net every time.
//
// Live OSC addresses for bus mixing parameters (fader/mute/EQ) were
// confirmed against the official Wing OSC spec (church visit 2026-07-10) --
// see scripts/wing-schema.mjs. Physical-output PATCH addressing
// (physicalOutputPatchFields in that same file) is still an unconfirmed
// guess -- PatchManager refuses to use it in live mode until confirmed.

import { makeOscTransport } from './osc.js';
import { PatchManager } from './patch-manager.js';

const MAX_EQ_BANDS = 6; // main/mtx: numbered bands only, no l/h shelf

export function makeWing(config, opts = {}) {
  return config.mode === 'mock' ? new MockWing(config, opts) : new LiveWing(config, opts);
}

/* ------------------------------- LIVE ---------------------------------- */

class LiveWing {
  constructor(config, { dataDir } = {}) {
    this.cfg = config;
    this.osc = makeOscTransport(config);
    this.ready = this.osc.ready;
    this.patches = new PatchManager({ config, transport: this.osc, dataDir });
  }

  /** OSC path prefix for a bus's Wing target (main bus vs matrix). */
  path(bus) {
    const t = bus.wing || {};
    return t.type === 'mtx' ? `/mtx/${t.num}` : `/main/${t.num}`;
  }

  /** Route measurement source to exactly one bus, others muted. `buses` is
   *  the caller's already-filtered active-bus list (session.js decides
   *  which buses are in play from physicalOutputs[].enabled). */
  async soloOutput(busId, buses) {
    await this.ready;
    for (const bus of buses) {
      this.osc.send(`${this.path(bus)}/mute`, [bus.id === busId ? 0 : 1]);
    }
  }

  async unmuteAll(buses) {
    await this.ready;
    for (const bus of buses) this.osc.send(`${this.path(bus)}/mute`, [0]);
  }

  /** Apply recommended filters + delay to a BUS. Only called from Apply tap.
   *  Physical outputs are never individually EQ'd/delayed — dumb patches
   *  only, correction always targets the bus layer. */
  async applyTuning(bus, filters, addDelayMs) {
    await this.ready;
    this.osc.send(`${this.path(bus)}/delay`, [addDelayMs]);
    filters.forEach((f, i) => {
      const band = i + 1;
      if (band > MAX_EQ_BANDS) {
        console.warn(`[wing] ${bus.id}: filter #${band} has no EQ band on this bus (max ${MAX_EQ_BANDS}) -- skipped: ${f.freq} Hz`);
        return;
      }
      const base = `${this.path(bus)}/eq`;
      this.osc.send(`${base}/${band}f`, [f.freq]);
      this.osc.send(`${base}/${band}g`, [f.gainDb]);
      this.osc.send(`${base}/${band}q`, [f.q]);
    });
    this.osc.send(`${this.path(bus)}/eq/on`, [1]);
  }

  /** Per-driver test injection (routing model section 2) — repatch one
   *  physical output's source to the test signal, snapshotted for restore.
   *  See PatchManager for the safety gates (confirmed addresses only). */
  async injectTestSignal(physicalOutput) {
    await this.ready;
    return this.patches.injectTestSignal(physicalOutput);
  }

  restorePatch(physicalOutput) { return this.patches.restorePatch(physicalOutput); }
  restoreAllPatches() { return this.patches.restoreAll(); }
  hasPendingPatches() { return this.patches.hasPendingPatches(); }

  close() { this.osc.close(); }
}

/* ------------------------------- MOCK ---------------------------------- */

class MockWing {
  constructor(config, { dataDir } = {}) {
    this.cfg = config;
    this.osc = makeOscTransport({ mode: 'mock' });
    this.patches = new PatchManager({ config, transport: this.osc, dataDir });
    this.state = { solo: null, applied: [] };
  }
  async soloOutput(busId) {
    this.state.solo = busId;
    log(`[mockWing] solo bus → ${busId}`);
  }
  async unmuteAll() {
    this.state.solo = null;
    log('[mockWing] all buses unmuted');
  }
  async applyTuning(bus, filters, addDelayMs) {
    this.state.applied.push({ bus: bus.id, filters, addDelayMs, at: Date.now() });
    log(`[mockWing] APPLY ${bus.id}: +${addDelayMs} ms, ${filters.length} filters`);
  }
  async injectTestSignal(physicalOutput) { return this.patches.injectTestSignal(physicalOutput); }
  restorePatch(physicalOutput) { return this.patches.restorePatch(physicalOutput); }
  restoreAllPatches() { return this.patches.restoreAll(); }
  hasPendingPatches() { return this.patches.hasPendingPatches(); }
  close() { this.osc.close(); }
}

const log = (...a) => console.log(...a);
