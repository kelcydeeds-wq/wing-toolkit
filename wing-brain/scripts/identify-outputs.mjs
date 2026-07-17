#!/usr/bin/env node
// identify-outputs.mjs — quick read-only confirmation of which Wing main/mtx
// number is which physical output. config/default.json's outputs all carry
// "TODO: confirm at audit" on their wing.num -- this is the fast targeted
// check for that, instead of running (and reading through) the full
// dump-wing-state.mjs capture just to answer "which number is Main L?"
//
// Usage:
//   node scripts/identify-outputs.mjs --host 192.168.1.50
//   node scripts/identify-outputs.mjs --mock

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { makeOscTransport } from '../src/wing/osc.js';
import { MAIN_COUNT, MATRIX_COUNT, mainStrip, matrixStrip, readValue, readName, physicalOutputPatchFields } from './wing-schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const DEFAULT_PROBE_GRPS = ['A', 'B', 'C', 'D'];
const DEFAULT_PROBE_NUMS = [1, 2, 3, 4, 5, 6, 7, 8];

export function parseArgs(argv) {
  const args = { mock: false, timeoutMs: 800, matrixCount: MATRIX_COUNT, probeIoOut: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') args.mock = true;
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--timeout') args.timeoutMs = Number(argv[++i]);
    else if (a === '--matrix-count') args.matrixCount = Number(argv[++i]);
    else if (a === '--probe-io-out') args.probeIoOut = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/identify-outputs.mjs [options]

  Read-only. Queries name + mute for every main (1-${MAIN_COUNT}) and matrix
  (1-N) on the console and prints a table, so you can match config/default.json's
  buses[].wing.num TODOs against what the console actually calls them.

  --host <ip>         Wing console IP (default: config/default.json's wing.host).
  --port <n>          Wing OSC port (default: config/default.json's wing.port).
  --mock              Use the in-memory mock console instead of a real Wing.
  --timeout <ms>      Per-address query timeout (default 800).
  --matrix-count <n>  How many matrix numbers to probe (default ${MATRIX_COUNT} --
                       matrix count itself is TODO(church), unconfirmed).
  --probe-io-out      ALSO best-effort probe /io/out/<grp>/<n>/conn/grp+in for
                       grp A-D, n 1-8 -- physicalOutputPatchFields()'s address
                       family is an UNCONFIRMED GUESS (see wing-schema.mjs). A
                       reply here doesn't prove the guess right, but silence
                       across all of them is a strong signal the shape is wrong
                       and needs to come from the console's own OSC docs/menus
                       instead of guessing further.
`);
}

/** Best-effort, clearly-speculative probe of the physical-output patch
 *  address family. Returns only the combos that answered SOMETHING --
 *  silence elsewhere is just silence, not evidence of anything. */
export async function probePhysicalOutputPatches(transport, {
  grps = DEFAULT_PROBE_GRPS, nums = DEFAULT_PROBE_NUMS, timeoutMs = 800
} = {}) {
  const hits = [];
  for (const grp of grps) {
    for (const num of nums) {
      const fields = physicalOutputPatchFields(grp, num);
      const [srcGrp, srcIn] = await Promise.all([
        transport.get(fields.sourceGrp, { timeoutMs }),
        transport.get(fields.sourceIn, { timeoutMs })
      ]);
      if (srcGrp !== null || srcIn !== null) {
        hits.push({ grp, num, sourceGrp: readValue(srcGrp), sourceIn: readValue(srcIn) });
      }
    }
  }
  return hits;
}

/** Query name+mute for one strip. Pure I/O, no formatting — kept separate so
 *  the table-building logic below is testable without a transport. */
async function queryStrip(transport, strip, timeoutMs) {
  const [name, mute] = await Promise.all([
    transport.get(strip.name, { timeoutMs }),
    transport.get(strip.mute, { timeoutMs })
  ]);
  return {
    kind: strip.kind, index: strip.index,
    // readName (not readValue): a name is the string arg, and an un-named /
    // unanswered strip must resolve to null, never a fabricated fallback.
    name: readName(name),
    mute: readValue(mute)
  };
}

export function formatTable(rows) {
  const lines = ['KIND     #   NAME                          MUTE', '-'.repeat(50)];
  for (const r of rows) {
    const kind = r.kind.padEnd(8);
    const idx = String(r.index).padEnd(3);
    const name = (r.name ?? '(no reply)').toString().padEnd(30);
    const mute = r.mute === null || r.mute === undefined ? '?' : (r.mute ? 'muted' : 'live');
    lines.push(`${kind} ${idx} ${name} ${mute}`);
  }
  return lines.join('\n');
}

export async function identifyOutputs(args) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/default.json'), 'utf8'));
  const wingCfg = { host: args.host || config.wing?.host, port: args.port || config.wing?.port };
  const transport = makeOscTransport({ mode: args.mock ? 'mock' : 'live', wing: wingCfg });
  if (args.mock) seedMockOutputs(transport);
  await transport.ready;

  const strips = [
    ...Array.from({ length: MAIN_COUNT }, (_, i) => mainStrip(i + 1)),
    ...Array.from({ length: args.matrixCount }, (_, i) => matrixStrip(i + 1))
  ];
  const rows = [];
  for (const strip of strips) rows.push(await queryStrip(transport, strip, args.timeoutMs));

  let ioOutHits = null;
  if (args.probeIoOut) ioOutHits = await probePhysicalOutputPatches(transport, { timeoutMs: args.timeoutMs });

  transport.close();
  return { rows, table: formatTable(rows), ioOutHits };
}

/** Mock seed for --mock / tests. Seeds ONLY mute states -- deliberately NO
 *  names. Mock mode has no real console names, and fabricating example names
 *  ("Main L", "Side Fills") would train the operator to trust text that never
 *  came from hardware, so the mock name column stays empty ("(no reply)") on
 *  purpose. See the no-fabricated-names rule in src/wing/console-names.js. */
export function seedMockOutputs(transport) {
  const set = (address, value) => transport.send(address, [value]);
  set('/main/1/mute', 0);
  set('/main/2/mute', 0);
  set('/main/3/mute', 0);
  set('/main/4/mute', 1);
  set('/mtx/1/mute', 0);
  set('/mtx/2/mute', 0);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  identifyOutputs(parseArgs(process.argv.slice(2)))
    .then(({ table, ioOutHits }) => {
      console.log(table);
      console.log('\nMatch these against config/default.json buses[].wing.num, then update the TODOs.');
      if (ioOutHits) {
        console.log('\n--- /io/out probe (UNCONFIRMED address family -- see wing-schema.mjs) ---');
        if (!ioOutHits.length) {
          console.log('No replies from any grp/num combo tried. The guessed address shape is likely wrong --');
          console.log('check the console\'s own OSC documentation/menus for the real I/O patch addressing.');
        } else {
          for (const h of ioOutHits) console.log(`  grp ${h.grp} num ${h.num}: sourceGrp=${h.sourceGrp} sourceIn=${h.sourceIn}`);
        }
      }
    })
    .catch((err) => { console.error(err); process.exit(1); });
}
