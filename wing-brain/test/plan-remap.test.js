// Tests for scripts/plan-remap.mjs.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, buildRemapPlan, toMarkdown, parseArgs, planRemap } from '../scripts/plan-remap.mjs';
import { channelStrip } from '../scripts/wing-schema.mjs';

const TARGET_LAYOUT = {
  ranges: [
    { start: 1, end: 3, label: 'Pastor + vocals' },
    { start: 4, end: 5, label: 'Drums' },
    { start: 6, end: 6, label: 'Vocal FX DCA return' },
    { start: 7, end: 9, label: 'Unassigned / spare' }
  ]
};

/** Build a minimal but well-formed dump: only the channels/userKeys given get
 *  real values seeded; every schema address not explicitly seeded is null,
 *  matching what dump-wing-state.mjs actually produces. */
function makeDump(channelSpecs, { userKeys = [] } = {}) {
  const channels = channelSpecs.map(({ index, name, sends = [], dca = [], muteGroups = [] }) => {
    const strip = channelStrip(index);
    const values = {};
    for (const addr of allAddresses(strip)) values[addr] = null;
    values[`/ch/${index}/name`] = [name];
    for (const busNum of dca) values[strip.dcaAssign.find((d) => d.dca === busNum).address] = [1];
    for (const g of muteGroups) values[strip.muteGroupAssign.find((m) => m.group === g).address] = [1];
    for (const s of sends) {
      const field = strip.sends.find((x) => x.bus === s.bus);
      values[field.on] = [1];
      values[field.level] = [s.level ?? -10];
    }
    return { kind: 'channel', index, path: `/ch/${index}`, values };
  });
  return {
    meta: { capturedAt: new Date(0).toISOString(), mock: true, source: 'mock' },
    channels, buses: [], mains: [], matrices: [], dcas: [], userKeys
  };
}

function allAddresses(strip) {
  const out = [];
  const walk = (n) => { if (typeof n === 'string') out.push(n); else if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') Object.values(n).forEach(walk); };
  const { kind, index, path: p, ...fields } = strip;
  walk(fields);
  return out;
}

/* ------------------------------ classify ------------------------------ */

test('classify matches instrument/role keywords to target-layout labels', () => {
  assert.equal(classify('Pastor Mic'), 'Pastor + vocals');
  assert.equal(classify('Kick In'), 'Drums');
  assert.equal(classify('Acoustic Gtr'), 'Guitars/bass + spares');
  assert.equal(classify('Piano'), 'Keys + spare');
  assert.equal(classify('Oscillator'), 'Oscillator / talkback');
});

test('classify resolves the "Crown mics" vs generic-vocal-mic collision correctly', () => {
  assert.equal(classify('Crown Mics'), 'Crown mics');
  assert.equal(classify('Guest Mic'), 'Pastor + vocals');
});

test('classify prefers "vox fx" over the broader "vocal" keyword', () => {
  assert.equal(classify('Vox FX Return'), 'Vocal FX DCA return');
});

test('classify returns null for a name matching no known category', () => {
  assert.equal(classify('Spare Line In'), null);
});

/* --------------------------- buildRemapPlan --------------------------- */

test('a channel already inside its target range is not moved', () => {
  const dump = makeDump([{ index: 2, name: 'Pastor Mic' }]);
  const plan = buildRemapPlan(dump, TARGET_LAYOUT);
  const move = plan.moves.find((m) => m.name === 'Pastor Mic');
  assert.equal(move.from, 2);
  assert.equal(move.to, 2);
  assert.equal(move.changed, false);
});

test('a channel outside its target range is moved into the first free slot', () => {
  const dump = makeDump([{ index: 8, name: 'Kick In' }]); // Drums range is 4-5, channel sits at 8
  const plan = buildRemapPlan(dump, TARGET_LAYOUT);
  const move = plan.moves.find((m) => m.name === 'Kick In');
  assert.equal(move.from, 8);
  assert.equal(move.to, 4, 'should take the first free slot in the Drums range');
  assert.equal(move.changed, true);
});

test('minimal disruption: an in-range channel is kept, only the out-of-range one relocates', () => {
  const dump = makeDump([
    { index: 5, name: 'Snare' },   // already in Drums range (4-5) -- keep
    { index: 9, name: 'Kick In' }  // outside -- must move into the range's other slot
  ]);
  const plan = buildRemapPlan(dump, TARGET_LAYOUT);
  const snare = plan.moves.find((m) => m.name === 'Snare');
  const kick = plan.moves.find((m) => m.name === 'Kick In');
  assert.equal(snare.to, 5, 'Snare stays put');
  assert.equal(kick.to, 4, 'Kick takes the one remaining free slot (not 5, which is taken)');
});

test('unclassified channels fall into the spare/unassigned range', () => {
  const dump = makeDump([{ index: 20, name: 'Mystery Line' }]);
  const plan = buildRemapPlan(dump, TARGET_LAYOUT);
  const move = plan.moves.find((m) => m.name === 'Mystery Line');
  assert.equal(move.category, 'Unassigned / spare');
  assert.ok(move.to >= 7 && move.to <= 9);
});

test('REAL layout: unclassified channels land in "Unassigned / spare", never in "Keys + spare"', () => {
  // Regression: the catch-all lookup used /unassigned|spare/i, which matched
  // "Keys + spare" (an instrument range that merely reserves a spare slot)
  // before the actual unassigned range — every unknown channel got crammed
  // into the 5 keys rows. Test against the REAL config, whose labels have
  // exactly that collision.
  const realLayout = JSON.parse(fs.readFileSync(new URL('../config/target-layout.json', import.meta.url), 'utf8'));
  const dump = makeDump([{ index: 3, name: 'Mystery Line' }]);
  const plan = buildRemapPlan(dump, realLayout);
  const move = plan.moves.find((m) => m.name === 'Mystery Line');
  assert.ok(move, 'unclassified channel should still get a placement');
  assert.equal(move.category, 'Unassigned / spare');
  assert.ok(move.to >= 26 && move.to <= 38, `should land in 26-38, got ${move.to}`);
});

test('a range with no free slots produces a warning and the channel is left unmoved', () => {
  const dump = makeDump([
    { index: 4, name: 'Kick In' }, { index: 5, name: 'Snare' }, // fill Drums (4-5)
    { index: 30, name: 'Tom 1' } // no room left
  ]);
  const plan = buildRemapPlan(dump, TARGET_LAYOUT);
  assert.ok(plan.warnings.some((w) => /No free slot in "Drums"/.test(w) && /channel 30/.test(w)));
  assert.ok(!plan.moves.some((m) => m.from === 30), 'unplaceable channel should not appear as a move');
});

test('empty/unnamed channels are ignored entirely', () => {
  const dump = makeDump([{ index: 1, name: '' }, { index: 2, name: 'Pastor Mic' }]);
  const plan = buildRemapPlan(dump, TARGET_LAYOUT);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].name, 'Pastor Mic');
});

/* --------------------------- reference chasing ------------------------- */

test('a moved channel carries its DCA, mute group, bus send, and user-key references', () => {
  const dump = makeDump(
    [{ index: 8, name: 'Kick In', dca: [2], muteGroups: [3], sends: [{ bus: 5, level: -6 }] }],
    { userKeys: [{ kind: 'userKey', index: 1, path: '/$ctl/userkeys/1', values: { '/$ctl/userkeys/1/target': ['/ch/8/mute'] } }] }
  );
  const plan = buildRemapPlan(dump, TARGET_LAYOUT);
  const move = plan.moves.find((m) => m.name === 'Kick In');
  assert.deepEqual(move.references.dca, [2]);
  assert.deepEqual(move.references.muteGroups, [3]);
  assert.deepEqual(move.references.sends, [{ bus: 5, level: -6 }]);
  assert.deepEqual(move.references.userKeys, [1]);
});

test('unmoved channels carry no references object (nothing to chase)', () => {
  const dump = makeDump([{ index: 2, name: 'Pastor Mic', dca: [1] }]);
  const plan = buildRemapPlan(dump, TARGET_LAYOUT);
  const move = plan.moves.find((m) => m.name === 'Pastor Mic');
  assert.equal(move.changed, false);
  assert.equal(move.references, undefined);
});

/* -------------------------------- markdown ----------------------------- */

test('toMarkdown lists moves, unchanged channels, and warnings in separate sections', () => {
  const dump = makeDump([
    { index: 2, name: 'Pastor Mic' },
    { index: 8, name: 'Kick In', dca: [1] }
  ]);
  const plan = buildRemapPlan(dump, TARGET_LAYOUT);
  const md = toMarkdown(plan, dump.meta);
  assert.match(md, /## Moves/);
  assert.match(md, /Kick In/);
  assert.match(md, /DCA 1/);
  assert.match(md, /## Already correctly placed/);
  assert.match(md, /Pastor Mic/);
});

/* -------------------------------- CLI ----------------------------------- */

test('parseArgs reads --dump, --dump-dir, --target, --out-json, --out-md', () => {
  const args = parseArgs(['--dump', 'a.json', '--dump-dir', 'somedir', '--target', 'b.json', '--out-json', 'c.json', '--out-md', 'd.md']);
  assert.equal(args.dump, 'a.json');
  assert.equal(args.dumpDir, 'somedir');
  assert.equal(args.target, 'b.json');
  assert.equal(args.outJson, 'c.json');
  assert.equal(args.outMd, 'd.md');
});

/* ------------------------------- planRemap ------------------------------ */

test('planRemap reads a dump + target layout from disk and writes plan.json + plan.md', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-remap-'));
  const dumpPath = path.join(tmp, 'dump.json');
  const targetPath = path.join(tmp, 'target.json');
  fs.writeFileSync(dumpPath, JSON.stringify(makeDump([{ index: 8, name: 'Kick In' }])));
  fs.writeFileSync(targetPath, JSON.stringify(TARGET_LAYOUT));

  const outJson = path.join(tmp, 'out', 'plan.json');
  const outMd = path.join(tmp, 'out', 'plan.md');
  const { plan } = planRemap({ dump: dumpPath, target: targetPath, outJson, outMd });

  assert.ok(fs.existsSync(outJson));
  assert.ok(fs.existsSync(outMd));
  assert.equal(JSON.parse(fs.readFileSync(outJson, 'utf8')).moves.length, plan.moves.length);
  assert.match(fs.readFileSync(outMd, 'utf8'), /Kick In/);
});

test('planRemap falls back to the most recent file in --dump-dir when --dump is omitted', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-remap-latest-'));
  const dumpDir = path.join(tmp, 'dumps');
  fs.mkdirSync(dumpDir);
  fs.writeFileSync(path.join(dumpDir, '2020-01-01T00-00-00-000Z.json'), JSON.stringify(makeDump([{ index: 1, name: 'Old Dump' }])));
  fs.writeFileSync(path.join(dumpDir, '2030-01-01T00-00-00-000Z.json'), JSON.stringify(makeDump([{ index: 1, name: 'New Dump' }])));
  fs.writeFileSync(path.join(tmp, 'target.json'), JSON.stringify(TARGET_LAYOUT));

  const { dumpPath, plan } = planRemap({
    dumpDir, target: path.join(tmp, 'target.json'),
    outJson: path.join(tmp, 'out.json'), outMd: path.join(tmp, 'out.md')
  });

  assert.match(dumpPath, /2030-01-01/);
  assert.equal(plan.moves[0].name, 'New Dump');
});

test('planRemap throws a clear error when no dump is available', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wing-remap-empty-'));
  assert.throws(
    () => planRemap({ dumpDir: path.join(tmp, 'nonexistent'), target: path.join(tmp, 'missing-target.json') }),
    /No dump file given/
  );
});
