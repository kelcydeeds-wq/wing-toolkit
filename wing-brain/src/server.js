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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// .env holds ANTHROPIC_API_KEY on the brain box; absent in fresh clones.
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const CONFIG_PATH = path.join(root, 'config/default.json');
const ROOM_PATH = path.join(root, 'config/room.json');

let config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
if (process.env.MODE) config.mode = process.env.MODE; // boot-time override only (npm run dev forces mock)
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
let audio, wing, session;
function buildRuntime() {
  try { wing?.close?.(); } catch { /* old transport may already be gone */ }
  audio = makeAudioIO(config);
  wing = makeWing(config);
  session = new TuneSession({ config, room, audio, wing, emit: broadcast });
}
buildRuntime();

/** True when saving settings would destroy in-flight work. */
function sessionBusy() {
  return ['waiting_position', 'measuring', 'preflight', 'review'].includes(session.state);
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
    const errors = validateConfig(nextConfig);
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
    const candidates = ['/?', '/xinfo', '/info', '/main/lr/config/name'];
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

/* ------------------------------- WebSocket ------------------------------- */

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ event: 'config', payload: { config, room } }));
  ws.send(JSON.stringify({ event: 'session', payload: session.snapshot() }));
  ws.send(JSON.stringify({ event: 'room', payload: room }));
  ws.send(JSON.stringify({ event: 'sessionHistory', payload: listSessionHistory() }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      switch (msg.action) {
        case 'start':     session.start(msg.mode); break;         // mode: 'verify' | 'full'
        case 'preflight': await session.preflightCheck(); break;
        case 'ready':    await session.ready(); break;
        case 'retake':   session.retake(); break;
        case 'apply':    await session.apply(); break;            // the only console write
        case 'baseline': session.saveBaseline(); break;
        case 'reset':    session.state = 'idle'; broadcast('session', session.snapshot()); break;
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
});
