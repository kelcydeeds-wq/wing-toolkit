#!/usr/bin/env node
// apply-remap.mjs — execute a plan-remap.mjs remap.json over OSC.
//
// For every changed move: read the source channel's full current parameter
// set live, write it to the destination channel (copying settings, repatching
// the input source, and renaming), re-apply its DCA/mute-group/bus-send
// references at the new channel number, then read every written address back
// and compare. The first verify mismatch ABORTS the remaining moves --
// already-applied moves before it are not rolled back, but nothing further
// is written until a human looks at it.
//
// SAFE BY DEFAULT: dry-run unless --execute is passed. Dry-run still reads
// the source channel's current values (so the preview is real), it just
// never writes or verifies.
//
// Addresses this reads/writes (see wing-schema.mjs) are confirmed against the
// official Wing OSC spec, except DCA/mute-group membership, which is still
// TODO(church) -- unconfirmed. Run this against --mock first, then try
// --execute on one low-risk channel against the real console before
// trusting it for a full plan.
//
// Usage:
//   node scripts/apply-remap.mjs --remap <plan.json> --mock
//   node scripts/apply-remap.mjs --remap <plan.json> --execute
//   node scripts/apply-remap.mjs --remap <plan.json> --execute --clear-source

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeOscTransport } from '../src/wing/osc.js';
import { channelStrip, leafAddresses, readValue } from './wing-schema.mjs';
import { seedMockConsole } from './dump-wing-state.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export function parseArgs(argv) {
  const args = { execute: false, mock: false, timeoutMs: 800, clearSource: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--remap') args.remap = argv[++i];
    else if (a === '--execute') args.execute = true;
    else if (a === '--mock') args.mock = true;
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--timeout') args.timeoutMs = Number(argv[++i]);
    else if (a === '--clear-source') args.clearSource = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/apply-remap.mjs --remap <file> [options]

  --remap <file>   remap.json produced by plan-remap.mjs (required).
  --execute        Actually write to the console. Without this flag the
                    script only reads current values and prints what it
                    would do -- nothing is written. DEFAULT: dry-run.
  --mock           Use the in-memory mock console instead of a real Wing.
  --host/--port    Override config/default.json's wing.host/port.
  --timeout <ms>   Per-address query timeout (default 800).
  --clear-source   After a channel is copied and verified, also mute and
                    blank the name at the OLD channel number. Off by
                    default -- a move only touches the destination unless
                    you explicitly ask for the source to be cleared too.
`);
}

function tolerantEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-3;
  return false;
}

function retarget(address, fromIndex, toIndex) {
  return address.replace(`/ch/${fromIndex}/`, `/ch/${toIndex}/`);
}

/** Read every schema address of a channel. Returns {address: value|null}. */
async function readChannel(transport, index, timeoutMs) {
  const addresses = leafAddresses(channelStrip(index));
  const values = {};
  for (const address of addresses) values[address] = await transport.get(address, { timeoutMs });
  return values;
}

/**
 * Copy one move (source channel's current settings -> destination channel),
 * dry-run or executed. Always logs via `log`. Returns a result record with
 * `status`: 'dry-run' | 'applied' | 'verify-failed'.
 */
export async function copyChannel(transport, move, { execute, timeoutMs, clearSource, log = () => {} }) {
  const { from, to, name, references } = move;
  log(`\n${execute ? 'EXECUTE' : 'DRY-RUN'}: ch${from} "${name}" -> ch${to}`);

  const sourceValues = await readChannel(transport, from, timeoutMs);
  const answered = Object.entries(sourceValues).filter(([, v]) => v !== null);
  log(`  read ${answered.length}/${Object.keys(sourceValues).length} source parameters` +
    (answered.length < Object.keys(sourceValues).length ? ' (rest unanswered -- unconfirmed address or genuinely unset, skipped)' : ''));

  const writes = answered.map(([addr, v]) => ({ address: retarget(addr, from, to), value: v }));
  // Force the name explicitly even if the name address itself didn't answer.
  if (!writes.some((w) => w.address === `/ch/${to}/name`)) {
    writes.push({ address: `/ch/${to}/name`, value: [name] });
  }

  if (!execute) {
    log(`  would write ${writes.length} parameter(s) to ch${to}`);
    describeReferences(references, log, 'would assign');
    return { from, to, name, status: 'dry-run', writeCount: writes.length };
  }

  for (const w of writes) transport.send(w.address, [readValue(w.value)]);
  for (const dca of references?.dca || []) transport.send(`/ch/${to}/grp/dca/${dca}`, [1]);
  for (const grp of references?.muteGroups || []) transport.send(`/ch/${to}/grp/mute/${grp}`, [1]);
  for (const s of references?.sends || []) {
    transport.send(`/ch/${to}/send/${s.bus}/on`, [1]);
    if (s.level !== null && s.level !== undefined) transport.send(`/ch/${to}/send/${s.bus}/lvl`, [s.level]);
  }
  log(`  wrote ${writes.length} parameter(s), verifying...`);

  const mismatches = [];
  for (const w of writes) {
    const readback = await transport.get(w.address, { timeoutMs });
    const expected = readValue(w.value);
    const got = readback === null ? null : readValue(readback);
    const ok = readback !== null && tolerantEqual(got, expected);
    if (!ok) mismatches.push({ address: w.address, expected, got });
  }

  if (mismatches.length) {
    log(`  VERIFY FAILED on ${mismatches.length} address(es):`);
    for (const m of mismatches.slice(0, 5)) log(`    ${m.address}: expected ${JSON.stringify(m.expected)}, got ${JSON.stringify(m.got)}`);
    return { from, to, name, status: 'verify-failed', mismatches, writeCount: writes.length };
  }
  log(`  verified OK (${writes.length}/${writes.length})`);
  describeReferences(references, log, 'assigned');

  if (clearSource) {
    log(`  clearing source ch${from} (mute + blank name)`);
    transport.send(`/ch/${from}/name`, ['']);
    transport.send(`/ch/${from}/mute`, [1]);
  }

  return { from, to, name, status: 'applied', writeCount: writes.length };
}

function describeReferences(references, log, verb) {
  if (!references) return;
  if (references.dca?.length) log(`  ${verb} DCA ${references.dca.join(',')}`);
  if (references.muteGroups?.length) log(`  ${verb} mute group ${references.muteGroups.join(',')}`);
  if (references.sends?.length) log(`  ${verb} sends: ${references.sends.map((s) => `bus ${s.bus}@${s.level}dB`).join(', ')}`);
  if (references.userKeys?.length) {
    log(`  NOTE: user key(s) ${references.userKeys.join(',')} reference this channel — targets are NOT rewritten automatically, update by hand`);
  }
}

/**
 * Execute (or dry-run) every changed move in a remap plan, in order, stopping
 * at the first verify failure. `opts.transportOverride` lets tests inject a
 * fake transport instead of a real/mock OSC connection.
 */
export async function applyRemap(args, { transportOverride } = {}) {
  const remapPath = path.resolve(args.remap);
  const remap = JSON.parse(fs.readFileSync(remapPath, 'utf8'));
  const moves = remap.moves.filter((m) => m.changed);

  if (!moves.length) {
    console.log('No moves to apply — plan is a no-op.');
    return { results: [], aborted: false };
  }

  let transport = transportOverride;
  let wingCfg = null;
  if (!transport) {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'config/default.json'), 'utf8'));
    wingCfg = { host: args.host || config.wing?.host, port: args.port || config.wing?.port };
    transport = makeOscTransport({ mode: args.mock ? 'mock' : 'live', wing: wingCfg });
    // A --mock run is a fresh in-memory console with nothing on it -- seed
    // the same "before" state dump-wing-state.mjs --mock uses, so a
    // dump -> plan -> apply --mock chain has real settings to copy instead
    // of every source read coming back null.
    if (args.mock) seedMockConsole(transport);
    await transport.ready;
  }

  console.log(`${args.execute ? 'EXECUTING' : 'DRY RUN'} ${moves.length} channel move(s)` +
    (args.mock ? ' [MOCK]' : wingCfg ? ` against ${wingCfg.host}:${wingCfg.port}` : ''));
  if (!args.execute) console.log('(pass --execute to actually write to the console)');

  const results = [];
  let aborted = false;
  for (const move of moves) {
    const result = await copyChannel(transport, move, {
      execute: args.execute, timeoutMs: args.timeoutMs, clearSource: args.clearSource, log: console.log
    });
    results.push(result);
    if (result.status === 'verify-failed') {
      console.error(`\nABORTING remaining moves — ch${move.from}->ch${move.to} failed verification. ` +
        `Fix and re-run; moves applied before this one are NOT rolled back.`);
      aborted = true;
      break;
    }
  }

  if (!transportOverride) transport.close();
  return { results, aborted };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.remap) {
    console.error('Missing required --remap <file>');
    printHelp();
    process.exit(1);
  }
  applyRemap(args)
    .then(({ aborted }) => process.exit(aborted ? 1 : 0))
    .catch((err) => { console.error(err); process.exit(1); });
}
