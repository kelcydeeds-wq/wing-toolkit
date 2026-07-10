# Decisions log

Running log of judgment calls made during autonomous work runs, so they can be
reviewed and reversed if wrong.

## 2026-07-10 — preflight fix (band-aware test tone)

- **Bug (user-reported):** pre-flight used one fixed 1 kHz blip for every
  output, including the sub (`band: [25, 120]`) — a sub can't reproduce
  1 kHz, so it read as no-signal regardless of whether it was actually
  working. Fixed: `blipForOutput()` now centers the test tone on each
  output's configured band (geometric mean of `[lo, hi]`, nudged in from the
  edges) instead of a single broadband frequency.
- **Second bug this uncovered:** `preflightCheck`'s pass criteria only had a
  *lower* bound on peak level (`peak >= minPeakDbfs`) — nothing caught a
  reading above 0 dBFS, which is physically meaningless (digital full scale)
  and should always fail, not pass. Surfaced because the sub's new in-band
  tone (~55 Hz) lands almost exactly on the mock room model's synthetic
  55 Hz resonance (`addResonance` in `src/audio/io.js`); driving it with a
  full second of sustained tone at that exact frequency rings the (linearly
  undamped) synthetic resonance up to ~28 dBFS. Fixed by reusing `isClipped()`
  in the pass check — `pass = peak >= minPeak && !clipped && snr >= minSnr` —
  and split the failure warning into a "clipped" message vs. a "no signal"
  message, since they're different actionable problems for an operator
  (turn down the trim, vs. check routing/patch).
- **Left the mock's resonance model as-is** rather than damping it to behave
  more realistically under sustained excitation — that risks changing
  Full-Tune's sweep-based measurements too (a different, brief signal), for
  a problem that only exists because the preflight tone (new, sustained,
  1 second) can land squarely on a synthetic mode. The clip check is the
  correct fix regardless of why a peak comes back nonsensical.

## 2026-07-10 — church-kit (double-clickable run-sheet)

- **`church-kit/` is CHURCH_SESSION.md as numbered .bat files** for the
  church PC — no VSCode, no typed commands. Batch (not PowerShell) because
  double-clicking .ps1 opens an editor on default Windows policy; .bat just
  runs. Every script `cd`s to the repo root via `%~dp0..`, ends with
  `pause`, and fails loudly rather than flashing a window shut.
- **The Wing IP is asked once and cached in `church-kit/wing-ip.txt`**
  (gitignored) — subsequent scripts read it silently and step 2 re-prompts
  with it as the default. Deleting the file resets it.
- **Step 5 (execute) demands a typed all-caps `YES`** and restates the
  three preconditions (USB backup, plan reviewed, dry-run sane) before the
  prompt. Steps 2-4 are read-only and say so in their banners.
- **Every bat was actually executed on this machine** — including 2/4/5
  against a real UDP fake-Wing responder on 127.0.0.1:2223 (91/91 parameter
  reads, full write+verify round trip, and the cancel path). Testing them
  found a real bug (next bullet), which is why "scripts I can't click
  don't count as done".
- **Bug found by the bat test, fixed in plan-remap.mjs:** the catch-all
  range lookup used `/unassigned|spare/i`, which matches **"Keys + spare"**
  (an instrument range that merely reserves a spare slot) before the actual
  "Unassigned / spare" range — every unclassifiable channel was crammed
  into the 5 keys rows. The unit tests missed it because their synthetic
  layout had no colliding label; there's now a regression test that runs
  against the real `config/target-layout.json`.
- **Test-runner foot-gun for posterity:** a temporary helper file named
  `test-responder.mjs` in the repo root matched `node --test`'s `test-*`
  discovery pattern. Being a UDP server, it never exits — the whole test
  run hung with no failure output (even `--test-force-exit` doesn't help,
  since that only fires after tests complete). Helpers that must not be
  discovered belong outside the repo or under names that can't match.

## 2026-07-10 — Settings page

- **Config edits go through `POST /api/config`** with merge semantics:
  objects merge recursively, **arrays and scalars replace wholesale** (the
  outputs table always sends the complete array — index-splicing reordered
  lists would corrupt them). The raw-JSON escape hatch sends `replace: true`
  because a merge can never *delete* a key, and an escape hatch that can't
  remove things isn't one.
- **Saves are refused (409) while a session is in
  waiting_position/measuring/preflight/review** — rebuilding the runtime
  mid-measurement would discard in-flight results, and in review it would
  silently discard recommendations pending Apply. `idle` and `done` allow
  saves; a save from `done` resets to home, which is acceptable since the
  session record is already persisted to history at that point.
- **Runtime rebuild instead of restart:** audio IO, Wing client, and a fresh
  TuneSession are recreated from the new config on every successful save
  (`buildRuntime()` in server.js). The old Wing transport is closed first.
  All handlers read the `session` variable at call time, so no stale refs.
- **`MODE` env var is a boot-time override only** (npm run dev forces mock).
  After boot, the Settings page's mode toggle is authoritative for the
  running process AND is persisted to disk — but a `npm run dev` restart
  forces mock again. `npm start` respects the saved file. GET /api/config
  reports the runtime truth, so the UI never lies about the active mode.
- **Validation ranges are typo-catchers, not tuning judgment** — "could any
  sane PA ever want this" caps (port 1-65535, band lo<hi, sweep ≤ -6 dBFS,
  guardrails within generous outer bounds). Guardrail defaults themselves
  are untouched; the UI additionally hides guardrail editing behind an
  "unlock advanced" toggle since they're safety limits.
- **Room API surface is verifyPosition only.** Geometry drives delay
  predictions and changes with a tape measure on-site, not from a phone
  form — the settings card says so and the server rejects other room keys.
- **test-wing tries several candidate query addresses** (`/?`, `/xinfo`,
  `/info`, `/main/lr/config/name`) and succeeds on any reply — the real
  Wing's info address is still `TODO(church)`, and a connectivity probe
  shouldn't false-negative just because one guessed address is wrong. It
  accepts host/port/mode in the body so the UI can test values *before*
  saving them.
- **Atomic writes**: temp file + rename in the same directory
  (`writeJsonAtomic`), so a crash mid-save can't leave a half-written
  config. Round-tripping through JSON.stringify normalizes number
  formatting (`2.0` → `2`) — cosmetic only.
- **scripts/smoke-settings.mjs** is a manual end-to-end check of the whole
  API against a running dev server (15 assertions incl. the 409 and
  broadcast paths). Not in `npm test` because it needs the live server and
  briefly rewrites real config files (it restores them, even on failure).

## 2026-07-08 — refinement run (Parts A + B)

- **CLAUDE.md and AI_MIX_MASTER_BUILD_PLAN.md do not exist** in this repo (only
  CHECKLIST.md at the toolkit root). The target channel layout for task 7 was
  taken from the task prompt itself (1-5 pastor+vocals, 6-10 keys+spare,
  11-16 guitars/bass+spares, 17-23 drums, 24 vocal FX DCA, 25 crown mics,
  39-40 osc/talkback) and written to `config/target-layout.json`.
- **`npm run dev` used Unix env-var syntax** (`MODE=mock node ...`) which fails
  on Windows, where development currently happens. Switched to `cross-env`
  (devDependency). Also changed `npm test` to plain `node --test` — passing
  `test/` explicitly failed to resolve as a directory in this environment.
- **`.env` loading re-added to server.js** (`process.loadEnvFile`, Node 20.12+)
  so the Claude advisor key works with plain `npm run dev`. `.env` is
  gitignored.
- **Wing OSC address scheme is unverified.** All live OSC paths are best-guess
  from public Wing OSC documentation and marked `TODO(church)`. Every remote
  read is timeout-guarded so wrong addresses degrade to `null` instead of
  hanging. The state dump at the church session is the source of truth.
- **Preflight blip**: a short (1 s, default) windowed 1 kHz tone burst
  (`makeBlip` in measure.js), not a sweep — a pre-flight only needs to prove
  signal makes it out and back, not measure a transfer function, so a plain
  tone keeps it fast and the pass/fail math trivial. Pass criterion: peak
  ≥ -50 dBFS *and* SNR ≥ 12 dB in the capture window, both configurable under
  `config/default.json` → `audio.preflight`.
- **Session history**: capped at 5 most-recent sessions (verify or full) in
  `data/sessions/<timestamp>__<mode>.json`, pruned oldest-first on every save.
  `TuneSession` takes an optional `dataDir` (defaults to `data/`) so tests can
  point it at a temp directory — this matters: without it, unit tests that
  drive a session through `finish()` would write real files into the
  operator's actual session history on every `npm test`.
- **Per-position overlay**: `buildRecommendations()` attaches each output's
  individual per-position `magDb` curve (same freq grid as the average) so the
  review screen can toggle between "average" and "all positions" without a
  second round trip.
- **Sweep level trim** is a per-output config field (`sweepTrimDb`), applied to
  the playback buffer only — `extractIR` peak-normalizes the recovered IR, so
  trims don't skew EQ judgment, only captured level/headroom. Sub default set
  to -6 dB.
- **Clip detector is intentionally strict** (-0.5 dBFS peak threshold). Running
  a mock Full Tune at the default room/verify position can trigger "Clipped
  capture" warnings from the synthetic room model's constructive reflections
  at close range — this is the detector correctly doing its job on synthetic
  data with aggressive early reflections, not a bug. Worth knowing before a
  first mock walkthrough so it doesn't read as broken.
- **Guardrail limits untouched** per run rules; guardrail *code* gained tests
  only.
- **OSC layer extracted to `src/wing/osc.js`**: a generic transport
  (`send`/`get`/`subscribe`, live UDP + in-memory mock) with no tune-specific
  knowledge, shared by `wing/client.js` (System Tune) and, from here on, the
  audit scripts (dump/plan-remap/apply-remap/recorder). `get()` always
  resolves — `null` on timeout, never throws or hangs — so callers can await
  a query in a loop without a try/catch per address. `wing/client.js` keeps
  the tune-shaped API (`soloOutput`/`unmuteAll`/`applyTuning`) unchanged;
  `LiveWing` just composes the shared transport instead of owning its own
  `osc.UDPPort`. One incidental wire-format change: OSC integer args (e.g.
  mute 0/1) now tag as OSC type `i` instead of always `f` — more correct, and
  nothing currently depends on the old tagging since no test or hardware run
  ever exercised `LiveWing` before this refactor.
- **`npm test` runs with `--test-force-exit`.** A UDP-backed test whose
  assertion throws before it calls `.close()` leaves a dgram socket open,
  and Node's test runner will not exit while any handle is open — the whole
  suite hangs forever instead of reporting the failure. Every OSC test now
  wraps its body in try/finally so sockets close either way, but
  `--test-force-exit` is kept as a backstop for the next person who forgets.
- OSC float args are 32-bit (`f` type) — a value like 1.4 round-trips with
  float32 rounding error (`1.399999976158142`). Tests compare OSC-transported
  numbers with a small tolerance, not `===`; production code was already
  tolerant of this since guardrail clamping rounds to 1 decimal place anyway.
- **Part B scripts live in `wing-brain/scripts/`**, not the toolkit-root
  `scripts/` (which holds unrelated REAPER bench tooling). The audit tools
  need `../src/wing/osc.js` and `../config/*.json` directly, so they belong
  inside the wing-brain package. `npm run record` in package.json already
  assumed this layout.
- **`wing-schema.mjs` is the single source of truth for Wing OSC addresses**,
  shared by dump/plan/apply-remap so they can't silently disagree about what
  a "channel" looks like. Every address in it is a best guess (see its header
  TODO(church) block) — counts (16 buses, 8 matrices, 16 DCAs, 4 EQ bands, 12
  user keys) are equally unconfirmed guesses, not spec.
- **`config/target-layout.json`** encodes the target channel ranges from the
  task brief (1-5 pastor+vocals, 6-10 keys+spare, 11-16 guitars/bass+spares,
  17-23 drums, 24 vocal-FX-DCA return, 25 crown mics, 26-38 spare, 39-40
  osc/talkback) so plan-remap has a machine-readable target instead of a
  hardcoded one.
- **dump-wing-state's `--mock` seed is a deliberately half-organized "before"
  state** (named channels scattered across the range, "Vox FX Return" parked
  at channel 30 instead of its target slot 24, live DCA/mute-group/bus-send
  references on it) — an empty/pristine mock would give plan-remap nothing
  real to reorganize and the tool chain would look like it works without
  proving it.
- **plan-remap classification is keyword matching on the channel name**, not
  anything smarter — deliberately so, since it's meant to be reviewed by a
  human (the church run-sheet's dump → plan-remap → **review** →
  apply-remap step) before anything executes. Keywords are coupled to the
  exact label strings in `config/target-layout.json`; renaming a range there
  means updating `CATEGORY_KEYWORDS` in plan-remap.mjs too.
- **plan-remap minimizes moves**: a channel already sitting inside its target
  range is left alone; only channels outside their range get relocated, into
  the range's remaining free slots in current-channel order. A full range
  produces a warning and leaves the extra channel(s) unmoved rather than
  overflowing into a neighboring range silently.
- **`--dump-dir` / `dataDir`-style injection again** (see the session-history
  entry above) — `planRemap()` takes an optional `dumpDir` so tests never
  scan/write the real `data/wing-state/`.
- **apply-remap re-reads the source channel live at execute time instead of
  trusting the dump snapshot.** remap.json only carries a name/category/
  reference summary, not full parameter values — and even if it did, the
  dump could be stale by the time apply-remap runs. It queries `ch{from}`'s
  full current state right before copying, so "copy all settings" always
  reflects what's on the console *now*.
- **The old channel is left alone after a move by default; `--clear-source`
  opts into muting + blanking its name.** The task said "copy... repatch...
  rename" for the destination, not "clear the source" — defaulting to leaving
  the source untouched is the more conservative reading, and duplicating a
  live mic onto two channels for one session isn't catastrophic. `--clear-source`
  is there for whoever wants the tidy version once they trust the plan.
- **Recorder subscribes to `/.*/`** (every address, via `LiveOscTransport`'s
  raw-RegExp subscribe path) rather than a fixed address list — the whole
  point of a traffic recorder is capturing addresses nobody predicted, which
  is exactly the gap dump-wing-state's best-guess schema can't fill.
- **`replayRecording` lives in `src/wing/osc.js`, not the recorder script.**
  It's a capability of the mock transport (feed it recorded traffic instead
  of synthetic sends), not something specific to the CLI — other tools or
  tests can import and reuse it directly. `record-osc.mjs` owns the file
  format (`{t, address, args}` JSONL, `t` = ms offset from recording start)
  and exposes replay as a `--replay` CLI convenience on top.
- **`recordFromTransport` takes an `AbortSignal`** instead of hardcoding
  `process.once('SIGINT', ...)`, so tests can stop a recording deterministically
  (`controller.abort()`) instead of needing to simulate a real SIGINT.
- **Verify uses tolerant float comparison** (same `< 1e-3` reasoning as the
  OSC transport tests) — an exact-equality readback check would spuriously
  abort a real remap over float32 rounding on the console's reply, not an
  actual failed write.
- **`--mock` on apply-remap.mjs seeds the same before-state as
  dump-wing-state.mjs's `--mock`.** Each script is a separate `node`
  process, so the in-memory mock console does not persist between them —
  without reseeding, a `dump → plan → apply --mock` dry-run chain would show
  "0 source parameters read" for every move, which is technically correct
  but a useless demo. `applyRemap()` also accepts a `transportOverride` for
  tests, the same idea for the same reason.
