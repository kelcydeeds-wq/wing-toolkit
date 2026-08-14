-- list-tracks.lua — one-off diagnostic: report every track name + FX count
-- in the current REAPER project, plus the project's own file path (if
-- saved), to a plain text file. Run via: reaper.exe -nonewinst <this file>

local report = {}
local function log(line) report[#report + 1] = line end

local _, projPath = reaper.EnumProjects(-1)
log("Project: " .. (projPath ~= "" and projPath or "(unsaved, no file)"))
log("Track count: " .. reaper.CountTracks(0))
log("")

for i = 0, reaper.CountTracks(0) - 1 do
  local tr = reaper.GetTrack(0, i)
  local _, trName = reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", "", false)
  local fxCount = reaper.TrackFX_GetCount(tr)
  local recInput = reaper.GetMediaTrackInfo_Value(tr, "I_RECINPUT")
  log(string.format("[%d] \"%s\" -- %d FX, I_RECINPUT=%d", i, trName, fxCount, recInput))
end

local f = io.open("C:\\Users\\Waves PC\\wing-toolkit\\scripts\\list-tracks-report.txt", "w")
if f then
  f:write(table.concat(report, "\n"))
  f:write("\n")
  f:close()
end
