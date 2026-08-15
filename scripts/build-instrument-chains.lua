-- build-instrument-chains.lua — loads a category-appropriate FX chain onto
-- every non-vocal REAPER track (vocals already have PSE -> Tune Real-Time
-- -> RCompressor -> F6 from build-vocal-chains-remaining.lua). All plugin
-- names below are confirmed present in this machine's
-- reaper-vstplugins64.ini (2026-08-14) -- checked before writing this, not
-- guessed. No specific knob/parameter values are set (same convention as
-- build-vocal-chain.lua) -- these are starting-point CHAINS (which
-- processors, in what order), left for the user to dial in by ear, since
-- there's no live signal to tune against from a script anyway.
--
-- Category reasoning (live-sound standard practice, not guessed per-channel):
--   Speech mic (no pitch/music content): gate -> comp -> de-ess.
--   DI/line instruments (no acoustic bleed to gate): EQ -> comp.
--   Mic'd/plucked instruments with stage bleed: gate -> EQ -> comp.
--   Bass: comp -> low-end enhancer -> EQ (dynamics first matters more here).
--   Close-mic'd drums (isolation matters): gate -> EQ -> comp.
--   Overheads/room mics: NO gate (would chop cymbal decay) -- EQ -> comp only.
--
-- Safe to re-run: TrackFX_AddByName with instantiate>0 reuses an existing
-- instance rather than duplicating.
-- Run via: reaper.exe -nonewinst <this file>

local CHAINS = {
  ["CARD MIC"] = {
    category = "Speech mic",
    fx = {"VST3: PSE Mono (Waves)", "VST3: RCompressor Mono (Waves)", "VST3: RDeEsser Mono (Waves)"}
  },
  ["PADS PIANO"] = {
    category = "DI/line",
    fx = {"VST3: REQ 6 Mono (Waves)", "VST3: RCompressor Mono (Waves)"}
  },
  ["KEYS"] = {
    category = "DI/line",
    fx = {"VST3: REQ 6 Mono (Waves)", "VST3: RCompressor Mono (Waves)"}
  },
  ["DRUM PAD"] = {
    category = "DI/line",
    fx = {"VST3: REQ 6 Mono (Waves)", "VST3: RCompressor Mono (Waves)"}
  },
  ["BANJ0"] = {
    category = "Mic'd/plucked, gated",
    fx = {"VST3: PSE Mono (Waves)", "VST3: REQ 6 Mono (Waves)", "VST3: RCompressor Mono (Waves)"}
  },
  ["ACOUSTIC GUITAR"] = {
    category = "Mic'd/plucked, gated",
    fx = {"VST3: PSE Mono (Waves)", "VST3: REQ 6 Mono (Waves)", "VST3: RCompressor Mono (Waves)"}
  },
  ["LEAD GUITAR"] = {
    category = "Mic'd/plucked, gated",
    fx = {"VST3: PSE Mono (Waves)", "VST3: REQ 6 Mono (Waves)", "VST3: RCompressor Mono (Waves)"}
  },
  ["RHYTHM GUITAR"] = {
    category = "Mic'd/plucked, gated",
    fx = {"VST3: PSE Mono (Waves)", "VST3: REQ 6 Mono (Waves)", "VST3: RCompressor Mono (Waves)"}
  },
  ["BASS"] = {
    category = "Bass",
    fx = {"VST3: RCompressor Mono (Waves)", "VST3: RBass Mono (Waves)", "VST3: REQ 6 Mono (Waves)"}
  },
  ["SNARE TOP"] = {
    category = "Close-mic'd drum, gated",
    fx = {"VST3: PSE Mono (Waves)", "VST3: REQ 6 Mono (Waves)", "VST3: RCompressor Mono (Waves)"}
  },
  ["SNARE BOT"] = {
    category = "Close-mic'd drum, gated",
    fx = {"VST3: PSE Mono (Waves)", "VST3: REQ 6 Mono (Waves)", "VST3: RCompressor Mono (Waves)"}
  },
  ["RACK"] = {
    category = "Close-mic'd drum, gated",
    fx = {"VST3: PSE Mono (Waves)", "VST3: REQ 6 Mono (Waves)", "VST3: RCompressor Mono (Waves)"}
  },
  ["FLOOR"] = {
    category = "Close-mic'd drum, gated",
    fx = {"VST3: PSE Mono (Waves)", "VST3: REQ 6 Mono (Waves)", "VST3: RCompressor Mono (Waves)"}
  },
  ["KICK OUT"] = {
    category = "Close-mic'd drum, gated",
    fx = {"VST3: PSE Mono (Waves)", "VST3: REQ 6 Mono (Waves)", "VST3: RCompressor Mono (Waves)"}
  },
  ["OH"] = {
    category = "Overhead (ungated -- preserves cymbal decay)",
    fx = {"VST3: REQ 6 Mono (Waves)", "VST3: RCompressor Mono (Waves)"}
  },
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

-- Deterministic order: iterate CHAIN_ORDER, not Lua's unordered table keys,
-- so the report always reads the same way run to run.
local CHAIN_ORDER = {
  "CARD MIC", "PADS PIANO", "KEYS", "BANJ0", "ACOUSTIC GUITAR", "LEAD GUITAR",
  "RHYTHM GUITAR", "BASS", "SNARE TOP", "SNARE BOT", "DRUM PAD", "RACK",
  "FLOOR", "OH", "KICK OUT"
}

for _, trackName in ipairs(CHAIN_ORDER) do
  local spec = CHAINS[trackName]
  local track = findTrackByName(trackName)
  if not track then
    log(trackName .. ": TRACK NOT FOUND")
  else
    log(trackName .. " (" .. spec.category .. "):")
    local ok = true
    for i, fxname in ipairs(spec.fx) do
      local fxIndex = reaper.TrackFX_AddByName(track, fxname, false, 1)
      if fxIndex < 0 then
        log("  [MISSING] " .. fxname)
        ok = false
      else
        log("  [" .. i .. "] " .. fxname .. " (fx index " .. fxIndex .. ")")
      end
    end
    if ok then log("  -> all FX loaded OK") else log("  -> loaded WITH GAPS") end
  end
end

reaper.Undo_EndBlock("Build category FX chains on all instrument tracks", -1)
reaper.UpdateArrange()

local f = io.open("C:\\Users\\Waves PC\\wing-toolkit\\scripts\\build-instrument-chains-report.txt", "w")
if f then
  f:write(table.concat(report, "\n"))
  f:write("\n")
  f:close()
end
