-- check-replacement-latency.lua — adds candidate replacement plugins to a
-- throwaway scratch track just long enough to read their real PDC, then
-- deletes the track. Doesn't touch any real channel track.
-- Run via: reaper.exe -nonewinst <this file>

local sampleRate = reaper.GetSetProjectInfo(0, "PROJECT_SRATE", 0, false)
if not sampleRate or sampleRate == 0 then sampleRate = 48000 end

local CANDIDATES = {
  "VST3: TrueVerb Mono (Waves)",
  "VST3: IR-L Mono (Waves)",
  "VST3: OneKnob Driver Mono (Waves)",
  "VST3: Vitamin Mono (Waves)",
}

local idx = reaper.CountTracks(0)
reaper.InsertTrackAtIndex(idx, true)
local scratch = reaper.GetTrack(0, idx)
reaper.GetSetMediaTrackInfo_String(scratch, "P_NAME", "LATENCY_SCRATCH", true)

local report = {}
for _, fxname in ipairs(CANDIDATES) do
  local fxIndex = reaper.TrackFX_AddByName(scratch, fxname, false, 1)
  if fxIndex < 0 then
    report[#report + 1] = fxname .. ": NOT FOUND / failed to load"
  else
    local ok, pdcStr = reaper.TrackFX_GetNamedConfigParm(scratch, fxIndex, "pdc")
    local samples = tonumber(pdcStr)
    if ok and samples then
      local ms = (samples / sampleRate) * 1000
      report[#report + 1] = string.format("%-40s %8d samples  %7.2f ms", fxname, samples, ms)
    else
      report[#report + 1] = fxname .. ": pdc not reported"
    end
  end
end

reaper.DeleteTrack(scratch)
reaper.UpdateArrange()

local f = io.open("C:\\Users\\Waves PC\\wing-toolkit\\scripts\\replacement-latency-report.txt", "w")
if f then
  f:write("Sample rate: " .. tostring(sampleRate) .. " Hz\n\n")
  f:write(table.concat(report, "\n"))
  f:write("\n")
  f:close()
end
