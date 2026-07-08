-- list-fx-params.lua — dump every parameter of every FX on the selected track
-- to the REAPER console. Use this to find Tune Real-Time's key/scale parameter
-- indices for OSC control (Bench Test B0.2).
--
-- Load via: Actions → Show action list → New action → Load ReaScript.
-- Select the vocal track first, then run.

local tr = reaper.GetSelectedTrack(0, 0)
if not tr then reaper.ShowConsoleMsg("Select a track first.\n") return end

local _, trName = reaper.GetTrackName(tr)
reaper.ShowConsoleMsg(("Track: %s\n"):format(trName))

local fxCount = reaper.TrackFX_GetCount(tr)
for fx = 0, fxCount - 1 do
  local _, fxName = reaper.TrackFX_GetFXName(tr, fx, "")
  reaper.ShowConsoleMsg(("\n== FX %d: %s ==\n"):format(fx + 1, fxName))
  local pCount = reaper.TrackFX_GetNumParams(tr, fx)
  for p = 0, pCount - 1 do
    local _, pName = reaper.TrackFX_GetParamName(tr, fx, p, "")
    local val = reaper.TrackFX_GetParam(tr, fx, p)
    -- OSC param numbers are 1-based: /track/N/fx/FX/fxparam/P/value
    reaper.ShowConsoleMsg(("  param %3d  %-32s = %.3f\n"):format(p + 1, pName, val))
  end
end
reaper.ShowConsoleMsg("\nOSC address pattern: /track/<n>/fx/<fx#>/fxparam/<param#>/value (all 1-based)\n")
