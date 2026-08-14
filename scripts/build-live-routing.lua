-- build-live-routing.lua — builds/configures one REAPER track per Wing
-- channel (1-19), routed in from and back out to the Wing over SoundGrid.
--
-- ASSUMPTION (please spot-check after running): ASIO channel index (N-1,
-- 0-based) corresponds to the SoundGrid input/output the Wing calls
-- "Wing-1 Exp <N>" -- confirmed for N=3 (user set REAPER's VERN-capture
-- track to "wing-1exp3", and Wing MOD send/return slot 3 is what carries
-- channel 3/VERN's audio). The other 18 channels follow the same
-- MOD-slot-N = channel-N pattern (set on the Wing side via OSC this same
-- session), so this script assumes the same N-1 offset holds for all of
-- them. After running, check at least 2-3 tracks' Input/hardware-output
-- dropdowns in REAPER actually read "Wing-1 Exp <N>" for the right N --
-- if the offset is off by one, every track will be off by the same one
-- slot and easy to spot immediately.
--
-- Load via: Actions -> Show action list -> New action -> Load ReaScript,
-- then run it once. Safe to re-run: reuses an existing track that already
-- matches a channel by name (including your existing "Vocal Chain (B0)"
-- track, treated as channel 3/VERN and renamed) instead of duplicating,
-- and won't add a second hardware output send to the same destination
-- channel if one already exists.

local CHANNELS = {
  {n = 1,  name = "CARD MIC"},
  {n = 2,  name = "Main"},
  {n = 3,  name = "VERN"},
  {n = 4,  name = "RENITA"},
  {n = 5,  name = "SCOTT"},
  {n = 6,  name = "PADS PIANO"},
  {n = 7,  name = "KEYS"},
  {n = 8,  name = "BANJ0"},
  {n = 9,  name = "ACOUSTIC GUITAR"},
  {n = 10, name = "LEAD GUITAR"},
  {n = 11, name = "RHYTHM GUITAR"},
  {n = 12, name = "BASS"},
  {n = 13, name = "SNARE TOP"},
  {n = 14, name = "SNARE BOT"},
  {n = 15, name = "DRUM PAD"},
  {n = 16, name = "RACK"},
  {n = 17, name = "FLOOR"},
  {n = 18, name = "OH"},
  {n = 19, name = "KICK OUT"},
}

-- Find an existing track by exact name (case-insensitive), or nil.
local function findTrackByName(name)
  local target = name:lower()
  for i = 0, reaper.CountTracks(0) - 1 do
    local tr = reaper.GetTrack(0, i)
    local _, trName = reaper.GetSetMediaTrackInfo_String(tr, "P_NAME", "", false)
    if trName:lower() == target then return tr end
  end
  return nil
end

-- Ensure a hardware-output send to `channelIndex` exists on `track`;
-- returns without adding a duplicate if one's already there.
local function ensureHardwareSend(track, channelIndex)
  local numSends = reaper.GetTrackNumSends(track, 1) -- category 1 = hw output sends
  for i = 0, numSends - 1 do
    local dst = reaper.GetTrackSendInfo_Value(track, 1, i, "I_DSTCHAN")
    if dst == channelIndex then return end -- already routed there
  end
  local sendidx = reaper.CreateTrackSend(track, nil) -- nil dest = hardware output
  reaper.SetTrackSendInfo_Value(track, 1, sendidx, "I_DSTCHAN", channelIndex)
  reaper.SetTrackSendInfo_Value(track, 1, sendidx, "D_VOL", 1.0)
  reaper.SetTrackSendInfo_Value(track, 1, sendidx, "B_MUTE", 0)
end

reaper.Undo_BeginBlock()
reaper.ShowConsoleMsg("Building live routing for 19 Wing channels...\n\n")

-- Channel 3/VERN: reuse the existing "Vocal Chain (B0)" track if present,
-- so its already-built FX chain isn't duplicated onto a second track.
local vernExisting = findTrackByName("Vocal Chain (B0)")
if vernExisting then
  reaper.GetSetMediaTrackInfo_String(vernExisting, "P_NAME", "VERN", true)
end

for _, ch in ipairs(CHANNELS) do
  local track = findTrackByName(ch.name)
  if not track then
    local idx = reaper.CountTracks(0)
    reaper.InsertTrackAtIndex(idx, true)
    track = reaper.GetTrack(0, idx)
    reaper.GetSetMediaTrackInfo_String(track, "P_NAME", ch.name, true)
  end

  local channelIndex = ch.n - 1 -- ASSUMPTION: "Wing-1 Exp <n>" = 0-based index n-1
  reaper.SetMediaTrackInfo_Value(track, "I_RECINPUT", channelIndex)
  reaper.SetMediaTrackInfo_Value(track, "I_RECMON", 1) -- live-through monitoring
  reaper.SetMediaTrackInfo_Value(track, "I_RECARM", 1)
  reaper.SetMediaTrackInfo_Value(track, "B_MUTE", 0)
  ensureHardwareSend(track, channelIndex)

  reaper.ShowConsoleMsg(("ch%-2d %-16s  input <- Wing-1 Exp %-2d   output -> Wing-1 Exp %-2d\n")
    :format(ch.n, ch.name, ch.n, ch.n))
end

reaper.Undo_EndBlock("Build live routing for all 19 Wing channels", -1)
reaper.UpdateArrange()

reaper.ShowConsoleMsg("\nDone. SPOT-CHECK before trusting all 19:\n")
reaper.ShowConsoleMsg("  Open 2-3 tracks' Input dropdown (top-left of the track panel) and their\n")
reaper.ShowConsoleMsg("  hardware-output routing (the small Route button) -- confirm they read\n")
reaper.ShowConsoleMsg("  \"Wing-1 Exp <N>\" matching that track's channel number. If they're all\n")
reaper.ShowConsoleMsg("  off by the same one slot, tell me and I'll shift the offset by one.\n")
