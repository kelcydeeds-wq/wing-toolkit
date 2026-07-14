# Wing Toolkit — project context for Claude Code

Read this first, every session. It exists so a fresh session (office or
church) doesn't have to rediscover the project from scratch.

## What this is

An AI-assisted live-mixing system built around a **Behringer Wing** console
at a church. "wing-brain" (in `wing-brain/`) is the first module: a
phone-driven **PA measurement/tuning tool** — walk the room with a reference
mic, run guided sweeps, get delay-alignment + guarded EQ recommendations
toward a worship target curve, apply with one tap (with a one-tap revert).

The longer-term system (per the master build plan — see "Master plan doc"
below) is a three-tier architecture:

1. **Behringer Wing console** — the physical mixer. Audio I/O and the mix
   engine live here. Everything else talks to it over OSC (UDP,
   address-per-parameter). See "Confirmed OSC address map" below.
2. **Mini PC ("the brain box")** — runs `wing-brain` (this repo) for
   measurement/tuning, and (pending the B0 bench test in `CHECKLIST.md`)
   either **REAPER** or **SuperRack Performer** for real-time vocal/
   instrument plugin chains (pitch correction, dynamics, etc.), connected to
   the Wing via a SoundGrid card. REAPER is controlled over OSC too
   (`scripts/test-reaper-osc.mjs`, `scripts/list-fx-params.lua`,
   `scripts/select_follow.lua` at the toolkit root).
3. **Phone / touchscreen** — the control surface. `wing-brain`'s UI is a
   phone-first web app (any browser on the same WiFi, no app install). The
   mini PC's 15" touchscreen will eventually get a custom layout for the
   REAPER/SuperRack side once B0.3 identifies what's annoying about the
   stock plugin windows.

**Which of REAPER vs SuperRack tier 2 actually uses is not decided yet** —
that's `CHECKLIST.md`'s bench test B0. Don't assume one over the other.

## Confirmed OSC address map

Every Wing OSC address used to be a guess. As of the 2026-07-10 church visit,
the addresses are **confirmed against the real console spec** and live in
one place: `wing-brain/scripts/wing-schema.mjs` (shared by
`dump-wing-state.mjs`, `plan-remap.mjs`, `apply-remap.mjs`, and
`src/wing/client.js` — they must never disagree with each other). Key
corrected shapes, so you don't have to re-derive them:

- Fader: `/<kind>/<n>/fdr` (channel/bus/main/mtx/dca) — not `"fader"`.
- Mains are numbered `/main/1..4` — **there is no `"lr"` stereo bus.**
- Channel name/color: `/ch/<n>/name`, `/ch/<n>/col` — not `config/name`.
- EQ bands are flat leaves: `/eq/1f /eq/1g /eq/1q` (not nested). Channels
  additionally have fixed low/high shelf bands `/eq/lf|lg|lq|leq` and
  `/eq/hf|hg|hq|heq`. Buses/mains/mtx have **6 numbered bands, no shelf**.
- Dynamics attack/release: `/dyn/att`, `/dyn/rel`.
- HPF: `/ch/<n>/flt/lc` (on/off), `/ch/<n>/flt/lcf` (freq) — not
  `preamp/hpf`.
- Sends: `/ch/<n>/send/<bus>/lvl`, `/send/<bus>/on` — not `"mix"`.
- Main assigns (separate from sends): `/ch/<n>/main/<n>/on`,
  `/main/<n>/lvl`.
- **Output delay** (confirmed live 2026-07-14): `/<out>/dly/dly` (value) +
  `/<out>/dly/on` + `/<out>/dly/mode` — NOT `/<out>/delay` (that address is a
  no-op; the app used to write it). `mode` units token: `MS` ms, `M` meters,
  `FT` feet, `SMP` samples. The recommender works in ms, so write `MS` first.
- **USB audio I/O routing** (the mini-PC's interface = the "USB" group):
  Wing→PC feed is `/io/out/USB/<n>/grp` (source group, e.g. `MAIN`) +
  `/io/out/USB/<n>/in` (index). PC→Wing is a source group `USB` selected on a
  channel via `/ch/<n>/in/conn/grp` = `USB`, `/ch/<n>/in/conn/in` = <ch>.
  Confirmed groups: `/io/in` = [LCL,AUX,A,B,C,SC,USB,CRD,MOD,PLAY,AES,USR,OSC,…];
  `/io/out` = [LCL,AUX,A,B,C,SC,USB,CRD,MOD,REC,AES]. `usbacfg` = "48/48".
- **Gain is not a channel address.** A channel's input gain and
  phantom/invert live on the physically patched I/O slot: read
  `/ch/<n>/in/conn/grp` + `/ch/<n>/in/conn/in` first, then query
  `/io/in/<grp>/<in>/g` and `/io/in/<grp>/<in>/vph`.
- **Wing OSC replies are 3-element arrays** — `[displayString,
  normalizedFloat 0-1, rawValue]`, not a single value. Use `readValue()`
  from `wing-schema.mjs` to interpret one (never index `[0]` directly for
  truthy/numeric checks — the display string is truthy either way).
- **DCA/mute-group membership** (confirmed live 2026-07-14): a single
  comma-separated string at `/ch/<n>/tags` (and `/bus/<n>/tags`), where
  `#D<k>` = member of DCA k and `#M<k>` = member of mute group k (custom tags
  preserved). NOT the old per-index `/ch/<n>/grp/dca/<k>` boolean (that was
  wrong — all null). Parse/build with `parseTags()`/`formatTags()` in
  `wing-schema.mjs`.
- **Still unconfirmed, marked `TODO(church)`, do not guess:** physical output
  patch addresses + test-signal injection point (both gated `confirmed:false`),
  aux/group bus count, matrix count, DCA count, mute-group count,
  custom/user-key addresses.
- **Discovery technique:** querying a *container* address with no args (e.g.
  `/ch/2`) makes the Wing reply with its child node names — walk that tree to
  confirm any unknown address instead of guessing.

Full rationale for every corrected address is in
`wing-brain/docs/DECISIONS.md` under "Wing OSC address correction".

## The guardrails rule: enforced in code, never relaxed

`wing-brain`'s auto-EQ has hard safety limits (`src/dsp/tune.js`,
documented in `wing-brain/README.md` under "Guardrails"): auto-EQ only below
`eqAutoMaxHz` (default 300 Hz), tilt-only above that, never boosts into a
detected null, max cut 6 dB / max boost 3 dB / max 8 filters per output,
and **nothing is written to the Wing without an explicit Apply tap** (baseline
saved first, one-tap revert).

**These numeric limits are not to be loosened by an AI session, ever** —
not for a task that seems to need it, not as a "temporary" test change. If a
task appears to require raising a guardrail, stop and ask the user; don't
edit the limit. This has held throughout the project's refinement work (see
`docs/DECISIONS.md`) and is the one rule that overrides "just make the tests
pass."

## Where to look next

- **`CHECKLIST.md`** (toolkit root) — the actual step-by-step punch list:
  office bench tests, hardware arrival steps, the B0 REAPER-vs-SuperRack
  decision test, the church session agenda, and a results section to fill
  in. This is the operational source of truth for "what's next."
- **Master plan doc** — `wing-brain/README.md` references a
  `MASTER_BUILD_PLAN §system-tune` for the full signal plan and system
  design. That document is **not currently checked into this repo** — it
  lives wherever the user is keeping it. If you need it and can't find it,
  ask rather than assuming its contents.
- **`wing-brain/docs/CHURCH_SESSION.md`** — the run-sheet a church visit
  follows, mirrored as double-clickable `.bat` files in
  `wing-brain/church-kit/` for running on the church PC without VSCode.
- **`wing-brain/docs/DECISIONS.md`** — running log of every non-obvious
  judgment call made during past work sessions, newest first. Check it
  before re-deciding something that was already decided.
- **`wing-brain/README.md`** — repo layout, quick start (mock mode), church
  mode config, guardrails, and current TODO(church) integration points.

## Known local clutter (not yet cleaned up)

There is a stray nested duplicate folder at
`Wing Toolkit/Wing Toolkit/wing-brain/` on disk (not part of the git repo).
It looks like debris from an earlier copy/init step. Don't treat it as a
second copy of the real project — the real repo root is
`Wing Toolkit/wing-brain/`. Flag it to the user before deleting anything
there; it hasn't been investigated yet.
