// Tests for the routing model's session.js additions: per-physical-output
// measurement, the shared-driver isolation wizard state machine, bus-layer
// correction pooling across multiple physical outputs, and test-signal
// injection/restore integration.
import { test, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TuneSession } from '../src/tune/session.js';
import { makeESS, fftConvolve } from '../src/dsp/measure.js';

const config = JSON.parse(fs.readFileSync(new URL('../config/default.json', import.meta.url), 'utf8'));
const room = JSON.parse(fs.readFileSync(new URL('../config/room.json', import.meta.url), 'utf8'));

const TMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-brain-test-wizard-'));
after(() => fs.rmSync(TMP_DATA_DIR, { recursive: true, force: true }));
function newSession(opts) { return new TuneSession({ ...opts, dataDir: TMP_DATA_DIR }); }

const sr = config.audio.sampleRate;
const { sweep } = makeESS({ ...config.audio.sweep, sampleRate: sr });
const captureSeconds = config.audio.sweep.seconds + config.audio.sweep.padSeconds;

// A single-position room keeps the wizard sequence (3 rounds per position)
// short in tests, instead of room.json's real 8 positions. Speakers are
// reused as-is so fill_l/fill_r geometry lookups (predictArrivalMs) still work.
const miniRoom = {
  name: 'Test Room', width: 10, depthMain: 10,
  speakers: room.speakers,
  positions: [{ id: 'p1', label: 'Test spot', zone: 'main', x: 9.25, y: 3, z: 1.2, weight: 1 }],
  verifyPosition: 'p1'
};

function cleanCapture(delayMs = 20, gain = 0.4, polaritySign = 1) {
  const delaySamp = Math.floor((delayMs / 1000) * sr);
  const n = Math.floor(captureSeconds * sr);
  const ref = new Float64Array(n), mic = new Float64Array(n);
  for (let i = 0; i < sweep.length && i + 100 < n; i++) ref[i + 100] = sweep[i];
  const ir = new Float64Array(delaySamp + 10);
  ir[delaySamp] = polaritySign * 1.0;
  const wet = fftConvolve(sweep, ir);
  for (let i = 0; i < wet.length && i + 100 < n; i++) mic[i + 100] = wet[i] * gain;
  return { ref, mic };
}

function sharedOutputConfig() {
  const bus = config.buses.find((b) => b.id === 'side_fills');
  const physicalOutput = { ...config.physicalOutputs.find((o) => o.id === 'side_fills_out') };
  return { ...config, buses: [bus], physicalOutputs: [physicalOutput] };
}

function twoOutputBusConfig() {
  // "mains" has two physical outputs (main_l_out, main_r_out) sharing one
  // bus -- the non-wizard case of multiple physical outputs pooling into
  // one bus correction.
  const bus = config.buses.find((b) => b.id === 'mains');
  const physicalOutputs = config.physicalOutputs.filter((o) => o.sourceBusId === 'mains');
  return { ...config, buses: [bus], physicalOutputs };
}

function fakeWing({ injectionSucceeds = false } = {}) {
  const calls = { injected: [], restored: [] };
  return {
    calls,
    soloOutput: async () => {},
    unmuteAll: async () => {},
    injectTestSignal: async (po) => {
      if (!injectionSucceeds) throw new Error('not confirmed');
      calls.injected.push(po.id);
    },
    restorePatch: async (po) => { calls.restored.push(po.id); return true; },
    restoreAllPatches: () => calls.injected.slice(),
    hasPendingPatches: () => false,
    applyTuning: async () => {}
  };
}

function collectEvents() {
  const log = [];
  return { log, emit: (event, payload) => log.push({ event, payload }) };
}

/** Drive one full wizard round (instruct/confirm x3: driver A, driver B,
 *  combined) with "yes, heard it" at every confirm step. */
async function driveWizardToCompletion(session) {
  for (let i = 0; i < 3; i++) {
    await session.wizardContinue();
    await session.wizardConfirm(true);
  }
}

/* ------------------------------ wizard trigger ------------------------------ */

test('a shared-driver physical output puts the session into wizard state instead of an automatic sweep', async () => {
  const audio = { playAndCapture: async () => cleanCapture(20) };
  const { log, emit } = collectEvents();
  const session = newSession({ config: sharedOutputConfig(), room: miniRoom, audio, wing: fakeWing(), emit });

  session.start('full');
  const readyPromise = session.ready();
  await Promise.resolve(); // let ready() run up to the wizard's suspend point
  await Promise.resolve();

  assert.equal(session.state, 'wizard');
  assert.ok(session.wizard, 'wizard state should be populated');
  assert.equal(session.wizard.physicalOutputId, 'side_fills_out');
  assert.equal(session.wizard.driverIndex, 0);
  assert.equal(session.wizard.step, 'instruct');

  await driveWizardToCompletion(session);
  await readyPromise;
});

test('non-shared physical outputs never enter wizard state', async () => {
  const audio = { playAndCapture: async () => cleanCapture(20) };
  const bus = config.buses.find((b) => b.id === 'sub');
  const physicalOutput = config.physicalOutputs.find((o) => o.id === 'sub_out');
  const cfg = { ...config, buses: [bus], physicalOutputs: [physicalOutput] };
  const session = newSession({ config: cfg, room: miniRoom, audio, wing: fakeWing(), emit: () => {} });

  session.start('full');
  await session.ready();

  assert.equal(session.wizard, null);
  assert.equal(session.results.length, 1);
});

/* ------------------------------ wizard step logic ---------------------------- */

test('wizardConfirm(false) replays instructions instead of advancing', async () => {
  const audio = { playAndCapture: async () => cleanCapture(20) };
  const session = newSession({ config: sharedOutputConfig(), room: miniRoom, audio, wing: fakeWing(), emit: () => {} });
  session.start('full');
  const readyPromise = session.ready();
  await Promise.resolve(); await Promise.resolve();

  await session.wizardContinue();
  assert.equal(session.wizard.step, 'confirm');
  await session.wizardConfirm(false);
  assert.equal(session.wizard.step, 'instruct', '"No" should return to the instruction step');
  assert.equal(session.wizard.driverIndex, 0, 'driver index must not advance on "No"');

  await driveWizardToCompletion(session);
  await readyPromise;
});

test('the two individual-driver sweeps are excluded from results (never fed into bus correction), only the combined sweep counts', async () => {
  const audio = { playAndCapture: async () => cleanCapture(20) };
  const session = newSession({ config: sharedOutputConfig(), room: miniRoom, audio, wing: fakeWing(), emit: () => {} });
  session.start('full');
  const readyPromise = session.ready();
  await Promise.resolve(); await Promise.resolve();
  await driveWizardToCompletion(session);
  await readyPromise;

  assert.equal(session.results.length, 1, 'only the combined sweep feeds correction');
  assert.equal(session.results[0].driverVariant, 'combined');
  assert.equal(session.results[0].outputId, 'side_fills', 'tagged with the BUS id');
  assert.equal(session.driverHealthResults.length, 2, 'both individual sweeps kept for health comparison');
  assert.deepEqual(session.driverHealthResults.map((r) => r.driverVariant).sort(), ['Side L', 'Side R']);
});

/* ------------------------------ driver health ---------------------------- */

test('checkDriverHealth flags a level mismatch between the two individual drivers', async () => {
  // Call sequence per wizard round: blipL, sweepL, blipR, sweepR, blipCombined,
  // sweepCombined -- only sweepL (index 1) and sweepR (index 3) matter for
  // the health comparison; blips are discarded, so their gain is irrelevant.
  let call = 0;
  const gains = [0.4, 0.4, 0.4, 0.02, 0.4, 0.4];
  const audio = { playAndCapture: async () => cleanCapture(20, gains[call++] ?? 0.4) };
  const { log, emit } = collectEvents();
  const session = newSession({ config: sharedOutputConfig(), room: miniRoom, audio, wing: fakeWing(), emit });
  session.start('full');
  const readyPromise = session.ready();
  await Promise.resolve(); await Promise.resolve();
  await driveWizardToCompletion(session);
  await readyPromise;

  assert.equal(session.driverHealthReports.length, 1);
  const report = session.driverHealthReports[0];
  assert.ok(report.flags.some((f) => /level differs/.test(f)), `expected a level flag, got: ${report.flags.join('; ')}`);
  assert.ok(log.some((e) => e.event === 'warning' && /driver health/.test(e.payload.message)));
});

test('checkDriverHealth flags a polarity mismatch between the two individual drivers', async () => {
  let call = 0;
  const signs = [1, 1, 1, -1, 1, 1]; // flip only sweepR (index 3)
  const audio = { playAndCapture: async () => cleanCapture(20, 0.4, signs[call++] ?? 1) };
  const session = newSession({ config: sharedOutputConfig(), room: miniRoom, audio, wing: fakeWing(), emit: () => {} });
  session.start('full');
  const readyPromise = session.ready();
  await Promise.resolve(); await Promise.resolve();
  await driveWizardToCompletion(session);
  await readyPromise;

  const report = session.driverHealthReports[0];
  assert.ok(report.flags.some((f) => /polarity mismatch/.test(f)));
});

test('checkDriverHealth reports no flags (and an info, not a warning) when both drivers match', async () => {
  const audio = { playAndCapture: async () => cleanCapture(20, 0.4, 1) };
  const { log, emit } = collectEvents();
  const session = newSession({ config: sharedOutputConfig(), room: miniRoom, audio, wing: fakeWing(), emit });
  session.start('full');
  const readyPromise = session.ready();
  await Promise.resolve(); await Promise.resolve();
  await driveWizardToCompletion(session);
  await readyPromise;

  const report = session.driverHealthReports[0];
  assert.deepEqual(report.flags, []);
  assert.ok(log.some((e) => e.event === 'info' && /driver health OK/.test(e.payload.message)));
});

test('buildRecommendations includes driverHealth in its output', async () => {
  const audio = { playAndCapture: async () => cleanCapture(20, 0.4, 1) };
  const session = newSession({ config: sharedOutputConfig(), room: miniRoom, audio, wing: fakeWing(), emit: () => {} });
  session.start('full');
  const readyPromise = session.ready();
  await Promise.resolve(); await Promise.resolve();
  await driveWizardToCompletion(session);
  await readyPromise;

  const rec = session.buildRecommendations();
  assert.ok(rec.driverHealth?.length === 1);
  assert.ok(rec.perOutput.side_fills, 'the bus should still get a correction entry from the combined sweep');
});

/* -------------------------- bus pooling across physical outputs -------------- */

test('a bus with two physical outputs (stereo mains) pools both into one correction entry', async () => {
  const audio = { playAndCapture: async () => cleanCapture(20) };
  const session = newSession({ config: twoOutputBusConfig(), room: miniRoom, audio, wing: fakeWing(), emit: () => {} });
  session.start('full');
  await session.ready();

  assert.equal(session.results.length, 2, 'one result per physical output');
  assert.ok(session.results.every((r) => r.outputId === 'mains'), 'both tagged with the shared bus id');

  const rec = session.buildRecommendations();
  assert.equal(Object.keys(rec.perOutput).length, 1, 'exactly one correction entry for the bus, not two');
  assert.ok(rec.perOutput.mains);
  assert.equal(rec.perOutput.mains.positions.length, 2, 'the overlay carries both physical outputs\' curves');
});

/* ------------------------------ injection integration ------------------------ */

test('measureOnePhysicalOutput calls injectTestSignal then restorePatch when injection succeeds', async () => {
  const audio = { playAndCapture: async () => cleanCapture(20) };
  const bus = config.buses.find((b) => b.id === 'sub');
  const physicalOutput = config.physicalOutputs.find((o) => o.id === 'sub_out');
  const cfg = { ...config, buses: [bus], physicalOutputs: [physicalOutput] };
  const wing = fakeWing({ injectionSucceeds: true });
  const session = newSession({ config: cfg, room: miniRoom, audio, wing, emit: () => {} });

  session.start('full');
  await session.ready();

  assert.deepEqual(wing.calls.injected, ['sub_out']);
  assert.deepEqual(wing.calls.restored, ['sub_out']);
});

test('measurement proceeds via normal bus routing (no restore attempted) when injection is unavailable', async () => {
  const audio = { playAndCapture: async () => cleanCapture(20) };
  const bus = config.buses.find((b) => b.id === 'sub');
  const physicalOutput = config.physicalOutputs.find((o) => o.id === 'sub_out');
  const cfg = { ...config, buses: [bus], physicalOutputs: [physicalOutput] };
  const wing = fakeWing({ injectionSucceeds: false });
  const { log, emit } = collectEvents();
  const session = newSession({ config: cfg, room: miniRoom, audio, wing, emit });

  session.start('full');
  await session.ready();

  assert.deepEqual(wing.calls.injected, []);
  assert.deepEqual(wing.calls.restored, [], 'never restore what was never injected');
  assert.equal(session.results.length, 1, 'measurement still completes via the fallback path');
  assert.ok(log.some((e) => e.event === 'info' && /injection unavailable/.test(e.payload.message)));
});

/* ------------------------------ restoreAllPatches ----------------------------- */

test('session.restoreAllPatches() delegates to wing.restoreAllPatches() and reports the count', () => {
  const wing = fakeWing();
  wing.calls.injected = ['side_fills_out'];
  const { log, emit } = collectEvents();
  const session = newSession({ config: sharedOutputConfig(), room: miniRoom, audio: {}, wing, emit });

  const restored = session.restoreAllPatches();
  assert.deepEqual(restored, ['side_fills_out']);
  assert.ok(log.some((e) => e.event === 'info' && /Restored 1 patch/.test(e.payload.message)));
});

/* ------------------------- standalone driver isolation test ------------------------- */
// testSharedDriverIsolation() is the SAME wizard state machine
// (runSharedDriverWizard/wizardContinue/wizardConfirm) entered directly
// instead of nested inside ready()'s per-position loop -- these tests cover
// its own entry/exit (guards, cleanup back to idle), not the wizard step
// logic itself, which the tests above already cover thoroughly.

test('testSharedDriverIsolation runs the same wizard standalone and returns to idle (not "measuring") when done', async () => {
  const audio = { playAndCapture: async () => cleanCapture(20) };
  const session = newSession({ config: sharedOutputConfig(), room: miniRoom, audio, wing: fakeWing(), emit: () => {} });

  const testPromise = session.testSharedDriverIsolation('side_fills_out');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(session.state, 'wizard');
  assert.equal(session.wizard.physicalOutputId, 'side_fills_out');

  await driveWizardToCompletion(session);
  await testPromise;

  assert.equal(session.state, 'idle', 'standalone entry point resets to idle -- there is no surrounding ready() loop to leave it "measuring" for');
  assert.equal(session.driverHealthReports.length, 1);
});

test('testSharedDriverIsolation uses room.verifyPosition, falling back to the first position when unset', async () => {
  const audio = { playAndCapture: async () => cleanCapture(20) };
  const roomNoVerify = { ...miniRoom, verifyPosition: 'not_a_real_id' };
  const session = newSession({ config: sharedOutputConfig(), room: roomNoVerify, audio, wing: fakeWing(), emit: () => {} });

  const testPromise = session.testSharedDriverIsolation('side_fills_out');
  await Promise.resolve(); await Promise.resolve();
  assert.equal(session.wizard.pos.id, 'p1', 'falls back to the first room position');

  await driveWizardToCompletion(session);
  await testPromise;
});

test('testSharedDriverIsolation throws for an unknown physical output id', async () => {
  const session = newSession({ config: sharedOutputConfig(), room: miniRoom, audio: {}, wing: fakeWing(), emit: () => {} });
  await assert.rejects(() => session.testSharedDriverIsolation('not_a_real_output'), /not found/);
});

test('testSharedDriverIsolation throws for an output that is not actually a shared driver', async () => {
  const bus = config.buses.find((b) => b.id === 'sub');
  const physicalOutput = config.physicalOutputs.find((o) => o.id === 'sub_out');
  const cfg = { ...config, buses: [bus], physicalOutputs: [physicalOutput] };
  const session = newSession({ config: cfg, room: miniRoom, audio: {}, wing: fakeWing(), emit: () => {} });
  await assert.rejects(() => session.testSharedDriverIsolation('sub_out'), /not a shared-driver output/);
});

test('testSharedDriverIsolation refuses to run while a session is already in progress', async () => {
  const audio = { playAndCapture: async () => cleanCapture(20) };
  const session = newSession({ config: sharedOutputConfig(), room: miniRoom, audio, wing: fakeWing(), emit: () => {} });
  session.start('verify'); // state -> waiting_position
  await assert.rejects(() => session.testSharedDriverIsolation('side_fills_out'), /cannot test driver isolation while a session is running/);
});
