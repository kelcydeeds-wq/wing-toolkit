# wing-brain — System Tune Module

First module of the AI-assisted mixing system ("the brain"). This module is the
**PA tuning utility**: guided multi-point measurement from your phone, dual-channel
transfer-function math, delay alignment, and guarded EQ recommendations toward a
worship target curve.

Runs on the mini PC (or any laptop for development). The phone is just a browser
on the same network — walk the room, move the Behringer reference mic, tap **Ready**.

## Quick start (office / mock mode)

```bash
npm install
npm run dev        # starts in MOCK mode — simulated Wing + simulated room
```

Open `http://localhost:3000` on the PC, or `http://<pc-ip>:3000` on your phone
(same WiFi). Mock mode simulates a two-main + sub PA in a reverberant room so the
entire workflow — positions, sweeps, analysis, results — can be exercised with zero
hardware.

## Church mode

Edit `config/default.json`:

```json
{
  "mode": "live",
  "wing": { "host": "192.168.1.50", "port": 2223 },
  "audio": { "inputDevice": "SoundGrid", "outputDevice": "SoundGrid",
             "referenceInputChannel": 1, "micInputChannel": 2 }
}
```

Signal plan (per MASTER_BUILD_PLAN §system-tune):
- Brain box plays the sweep out an output patched to a Wing input → routed to mains.
- The same sweep is captured back as the **reference channel** (loopback through the
  Wing on a spare bus/direct-out), and the Behringer measurement mic comes back as
  the **mic channel**.
- Because reference and mic share the same capture clock, PC↔Wing latency cancels
  in the cross-correlation. No delay calibration step exists because none is needed.

## What the two buttons do

- **Verify System** (~2 min, one position): delay/polarity/level check per output,
  response compared against stored baseline. Run any Sunday.
- **Full Tune** (guided multi-point): sweep at each marked position → spatially
  averaged response → proposed alignment delays + guarded EQ toward the target
  curve → **A/B preview before anything is written to the console.**

## Guardrails (enforced in code, see src/dsp/tune.js)

- Auto-EQ only below `eqAutoMaxHz` (default 300 Hz) from averaged data.
- Above that: tilt shaping only, wide Q, cut-biased.
- Never boosts into a null (cancellation detection via position variance).
- Max cut 6 dB, max boost 3 dB, max 8 filters per output.
- Nothing is written to the Wing without an explicit Apply tap; baseline scene
  saved first; one-tap revert.

## Repo layout

```
src/server.js        HTTP + WebSocket, serves the phone UI, session orchestration
src/tune/session.js  Measurement session state machine (positions, retakes, results)
src/dsp/measure.js   Sweep generation, deconvolution, transfer function, delay find
src/dsp/tune.js      Averaging, target curve, guarded EQ/delay recommendations
src/wing/client.js   Wing OSC client (live) + mock console
src/audio/io.js      Audio capture/playback abstraction (live via sox/portaudio, mock)
public/              Phone-first web UI
config/              Target curves, guardrails, device config
docs/ROOM_LAYOUT.md  How to enter the building layout + measurement positions
```

## Status / integration points needing the church session

- `src/audio/io.js` live capture path must be verified against the SoundGrid ASIO
  device on the mini PC (mock path is complete).
- Wing OSC addresses for output EQ/delay are stubbed with TODOs pending the state
  dump from the audit session (mock console implements them).
- Measurement positions: placeholder 4-position layout in `config/room.json` —
  replace after the building-sketch session.
