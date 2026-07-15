# Decisions log

Running log of judgment calls made during autonomous work runs, so they can be
reviewed and reversed if wrong.

## 2026-07-15 — live audio: sox/MME replaced with naudiodon/ASIO (root cause of the 300-500ms reading)

Diagnosed entirely by reading code — no church visit needed for this part.
`src/audio/io.js`'s LIVE implementation used sox with `-t waveaudio`, which
is Windows MME, spawned as two INDEPENDENT processes (one play, one record).
The file's own header comment claimed "SoundGrid ASIO device" as the design
intent — the implementation never matched that intent. Two real bugs:

- **MME has well-documented large fixed buffering** (commonly 200-500ms) —
  matches the exact 300-500ms symptom from the 2026-07-14 visit precisely.
  Because ref+mic were two channels of the SAME mme capture, this fixed
  delay was equal on both channels and canceled correctly in
  cross-correlation — which is exactly why relative timing (delay
  differences between positions/outputs) came out sane while an absolute
  offset got added to every reading, matching what was observed.
- **`config.audio.referenceInputChannel`/`micInputChannel` were dead
  config** — the old code hardcoded channel 0 = ref, channel 1 = mic from a
  fixed `-c 2` capture, completely ignoring those two settings. They
  happened to default to 1/2 (matching the hardcoded 0/1 zero-indexed
  assumption), so this was latent, not yet symptomatic — but the Settings
  UI exposes those fields as if they're honored, and they weren't.

**Replaced with naudiodon** (PortAudio bindings), per explicit direction —
one full-duplex `AudioIO` stream opened ONCE in `LiveAudioIO`'s constructor
and reused for every `playAndCapture()` call, so input and output genuinely
share one ASIO callback/clock for the object's whole lifetime, not two
processes with no synchronization guarantee at all.
- **`referenceInputChannel`/`micInputChannel` are now actually read** —
  `extractChannels()` de-interleaves whichever two 1-indexed channels
  config names out of an N-channel capture (N = max of the two configured
  indices — PortAudio can only open "the first N channels" of a device, not
  an arbitrary offset, so this opens enough channels to cover whichever is
  higher and picks the two of interest out of that block).
- **naudiodon is imported LAZILY** (dynamic `import()` inside
  `LiveAudioIO._open()`, never at module load time) — it's a native addon
  that must be built from source with the Steinberg ASIO SDK (confirmed via
  research: the SDK can't be legally redistributed as a prebuilt binary, so
  `npm install` downloads it and compiles during install). This machine has
  no C++ build tools at all (`cl.exe`/vswhere not found) — genuinely cannot
  install, build, or test this against real hardware here. The lazy import
  means `MockAudioIO` and the entire test suite have zero dependency on
  naudiodon being present; only actually constructing a LIVE `AudioIO`
  touches it. Verified: `npm test` passes with naudiodon absent from
  `node_modules` entirely.
- **`package-lock.json` synced via `npm install --package-lock-only`**
  (real registry metadata/integrity hash, `hasInstallScript: true`
  confirmed) without attempting the actual native build — church-side
  `npm install` will now correctly attempt the real build+ASIO-SDK-download
  rather than working from a stale/mismatched lockfile.
- **`config.audio.inputDevice`/`outputDevice` are flagged `TODO(church)`,
  not silently guessed.** The confirmed value ("IN 1-2 (BEHRINGER
  WING-USB)") is an MME-era name; ASIO typically exposes a whole interface
  as one bidirectionally-named device, often under a different string
  entirely. `findAsioDevice()` fails loudly (lists every ASIO device it
  actually saw) rather than silently opening the wrong interface or
  falling back to a guess.
- **`scripts/list-audio-devices.mjs` (WinMM P/Invoke-based) cannot see ASIO
  devices** — different Windows driver model entirely. Added a loud warning
  to its output rather than rewriting it to depend on naudiodon (which
  isn't installed on most dev machines) — the real ASIO device name has to
  come from `naudiodon.getDevices()` on a machine where it's actually
  built, i.e. the brain box, at church.
- **Cross-correlation cancellation logic itself was NOT changed and is
  architecturally sound** — confirmed on request. `findDelay()` (dsp/
  measure.js) needs no manual "subtract the interface latency" step; it
  relies entirely on ref and mic being two channels of one synchronized
  capture (same hardware clock), so ANY shared/fixed latency — MME
  buffering, ASIO buffer size, whatever — falls out of the cross-correlation
  subtraction automatically, regardless of its magnitude. The naudiodon
  rewrite doesn't change this principle, it just makes the "shared clock"
  guarantee genuinely true (one duplex stream) instead of incidentally true
  (two processes that happened to start close together).
- **10 new tests** for the pure, hardware-independent helpers
  (`findAsioDevice`, `interleaveStereo`, `extractChannels`) in
  `test/audio-io.test.js`. `LiveAudioIO` itself (the real duplex stream) is
  NOT unit-testable here for the same reason it can't be installed here —
  it needs the repeat-measurement variance test (5 repeated measurements,
  check consistency) at church, per explicit instruction, as the real
  acceptance test once naudiodon is actually built there.

## 2026-07-15 — hard gate: low-confidence measurements can't reach an applied correction

Prompted by a real result from the 2026-07-14 church visit: a 300-500ms
"delay" reading, which is not physically plausible for this room (would
imply ~100m of unaccounted path). Diagnosis: `findDelay()`'s cross-correlation
search window defaults to `maxDelayMs = 500` — when the mic channel has no
real correlated signal (that visit's own notes already flag construction-noise
contamination), the search has no true peak to lock onto and returns
whatever noise happens to be highest, which can land anywhere up to the
window ceiling. The system already retried once and warned
("even after retry") on exactly this reading — it did its job — but the
warning was soft: a low-confidence result still flowed into
`buildRecommendations()` and could be written to the console if Apply was
tapped without noticing.

- **`TuneSession.confidenceFilteredResults()`** (new): the one gate
  everything correction-facing must pass through — rows below
  `LOW_CONFIDENCE_THRESHOLD` (3) are excluded. `buildRecommendations()`'s EQ
  loop and its `recommendDelays()` call now both read from this filtered set
  instead of `this.results` directly; `finish()` also passes it (not the raw
  results) into `buildAnalysisPayload()`, so Claude never reasons over data
  the local recommender itself distrusts.
- **Raw data is never deleted** — `this.results` (and the downloadable
  session record) still contains every measurement, low-confidence ones
  included, for operator visibility/debugging. Only what feeds a
  *correction* is filtered. This matches the project's existing pattern of
  keeping raw data while guarding what gets applied (e.g. guardrail clamps
  in `advisor.js` don't delete Claude's raw response, just what's trusted).
- **A bus left with zero usable rows gets no `perOutput`/`delays` entry at
  all** — not a zero-filled placeholder, not a best-guess. `apply()`'s
  existing `if (!rec) continue` then silently (but correctly) skips writing
  anything for that bus. `buildRecommendations()` now also returns
  `excludedLowConfidenceCount` and `busesWithNoUsableData` so `finish()` can
  warn about both cases explicitly, and the review screen shows the same
  warnings persistently (the transient `#status` toast scrolls away; a
  card on the review screen doesn't).
- **Chose per-row exclusion over an all-or-nothing Apply block.** A single
  bad position at one output, out of e.g. 8 positions × 4 buses, shouldn't
  prevent applying the 31 good measurements alongside it — only the bus(es)
  actually left without usable data lose their correction, and only for
  positions/outputs that were actually bad.
- **Verify mode was not touched.** It never wrote to the console in the
  first place ("compares against stored baseline, writes nothing" — see the
  file header) — the risk this closes is specific to Full Tune's Apply path.
  `buildVerifyReport()` still surfaces raw `confidence` per row without a
  gate; a low-confidence badge on that screen would be a reasonable follow-up
  but is out of scope here.
- **Test-writing note**: two new tests initially used a raw call-counter
  (`call++ === 0 ? noisy : clean`) to simulate "first position bad, rest
  good" — but the low-confidence retry itself consumes a second
  `playAndCapture` call within the SAME position, so the retry's call landed
  on the "clean" branch and silently rescued the position the test meant to
  keep bad, making both tests pass without exercising exclusion at all
  (caught because `excludedLowConfidenceCount` came back 0 instead of 1).
  Fixed by branching on which position is being measured (an explicit
  counter set between `ready()` calls), not a raw call count — the same
  class of mistake as the "async thing didn't happen yet" and "LEQ10 window
  blends levels" test bugs logged in earlier entries: the mock's timing
  assumptions didn't match the code's actual call pattern.

## 2026-07-14 (church audit session) — FIRST live console contact: addresses largely confirmed, DCA/mute model corrected, output config fixed

First time the toolchain ever touched the real Wing (192.168.25.80:2223, a
"FusionFOH" WING, firmware 3.0.5). Ran the read-only audit steps against real
hardware. Results, newest-relevant first:

- **The corrected address map from the 2026-07-10 spec review is basically
  right.** A full `dump-wing-state` answered ~73% of addresses on the first
  real run (channels/buses/mains/matrices/DCAs all read with real names,
  gains, EQ, sends) — nowhere near the "near-0%, everything's wrong" failure
  the run-sheet warned about. Fader/mute/EQ/dynamics/sends/name/HPF/input-patch
  all confirmed working against real hardware.

- **DCA + mute-group membership addresses were wrong and are now fixed.** The
  old guess was a per-index boolean (`/ch/N/grp/dca/K`, `/ch/N/grp/mute/K`) —
  every one of those timed out (null) across all 40 channels. Discovered the
  real scheme by **node-tree enumeration**: querying a *container* address
  (e.g. `/ch/2` with no args) makes the Wing reply with its child node names.
  Walking that tree revealed membership lives in a single comma-separated
  string at **`/ch/N/tags`** (and `/bus/N/tags`): `#D<k>` = member of DCA k,
  `#M<k>` = member of mute group k (plus any custom tags, preserved).
  Verified across all 40 channels — 100% consistent with the DCA names
  (drums→#D1, bass→#D2, guitars→#D3, keys→#D4, vox→#D5, all-band→#D6).
  - Schema change: `dcaAssignFields`/`muteGroupAssignFields` (arrays of
    per-index addresses) replaced by a single `tags` leaf on channel/bus
    strips, plus exported `parseTags()`/`formatTags()`. Consumers updated:
    `plan-remap` parses the tags string; `apply-remap` no longer sends
    per-index membership — the `tags` leaf is read from source and copied
    verbatim by the existing generic write loop, so membership (and any custom
    tags) travels with a moved channel for free. Mock seeder + 4 tests updated;
    full suite (218) green. Bonus: dropping ~960 dead per-index addresses from
    the query set pushed the dump's answered ratio to 96%.
  - This closes the biggest `TODO(church)` item. Node-container enumeration is
    now the go-to technique for confirming any remaining unknown address.

- **Output config had a real bug, now fixed.** `config/default.json` mapped the
  Sub to `main/3`, but the real console has **main 2 = SUBS, main 3 =
  BROADCAST**. As shipped, the tuning tool would have EQ'd the broadcast feed
  thinking it was the sub. Corrected sub→`main/2`; all four tuning outputs
  (mains=main1, sub=main2, side-fills=mtx1, center-fill=mtx2) now verified
  against real names and flipped to `wing.confirmed: true`. (`physicalOutputs`
  patch addresses + `testSignal` injection point remain unconfirmed — not
  covered this session; still gated `confirmed: false`.)

- **OSC traffic recorder captures nothing — the console doesn't push.** An
  8-second live capture recorded 0 messages. The Wing only *replies to
  requests*; it does not send unsolicited parameter updates to an OSC client
  that hasn't subscribed. `record-osc.mjs` (and anything wanting live change
  streams, e.g. loudness monitoring off console meters) needs a **subscription
  handshake** first — presumably an X32-`/xremote`-style periodic renew, exact
  Wing command not yet known. TODO: discover the Wing subscribe command (try
  node-enumerating the root `/` for a subscribe node, or capture what the
  official Wing app sends). Until then the rehearsal-recording step is a no-op.

- **Channel remap: generated the plan, decided NOT to apply it.** The console
  is already cleanly laid out by a human. The keyword classifier badly misreads
  this church's naming — it dumped the vocalists (Main/Vern/Renita/Scott) and
  half the drum kit (Rack/Floor/OH/Perc) into "Unassigned/spare". Applying it
  would scramble a good layout. The remap classifier needs church-specific
  keyword tuning (an at-home task) before it's usable here; the whole
  reorg-the-console premise may simply not apply to this well-kept board.

- **Full control/routing map + more live fixes (second half of the session).**
  Enumerated the console's whole node tree to understand it end to end:
  - Top level: `/io /ch /aux /bus /main /mtx /dca /mgrp /fx /cards /play /rec
    /$ctl /$globals` etc. Mains have 6 numbered EQ bands + l/h shelves + a tilt;
    dynamics are a bus compressor (`SBUS`).
  - **`applyTuning` delay bug fixed.** Was writing `/<out>/delay` (a no-op).
    Real address is `/<out>/dly/dly` + `/dly/on` + `/dly/mode`; units token
    `MS`/`M`/`FT`/`SMP` (discovered by trial on the unused Main 4, restored
    after). Now forces `MS` and enables the delay. Code + osc.test updated.
    NOTE for whoever runs the first real Apply: the mains already carry a real
    engineer-set alignment delay (`/main/1/dly` was 13.5 with mode `FT`) —
    applyTuning will OVERWRITE it. That's intended (the tool sets alignment),
    but confirm the baseline scene is saved first.
  - **Audio-device config was wrong too** (same class as the sub bug): config
    said `SoundGrid`, but there is no SoundGrid card — the mini-PC talks to the
    Wing over its built-in USB-C audio (`BEHRINGER WING-USB`, the "USB" routing
    group). Fixed `audio.inputDevice`/`outputDevice` to
    `IN 1-2`/`OUT 1-2 (BEHRINGER WING-USB)`. Installed sox; confirmed sox↔Wing
    capture works.
  - **Silent sweep root cause (found by the user):** the injection channel's
    input was patched to a local analog input, not the USB return — repatched
    to USB 1-2 on the console and the sweep now plays through the mains.
  - **OSC write control verified** live (toggled the unused `/mtx/3/mute` and
    restored). So `soloOutput()`'s one-output-at-a-time muting works on the
    real console. Reference loopback is already wired: `/io/out/USB/1` ← MAIN 1,
    so PC IN 1 = Main 1. Remaining gap for real measurement: `/io/out/USB/2`
    still ← MAIN 2 (subs); the measurement mic (ch 39) needs to land on USB
    out 2 so PC IN 2 = mic.
  - Construction crew on site this session — any mic/frequency data captured
    today is noise-contaminated and must be treated as throwaway (plumbing
    validation only, not real tuning).

## 2026-07-14 — two-layer routing model, per-driver test injection, shared-driver wizard

Comprehensive rework requested with an explicit constraint: **run OSC
discovery and show real bus/output numbers before hardcoding anything.**
The console was unreachable from this session (verified by actually trying
`identify-outputs.mjs` against the cached IP, not just assuming) — so
everything below is architecture built mock-first with placeholder numbers,
per the user's own choice when given that tradeoff explicitly.

- **`config.outputs[]` split into two layers**: `config.buses[]` (what live
  modules — mutes, loudness, EQ, delay — control) and
  `config.physicalOutputs[]` (dumb patches, each pointing at a `sourceBusId`).
  A stereo bus like "mains" now has ONE Wing address feeding TWO physical
  outputs (`main_l_out`, `main_r_out`), matching how a Wing stereo bus is
  actually addressed (one number, console-side L/R linking) — this is a real
  behavior change from the old model, which treated Main L and Main R as two
  independent mono outputs measured and corrected separately.
- **Both layers ship with `wing.confirmed: false`** (buses) and
  `wing.grp/num: null, confirmed: false` (physical outputs) — nothing here
  is a guess dressed up as fact. `sub`'s bus number (3) and `side_fills`'s
  matrix number (1) are carried over from the OLD flat config as a
  starting point, not re-derived from anything new.
- **Correction pooling trick**: measurement happens per PHYSICAL OUTPUT
  (so per-driver geometry/health can be checked), but every result row is
  tagged `outputId: bus.id` — the BUS id, not the physical output's own id.
  `dsp/tune.js`'s `spatialAverage`/`recommendEQ`/`recommendDelays` were
  **not touched at all** — they already average every row sharing one
  `outputId`, and don't care whether those rows came from different mic
  positions, different physical outputs sharing a bus (stereo mains), or
  both at once. This was the single highest-leverage design choice in this
  whole feature — it turned "how do I combine two speakers' measurements
  into one bus correction" into zero new code.
- **`src/wing/patch-manager.js`** (new): the defensive snapshot/restore
  safety net for per-driver test-signal injection. Every repatch snapshots
  the ORIGINAL patch source to `data/patch-snapshot.json` before touching
  anything, gates live-mode writes behind `wing.confirmed` (per output) AND
  `testSignal.confirmed` (global) AND a successful read of the original
  source — refuses to repatch anything it can't prove it can restore.
  `restoreAll()` is a synchronous, disk-driven escape hatch (works even if
  the in-memory config that made the repatch is long gone) wired to
  SIGINT/uncaughtException handlers AND a UI button
  (`POST /api/patches/restore-all`). Deliberately NOT built on this
  project's usual AbortController pattern (see `record-osc.mjs`) — that's
  for cooperative cancellation the caller opts into; this needs to fire on
  involuntary termination too, which only a real process signal handler
  catches.
- **Injection failure degrades to the pre-existing solo/mute-only
  measurement path, not a hard error.** Since every physical output ships
  with `wing.grp/num: null`, `injectTestSignal()` always throws today (by
  design — "no address configured" is checked before the confirmed gates,
  in both mock and live mode) and `measureOnePhysicalOutput()` catches that
  and proceeds exactly like the old code always did. Practically: shipping
  this doesn't change today's live-measurement behavior at all until
  someone fills in real `grp`/`num` values and flips `confirmed: true` —
  the new injection path is fully opt-in.
- **Physical-output patch OSC addressing
  (`physicalOutputPatchFields()` in `wing-schema.mjs`) is a best-effort
  guess**, mirroring the confirmed channel-input pattern
  (`/ch/N/in/conn/grp`+`/in/conn/in`) as `/io/out/<grp>/<n>/conn/grp`+`/conn/in`.
  Nobody has ever queried the Wing's actual output-patch matrix — this is
  new ground beyond the mixing-parameter addresses fixed on the 2026-07-10
  visit. `identify-outputs.mjs --probe-io-out` best-effort-probes it (grp
  A-D × num 1-8) and reports any replies, but explicitly does not claim
  silence means the guess is close — only that a reply would be a real
  signal worth following up on.
- **Test-signal source is also unconfirmed and left that way on purpose**:
  `config.testSignal.source` can be `"usb_sweep"` (the existing ESS
  playback path, physically wired into one console input channel — replaces
  the old unused `wing.oscillatorChannel` placeholder) or
  `"wing_oscillator"` (an internal console generator, IF the Wing exposes
  one over OSC — never checked). The injection layer doesn't care which;
  it just writes whatever `injectionChannelGrp/Num` config says into the
  physical output's patch source.
- **The shared-driver wizard runs at EVERY measurement position, not
  once per session.** The user's spec describes the instruct/confirm/sweep
  sequence as something that happens "when System Tune reaches" a
  shared-driver output — read literally, that's per-position, and that's
  what got built (confirmed working end-to-end for all 8 real room
  positions via a live server smoke test). This is the correct literal
  interpretation but a real operational cost — unplugging/replugging a
  cable at every one of 8 positions is tedious. Deliberately did NOT
  simplify this to "wizard runs once, using the verify position" on my own
  initiative, since that's a workflow tradeoff the user should make, not
  one I should guess at. Flag this to them; a "once per session" mode
  would be a small, contained change to `ready()`'s loop if they want it.
- **Wizard's confidence blip reuses `makeBlip()`** (a sine tone, band-centered
  via the same `blipForOutput()` helper preflight already uses) rather than
  building a new pink-noise generator — the spec allowed either ("1-2s pink
  noise burst or tone"), and a tone is simpler with zero new DSP code.
- **Driver health comparison** (polarity, level, max response deviation)
  flags anything beyond ±3 dB / a polarity flip — informational only,
  stored in `driverHealthReports` and surfaced on the review screen; never
  read by `buildRecommendations()`, which only ever sees `results` (the
  bus-tagged combined/normal measurements). Individual driver sweeps
  (`driverHealthResults`) are structurally incapable of leaking into a
  correction even by accident, since nothing in `buildRecommendations()`
  reads that array.
- **Settings UI ships functional, not polished**: two tables (Buses,
  Physical Outputs) replacing the old flat Outputs card, a "Run output
  discovery" button that calls the extended `identify-outputs.mjs` live
  (via `POST /api/discover-outputs`) and shows console names/mute state
  for manual cross-referencing — it does NOT auto-fill bus numbers, by
  design, since blindly trusting a name match is exactly the kind of
  guessing this whole feature exists to avoid. A "Patch Safety" card
  exposes pending-patch status and the Restore All Patches button.
- **End-to-end validated against the real server**, not just unit tests: a
  disposable script drove a full `start(full)` → wizard → `review` cycle
  over a websocket against `npm run dev`, across all 8 real room positions,
  confirming the wizard state machine, injection fallback, driver-health
  warnings, and Claude-unavailable local-recommender fallback all work
  together without a single server error. (Also incidentally re-confirmed
  the mock room model's clipping tendency from the 2026-07-08 preflight fix
  — sweeps clip under some bus/gain combinations in mock mode. Not a
  regression from this work, not touched; noted here in case it resurfaces.)
- **218 tests** (was 191): new `test/patch-manager.test.js` (14, snapshot/
  restore/safety-gate coverage) and `test/routing-wizard.test.js` (12,
  wizard state machine + bus-pooling + injection integration), plus every
  existing test file touching the old `config.outputs` updated to the new
  schema.

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
