# PHASE 0 — GETTING STARTED CHECKLIST

Work through this in order. Each bench test has a PASS criterion — record the
result, because the results decide the architecture (REAPER vs SuperRack, brain
box placement). Bring this file's results section to our next session.

---

## NOW (office, no hardware needed)

- [x] Unzip `wing-brain`, run `npm install`, then `npm run dev`
- [x] Open the printed address on your phone (same WiFi) → run a mock **Full Tune**
      end to end. You should walk through 5 positions and land on a review screen
      with delay + EQ recommendations. This is the exact church workflow.
      **Verified 2026-07-24/27** — scripted a WebSocket driver against the running
      mock server instead of a real phone tap-through (see CHECKLIST results
      below for the caveat); walked all 8 configured positions (`room.json` has
      8, not 5 — that's just this checklist's wording being approximate),
      correctly handled the shared-driver wizard for the side-fill pairs, landed
      on `review` with sane guarded EQ recommendations (all within the
      6dB-cut/3dB-boost limits). Confirms the underlying flow/logic works after
      the recent routing-revamp changes; does not confirm on-phone feel/UX —
      still worth an actual phone tap-through once you're at the machine.
- [x] Create the GitHub repo, push `wing-brain`. All future work lands here.
      (private repo: github.com/kelcydeeds-wq/wing-toolkit)
- [x] Get a USB-A→XLR or interface plan for the Behringer measurement mic on the
      mini PC (if the mic will come back through the Wing instead, note that —
      it changes `config/default.json` audio input mapping, nothing else).
      **Resolved — no separate interface needed.** Per
      `docs/MEASUREMENT_RIG.md` (confirmed live 2026-07-14): the mic patches
      directly into the Wing itself (channel 39, local input `LCL/2`, phantom
      on), not into anything on the mini PC. It comes back to the PC over the
      same Wing USB-C connection wing-brain already uses (matrix 6 → USB out
      2 → PC `IN 2`, `audio.micInputChannel = 2`). No USB-A→XLR adapter to buy.

## HARDWARE ARRIVAL (mini PC + WING-LIVE/SoundGrid card)

- [x] Mini PC: install Windows updates, disable sleep/hibernate, set power plan
      to High Performance, static IP on the console VLAN.
      **Done 2026-07-24, partial:** power plan set to Ultimate Performance
      (Windows 11 hides the old "High Performance" preset — this is the same
      tier or better); standby + hibernate timeouts confirmed 0 (never) on both
      AC/DC; hibernate confirmed off (no `hiberfil.sys`). Windows Update: one
      pending item (a Defender antimalware-platform version bump, not a
      security update) failed to install headlessly with error `0x80240044`
      (sits right next to the documented `WU_E_NO_UI_SUPPORT`, consistent with
      a non-interactive-session limitation in the Windows Update Agent COM API)
      — low priority, Defender platform updates self-install on their own
      background schedule regardless of main OS updates, not worth chasing
      further. **Static IP on the console VLAN: not done** — this machine is
      currently DHCP on the office network (192.168.0.0/24); needs the actual
      church console VLAN's subnet/gateway once known, didn't want to guess at
      network config on the machine I'm remoted into.

      **2026-07-27: found why the machine kept sleeping despite "never"
      being set.** This hardware uses Modern Standby (S0 Low Power Idle),
      confirmed via the event log — the classic idle timer really is 0
      (never), but Modern Standby drops into a low-power state on its own
      screen-off/no-foreground-need heuristic regardless, then briefly wakes
      (repeated ~25-31 second exit→re-enter cycles all day, e.g. 8:07am,
      9:58am, 12:12/24/31pm, 3:43pm — a wake-timer-driven maintenance
      pattern, not idle-timeout sleep). Applied the known fix: set
      `HKLM\SYSTEM\CurrentControlSet\Control\Power\PlatformAoAcOverride`
      (DWORD) = `0`, which forces classic S3 sleep instead of Modern
      Standby — S3 *is* purely idle-timer driven, so "never" will actually
      mean never once it's active. **Needs a reboot to take effect — not
      done yet, user wanted to pick the timing.** Not guaranteed to work if
      this hardware's firmware has no S3 fallback at all; if sleeping
      continues after the reboot, that's the likely reason, and next step
      would be checking BIOS/UEFI for any power-state option, or looking at
      third-party keep-awake tooling instead.
- [ ] Install SoundGrid driver + firmware for the Wing card. Confirm the Wing
      shows the card in SETUP and the PC sees the SoundGrid ASIO device.
      **Checked 2026-07-24: not installed** (no `HKLM:\SOFTWARE\ASIO` entries,
      nothing SoundGrid-named on disk). Per Waves' own docs the driver installs
      *bundled with a SoundGrid application* (e.g. SoundGrid Studio) via Waves
      Central, not as a standalone download — next step is opening Waves
      Central and installing that application from your account, or
      waves.com/downloads if it's not listed there.
- [x] Install REAPER (free full evaluation) — do NOT buy SuperRack Performer yet;
      B0 decides. **Confirmed installed: REAPER 7.78.**
- [x] Install Waves Central + your plugin licenses on the mini PC.
      **RESOLVED 2026-07-27.** 258 plugin bundles installed under
      `Plug-Ins V17`; PSE/Tune Real-Time/F6 initially didn't register in
      REAPER's FX list at all (traced to a `LicenseGUID` in each plugin's
      `Info.xml` not being recognized — see `docs/DECISIONS.md`), then
      registered but ran in demo mode (periodic muting) — user's theory was
      a license-seat conflict with a different PC that previously had these
      same plugins + SuperRack installed. User worked through a
      deactivation flow in Waves Central; license file jumped from 635
      bytes to 58KB and a fresh login token landed. **Confirmed fixed**: all
      4 plugin windows (PSE, Tune Real-Time, RCompressor, F6) floated for a
      visual check — user confirmed no demo watermark, "looks great."
- [x] REAPER: Preferences → Audio → Device → ASIO → SoundGrid, 48 kHz,
      start at 128 samples. **Driver + sample rate confirmed 2026-08-12** —
      verified directly from `reaper.ini`'s `[audioconfig]` section (real
      format, finally confirmed after two failed research attempts earlier
      tonight — worth keeping for next time):
      `asio_driver_name="Waves SoundGrid ASIO"`, `asio_srate=48000`,
      `asio_srate_use=1`, `asio_input0=0`/`asio_input1=63` (all 64 channels
      available). Buffer needed changing in the SoundGrid Driver Control
      Panel specifically (`asio_bsize_use=0` means REAPER defers to the
      driver's own buffer setting) — **user set it to 128 samples there,
      confirmed via screenshot.** Fully done: driver, sample rate, and
      buffer all at target. **Nothing left blocking B0.1 except actually
      running the 30-minute soak.**

## BENCH TEST B0 — REAPER vs SuperRack (the architecture decision)

Build one vocal chain in REAPER: track with PSE → Tune Real-Time → compressor → F6.
**2026-07-27: built and verified structurally** — `scripts/build-vocal-chain.lua`
(load via Actions → Show action list → New action → Load ReaScript, or run
`reaper.exe -nonewinst scripts/build-vocal-chain.lua` against an already-running
REAPER) creates a "Vocal Chain (B0)" track with all 4 FX in order. Compressor
choice: RCompressor (RComp) — low CPU/latency, simple "set and forget" for
unattended live use, over multiband C4/C6 (overkill for one channel) or
character/mix tools CLA-76/SSLComp. Structurally built and licensing-clear
(demo-mode resolved) — not yet functionally soak-tested with real audio,
that's what B0.1 below is for.

- [ ] **B0.1 Stability/latency:** route a vocal mic Wing→REAPER→Wing insert.
      Play/talk through it for 30+ min at 128 samples with 8 copies of the chain
      on 8 tracks. PASS: no crackles/dropouts, round-trip latency acceptable by ear
      (target well under ~10 ms total insert latency).
      **System-level prep done 2026-07-27** (standard pro-audio reliability
      practices, verified applied not just attempted): added `reaper.exe` to
      Windows Defender's process exclusion list (AV scanning REAPER's
      real-time audio thread is a well-known dropout cause) and disabled USB
      selective suspend on both AC/DC (prevents Windows power-managing the
      Wing's USB-C connection mid-show). Both confirmed via an elevated
      re-check, not just trusted from the change command's own output.
      Waves demo-mode/license-seat blocker is now **resolved** (see above),
      and as of 2026-08-12 the hardware blocker is gone too — the Wing is
      physically here, SoundGrid audio is confirmed working end-to-end
      (`Waves SoundGrid ASIO`, 64/64 channels, 48kHz/128 samples all
      confirmed set). **Every prerequisite is now done.** All that's left
      is actually running the 30-min soak — needs a human talking through
      the chain and judging by ear, not something to run unattended or
      substitute for.
- [x] **B0.2 OSC control (replaces old B1):** enable REAPER OSC
      (Preferences → Control/OSC/web → Add → OSC, "Local port" 8000, note the IP).
      Run `node scripts/test-reaper-osc.mjs <reaper-ip>` from this kit.
      PASS: the script moves a named FX parameter and reads the value back.
      Then identify Tune Real-Time's key/scale parameter index with
      `scripts/list-fx-params.lua` and confirm the same script can set it.
      **Params found 2026-07-27**: Tune Real-Time is FX #2 on the track;
      `Scale Type` = param 12, `Scale Root` (the key) = param 13. OSC
      addresses: `/track/1/fx/2/fxparam/12/value` and
      `/track/1/fx/2/fxparam/13/value`.
      **B0.2 core: PASS, confirmed 2026-07-27.** User enabled OSC in
      Preferences (Local port mode, listen port 8000, "Allow binding to
      actions/FX learn" checked). Ran `test-reaper-osc.mjs` against
      `Scale Root` — no feedback came back to the script's own UDP listener,
      but read the parameter's true value directly via a ReaScript check
      afterward and confirmed it landed exactly on the last value sent
      (0.5). **External OSC control of a named FX parameter is proven
      working.** The missing piece is the read-back/feedback direction
      specifically — REAPER never sent anything to the script's listening
      port. Didn't chase this further; best guess is "Local port" mode is
      receive-oriented rather than fully bidirectional (the dialog never
      asked for a remote/device port to push feedback to, unlike the
      "Configure device IP+device port" mode) — unconfirmed, worth trying
      that mode instead if live feedback (e.g. for a future touch UI status
      display) is ever needed.
- [ ] **B0.3 Touchscreen feel:** open the chain's FX windows on the 15" screen.
      Note what's annoying — that list becomes the spec for the custom touch layout.
- [ ] **B0.4 SELECT-follow:** load `scripts/select_follow.lua` (Actions → Show
      action list → New action → Load ReaScript). With the Wing sending MIDI on
      SELECT (or simulated via any MIDI note for now), PASS: the matching track's
      FX chain window comes to front.
      **Mechanism verified working 2026-07-27** — launched the script via
      `reaper.exe -nonewinst scripts/select_follow.lua` (it's already running
      in the current REAPER session, no need to load it again) and drove
      track selection programmatically as a stand-in for the Wing MIDI:
      selecting a track opened its FX chain (`TrackFX_GetChainVisible`
      confirmed visible) and correctly closed the previous track's chain each
      time, both directions. What's left is genuinely just the human/MIDI
      part — manually selecting tracks in the actual REAPER GUI (or Wing
      SELECT once at church) to confirm it feels right, not the underlying
      logic, which already works.

**Decision rule:** B0.1 + B0.2 both PASS → build on REAPER. B0.1 fails after
buffer/driver tuning → SuperRack fallback (architecture doc already covers it).

## CHURCH SESSION AGENDA (book ~an afternoon, empty room)

1. Full Wing scene/show backup to USB — verify it reloads.
2. Run the state-dump script (we write it together that day, ~30 min) → JSON audit.
3. Review audit + approve channel remap plan → execute reorg → line-check verify
   → save new baseline scene + fresh backup.
4. Fill in the real Wing output OSC addresses in `src/wing/client.js` (TODOs).
5. Verify live audio capture path in `src/audio/io.js` against SoundGrid.
6. Walk the room with the building sketch → replace `config/room.json` positions.
7. Run first real **Full Tune** → A/B the result → save baseline.
8. Record ~1 hour of OSC traffic during any rehearsal → mock replay data.
9. TODO(church): confirm where the electrical sub/main crossover actually
   lives — Wing output processing, amp DSP, or inside a powered speaker.
   `wing-brain`'s `config.system.crossoverHz` only guards EQ recommendation
   and advisor reasoning around the sub/main handoff region; it never writes
   an actual crossover filter, so this stays an open physical signal-chain
   question until confirmed on-site.
10. TODO(church): **confirm the main/mtx/bus name-read addresses** (~30 sec).
    Run `node scripts/read-console-names.mjs --host <wing-ip>` and compare the
    printed names against the console's scribble strips. `/main/N/name` is
    confirmed; `/mtx/N/name` and `/bus/N/name` follow the same confirmed
    `/ch/N/name` pattern but are not yet live-verified. If a whole KIND comes
    back "(no reply)" while its strips are named on the surface, fix
    `nameAddress()` in `scripts/wing-schema.mjs` (the single place) from the
    console's OSC docs. Once the printed names match, move those addresses into
    CLAUDE.md's confirmed list. The routing picker degrades safely until then
    (shows bare designations like "MTX 6"), so this is verification, not a
    blocker.
    **2026-08-12: very likely confirmed, not yet promoted.** A full
    `dump-wing-state.mjs` run (not the dedicated script, but same address
    patterns) got real names back for 16/16 buses and 5/8 matrices —
    including `mtx6: MEAS MIC`, matching `MEASUREMENT_RIG.md`'s documented
    tap exactly. The 3 silent matrices (4/7/8) are scattered, not a clean
    "whole kind fails" pattern, so they read as unused/unnamed slots rather
    than a broken address pattern — but that's an inference, not the actual
    physical scribble-strip comparison this TODO calls for. Do that quick
    check, then promote `/mtx/N/name` and `/bus/N/name` to CLAUDE.md's
    confirmed list.

## RESULTS (fill in)

### 2026-08-14 — TIME-BOXED CERTIFICATION SESSION (90 min budget): steps 1-2 PASS, step 3 BLOCKED on a new audio-I/O bug, steps 4-6 not reached

Goal was the certification block only (not a full tune): connection check,
address verification, the repeatability test, SPL calibration, geometry
ground truth, pre-flight. Actual outcome: steps 1-2 fully passed; step 3
(the main event) never got to run a single sweep — blocked one layer below
the test itself, in raw audio I/O. Steps 4-6 not reached. Read the whole
entry — several things changed from the 2026-08-12 session's state.

**Step 1 (connection) — PASS, but flagged a real reliability problem.**
git pull clean, 324/324 tests, server started in live mode. **The Wing's
OSC connection dropped and recovered FOUR separate times during this
session** (ping to `192.168.1.137` going completely dead — not just OSC,
ICMP too — then recovering after a retry a few minutes later, no pattern
to the timing). User's working theory, not yet confirmed: a specific
network switch in the chain is the recurring cause, and restarting it may
fix this permanently — **verify this on the next visit before assuming
it's resolved.** If it recurs, this needs real investigation (bad
switch/port, WiFi AP issue, interference) before a live tune day, since a
mid-service OSC drop would be a real problem even though audio itself
doesn't route through that path.

**Step 2 (console address verification) — PASS.** 28/28 addresses
answered via `scripts/read-console-names.mjs`, user visually confirmed
every name against the physical scribble strips. `/main/N/name`,
`/mtx/N/name`, `/bus/N/name` promoted to CLAUDE.md's confirmed list.
Noted in passing: MTX 3 and MTX 6 are BOTH named "MEAS MIC" — previously
only MTX 6 was documented as the measurement tap; not investigated further
(not blocking), worth asking about next visit.

**Audio I/O had to be rebuilt entirely before step 3 could even attempt to
run** (not in the original time budget, but a hard prerequisite): this
session runs on a different PC than 2026-08-12's assumption baked into
`MEASUREMENT_RIG.md` — **no direct USB-C connection from this PC to the
Wing exists anymore**; the only audio interface is `Waves SoundGrid ASIO`
(confirmed via `naudiodon.getDevices()`). Rebuilt the whole measurement
signal path on the SoundGrid `MOD` io-group instead of the Wing's native
`USB` io-group, preserving the original design (Aux 1 "PC" for sweep
injection, channel 39 → Matrix 6 for mic, Main 4 for reference):
- New reference tap: `/io/out/MOD/20` ← `MAIN/4` (mirrors the old USB/1 tap).
- New mic tap: `/io/out/MOD/21` ← `MTX/6` (mirrors the old USB/2 tap).
- `config/default.json`: `audio.inputDevice`/`outputDevice` → `"Waves
  SoundGrid ASIO"`, `referenceInputChannel: 20`, `micInputChannel: 21`.
- Aux 1 "PC"'s source was initially set to `MOD/1` (assuming ASIO output
  channel 1 = MOD slot 1 by default) — **this was WRONG**. The user has
  their own SoundGrid-side routing (set up separately in the SoundGrid
  software, not the Wing) that maps the PC's actual output to `MOD 63/64`,
  not slot 1. Corrected: Aux 1 now sources `MOD/63`. **Lesson: ASIO
  channel number does not necessarily equal MOD slot number** — that
  mapping is configurable inside the SoundGrid software itself, is
  apparently already been customized on this rig, and must be confirmed
  from the SoundGrid side (not assumed from the Wing side) before wiring
  anything else through it.

**Step 3 (repeatability test) — BLOCKED, not failed; never got to run
a single sweep.** Added `TuneSession.repeatSweep()` (session.js) + a
`repeat_sweep` WebSocket action (server.js) + a small terminal-driven
client (`scripts/run-repeat-sweep.mjs`) to run N back-to-back sweeps on
one physical output at the fixed verify position without walking the full
multi-position wizard — this is real, working, tested code (324/324 still
pass) and should work once the underlying bug below is fixed. **The
blocker**: `src/audio/io.js`'s `playAndCapture()`/`captureAmbient()` poll
`while (framesCaptured < nCaptureFrames) await sleep(20)`, waiting on the
ASIO stream's `'data'` event — and against `Waves SoundGrid ASIO`, **that
event never fires at all**. Isolated with a minimal standalone script
(bypassing wing-brain entirely): a plain symmetric 2-channel
`naudiodon.AudioIO` stream against this exact device, `.start()`ed, real
signal presumably present — **zero bytes received after 3 seconds**. This
rules out a channel-count-specific bug (the real config uses 21 channels
in / 2 out; the isolated test used 2/2 and still hung) — this is a
fundamental, first-time integration issue between wing-brain's own
`naudiodon`-based capture code and this specific ASIO device. Every prior
successful use of `Waves SoundGrid ASIO` on this project (REAPER's own
audio engine, last session) went through a completely different, mature
ASIO host application — wing-brain's own `io.js` has **never** been
exercised against this device before today, only against the Wing's old
direct 2-channel USB-C interface. Not resolved this session; genuinely
needs dedicated debugging time (compare against a known-working naudiodon
ASIO example against a *different* multi-channel interface; check for a
buffer-size/driver-negotiation issue specific to this device's 128-sample
ASIO buffer; consider whether naudiodon 2.3.6 has known issues with this
class of device). **Next session should start here** — nothing past this
point in the certification block can be attempted until raw capture works
at all.

**Steps 4-6 (SPL calibration, geometry ground truth, pre-flight) — not
reached.** All three need either a working sweep/capture path (4, 6) or
just didn't get to before time ran out (5, which is actually
network/audio-independent — pure data entry into `room.json` — and could
be done at the very start of next session with zero setup cost if the
user has the fly-height/room-dimension numbers handy).

**Session continued past the certification block into vocal-chain setup**
(user's own redirect once step 3 was blocked): found and fixed a second
real problem, then rebuilt the affected REAPER work.

- **`/aux/1/in/conn` was pointed at the wrong MOD slot.** Two sessions ago
  this was set to `MOD/1` on the assumption that wing-brain's hardcoded
  ASIO output channels (1-2) map 1:1 to MOD slot 1 by default. The user
  has since set up their **own routing inside the SoundGrid software
  itself** (separate from anything on the Wing) that sends the PC's actual
  output to **MOD 63/64**, not slot 1. Corrected `/aux/1/in/conn` to
  `MOD/63`. **Lesson, worth remembering**: ASIO channel number and MOD
  slot number are only the same by default — that mapping lives inside
  the SoundGrid application and can be (and here, was) customized
  independently of anything visible from the Wing's OSC side. Always
  confirm the actual SoundGrid-side routing before assuming the default.
- **REAPER's entire project was found empty** (0 tracks, unsaved, no
  file) when trying to add vocal FX chains to the other 3 vocal channels.
  Everything built two sessions ago — all 19 channel-routing tracks,
  VERN's FX chain — is gone; the project was evidently never saved to
  disk and was lost on some REAPER restart/close between sessions.
  Rebuilt from scratch: `scripts/build-live-routing.lua` re-ran cleanly
  (all 19 tracks back, I_RECINPUT 0-18 confirmed correct via a new
  diagnostic, `scripts/list-tracks.lua`), then a new script,
  `scripts/build-vocal-chains-remaining.lua`, added the standard vocal
  chain (PSE → Tune Real-Time → RCompressor → F6) to **all 4** vocal
  tracks (Main, VERN, RENITA, SCOTT) — confirmed via its own report file,
  all 4 loaded clean, no gaps.
  **The project has been explicitly saved this time**
  (`scripts/save-project.lua` → `wing-brain/data/wing-live-session.rpp`,
  confirmed 77KB of real content on disk) specifically so this doesn't
  happen a third time — but note the in-app "current project path" still
  reported unsaved right after the script ran (a `Main_SaveProjectEx`
  quirk, not investigated further), so **next session: open
  `wing-live-session.rpp` directly rather than trusting the running
  instance still has it associated**, and do a real Ctrl+S once it's
  confirmed to actually persist the association.
- **Still open, not yet checked**: whether channels 2 (Main), 4 (RENITA),
  5 (SCOTT) have the Wing-side external-FX-insert configured (FX
  Processor slot → TYPE=EXTERNAL → SEND/RETURN=MOD/N) the same way VERN's
  was two sessions ago — this still requires the manual touchscreen steps
  documented in the 2026-08-12 entry below, once per channel, since the
  OSC address for it remains unconfirmed. No vocal chain testing with a
  live mic happened this session — ran out of time right as REAPER's FX
  chains finished rebuilding.

**⚠️ CRITICAL for next session — the Wing scene will have changed.**
User is reloading the console's normal Sunday-service scene so the board
is usable for tonight, immediately after this session ends. Every live OSC
change made across today's session and the 2026-08-12 session (channel
remap, MOD routing, ALT sources, the two new measurement taps at MOD
20/21, Aux 1's source) lives in whatever scene was active during that
work — **not** the Sunday-service scene about to be loaded. Next session
must **reload the correct working scene first**, before assuming any of
this documented routing state still matches the console's live state.
Scene name/number was not captured before the switch (a quick OSC query
attempt — `/-scene/current`, `/scene`, `/$scene` — returned nothing under
time pressure) — **ask the user which scene to reload**, don't guess.

### 2026-08-12 (evening, after the channel remap) — LIVE ROUTING: SoundGrid round-trip built, then pivoted mid-session to an insert-based vocal architecture

Same evening as the channel remap below, immediately after. Goal: get every
channel's audio into the mini PC and back, so it can be processed
externally. What was actually built, and how the plan changed partway
through — read the whole entry before assuming any one step is still the
current approach, since the vocal architecture changed near the end.

**Wing-side SoundGrid routing (still current, unaffected by the later
pivot)**:
- Discovered the Wing's SoundGrid card exposes a **send** map
  (`/io/out/MOD/<n>/grp` + `/in`, 64 slots) that taps a physical input
  directly out to the network, and a symmetric **return** map
  (`/io/in/MOD/<n>`) that brings network audio back in — confirmed the
  group token is `MOD`, not `USB` or a literal `WSG` (the touchscreen's
  display label for it).
- Scanning all 64 send slots found only 2 already configured — both
  leftover from earlier ad-hoc testing, **one of them silently wrong**:
  channel 3 (VERN)'s MAIN input was pointed at `MOD` (a SoundGrid return)
  instead of its real mic, with the real mic (`CRD` group, index 16)
  demoted to ALT — except `CRD/16` turned out to be **dead** (gain/phantom
  addresses returned null, meaning it's not a populated physical slot at
  all). VERN's actual mic is `A/3`, labeled "VOX 2" on the physical input
  with a real, non-default gain setting — cross-checked via
  `/io/in/<grp>/<n>/name` + `/g` + `/vph` before trusting it. Channel 2
  ("Main") had the identical stale pattern (`MOD` on MAIN, dead `CRD/23` on
  ALT, real source `A/2` "VOX 1"). Both fixed: real mic restored to MAIN,
  `MOD` moved to ALT.
- Established a clean **MOD slot N = channel N** convention for all 19
  channels (channel 3 already fit this pattern by luck; channel 2 was
  moved from its old slot 1 to slot 2 to fit it too, since no REAPER track
  yet depended on the old slot 1 assignment). For each channel, its real
  physical MAIN source was read, a MOD send slot configured to source that
  same signal, and the channel's ALT set to that MOD slot. All 19 verified
  via readback.
- `/ch/N/in/conn/altin` (and by extension the whole ALT side) needs the
  same `raw+1`-on-write behavior as `/ch/N/in/conn/in` — confirmed
  empirically, not yet promoted into `wing-schema.mjs` as a committed fix
  (all of tonight's routing writes so far were done as direct one-off OSC
  scripts, not through `apply-remap.mjs`, so this is a note for whoever
  next builds routing tooling into the schema, not a shipped fix).
- **`/ch/N/in/set/altsrc`** (not `/ch/N/in/conn/set/altsrc` as an earlier
  session's notes had it — that path doesn't exist) is the actual
  MAIN/ALT active-source toggle: `0` = MAIN (confirmed as the untouched
  baseline on every channel checked), `1` = ALT. All 19 channels were set
  to `1` (verified) to bring the SoundGrid path live, then a decision
  later in the session (see below) called for reverting the 4 vocal
  channels back to `0` — **that revert's success is UNCONFIRMED**: the
  Wing dropped off the network (ping to `192.168.1.137` stopped replying
  entirely, likely the console/network being powered down as the session
  ended) before the write could be verified. **First thing to check next
  session**: read back `/ch/2,3,4,5/in/set/altsrc` and confirm they're
  `0`, not still `1`.

**REAPER-side build (superseded for vocals, see pivot below; instruments
still use this pattern)**:
- REAPER's audio device (Preferences → Audio → Device) showed ASIO input
  channels named `Wing-1 Exp <N>` (1-64) but **output channels named
  `SoundGrid <N>`** — a different naming scheme on the same driver. This
  turned out to matter: audio was flowing in (REAPER metering fine) but
  **not** flowing back to the Wing (no metering on any MOD input slot)
  until the user found and fixed a separate **output routing** setting
  inside the SuperRack SoundGrid host app itself — input worked without
  that step, output did not. Worth remembering for next time: SoundGrid's
  input and output paths are not symmetric in what setup they require,
  even though the Wing-side OSC addressing is symmetric.
- `scripts/build-live-routing.lua` was written to build/configure one
  REAPER track per channel (input capture + hardware-output send, both
  targeting ASIO channel index `N-1` to match `Wing-1 Exp <N>` /
  `SoundGrid <N>`), reusing the existing "Vocal Chain (B0)" track for
  channel 3 rather than duplicating it. **Ran successfully without the
  user touching REAPER's GUI at all**, via
  `reaper.exe -nonewinst <script.lua>` from a shell on the same machine —
  confirmed this forwards to the already-running instance (verified no
  second REAPER process was spawned) rather than needing the Action List,
  which the user couldn't locate in this REAPER skin/layout. Useful
  pattern for any future one-shot ReaScript that shouldn't require GUI
  navigation.

**Mid-session architecture pivot**: the user decided to use **SuperRack
Performer instead of REAPER** for the actual live vocal processing, and —
more importantly — to route **vocals differently from instruments**:
- **Instruments**: keep using the ALT-source round-trip built above
  (channel's active source becomes the processed PC signal entirely).
- **Vocals**: use the Wing's own **external FX insert** mechanism instead,
  so the channel's monitor/IEM sends can stay pre-insert (dry) while FOH
  gets the post-insert (processed) signal — something the ALT-source swap
  can't do, since swapping the whole channel's source has no separate dry
  tap. Reasoning: singers shouldn't hear pitch-correction/compression
  artifacts in their own monitors.
- Discovered via the console's own touchscreen (channel → an FX Processor
  slot → **FX TYPE: EXTERNAL**) that this insert mechanism's SEND/RETURN
  **reuse the exact same MOD-slot-per-channel pipe already built above** —
  confirmed on channel 3's screen showing `SEND: MOD 3` / `RETURN: MOD 3`.
  So the Wing-side routing work above wasn't wasted by the pivot; only
  *which* Wing mechanism consumes it changed, for vocals only.
  **`FX MIX` was at 0% (fully dry)** on channel 3's insert — remember to
  raise it once SuperRack is actually sending processed audio, or nothing
  will be audible through this path despite everything else being wired.
- **The OSC address for assigning an FX Processor slot to a channel is
  UNCONFIRMED** — tried `/ch/N/preins`, `/postins`, `/fx`, `/fx/N`,
  `/ch/N/proc`, `/peq`, `/ptap`, `/insert`, `/ins`, `/ext`, `/extfx`, and
  numbered/nested variants of all of these; every channel on the whole
  console (all 40) returns null for `preins`/`postins` even though they're
  listed as valid children of `/ch/N` in a container walk, and even after
  channel 3 was actively configured with `FX3` via the touchscreen.
  Whatever the real address is, it wasn't found by guessing. **Manual
  workaround used instead**: the user repeats the same touchscreen steps
  (FX Processor slot → TYPE=EXTERNAL → SEND/RETURN=MOD/<that channel's own
  number>) on the other 3 vocal channels (2/Main, 4/RENITA, 5/SCOTT) by
  hand. Automating this is a TODO for a future session if it's worth the
  investigation time.

**State the console was left in**: instruments (channels 6-19) on ALT,
routed to REAPER's plain pass-through tracks (no FX loaded on any of them
except channel 3, which isn't an instrument). Vocals (2-5) were being
reverted to MAIN when the Wing went unreachable — **unconfirmed, verify
first next session**. Only channel 3 has an FX Processor EXTERNAL insert
configured (FX MIX at 0%, so inaudible either way right now). SuperRack
Performer has not yet been installed/configured for this workflow — that
and the actual vocal effects chains are next-session work, along with the
originally-planned **system tuning** (`wing-brain`'s own measurement/EQ
tool, the project's first module, not yet run for real at this venue).

### 2026-08-12 (later same day) — CHANNEL REMAP: full renumbering to match the operator's physical layout

Same day as the first-hardware-session entry below, later that evening. User
wanted the console's channel *numbers* to match their physical mixing
layout (1 = card mic, 2 = Main, 3-5 = the three vocalists, 6-12 = piano/
keys/banjo/guitars/bass, 13-19 = drums) — a full-settings swap, not just a
rename, so each new channel number carries over the exact EQ/dynamics/gate/
etc. the instrument/mic previously had. Scope was confirmed explicitly with
the user mid-session: **everything** in the 19-channel list gets
renumbered, including piano/keys/banjo/guitars/bass (an earlier instruction
to leave those instruments alone was superseded by the final, more specific
layout).

- **Pilot swap first**: ch1 (KICK IN) ↔ ch20 (CARD MIC), including the
  channel *icon* (missing from the schema entirely until this session —
  fixed permanently, confirmed no `+1` offset needed unlike `col`). Found
  and fixed two real bugs in `scripts/apply-remap.mjs` /
  `scripts/wing-schema.mjs` during this pilot, both now covered by the test
  suite:
  1. **Continuous params need OSC float typing.** Whole-number values
     (fader, gate/dyn thresholds, EQ gains, etc.) sent as OSC ints are
     silently dropped by the Wing. Added `isContinuousParam()` +
     `sendFloat()` throughout the copy path.
  2. **Index-type params need `raw+1` on write.** `col` and
     `in/conn/in` are 0-indexed on read but must be written `raw+1` to
     round-trip correctly (confirmed empirically, twice, on different
     params) — the Wing normalizes back to the same raw value on the next
     read. Added `writeValueForCopy()` / `INDEX_ADDRESS`.
- **Computed the remaining 18-channel permutation** (channels 2-19) with a
  dependency-ordered topological algorithm, not naive per-node cycle
  detection. A first attempt wrongly treated a channel as a "closed"
  external source the first time it was visited, without noticing it was
  *also* the target of a still-pending move — e.g. channel 3 both receives
  VERN's data *and* is the source SNARE TOP's move needs to read first; the
  naive version would have let the VERN write clobber SNARE TOP before it
  was copied out. Correct algorithm: repeatedly fire any move whose source
  nothing else still needs, then break the two genuine cycles that remained
  (FLOOR↔PADS PIANO, KEYS↔OH) with a scratch channel each (real channels 29
  and 30, confirmed unused).
- **Executing the real plan surfaced three more previously-unknown
  categories of Wing OSC behavior**, all now fixed permanently in
  `wing-schema.mjs` / `apply-remap.mjs`:
  1. `dyn/mdl` (dynamics section has a selectable **model**, e.g. "COMP"
     full-featured vs "LA" opto-style) **gates which sub-parameters exist
     at all** — an "LA"-model channel has no `thr`/`ratio`/`att`/`rel`
     addresses; writing them is a silent no-op unless the model is
     switched to match first. Added `dyn/mdl` plus the previously-missing
     `mix`/`gain`/`knee`/`det`/`hld`/`env`/`auto` fields.
  2. **Same pattern on the gate section** (`gate/mdl`: "GATE" full vs "LA"
     reduced) — and the gate section had never been fully captured by
     *any* past remap in this project, only `on`/`thr`. Added `gate/mdl`
     plus `range`/`att`/`hld`/`rel`/`acc`/`ratio`.
  3. **Same pattern on channel EQ** (`eq/mdl`) — discovered a third EQ
     topology, `"SOUL"` (fixed lo-mid/hi-mid bands with their own
     freq/Q/gain instead of the documented 4 parametric bands), in use on
     at least the original KICK OUT channel. Added `eq/mdl` plus the
     SOUL-only `lmf/lmf3/lmq/lmg/hmf/hmf3/hmq/hmg` fields.
  4. **A parameter's value representation can itself be model-dependent**:
     `dyn/ratio` is a plain number under "COMP" but a stepped string enum
     (e.g. `"6:1"`) under a fourth model, `"NSTR"`. Fixed generically in
     `apply-remap.mjs` by choosing float-vs-plain `send()` based on the
     *actual runtime type* of the value being written, not just the
     address pattern — should absorb further model variants without
     another one-off patch.
- All 20 moves for channels 2-19 executed against the real console and
  independently verified via readback after each; then the entire 1-19
  layout was re-verified end-to-end in a fresh pass reading every channel
  name straight off the console. Final layout: 1 CARD MIC, 2 Main, 3 VERN,
  4 RENITA, 5 SCOTT, 6 PADS PIANO, 7 KEYS, 8 BANJ0, 9 ACOUSTIC GUITAR,
  10 LEAD GUITAR, 11 RHYTHM GUITAR, 12 BASS, 13 SNARE TOP, 14 SNARE BOT,
  15 DRUM PAD, 16 RACK, 17 FLOOR, 18 OH, 19 KICK OUT.
- The console's separate **USER-layer** (operator screen-position →
  real-channel display mapping) is untouched by any of this — confirmed
  it's a distinct mechanism from a channel's actual identity, and no OSC
  address for it was found (tried `/usr`, `/usrkeys`, `/userkeys`, `/key`,
  `/keys`, `/panel`, `/surface`, `/global`, `/glob`, `/action` — all
  timed out). User fixed the on-screen positions manually afterward.
- **Cleared the 7 leftover "duplicate" channels** the swap left behind
  (21, 22, 23, 24, 28 — the old numbers Main/VERN/RENITA/SCOTT/BANJ0 lived
  at before the swap — plus 29/30, the two scratch channels used for the
  FLOOR/PADS PIANO and KEYS/OH cycles): muted and blanked their names so
  they can't be mistaken for live channels or end up double-feeding a
  physical source that's now also patched to its new channel number.

### 2026-08-12 — FIRST REAL HARDWARE SESSION, live at church

The mini PC is now physically at the church, on the real network, first-ever
contact with the actual Wing. Network topology as set up: PC's WiFi adapter
→ church WiFi network (`192.168.25.0/24`); PC's Ethernet → a small isolated
Netgear switch with only the PC and the Wing on it (SoundGrid's own
dedicated network, no DHCP — both ends self-assigned link-local addresses,
which is correct/expected); Wing has two network legs — one to the church
network directly (carries OSC), one to the isolated switch (carries
SoundGrid audio). The SoundGrid card is physically installed in the Wing.

- **OSC control: CONFIRMED LIVE.** The Wing answers at `192.168.25.80:2223`
  — the same address documented from the 2026-07-14 visit, still valid.
  Ran a full `dump-wing-state.mjs` against it: 4223/4398 addresses answered
  (96%). Console configuration matches prior documentation exactly — channel
  39 is still "REFERENCE MIC", mains are still MAINS/SUBS/BROADCAST/LOBBY,
  matrix 6 is still "MEAS MIC" (matches `MEASUREMENT_RIG.md`'s tap). Nothing
  has drifted since the last visit. Real dump saved at
  `wing-brain/data/wing-state/2026-08-12T17-39-55-024Z.json` (gitignored,
  contains real venue data).
  **Later the same day: church installed a new UniFi network mid-session.**
  New Wing IP is `192.168.1.137` (subnet changed to `192.168.1.0/24`).
  Re-verified OSC on the new address too — 4238/4400 answered, same clean
  result. Updated `config/default.json` and `docs/MEASUREMENT_RIG.md` to
  the new address; second dump saved at
  `wing-brain/data/wing-state/2026-08-12T20-33-11-345Z.json`. One real
  troubleshooting detour along the way: the PC's WiFi got a DHCP address
  in the new range fine, but the Wing was unreachable at first (ICMP "host
  unreachable", no ARP resolution) — turned out to just be a typo in the
  IP the user read off the console (`.139` vs the real `.137`), not an
  actual network problem. Did check + have the user disable UniFi's
  "Client Device Isolation" on the relevant WiFi network as part of
  narrowing it down; that's a reasonable thing to leave off anyway for a
  permanent production network like this one, even though it wasn't the
  actual cause here.
  Console currently has 40 channels named (14/16/
  29-37 unused), 16 buses (mostly IEM mixes + drum/vocal processing), 4
  mains, matrices mostly named except 4/7/8 (see item 10 above).
- **SoundGrid: driver + hardware confirmed alive, but ASIO not exposed yet
  — pinpointed to one specific remaining step.** In order:
  1. SoundGrid driver is now installed (wasn't, last session).
  2. `naudiodon`'s `getHostAPIs()` shows `Waves SoundGrid ASIO` by name but
     **skips** it (0 devices) — however WASAPI/WDM-KS both see it as a real,
     alive device (`Speakers (Waves SoundGrid)`, `Line In/Microphone (Waves
     SoundGrid)`, valid sample rate/channel/latency info, one kernel filter
     — "SG Wave" — created successfully with valid pins). This is real
     hardware talking back, not "nothing connected" like every prior check.
  3. Opened the **SoundGrid Driver Control Panel**: correctly pointed at
     the right NIC (the Ethernet/isolated-switch adapter), buffer currently
     256 samples (checklist target is 128, not yet changed — low priority
     until the device is actually visible to REAPER). Its own text says a
     **separate SoundGrid host application** must "assign the driver in the
     inventory" before ASIO will actually work.
  4. Found the free host app is **SoundGrid Studio** — but it's no longer
     offered standalone in Waves Central's catalog, only bundled with paid
     "eMotion ST" mixer tiers (confirmed via real Sweetwater/B&H retail
     listings, not a guess). Did not install any of these — didn't want to
     risk a paid activation for something that should be free.
  5. User instead installed **"SuperRack SoundGrid"** (free, distinct from
     the already-installed "SuperRack Performer") directly from Waves'
     website per something they recalled from a YouTube video. This is a
     legitimate, different SoundGrid host application.
  6. Launched it. **Confirmed via `SGDawNodeService.log`**: right before
     launch, the correct NIC (`58:47:ca:7a:1e:6b`) was actually successfully
     activated (`retval: true`). Launching SuperRack SoundGrid **reset it to
     "None"** (`00:00:00:00:00:00`), which then failed
     (`Could not Start Kernel Driver Streaming err: -1036`). SuperRack
     SoundGrid's own log confirms: `"The selected network port is
     [00:00:00:00:00:00 - None]"`.
  7. Checked for a config file or registry key holding this network-port
     selection (so it could be fixed without a GUI click) — found nothing;
     the only registry key present (`HKCU\SOFTWARE\Waves Audio\SPRK`) just
     has window-position data. Didn't force a blind fix into undocumented
     app state. **What's left is one GUI step**: open SuperRack SoundGrid's
     own Settings and select the correct network port (the same
     Realtek 2.5GbE adapter already selected in the Driver Control Panel).
  8. Confirmed the Wing itself is a first-class supported SoundGrid device
     — there's a dedicated `SoundGrid Wing Control` module referencing
     `Behringer_WING_v2.wfi`, not a generic fallback.
  9. **RESOLVED.** User opened SuperRack SoundGrid's SETUP screen, selected
     the correct network port there (not just in the Driver Control Panel),
     and the Wing appeared in Inventory as "Wing-1" — ON, DIG, 48kHz.
     Re-checked `naudiodon`: **`Waves SoundGrid ASIO` now shows 64 input /
     64 output channels, fully populated.** This was independently verified
     (re-ran the device enumeration after the change), not just assumed
     from the UI looking right. SoundGrid audio is no longer a blocker for
     anything.
- **Backup reminder**: flagged the church-session-agenda item 1 (full Wing
  scene/show backup to USB) before doing anything OSC-related. Status not
  confirmed as of this writing — everything done today was read-only
  regardless (state dump, no writes), so it wasn't a blocker for today, but
  do this before any future step that writes to the console.

### 2026-07-24/25 — office session on the actual UM690 Pro (mini PC), no Wing/SoundGrid on the network

Ran this session split between what's genuinely headless-verifiable and what
needs a human physically present (talking through a live mic for 30+ min,
judging latency "by ear," touching the touchscreen, clicking through REAPER's
GUI). Machine specs confirmed live: AMD Ryzen 9 6900HX (8C/16T), 16 GB
physical RAM (**13.7 GB visible to Windows** — the iGPU reserves the rest;
worth knowing for the "one box or two" question below).

- **SoundGrid ASIO driver: NOT installed.** No `HKLM:\SOFTWARE\ASIO` entries
  found, no SoundGrid-named folder anywhere under Program Files. Per Waves'
  own docs, the SoundGrid driver installs *bundled with a SoundGrid
  application* (e.g. SoundGrid Studio) via Waves Central, not as a standalone
  download — so the next step is opening Waves Central and installing that
  application from your account's available downloads (waves.com/downloads
  if it's not listed there). This is an account/GUI action, not something to
  automate blind.
- **Waves plugins: PSE ("Primary Source Expander"), Waves Tune Real-Time, and
  F6 are all physically installed** (`Plug-Ins V17\`), plus a device-locked
  license already active on this machine (`last.lgn` +
  `LastAcceptableMACAddress.txt` present, `Demo Mode\V17` empty — no plugins
  currently in demo). No single plugin named "compressor" — CHECKLIST doesn't
  specify which; C1/C4/C6/RComp/CLA-76/SSLComp etc. are all present as
  options. **Caveat: the plugin install was still running live during this
  check**, so treat this as a snapshot, not final — re-verify once the
  install finishes before actually building the chain.
- **REAPER 7.78 confirmed installed.** OSC is not yet enabled in
  `reaper.ini` — I looked for a way to enable it by editing the config file
  directly (to avoid needing the GUI) but couldn't find a verified,
  documented `csurf_N` OSC line format, and this is the machine that's
  actually going to church, so I didn't want to guess at config-file syntax
  and risk a corrupted REAPER config. This is a ~30 second GUI step instead:
  Preferences → Control/OSC/web → Add → OSC, Local port 8000, note the IP.
- **Resource test (partial):** launched REAPER (empty, no project/FX chain)
  alongside `wing-brain`'s dev server simultaneously — idle footprint was
  small (REAPER ~134 MB across its two processes, wing-brain's node
  processes ~156 MB combined), CPU spiked briefly to ~6.9% then settled, free
  RAM barely moved (6.6→6.4 GB free). **This is not the real test** — it
  proves the two apps don't conflict at idle, not that there's headroom
  under real load (8 tracks × 4 Waves plugins doing live DSP + wing-brain
  actually capturing/analyzing audio). That needs the actual chain built and
  running, which is blocked on the plugin install finishing + SoundGrid
  driver + real audio flowing. Closed REAPER afterward so it wouldn't
  conflict with the in-progress Waves install (Waves Central sometimes needs
  the DAW closed to update plugin files safely).
- `scripts/test-reaper-osc.mjs`, `scripts/list-fx-params.lua`,
  `scripts/select_follow.lua` all present and ready at the toolkit root —
  none of them have been run yet since OSC isn't enabled and no FX chain
  exists to point them at.

- B0.1: **NOT RUN** — needs real audio hardware (none connected) + a human
  talking through the chain for 30+ min and judging latency by ear. Buffer
  size target is still 128 samples per the plan; unconfirmed in practice.
- B0.2: **NOT RUN** — blocked on enabling OSC in REAPER's prefs (GUI, ~30
  sec) and building the FX chain (blocked on the Waves install finishing).
  Once both are done, `node scripts/test-reaper-osc.mjs <reaper-ip>` then
  `list-fx-params.lua` on the Tune track are ready to go immediately.
- B0.3: **NOT RUN** — needs a human at the touchscreen with FX windows open.
- B0.4: **NOT RUN** — `select_follow.lua` is staged and ready to load
  (Actions → Show action list → New action → Load ReaScript →
  `scripts/select_follow.lua`); testing it by manually selecting tracks is a
  GUI/human step.
- Decision: REAPER / SuperRack — **not yet decidable**, B0.1 and B0.2 (the
  two the decision rule actually depends on) are both still open.
