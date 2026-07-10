// settings.js — validation, merge, and atomic persistence for the Settings
// API. Pure functions, no express/runtime knowledge, so the rules are unit
// testable in isolation.
//
// Validation philosophy: the ranges here are "is this a config a sane PA
// could ever want" caps, not tuning judgment — tuning judgment stays in the
// guardrails themselves. Anything outside these ranges is almost certainly a
// typo (port 80000, band [16000, 40], sweep at 0 dBFS) and gets rejected
// with a path-specific message instead of being written to disk.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Deep merge: objects merge recursively, arrays and scalars replace
 * wholesale. Array replacement is deliberate — a partial update to the
 * outputs table sends the whole array, and splicing arrays by index would
 * corrupt reordered lists.
 */
export function mergeDeep(base, patch) {
  if (Array.isArray(patch) || typeof patch !== 'object' || patch === null) return patch;
  if (Array.isArray(base) || typeof base !== 'object' || base === null) base = {};
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = mergeDeep(base[key], value);
  }
  return out;
}

/** Write JSON atomically: temp file in the same directory, then rename.
 *  A crash mid-write leaves the original intact, never a half-written file. */
export function writeJsonAtomic(filePath, obj) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

/* ------------------------------ validation ------------------------------ */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => Number.isInteger(v);
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Validate a FULL config object (callers merge partial updates into the
 * current config first, so every rule always sees complete context).
 * Returns an array of error strings; empty array = valid.
 */
export function validateConfig(config) {
  const errors = [];
  const bad = (msg) => errors.push(msg);

  if (!config || typeof config !== 'object') return ['config must be an object'];

  if (!['mock', 'live'].includes(config.mode)) bad('mode: must be "mock" or "live"');

  const port = (label, v) => {
    if (!isInt(v) || v < 1 || v > 65535) bad(`${label}: must be an integer 1-65535`);
  };
  port('server.port', config.server?.port);
  port('wing.port', config.wing?.port);
  if (!isStr(config.wing?.host)) bad('wing.host: must be a non-empty string');

  const a = config.audio || {};
  if (!isInt(a.sampleRate) || a.sampleRate < 8000 || a.sampleRate > 192000) {
    bad('audio.sampleRate: must be an integer 8000-192000');
  }
  if (!isStr(a.inputDevice)) bad('audio.inputDevice: must be a non-empty string');
  if (!isStr(a.outputDevice)) bad('audio.outputDevice: must be a non-empty string');
  for (const ch of ['referenceInputChannel', 'micInputChannel']) {
    if (!isInt(a[ch]) || a[ch] < 1 || a[ch] > 64) bad(`audio.${ch}: must be an integer 1-64`);
  }

  const s = a.sweep || {};
  if (!isNum(s.f1) || !isNum(s.f2) || s.f1 < 10 || s.f2 > 24000 || s.f1 >= s.f2) {
    bad('audio.sweep: f1/f2 must be numbers with 10 <= f1 < f2 <= 24000');
  }
  if (!isNum(s.seconds) || s.seconds < 1 || s.seconds > 30) bad('audio.sweep.seconds: must be 1-30');
  if (!isNum(s.padSeconds) || s.padSeconds < 0 || s.padSeconds > 10) bad('audio.sweep.padSeconds: must be 0-10');
  if (!isNum(s.levelDbfs) || s.levelDbfs > -6 || s.levelDbfs < -60) {
    bad('audio.sweep.levelDbfs: must be -60 to -6 dBFS (headroom is not optional)');
  }

  if (a.preflight !== undefined) {
    const pf = a.preflight;
    if (typeof pf !== 'object' || pf === null) bad('audio.preflight: must be an object');
    else {
      if (pf.blipSeconds !== undefined && (!isNum(pf.blipSeconds) || pf.blipSeconds < 0.1 || pf.blipSeconds > 5)) {
        bad('audio.preflight.blipSeconds: must be 0.1-5');
      }
      if (pf.minPeakDbfs !== undefined && (!isNum(pf.minPeakDbfs) || pf.minPeakDbfs < -120 || pf.minPeakDbfs > 0)) {
        bad('audio.preflight.minPeakDbfs: must be -120 to 0');
      }
      if (pf.minSnrDb !== undefined && (!isNum(pf.minSnrDb) || pf.minSnrDb < 0 || pf.minSnrDb > 60)) {
        bad('audio.preflight.minSnrDb: must be 0-60');
      }
    }
  }

  if (!Array.isArray(config.outputs) || config.outputs.length === 0) {
    bad('outputs: must be a non-empty array');
  } else {
    const seen = new Set();
    config.outputs.forEach((o, i) => {
      const at = `outputs[${i}]`;
      if (!isStr(o?.id)) bad(`${at}.id: must be a non-empty string`);
      else if (seen.has(o.id)) bad(`${at}.id: duplicate id "${o.id}"`);
      else seen.add(o.id);
      if (!isStr(o?.label)) bad(`${at}.label: must be a non-empty string`);
      if (o?.role !== undefined && !['main', 'sub', 'fill'].includes(o.role)) {
        bad(`${at}.role: must be main, sub, or fill`);
      }
      if (o?.enabled !== undefined && typeof o.enabled !== 'boolean') bad(`${at}.enabled: must be a boolean`);
      if (!['main', 'mtx'].includes(o?.wing?.type)) bad(`${at}.wing.type: must be "main" or "mtx"`);
      if (!isInt(o?.wing?.num) || o.wing.num < 1 || o.wing.num > 64) bad(`${at}.wing.num: must be an integer 1-64`);
      const band = o?.band;
      if (!Array.isArray(band) || band.length !== 2 || !isNum(band[0]) || !isNum(band[1])
          || band[0] < 10 || band[1] > 24000 || band[0] >= band[1]) {
        bad(`${at}.band: must be [lo, hi] with 10 <= lo < hi <= 24000`);
      }
      if (o?.sweepTrimDb !== undefined && (!isNum(o.sweepTrimDb) || o.sweepTrimDb < -60 || o.sweepTrimDb > 0)) {
        bad(`${at}.sweepTrimDb: must be -60 to 0 dB (trims attenuate, never boost)`);
      }
    });
  }

  const g = config.guardrails || {};
  const gr = (key, lo, hi, int = false) => {
    const v = g[key];
    if (!isNum(v) || v < lo || v > hi || (int && !isInt(v))) {
      bad(`guardrails.${key}: must be ${int ? 'an integer ' : ''}${lo}-${hi}`);
    }
  };
  gr('eqAutoMaxHz', 50, 2000);
  gr('maxCutDb', 0, 12);
  gr('maxBoostDb', 0, 6);
  gr('maxFiltersPerOutput', 1, 16, true);
  gr('minQ', 0.1, 5);
  gr('maxQ', 1, 16);
  gr('maxBoostQ', 0.5, 8);
  gr('nullVarianceDb', 1, 20);
  gr('minFilterHz', 20, 200);
  gr('noBoostBelowHz', 20, 500);
  gr('minFilterSpacingOct', 0, 2);
  gr('fillPrecedenceMs', 0, 20);
  gr('tiltOnlyAboveHz', 100, 2000);
  if (isNum(g.minQ) && isNum(g.maxQ) && g.minQ >= g.maxQ) bad('guardrails: minQ must be less than maxQ');
  if (typeof g.requireApplyTap !== 'boolean') bad('guardrails.requireApplyTap: must be a boolean');

  const curveErrors = (curve, at) => {
    if (!isStr(curve?.name)) bad(`${at}.name: must be a non-empty string`);
    const pts = curve?.points;
    if (!Array.isArray(pts) || pts.length < 2) { bad(`${at}.points: must be an array of at least 2 [Hz, dB] pairs`); return; }
    let prev = -Infinity;
    for (const [j, p] of pts.entries()) {
      if (!Array.isArray(p) || p.length !== 2 || !isNum(p[0]) || !isNum(p[1])
          || p[0] < 10 || p[0] > 24000 || p[1] < -24 || p[1] > 24) {
        bad(`${at}.points[${j}]: must be [Hz 10-24000, dB -24..24]`); continue;
      }
      if (p[0] <= prev) bad(`${at}.points[${j}]: frequencies must be strictly ascending`);
      prev = p[0];
    }
  };
  const curves = config.targetCurves;
  if (!curves || typeof curves !== 'object' || Array.isArray(curves) || Object.keys(curves).length === 0) {
    bad('targetCurves: must be a non-empty object of {curveName: curve}');
  } else {
    for (const [key, curve] of Object.entries(curves)) {
      curveErrors(curve, `targetCurves.${key}`);
      if (isStr(curve?.name) && curve.name !== key) bad(`targetCurves.${key}.name: must match its map key ("${curve.name}" != "${key}")`);
    }
    if (!isStr(config.selectedTargetCurve) || !curves[config.selectedTargetCurve]) {
      bad(`selectedTargetCurve: must be a key present in targetCurves (got ${JSON.stringify(config.selectedTargetCurve)})`);
    }
  }

  return errors;
}

/** The currently-active target curve object — the one lookup every caller
 *  (tune session, advisor prompt) should go through, so nothing reads
 *  targetCurves[selected] by hand and risks a stale/mistyped key. */
export function activeTargetCurve(config) {
  return config.targetCurves[config.selectedTargetCurve];
}

/**
 * Room updates through the API are deliberately narrow: only the verify
 * position is settable. Geometry edits still happen in room.json by hand —
 * the map/positions drive delay predictions, so they change on-site with a
 * tape measure, not from a phone form.
 */
export function validateRoomPatch(patch, room) {
  const errors = [];
  if (!patch || typeof patch !== 'object') return ['room: patch must be an object'];
  const keys = Object.keys(patch);
  const extra = keys.filter((k) => k !== 'verifyPosition');
  if (extra.length) {
    errors.push(`room: only verifyPosition is editable via the API (got: ${extra.join(', ')}) — edit config/room.json directly for geometry`);
  }
  if (patch.verifyPosition !== undefined) {
    const ids = (room?.positions || []).map((p) => p.id);
    if (!ids.includes(patch.verifyPosition)) {
      errors.push(`room.verifyPosition: "${patch.verifyPosition}" is not a known position (${ids.join(', ')})`);
    }
  }
  return errors;
}
