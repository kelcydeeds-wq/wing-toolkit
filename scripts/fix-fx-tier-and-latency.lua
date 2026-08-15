-- fix-fx-tier-and-latency.lua — corrects two problems found in the
-- "Elevation Worship style" pass: H-Reverb is NOT in the Waves Essential
-- subscription tier (verified against waves.com/subscriptions/essential,
-- 2026-08-14) despite being used on nearly every channel, and Silk Vocal
-- (IS Essentials-tier) reports 1087 samples (~23ms @44.1kHz) of real
-- processing latency -- verified via this machine's actual plugin builds
-- (TrackFX_GetNamedConfigParm(..., "pdc")), not a spec-sheet claim -- far
-- too high for a live insert chain. "Kramer Tape" is also a different,
-- unverified-tier product from the tier-listed "Kramer Master Tape".
--
-- Replacements (all confirmed Essentials-tier AND ~0ms real latency on
-- this machine, see scripts/replacement-latency-report.txt):
--   H-Reverb    -> TrueVerb          (reverb duties)
--   Silk Vocal  -> Vitamin           (vocal warmth/presence, low latency)
--   Kramer Tape -> OneKnob Driver    (bass warmth, 0.11ms)
--
-- Removes the old plugin by name (if present) then adds the replacement
-- (TrackFX_AddByName instantiate>0 is idempotent). New instance lands at
-- the end of the chain -- a minor reordering vs the original position,
-- accepted for simplicity; nothing here has been tuned by ear yet anyway.
-- Run via: reaper.exe -nonewinst <this file>

local REPLACEMENTS = {
  ["VST3: H-Reverb Mono (Waves)"] = "VST3: TrueVerb Mono (Waves)",
  ["VST3: Silk Vocal Mono (Waves)"] = "VST3: Vitamin Mono (Waves)",
  ["VST3: Kramer Tape Mono (Waves)"] = "VST3: OneKnob Driver Mono (Waves)",
}

local report = {}
local function log(line) report[#report + 1] = line end

reaper.Undo_BeginBlock()

for i = 0, reaper.CountTracks(0) - 1 do
  local tr = reaper.GetTrack(0, i)
  local _, trName = reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", "", false)
  local changed = false
  local lines = {}

  -- Walk backwards since we delete while iterating.
  for fx = reaper.TrackFX_GetCount(tr) - 1, 0, -1 do
    local _, fxName = reaper.TrackFX_GetFXName(tr, fx, "")
    local replacement = REPLACEMENTS[fxName]
    if replacement then
      reaper.TrackFX_Delete(tr, fx)
      local newIndex = reaper.TrackFX_AddByName(tr, replacement, false, 1)
      lines[#lines + 1] = "  " .. fxName .. "  ->  " .. replacement ..
        (newIndex >= 0 and " OK" or " FAILED TO ADD REPLACEMENT")
      changed = true
    end
  end

  if changed then
    log(trName .. ":")
    for _, l in ipairs(lines) do log(l) end
  end
end

reaper.Undo_EndBlock("Fix FX tier/latency: H-Reverb->TrueVerb, Silk Vocal->Vitamin, Kramer Tape->OneKnob Driver", -1)
reaper.UpdateArrange()

local f = io.open("C:\\Users\\Waves PC\\wing-toolkit\\scripts\\fix-fx-tier-and-latency-report.txt", "w")
if f then
  f:write(table.concat(report, "\n"))
  f:write("\n")
  f:close()
end
