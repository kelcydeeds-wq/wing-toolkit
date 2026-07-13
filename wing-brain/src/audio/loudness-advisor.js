// loudness-advisor.js — Claude as a contextual read on loudness alerts.
//
// Mirrors tune/advisor.js's division of labor exactly:
//   code measures  → LEQ, sustained-threshold status              (loudness-monitor.js)
//   Claude judges  → what a level trend MEANS                     (this file)
//   code enforces  → the raw alert always fires regardless        (loudness-monitor.js)
//   no local fallback needed here — annotation is optional, never load-bearing.
//
// Unlike the tune advisor (one call per Full Tune), this fires once per
// alert EVENT (a sustained-threshold transition into warn/alert), not on a
// timer and not per second — a busy service triggers a handful of these,
// not hundreds. Cheap enough that a missing/failed call is a non-event: the
// raw meter already did its job before this is ever asked.
//
// Setup: same ANTHROPIC_API_KEY as tune/advisor.js. Without a key, this
// silently returns null and the UI's secondary annotation line just stays
// blank — never blocks, delays, or overrides the raw threshold alert.

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5'; // classification task, not tuning judgment — Haiku tier is plenty

const READ_KINDS = ['drift', 'dynamics', 'ramp', 'unclear'];
const CONFIDENCE_LEVELS = ['low', 'medium', 'high'];

/**
 * Bucket a readings array ({t, levelDb, ...}) into ~stepSeconds-wide bins
 * over the last windowSeconds, averaging each bin — gives Claude a shape
 * (rise-and-fall vs step vs ramp) instead of a dense per-frame trace.
 */
export function downsampleTrend(readings, nowSeconds, { windowSeconds = 120, stepSeconds = 5 } = {}) {
  const cutoff = nowSeconds - windowSeconds;
  const buckets = new Map(); // bucketIndex -> { dbSum, tSum, n }
  for (const r of readings) {
    if (r.t < cutoff) continue;
    const bucket = Math.floor((r.t - cutoff) / stepSeconds);
    const e = buckets.get(bucket) || { dbSum: 0, tSum: 0, n: 0 };
    e.dbSum += r.levelDb;
    e.tSum += r.t;
    e.n++;
    buckets.set(bucket, e);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, e]) => ({ tSec: Math.round(e.tSum / e.n), db: Math.round((e.dbSum / e.n) * 10) / 10 }));
}

/**
 * Build the compact payload Claude reasons over for one alert event.
 * `readings` is the monitor's full-resolution reading log; everything else
 * is scalar context captured at the moment the alert fired.
 */
export function buildLoudnessPayload({
  currentDb, targetDb, marginState, overageDurationSec, readings, nowSeconds, serviceElapsedMin,
  currentSongLabel = null, isWorshipSection = null
}) {
  return {
    currentDb: Math.round(currentDb * 10) / 10,
    targetDb,
    marginState,
    overageDurationSec: Math.round(overageDurationSec),
    recentTrend: downsampleTrend(readings || [], nowSeconds),
    serviceElapsedMin: Math.round(serviceElapsedMin * 10) / 10,
    currentSongLabel,
    isWorshipSection
  };
}

const SYSTEM_PROMPT = `You are an experienced FOH (front-of-house) mentor reviewing a live loudness level trend during a church service — not a compliance system issuing violations. You are shown one alert event: the current level, target, how long it has been sustained over margin, and the last ~2 minutes of level history as {tSec, db} points.

Distinguish three shapes, plus a fallback:
- "drift": a step-change that holds — the level jumped and stayed there. Usually means a fader got bumped or gain crept up; probably needs a physical fader pulled.
- "dynamics": a rise-and-fall shape — the trend climbs into the alert and is already easing, or shows the kind of peak/trough movement a song's dynamics produce. Probably fine, no action needed.
- "ramp": a slow, mostly-monotonic climb over many minutes, each step small enough that no single moment looked alarming — the classic "ears adapt, nobody notices it happening" creep. Worth flagging even though every individual reading seemed OK.
- "unclear": the trend does not clearly fit any of the above, or there is not enough history yet to tell (e.g. early in the service).

Consider serviceElapsedMin and currentSongLabel/isWorshipSection if provided, but do not assume worship = automatically fine — a genuinely hot mix during worship is still drift. When genuinely unsure, prefer "unclear" and low confidence over guessing.

Respond ONLY with JSON, no markdown fences, matching:
{ "read": "drift"|"dynamics"|"ramp"|"unclear", "note": "one sentence, plain language, for a non-technical volunteer", "confidence": "low"|"medium"|"high" }`;

/**
 * Ask Claude for a contextual read on one alert event. Returns the raw
 * parsed response or null on any failure (missing key, network error, bad
 * JSON) — callers must treat null as "no annotation available", never as
 * a reason to alter the raw alert.
 */
export async function claudeLoudnessRead(payload) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(payload) }]
      })
    });
    if (!res.ok) {
      console.error('[loudness-advisor] API error', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error('[loudness-advisor] failed:', err.message);
    return null;
  }
}

/** Sanitize whatever Claude returned to a known shape. Returns null for a
 *  non-object (e.g. claudeLoudnessRead already returned null on failure) —
 *  never throws, so a malformed response degrades to "no annotation"
 *  instead of breaking the monitor. */
export function validate(advice) {
  if (!advice || typeof advice !== 'object') return null;
  return {
    read: READ_KINDS.includes(advice.read) ? advice.read : 'unclear',
    note: String(advice.note || '').slice(0, 160),
    confidence: CONFIDENCE_LEVELS.includes(advice.confidence) ? advice.confidence : 'low'
  };
}
