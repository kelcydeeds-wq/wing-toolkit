#!/usr/bin/env node
// record-osc.mjs — capture all incoming Wing OSC traffic to a timestamped
// JSONL file, and replay a recording back through the mock transport for
// development without a live console.
//
// Recording: `npm run record` (or this script directly) subscribes to every
// incoming OSC message and appends one JSON line per message to
// data/osc-recordings/<timestamp>.jsonl. Runs until Ctrl+C.
//
// Replay: `node scripts/record-osc.mjs --replay <file> --mock` feeds a
// recording back through the mock transport at (roughly) its original
// timing via replayRecording() in src/wing/osc.js -- lets other tools or UI
// work be driven by real captured traffic instead of synthetic data.
//
// Usage:
//   node scripts/record-osc.mjs [--host <ip>] [--port <n>] [--out <file>]
//   node scripts/record-osc.mjs --replay <file> [--mock] [--speed <n>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeOscTransport, replayRecording } from '../src/wing/osc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export function parseArgs(argv) {
  const args = { mock: false, speed: 1 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') args.mock = true;
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--replay') args.replay = argv[++i];
    else if (a === '--speed') args.speed = Number(argv[++i]);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/record-osc.mjs [--host <ip>] [--port <n>] [--out <file>]
      Record all incoming Wing OSC traffic to a JSONL file. Runs until Ctrl+C.
      --host/--port override config/default.json's wing.host/wing.port.
      --out defaults to data/osc-recordings/<timestamp>.jsonl.

  node scripts/record-osc.mjs --replay <file> [--mock] [--speed <n>]
      Replay a recording through the transport (--mock for the in-memory
      mock console) at <n>x its original speed (default 1x).
`);
}

function defaultOutPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(root, 'data/osc-recordings', `${stamp}.jsonl`);
}

/** Read a .jsonl recording into an array of {t, address, args}. */
export function loadRecording(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * Record all traffic on `transport` to `outPath` until `signal` aborts (or,
 * with no signal, until Ctrl+C). Returns { outPath, count } once stopped.
 */
export async function recordFromTransport(transport, outPath, { signal, log = console.log } = {}) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const out = fs.createWriteStream(outPath, { flags: 'a' });

  const startedAt = Date.now();
  let count = 0;
  const unsub = transport.subscribe(/.*/, (values, address) => {
    out.write(JSON.stringify({ t: Date.now() - startedAt, address, args: values }) + '\n');
    count++;
  });

  log(`Recording -> ${outPath}`);
  if (!signal) log('Press Ctrl+C to stop.');

  await new Promise((resolve) => {
    const stop = () => resolve();
    if (signal) {
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', stop, { once: true });
    } else {
      process.once('SIGINT', stop);
    }
  });

  unsub();
  await new Promise((resolve) => out.end(resolve));
  log(`Stopped. ${count} message(s) recorded to ${outPath}`);
  return { outPath, count };
}

export async function recordOsc(args, { signal } = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/default.json'), 'utf8'));
  const wingCfg = { host: args.host || config.wing?.host, port: args.port || config.wing?.port };
  const transport = makeOscTransport({ mode: args.mock ? 'mock' : 'live', wing: wingCfg });
  await transport.ready;

  console.log(`Recording ${args.mock ? '[MOCK]' : `from ${wingCfg.host}:${wingCfg.port}`}`);
  const outPath = path.resolve(args.out || defaultOutPath());
  const result = await recordFromTransport(transport, outPath, { signal });
  transport.close();
  return result;
}

export async function replayFile(filePath, args) {
  const records = loadRecording(filePath);
  const transport = makeOscTransport({ mode: args.mock ? 'mock' : 'live', wing: args });
  await transport.ready;
  console.log(`Replaying ${records.length} message(s) from ${filePath} at ${args.speed}x`);
  await replayRecording(transport, records, {
    speedMultiplier: args.speed,
    onEvent: (rec, i, total) => console.log(`  [${i + 1}/${total}] ${rec.address} ${JSON.stringify(rec.args)}`)
  });
  transport.close();
  console.log('Replay complete.');
  return { count: records.length };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const run = args.replay ? replayFile(args.replay, args) : recordOsc(args);
  run.then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
}
