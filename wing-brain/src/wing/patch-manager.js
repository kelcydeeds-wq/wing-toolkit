// patch-manager.js — defensive snapshot/restore for physical-output patch
// repatching during per-driver test injection (System Tune's routing model).
//
// Safety-critical: an output left pointed at the test signal after a crash
// means dead air (or a stuck test tone) on a real PA during a live service.
// Every repatch is preceded by a disk snapshot of the ORIGINAL patch state,
// written BEFORE the repatch happens. Restore fires on: explicit completion,
// any thrown error, SIGINT, uncaughtException -- plus a manual "Restore All
// Patches" escape hatch that doesn't need to know what was repatched, it
// just replays whatever the snapshot file on disk says.
//
// >>> physicalOutputPatchFields() (wing-schema.mjs) is an UNCONFIRMED GUESS
//     at the real OSC address family. Every write here is gated on
//     `wing.confirmed === true` (per physical output) and
//     `testSignal.confirmed === true` (globally) in LIVE mode -- mock mode
//     ignores both gates, since nothing physical is at risk. Never remove
//     these gates to "make it work" against a real console; confirm the
//     addresses first. <<<

import fs from 'node:fs';
import path from 'node:path';
import { physicalOutputPatchFields, readValue } from '../../scripts/wing-schema.mjs';

const DEFAULT_DATA_DIR = 'data';

let activeManager = null;
let processHandlersInstalled = false;

/**
 * Registered once per process (guarded), not once per PatchManager instance
 * -- buildRuntime() in server.js recreates the manager on every settings
 * save, and we must not accumulate a new SIGINT listener every time. The
 * most-recently-constructed manager becomes `activeManager`, but restoreAll()
 * reads from the on-disk snapshot regardless of which instance is "active",
 * so correctness never depends on which one a crash happens to catch.
 */
function installProcessHandlersOnce() {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  const restoreActive = (label) => {
    if (!activeManager) return;
    try {
      const restored = activeManager.restoreAll();
      if (restored.length) console.error(`[patch-manager] ${label}: restored ${restored.length} pending patch(es)`);
    } catch (err) {
      console.error(`[patch-manager] ${label}: restore failed —`, err);
    }
  };
  process.on('SIGINT', () => { restoreActive('SIGINT'); process.exit(1); });
  process.on('uncaughtException', (err) => {
    console.error('[patch-manager] uncaught exception, restoring all patches before exit:', err);
    restoreActive('uncaughtException');
    process.exitCode = 1;
  });
}

export class PatchManager {
  constructor({ config, transport, dataDir = DEFAULT_DATA_DIR }) {
    this.cfg = config;
    this.osc = transport;
    this.dataDir = dataDir;
    this.snapshotPath = path.resolve(dataDir, 'patch-snapshot.json');
    installProcessHandlersOnce();
    activeManager = this;
  }

  _readSnapshot() {
    if (!fs.existsSync(this.snapshotPath)) return {};
    try { return JSON.parse(fs.readFileSync(this.snapshotPath, 'utf8')); }
    catch { return {}; } // corrupt/partial snapshot -- treat as empty rather than crash
  }

  _writeSnapshot(snapshot) {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${this.snapshotPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, this.snapshotPath);
  }

  /** True if any physical output has a pending (unrestored) patch snapshot
   *  — e.g. the server crashed mid-injection last run. Server startup checks
   *  this to warn the operator before anything else happens. */
  hasPendingPatches() {
    return Object.keys(this._readSnapshot()).length > 0;
  }

  /** Read a physical output's CURRENT patch source over OSC. Returns null on
   *  timeout/no address configured — callers must treat that as "the
   *  original is unknown, do not repatch," never guess a fallback. */
  async readCurrentSource(physicalOutput, { timeoutMs = 800 } = {}) {
    const { grp, num } = physicalOutput.wing || {};
    if (!grp || !num) return null;
    const fields = physicalOutputPatchFields(grp, num);
    const [srcGrp, srcIn] = await Promise.all([
      this.osc.get(fields.sourceGrp, { timeoutMs }),
      this.osc.get(fields.sourceIn, { timeoutMs })
    ]);
    const grpVal = readValue(srcGrp), inVal = readValue(srcIn);
    if (grpVal == null && inVal == null) return null;
    return { grp: grpVal, in: inVal };
  }

  /**
   * Repatch one physical output's source to the configured test signal,
   * snapshotting the original first. Refuses (throws) in live mode if:
   *   - the output's wing address hasn't been confirmed against the console,
   *   - the global test-signal injection point hasn't been confirmed,
   *   - the original source couldn't be read (never repatch what we can't
   *     restore).
   * Mock mode skips all three gates — nothing physical is at risk.
   */
  async injectTestSignal(physicalOutput, { timeoutMs = 800 } = {}) {
    if (!physicalOutput.wing?.grp || !physicalOutput.wing?.num) {
      throw new Error(`${physicalOutput.id}: no wing.grp/num configured yet — run output discovery first (nothing to repatch).`);
    }
    const live = this.cfg.mode !== 'mock';
    if (live && !physicalOutput.wing?.confirmed) {
      throw new Error(`${physicalOutput.id}: wing.confirmed is false — refusing to repatch an unverified address. Run output discovery and confirm it first.`);
    }
    const ts = this.cfg.testSignal || {};
    if (live && !ts.confirmed) {
      throw new Error('testSignal.confirmed is false — the test signal source/injection point has not been verified against the real console.');
    }

    const original = await this.readCurrentSource(physicalOutput, { timeoutMs });
    if (live && !original) {
      throw new Error(`${physicalOutput.id}: could not read its current patch source (no reply) — refusing to repatch something we can't restore.`);
    }

    const snap = this._readSnapshot();
    snap[physicalOutput.id] = {
      at: new Date().toISOString(),
      original: original || { grp: null, in: null }
    };
    this._writeSnapshot(snap);

    const { grp, num } = physicalOutput.wing;
    const fields = physicalOutputPatchFields(grp, num);
    this.osc.send(fields.sourceGrp, [ts.injectionChannelGrp]);
    this.osc.send(fields.sourceIn, [ts.injectionChannelNum]);
  }

  /** Restore one physical output to its snapshotted original patch and clear
   *  its snapshot entry. Returns false (no-op) if nothing was pending. */
  restorePatch(physicalOutput) {
    const snap = this._readSnapshot();
    const entry = snap[physicalOutput.id];
    if (!entry) return false;
    const { grp, num } = physicalOutput.wing || {};
    if (grp && num) {
      const fields = physicalOutputPatchFields(grp, num);
      this.osc.send(fields.sourceGrp, [entry.original.grp]);
      this.osc.send(fields.sourceIn, [entry.original.in]);
    }
    delete snap[physicalOutput.id];
    this._writeSnapshot(snap);
    return true;
  }

  /**
   * Restore EVERY output recorded in the snapshot file — the "Restore All
   * Patches" escape hatch (UI button + crash-recovery handlers). Reads
   * straight off disk, so it works even for a physical output whose config
   * entry was later removed/renamed, as long as the id + wing address are
   * still resolvable. Always synchronous — OSC sends are fire-and-forget UDP,
   * so this is safe to call from a SIGINT/uncaughtException handler where
   * awaiting isn't reliable. Returns the list of output ids that were restored.
   */
  restoreAll() {
    const snap = this._readSnapshot();
    const ids = Object.keys(snap);
    for (const id of ids) {
      const entry = snap[id];
      const physicalOutput = (this.cfg.physicalOutputs || []).find((o) => o.id === id);
      const wing = physicalOutput?.wing;
      if (wing?.grp && wing?.num) {
        const fields = physicalOutputPatchFields(wing.grp, wing.num);
        this.osc.send(fields.sourceGrp, [entry.original.grp]);
        this.osc.send(fields.sourceIn, [entry.original.in]);
      } else {
        console.error(`[patch-manager] restoreAll: "${id}" has no resolvable wing address anymore — snapshot cleared but nothing could be sent. Check it manually on the console.`);
      }
    }
    this._writeSnapshot({});
    return ids;
  }
}
