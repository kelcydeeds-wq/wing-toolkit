-- save-project.lua — save the current REAPER project to a real file so it
-- survives REAPER closing/crashing. Two sessions' worth of track/FX work
-- was lost between 2026-08-12 and 2026-08-14 because the project was never
-- saved to disk -- this exists to stop that happening a third time.
-- Run via: reaper.exe -nonewinst <this file>

local projectPath = "C:\\Users\\Waves PC\\wing-toolkit\\wing-brain\\data\\wing-live-session.rpp"
reaper.Main_SaveProjectEx(0, projectPath, 0)

local f = io.open("C:\\Users\\Waves PC\\wing-toolkit\\scripts\\save-project-report.txt", "w")
if f then
  local _, actualPath = reaper.EnumProjects(-1)
  f:write("Requested save to: " .. projectPath .. "\n")
  f:write("Project now reports path: " .. (actualPath ~= "" and actualPath or "(still unsaved!)") .. "\n")
  f:close()
end
