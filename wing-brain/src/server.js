// server.js — HTTP + WebSocket host for the tune UI.
// Phone and touchscreen are both just browsers pointed at this box.

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { makeAudioIO } from './audio/io.js';
import { makeWing } from './wing/client.js';
import { makeOscTransport } from './wing/osc.js';
import { TuneSession, listSessionHistory } from './tune/session.js';
import { validateConfig, validateRoomPatch, mergeDeep, writeJsonAtomic } from './config/settings.js';
import { LoudnessMonitor, listLoudnessHistory, computeSplOffset } from './audio/loudness-monitor.js';
import { readConsoleNames } from './wing/console-names.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// .env holds ANTHROPIC_API_KEY on the brain box; absent in fresh clones.
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const CONFIG_PATH = path.join(root, 'config/default.json');
const ROOM_PATH = path.join(root, 'config/room.json');

let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
if (process.env.MODE) config.mode = process.env.MODE; // boot-time override only (npm run dev forces mock)
if (process.env.PORT) config.server.port = Number(process.env.PORT); // boot-time override (e.g. a second test instance)
let room = JSON.parse(fs.readFileSync(ROOM_PATH, 'utf8'));

const app = express();
app.use(express.json());
app.use(express.static(path.join(root, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(event, payload) {
  const msg = JSON.stringify({ event, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

/* ------------------------- runtime (rebuildable) ------------------------- */

// audio/wing/session are recreated whenever settings are saved — no server
// restart. Everything that touches them reads these variables at call time.
// The loudness monitor is deliberately separate from `session` — it must
// keep running through tune sessions, mode changes, everything.
let audio, wing, session, loudness;
// Cached per-session console name read (mains/matrices/buses). Never
// auto-refreshed (no polling) -- lazily filled on first request, then only on
// an explicit "Refresh from console" tap. Invalidated on every buildRuntime()
// because a mode/host change makes the previous read meaningless.
let consoleNames = null;
function buildRuntime() {
  try { wing?.close?.(); } catch { /* old transport may already be gone */ }
  try { loudness?.stop?.(); } catch { /* best effort */ }
  audio = makeAudioIO(config);
  wing = makeWing(config);
  session = new TuneSession({ config, room, audio, wing, emit: broadcast });
  loudness = new LoudnessMonitor({ config, room, emit: broadcast });
  loudness.start();
  consoleNames = null; // stale once mode/host may have changed
}
buildRuntime();

/** Read every main/mtx/bus scribble name off the console, cache it, and push
 *  it to all clients. The single place a name read happens on the server --
 *  what it returns is exactly what the console said (mock => no names). */
async function refreshConsoleNames() {
  consoleNames = await readConsoleNames({
    mock: config.mode === 'mock', host: config.wing.host, port: config.wing.port, timeoutMs: 800
  });
  broadcast('consoleNames', consoleNames);
  return consoleNames;
}

/** True when saving settings would destroy in-flight work. */
function sessionBusy() {
  return ['waiting_position', 'measuring', 'preflight', 'review', 'routing_test'].includes(session.state);
}

/* ------------------------------- HTTP API -------------------------------- */

// Export the last analysis payload — paste it into Claude (chat or Claude Code)
// for a manual tune before the API key is set up on the brain box.
app.get('/analysis.json', (_req, res) => {
  if (!session.lastAnalysisPayload) return res.status(404).json({ error: 'run a Full Tune first' });
  res.json(session.lastAnalysisPayload);
});

// Session history — last N full/verify sessions (see data/sessions/), for the
// phone UI's history list and the review screen's download-results button.
app.get('/api/sessions', (_req, res) => {
  res.json(listSessionHistory());
});

const SESSION_ID_RE = /^[0-9A-Za-z_-]+$/; // our own generated ids only — blocks path traversal
app.get('/api/sessions/:id', (req, res) => {
  if (!SESSION_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid session id' });
  const file = path.join(root, 'data/sessions', `${req.params.id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
  res.download(file, `${req.params.id}.json`);
});

/* ---------------------------- Loudness monitor ---------------------------- */

// Recent loudness records (see data/loudness/) — average/peak/time-in-status
// per monitored stretch, for the Monday-report summary card. Independent of
// tune session history.
app.get('/api/loudness/history', (_req, res) => {
  res.json(listLoudnessHistory());
});

// One-time calibration: operator stands at the reference position with an
// SPL meter, reads it, and POSTs that reading. We compare it against the
// monitor's current (uncalibrated) dBFS reading and save the offset.
app.post('/api/loudness/calibrate', (req, res) => {
  const { splMeterReadingDb } = req.body || {};
  if (typeof splMeterReadingDb !== 'number' || !Number.isFinite(splMeterReadingDb)) {
    return res.status(400).json({ error: 'splMeterReadingDb: must be a number' });
  }
  const dbfs = loudness.currentDbfs();
  if (dbfs === null || !Number.isFinite(dbfs)) {
    return res.status(409).json({ error: 'no loudness reading yet — wait a few seconds for the monitor to warm up and retry' });
  }
  const offsetDb = computeSplOffset(dbfs, splMeterReadingDb);
  const nextConfig = mergeDeep(config, { audio: { splDbOffset: offsetDb } });
  const errors = validateConfig(nextConfig, room);
  if (errors.length) return res.status(400).json({ error: 'validation failed', errors });

  writeJsonAtomic(CONFIG_PATH, nextConfig);
  config = nextConfig;
  buildRuntime();
  broadcast('config', { config, room });
  res.json({ ok: true, offsetDb: Math.round(offsetDb * 10) / 10, measuredDbfs: Math.round(dbfs * 10) / 10, config });
});

// Console scribble-strip names (mains/matrices/buses) for the routing picker.
// GET returns the per-session cache, lazily doing the FIRST read if nothing is
// cached yet (so opening the picker "just works"); it never re-reads a live
// console on its own after that. POST /refresh forces a fresh read -- the only
// thing that re-hits the console, i.e. the manual "Refresh from console" tap.
// Read-only. What comes back is exactly what the console reported; mock mode
// returns no names at all (see src/wing/console-names.js).
app.get('/api/console-names', async (_req, res) => {
  try {
    if (!consoleNames) await refreshConsoleNames();
    res.json(consoleNames);
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

app.post('/api/console-names/refresh', async (_req, res) => {
  try {
    res.json(await refreshConsoleNames());
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

/* ------------------------------ Patch safety ------------------------------ */

// "Restore All Patches" escape hatch (routing model section 2) — works
// regardless of session state, reads straight off the on-disk snapshot.
app.get('/api/patches/status', (_req, res) => {
  res.json({ pending: wing.hasPendingPatches ? wing.hasPendingPatches() : false });
});

app.post('/api/patches/restore-all', (_req, res) => {
  const restored = session.restoreAllPatches();
  res.json({ ok: true, restored });
});

/* ------------------------------ Settings API ----------------------------- */

app.get('/api/config', (_req, res) => {
  res.json({ config, room });
});

app.post('/api/config', (req, res) => {
  if (sessionBusy()) {
    return res.status(409).json({
      error: `a session is ${session.state} — finish, apply, or discard it before changing settings`
    });
  }
  const { config: cfgPatch, room: roomPatch, replace } = req.body || {};
  if (!cfgPatch && !roomPatch) return res.status(400).json({ error: 'empty update — send {config} and/or {room}' });

  let nextConfig = config;
  if (cfgPatch) {
    // replace:true = the raw-JSON escape hatch, where deletions must stick;
    // a merge can only add/overwrite keys, never remove them.
    nextConfig = replace ? cfgPatch : mergeDeep(config, cfgPatch);
    const errors = validateConfig(nextConfig, room);
    if (errors.length) return res.status(400).json({ error: 'validation failed', errors });
  }

  let nextRoom = room;
  if (roomPatch) {
    const errors = validateRoomPatch(roomPatch, room);
    if (errors.length) return res.status(400).json({ error: 'validation failed', errors });
    nextRoom = { ...room, verifyPosition: roomPatch.verifyPosition };
  }

  // Validation passed — persist atomically, then rebuild the runtime.
  if (cfgPatch) writeJsonAtomic(CONFIG_PATH, nextConfig);
  if (roomPatch) writeJsonAtomic(ROOM_PATH, nextRoom);
  config = nextConfig;
  room = nextRoom;
  buildRuntime();

  broadcast('config', { config, room });
  broadcast('room', room);
  broadcast('session', session.snapshot());
  res.json({ ok: true, config, room });
});

/* ------------------------- Visual editor API (Stage 1) -------------------- */
// Backend persistence for the interactive speaker/output editor. Stages 2-5
// (canvas dragging, add/remove UI, settings panels, Wing-discovery tie-in)
// are separate follow-up work — this is only the REST surface they call.
// Every write here follows the exact same guard/validate/write/rebuild/
// broadcast shape as POST /api/config above.

function busyResponse(res) {
  return res.status(409).json({
    error: `a session is ${session.state} — finish, apply, or discard it before changing settings`
  });
}

/** Validate + persist a full next `config`, mirroring POST /api/config. */
function commitConfig(nextConfig, res) {
  const errors = validateConfig(nextConfig, room);
  if (errors.length) return res.status(400).json({ error: 'validation failed', errors });
  writeJsonAtomic(CONFIG_PATH, nextConfig);
  config = nextConfig;
  buildRuntime();
  broadcast('config', { config, room });
  broadcast('room', room);
  broadcast('session', session.snapshot());
  res.json({ ok: true, config, room });
}

/** Validate + persist a full next `room`, via a room-patch-shaped object so
 *  it goes through the same validateRoomPatch rules as POST /api/config. */
function commitRoomPatch(patch, nextRoomFull, res) {
  const errors = validateRoomPatch(patch, room);
  if (errors.length) return res.status(400).json({ error: 'validation failed', errors });
  writeJsonAtomic(ROOM_PATH, nextRoomFull);
  room = nextRoomFull;
  buildRuntime();
  broadcast('config', { config, room });
  broadcast('room', room);
  broadcast('session', session.snapshot());
  res.json({ ok: true, config, room });
}

// --- Buses (config.buses[]) ---

app.put('/api/buses/:id', (req, res) => {
  if (sessionBusy()) return busyResponse(res);
  const id = req.params.id;
  const body = { ...(req.body || {}), id };
  const nextBuses = config.buses.some((b) => b.id === id)
    ? config.buses.map((b) => (b.id === id ? body : b))
    : [...config.buses, body];
  commitConfig({ ...config, buses: nextBuses }, res);
});

app.delete('/api/buses/:id', (req, res) => {
  if (sessionBusy()) return busyResponse(res);
  const id = req.params.id;
  const referencing = config.physicalOutputs.filter((o) => o.sourceBusId === id).map((o) => o.id);
  if (referencing.length) {
    return res.status(409).json({
      error: `bus "${id}" is still referenced by physicalOutputs: ${referencing.join(', ')} — repoint or delete them first`
    });
  }
  const nextBuses = config.buses.filter((b) => b.id !== id);
  commitConfig({ ...config, buses: nextBuses }, res);
});

// --- Physical outputs (config.physicalOutputs[]) ---

app.put('/api/outputs/:id', (req, res) => {
  if (sessionBusy()) return busyResponse(res);
  const id = req.params.id;
  const body = { ...(req.body || {}), id };
  const nextOutputs = config.physicalOutputs.some((o) => o.id === id)
    ? config.physicalOutputs.map((o) => (o.id === id ? body : o))
    : [...config.physicalOutputs, body];
  commitConfig({ ...config, physicalOutputs: nextOutputs }, res);
});

app.delete('/api/outputs/:id', (req, res) => {
  if (sessionBusy()) return busyResponse(res);
  const id = req.params.id;
  const nextOutputs = config.physicalOutputs.filter((o) => o.id !== id);
  commitConfig({ ...config, physicalOutputs: nextOutputs }, res);
});

// --- Speakers (room.speakers[]) ---

app.put('/api/speakers/:id', (req, res) => {
  if (sessionBusy()) return busyResponse(res);
  const id = req.params.id;
  const body = { ...(req.body || {}), id };
  const nextSpeakers = room.speakers.some((s) => s.id === id)
    ? room.speakers.map((s) => (s.id === id ? body : s))
    : [...room.speakers, body];
  commitRoomPatch({ speakers: nextSpeakers }, { ...room, speakers: nextSpeakers }, res);
});

app.delete('/api/speakers/:id', (req, res) => {
  if (sessionBusy()) return busyResponse(res);
  const id = req.params.id;
  const reasons = [];
  for (const o of config.physicalOutputs) {
    if (o.speakerId === id) reasons.push(o.id);
    for (const d of o.sharedDrivers?.drivers || []) {
      if (d.speakerId === id) reasons.push(`${o.id} (sharedDrivers: "${d.label}")`);
    }
  }
  if (reasons.length) {
    return res.status(409).json({
      error: `speaker "${id}" is still referenced by physicalOutputs: ${reasons.join(', ')} — repoint or delete them first`
    });
  }
  const nextSpeakers = room.speakers.filter((s) => s.id !== id);
  commitRoomPatch({ speakers: nextSpeakers }, { ...room, speakers: nextSpeakers }, res);
});

// --- Measurement positions (room.positions[]) ---

app.put('/api/positions/:id', (req, res) => {
  if (sessionBusy()) return busyResponse(res);
  const id = req.params.id;
  const body = { ...(req.body || {}), id };
  const nextPositions = room.positions.some((p) => p.id === id)
    ? room.positions.map((p) => (p.id === id ? body : p))
    : [...room.positions, body];
  commitRoomPatch({ positions: nextPositions }, { ...room, positions: nextPositions }, res);
});

app.delete('/api/positions/:id', (req, res) => {
  if (sessionBusy()) return busyResponse(res);
  const id = req.params.id;
  const reasons = [];
  if (room.verifyPosition === id) reasons.push('room.verifyPosition');
  if (config.loudnessMonitor?.referencePositionId === id) reasons.push('config.loudnessMonitor.referencePositionId');
  for (const b of config.buses) {
    if (Array.isArray(b.alignPositions) && b.alignPositions.includes(id)) {
      reasons.push(`config.buses.${b.id}.alignPositions`);
    }
  }
  if (reasons.length) {
    return res.status(409).json({ error: `position "${id}" is still referenced by: ${reasons.join(', ')}` });
  }
  const nextPositions = room.positions.filter((p) => p.id !== id);
  commitRoomPatch({ positions: nextPositions }, { ...room, positions: nextPositions }, res);
});

// Harmless connectivity probe. Accepts optional {host, port, mode} so the
// settings page can test values BEFORE saving them.
app.post('/api/test-wing', async (req, res) => {
  const { host, port, mode } = req.body || {};
  const effMode = mode || config.mode;
  if (effMode === 'mock') {
    return res.json({ ok: true, mock: true, message: 'mock — always connected' });
  }
  const target = { host: host || config.wing.host, port: port || config.wing.port };
  const transport = makeOscTransport({ mode: 'live', wing: target });
  try {
    await transport.ready;
    // TODO(church): confirm which info/query address the Wing actually
    // answers; until then, try several candidates — any reply proves the
    // console is reachable and speaking OSC.
    const candidates = ['/?', '/xinfo', '/info', '/main/1/name'];
    const replies = await Promise.all(candidates.map((a) => transport.get(a, { timeoutMs: 1500 })));
    const hit = replies.findIndex((r) => r !== null);
    if (hit >= 0) {
      res.json({ ok: true, host: target.host, port: target.port, address: candidates[hit], reply: replies[hit] });
    } else {
      res.json({ ok: false, timeout: true, host: target.host, port: target.port, message: 'no reply from console (timeout) — check IP, port, and that OSC is enabled on the Wing' });
    }
  } catch (err) {
    res.json({ ok: false, error: String(err.message || err) });
  } finally {
    transport.close();
  }
});

/** After apply() writes EQ/delay to the console, persist each bus's
 *  auto-detected proposedBand (piece 1 of crossover handling) to
 *  config.buses[].band -- same consent gate as the EQ filters: the review
 *  screen already showed "proposed vs current" before the operator tapped
 *  Apply, so this is not a hidden write. Goes through the SAME
 *  validateConfig every other config write uses (no separate validation
 *  path), and a validation failure here must never undo/block the console
 *  writes that already succeeded. */
function applyProposedBands() {
  const perOutput = session.recommendations?.perOutput;
  if (!perOutput) return;

  let changed = false;
  const nextConfig = {
    ...config,
    buses: config.buses.map((bus) => {
      const proposed = perOutput[bus.id]?.proposedBand;
      if (!proposed) return bus;
      if (proposed.lo === bus.band[0] && proposed.hi === bus.band[1]) return bus;
      changed = true;
      return { ...bus, band: [proposed.lo, proposed.hi] };
    })
  };
  if (!changed) return;

  const errors = validateConfig(nextConfig, room);
  if (errors.length) {
    console.warn('[server] apply: proposed passband(s) failed validateConfig, band not persisted:', errors);
    return;
  }

  writeJsonAtomic(CONFIG_PATH, nextConfig);
  config = nextConfig;
  buildRuntime();
  broadcast('config', { config, room });
  broadcast('session', session.snapshot());
}

/* ------------------------------- WebSocket ------------------------------- */

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ event: 'config', payload: { config, room } }));
  ws.send(JSON.stringify({ event: 'session', payload: session.snapshot() }));
  ws.send(JSON.stringify({ event: 'room', payload: room }));
  ws.send(JSON.stringify({ event: 'sessionHistory', payload: listSessionHistory() }));
  ws.send(JSON.stringify({ event: 'loudnessHistory', payload: listLoudnessHistory() }));
  const loudnessSnapshot = loudness.snapshot();
  if (loudnessSnapshot) ws.send(JSON.stringify({ event: 'loudness', payload: loudnessSnapshot }));
  if (consoleNames) ws.send(JSON.stringify({ event: 'consoleNames', payload: consoleNames }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      switch (msg.action) {
        case 'start':     session.start(msg.mode); break;         // mode: 'verify' | 'full'
        case 'preflight': await session.preflightCheck(); break;
        case 'summation_check': await session.runSummationCheck(); break;
        case 'ready':    await session.ready(); break;
        case 'retake':   session.retake(); break;
        case 'apply':    await session.apply(); applyProposedBands(); break; // the only console write
        case 'baseline': session.saveBaseline(); break;
        case 'reset':    session.state = 'idle'; broadcast('session', session.snapshot()); break;
        // Shared-driver measurement wizard (routing model section 3).
        case 'wizard_continue': await session.wizardContinue(); break;
        case 'wizard_confirm':  await session.wizardConfirm(!!msg.heard); break;
        // Standalone driver-isolation test -- same wizard, entered directly
        // instead of nested inside a Full Tune's per-position loop.
        case 'test_shared_driver': await session.testSharedDriverIsolation(msg.physicalOutputId); break;
        // Per-speaker routing ground-truth: blip through one output's bus,
        // confirm the mic hears it (routing revamp, Workstream 4).
        case 'test_routing': await session.testRoutingForOutput(msg.physicalOutputId); break;
        // "Restore All Patches" escape hatch — works regardless of session state.
        case 'restore_patches': session.restoreAllPatches(); break;
      }
    } catch (err) {
      ws.send(JSON.stringify({ event: 'error', payload: { message: String(err.message || err) } }));
    }
  });
});

const port = config.server.port;
server.listen(port, () => {
  const nets = os.networkInterfaces();
  const addrs = Object.values(nets).flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => `http://${n.address}:${port}`);
  console.log(`wing-brain tune module [${config.mode.toUpperCase()} mode]`);
  console.log(`  Local:   http://localhost:${port}`);
  for (const a of addrs) console.log(`  Phone:   ${a}`);
  if (wing.hasPendingPatches && wing.hasPendingPatches()) {
    console.warn('[server] WARNING: pending patch snapshot found on disk (data/patch-snapshot.json) — ' +
      'a previous run may have crashed mid-injection. Use "Restore All Patches" in Settings before starting a tune.');
  }
});
