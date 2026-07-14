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

  /** OSC address that turns the injected test signal on/off for one bus, if
   *  `testSignal.auxChannel` is configured (confirmed live 2026-07-14): the
   *  aux strip receiving the injected signal has independent send/assign
   *  toggles per main and per matrix, so isolation can happen at the SOURCE
   *  instead of by muting bus masters. Returns null if no aux is configured
   *  (caller falls back to mute-based isolation). */
  sourceSwitchAddress(bus) {
    const aux = this.cfg.testSignal?.auxChannel;
    if (!aux) return null;
    const t = bus.wing || {};
    return t.type === 'mtx' ? `/aux/${aux}/send/MX${t.num}/on` : `/aux/${aux}/main/${t.num}/on`;
  }

  /**
   * Route measurement source to exactly one bus. `buses` is the caller's
   * already-filtered active-bus list (session.js decides which buses are in
   * play from physicalOutputs[].enabled).
   *
   * PREFERS source-side isolation (toggling the injected signal's per-bus
   * send, via sourceSwitchAddress()) over muting bus masters. Muting is NOT
   * safe on this console: `/cfg/mainlink` links Main 1 (mains) + Main 2 (sub)
   * so muting Main 1 to isolate another bus force-mutes the sub too (confirmed
   * live 2026-07-14 -- Main 2's effective $mute followed Main 1's mute even
   * though Main 2's own mute button was untouched). Source-side isolation
   * sidesteps this entirely: bus mute state is never touched, so a linked bus
   * is unaffected by another bus being isolated. Falls back to the old
   * mute-based method only if no `testSignal.auxChannel` is configured (e.g.
   * mock/tests, or a console where this hasn't been set up yet).
   */
  async soloOutput(busId, buses) {
    await this.ready;
    for (const bus of buses) {
      const on = bus.id === busId;
      const srcAddr = this.sourceSwitchAddress(bus);
      if (srcAddr) this.osc.send(srcAddr, [on ? 1 : 0]);
      else this.osc.send(`${this.path(bus)}/mute`, [on ? 0 : 1]);
    }
  }

  async unmuteAll(buses) {
    await this.ready;
    for (const bus of buses) {
      const srcAddr = this.sourceSwitchAddress(bus);
      // Defensive: always unmute the bus itself too (cheap, harmless, and
      // covers any bus left muted by a prior session's old mute-based run).
      this.osc.send(`${this.path(bus)}/mute`, [0]);
      if (srcAddr) this.osc.send(srcAddr, [0]); // session over -- injector silent
    }
  }

  /** Apply recommended filters + delay to a BUS. Only called from Apply tap.
   *  Physical outputs are never individually EQ'd/delayed — dumb patches
   *  only, correction always targets the bus layer. */
  async applyTuning(bus, filters, addDelayMs) {
    await this.ready;
    // Delay on the real console is /<out>/dly/dly (value) + /dly/on + /dly/mode,
    // NOT /<out>/delay (confirmed live 2026-07-14 — the old address was a no-op).
    // mode "MS" = milliseconds (also valid: M=meters, FT=feet, SMP=samples); the
    // recommender works in ms, so force MS before writing the value.
    const dp = `${this.path(bus)}/dly`;
    this.osc.send(`${dp}/mode`, ['MS']);      // string enum
    this.osc.sendFloat(`${dp}/dly`, [addDelayMs]); // continuous -> MUST be float
    this.osc.send(`${dp}/on`, [1]);           // discrete on/off
    filters.forEach((f, i) => {
      const band = i + 1;
      if (band > MAX_EQ_BANDS) {
        console.warn(`[wing] ${bus.id}: filter #${band} has no EQ band on this bus (max ${MAX_EQ_BANDS}) -- skipped: ${f.freq} Hz`);
        return;
      }
      // EQ freq/gain/Q are continuous — the Wing ignores integer-typed values
      // for these, so they must go out as OSC floats (see osc.js sendFloat).
      const base = `${this.path(bus)}/eq`;
      this.osc.sendFloat(`${base}/${band}f`, [f.freq]);
      this.osc.sendFloat(`${base}/${band}g`, [f.gainDb]);
      this.osc.sendFloat(`${base}/${band}q`, [f.q]);
    });
    this.osc.send(`${this.path(bus)}/eq/on`, [1]); // discrete on/off
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
