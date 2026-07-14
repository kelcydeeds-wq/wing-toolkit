@echo off
setlocal
title Wing Toolkit - List audio devices
cd /d "%~dp0.."
echo ============================================
echo  STEP 1b: LIST AUDIO DEVICES  (read-only, optional)
echo ============================================
echo.
echo Lists every audio input/output Windows can see on this PC -- use it
echo to find the Wing's USB audio interface (or the SoundGrid card once
echo installed) so its exact name can go into config\default.json.
echo.
echo Nothing is written anywhere. Safe to run any time.
echo.

node scripts\list-audio-devices.mjs
if errorlevel 1 (
  echo.
  echo [X] Failed - read the error above.
  pause
  exit /b 1
)

echo.
echo ============================================
echo  Found the Wing's device above? Put its exact name in
echo  config\default.json under audio.inputDevice / audio.outputDevice.
echo  Confirm with a short manual recording test before trusting it.
echo ============================================
pause
