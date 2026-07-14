#!/usr/bin/env node
// dump-wing-state.mjs — full state audit of the Wing console over OSC.
//
// Walks channels 1-40, aux/group buses, mains, matrices, DCAs, and (best
// effort) custom/user keys, reading name, patch/source, gain, HPF, EQ,
// dynamics, mutes, fader, bus sends, and main/matrix assigns for each.
// Writes one timestamped JSON file.
//
// Every read goes through the shared OSC transport's get(), which times out
// to `null` instead of hanging (see src/wing/osc.js) -- an address this
// script guessed wrong just shows up as `null` in the dump instead of
// stalling the whole audit. TODO(church): confirm the address scheme in
// scripts/wing-schema.mjs against the real console and re-run.
//
// Usage:
//   node scripts/dump-wing-state.mjs --mock
//   node scripts/dump-wing-state.mjs --host 192.168.1.50 --port 2223
//
// See --help for all flags.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeOscTransport } from '../src/wing/osc.js';
import {
  CHANNEL_COUNT, BUS_COUNT, MAIN_COUNT, MATRIX_COUNT, DCA_COUNT,
  channelStrip, busStrip, mainStrip, matrixStrip, dcaStrip, userKeyStrip,
  leafAddresses, ioInputFields, readValue
} from './wing-schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const USER_KEY_COUNT = 12; // TODO(church): confirm -- see wing-schema.mjs userKeyStrip note

export function parseArgs(argv) {
  const args = { mock: false, timeoutMs: 800, concurrency: 16 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') args.mock = true;
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--timeout') args.timeoutMs = Number(argv[++i]);
    else if (a === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/dump-wing-state.mjs [options]

  --mock            Use the in-memory mock console (no real Wing needed),
                     seeded with a realistic fake patch so downstream tools
                     (plan-remap, apply-remap) have something real to chew on.
  --host <ip>       Override config/default.json's wing.host.
  --port <n>        Override config/default.json's wing.port.
  --out <file>       Output path (default: data/wing-state/<timestamp>.json).
  --timeout <ms>    Per-address query timeout (default 800). Every read is
                    timeout-safe -- an unanswered address becomes null, it
                    never hangs the dump.
  --concurrency <n> Parallel in-flight queries (default 16).
`);
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

function buildStrips() {
  return [
    ...Array.from({ length: CHANNEL_COUNT }, (_, i) => channelStrip(i + 1)),
    ...Array.from({ length: BUS_COUNT }, (_, i) => busStrip(i + 1)),
    ...Array.from({ length: MAIN_COUNT }, (_, i) => mainStrip(i + 1)),
    ...Array.from({ length: MATRIX_COUNT }, (_, i) => matrixStrip(i + 1)),
    ...Array.from({ length: DCA_COUNT }, (_, i) => dcaStrip(i + 1)),
    ...Array.from({ length: USER_KEY_COUNT }, (_, i) => userKeyStrip(i + 1))
  ];
}

/**
 * Channel gain isn't a channel address -- it lives on the physically patched
 * input. For every channel whose sourceGrp/sourceIn answered, build and
 * query the /io/in/<grp>/<in>/... addresses and merge the results into that
 * channel's values map. Second pass because it depends on the first pass's
 * results.
 */
async function captureChannelGains(transport, results, { timeoutMs, concurrency }) {
  const tasks = [];
  for (const strip of results) {
    if (strip.kind !== 'channel') continue;
    const grp = readValue(strip.values[`${strip.path}/in/conn/grp`]);
    const inNum = readValue(strip.values[`${strip.path}/in/conn/in`]);
    if (grp === null || grp === undefined || inNum === null || inNum === undefined) continue;
    const io = ioInputFields(grp, inNum);
    tasks.push({ strip, io });
  }
  await mapWithConcurrency(tasks, concurrency, async ({ strip, io }) => {
    strip.values[io.gain] = await transport.get(io.gain, { timeoutMs });
    strip.values[io.phantomInvert] = await transport.get(io.phantomInvert, { timeoutMs });
  });
  return tasks.length;
}

/** Query every address across every strip with bounded concurrency. */
async function captureAll(transport, strips, { timeoutMs, concurrency }, onProgress) {
  const perStripValues = new Map(strips.map((s) => [s, {}]));
  const tasks = [];
  for (const strip of strips) {
    for (const address of leafAddresses(strip)) tasks.push({ strip, address });
  }

  let done = 0;
  await mapWithConcurrency(tasks, concurrency, async ({ strip, address }) => {
    perStripValues.get(strip)[address] = await transport.get(address, { timeoutMs });
    done++;
    if (onProgress && (done % 200 === 0 || done === tasks.length)) onProgress(done, tasks.length);
  });

  return strips.map((strip) => ({
    kind: strip.kind, index: strip.index, path: strip.path,
    values: perStripValues.get(strip)
  }));
}

/**
 * Seed the mock console with a plausible, partially-organized "before" state
 * -- a few named channels scattered across the range, a couple of DCA/mute
 * group assignments and bus sends, one channel ("Vox FX Return" at 30) that
 * doesn't match config/target-layout.json's slot for it (24). Gives
 * plan-remap.mjs real moves to compute instead of an empty diff.
 */
export function seedMockConsole(transport) {
  const set = (address, value) => transport.send(address, [value]);

  const namedChannels = {
    1: 'Pastor Mic', 2: 'Guest Mic',
    6: 'Piano', 7: 'Keys 2',
    11: 'Acoustic Gtr', 12: 'Electric Gtr', 13: 'Bass',
    17: 'Kick', 18: 'Snare', 19: 'Hi-Hat', 20: 'Tom 1', 21: 'Tom 2', 22: 'OH L', 23: 'OH R',
    30: 'Vox FX Return', // TODO(remap): target layout wants this at channel 24
    35: 'Choir Mic 1', 36: 'Choir Mic 2',
    39: 'Oscillator', 40: 'Talkback'
  };
  let slot = 1; // fake physical input slot per named channel, group "A"
  for (const [ch, name] of Object.entries(namedChannels)) {
    set(`/ch/${ch}/name`, name);
    set(`/ch/${ch}/fdr`, -6);
    set(`/ch/${ch}/mute`, 0);
    set(`/ch/${ch}/flt/lc`, 1);
    set(`/ch/${ch}/flt/lcf`, 80);
    // Gain lives on the patched input, not the channel -- patch each named
    // channel to group A, a distinct input slot, then seed that slot's gain.
    set(`/ch/${ch}/in/conn/grp`, 'A');
    set(`/ch/${ch}/in/conn/in`, slot);
    set(`/io/in/A/${slot}/g`, 30 + (Number(ch) % 10));
    slot++;
  }

  // DCA + mute group membership -- a single `tags` string per channel on the
  // real console (#D<k> = DCA k, #M<k> = mute group k). These must move with a
  // channel on remap.
  set('/ch/30/tags', '#D1');         // Vox FX riding DCA 1 today
  set('/ch/1/tags', '#M1');
  set('/ch/2/tags', '#M1');

  // Bus sends -- also downstream references a remap must chase.
  set('/bus/1/name', 'Vox Reverb');
  set('/bus/2/name', 'Drum Monitor');
  set('/ch/1/send/1/on', 1); set('/ch/1/send/1/lvl', -10);
  set('/ch/30/send/1/on', 1); set('/ch/30/send/1/lvl', -8);
  set('/ch/17/send/2/on', 1); set('/ch/17/send/2/lvl', -4);

  set('/main/1/name', 'Main L');
  set('/main/1/fdr', 0);
  set('/main/1/mute', 0);
  set('/main/2/name', 'Main R');
  set('/main/2/fdr', 0);
  set('/main/2/mute', 0);

  set('/dca/1/name', 'Vox FX');
  set('/dca/2/name', 'Band');
}

function defaultOutPath(mock) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(root, 'data/wing-state', `${stamp}${mock ? '__mock' : ''}.json`);
}

export async function dumpWingState(args) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/default.json'), 'utf8'));
  const wingCfg = {
    host: args.host || config.wing?.host,
    port: args.port || config.wing?.port
  };
  const transport = makeOscTransport({ mode: args.mock ? 'mock' : 'live', wing: wingCfg });
  if (args.mock) seedMockConsole(transport);
  await transport.ready;

  console.log(`Dumping Wing state ${args.mock ? '[MOCK]' : `from ${wingCfg.host}:${wingCfg.port}`}...`);
  const strips = buildStrips();
  const results = await captureAll(transport, strips, args, (done, total) => {
    process.stdout.write(`\r  ${done}/${total} addresses queried`);
  });
  process.stdout.write('\n');

  const gainTasks = await captureChannelGains(transport, results, args);
  if (gainTasks) console.log(`  queried input gain for ${gainTasks} patched channel(s) via /io/in/<grp>/<in>`);
  transport.close();

  const dump = {
    meta: {
      capturedAt: new Date().toISOString(),
      source: args.mock ? 'mock' : `${wingCfg.host}:${wingCfg.port}`,
      mock: !!args.mock,
      timeoutMs: args.timeoutMs,
      counts: { channels: CHANNEL_COUNT, buses: BUS_COUNT, matrices: MATRIX_COUNT, dcas: DCA_COUNT }
    },
    channels: results.filter((r) => r.kind === 'channel'),
    buses: results.filter((r) => r.kind === 'bus'),
    mains: results.filter((r) => r.kind === 'main'),
    matrices: results.filter((r) => r.kind === 'matrix'),
    dcas: results.filter((r) => r.kind === 'dca'),
    userKeys: results.filter((r) => r.kind === 'userKey')
  };

  const outPath = path.resolve(args.out || defaultOutPath(args.mock));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(dump, null, 2));

  const allValues = results.flatMap((r) => Object.values(r.values));
  const answered = allValues.filter((v) => v !== null).length;
  console.log(`Wrote ${outPath}`);
  console.log(`${answered}/${allValues.length} addresses answered` +
    (args.mock ? '' : ' (unanswered = unconfirmed/unused address, see TODO(church) in scripts/wing-schema.mjs)'));

  return { outPath, dump };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  dumpWingState(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
