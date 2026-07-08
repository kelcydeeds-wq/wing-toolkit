# Decisions log

Running log of judgment calls made during autonomous work runs, so they can be
reviewed and reversed if wrong.

## 2026-07-08 — refinement run (Parts A + B)

- **CLAUDE.md and AI_MIX_MASTER_BUILD_PLAN.md do not exist** in this repo (only
  CHECKLIST.md at the toolkit root). The target channel layout for task 7 was
  taken from the task prompt itself (1-5 pastor+vocals, 6-10 keys+spare,
  11-16 guitars/bass+spares, 17-23 drums, 24 vocal FX DCA, 25 crown mics,
  39-40 osc/talkback) and written to `config/target-layout.json`.
- **`npm run dev` used Unix env-var syntax** (`MODE=mock node ...`) which fails
  on Windows, where development currently happens. Switched to `cross-env`
  (devDependency). Also changed `npm test` glob to `node --test test/` — cmd
  does not expand globs.
- **`.env` loading re-added to server.js** (`process.loadEnvFile`, Node 20.12+)
  so the Claude advisor key works with plain `npm run dev`. `.env` is
  gitignored.
- **Wing OSC address scheme is unverified.** All live OSC paths are best-guess
  from public Wing OSC documentation and marked `TODO(church)`. Every remote
  read is timeout-guarded so wrong addresses degrade to `null` instead of
  hanging. The state dump at the church session is the source of truth.
- **Preflight blip**: implemented as a 0.5 s log sweep (reuses ESS machinery)
  rather than pink noise — the capture/level path is identical and it keeps
  measure.js the only signal generator. Pass criterion: returned level above
  -55 dBFS and at least 20 dB above the capture noise floor.
- **Session history**: capped at 5 most-recent full-tune sessions in
  `data/sessions/`, pruned oldest-first at save time. Traces included, so files
  are ~1-2 MB each.
- **Sweep level trim** is a per-output config field (`sweepTrimDb`), applied to
  the playback buffer only — analysis normalizes level, so trims don't skew EQ
  judgment. Sub default set to -6 dB.
- **Guardrail limits untouched** per run rules; guardrail *code* gained tests
  only.
