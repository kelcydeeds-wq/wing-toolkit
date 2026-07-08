# Church session run-sheet

Exact steps for the on-site audit + remap + tune session, in order. Every
step has a **Rollback** line — read it before you run the step, not after
something goes wrong.

**Ground rules for the day:**
- Nothing in Part B (dump/plan/apply-remap/record) has ever touched a real
  Wing. Every OSC address it uses is a best guess (`scripts/wing-schema.mjs`
  is marked `TODO(church)` throughout) — assume it's wrong until the dump
  proves otherwise, and go slowly.
- `apply-remap.mjs` defaults to dry-run. Do not add `--execute` until you've
  read the plan and trust it.
- Stop and reassess (don't push through) if: a dump answers close to 0%
  of addresses, a dry-run apply shows 0 source parameters read for every
  channel, or an execute run aborts on a verify mismatch.
- Replace `192.168.1.50` / `2223` below with the real console IP/port if
  different from `config/default.json`'s current values (`--host`/`--port`
  override on every script).

All commands run from the `wing-brain/` directory.

---

## 0. Full Wing scene/show backup to USB

**Manual, on the console.** Save the current show/scene to a USB drive.
Reload it to confirm the backup is actually readable before doing anything
else — a backup you haven't verified isn't a backup.

**Rollback:** N/A — this step *is* the rollback for everything that follows.
Do not proceed past this step without a verified backup in hand.

---

## 1. Dump the current Wing state

```
node scripts/dump-wing-state.mjs --host 192.168.1.50 --port 2223
```

Writes `data/wing-state/<timestamp>.json` and prints an answered/total count
at the end.

- **If the answered count is near 0%:** the address scheme in
  `scripts/wing-schema.mjs` is wrong (expected on the first real run — see
  Ground rules). Use whatever OSC monitoring you have on hand (Wing's own
  OSC log if it has one, Wireshark, a generic OSC monitor app) against a
  single channel to find the real address pattern, fix
  `scripts/wing-schema.mjs`, and re-run this step. Every other tool reads
  its addresses from that one file, so fixing it here fixes everything
  downstream.
- **If it's answering a reasonable fraction** (channels you know are patched
  show real names/gains, empty channels show null): proceed.

**Rollback:** N/A — read-only, touches nothing on the console.

---

## 2. Build the remap plan

```
node scripts/plan-remap.mjs --dump data/wing-state/<the file from step 1>.json
```

Writes `data/remap-plans/<timestamp>.remap.json` and a matching `.md` table.
Prints the move/warning count.

**Rollback:** N/A — read-only, only writes plan files.

---

## 3. Review the plan (required — do not skip)

Open the `.md` file from step 2. For every row in **Moves**:

- Does the channel name make sense for its assigned category? Classification
  is keyword-matching on the channel name (see `plan-remap.mjs`'s
  `CATEGORY_KEYWORDS`) and can be wrong, especially for ambiguous or
  abbreviated names.
- Check the **Downstream refs** column — every DCA/mute-group/bus-send/user-key
  reference listed there moves with the channel. If something looks missing
  (e.g. you know a channel feeds a monitor mix but no send shows up), the
  bus-send address guess in `wing-schema.mjs` is probably wrong — fix it and
  regenerate the plan (step 2) before continuing.
- Read the **Warnings** section. A "no free slot" warning means a target
  range is oversubscribed — decide by hand whether to widen the range in
  `config/target-layout.json` or manually reassign in the JSON.

To correct a wrong move: hand-edit `data/remap-plans/<file>.remap.json`
directly (change `to`, drop the entry, whatever's needed) — apply-remap
reads whatever is in that file, it doesn't recompute anything.

**Rollback:** N/A — editing a plan file on disk affects nothing live.

---

## 4. Apply-remap dry run

```
node scripts/apply-remap.mjs --remap data/remap-plans/<file>.remap.json --host 192.168.1.50 --port 2223
```

No `--execute` — this only reads. Check:

- Each move logs `read N/91 source parameters`. If N is consistently 0
  across every channel, the address scheme is still wrong — stop, go back
  to step 1's troubleshooting note.
- If N looks reasonable (roughly matches what you'd expect a patched channel
  to have set), the addresses are working well enough to proceed.

**Rollback:** N/A — dry-run never writes.

---

## 5. Single-channel trial (do this before the full execute)

Hand-edit a throwaway copy of the remap JSON down to just **one** low-risk
channel (a spare or a channel that's easy to visually confirm, not something
mid-song-critical), then:

```
node scripts/apply-remap.mjs --remap <one-channel-copy>.remap.json --host 192.168.1.50 --port 2223 --execute
```

Walk over to the console and visually confirm: the destination channel has
the right name, gain, fader position, mute state, and (if applicable) EQ
matches the source. This is the first time this whole toolchain has touched
real hardware — confirm it did what it says before trusting it for 40
channels at once.

**Rollback:** The moved channel's *old* number still has its original
settings (apply-remap doesn't touch the source unless you pass
`--clear-source`, which you should not do yet). To undo: either manually
reset the destination channel on the console, or reload the step 0 backup.

---

## 6. Execute the full remap

```
node scripts/apply-remap.mjs --remap data/remap-plans/<file>.remap.json --host 192.168.1.50 --port 2223 --execute
```

Watch the log. Each channel move prints `verified OK` or `VERIFY FAILED`.

- **If it aborts on a verify failure:** it stops immediately — no further
  moves are attempted. The moves that already printed `verified OK` before
  the failure *are* live on the console; the failed one and everything after
  it were never attempted.
- Note which channel failed and why (the log prints the specific address and
  expected-vs-got values) before deciding how to proceed.

**Rollback:**
- **Full rollback:** reload the step 0 USB backup. This undoes every move
  in this run, applied or not.
- **Partial/targeted fix:** manually correct just the failed channel (or
  whichever channels look wrong) directly on the console — the already-applied
  moves before the failure don't need to be touched if they verified fine.

---

## 7. Verify on the console

Physically walk the room (or at least walk the channel strips):

- Confirm every moved channel passes audio at its new number.
- Confirm mute, fader, and any DCA/mute-group membership behave as expected
  at the new channel number.
- Optionally, re-run step 1's dump and compare names/positions against the
  remap plan to confirm the new layout stuck exactly as applied.

**Rollback:** Same as step 6 — full USB reload, or manual per-channel fixes.

---

## 8. Save new baseline scene + fresh backup

**Manual, on the console.** Once the remap is confirmed working, save it as
the new baseline scene, then back that up to USB. This is the new "step 0"
for any future session.

**Rollback:** N/A — this step exists to make sure there's a recovery point
*after* today's changes, same as step 0 was the recovery point before them.

---

## 9. Run the tune

Before this step, in the wing-brain repo:

- Fill in the real Wing output OSC addresses in `src/wing/client.js`'s
  `TODO(church)` markers (output section addresses, EQ/delay scheme) — use
  whatever you confirmed while fixing `wing-schema.mjs` in step 1.
- Verify the live audio capture path in `src/audio/io.js` against the
  SoundGrid ASIO device (device names, channel mapping) — also marked
  `TODO(church)`.
- Set `config/default.json`'s top-level `"mode"` to `"live"` (or run with
  `MODE=live npm start` without changing the file).

Then:

```
npm start
```

Open the printed address on the touchscreen/phone.

1. **Verify System** first (~2 min, 1 position, writes nothing) — confirms
   delay/level/polarity read sanely on the real outputs before committing to
   a full walk.
2. **Full Tune** — walk all positions. Review the recommendations screen
   (Claude's tuning, or the local fallback if `ANTHROPIC_API_KEY` isn't set
   in `.env`). Use the per-position overlay toggle on any output whose curve
   looks like it's averaging across genuinely different rooms (high
   variance) before trusting a correction there.
3. **Apply** only after reading the recommendations — this is the one path
   in the whole app that writes to the console, gated behind the tap and a
   confirm dialog on purpose.

**Rollback:**
- Before Apply: tap **Discard** — nothing was written, no rollback needed.
- After Apply: reload the step 8 baseline scene. The applied session's exact
  JSON is also downloadable from the review screen (or the Recent Sessions
  list on the home screen) for reference if you need to see exactly what was
  written.

---

## 10. Record OSC traffic during rehearsal

```
npm run record -- --host 192.168.1.50 --port 2223
```

Let it run during rehearsal (~1 hour is plenty), then Ctrl+C. Writes to
`data/osc-recordings/<timestamp>.jsonl`.

This captures real console traffic for future mock-replay-driven development
(`node scripts/record-osc.mjs --replay <file> --mock`) — nothing about this
step is destructive or session-critical, it's purely for later.

**Rollback:** N/A — read-only capture, no writes to the console.

---

## Wrap-up

- `data/` is gitignored — none of today's dumps, remap plans, session
  history, or recordings are preserved by git. Copy the whole `data/`
  directory off the mini PC to a backup location before you leave.
- Fill in `CHECKLIST.md`'s RESULTS section (B0.1–B0.4) if this session also
  covered the REAPER/OSC bench tests.
- Note anything that surprised you — wrong addresses found, warnings that
  needed manual fixes, anything that felt riskier than expected — in
  `docs/DECISIONS.md` so the next session starts smarter than this one did.
