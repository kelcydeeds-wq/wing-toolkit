// wing-schema.mjs — best-guess Behringer Wing OSC address map.
//
// TODO(church): every address here is a best guess from public Wing OSC
// documentation, not confirmed against a real console. This file is the
// single source of truth for "what does a channel/bus/main/matrix/DCA strip
// look like over OSC" so dump-wing-state, plan-remap, and apply-remap never
// disagree with each other about it. When the real addresses come back from
// the church audit, fix them here once and every tool picks it up.
//
// Counts below are also best-guess and should be confirmed on site.
export const CHANNEL_COUNT = 40;
export const BUS_COUNT = 16;      // TODO(church): confirm aux/group bus count
export const MATRIX_COUNT = 8;    // TODO(church): confirm matrix count
export const DCA_COUNT = 16;      // TODO(church): confirm DCA count
export const MUTE_GROUP_COUNT = 8; // TODO(church): confirm mute group count
export const EQ_BANDS = 4;        // TODO(church): Wing channel EQ is likely 4-6 bands

/**
 * Full parameter set for a "channel-shaped" strip (input channel). Buses,
 * mains, matrices, and DCAs reuse the pieces that apply to them via the
 * `strip*` helpers below rather than duplicating address patterns.
 */
export function channelStrip(n) {
  const p = `/ch/${n}`;
  return {
    kind: 'channel', index: n, path: p,
    name: `${p}/config/name`,
    color: `${p}/config/color`,
    source: `${p}/config/source`, // patch/source -- TODO(church): confirm patch address scheme
    ...preampFields(p),
    ...dynamicsFields(p),
    ...eqFields(p),
    ...mixFields(p),
    dcaAssign: dcaAssignFields(p),
    muteGroupAssign: muteGroupAssignFields(p),
    sends: sendFields(p)
  };
}

/** Bus (aux/group) strip — has EQ/dynamics/sends like a channel, no preamp/source. */
export function busStrip(n) {
  const p = `/bus/${n}`;
  return {
    kind: 'bus', index: n, path: p,
    name: `${p}/config/name`,
    color: `${p}/config/color`,
    ...dynamicsFields(p),
    ...eqFields(p),
    ...mixFields(p),
    dcaAssign: dcaAssignFields(p),
    muteGroupAssign: muteGroupAssignFields(p),
    sends: sendFields(p, MATRIX_COUNT, '/mtx') // buses feed matrices, not other buses
  };
}

/** Main (LR) strip — name/fader/mute/EQ/dynamics, no sends of its own (it IS the destination). */
export function mainStrip(id = 'lr') {
  const p = `/main/${id}`;
  return {
    kind: 'main', index: id, path: p,
    name: `${p}/config/name`,
    ...dynamicsFields(p),
    ...eqFields(p),
    fader: `${p}/fader`,
    mute: `${p}/mute`
  };
}

/** Matrix strip — name/fader/mute/EQ, plus which sources feed it. */
export function matrixStrip(n) {
  const p = `/mtx/${n}`;
  return {
    kind: 'matrix', index: n, path: p,
    name: `${p}/config/name`,
    ...dynamicsFields(p),
    ...eqFields(p),
    fader: `${p}/fader`,
    mute: `${p}/mute`
  };
}

/** DCA — just a name, fader, and mute; no EQ/dynamics/sends. */
export function dcaStrip(n) {
  const p = `/dca/${n}`;
  return {
    kind: 'dca', index: n, path: p,
    name: `${p}/config/name`,
    fader: `${p}/fader`,
    mute: `${p}/mute`
  };
}

/**
 * Custom/user-assignable keys. Genuinely the least certain part of this
 * schema — Wing's user-key mapping isn't in the parts of the public OSC
 * spec this was written against. TODO(church): confirm the address scheme
 * entirely; this may need to be rewritten from scratch after the audit.
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

/* ---------------------- shared field-group helpers ---------------------- */

function preampFields(p) {
  return {
    gain: `${p}/preamp/gain`,
    invert: `${p}/preamp/invert`,
    hpfOn: `${p}/preamp/hpf/on`,
    hpfFreq: `${p}/preamp/hpf/f`
  };
}

function dynamicsFields(p) {
  return {
    gateOn: `${p}/gate/on`,
    gateThreshold: `${p}/gate/thr`,
    dynOn: `${p}/dyn/on`,
    dynThreshold: `${p}/dyn/thr`,
    dynRatio: `${p}/dyn/ratio`,
    dynAttack: `${p}/dyn/attack`,
    dynRelease: `${p}/dyn/release`
  };
}

function eqFields(p) {
  return {
    eqOn: `${p}/eq/on`,
    eq: Array.from({ length: EQ_BANDS }, (_, i) => {
      const b = i + 1;
      return { band: b, type: `${p}/eq/${b}/type`, freq: `${p}/eq/${b}/f`, gain: `${p}/eq/${b}/g`, q: `${p}/eq/${b}/q` };
    })
  };
}

function mixFields(p) {
  return {
    fader: `${p}/fader`,
    mute: `${p}/mute`,
    pan: `${p}/pan`,
    mainAssign: `${p}/mix/main/on` // TODO(church): confirm main-assign address; mono vs LR
  };
}

function dcaAssignFields(p) {
  return Array.from({ length: DCA_COUNT }, (_, i) => ({ dca: i + 1, address: `${p}/grp/dca/${i + 1}` }));
}

function muteGroupAssignFields(p) {
  return Array.from({ length: MUTE_GROUP_COUNT }, (_, i) => ({ group: i + 1, address: `${p}/grp/mute/${i + 1}` }));
}

function sendFields(p, count = BUS_COUNT, destPrefix = '/mix') {
  return Array.from({ length: count }, (_, i) => ({
    bus: i + 1,
    level: `${p}${destPrefix === '/mix' ? '/mix' : ''}/${i + 1}/level`,
    on: `${p}${destPrefix === '/mix' ? '/mix' : ''}/${i + 1}/on`
  }));
}

/** Every leaf OSC address in a strip object, flattened, for the dump walker. */
export function leafAddresses(strip) {
  const out = [];
  const walk = (node) => {
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') { Object.values(node).forEach(walk); return; }
  };
  // Skip the plain metadata fields (kind/index/path) — not OSC addresses.
  const { kind, index, path, ...fields } = strip;
  walk(fields);
  return out;
}
