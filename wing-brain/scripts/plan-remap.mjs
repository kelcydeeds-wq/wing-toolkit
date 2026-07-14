#!/usr/bin/env node
// plan-remap.mjs — turn a dump-wing-state.mjs capture + config/target-layout.json
// into a channel remap plan: a human-readable markdown table plus a machine
// remap.json that apply-remap.mjs executes.
//
// Classification (which channel belongs in which target range) is a keyword
// guess against the channel name -- see CATEGORY_KEYWORDS below. This is
// exactly why the church-session run-sheet has a manual "review" step
// between plan-remap and apply-remap: read the markdown table before
// anything gets executed, fix any wrong bucket by hand.
//
// For every channel the plan actually moves, it chases downstream
// references -- DCA membership, mute group membership, bus sends, and any
// custom/user key that targets that channel -- so nothing silently breaks
// when the channel number changes.
//
// Usage:
//   node scripts/plan-remap.mjs --dump data/wing-state/<file>.json
//   node scripts/plan-remap.mjs            # uses the most recent dump

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelStrip, readValue, parseTags } from './wing-schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/**
 * Keyword → target-layout label. Checked in order, first match wins, so
 * more specific categories are listed before broader ones (e.g. "vox fx"
 * before the generic vocal keywords). Coupled to the exact label strings in
 * config/target-layout.json -- if you rename a range there, update this too.
 */
const CATEGORY_KEYWORDS = [
  ['Vocal FX DCA return', ['vox fx', 'fx return', 'vocal fx']],
  ['Pastor + vocals', ['pastor', 'vocal', 'choir', 'guest mic', 'vox mic', 'lead vox']],
  ['Keys + spare', ['piano', 'keys', 'organ', 'synth']],
  ['Guitars/bass + spares', ['gtr', 'guitar', 'bass']],
  ['Drums', ['kick', 'snare', 'hat', 'tom', 'oh l', 'oh r', 'overhead', 'drum', 'cymbal']],
  ['Crown mics', ['crown']],
  ['Oscillator / talkback', ['oscillator', 'talkback', 'osc']]
];

export function classify(name) {
  const n = name.toLowerCase();
  for (const [label, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((k) => n.includes(k))) return label;
  }
  return null;
}

/** Assign a category's channels to a target range, minimizing moves: keep
 *  any channel already inside the range where it is, only relocate the ones
 *  that are currently outside it. */
function planCategory(range, channels) {
  const inRange = channels.filter((c) => c.index >= range.start && c.index <= range.end);
  const outOfRange = channels.filter((c) => !(c.index >= range.start && c.index <= range.end));
  const usedSlots = new Set(inRange.map((c) => c.index));
  const freeSlots = [];
  for (let s = range.start; s <= range.end; s++) if (!usedSlots.has(s)) freeSlots.push(s);

  const moves = inRange.map((c) => ({ from: c.index, to: c.index, changed: false }));
  for (const c of outOfRange) {
    const to = freeSlots.shift();
    moves.push(to === undefined
      ? { from: c.index, to: null, changed: false }
      : { from: c.index, to, changed: true });
  }
  return moves;
}

/** Every downstream reference to a channel that must move with it. */
function chaseReferences(dump, channelIndex) {
  const strip = channelStrip(channelIndex);
  const chanDump = dump.channels.find((c) => c.index === channelIndex);
  const values = chanDump ? chanDump.values : {};

  // DCA + mute-group membership come from the channel's `tags` string
  // (e.g. "#D1,#D6,#M3"), confirmed against the real console 2026-07-14.
  const { dca, muteGroups } = parseTags(values[strip.tags]);
  const sends = strip.sends
    .filter((s) => readValue(values[s.on]))
    .map((s) => ({ bus: s.bus, level: readValue(values[s.level]) }));
  const userKeys = (dump.userKeys || [])
    .filter((uk) => {
      const target = readValue(uk.values[`${uk.path}/target`]);
      return typeof target === 'string' && target.includes(`/ch/${channelIndex}/`);
    })
    .map((uk) => uk.index);

  return { dca, muteGroups, sends, userKeys };
}

/**
 * Build the full remap plan from a dump-wing-state.mjs capture and a
 * target-layout config. Pure function — no file I/O — so it's easy to test.
 */
export function buildRemapPlan(dump, targetLayout) {
  const named = dump.channels
    .map((c) => ({ index: c.index, name: readValue(c.values[`/ch/${c.index}/name`]) }))
    .filter((c) => typeof c.name === 'string' && c.name.trim().length > 0);

  const byLabel = new Map(targetLayout.ranges.map((r) => [r.label, []]));
  const unclassified = [];
  for (const c of named) {
    const label = classify(c.name);
    if (label && byLabel.has(label)) byLabel.get(label).push(c);
    else unclassified.push(c);
  }

  // The catch-all range for unclassifiable channels. "unassigned" first —
  // a bare /spare/ match would grab "Keys + spare" / "Guitars/bass + spares"
  // (instrument ranges that merely RESERVE spare slots) before the actual
  // unassigned range, dumping every unknown channel into the keys rows.
  const spareRange = targetLayout.ranges.find((r) => /unassigned/i.test(r.label))
    ?? targetLayout.ranges.find((r) => /^spare/i.test(r.label));
  if (spareRange) byLabel.get(spareRange.label).push(...unclassified);

  const warnings = [];
  const moves = [];
  for (const range of targetLayout.ranges) {
    const chans = (byLabel.get(range.label) || []).slice().sort((a, b) => a.index - b.index);
    for (const m of planCategory(range, chans)) {
      const chan = chans.find((c) => c.index === m.from);
      if (m.to === null) {
        warnings.push(`No free slot in "${range.label}" (${range.start}-${range.end}) for channel ${m.from} "${chan.name}" — needs manual placement.`);
        continue;
      }
      moves.push({ from: m.from, to: m.to, name: chan.name, category: range.label, changed: m.changed });
    }
  }

  if (unclassified.length && !spareRange) {
    for (const c of unclassified) warnings.push(`Could not classify channel ${c.index} "${c.name}" into any target range (no spare/unassigned range to fall back to).`);
  }

  for (const move of moves) {
    if (move.changed) move.references = chaseReferences(dump, move.from);
  }

  return { moves, warnings, generatedAt: new Date().toISOString() };
}

function describeRefs(refs) {
  if (!refs) return '—';
  const parts = [];
  if (refs.dca.length) parts.push(`DCA ${refs.dca.join(',')}`);
  if (refs.muteGroups.length) parts.push(`Mute grp ${refs.muteGroups.join(',')}`);
  if (refs.sends.length) parts.push(`Sends → bus ${refs.sends.map((s) => s.bus).join(',')}`);
  if (refs.userKeys.length) parts.push(`User key ${refs.userKeys.join(',')}`);
  return parts.length ? parts.join('; ') : 'none';
}

export function toMarkdown(plan, dumpMeta) {
  const changed = plan.moves.filter((m) => m.changed);
  const unchanged = plan.moves.filter((m) => !m.changed);
  let md = `# Channel remap plan\n\n`;
  md += `Generated ${plan.generatedAt} from a dump captured ${dumpMeta?.capturedAt ?? 'unknown time'} `;
  md += `(${dumpMeta?.mock ? 'MOCK' : dumpMeta?.source ?? 'unknown source'}).\n\n`;
  md += `**Review this table before running apply-remap.** Classification is keyword-based and can be wrong — fix \`from\`/\`to\` by hand in remap.json if a channel landed in the wrong category.\n\n`;
  md += `${changed.length} channel(s) move, ${unchanged.length} already correctly placed.\n\n`;

  md += `## Moves\n\n| Old Ch | New Ch | Name | Category | Downstream refs |\n|---|---|---|---|---|\n`;
  for (const m of changed) {
    md += `| ${m.from} | ${m.to} | ${m.name} | ${m.category} | ${describeRefs(m.references)} |\n`;
  }
  if (!changed.length) md += `| — | — | — | — | — |\n`;

  if (unchanged.length) {
    md += `\n## Already correctly placed\n\n| Ch | Name | Category |\n|---|---|---|\n`;
    for (const m of unchanged) md += `| ${m.from} | ${m.name} | ${m.category} |\n`;
  }

  if (plan.warnings.length) {
    md += `\n## Warnings\n\n` + plan.warnings.map((w) => `- ${w}`).join('\n') + '\n';
  }
  return md;
}

/* ------------------------------- CLI ------------------------------- */

export function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dump') args.dump = argv[++i];
    else if (a === '--dump-dir') args.dumpDir = argv[++i];
    else if (a === '--target') args.target = argv[++i];
    else if (a === '--out-json') args.outJson = argv[++i];
    else if (a === '--out-md') args.outMd = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`Unknown argument: ${a}`); printHelp(); process.exit(1); }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/plan-remap.mjs [options]

  --dump <file>     A dump-wing-state.mjs JSON capture (default: most recent
                     file in --dump-dir).
  --dump-dir <dir>  Directory to look for the most recent dump in when
                     --dump is omitted (default: data/wing-state).
  --target <file>   Target layout config (default: config/target-layout.json).
  --out-json <file> Machine remap plan (default: data/remap-plans/<timestamp>.json).
  --out-md <file>   Human-readable table (default: same path, .md).
`);
}

function findLatestDump(dumpDir) {
  if (!fs.existsSync(dumpDir)) return null;
  const files = fs.readdirSync(dumpDir).filter((f) => f.endsWith('.json')).sort();
  return files.length ? path.join(dumpDir, files[files.length - 1]) : null;
}

function defaultOutPaths() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(root, 'data/remap-plans');
  return { outJson: path.join(dir, `${stamp}.remap.json`), outMd: path.join(dir, `${stamp}.remap.md`) };
}

export function planRemap(args) {
  const dumpDir = args.dumpDir ? path.resolve(args.dumpDir) : path.join(root, 'data/wing-state');
  const dumpPath = args.dump || findLatestDump(dumpDir);
  if (!dumpPath) throw new Error(`No dump file given and none found in ${dumpDir} — run dump-wing-state.mjs first.`);
  const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf8'));

  const targetPath = args.target || path.join(root, 'config/target-layout.json');
  const targetLayout = JSON.parse(fs.readFileSync(targetPath, 'utf8'));

  const plan = buildRemapPlan(dump, targetLayout);
  const md = toMarkdown(plan, dump.meta);

  const defaults = defaultOutPaths();
  const outJson = path.resolve(args.outJson || defaults.outJson);
  const outMd = path.resolve(args.outMd || defaults.outMd);
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.mkdirSync(path.dirname(outMd), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(plan, null, 2));
  fs.writeFileSync(outMd, md);

  return { plan, dumpPath, outJson, outMd };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { plan, dumpPath, outJson, outMd } = planRemap(parseArgs(process.argv.slice(2)));
    console.log(`Dump:   ${dumpPath}`);
    console.log(`Plan:   ${outJson}`);
    console.log(`Table:  ${outMd}`);
    console.log(`${plan.moves.filter((m) => m.changed).length} move(s), ${plan.warnings.length} warning(s).`);
    if (plan.warnings.length) plan.warnings.forEach((w) => console.warn(`  ! ${w}`));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
