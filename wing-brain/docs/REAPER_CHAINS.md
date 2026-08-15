# REAPER FX chains — per-channel design (2026-08-14)

Consolidated reference for the FX chains built across the 2026-08-14
session (see `CHECKLIST.md`'s dated entries for the full narrative of how
these were built and corrected). The live project file is
`wing-brain/data/wing-live-session.rpp` — open that directly in REAPER
rather than assuming a running instance still has it associated (see
`DECISIONS.md`'s note on a `Main_SaveProjectEx` quirk).

**Status: structurally correct starting point, not a finished mix.** No
plugin parameter (wet level, reverb decay time, delay tempo-sync, gate
threshold, compression ratio — nothing) has been tuned by ear yet. This
is the *chain* (which processors, in what order) for each channel; the
actual settings need a human listening to real signal, which hasn't
happened yet as of this writing (blocked partly by the console being
mid-service, partly by `wing-brain`'s own audio capture bug — see
`STATUS.md`).

## How this was built

Four scripts, in order, each idempotent (safe to re-run):
1. `scripts/build-vocal-chains-remaining.lua` — base vocal chain on all 4
   vocal tracks.
2. `scripts/build-instrument-chains.lua` — category-appropriate gate/EQ/
   comp chain on all 15 non-vocal tracks.
3. `scripts/build-elevation-style-fx.lua` — ambience/character pass
   ("Elevation Worship style") layered on top.
4. `scripts/fix-fx-tier-and-latency.lua` — corrected two problems found
   in an audit (H-Reverb isn't Waves Essential-tier despite heavy use;
   Silk Vocal measured ~23ms real latency, too high for live use).

Re-running all four in order against a fresh/empty project reproduces the
current state exactly (all `TrackFX_AddByName` calls use `instantiate=1`,
which reuses an existing instance rather than duplicating).

## Plugin roster — every plugin currently in use

All 12 confirmed **Waves Essential subscription tier** (checked against
the real current list at waves.com/subscriptions/essential, 2026-08-14 —
123 plugins, not assumed from plugin-family naming) **and** confirmed
**real reported latency** on this machine (`TrackFX_GetNamedConfigParm`
`"pdc"`, not a spec-sheet claim):

| Plugin | Role | Latency |
|---|---|---|
| PSE (Primary Source Expander) | gate/expander | 0 samples |
| RCompressor (Renaissance) | compression | 64 samples (~1.45ms) |
| RDeEsser (Renaissance) | de-essing | 64 samples (~1.45ms) |
| REQ 6 (Renaissance) | parametric EQ | 0 samples |
| RBass (Renaissance) | low-end enhancement | 0 samples |
| Waves Tune Real-Time | pitch correction | 0 samples |
| F6 | dynamic EQ | 0 samples |
| H-Delay | tempo-syncable delay | 0 samples |
| MetaFlanger | modulation/width | 0 samples |
| TrueVerb | reverb | 0 samples |
| Vitamin | harmonic warmth/presence | 0 samples |
| OneKnob Driver | saturation/warmth | 5 samples (~0.11ms) |

Ceiling latency across the entire 19-channel design: **~1.45ms**
(RCompressor/RDeEsser). Imperceptible for live use.

**Do not add H-Reverb, Silk Vocal, or "Kramer Tape"** (as opposed to
"Kramer Master Tape") to any future chain without re-checking both tier
and latency first — all three were tried and rejected this session (see
`CHECKLIST.md`'s 2026-08-14 entries for why). Plugin-family naming is not
a reliable guide to either property.

## Per-channel chains

Order = signal flow, left to right.

| Channel | Chain | Category |
|---|---|---|
| CARD MIC | PSE → RCompressor → RDeEsser | Speech mic — deliberately no reverb/delay (see below) |
| Main | PSE → Tune RT → RCompressor → F6 → Vitamin → H-Delay → TrueVerb | Vocal |
| VERN | PSE → Tune RT → RCompressor → F6 → Vitamin → H-Delay → TrueVerb | Vocal |
| RENITA | PSE → Tune RT → RCompressor → F6 → Vitamin → H-Delay → TrueVerb | Vocal |
| SCOTT | PSE → Tune RT → RCompressor → F6 → Vitamin → H-Delay → TrueVerb | Vocal |
| PADS PIANO | REQ 6 → RCompressor → MetaFlanger → TrueVerb | DI/line |
| KEYS | REQ 6 → RCompressor → MetaFlanger → TrueVerb | DI/line |
| DRUM PAD | REQ 6 → RCompressor → TrueVerb | DI/line |
| BANJ0 | PSE → REQ 6 → RCompressor → TrueVerb | Mic'd/plucked, gated |
| ACOUSTIC GUITAR | PSE → REQ 6 → RCompressor → TrueVerb | Mic'd/plucked, gated |
| LEAD GUITAR | PSE → REQ 6 → RCompressor → H-Delay → TrueVerb → MetaFlanger | Mic'd/plucked, gated + ambient shimmer |
| RHYTHM GUITAR | PSE → REQ 6 → RCompressor → H-Delay → TrueVerb | Mic'd/plucked, gated |
| BASS | RCompressor → RBass → REQ 6 → OneKnob Driver | Bass — dry, no reverb/delay (see below) |
| SNARE TOP | PSE → REQ 6 → RCompressor → TrueVerb | Close-mic'd drum, gated |
| SNARE BOT | PSE → REQ 6 → RCompressor | Close-mic'd drum, gated — no ambience (see below) |
| RACK | PSE → REQ 6 → RCompressor → TrueVerb | Close-mic'd drum, gated |
| FLOOR | PSE → REQ 6 → RCompressor → TrueVerb | Close-mic'd drum, gated |
| OH | REQ 6 → RCompressor → TrueVerb | Overhead — ungated on purpose (see below) |
| KICK OUT | PSE → REQ 6 → RCompressor | Close-mic'd drum, gated — no reverb (see below) |

## Design reasoning — the exceptions matter as much as the additions

- **CARD MIC has no reverb/delay.** This is the pastor's speech mic —
  ambience on a sermon reads as a mixing mistake, not a style choice.
- **KICK OUT and BASS carry no reverb/delay.** A tight, dry low end is
  *part of* the "big" modern-worship sound, not an oversight — the big
  vocal/guitar/pad verbs only read as big against a clean foundation;
  reverb down low just muddies the mix.
- **SNARE BOT has no ambience.** It's a phase/reinforcement mic (blended
  with SNARE TOP for tone, not meant to carry its own sense of space).
- **OH (overheads) is deliberately ungated**, unlike every other drum
  channel — gating overheads chops the cymbal decay, which is exactly the
  thing overheads exist to capture.
- **Guitars were NOT given amp-simulation plugins** (`GTR Amp`/`GTR
  Stomp`, also available and Essential-tier) — it's unknown whether lead/
  rhythm guitar are DI signals (which would need a sim) or already mic'd
  on a real amp (where a sim would double-process the tone incorrectly).
  **Ask the user which it is** before adding amp sim to either channel.
- **Lead Guitar gets the heaviest ambient treatment** (delay + reverb +
  modulation) — the washy, atmospheric "shimmer" electric guitar texture
  is arguably the single most recognizable element of this production
  style, more than any other single choice in this chain design.
