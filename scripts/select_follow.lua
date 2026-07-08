-- select_follow.lua — Bench Test B0.4: console-follow for the touchscreen.
-- Watches for track selection changes in REAPER and floats that track's FX
-- chain window, closing the previous one. Pure REAPER — works with the brain
-- box unplugged (skeptic-approved).
--
-- How selection gets driven from the Wing:
--   Path A (B0.4 today): map Wing SELECT MIDI to REAPER's built-in
--     "Track: select track N" actions via Actions → MIDI learn.
--   Path B (later): brain box sees SELECT over Wing OSC and sends
--     /track/N/select to REAPER — same script, no changes.
--
-- Load via Actions → Load ReaScript, then set it to run at startup:
--   Extensions not required — add to the project's startup action, or just
--   run it once per session; it keeps itself alive with reaper.defer.

local lastTrack = nil

local function tick()
  local tr = reaper.GetSelectedTrack(0, 0)
  if tr ~= lastTrack and tr ~= nil then
    -- Close previous chain window
    if lastTrack and reaper.ValidatePtr(lastTrack, "MediaTrack*") then
      reaper.TrackFX_Show(lastTrack, 0, 0) -- hide chain
    end
    -- Show new chain window (index 0, showFlag 1 = show chain)
    reaper.TrackFX_Show(tr, 0, 1)
    lastTrack = tr
  end
  reaper.defer(tick)
end

tick()
