// Tests for console name reading — the correctness-critical foundation of the
// routing revamp. The overriding rule under test: what a name read yields is
// ALWAYS exactly what the console returned, and mock mode fabricates NOTHING.
import { test } from 'node:test';
import assert from 'node:assert';
import { readName, nameAddress, wingDesignation } from '../scripts/wing-schema.mjs';
import { readConsoleNames, nameRows, NAME_KINDS } from '../src/wing/console-names.js';
import { makeOscTransport } from '../src/wing/osc.js';

/* ------------------------------ readName ------------------------------- */

test('readName returns null for no reply / timeout', () => {
  assert.equal(readName(null), null);
  assert.equal(readName(undefined), null);
});

test('readName returns the string arg for a normal name reply', () => {
  assert.equal(readName(['FILL BALCONY']), 'FILL BALCONY');
});

test('readName takes the FIRST (string) arg, never a numeric raw/last element', () => {
  // A multi-element reply must not resolve to the trailing 0 the way readValue
  // would — the name is the string, always the first arg.
  assert.equal(readName(['FILL BALCONY', 0, 0]), 'FILL BALCONY');
});

test('readName treats an empty / whitespace name as null (un-named strip)', () => {
  assert.equal(readName(['']), null);
  assert.equal(readName(['   ']), null);
});

test('readName rejects a non-string first arg (never invents a name from a number)', () => {
  assert.equal(readName([42]), null);
  assert.equal(readName([0, 1, 2]), null);
});

test('readName trims surrounding whitespace', () => {
  assert.equal(readName(['  Main L  ']), 'Main L');
});

/* --------------------------- address builder --------------------------- */

test('nameAddress builds the confirmed /ch pattern for every kind', () => {
  assert.equal(nameAddress('main', 1), '/main/1/name');
  assert.equal(nameAddress('mtx', 6), '/mtx/6/name');
  assert.equal(nameAddress('bus', 16), '/bus/16/name');
  assert.equal(nameAddress('ch', 3), '/ch/3/name');
});

test('nameAddress throws on an unknown kind (fail loud, do not guess)', () => {
  assert.throws(() => nameAddress('dca', 1), /unknown kind/);
});

test('wingDesignation matches the console surface tokens', () => {
  assert.equal(wingDesignation('main', 1), 'MAIN 1');
  assert.equal(wingDesignation('mtx', 6), 'MTX 6');
  assert.equal(wingDesignation('bus', 3), 'BUS 3');
});

/* ----------------------- readConsoleNames: mock ------------------------ */

test('readConsoleNames({mock:true}) fabricates NO names — every entry is null', async () => {
  const result = await readConsoleNames({ mock: true });
  assert.equal(result.mock, true);
  assert.equal(result.answered, 0);
  for (const { kind } of NAME_KINDS) {
    for (const v of Object.values(result.entries[kind])) {
      assert.equal(v, null, `mock entry ${kind} must be null, never a fabricated name`);
    }
  }
});

test('mock short-circuits BEFORE any transport read — a seeded transport cannot leak a name', async () => {
  // Even if a transport is handed in with a "real-looking" seeded name, mock
  // mode must never surface it. This is the hard guarantee: no console read,
  // no name.
  const transport = makeOscTransport({ mode: 'mock' });
  transport.seed('/main/1/name', ['SHOULD NOT APPEAR']);
  const result = await readConsoleNames({ mock: true, transport });
  assert.equal(result.entries.main[1], null);
});

test('nameRows over a mock result yields designations with null names', () => {
  const rows = nameRows({ entries: emptyEntriesFromKinds() });
  assert.ok(rows.length > 0);
  const mtx6 = rows.find((r) => r.kind === 'mtx' && r.index === 6);
  assert.equal(mtx6.designation, 'MTX 6');
  assert.equal(mtx6.name, null);
});

/* ---------------------- readConsoleNames: live path -------------------- */

test('live read surfaces exactly the console-supplied names, others null', async () => {
  const transport = makeOscTransport({ mode: 'mock' }); // stand-in for a live transport
  transport.seed('/mtx/1/name', ['FILL BALCONY']);
  transport.seed('/main/2/name', ['']); // answered, but un-named -> null name
  const result = await readConsoleNames({ mock: false, transport });

  assert.equal(result.mock, false);
  assert.equal(result.entries.mtx[1], 'FILL BALCONY');
  assert.equal(result.entries.main[2], null, 'empty name -> null (bare designation shown)');
  assert.equal(result.entries.main[1], null, 'unseeded -> null');
  // Two addresses replied (the named one + the empty-string one).
  assert.equal(result.answered, 2);
  assert.equal(result.ok, true, 'ok when the console answered at least one address');
});

test('live read with zero replies fails loudly (ok:false) instead of showing an empty state as real', async () => {
  const transport = makeOscTransport({ mode: 'mock' }); // nothing seeded -> all get() return null
  const result = await readConsoleNames({ mock: false, transport });
  assert.equal(result.ok, false);
  assert.equal(result.answered, 0);
  for (const { kind } of NAME_KINDS) {
    for (const v of Object.values(result.entries[kind])) assert.equal(v, null);
  }
});

function emptyEntriesFromKinds() {
  const entries = {};
  for (const { kind, count } of NAME_KINDS) {
    entries[kind] = {};
    for (let n = 1; n <= count; n++) entries[kind][n] = null;
  }
  return entries;
}
