-- build-vocal-chain.lua — Bench Test B0: builds the vocal FX chain
-- (PSE -> Tune Real-Time -> RCompressor -> F6) on a new track, so B0.1/B0.2
-- don't need it built by hand in the GUI first.
--
-- Load via: Actions -> Show action list -> New action -> Load ReaScript,
-- then run it once. Safe to re-run -- it won't duplicate FX on the same
-- track (TrackFX_AddByName with instantiate>0 reuses an existing instance).
--
-- Plugin names below are REAPER's actual registered names (confirmed against
-- this machine's reaper-vstplugins64.ini, 2026-07-27) -- note these can
-- differ from the marketing name: Primary Source Expander registers as just
-- "PSE", and the "compressor" the checklist didn't specify a pick for is
-- RCompressor (RComp) -- chosen for low CPU/latency and being a simple,
-- reliable "set and forget" vocal compressor for unattended live use, over
-- the multiband C4/C6 (overkill for one channel) or the character/mix tools
-- CLA-76/SSLComp (need more careful gain-staging).

local CHAIN = {
  "VST3: PSE Mono (Waves)",
  "VST3: Waves Tune Real-Time Mono (Waves)",
  "VST3: RCompressor Mono (Waves)",
  "VST3: F6 Mono (Waves)",
}

reaper.Undo_BeginBlock()

local trackIdx = reaper.CountTracks(0)
reaper.InsertTrackAtIndex(trackIdx, true)
local track = reaper.GetTrack(0, trackIdx)
reaper.GetSetMediaTrackInfo_String(track, "P_NAME", "Vocal Chain (B0)", true)

reaper.ShowConsoleMsg("Building vocal chain on new track...\n")
local ok = true
for i, fxname in ipairs(CHAIN) do
  local fxIndex = reaper.TrackFX_AddByName(track, fxname, false, 1)
  if fxIndex < 0 then
    reaper.ShowConsoleMsg(("  [MISSING] %s -- not found/licensed on this machine\n"):format(fxname))
    ok = false
  else
    reaper.ShowConsoleMsg(("  [%d] %s\n"):format(i, fxname))
  end
end

reaper.SetOnlyTrackSelected(track)
reaper.TrackFX_Show(track, 0, 1) -- open the chain window so it's visible immediately

reaper.Undo_EndBlock("Build B0 vocal chain (PSE -> Tune RT -> RCompressor -> F6)", -1)
reaper.UpdateArrange()

if ok then
  reaper.ShowConsoleMsg("\nDone -- all 4 FX loaded on \"Vocal Chain (B0)\".\n")
else
  reaper.ShowConsoleMsg("\nDone with gaps -- see [MISSING] lines above.\n")
end
