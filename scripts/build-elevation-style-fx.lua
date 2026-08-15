-- build-elevation-style-fx.lua — layers a modern "arena worship" (Elevation
-- Worship-style) ambience/character pass ON TOP of the existing gate/EQ/
-- comp chains (build-vocal-chains-remaining.lua, build-instrument-chains.lua)
-- -- does not remove or reorder anything already there, just appends.
--
-- Genre reasoning, not guessed per-channel:
--   Vocals: big hall/plate reverb + rhythmic delay + an "air"/polish stage
--     (Silk Vocal) is the signature modern-CCM vocal sound.
--   Pads/keys: lush reverb + subtle modulation (width/movement) is the
--     "atmospheric bed" every arena-worship mix is built on.
--   Lead guitar: ambient delay + big reverb + modulation is THE defining
--     texture of the genre's "shimmer" electric guitar sound; rhythm
--     guitar gets a lighter version (more rhythmic, less washed-out).
--   Toms/overheads: moderate room reverb for a glued, "big" kit sound.
--   Snare top: brighter/bigger reverb specifically -- the "big modern
--     snare" is one of the most recognizable elements of the style.
--   Deliberately EXCLUDED from the big/wet treatment, on purpose, not by
--   omission: CARD MIC (pastor's speech mic -- reverb reads as a mistake,
--   not a style), KICK OUT / BASS / SNARE BOT (a dry, tight low end is
--   PART of the style -- big verbs up top only read as "big" against a
--   clean foundation; reverb on kick/bass just makes the mix muddy).
--
-- All plugin names confirmed present in reaper-vstplugins64.ini before
-- writing this. No parameter values set -- same convention as the earlier
-- chain-building scripts; needs a human's ears once there's live signal.
-- Safe to re-run (TrackFX_AddByName instantiate>0 reuses existing instances).
-- Run via: reaper.exe -nonewinst <this file>

local ADDITIONS = {
  ["Main"]    = {"VST3: Silk Vocal Mono (Waves)", "VST3: H-Delay Mono (Waves)", "VST3: H-Reverb Mono (Waves)"},
  ["VERN"]    = {"VST3: Silk Vocal Mono (Waves)", "VST3: H-Delay Mono (Waves)", "VST3: H-Reverb Mono (Waves)"},
  ["RENITA"]  = {"VST3: Silk Vocal Mono (Waves)", "VST3: H-Delay Mono (Waves)", "VST3: H-Reverb Mono (Waves)"},
  ["SCOTT"]   = {"VST3: Silk Vocal Mono (Waves)", "VST3: H-Delay Mono (Waves)", "VST3: H-Reverb Mono (Waves)"},

  ["PADS PIANO"] = {"VST3: MetaFlanger Mono (Waves)", "VST3: H-Reverb Mono (Waves)"},
  ["KEYS"]       = {"VST3: MetaFlanger Mono (Waves)", "VST3: H-Reverb Mono (Waves)"},

  ["BANJ0"]           = {"VST3: H-Reverb Mono (Waves)"},
  ["ACOUSTIC GUITAR"] = {"VST3: H-Reverb Mono (Waves)"},
  ["LEAD GUITAR"]     = {"VST3: H-Delay Mono (Waves)", "VST3: H-Reverb Mono (Waves)", "VST3: MetaFlanger Mono (Waves)"},
  ["RHYTHM GUITAR"]   = {"VST3: H-Delay Mono (Waves)", "VST3: H-Reverb Mono (Waves)"},

  ["BASS"] = {"VST3: Kramer Tape Mono (Waves)"}, -- warmth only, no reverb/delay -- kept dry on purpose

  ["SNARE TOP"] = {"VST3: H-Reverb Mono (Waves)"}, -- the "big modern snare"
  ["RACK"]      = {"VST3: H-Reverb Mono (Waves)"},
  ["FLOOR"]     = {"VST3: H-Reverb Mono (Waves)"},
  ["DRUM PAD"]  = {"VST3: H-Reverb Mono (Waves)"},
  ["OH"]        = {"VST3: H-Reverb Mono (Waves)"},
  -- CARD MIC, KICK OUT, BASS(reverb/delay), SNARE BOT: intentionally no
  -- reverb/delay added -- see header comment.
}

local EXCLUDED_ON_PURPOSE = {
  ["CARD MIC"] = "speech mic -- reverb on a sermon reads as a mistake, not a style",
  ["KICK OUT"] = "dry/tight low end is part of the style, not an omission",
  ["SNARE BOT"] = "phase/reinforcement mic, not meant to carry ambience",
}

local CHAIN_ORDER = {
  "CARD MIC", "Main", "VERN", "RENITA", "SCOTT", "PADS PIANO", "KEYS",
  "BANJ0", "ACOUSTIC GUITAR", "LEAD GUITAR", "RHYTHM GUITAR", "BASS",
  "SNARE TOP", "SNARE BOT", "DRUM PAD", "RACK", "FLOOR", "OH", "KICK OUT"
}

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

for _, trackName in ipairs(CHAIN_ORDER) do
  local track = findTrackByName(trackName)
  if not track then
    log(trackName .. ": TRACK NOT FOUND")
  elseif EXCLUDED_ON_PURPOSE[trackName] then
    log(trackName .. ": intentionally left dry -- " .. EXCLUDED_ON_PURPOSE[trackName])
  else
    local additions = ADDITIONS[trackName]
    log(trackName .. ":")
    local ok = true
    for i, fxname in ipairs(additions) do
      local fxIndex = reaper.TrackFX_AddByName(track, fxname, false, 1)
      if fxIndex < 0 then
        log("  [MISSING] " .. fxname)
        ok = false
      else
        log("  [+] " .. fxname .. " (fx index " .. fxIndex .. ")")
      end
    end
    if ok then log("  -> style pass added OK") else log("  -> added WITH GAPS") end
  end
end

reaper.Undo_EndBlock("Add Elevation Worship-style ambience/character FX pass", -1)
reaper.UpdateArrange()

local f = io.open("C:\\Users\\Waves PC\\wing-toolkit\\scripts\\build-elevation-style-fx-report.txt", "w")
if f then
  f:write(table.concat(report, "\n"))
  f:write("\n")
  f:close()
end
