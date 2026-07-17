#!/usr/bin/env node
// read-console-names.mjs — dump every main/matrix/bus scribble-strip name the
// console reports, in one pass. This is the 30-second verification tool for
// the name-read addresses: /main/N/name is confirmed, but /mtx/N/name and
// /bus/N/name FOLLOW the confirmed /ch/N/name pattern WITHOUT being live-
// verified yet (see scripts/wing-schema.mjs). Run this at the console:
//
//   * If the main/mtx/bus rows show the names on the Wing's surface, the
//     address shapes are correct -- update CLAUDE.md's confirmed list.
//   * If a whole KIND (e.g. every BUS row) comes back "(no reply)", that
//     kind's address shape is probably wrong -- fix nameAddress() in
//     wing-schema.mjs (the one place) from the console's own OSC docs, don't
//     guess further.
//
// Read-only. Every query is timeout-safe (never hangs). Mock mode prints no
// names on purpose -- the console names are genuinely unavailable there.
//
// Usage:
//   node scripts/read-console-names.mjs --mock
//   node scripts/read-console-names.mjs --host 192.168.25.80 --port 2223

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readConsoleNames, nameRows, NAME_KINDS } from '../src/wing/console-names.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

export function parseArgs(argv) {
  const args = { mock: false, timeoutMs: 800 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') args.mock = true;
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--timeout') args.timeoutMs = Number(argv[++i]);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/read-console-names.mjs [options]

  Reads and prints main/matrix/bus scribble-strip names in one pass, so the
  name-read address shapes can be verified at the console in ~30 seconds.

  --host <ip>      Wing console IP (default: config/default.json's wing.host).
  --port <n>       Wing OSC port (default: config/default.json's wing.port).
  --mock           Use the in-memory mock console (prints NO names by design).
  --timeout <ms>   Per-address query timeout (default 800).
`);
}

export function formatNameTable(result) {
  const lines = ['KIND    DESIGNATION   NAME', '-'.repeat(44)];
  for (const row of nameRows(result)) {
    const kind = row.kind.padEnd(6);
    const desig = row.designation.padEnd(12);
    const name = row.name === null ? '(no reply / un-named)' : row.name;
    lines.push(`${kind}  ${desig}  ${name}`);
  }
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/default.json'), 'utf8'));
  const host = args.host || config.wing?.host;
  const port = args.port || config.wing?.port;

  const result = await readConsoleNames({ mock: args.mock, host, port, timeoutMs: args.timeoutMs });
  console.log(`\nConsole names ${args.mock ? '[MOCK]' : `from ${host}:${port}`}  (read ${result.readAt})\n`);
  console.log(formatNameTable(result));

  if (result.mock) {
    console.log('\nMOCK — console names are unavailable. This is correct: nothing here is a real name.');
  } else if (!result.ok) {
    console.log(`\n⚠ The console answered NONE of ${result.total} name addresses.`);
    console.log('  Either it is unreachable (check IP/port/OSC enabled) OR the address shapes are wrong.');
  } else {
    console.log(`\n${result.answered}/${result.total} addresses answered.`);
    const silentKinds = NAME_KINDS.filter(({ kind }) =>
      Object.values(result.entries[kind]).every((v) => v === null));
    for (const { kind, label } of silentKinds) {
      console.log(`  Note: every ${label} came back empty — if the Wing surface shows ${label} names,`);
      console.log(`        nameAddress('${kind}', …) in scripts/wing-schema.mjs likely has the wrong shape.`);
    }
    console.log('\nIf these match the console surface, mark /main|/mtx|/bus name addresses confirmed in CLAUDE.md.');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
