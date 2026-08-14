-- build-vocal-chains-remaining.lua — adds the standard vocal FX chain
-- (PSE -> Tune Real-Time -> RCompressor -> F6, same as VERN's existing
-- "Vocal Chain (B0)"/"VERN" track) to the other 3 vocal channels' tracks:
-- "Main", "RENITA", "SCOTT". Reuses the tracks build-live-routing.lua
-- already created (input=Wing-1 Exp N / hardware output send already
-- wired) rather than creating new ones -- if a named track isn't found,
-- reports it as missing rather than guessing.
--
-- Safe to re-run: TrackFX_AddByName with instantiate>0 reuses an existing
-- instance rather than duplicating.
--
-- Run via: reaper.exe -nonewinst <this file>
-- Writes a plain-text report to build-vocal-chains-report.txt next to this
-- script (Lua's io.open, not ShowConsoleMsg) so it can be read back
-- without needing REAPER's own console window.

local CHAIN = {
  "VST3: PSE Mono (Waves)",
  "VST3: Waves Tune Real-Time Mono (Waves)",
  "VST3: RCompressor Mono (Waves)",
  "VST3: F6 Mono (Waves)",
}

local TARGET_TRACKS = {"Main", "VERN", "RENITA", "SCOTT"}

local function findTrackByName(name)
  local target = name:lower()
  for i = 0, reaper.CountTracks(0) - 1 do
    local tr = reaper.GetTrack(0, i)
    local _, trName = reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", "", false)
    if trName:lower() == target then return tr end
  end
  return nil
end

local report = {}
local function log(line) report[#report + 1] = line end

reaper.Undo_BeginBlock()

for _, trackName in ipairs(TARGET_TRACKS) do
  local track = findTrackByName(trackName)
  if not track then
    log(trackName .. ": TRACK NOT FOUND -- expected it to already exist from build-live-routing.lua")
  else
    log(trackName .. ":")
    local ok = true
    for i, fxname in ipairs(CHAIN) do
      local fxIndex = reaper.TrackFX_AddByName(track, fxname, false, 1)
      if fxIndex < 0 then
        log("  [MISSING] " .. fxname .. " -- not found/licensed on this machine")
        ok = false
      else
        log("  [" .. i .. "] " .. fxname .. " (fx index " .. fxIndex .. ")")
      end
    end
    if ok then log("  -> all 4 FX loaded OK") else log("  -> loaded WITH GAPS, see [MISSING] above") end
  end
end

reaper.Undo_EndBlock("Build vocal FX chains on Main/RENITA/SCOTT", -1)
reaper.UpdateArrange()

local reportPath = "C:\\Users\\Waves PC\\wing-toolkit\\scripts\\build-vocal-chains-report.txt"
local f = io.open(reportPath, "w")
if f then
  f:write(table.concat(report, "\n"))
  f:write("\n")
  f:close()
end
