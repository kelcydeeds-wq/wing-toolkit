# Phase 0 scripts

- `test-reaper-osc.mjs` — B0.2. Dependency-free Node OSC client: wiggles an FX
  parameter in REAPER and listens for feedback. Run from any machine on the LAN.
- `list-fx-params.lua` — B0.2 helper. Dumps FX parameter names/indices for the
  selected track so you can find Tune Real-Time's key + scale parameters.
- `select_follow.lua` — B0.4. Floats the FX chain of whatever track is selected;
  drive selection from the Wing via MIDI-learned select actions (today) or the
  brain box over OSC (later).

Order: get audio stable (B0.1) → run list-fx-params → run test-reaper-osc against
the Tune key param → load select_follow and press SELECT on the console.
