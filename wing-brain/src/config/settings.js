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
 * `room` is optional — when provided, loudnessMonitor.referencePositionId is
 * cross-checked against room.positions (it must name a real position, never
 * free text); omitting `room` skips that one cross-object check, which is
 * how existing config-only unit tests keep working unchanged.
 * Returns an array of error strings; empty array = valid.
 */
export function validateConfig(config, room) {
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

  const sys = config.system || {};
  if (!isNum(sys.crossoverHz) || sys.crossoverHz < 40 || sys.crossoverHz > 300) {
    bad('system.crossoverHz: must be a number 40-300 Hz');
  }

  const a = config.audio || {};
  if (!isInt(a.sampleRate) || a.sampleRate < 8000 || a.sampleRate > 192000) {
    bad('audio.sampleRate: must be an integer 8000-192000');
  }
  if (!isStr(a.inputDevice)) bad('audio.inputDevice: must be a non-empty string');
  if (!isStr(a.outputDevice)) bad('audio.outputDevice: must be a non-empty string');
  for (const ch of ['referenceInputChannel', 'micInputChannel']) {
    if (!isInt(a[ch]) || a[ch] < 1 || a[ch] > 64) bad(`audio.${ch}: must be an integer 1-64`);
  }
  if (a.splDbOffset !== undefined && a.splDbOffset !== null) {
    if (!isNum(a.splDbOffset) || a.splDbOffset < -60 || a.splDbOffset > 200) {
      bad('audio.splDbOffset: must be null (uncalibrated) or a number -60 to 200');
    }
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
  if (s.targetSplDb !== undefined && s.targetSplDb !== null) {
    if (!isNum(s.targetSplDb) || s.targetSplDb < 40 || s.targetSplDb > 120) {
      bad('audio.sweep.targetSplDb: must be null (disabled) or 40-120 dB SPL');
    }
  }
  if (s.maxLevelDbfs !== undefined) {
    if (!isNum(s.maxLevelDbfs) || s.maxLevelDbfs > -6 || s.maxLevelDbfs < -60) {
      bad('audio.sweep.maxLevelDbfs: must be -60 to -6 dBFS');
    } else if (isNum(s.levelDbfs) && s.maxLevelDbfs < s.levelDbfs) {
      bad('audio.sweep.maxLevelDbfs: must be >= audio.sweep.levelDbfs (it is a ceiling for auto-raise, not a floor)');
    }
  }
  if (s.minSnrMarginDb !== undefined && (!isNum(s.minSnrMarginDb) || s.minSnrMarginDb < 0 || s.minSnrMarginDb > 40)) {
    bad('audio.sweep.minSnrMarginDb: must be 0-40 dB');
  }
  if (s.ambientCheckSeconds !== undefined && (!isNum(s.ambientCheckSeconds) || s.ambientCheckSeconds < 0.2 || s.ambientCheckSeconds > 5)) {
    bad('audio.sweep.ambientCheckSeconds: must be 0.2-5 seconds');
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

  // --- Layer 1: buses. Live modules (mutes, loudness, EQ, delay) operate
  // ONLY on this layer -- see docs/DECISIONS.md "routing model" entry.
  const busIds = new Set();
  if (!Array.isArray(config.buses) || config.buses.length === 0) {
    bad('buses: must be a non-empty array');
  } else {
    config.buses.forEach((b, i) => {
      const at = `buses[${i}]`;
      if (!isStr(b?.id)) bad(`${at}.id: must be a non-empty string`);
      else if (busIds.has(b.id)) bad(`${at}.id: duplicate id "${b.id}"`);
      else busIds.add(b.id);
      if (!isStr(b?.label)) bad(`${at}.label: must be a non-empty string`);
      if (!['main', 'sub', 'fill'].includes(b?.role)) bad(`${at}.role: must be main, sub, or fill`);
      if (typeof b?.stereo !== 'boolean') bad(`${at}.stereo: must be a boolean`);
      if (!['main', 'mtx'].includes(b?.wing?.type)) bad(`${at}.wing.type: must be "main" or "mtx"`);
      if (!isInt(b?.wing?.num) || b.wing.num < 1 || b.wing.num > 64) bad(`${at}.wing.num: must be an integer 1-64`);
      if (typeof b?.wing?.confirmed !== 'boolean') bad(`${at}.wing.confirmed: must be a boolean`);
      const band = b?.band;
      if (!Array.isArray(band) || band.length !== 2 || !isNum(band[0]) || !isNum(band[1])
          || band[0] < 10 || band[1] > 24000 || band[0] >= band[1]) {
        bad(`${at}.band: must be [lo, hi] with 10 <= lo < hi <= 24000`);
      }
      if (b?.sweepTrimDb !== undefined && (!isNum(b.sweepTrimDb) || b.sweepTrimDb < -60 || b.sweepTrimDb > 0)) {
        bad(`${at}.sweepTrimDb: must be -60 to 0 dB (trims attenuate, never boost)`);
      }
    });
  }

  // --- Layer 2: physical outputs. Dumb patches only -- no EQ/delay is ever
  // written here (enforced by client.js/session.js, not by this validator).
  if (!Array.isArray(config.physicalOutputs) || config.physicalOutputs.length === 0) {
    bad('physicalOutputs: must be a non-empty array');
  } else {
    const outIds = new Set();
    const speakerIds = new Set((room?.speakers || []).map((s) => s.id));
    config.physicalOutputs.forEach((o, i) => {
      const at = `physicalOutputs[${i}]`;
      if (!isStr(o?.id)) bad(`${at}.id: must be a non-empty string`);
      else if (outIds.has(o.id)) bad(`${at}.id: duplicate id "${o.id}"`);
      else outIds.add(o.id);
      if (!isStr(o?.label)) bad(`${at}.label: must be a non-empty string`);
      if (!isStr(o?.sourceBusId)) bad(`${at}.sourceBusId: must be a non-empty string`);
      else if (busIds.size && !busIds.has(o.sourceBusId)) bad(`${at}.sourceBusId: "${o.sourceBusId}" is not a known bus id`);
      if (!['L', 'R', 'mono'].includes(o?.side)) bad(`${at}.side: must be "L", "R", or "mono"`);
      if (o?.enabled !== undefined && typeof o.enabled !== 'boolean') bad(`${at}.enabled: must be a boolean`);
      if (o?.speakerId !== undefined) {
        if (!isStr(o.speakerId)) bad(`${at}.speakerId: must be a non-empty string`);
        else if (room && speakerIds.size && !speakerIds.has(o.speakerId)) bad(`${at}.speakerId: "${o.speakerId}" is not a known room speaker id`);
      }
      const w = o?.wing;
      if (!w || typeof w !== 'object') bad(`${at}.wing: must be an object`);
      else {
        if (w.grp !== null && !isStr(w.grp)) bad(`${at}.wing.grp: must be null or a non-empty string`);
        if (w.num !== null && (!isInt(w.num) || w.num < 1)) bad(`${at}.wing.num: must be null or a positive integer`);
        if (typeof w.confirmed !== 'boolean') bad(`${at}.wing.confirmed: must be a boolean`);
      }
      if (o?.sharedDrivers !== undefined) {
        const sd = o.sharedDrivers;
        if (!isInt(sd?.count) || sd.count < 2) bad(`${at}.sharedDrivers.count: must be an integer >= 2`);
        if (!Array.isArray(sd?.drivers) || sd.drivers.length !== sd?.count) {
          bad(`${at}.sharedDrivers.drivers: must be an array with length matching count`);
        } else {
          sd.drivers.forEach((d, j) => {
            if (!isStr(d?.label)) bad(`${at}.sharedDrivers.drivers[${j}].label: must be a non-empty string`);
            if (d?.speakerId !== undefined) {
              if (!isStr(d.speakerId)) bad(`${at}.sharedDrivers.drivers[${j}].speakerId: must be a non-empty string`);
              else if (room && speakerIds.size && !speakerIds.has(d.speakerId)) {
                bad(`${at}.sharedDrivers.drivers[${j}].speakerId: "${d.speakerId}" is not a known room speaker id`);
              }
            }
          });
        }
      }
    });
  }

  // --- Test signal injection point (per-output test injection, section 2).
  const ts = config.testSignal;
  if (!ts || typeof ts !== 'object') {
    bad('testSignal: must be an object');
  } else {
    if (!['usb_sweep', 'wing_oscillator'].includes(ts.source)) {
      bad('testSignal.source: must be "usb_sweep" or "wing_oscillator"');
    }
    if (ts.injectionChannelGrp !== null && !isStr(ts.injectionChannelGrp)) {
      bad('testSignal.injectionChannelGrp: must be null or a non-empty string');
    }
    if (ts.injectionChannelNum !== null && (!isInt(ts.injectionChannelNum) || ts.injectionChannelNum < 1)) {
      bad('testSignal.injectionChannelNum: must be null or a positive integer');
    }
    if (typeof ts.confirmed !== 'boolean') bad('testSignal.confirmed: must be a boolean');
    if (ts.auxChannel !== undefined && ts.auxChannel !== null && (!isInt(ts.auxChannel) || ts.auxChannel < 1)) {
      bad('testSignal.auxChannel: must be null/absent or a positive integer');
    }
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

  const lm = config.loudnessMonitor;
  if (!lm || typeof lm !== 'object') {
    bad('loudnessMonitor: must be an object');
  } else {
    if (typeof lm.enabled !== 'boolean') bad('loudnessMonitor.enabled: must be a boolean');
    if (!isStr(lm.referencePositionId)) {
      bad('loudnessMonitor.referencePositionId: must be a non-empty string');
    } else if (room) {
      const ids = (room.positions || []).map((p) => p.id);
      if (!ids.includes(lm.referencePositionId)) {
        bad(`loudnessMonitor.referencePositionId: "${lm.referencePositionId}" is not a known room position (${ids.join(', ')})`);
      }
    }
    if (!isNum(lm.targetDb) || lm.targetDb < 40 || lm.targetDb > 120) bad('loudnessMonitor.targetDb: must be 40-120 dB');
    if (!isNum(lm.softMarginDb) || lm.softMarginDb < 0 || lm.softMarginDb > 20) bad('loudnessMonitor.softMarginDb: must be 0-20 dB');
    if (!isNum(lm.hardMarginDb) || lm.hardMarginDb < 0 || lm.hardMarginDb > 30) bad('loudnessMonitor.hardMarginDb: must be 0-30 dB');
    if (isNum(lm.softMarginDb) && isNum(lm.hardMarginDb) && lm.softMarginDb >= lm.hardMarginDb) {
      bad('loudnessMonitor: softMarginDb must be less than hardMarginDb');
    }
    if (!isNum(lm.sustainedSeconds) || lm.sustainedSeconds < 0 || lm.sustainedSeconds > 120) {
      bad('loudnessMonitor.sustainedSeconds: must be 0-120 seconds');
    }
    if (!/^LEQ\d+$/i.test(String(lm.integrationWindow || ''))) {
      bad('loudnessMonitor.integrationWindow: must look like "LEQ10" (an integer seconds window)');
    }
    if (lm.quietTargetDb !== null && lm.quietTargetDb !== undefined) {
      if (!isNum(lm.quietTargetDb) || lm.quietTargetDb < 40 || lm.quietTargetDb > 120) {
        bad('loudnessMonitor.quietTargetDb: must be null (disabled) or 40-120 dB');
      } else if (isNum(lm.targetDb) && lm.quietTargetDb >= lm.targetDb) {
        bad('loudnessMonitor.quietTargetDb: must be less than targetDb');
      }
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
 * Bounding box of room.walls (min/max of each coordinate) — a cheap
 * containment check, not full point-in-polygon (rooms here are close enough
 * to rectangular that a bbox is a useful sanity check, not a precise
 * boundary). Mirrors the client-side bbox math `drawRoom()` in
 * public/index.html already uses. Returns null when walls are unknown/empty
 * so callers can skip the check rather than reject.
 */
export function roomBounds(room) {
  const walls = room?.walls;
  if (!Array.isArray(walls) || walls.length === 0) return null;
  const xs = walls.map((p) => p[0]);
  const ys = walls.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

/** True if [x, y] falls within room.walls' bounding box, or if walls are
 *  unknown (bounds are "if known" per the Stage 1 spec — never reject a
 *  point just because we have no geometry to check it against). */
export function isWithinRoomBounds(x, y, room) {
  const b = roomBounds(room);
  if (!b) return true;
  return x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
}

const MAX_Z_M = 20; // sane hardcoded cap for fly/mount height — not a guardrail

/** Validate a full room.speakers array ({id, x, y, z, note?}). Returns an
 *  array of error strings; empty = valid. `room` is used only for bounds
 *  (the array being validated may itself be the candidate next value, so
 *  duplicate-id checks are against `speakers`, not `room.speakers`). */
export function validateSpeakersArray(speakers, room) {
  if (!Array.isArray(speakers)) return ['room.speakers: must be an array'];
  const errors = [];
  const bad = (msg) => errors.push(msg);
  const ids = new Set();
  speakers.forEach((s, i) => {
    const at = `room.speakers[${i}]`;
    if (!isStr(s?.id)) bad(`${at}.id: must be a non-empty string`);
    else if (ids.has(s.id)) bad(`${at}.id: duplicate id "${s.id}"`);
    else ids.add(s.id);
    if (!isNum(s?.x) || !isNum(s?.y)) bad(`${at}.x/y: must be numbers`);
    else if (!isWithinRoomBounds(s.x, s.y, room)) bad(`${at}.x/y: outside the room's wall bounds`);
    if (s?.z !== undefined && (!isNum(s.z) || s.z < 0 || s.z > MAX_Z_M)) {
      bad(`${at}.z: must be a number 0-${MAX_Z_M} (meters)`);
    }
    if (s?.note !== undefined && typeof s.note !== 'string') bad(`${at}.note: must be a string`);
    if (s?.needsPositioning !== undefined && typeof s.needsPositioning !== 'boolean') {
      bad(`${at}.needsPositioning: must be a boolean`);
    }
  });
  return errors;
}

/** Validate a full room.positions array ({id, label, zone, x, y, z, weight}).
 *  Same shape/reasoning as validateSpeakersArray. */
export function validatePositionsArray(positions, room) {
  if (!Array.isArray(positions)) return ['room.positions: must be an array'];
  const errors = [];
  const bad = (msg) => errors.push(msg);
  const ids = new Set();
  positions.forEach((p, i) => {
    const at = `room.positions[${i}]`;
    if (!isStr(p?.id)) bad(`${at}.id: must be a non-empty string`);
    else if (ids.has(p.id)) bad(`${at}.id: duplicate id "${p.id}"`);
    else ids.add(p.id);
    if (!isStr(p?.label)) bad(`${at}.label: must be a non-empty string`);
    if (!['main', 'balcony', 'under_balcony'].includes(p?.zone)) {
      bad(`${at}.zone: must be "main", "balcony", or "under_balcony"`);
    }
    if (!isNum(p?.x) || !isNum(p?.y)) bad(`${at}.x/y: must be numbers`);
    else if (!isWithinRoomBounds(p.x, p.y, room)) bad(`${at}.x/y: outside the room's wall bounds`);
    if (p?.z !== undefined && (!isNum(p.z) || p.z < 0 || p.z > MAX_Z_M)) {
      bad(`${at}.z: must be a number 0-${MAX_Z_M} (meters)`);
    }
    if (!isNum(p?.weight) || p.weight < 0) bad(`${at}.weight: must be a number >= 0`);
    if (p?.enabled !== undefined && typeof p.enabled !== 'boolean') bad(`${at}.enabled: must be a boolean`);
  });
  return errors;
}

/**
 * Room updates through the API. Originally deliberately narrow (only the
 * verify position was settable; geometry edits happened in room.json by
 * hand). Widened for the visual speaker/output editor (Stage 1 of that
 * feature) to also accept full-array replacements of `speakers` and
 * `positions` — mergeDeep replaces arrays wholesale, so callers build the
 * complete next array (one item added/updated/removed) and send it here.
 * `verifyPosition`-only patches keep behaving exactly as before: same keys
 * check, same message prefix, same validation.
 */
export function validateRoomPatch(patch, room) {
  const errors = [];
  if (!patch || typeof patch !== 'object') return ['room: patch must be an object'];
  const keys = Object.keys(patch);
  const known = ['verifyPosition', 'speakers', 'positions'];
  const extra = keys.filter((k) => !known.includes(k));
  if (extra.length) {
    errors.push(`room: only verifyPosition, speakers, positions are editable via the API (got: ${extra.join(', ')}) — edit config/room.json directly for geometry`);
  }
  if (patch.verifyPosition !== undefined) {
    const ids = (room?.positions || []).map((p) => p.id);
    if (!ids.includes(patch.verifyPosition)) {
      errors.push(`room.verifyPosition: "${patch.verifyPosition}" is not a known position (${ids.join(', ')})`);
    }
  }
  if (patch.speakers !== undefined) {
    errors.push(...validateSpeakersArray(patch.speakers, room));
  }
  if (patch.positions !== undefined) {
    errors.push(...validatePositionsArray(patch.positions, room));
  }
  return errors;
}
