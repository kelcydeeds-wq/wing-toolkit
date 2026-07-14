# Measurement rig — confirmed signal routing (2026-07-14)

The exact console + PC routing that makes a live measurement work at this church.
Established and validated end-to-end on 2026-07-14 (plumbing proven; mic *data*
that day was discarded — construction noise). Reproduce this for a real tune.

## Hardware / network
- **Console:** Behringer WING ("FusionFOH"), firmware 3.0.5.
- **Wing IP / OSC:** `192.168.25.80` : `2223` (in `config/default.json` → `wing`).
- **Audio interface:** the Wing's built-in **USB-C audio** — appears to the PC as
  `IN 1-2 / OUT 1-2 (BEHRINGER WING-USB)`. There is **no SoundGrid card**.
  Wing USB config `usbacfg = 48/48` @ 48 kHz. (`config` → `audio.inputDevice`/
  `outputDevice`.)
- **Measurement mic:** Behringer ref mic on **channel 39** ("REFERENCE MIC"),
  patched to local input `LCL/2`. Needs **phantom** (`/io/in/LCL/2/vph = 1`),
  gain ~12.5 dB.

## Signal path
```
                 PC plays sweep out "OUT 1-2 (WING-USB)"
                                  │  (USB in ch 1)
                                  ▼
        Aux 1  "PC"  ( /aux/1  sourced from USB/1 )   fader ~ -20 dB
             │  (send to Main 4, always on = REFERENCE)
             │  (isolate: on/off sends to Main 1 / 2 / 3 = output under test)
             ├─────────────► Main 4 (LOBBY, no speaker) ──► /io/out/USB/1
             │                                                 = PC IN 1 = REFERENCE
             ▼                                                  (audio.referenceInputChannel = 1)
   Main 1 / 2(sub) / 3   ← EQ BYPASSED for a flat measurement
             │  (only the isolated one is fed)
             └──────────────► speakers ──► ROOM
                                             │
                          measurement mic ◄──┘ (ch 39, LCL/2, phantom on)
                                  │
                     ch39 ──(pre-fader send)──► Matrix 6 ──► /io/out/USB/2
                                                              = PC IN 2 = MIC
                                                              (audio.micInputChannel = 2)
```

## ⚠️ Main-link: isolate by SOURCE, not by muting masters
`/cfg/mainlink = 2` groups **Main 1 (MAINS) + Main 2 (SUBS)** as a linked
main/sub pair — so **muting Main 1 force-mutes the sub** (Main 2's effective
`$mute` goes to 2 = inherited). Proven live. Do NOT change the main-link (it's
the intended show behavior), and do NOT isolate outputs by muting masters (the
app's default `soloOutput` does this — it will kill the sub).

**Isolate by source routing instead:** the sweep source is Aux 1 "PC", which has
independent on/off sends to each main. Route the sweep to ONE output at a time and
leave every master unmuted:

| Measuring | aux1→main1 | aux1→main2 (sub) | aux1→main3 |
|-----------|:---:|:---:|:---:|
| Mains | ON | OFF | OFF |
| Sub   | OFF | ON | OFF |
| Broadcast | OFF | OFF | ON |

Because no master is muted, the main-link never fires; only the target output
receives the sweep, so the mic hears only that output.

**Reference must tap the SOURCE, not Main 1.** If the reference taps Main 1, it
goes silent whenever you isolate a non-mains output. Instead route Aux 1 "PC" →
**Main 4** (LOBBY — patched to no physical output, so it's silent in the room) →
USB out 1. Main 4 always carries the sweep regardless of isolation, and MAIN→USB
taps are reliable (matrix→USB taps need their in-matrix USB channel unmuted).

## The rules that make it work (learned the hard way)
- **Reference and mic must be on INDEPENDENT taps.** USB out 1 taps **Main 1
  directly**; USB out 2 taps a matrix fed **only** by the mic. Do **not** put both
  on one *stereo* matrix — a stereo matrix L/R-links, so both USB channels end up
  identical (main-bus sends have no pan to separate them). Verified: linked = the
  two captures were bit-identical; separated = they differ (that's the goal).
- **A USB output can only source `MAIN`, `BUS`, `AUX`, `MTX`, or `OFF`** — never a
  raw channel. That's why the mic has to pass through a matrix (or bus) first.
- **Unmute the matrix's USB input.** A muted USB channel inside the measurement
  matrix silently kills the tap (cost us a while — the matrix metered fine but
  passed nothing until unmuted).
- **Flatten before measuring:** bypass Main 1 EQ (`/main/1/eq/on 0`) and flatten
  the Aux 1 "PC" EQ, so you measure the room+speakers, not existing console EQ.
- **Matrix numbering:** the console UI groups matrices as stereo pairs, so its
  "Matrix 3" = OSC `mtx5`/`mtx6`. Watch that translation.
- **OSC value types:** faders/gains/freqs/Q/delay must be sent as **floats** (raw
  units — dB, Hz, ms); the Wing ignores integer-typed values for these. Fader/
  gain "0 dB" is a float, not integer 0. (Handled in code via `osc.sendFloat`.)

## Measurement-session console state (what to set)
1. Aux 1 "PC" fader up to ~**-20 dB** (measurement level; higher gets loud fast).
2. Main 1 EQ **bypassed** (flat). Original curve is snapshotted to
   `data/main1-eq-snapshot.json`.
3. Mic path live: `/ch/39/send/MX6` on, **PRE**, ~0 dB; `mtx6` unmuted, fader ~0 dB.
4. Reference: `aux1→main4` on, `main4` unmuted; `/io/out/USB/1 = MAIN/4`.
   Mic: `/io/out/USB/2 = MTX/6`.
5. Per output under test, set `aux1→main1/2/3` on/off (see the isolation table
   above). Leave all masters unmuted.

## Restore to show-ready (after measuring)
- Re-enable Main 1 EQ (`/main/1/eq/on 1`) and restore its bands from
  `data/main1-eq-snapshot.json`.
- Put Aux 1 "PC" fader back where it lives for playback.
- Restore `/io/out/USB/1` and `/io/out/USB/2` to their pre-session sources
  (original: USB out 2 ← MAIN/2 — snapshot in `data/usb-out2-snapshot.json`).
- Turn off the measurement matrix sends if you don't want them left up.
