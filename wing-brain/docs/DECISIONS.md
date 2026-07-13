# Decisions log

Running log of judgment calls made during autonomous work runs, so they can be
reviewed and reversed if wrong.

## 2026-07-13 — Claude judgment layer on the loudness monitor

- **New `src/audio/loudness-advisor.js`**, mirroring `tune/advisor.js`'s
  division of labor exactly: code measures and always fires the raw alert;
  Claude only annotates, a few seconds later, why the trend probably looks
  the way it does. `LoudnessMonitor` never awaits it — `pushFrame()` stays
  fully synchronous, kicks off the Claude call as a fire-and-forget promise,
  and returns immediately. **Explicit requirement, verified by a test**:
  a genuinely over-target reading stays WARN/ALERT even when Claude reads it
  as "dynamics, ignore" — the annotation decorates the transition record, it
  never touches `classifier.status`.
- **Event-driven, one call per alert episode** — triggered only on the
  `changed && (WARN||ALERT)` edge from `LevelClassifier.update()`, which
  already had a natural rate limit (`sustainedSeconds` between any two
  possible re-fires of the same margin) — no extra throttling needed.
  `LevelClassifier.update()` gained a third return field, `sinceSeconds`
  (how long the *current* status has held), used to report
  `overageDurationSec` in the payload — additive change, every existing
  caller destructuring `{status, changed}` is unaffected.
- **Haiku, not Sonnet** — `loudness-advisor.js` uses `claude-haiku-4-5`, a
  separate model constant from `tune/advisor.js`'s Sonnet, per explicit
  instruction that this is a cheap classification task, not tuning
  judgment. Same key (`ANTHROPIC_API_KEY`), same request/parse/catch
  shape, same "missing key → null, never throws" contract.
- **Fire-and-forget bookkeeping**: `_maybeRequestRead()` captures a direct
  object reference to the transition record (not an index into
  `this.transitions`) before kicking off the promise chain, so the
  eventual `.then()` mutates the right object even if `_resetRecord()`
  (4-hour auto-rotation) has since replaced the array it lived in. Pending
  promises are tracked in a `Set` with a `waitForPendingReads()` test-only
  drain method — production code never calls it; tests need it because the
  chain is genuinely async (`Promise.resolve().then(...)`) and asserting on
  `calls.length` immediately after `pushFrame()` would be asserting on a
  microtask that hasn't run yet (caught by two tests failing this exact way
  on first write — see below).
- **A read that never resolved before `stop()` saves the record shows up as
  `alertReadCounts.unavailable`**, same bucket as a genuine API failure —
  there's currently no way to tell "Claude was still thinking" from "the key
  was missing" from the persisted record alone. Accepted as a minor
  reporting gap rather than making `stop()` async to await in-flight reads
  before persisting; `stop()`'s synchronous contract (server.js calls it
  bare in `buildRuntime()`, tests call it bare) was judged more valuable
  than that last bit of report precision. Revisit if "unavailable" shows up
  often enough in practice to be confusing on the Monday report.
- **UI note line clears on ANY status transition**, not just a return to
  ok/quiet — a fresh warn→alert escalation also wipes the old "probably
  dynamics" note rather than leaving it visible next to a now-red meter.
  Simple rule (`status !== lastLoudnessStatus`), and `renderLoudnessNote()`
  additionally drops a `loudnessRead` payload if the meter has already
  moved past the status the payload was about — a stale note arriving late
  is worse than no note.
- **Test-writing mistake caught before it shipped**: two new tests
  (checking `calls.length` and a manually-resolved promise reference)
  asserted on the Claude call's side effects *synchronously*, right after
  the `pushFrame()` loop that triggers it — but the trigger itself defers
  to a microtask (`Promise.resolve().then(...)`), so those assertions ran
  before the stub had even been called. Both failed with the state they'd
  have *before* the async work happens (`calls.length === 0`, an unassigned
  resolver function). Fixed by awaiting `waitForPendingReads()` (or gating
  the stub on an explicit `Promise` instead of hoping a resolver variable
  is assigned in time) before asserting. Distinct from and unrelated to the
  `dataDir` test-pollution mistake logged in the 2026-07-10 entry below —
  worth naming because "the async thing didn't happen yet" is a different
  failure shape than "the async thing wrote to the wrong place," and both
  are easy to reintroduce in a fire-and-forget design like this one.
- **Test-writing mistake #2**: two other tests alternated `pushFrame()`
  calls between two different dB levels (e.g. 93 then 97, or 93 then 60)
  under the *default* 10-second LEQ window. Since the rolling LEQ blends
  energy across whatever chunks are still inside that window, consecutive
  1-second frames at different levels don't produce the discrete level
  jumps the tests assumed — the reported level was a smeared average of
  old and new chunks for several frames after a "transition." Fixed by
  overriding `integrationWindow: 'LEQ1'` in those two tests specifically,
  which (combined with 1-second frames) makes each frame's LEQ reading
  equal to just that frame's own level, restoring the simple hand-computed
  frame-count math. Every other test in this suite uses a single constant
  level throughout its frame loop, where blending is a non-issue (the
  average of N identical values is that value) — this only bites tests
  that intentionally change level mid-stream, worth remembering for any
  future test that does the same.

## 2026-07-10 — live loudness monitor (continuous LEQ, independent of tune sessions)

- **New module `src/audio/loudness-monitor.js`**, deliberately NOT touching
  `TuneSession` — per explicit instruction, services happen far more often
  than full tune sessions and this must keep running through all of them
  (mode changes aside). `server.js`'s `buildRuntime()` owns a separate
  `loudness` runtime object alongside `audio`/`wing`/`session`, stopped and
  recreated on every settings save same as the others.
- **Every internal clock is audio-time, not wall-clock.** `LeqAccumulator`
  advances its elapsed-seconds counter purely from `frame.length /
  sampleRate` as frames are pushed, and `LevelClassifier`'s sustained-timers
  key off that same clock. This was the single most important design choice
  in the module: it means `LoudnessMonitor.pushFrame()` is fully
  deterministic and testable by calling it in a loop with synthetic frames —
  no fake timers, no wall-clock flakiness, and a live run behaves
  identically to a test run frame-for-frame.
- **LEQ is a real rolling window**, not an IIR/exponential approximation: a
  deque of `{sumSq, n, tEnd}` chunks, trimmed from the front once a chunk's
  end falls outside `windowSeconds` (parsed from `"LEQ10"` etc. via
  `parseIntegrationWindowSeconds`). Chunk-boundary trimming means the window
  is accurate to within one capture-frame duration, which is standard
  practice for chunked LEQ metering and plenty precise for an 8-120s
  sustained-threshold decision.
- **Sustained-threshold logic clears immediately on drop, no hysteresis on
  the way down.** A level dipping back under a margin resets that margin's
  "since" timer to null right away — only the *rising* edge requires
  `sustainedSeconds` of continuous overage to fire. This satisfies "ignores
  single transient hits" without over-engineering a second debounce for
  clearing; LEQ10+ is already smoothed enough that clearing flappiness
  wasn't judged a real risk. Revisit if real-world use shows the status
  flickering ok/warn near the threshold edge.
- **Calibration is a pure offset**: `computeSplOffset(measuredDbfs,
  splMeterReadingDb) = splMeterReadingDb - measuredDbfs`, stored as
  `config.audio.splDbOffset` (null = uncalibrated, meter reads raw dBFS).
  `POST /api/loudness/calibrate` reads the monitor's current raw LEQ via a
  new `currentDbfs()` getter, computes the offset, and pushes it through the
  existing validate → atomic-write → `buildRuntime()` pipeline — same path
  as every other settings save, no separate persistence mechanism.
- **`validateConfig(config, room)` gained an optional second parameter** to
  cross-check `loudnessMonitor.referencePositionId` against
  `room.positions` (must name a real position, never free text, per
  explicit instruction). `room` is optional specifically so every existing
  config-only unit test keeps working unchanged — omitting it just skips
  that one cross-object check rather than failing closed or open in a
  surprising way. `server.js` always passes the live `room` object.
- **Live continuous capture is a TODO(church) stub**
  (`LoudnessMonitor._defaultFrameSource()` returns a no-op frame source in
  live mode) — the existing `audio/io.js` abstraction only exposes one-shot
  `playAndCapture()` for sweeps, not a persistent streaming tap. Wiring a
  real continuous capture off the SoundGrid device, and figuring out whether
  it needs to yield the physical input during a Full Tune sweep (device
  contention on the same channel) is unresolved and needs the church visit
  to answer, not a guess made from the office.
- **Mock frame generation (`mockLoudnessFrame`) rescales synthesized noise
  to land its RMS exactly on the intended dBFS target** (measure the raw
  noise's actual level, then apply the exact gain needed) rather than
  relying on the noise's incidental level — makes the "slowly drifting +
  occasional spikes" mock deterministic and testable with a stubbed
  `Math.random`, instead of a statistical/approximate assertion.
- **A very long always-on run auto-rotates into a fresh record every 4
  hours** (`MAX_RECORD_SECONDS`) so a service that runs long, or a box left
  running for days, doesn't accumulate one giant unflushed in-memory record
  that's lost on a crash. Persisted records are pruned to the 5 most recent,
  mirroring `MAX_SESSION_HISTORY`'s existing pattern in `tune/session.js`.
- **Persisted records store summary stats + a transition log, not raw
  readings** — avg/peak/seconds-in-each-status plus `{t, status}` on every
  flip. Keeps files tiny across hours of monitoring; the "small summary
  card" the UI needs never needed per-second history on disk.
- **Repeated the exact test-pollution mistake documented earlier in this
  file** while writing this module's own tests: three `LoudnessMonitor`
  instances in `test/loudness-monitor.test.js` called `start()`/`stop()`
  without passing `dataDir`, silently writing real files into
  `wing-brain/data/loudness/` on every `npm test` run (caught by manually
  inspecting that folder after a dev-server smoke test, not by the tests
  themselves — they don't assert anything about the real data dir, so they
  stayed green while polluting it). Fixed by routing every monitor that
  calls `start()`+`stop()` through a shared `tmpDataDir()` helper. Same root
  cause, same fix shape as the tune-session history fix from 2026-07-08 —
  worth remembering that *any* new stateful module with a default
  `dataDir='data'` needs this from the first test, not discovered after.

## 2026-07-10 — multiple named target curves (elevation / bethel / general)

- **`config.targetCurve` (single object) replaced with `config.targetCurves`**
  (a `{name: curve}` map) **+ `config.selectedTargetCurve`** (a string key
  into that map), seeded with three curves the user supplied: `elevation`
  (vocal-forward, tight low end, bright presence), `bethel` (atmospheric,
  warmer/fuller low end, softer top), and `general` (the shipped default —
  flat through vocal presence for sermon intelligibility, moderate safe
  tilt otherwise). This slots into the Settings page's existing "Tuning"
  card, whose target-curve dropdown already read `C.targetCurves` — it just
  had one placeholder curve to choose from before.
- **A curve's map key must equal its own `.name`** (validated in
  `settings.js`) — one canonical name per curve, no risk of a UI dropdown
  value and a stored curve's `.name` field silently drifting apart.
- **Added `activeTargetCurve(config)`** in `src/config/settings.js` — the
  one place that resolves `targetCurves[selectedTargetCurve]`. Both
  `src/tune/session.js` (`buildRecommendations()`) and `src/tune/advisor.js`
  (`buildAnalysisPayload()`) now call it instead of reading `config.targetCurve`
  directly, so there's a single lookup to get right rather than two
  hand-written ones that could disagree on a stale/mistyped key.
- **Settings UI**: the dropdown now saves `selectedTargetCurve` (a string)
  rather than pushing a whole curve object back through `POST /api/config`
  — cheaper diff, and the curve data itself is edited via the raw-JSON
  escape hatch, not the dropdown. Added a one-line hint under the dropdown
  showing the selected curve's `.comment`, updated on change, so an operator
  picking between three curves by name alone isn't guessing what "bethel"
  sounds like.
- **Curve data is explicitly "informed approximation, not measured data"**
  per the user's own `comment` fields — carried through unedited. Not this
  session's judgment call to revise; flagged here only so a future session
  doesn't mistake the numbers for calibrated targets.

## 2026-07-10 — Wing OSC address correction (real spec from church visit)

- **Every previously-guessed Wing OSC address was wrong in a consistent way.**
  The user brought back the real Wing OSC spec after a church visit and a
  real state dump (`data/wing-state/2026-07-10T21-05-05-211Z.json`, 455/5087
  addresses answered under the *old* guessed scheme = 8.9%). Corrected
  `scripts/wing-schema.mjs` (the single source of truth shared by
  dump/plan/apply-remap and `src/wing/client.js`) per the corrected map:
  fader is `/<kind>/<n>/fdr`; mains are numbered `/main/1..4` (no `"lr"`);
  channel name/color are `/ch/<n>/name` / `/col` (not `config/name`); EQ
  bands are flat leaves `/eq/1f /eq/1g /eq/1q` (channels also have fixed
  `/eq/lf|lg|lq|leq` and `/eq/hf|hg|hq|heq` shelf bands; buses/mains/mtx have
  6 numbered bands, no shelf letters); dynamics attack/release are
  `/dyn/att` / `/dyn/rel`; the HPF is `/flt/lc` (on) and `/flt/lcf` (freq),
  not `preamp/hpf`; sends are `/send/<bus>/on` and `/send/<bus>/lvl`; main
  assigns are `/main/<n>/on` and `/main/<n>/lvl`, distinct from bus sends.
- **Gain is not a channel address.** A channel's input gain and
  phantom/invert live on the physically patched I/O slot, not the channel
  strip: read `/ch/<n>/in/conn/grp` and `/ch/<n>/in/conn/in` first, then
  query `/io/in/<grp>/<in>/g` and `/io/in/<grp>/<in>/vph`. Implemented as a
  second query pass (`captureChannelGains()` in dump-wing-state.mjs) since it
  depends on the first pass's results — mirrors the existing DCA/mute-group
  "read patch, then act" pattern already used elsewhere in the script.
- **DCA and mute-group *membership* addresses are still unconfirmed** — the
  user's source excerpt didn't cover that section. Left as-is
  (`/ch/<n>/grp/dca/<n>`, `/ch/<n>/grp/mute/<n>`) with `TODO(church)`
  comments rather than guessed at, per explicit instruction. Also still
  unconfirmed and marked `TODO(church)`: aux/group bus count, matrix count,
  DCA count, mute-group count, and all custom/user-key addresses.
- **Wing OSC replies are 3-element arrays**
  (`[displayString, normalizedFloat 0-1, rawValue]`), not the single-value
  arrays the mock/tests/writes use — e.g. `/ch/1/mute` answers
  `["1", 1, 1]`. Confirmed from the real dump. This silently broke
  `plan-remap.mjs`'s truthy checks (`v[0]` on a 3-tuple reads the *display
  string* "0"/"1", which is JS-truthy either way) and `apply-remap.mjs`'s
  write/verify logic (which wrote/compared the full captured array instead
  of one value). Fixed with a single `readValue(v)` helper in
  wing-schema.mjs — prefers the last (raw) element for 3-tuples, passes
  single-element arrays and non-arrays through unchanged — used everywhere
  a captured reply needs interpreting (truthy checks, numeric comparison,
  what to actually write to the destination on a copy).
- **`LiveWing.applyTuning()` (src/wing/client.js) only ever targets
  main/mtx outputs**, which have 6 numbered EQ bands and no low/high shelf
  addressing. Design choice (not explicitly specified by the user): both
  `peq` and `hshelf` filter types are written as plain numbered bands up to
  a `MAX_EQ_BANDS = 6` cap; a filter beyond band 6 is skipped with a console
  warning rather than silently dropped or erroring, since there's no
  shelf-letter address to fall back to on these bus types.
- **Regression tests added** (`test/dump-wing-state.test.js`) asserting the
  exact corrected address strings for every field on `channelStrip`,
  `busStrip`/`mainStrip`/`matrixStrip`, `mainStrip` numbering, and
  `ioInputFields` — so this can't silently drift back to guessed addresses.
  Also covers `readValue()`'s 3-tuple/single-element/non-array behavior.
- **Could not re-verify coverage against the real console** — the church
  dump on disk only recorded answers to the *old* (wrong) addresses; there's
  no way to know what the new addresses would answer without a live query.
  Per the user's own instruction, the next physical church visit should
  re-run `2-DUMP-WING-STATE.bat`; ch/bus/mtx coverage should jump close to
  100%, main/dca/mute-groups still need verification since those sections
  weren't in the source excerpt used for this fix.

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
