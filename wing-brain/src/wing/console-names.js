// console-names.js — read scribble-strip names for mains / matrices / buses
// off the Wing, in one timeout-safe pass.
//
// This is the single source the routing picker (and the read-console-names
// diagnostic) get destination names from. It exists so that what the UI shows
// is ALWAYS exactly what the console returned:
//
//   * MOCK MODE RETURNS NO NAMES, EVER. There is no seeded/example/placeholder
//     name here or anywhere it feeds. A mock read resolves every entry to null
//     with mock:true, so the UI shows bare designations ("MTX 6") plus a
//     "console names unavailable" note -- it must never train the operator to
//     trust text that didn't come from hardware.
//   * A LIVE READ THAT GETS NO REPLY FAILS LOUDLY. `ok` is false when the
//     console answered nothing, so the UI can show "couldn't read console
//     names -- Refresh" rather than silently presenting an empty/stale state
//     as if it were real.
//
// Address shapes and the name parser live in scripts/wing-schema.mjs
// (nameAddress/readName) so a corrected address is a one-file edit.

import { makeOscTransport } from './osc.js';
import {
  MAIN_COUNT, MATRIX_COUNT, BUS_COUNT,
  nameAddress, readName, wingDesignation
} from '../../scripts/wing-schema.mjs';

// The destination kinds a routing picker can reach, in display order. Counts
// come from wing-schema (some still TODO(church)-unconfirmed); reading a few
// extra numbers that don't exist just yields nulls, which is harmless.
export const NAME_KINDS = [
  { kind: 'main', label: 'Main',   count: MAIN_COUNT },
  { kind: 'mtx',  label: 'Matrix', count: MATRIX_COUNT },
  { kind: 'bus',  label: 'Bus',    count: BUS_COUNT }
];

/** Empty (all-null) entries map — the shape every result carries, so callers
 *  never have to special-case "no names read yet". */
function emptyEntries() {
  const entries = {};
  for (const { kind, count } of NAME_KINDS) {
    entries[kind] = {};
    for (let n = 1; n <= count; n++) entries[kind][n] = null;
  }
  return entries;
}

async function mapWithConcurrency(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/**
 * Read every main/mtx/bus name in one pass.
 *
 * Returns:
 *   {
 *     readAt: ISO string,          // when this read completed
 *     mock: boolean,               // true => names are unavailable by definition
 *     ok: boolean,                 // live: did the console answer anything at all
 *     answered: number,            // count of addresses that replied (non-null)
 *     total: number,               // count of addresses queried
 *     entries: { main:{1:name|null,...}, mtx:{...}, bus:{...} }
 *   }
 *
 * `entries[kind][n]` is a clean console-supplied string, or null (no name /
 * un-named strip / no reply). Never a fabricated value.
 *
 * @param {object}  opts
 * @param {boolean} opts.mock       mock mode -> short-circuit to all-null, no I/O
 * @param {string}  opts.host       Wing host (live only)
 * @param {number}  opts.port       Wing OSC port (live only)
 * @param {number}  [opts.timeoutMs=800]
 * @param {number}  [opts.concurrency=16]
 * @param {object}  [opts.transport] inject a transport (tests); not closed here
 */
export async function readConsoleNames({
  mock = false, host, port, timeoutMs = 800, concurrency = 16, transport
} = {}) {
  const entries = emptyEntries();
  const total = NAME_KINDS.reduce((sum, k) => sum + k.count, 0);

  // Mock: there are no console names. Do not touch a transport, do not seed --
  // return the empty (all-null) shape flagged mock so the UI says so.
  if (mock) {
    return { readAt: new Date().toISOString(), mock: true, ok: true, answered: 0, total, entries };
  }

  const ownTransport = !transport;
  const t = transport || makeOscTransport({ mode: 'live', wing: { host, port } });
  let answered = 0;
  try {
    await t.ready;
    const tasks = [];
    for (const { kind, count } of NAME_KINDS) {
      for (let n = 1; n <= count; n++) tasks.push({ kind, n });
    }
    await mapWithConcurrency(tasks, concurrency, async ({ kind, n }) => {
      const reply = await t.get(nameAddress(kind, n), { timeoutMs });
      if (reply !== null && reply !== undefined) answered++;
      entries[kind][n] = readName(reply);
    });
  } finally {
    if (ownTransport) t.close();
  }

  return { readAt: new Date().toISOString(), mock: false, ok: answered > 0, answered, total, entries };
}

/** Flatten a result into display rows for the diagnostic table / picker.
 *  Each row: { kind, index, designation, name }. `name` is null when un-named. */
export function nameRows(result) {
  const rows = [];
  for (const { kind, count } of NAME_KINDS) {
    for (let n = 1; n <= count; n++) {
      rows.push({ kind, index: n, designation: wingDesignation(kind, n), name: result.entries[kind]?.[n] ?? null });
    }
  }
  return rows;
}
