// Smoke test for the settings API against the RUNNING dev server (mock mode).
// Not part of `npm test` — it needs a live server and briefly rewrites the
// real config files (restoring them afterwards, even on failure).
//
// Usage: npm run dev, then from wing-brain/:  node scripts/smoke-settings.mjs
//
// Exercises: GET config, valid save (+ ws broadcast + disk write + runtime
// rebuild), invalid save (400), busy-session save (409), test-wing (mock),
// test-wing live timeout, room patch rules, and replace:true restore.
import WebSocket from 'ws';
import fs from 'node:fs';

const B = 'http://localhost:3000';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };

const j = async (res) => ({ status: res.status, body: await res.json() });
const post = (url, body) => fetch(B + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(j);

const originalFile = fs.readFileSync('config/default.json', 'utf8');

// Watch ws for the config broadcast
const ws = new WebSocket('ws://localhost:3000');
let sawConfigBroadcast = false;
let broadcastHost = null;
await new Promise((r) => ws.on('open', r));
ws.on('message', (raw) => {
  const { event, payload } = JSON.parse(raw);
  if (event === 'config' && payload.config.wing.host === '10.9.8.7') {
    sawConfigBroadcast = true;
    broadcastHost = payload.config.wing.host;
  }
});

try {
  // 1. GET
  const got = await j(await fetch(B + '/api/config'));
  check('GET /api/config returns config + room', got.status === 200 && !!got.body.config && !!got.body.room);
  const originalHost = got.body.config.wing.host;

  // 2. Valid save
  const saved = await post('/api/config', { config: { wing: { host: '10.9.8.7' } } });
  check('POST valid patch → 200 ok', saved.status === 200 && saved.body.ok === true);
  const onDisk = JSON.parse(fs.readFileSync('config/default.json', 'utf8'));
  check('patch persisted to disk', onDisk.wing.host === '10.9.8.7');
  check('untouched sibling (wing.port) survived merge', onDisk.wing.port === got.body.config.wing.port);
  await new Promise((r) => setTimeout(r, 300));
  check('ws config broadcast received', sawConfigBroadcast, `host=${broadcastHost}`);

  // 3. Invalid save → 400 with path-specific errors
  const bad = await post('/api/config', { config: { wing: { port: 99999 }, audio: { sweep: { levelDbfs: 0 } } } });
  check('POST invalid patch → 400', bad.status === 400);
  check('errors are path-specific', (bad.body.errors || []).some((e) => /wing\.port/.test(e)) && (bad.body.errors || []).some((e) => /levelDbfs/.test(e)),
    (bad.body.errors || []).join(' | '));
  check('invalid patch not persisted', JSON.parse(fs.readFileSync('config/default.json', 'utf8')).wing.port !== 99999);

  // 4. Busy session → 409
  ws.send(JSON.stringify({ action: 'start', mode: 'verify' })); // -> waiting_position
  await new Promise((r) => setTimeout(r, 300));
  const busy = await post('/api/config', { config: { wing: { host: '1.1.1.1' } } });
  check('POST during session → 409', busy.status === 409, busy.body.error);
  ws.send(JSON.stringify({ action: 'reset' }));
  await new Promise((r) => setTimeout(r, 200));

  // 5. test-wing in mock mode
  const tw = await post('/api/test-wing', {});
  check('test-wing (mock) → always connected', tw.status === 200 && tw.body.ok && tw.body.mock);

  // 6. test-wing live against a dead address → graceful timeout, not a hang
  const t0 = Date.now();
  const twLive = await post('/api/test-wing', { mode: 'live', host: '127.0.0.1', port: 39999 });
  check('test-wing (live, dead target) → ok:false timeout', twLive.status === 200 && twLive.body.ok === false, `${Date.now() - t0}ms`);

  // 7. Room patch
  const roomSave = await post('/api/config', { room: { verifyPosition: 'p1' } });
  check('room verifyPosition save → 200', roomSave.status === 200 && roomSave.body.room.verifyPosition === 'p1');
  const badRoom = await post('/api/config', { room: { verifyPosition: 'nope' } });
  check('bad verifyPosition → 400', badRoom.status === 400);
  const badRoomKeys = await post('/api/config', { room: { width: 30 } });
  check('room geometry via API → 400', badRoomKeys.status === 400);
} finally {
  // Restore original config + room via the API (also proves replace:true), then verify.
  const orig = JSON.parse(originalFile);
  await post('/api/config', { config: orig, replace: true });
  await post('/api/config', { room: { verifyPosition: 'p4' } });
  const restored = JSON.parse(fs.readFileSync('config/default.json', 'utf8'));
  check('original config restored via replace:true', restored.wing.host === orig.wing.host);
  ws.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
