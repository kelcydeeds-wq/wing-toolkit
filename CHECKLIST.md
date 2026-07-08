# PHASE 0 — GETTING STARTED CHECKLIST

Work through this in order. Each bench test has a PASS criterion — record the
result, because the results decide the architecture (REAPER vs SuperRack, brain
box placement). Bring this file's results section to our next session.

---

## NOW (office, no hardware needed)

- [ ] Unzip `wing-brain`, run `npm install`, then `npm run dev`
- [ ] Open the printed address on your phone (same WiFi) → run a mock **Full Tune**
      end to end. You should walk through 5 positions and land on a review screen
      with delay + EQ recommendations. This is the exact church workflow.
- [ ] Create the GitHub repo, push `wing-brain`. All future work lands here.
- [ ] Get a USB-A→XLR or interface plan for the Behringer measurement mic on the
      mini PC (if the mic will come back through the Wing instead, note that —
      it changes `config/default.json` audio input mapping, nothing else).

## HARDWARE ARRIVAL (mini PC + WING-LIVE/SoundGrid card)

- [ ] Mini PC: install Windows updates, disable sleep/hibernate, set power plan
      to High Performance, static IP on the console VLAN.
- [ ] Install SoundGrid driver + firmware for the Wing card. Confirm the Wing
      shows the card in SETUP and the PC sees the SoundGrid ASIO device.
- [ ] Install REAPER (free full evaluation) — do NOT buy SuperRack Performer yet;
      B0 decides.
- [ ] Install Waves Central + your plugin licenses on the mini PC.
- [ ] REAPER: Preferences → Audio → Device → ASIO → SoundGrid, 48 kHz,
      start at 128 samples.

## BENCH TEST B0 — REAPER vs SuperRack (the architecture decision)

Build one vocal chain in REAPER: track with PSE → Tune Real-Time → compressor → F6.

- [ ] **B0.1 Stability/latency:** route a vocal mic Wing→REAPER→Wing insert.
      Play/talk through it for 30+ min at 128 samples with 8 copies of the chain
      on 8 tracks. PASS: no crackles/dropouts, round-trip latency acceptable by ear
      (target well under ~10 ms total insert latency).
- [ ] **B0.2 OSC control (replaces old B1):** enable REAPER OSC
      (Preferences → Control/OSC/web → Add → OSC, "Local port" 8000, note the IP).
      Run `node scripts/test-reaper-osc.mjs <reaper-ip>` from this kit.
      PASS: the script moves a named FX parameter and reads the value back.
      Then identify Tune Real-Time's key/scale parameter index with
      `scripts/list-fx-params.lua` and confirm the same script can set it.
- [ ] **B0.3 Touchscreen feel:** open the chain's FX windows on the 15" screen.
      Note what's annoying — that list becomes the spec for the custom touch layout.
- [ ] **B0.4 SELECT-follow:** load `scripts/select_follow.lua` (Actions → Show
      action list → New action → Load ReaScript). With the Wing sending MIDI on
      SELECT (or simulated via any MIDI note for now), PASS: the matching track's
      FX chain window comes to front.

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

## RESULTS (fill in)

- B0.1: PASS / FAIL — buffer size ____, notes:
- B0.2: PASS / FAIL — Tune key param index ____, notes:
- B0.3: annoyances list:
- B0.4: PASS / FAIL — notes:
- Decision: REAPER / SuperRack
