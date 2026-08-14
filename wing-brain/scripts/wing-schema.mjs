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
    // Confirmed live 2026-08-12 (channel-swap work): a plain index, unlike
    // col -- writing the raw value back directly round-trips correctly, no
    // +1 offset needed. Was missing from this schema entirely before, so a
    // channel's icon silently didn't travel on any earlier remap/copy.
    icon: `${p}/icon`,
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
    // Confirmed live 2026-08-12 (channel-swap work): same gating behavior as
    // dyn/mdl below, on the gate section -- "GATE" (full: thr/range/att/
    // hld/rel/acc/ratio) vs "LA" (reduced: no thr etc. at all). Must be
    // written before the model-dependent gate fields.
    gateModel: `${p}/gate/mdl`,
    gateThreshold: `${p}/gate/thr`,
    gateRange: `${p}/gate/range`,
    gateAttack: `${p}/gate/att`,
    gateHold: `${p}/gate/hld`,
    gateRelease: `${p}/gate/rel`,
    // Unconfirmed meaning (TODO(church)) but a plain continuous value like
    // its siblings -- safe to carry verbatim regardless.
    gateAcceleration: `${p}/gate/acc`,
    // Single-element string reply (e.g. "1:3"), like name/eq-mdl -- not a
    // continuous float, no offset.
    gateRatio: `${p}/gate/ratio`,
    dynOn: `${p}/dyn/on`,
    // Confirmed live 2026-08-12 (channel-swap work): the dynamics processor
    // has a model selector (e.g. "COMP" full-featured vs "LA" opto-style
    // leveling amp) that GATES which of thr/ratio/att/rel even exist --
    // an "LA"-model channel silently drops writes to dyn/thr etc. entirely.
    // Must be written before the model-dependent fields below so a copy
    // lands on a channel with a different model already selected. Value is
    // a plain string (single-element reply, like name), no offset/float.
    dynModel: `${p}/dyn/mdl`,
    dynMix: `${p}/dyn/mix`,
    dynMakeupGain: `${p}/dyn/gain`,
    dynThreshold: `${p}/dyn/thr`,
    dynRatio: `${p}/dyn/ratio`,
    dynKnee: `${p}/dyn/knee`,
    // Single-element string replies ("RMS"/"LOG") -- enums, not continuous.
    dynDetection: `${p}/dyn/det`,
    dynAttack: `${p}/dyn/att`,
    dynHold: `${p}/dyn/hld`,
    dynRelease: `${p}/dyn/rel`,
    dynEnvelope: `${p}/dyn/env`,
    // Boolean-shaped (0/1), like dynOn/gateOn -- plain send(), not continuous.
    dynAuto: `${p}/dyn/auto`
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
    // Confirmed live 2026-08-12 (channel-swap work): eq/mdl selects between
    // at least "STD" (the 4-numbered-band + l/h-shelf shape below, what this
    // whole schema assumes) and "SOUL" -- an entirely different topology
    // with fixed lo-mid/hi-mid bands instead of the 4 parametric ones (see
    // soulMidBands below) and no q/type on its shelves. A channel's eq/mdl
    // is NOT necessarily "STD" -- must be copied first, same reason as
    // dyn/mdl, or the model-dependent fields below silently no-op.
    eqModel: `${p}/eq/mdl`,
    eqOn: `${p}/eq/on`,
    eq: [
      ...Array.from({ length: EQ_BANDS }, (_, i) => numberedEqBand(p, i + 1)),
      shelfEqBand(p, 'l'),
      shelfEqBand(p, 'h')
    ],
    // Only meaningful under eq/mdl "SOUL" -- ignored (reads null, skipped)
    // by copyChannel on a "STD" channel. lmf3/hmf3's exact meaning is
    // unconfirmed (TODO(church)) but its raw value round-trips like any
    // other continuous param, so it's safe to carry verbatim regardless.
    soulMidBands: {
      lowMidFreq: `${p}/eq/lmf`,
      lowMidFreq3: `${p}/eq/lmf3`,
      lowMidQ: `${p}/eq/lmq`,
      lowMidGain: `${p}/eq/lmg`,
      highMidFreq: `${p}/eq/hmf`,
      highMidFreq3: `${p}/eq/hmf3`,
      highMidQ: `${p}/eq/hmq`,
      highMidGain: `${p}/eq/hmg`
    }
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

// leafAddresses() flattens strips down to bare address strings, so a caller
// writing generically (apply-remap.mjs's channel-copy loop) has no field-name
// context left to know which addresses are continuous (must be sent as OSC
// floats, per osc.js's sendFloat doc comment and CLAUDE.md's confirmed rule —
// the Wing silently ignores an integer-typed write for these) vs discrete
// (on/off, index, string — plain send() is correct). Matched by address
// SUFFIX since that's the only thing surviving the flatten. Keep in sync with
// the field groups above (filterFields/dynamicsFields/*EqFields/mixFields/
// sendFields/mainSendFields) if the schema changes.
const CONTINUOUS_ADDRESS_SUFFIX = new RegExp(
  '(' + [
    'flt/lcf',            // HPF frequency
    'gate/thr',           // gate threshold
    'gate/(range|att|hld|rel|acc)', // additional gate continuous params
    'dyn/thr', 'dyn/ratio', 'dyn/att', 'dyn/rel', // dynamics
    'dyn/(mix|gain|knee|hld)',   // additional dynamics continuous params
    'eq/\\d[fgq]',         // numbered EQ bands: 1f/1g/1q .. 6f/6g/6q
    'eq/[lh][fgq]',        // shelf EQ bands: lf/lg/lq/hf/hg/hq
    'eq/[lh]m(f3?|[qg])',  // "SOUL" model mid bands: lmf/lmf3/lmq/lmg/hmf/hmf3/hmq/hmg
    'fdr',                 // fader
    'pan',                 // pan
    'send/\\d+/lvl',       // bus send level
    'main/\\d+/lvl'        // main send level
  ].join('|') + ')$'
);

/** True if `address` must be sent as an OSC float (osc.js's sendFloat), not
 *  the default send() — see CONTINUOUS_ADDRESS_SUFFIX above for why. */
export function isContinuousParam(address) {
  return CONTINUOUS_ADDRESS_SUFFIX.test(address);
}

// Confirmed live 2026-08-12: most discrete params round-trip by writing back
// exactly the raw value from a read (booleans like mute/gate-on/dyn-on, and
// strings like name/tags/group-token, all verified this way). But INDEX-type
// params -- an enumerated position within a list, not a boolean or a string
// -- are the opposite: raw is 0-indexed on read, but the write wants raw+1
// (write 8 -> lands as raw 7; write 9 -> lands as raw 8). Confirmed on TWO
// independent params this way (col = position in the color palette, in/conn/in
// = position within an input group), so this reads as a real property of how
// index params work on this console, not a one-off quirk of either address.
// Not a float-typing issue either -- retried col as an OSC float with no
// change. If a future schema addition turns out to be index-typed too (watch
// for a captured raw value that's consistently one less than expected after
// a copy), add its suffix here rather than special-casing it elsewhere.
const INDEX_ADDRESS = /\/(col|in\/conn\/in)$/;

/** The value to actually send for `address` given a value freshly read from
 *  another channel/bus (i.e. copying a param from a source strip to a
 *  destination strip during a remap) -- applies the index write-offset
 *  above, passes every other address through unchanged. */
export function writeValueForCopy(address, rawValue) {
  if (INDEX_ADDRESS.test(address) && typeof rawValue === 'number') return rawValue + 1;
  return rawValue;
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

/* ------------------------- console name reading ------------------------- */
//
// The scribble-strip name of a main/matrix/bus/channel. The ONE address
// builder + the ONE parser below are the single place name reads are shaped,
// so if the real console reveals a different address form for main/mtx/bus
// names, this file is the only edit (per the "fix in one place" rule).
//
// Confirmation status: /ch/N/name is CONFIRMED against the real console spec
// (church visit 2026-07-10). /main/N/name, /mtx/N/name, /bus/N/name FOLLOW
// that exact confirmed pattern but have NOT themselves been live-verified --
// TODO(church): run scripts/read-console-names.mjs at the console to confirm,
// then move them into CLAUDE.md's confirmed list. Until then the reader is
// timeout-safe: a wrong address shape just yields a null (unanswered) name and
// the UI shows the bare designation ("MTX 6"), never a guess.

/** OSC address of a strip's scribble-strip name. `kind` is one of the config
 *  wing.type tokens plus 'bus'/'ch': 'main' | 'mtx' | 'bus' | 'ch'. */
export function nameAddress(kind, n) {
  switch (kind) {
    case 'main': return `/main/${n}/name`;
    case 'mtx':  return `/mtx/${n}/name`;
    case 'bus':  return `/bus/${n}/name`;
    case 'ch':   return `/ch/${n}/name`;
    default: throw new Error(`nameAddress: unknown kind "${kind}"`);
  }
}

/** The console-surface designation for a destination, e.g. "MTX 6", "MAIN 1".
 *  Matches the Wing surface's own capitalization (used verbatim in the picker,
 *  the one place internal-looking tokens like "MTX" are allowed in the UI). */
export function wingDesignation(kind, n) {
  const token = { main: 'MAIN', mtx: 'MTX', bus: 'BUS', ch: 'CH' }[kind];
  if (!token) throw new Error(`wingDesignation: unknown kind "${kind}"`);
  return `${token} ${n}`;
}

/**
 * Interpret a captured name reply into a clean display string, or null when
 * there is no real console-supplied name. Deliberately NOT readValue(): a name
 * is the STRING arg (the first element), never the numeric raw/last element
 * readValue prefers -- a multi-element name reply must not silently resolve to
 * a 0. Returns null for: no reply / timeout (`null`), a non-string arg, or an
 * empty/whitespace name (an un-named strip -> caller shows the bare
 * designation). NEVER invents a value -- null in, null out.
 */
export function readName(reply) {
  if (reply === null || reply === undefined) return null;
  const first = Array.isArray(reply) ? reply[0] : reply;
  if (typeof first !== 'string') return null;
  const trimmed = first.trim();
  return trimmed.length ? trimmed : null;
}
