-- check-fx-latency.lua — reports every FX loaded across every track, with
-- its actual reported processing latency (PDC, in samples and ms) as this
-- machine's plugin builds actually report it -- ground truth, not a claim
-- from documentation. Run via: reaper.exe -nonewinst <this file>

local sampleRate = reaper.GetSetProjectInfo(0, "PROJECT_SRATE", 0, false)
if not sampleRate or sampleRate == 0 then sampleRate = 48000 end

local report = {}
local function log(line) report[#report + 1] = line end

local seen = {} -- dedupe identical plugin names across tracks -- only need each plugin's latency once

for i = 0, reaper.CountTracks(0) - 1 do
  local tr = reaper.GetTrack(0, i)
  local _, trName = reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", "", false)
  local fxCount = reaper.TrackFX_GetCount(tr)
  for fx = 0, fxCount - 1 do
    local _, fxName = reaper.TrackFX_GetFXName(tr, fx, "")
    if not seen[fxName] then
      seen[fxName] = true
      local ok, pdcStr = reaper.TrackFX_GetNamedConfigParm(tr, fx, "pdc")
      local samples = tonumber(pdcStr)
      if ok and samples then
        local ms = (samples / sampleRate) * 1000
        log(string.format("%-45s %8d samples  %7.2f ms", fxName, samples, ms))
      else
        log(string.format("%-45s (pdc not reported / query failed)", fxName))
      end
    end
  end
end

table.sort(report)

local f = io.open("C:\\Users\\Waves PC\\wing-toolkit\\scripts\\fx-latency-report.txt", "w")
if f then
  f:write("Sample rate: " .. tostring(sampleRate) .. " Hz\n\n")
  f:write(table.concat(report, "\n"))
  f:write("\n")
  f:close()
end
