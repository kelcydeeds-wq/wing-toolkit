// wing-schema.mjs — Behringer Wing OSC address map.
//
// Addresses below are confirmed against the official Wing OSC spec (church
// visit 2026-07-10) except where marked TODO(church) -- those sections
// weren't in the source excerpt used to fix this file and are still guesses.
// This file is the single source of truth for "what does a channel/bus/
// main/matrix/DCA strip look like over OSC" so dump/plan/apply-remap and
// the tune feature's LiveWing client never disagree with each other.
//
// Reply shape: the console answers a query with THREE args --
// [displayString, normalizedFloat 0-1, rawValue] -- e.g. /ch/1/mute reads
// back ["1", 1, 1]. Callers that interpret values (not just capture them)
// must not assume a single-element array; see readValue() in
// plan-remap.mjs / apply-remap.mjs.
export const CHANNEL_COUNT = 40;
export const BUS_COUNT = 16;      // TODO(church): confirm aux/group bus count
export const MAIN_COUNT = 4;      // confirmed: /main/1..4, no "lr" bus
export const MATRIX_COUNT = 8;    // TODO(church): confirm matrix count
export const DCA_COUNT = 16;      // TODO(church): confirm DCA count
export const MUTE_GROUP_COUNT = 8; // TODO(church): confirm mute group count
export const EQ_BANDS = 4;        // channel: numbered parametric bands (plus fixed l/h shelf, see below)
export const BUS_EQ_BANDS = 6;    // bus/main/mtx: numbered bands, no l/h shelf

/**
 * Full parameter set for an input channel. Buses, mains, matrices, and DCAs
 * reuse the pieces that apply to them via the shared field-group helpers
 * below rather than duplicating address patterns.
 */
export function channelStrip(n) {
  const p = `/ch/${n}`;
  return {
    kind: 'channel', index: n, path: p,
    name: `${p}/name`,
    col: `${p}/col`,
    // Gain is NOT a channel address -- it lives on the physically patched
    // input. Read these two first, then build the /io/in/<grp>/<in>/...
    // address with ioInputFields() below (see dump-wing-state.mjs's
    // second-pass gain fetch).
    sourceGrp: `${p}/in/conn/grp`,
    sourceIn: `${p}/in/conn/in`,
    ...filterFields(p),
    ...dynamicsFields(p),
    ...channelEqFields(p),
    ...mixFields(p),
    tags: `${p}/tags`,
    sends: sendFields(p, BUS_COUNT),
    mainSends: mainSendFields(p)
  };
}

/** Bus (aux/group) strip — has dynamics/EQ/sends like a channel, no preamp/source/filter. */
export function busStrip(n) {
  const p = `/bus/${n}`;
  return {
    kind: 'bus', index: n, path: p,
    name: `${p}/name`,
    col: `${p}/col`,
    ...dynamicsFields(p),
    ...busEqFields(p),
    ...mixFields(p),
    tags: `${p}/tags`,
    sends: sendFields(p, MATRIX_COUNT) // buses feed matrices, not other buses
  };
}

/** Main strip — numbered 1-4, no "lr". Name/fader/mute/EQ/dynamics; no sends of its own. */
export function mainStrip(n) {
  const p = `/main/${n}`;
  return {
    kind: 'main', index: n, path: p,
    name: `${p}/name`,
    ...dynamicsFields(p),
    ...busEqFields(p),
    fader: `${p}/fdr`,
    mute: `${p}/mute`
  };
}

/** Matrix strip — name/fader/mute/EQ, plus which sources feed it. */
export function matrixStrip(n) {
  const p = `/mtx/${n}`;
  return {
    kind: 'matrix', index: n, path: p,
    name: `${p}/name`,
    ...dynamicsFields(p),
    ...busEqFields(p),
    fader: `${p}/fdr`,
    mute: `${p}/mute`
  };
}

/** DCA — just a name, fader, and mute; no EQ/dynamics/sends. */
export function dcaStrip(n) {
  const p = `/dca/${n}`;
  return {
    kind: 'dca', index: n, path: p,
    name: `${p}/name`,
    fader: `${p}/fdr`,
    mute: `${p}/mute`
  };
}

/**
 * Custom/user-assignable keys. TODO(church): not in the corrected address
 * source -- entirely unconfirmed, left as-is deliberately rather than guessed.
 */
export function userKeyStrip(n) {
  const p = `/$ctl/userkeys/${n}`;
  return {
    kind: 'userKey', index: n, path: p,
    function: `${p}/function`,
    target: `${p}/target`,
    label: `${p}/label`
  };
}

/**
 * A channel's input gain and phantom/invert are addressed by physical input
 * slot, not by channel number -- call this with the grp/in values read from
 * a channel's sourceGrp/sourceIn addresses above.
 */
export function ioInputFields(grp, inNum) {
  const p = `/io/in/${grp}/${inNum}`;
  return { gain: `${p}/g`, phantomInvert: `${p}/vph` };
}

/**
 * Physical output patch source -- which bus/channel feeds this physical
 * output socket. TODO(church): ENTIRELY UNCONFIRMED. Nobody has queried the
 * Wing's I/O patch matrix for physical outputs -- everything fixed on the
 * 2026-07-10 visit covered mixing parameters (fader/mute/EQ/sends), not
 * output patch routing. This is a best-effort guess mirroring the confirmed
 * channel-input pattern (/ch/N/in/conn/grp + /in/conn/in) -- likely wrong in
 * some way (group letter scheme, field names, or the whole shape). Verify
 * against the real console before trusting it for anything beyond mock
 * testing; every caller of this must gate on a `confirmed: true` flag first
 * (see src/wing/patch-manager.js).
 */
export function physicalOutputPatchFields(grp, outNum) {
  const p = `/io/out/${grp}/${outNum}`;
  return { sourceGrp: `${p}/conn/grp`, sourceIn: `${p}/conn/in` };
}

/* ---------------------- shared field-group helpers ---------------------- */

/** Channel-only: high-pass filter. TODO(church): confirmed as "flt", not "preamp/hpf". */
function filterFields(p) {
  return {
    hpfOn: `${p}/flt/lc`,
    hpfFreq: `${p}/flt/lcf`
  };
}

function dynamicsFields(p) {
  return {
    gateOn: `${p}/gate/on`,
    gateThreshold: `${p}/gate/thr`,
    dynOn: `${p}/dyn/on`,
    dynThreshold: `${p}/dyn/thr`,
    dynRatio: `${p}/dyn/ratio`,
    dynAttack: `${p}/dyn/att`,
    dynRelease: `${p}/dyn/rel`
  };
}

function numberedEqBand(p, n) {
  return { band: n, freq: `${p}/eq/${n}f`, gain: `${p}/eq/${n}g`, q: `${p}/eq/${n}q` };
}

/** The "l"/"h" shelf bands carry an extra curve-type param (leq/heq) that
 *  the numbered bands don't have. TODO(church): leq/heq's value meaning
 *  (which curve types map to which numbers) is unconfirmed -- captured but
 *  not interpreted anywhere yet. */
function shelfEqBand(p, letter) {
  return { band: letter, freq: `${p}/eq/${letter}f`, gain: `${p}/eq/${letter}g`, q: `${p}/eq/${letter}q`, type: `${p}/eq/${letter}eq` };
}

/** Channel EQ: 4 numbered parametric bands + fixed low/high shelf. */
function channelEqFields(p) {
  return {
    eqOn: `${p}/eq/on`,
    eq: [
      ...Array.from({ length: EQ_BANDS }, (_, i) => numberedEqBand(p, i + 1)),
      shelfEqBand(p, 'l'),
      shelfEqBand(p, 'h')
    ]
  };
}

/** Bus/main/mtx EQ: fully numbered, no shelf letters. */
function busEqFields(p) {
  return {
    eqOn: `${p}/eq/on`,
    eq: Array.from({ length: BUS_EQ_BANDS }, (_, i) => numberedEqBand(p, i + 1))
  };
}

function mixFields(p) {
  return {
    fader: `${p}/fdr`,
    mute: `${p}/mute`,
    pan: `${p}/pan`
  };
}

// DCA and mute-group membership are NOT per-index boolean addresses (the old
// `/ch/N/grp/dca/K` guess was wrong — every such address timed out on the real
// console). Confirmed at the church 2026-07-14: membership lives in a single
// comma-separated string at `/ch/N/tags` (and `/bus/N/tags`), where `#D<k>` =
// member of DCA k and `#M<k>` = member of mute group k. Other (custom) tags may
// also appear and are preserved. Discovered by node-tree enumeration — querying
// the container `/ch/N` returns its child node names, which is how the real
// address was found. `tags` is exposed as a plain leaf on the channel/bus
// strips, so the dump captures it and apply-remap copies it verbatim; parse it
// with parseTags() below.

/** Parse a Wing `tags` string (e.g. "#D1,#D6,#M3") into membership arrays.
 *  Accepts a raw reply array or a bare string. Non-#D/#M tokens -> `other`. */
export function parseTags(raw) {
  const s = readValue(raw);
  const str = typeof s === 'string' ? s : '';
  const dca = [], muteGroups = [], other = [];
  for (const token of str.split(',')) {
    const tok = token.trim();
    if (!tok) continue;
    const d = /^#D(\d+)$/.exec(tok);
    const m = /^#M(\d+)$/.exec(tok);
    if (d) dca.push(Number(d[1]));
    else if (m) muteGroups.push(Number(m[1]));
    else other.push(tok);
  }
  return { dca, muteGroups, other };
}

/** Inverse of parseTags — build a `tags` string from membership arrays. */
export function formatTags({ dca = [], muteGroups = [], other = [] } = {}) {
  return [...dca.map((d) => `#D${d}`), ...muteGroups.map((g) => `#M${g}`), ...other].join(',');
}

/** Sends to the next bus tier (channel/bus -> bus/matrix). */
function sendFields(p, count) {
  return Array.from({ length: count }, (_, i) => ({
    bus: i + 1,
    on: `${p}/send/${i + 1}/on`,
    level: `${p}/send/${i + 1}/lvl`
  }));
}

/** Assignment to one of the numbered mains (1-4), separate from bus sends. */
function mainSendFields(p) {
  return Array.from({ length: MAIN_COUNT }, (_, i) => ({
    main: i + 1,
    on: `${p}/main/${i + 1}/on`,
    level: `${p}/main/${i + 1}/lvl`
  }));
}

/** Every leaf OSC address in a strip object, flattened, for the dump walker. */
export function leafAddresses(strip) {
  const out = [];
  const walk = (node) => {
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      // "band"/"bus"/"main"/"group"/"dca" are label fields (e.g. band: 'l',
      // bus: 3), not OSC addresses -- skip them so leafAddresses only ever
      // sees actual address strings.
      const { band, bus, main, group, dca, ...rest } = node;
      Object.values(rest).forEach(walk);
      return;
    }
  };
  // Skip the plain metadata fields (kind/index/path) — not OSC addresses.
  const { kind, index, path, ...fields } = strip;
  walk(fields);
  return out;
}

/**
 * Extract "the value" from a captured reply for interpretation (truthy
 * checks, numeric comparisons, copying). The console replies with
 * [displayString, normalized, raw] for most parameters; single-element
 * arrays (as produced by writes, mocks, and tests) pass through as-is.
 * Prefers the raw/last element -- a numeric 0/1, not the string "0"/"1"
 * (which is truthy either way and silently breaks on/off checks).
 */
export function readValue(v) {
  if (!Array.isArray(v)) return v;
  return v.length > 1 ? v[v.length - 1] : v[0];
}
