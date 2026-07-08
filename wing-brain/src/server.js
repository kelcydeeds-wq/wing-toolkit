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
import { TuneSession } from './tune/session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// .env holds ANTHROPIC_API_KEY on the brain box; absent in fresh clones.
try { process.loadEnvFile(path.join(root, '.env')); } catch {}

const config = JSON.parse(fs.readFileSync(path.join(root, 'config/default.json'), 'utf8'));
if (process.env.MODE) config.mode = process.env.MODE;
const room = JSON.parse(fs.readFileSync(path.join(root, 'config/room.json'), 'utf8'));

const audio = makeAudioIO(config);
const wing = makeWing(config);

const app = express();
app.use(express.json());
app.use(express.static(path.join(root, 'public')));

// Export the last analysis payload — paste it into Claude (chat or Claude Code)
// for a manual tune before the API key is set up on the brain box.
app.get('/analysis.json', (_req, res) => {
  if (!session.lastAnalysisPayload) return res.status(404).json({ error: 'run a Full Tune first' });
  res.json(session.lastAnalysisPayload);
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(event, payload) {
  const msg = JSON.stringify({ event, payload });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(msg);
  }
}

const session = new TuneSession({ config, room, audio, wing, emit: broadcast });

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ event: 'session', payload: session.snapshot() }));
  ws.send(JSON.stringify({ event: 'room', payload: room }));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      switch (msg.action) {
        case 'start':    session.start(msg.mode); break;          // mode: 'verify' | 'full'
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
