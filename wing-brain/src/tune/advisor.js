// advisor.js — Claude as the tuning brain.
//
// Division of labor (same as the whole system):
//   code measures  → sweeps, IRs, transfer functions, averaging   (measure.js)
//   Claude judges  → what the curves MEAN and what to do          (this file)
//   code enforces  → guardrails clamp whatever comes back         (validate())
//   local fallback → heuristic recommender if offline             (tune.js)
//
// One Full Tune = one API call. Cost: pennies.
//
// Setup: set ANTHROPIC_API_KEY in the environment (or .env) on the brain box.
// Without a key, the app silently uses the local recommender and marks the
// result "source: local".

import { recommendEQ, recommendDelays, spatialAverage, targetOnGrid } from '../dsp/tune.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

/**
 * Build the compact analysis payload Claude reasons over.
 * Curves are downsampled to ~48 log-spaced points — plenty for tonal judgment,
 * tiny on the wire.
 */
export function buildAnalysisPayload({ config, room, results, localRec }) {
  const ds = (freqs, arr, n = 48) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const idx = Math.round((i / (n - 1)) * (freqs.length - 1));
      out.push([Math.round(freqs[idx]), Math.round(arr[idx] * 10) / 10]);
    }
    return out;
  };

  const outputs = {};
  for (const output of config.outputs) {
    const rs = results.filter((r) => r.outputId === output.id);
    if (!rs.length) continue;
    const weighted = rs.filter((r) => r.positionWeight > 0);
    const { avg, varDb } = spatialAverage(
      (weighted.length ? weighted : rs).map((r) => ({
        magDb: Float64Array.from(r.magDb), weight: r.positionWeight || 1
      }))
    );
    const grid = Float64Array.from(rs[0].freqs);
    const target = targetOnGrid(config.targetCurve.points, grid);
    outputs[output.id] = {
      label: output.label,
      band: output.band,
      avgResponseDb: ds(grid, avg),
      positionVarianceDb: ds(grid, varDb),
      targetDb: ds(grid, target),
      delaysMsByPosition: Object.fromEntries(rs.map((r) => [r.positionId, Math.round(r.delayMs * 10) / 10])),
      polarity: rs.map((r) => r.polarity),
      levelsDbfs: rs.map((r) => r.levelDbfs)
    };
  }

  return {
    room: {
      name: room.name,
      widthM: room.width, mainFloorDepthM: room.depthMain,
      balcony: room.balcony, speakers: room.speakers,
      positions: room.positions.map(({ id, label, zone, x, y, z, weight }) =>
        ({ id, label, zone, x, y, z, weight }))
    },
    guardrails: config.guardrails,
    targetCurveName: config.targetCurve.name,
    outputs,
    localRecommendation: localRec ? {
      note: 'heuristic fallback recommender output — improve on it, ignore it, or endorse it',
      perOutput: Object.fromEntries(Object.entries(localRec.perOutput).map(
        ([id, o]) => [id, o.filters])),
      delays: localRec.delays,
      zoneReport: localRec.zoneReport
    } : null
  };
}

const SYSTEM_PROMPT = `You are the tuning engineer for a church PA (worship band + speech), analyzing multi-position transfer-function measurements. You receive per-output spatially-averaged magnitude responses, position variance, delay/polarity/level data, room geometry, and a heuristic recommender's attempt.

Reason like a system tech: distinguish room modes from speaker response from position-dependent interference (high variance = don't EQ it). Below ~300 Hz be surgical where variance is low. Above, shape broadly toward the target tilt; never chase narrow HF features from averaged data. Prefer cuts. Boosts only into stable, broad dips, wide Q. Respect each output's passband. Consider crossover-region interaction between subs and mains when judging the low end. Flag polarity or geometry anomalies rather than EQing around them.

Respond ONLY with JSON, no markdown fences, matching:
{
  "summary": "2-4 sentences on what the room is doing and your strategy",
  "outputs": {
    "<outputId>": {
      "filters": [{"type":"peq|hshelf|lshelf","freq":Hz,"gainDb":n,"q":n,"reason":"short"}],
      "note": "one sentence"
    }
  },
  "delays": { "<outputId>": { "addDelayMs": n } },
  "warnings": ["anything the operator should check physically"]
}
Filters must respect the provided guardrails (they are clamped in code afterward regardless). Delay recommendations should align arrivals at the weighted listening area; omit outputs you would leave alone.`;

/**
 * Ask Claude for the tuning. Returns { source, summary, perOutputFilters,
 * delays, warnings } or null on any failure (caller falls back to local).
 */
export async function claudeTune(payload) {
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
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(payload) }]
      })
    });
    if (!res.ok) {
      console.error('[advisor] API error', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const text = (data.content || []).map((c) => c.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return parsed;
  } catch (err) {
    console.error('[advisor] failed:', err.message);
    return null;
  }
}

/** Clamp whatever came back to the guardrails. Code-enforced, always. */
export function validate(advice, config) {
  const g = config.guardrails;
  const out = { outputs: {}, delays: advice.delays || {}, summary: advice.summary || '',
                warnings: advice.warnings || [] };
  for (const output of config.outputs) {
    const a = advice.outputs?.[output.id];
    if (!a) continue;
    const band = output.band || [40, 16000];
    const filters = (a.filters || [])
      .filter((f) => Number.isFinite(f.freq) && Number.isFinite(f.gainDb))
      .filter((f) => f.freq >= Math.max(g.minFilterHz, band[0] * 0.8) && f.freq <= band[1] * 1.2)
      .filter((f) => !(f.gainDb > 0 && f.freq < g.noBoostBelowHz))
      .slice(0, g.maxFiltersPerOutput)
      .map((f) => ({
        type: ['peq', 'hshelf', 'lshelf'].includes(f.type) ? f.type : 'peq',
        freq: Math.round(f.freq),
        gainDb: clamp(f.gainDb, -g.maxCutDb, g.maxBoostDb),
        q: clamp(f.q ?? 1.4, g.minQ, f.gainDb > 0 ? g.maxBoostQ : g.maxQ),
        reason: String(f.reason || '').slice(0, 80)
      }));
    out.outputs[output.id] = { filters, note: String(a.note || '').slice(0, 200) };
  }
  for (const [id, d] of Object.entries(out.delays)) {
    if (id.startsWith('_')) continue;
    out.delays[id] = { addDelayMs: clamp(Number(d.addDelayMs) || 0, 0, 200) };
  }
  return out;
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
