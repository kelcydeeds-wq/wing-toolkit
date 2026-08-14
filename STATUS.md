# Wing Toolkit — current status (as of 2026-08-14)

This is a handoff snapshot for a fresh Claude session that does **not** have
access to this repo or the conversation that produced it. It should stand on
its own. For the operational punch list see `CHECKLIST.md`; for detailed
rationale/history behind every judgment call below see
`wing-brain/docs/DECISIONS.md`; for project conventions see `CLAUDE.md`.

## ⚠️ READ FIRST: the Wing's live scene has changed since this routing was built

Everything below describing channel routing / MOD slots / ALT sources was
built during a working session, and **the user reloaded the console's
normal Sunday-service scene immediately after that session ended** (2026-
08-14) so the board was usable that evening. None of the OSC state
described in this file is guaranteed to still be true on the console —
**ask the user which scene to reload before trusting or building on any
of it**, don't assume the last-known state still holds. The codebase/config
files are unaffected (this is purely about the console's own live state).

## What this is

An AI-assisted live-mixing system built around a Behringer Wing console at a
church. `wing-brain` is the first module: a phone-driven PA measurement/
tuning tool. The longer-term system is three-tier: **Wing console** (audio
I/O + mix engine, controlled over OSC) → **mini PC ("the brain box")** (runs
`wing-brain` for measurement, plus REAPER for instrument processing and
SuperRack Performer for vocal processing — see "Live routing" below; the
formal B0 bench-test decision was never closed out, but the user informally
settled on this split mid-session on 2026-08-12) → **phone** (the control
surface, any browser on the same WiFi).

## Physical situation right now

The mini PC in question is a **UM690 Pro (AMD Ryzen 9 6900HX, 16GB RAM,
Windows 11 Pro)** — this is the actual machine that will physically travel to
the church, not a throwaway dev box. **It is now physically at the church,
connected to the real Wing.** Network: PC's WiFi → church network
(`192.168.25.0/24`, same subnet documented from the 2026-07-14 visit); PC's
Ethernet → a small isolated Netgear switch with only the PC and Wing on it
(SoundGrid's dedicated network, no DHCP, both ends link-local). The Wing has
two network legs: one to the church network (carries OSC), one to the
isolated switch (carries SoundGrid audio). The SoundGrid card is physically
installed in the Wing now. Real OSC contact and a real state dump have both
happened — see below.

## Live hardware session (2026-08-12) — first real contact with the Wing

- **OSC control: confirmed live.** The Wing answers at `192.168.1.137:2223`
  — church replaced their network with a new UniFi setup partway through
  this session (was `192.168.25.80` earlier the same day, matching the
  2026-07-14 visit; changed when the new network went in). Already updated
  in `config/default.json` and `docs/MEASUREMENT_RIG.md` — if this stops
  matching, re-read it off the Wing's own screen, don't assume either
  address. Ran a full state dump on the new address too: 4238/4400
  addresses answered (96%), Console config matches prior
  documentation exactly — channel 39 still "REFERENCE MIC", mains still
  MAINS/SUBS/BROADCAST/LOBBY, matrix 6 still "MEAS MIC". Nothing has
  drifted since the last visit. Two dumps saved this session (gitignored,
  real venue data — don't assume a fresh session can see them without
  re-running): `2026-08-12T17-39-55-024Z.json` (old IP, still valid data,
  just a stale filename) and `2026-08-12T20-33-11-345Z.json` (new IP,
  post-network-change).
- **SoundGrid: RESOLVED. `Waves SoundGrid ASIO` now shows 64/64 real
  channels**, independently re-verified after the fix (not just assumed
  from the UI). Path there: the driver saw the interface by name but
  PortAudio's ASIO backend was skipping it (WASAPI/WDM-KS saw it fine —
  real hardware, not "nothing connected"). Root cause was that getting
  ASIO to expose it needs a separate SoundGrid host application to
  "assign the driver in the inventory." The free option Waves Central's
  catalog offers now is only bundled with paid "eMotion ST" mixer tiers
  (verified against real retail listings — didn't risk an accidental paid
  activation). User instead found and installed the correct free app,
  **"SuperRack SoundGrid,"** from Waves' own website. Launching it reset
  the network port selection to "None" (confirmed via its own log — a
  working activation right before launch, then reset-to-null right after).
  Found no config file/registry key to fix that blind, so it stayed a GUI
  step: user opened SuperRack SoundGrid's SETUP screen, selected the
  correct port there, and the Wing appeared in Inventory as "Wing-1" (ON,
  DIG, 48kHz) — that's what actually fixed it. **Open question, not yet
  tested**: whether SuperRack SoundGrid's window needs to stay running
  indefinitely for the ASIO driver to keep working, or whether it's now
  set at a background-service level that survives closing it. Left it
  running for now. Full blow-by-blow is in `CHECKLIST.md`'s 2026-08-12
  results entry.
- **REAPER's own audio-device selection is the only remaining step for
  B0.1** — Preferences → Audio → Device → ASIO → Waves SoundGrid ASIO,
  48kHz, 128 samples (Driver Control Panel currently has buffer at 256,
  not yet changed). A GUI step, not yet done as of this writing.
- **Backup reminder flagged, not confirmed done**: the church-session
  agenda's first item (full Wing scene/show backup to USB) should happen
  before anything that *writes* to the console. Everything done today was
  read-only, so it wasn't a blocker yet — but don't skip it before the
  next step that writes.

## Channel remap: DONE (2026-08-12, evening)

The console's 19 working channels have been fully renumbered to match the
operator's physical mixing layout, with each channel's complete settings
(EQ, dynamics, gate, sends, tags/DCA/mute-group, icon) carried over from
wherever that instrument/mic used to live — not just a rename. Final
layout: **1 CARD MIC, 2 Main, 3 VERN, 4 RENITA, 5 SCOTT, 6 PADS PIANO,
7 KEYS, 8 BANJ0, 9 ACOUSTIC GUITAR, 10 LEAD GUITAR, 11 RHYTHM GUITAR,
12 BASS, 13 SNARE TOP, 14 SNARE BOT, 15 DRUM PAD, 16 RACK, 17 FLOOR,
18 OH, 19 KICK OUT.** Independently re-verified by reading every channel
name fresh off the console after all writes completed. Full narrative in
`CHECKLIST.md`'s "CHANNEL REMAP" results entry; the four Wing OSC quirks
this surfaced (dyn/gate/EQ per-channel "models" gating which sub-params
exist, plus a model-dependent value-representation case) are in
`wing-brain/docs/DECISIONS.md` and now permanently fixed in
`wing-brain/scripts/wing-schema.mjs` / `apply-remap.mjs`. Leftover
duplicate channels (21-24, 28-30, the old numbers before the swap) were
muted and blanked. The console's separate USER-layer screen-position
mapping isn't touched by any of this — user re-pointed it manually.

## Live routing: BUILT, then architecture changed mid-session (2026-08-12, evening) — READ BEFORE TOUCHING

Full detail in `CHECKLIST.md`'s "LIVE ROUTING" results entry and
`wing-brain/docs/DECISIONS.md`; short version for orientation:

- Every channel's ALT input source now points at a Wing SoundGrid `MOD`
  slot matching its own channel number (`MOD/N` for channel `N`), with a
  matching send configured to that channel's real physical mic/instrument
  input. This round-trip (Wing → SoundGrid → PC → back) is verified
  working for channel 3 (VERN) end-to-end.
- **Instruments** (channels 6-19) are meant to stay on this ALT-swap path.
  REAPER has a track per channel (`scripts/build-live-routing.lua`,
  input+output both wired), no FX loaded on any of them except VERN's.
- **Vocals** (channels 2/Main, 3/VERN, 4/RENITA, 5/SCOTT) changed plan
  mid-session: instead of the ALT-swap, they use the Wing's own
  **external-FX-insert** mechanism (a channel's FX Processor slot set to
  `FX TYPE: EXTERNAL`) so monitor sends can stay dry while FOH gets the
  processed signal. This insert's SEND/RETURN reuse the *same* `MOD/N`
  slot already built — only channel 3 has this actually configured on the
  console so far (FX MIX at 0%, so no audible effect yet either way).
  Processing software also changed from REAPER to **SuperRack Performer**
  for vocals specifically (not yet installed/configured for this).
- **The OSC address to assign an FX Processor slot to a channel is
  unconfirmed** — extensively probed, not found (see DECISIONS.md for the
  full list of addresses tried). Manual touchscreen setup only, for now.
- **Verify first, before anything else next session**: channels 2/3/4/5
  were being switched from ALT back to MAIN (`/ch/N/in/set/altsrc` → `0`)
  when the Wing dropped off the network entirely (not just OSC — basic
  ping to `192.168.1.137` stopped replying, most likely the console/network
  being powered down as the session ended). **Whether that revert actually
  landed is unconfirmed.** Read back `/ch/2,3,4,5/in/set/altsrc` first
  thing — if any are still `1`, that channel is silently depending on a
  PC/REAPER signal path with no FX loaded, instead of its direct mic.

## Confirmed working

- **`wing-brain` itself**: installed, full test suite passing (324/324).
  Mock "Full Tune" flow verified end-to-end via a scripted WebSocket
  walkthrough (all positions, including the shared-driver measurement
  wizard) — lands on a review screen with sane guarded EQ recommendations.
- **Live audio (ASIO)**: `naudiodon`'s published npm package does NOT ship
  with ASIO compiled in, despite code comments implying otherwise. Built a
  real ASIO-enabled PortAudio from source against a user-obtained Steinberg
  ASIO SDK; confirmed `getHostAPIs()` reports ASIO. Fully reproducible via
  `wing-brain/scripts/build-portaudio-asio.ps1` if `node_modules` is ever
  wiped (a plain `npm install` alone will silently regress this).
- **REAPER**: installed (v7.78, evaluation license).
- **Waves plugins**: ~258 bundles installed under `Plug-Ins V17`, including
  Primary Source Expander (registers as "PSE"), Waves Tune Real-Time, F6, and
  several compressor options.
- **B0 vocal chain built**: a "Vocal Chain (B0)" track exists in REAPER with
  PSE → Tune Real-Time → RCompressor → F6 in order, built via
  `scripts/build-vocal-chain.lua` (safe to re-run, won't duplicate FX).
  RCompressor chosen as the compressor (checklist didn't specify one) for
  low CPU/latency and being a reliable "set and forget" choice for
  unattended live use.
- **B0.2 core: PASS.** Tune Real-Time's key/scale OSC parameter indices are
  known (on the built track, Tune Real-Time is FX #2, `Scale Type` = param
  12, `Scale Root` (the key) = param 13; OSC addresses
  `/track/1/fx/2/fxparam/12/value` and `.../13/value`). User enabled OSC in
  REAPER's prefs (Local port mode, port 8000); `test-reaper-osc.mjs` was run
  against `Scale Root` and the parameter's true value was independently
  confirmed changed to match. **One open nuance**: REAPER never sent
  feedback back to the test script's UDP listener, even though the write
  direction worked — best guess is "Local port" OSC mode is receive-oriented
  rather than fully bidirectional; unconfirmed, worth trying "Configure
  device IP+device port" mode instead if live feedback is needed later
  (e.g. a touch UI status display).
- **B0.4 mechanism verified**: `scripts/select_follow.lua` (auto-floats the
  selected track's FX chain window) was launched and its actual behavior
  confirmed via `TrackFX_GetChainVisible` — selecting a track opens its
  chain and closes the previous one, both directions.
- **System-level audio-reliability prep**: `reaper.exe` added to Windows
  Defender's process exclusion list; USB selective suspend disabled (AC+DC);
  power plan set to Ultimate Performance; sleep/hibernate confirmed off.
  Verified applied via elevated re-checks, not just attempted.
- **Measurement mic resolved**: no separate USB interface needed on the mini
  PC — the mic patches directly into the Wing itself (channel 39, phantom
  power) and returns over the same Wing USB-C connection wing-brain already
  uses. Documented in `wing-brain/docs/MEASUREMENT_RIG.md`.

## Pending — needs a reboot

The machine was still sleeping unexpectedly despite the idle timer being set
to "never." Root cause: this hardware uses **Modern Standby**, which can
drop into a low-power state on its own screen-off heuristic independent of
the classic idle timer (confirmed via repeated ~25-30 second exit→re-enter
cycles in the event log all day, not idle-timeout-driven sleep). Fix applied
— `HKLM\SYSTEM\CurrentControlSet\Control\Power\PlatformAoAcOverride` (DWORD)
set to `0`, which forces classic S3 sleep instead (purely idle-timer
driven). **Requires a reboot to take effect — not yet rebooted**, user
wanted to pick the timing. Not guaranteed to work if this hardware's
firmware has no S3 fallback; if sleep continues after reboot, check
BIOS/UEFI for a power-state option next.

## Currently blocked

1. **Static IP on the console VLAN**: not set. Whether this is still needed
   is worth reconsidering now that the PC is actually on the church network
   via WiFi (DHCP) and reaching the Wing fine — may turn out to be
   unnecessary rather than just "not done yet."

That's the only real blocker left in the whole toolkit. REAPER's audio
device (`Waves SoundGrid ASIO`, 48kHz, 128 samples) is fully set and
verified — driver/sample-rate confirmed directly from `reaper.ini`, buffer
size confirmed via screenshot of the SoundGrid Driver Control Panel. Every
prerequisite for B0.1 is now done.

## Waves license issue: RESOLVED

PSE/Tune Real-Time/F6 ran in demo mode (periodic muting) even after they
registered in REAPER's FX list — turned out to be a license-seat conflict
with a different PC that previously had these same plugins + SuperRack
installed. User worked through a deactivation flow in Waves Central; the
license file jumped from 635 bytes to 58KB and a fresh login token landed.
**Confirmed fixed**: floated all 4 plugin windows for a visual check, user
confirmed no demo watermark. This was the last blocker for a meaningful
B0.1 — see below, the only thing stopping B0.1 now is hardware.

## Not yet run (need a human physically present)

- **B0.1** (30+ min stability/latency soak, judged by ear) — every
  prerequisite is done (SoundGrid audio confirmed end-to-end, REAPER's
  device/rate/buffer all set). Nothing left but actually running it.
- **B0.3** (touchscreen feel) — inherently physical/tactile.
- **B0.4** (the actual click-through test) — underlying mechanism already
  verified working; what's left is just a human doing it in the GUI (or the
  Wing sending real MIDI, now that it's actually reachable).

## Immediate next steps, in likely order

Updated 2026-08-14. B0.1/B0.3/B0.4 and the channel remap are done — see
"Channel remap: DONE" above. A certification session on 2026-08-14 got
through address verification but hit a real blocker; see `CHECKLIST.md`'s
2026-08-14 entries (two of them, same day) for the full narrative.

1. **Reload the correct Wing scene first** — see the warning at the top of
   this file. Ask the user which one; don't assume.
2. **`wing-brain`'s own audio capture is broken against the SoundGrid ASIO
   device** — `src/audio/io.js`'s `playAndCapture()`/`captureAmbient()`
   hang forever waiting for the ASIO stream's `'data'` event, which never
   fires (confirmed down to a minimal 2-channel reproduction outside
   wing-brain entirely — not a channel-count bug). This blocks the
   repeatability test, SPL calibration, and pre-flight check — i.e. most
   of the certification block and all of a real tune. **This is the top
   priority next session**, ahead of anything else in this list, since
   nothing downstream of it can be attempted. `TuneSession.repeatSweep()`
   (session.js) + `scripts/run-repeat-sweep.mjs` are already built and
   ready to use the moment capture works.
3. **REAPER's project must be saved deliberately, every session** — it
   was found completely empty (all prior work lost) at the start of the
   vocal-chain work on 2026-08-14. Rebuilt and saved to
   `wing-brain/data/wing-live-session.rpp` — open that file directly next
   session rather than trusting a running REAPER instance still has it
   associated (see DECISIONS.md for the exact quirk). Run
   `scripts/save-project.lua` again at the end of any session that
   touches REAPER.
4. Finish the vocal external-FX-insert setup by hand on channels 2
   (Main), 4 (RENITA), 5 (SCOTT) — channel 3 (VERN) was done 2026-08-12,
   the OTHER THREE WERE NOT YET CONFIRMED as of 2026-08-14 either (session
   ran out of time right before checking). See `CHECKLIST.md`'s "LIVE
   ROUTING" entry for the exact touchscreen steps. All 4 vocal tracks in
   REAPER now have the full FX chain loaded either way (PSE → Tune
   Real-Time → RCompressor → F6) — no vocal chain has actually been
   tested with a live mic yet.
5. Once capture works again: confirm the 2026-08-14 measurement-rig
   rewiring (MOD 20/21 taps, Aux 1 → MOD 63) survived whatever scene gets
   reloaded, then finally run the actual repeatability test.
6. Install/configure SuperRack Performer for vocals if still wanted
   (REAPER is currently doing this job and works fine — the SuperRack
   switch was a stated preference, not a blocker).
7. **Run `wing-brain`'s actual system tuning** at the venue — the
   phone-driven measurement/EQ tool that's the whole first module of this
   project, still not run for real at this venue. Gated on item 2 above.
8. Do the full Wing scene/show backup to USB (church-session-agenda item 1)
   if it hasn't happened yet — before anything further that writes to the
   console.

## Where everything lives

- `CHECKLIST.md` (toolkit root) — the full step-by-step punch list with a
  detailed Results section (dated entries, what's verified vs not).
- `wing-brain/docs/DECISIONS.md` — chronological log of every non-obvious
  judgment call, newest first. Check before re-deciding something already
  decided (e.g. the SoundGrid-vs-USB-C non-conflict above).
- `wing-brain/docs/MEASUREMENT_RIG.md` — the exact confirmed console+PC
  signal routing for a live measurement session.
- `CLAUDE.md` — project conventions, confirmed OSC address map, guardrail
  rules (never loosen `wing-brain`'s EQ safety limits).
- `scripts/` (toolkit root) — REAPER-side bench-test tooling:
  `build-vocal-chain.lua`, `test-reaper-osc.mjs`, `list-fx-params.lua`,
  `select_follow.lua`.
- `wing-brain/scripts/build-portaudio-asio.ps1` — rebuilds ASIO support if
  `node_modules` ever gets wiped; needs `wing-brain/.audio-build/ASIO-SDK.zip`
  (gitignored, not redistributable) to already be present.
