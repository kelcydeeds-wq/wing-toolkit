@echo off
setlocal
title Wing Toolkit - OSC recorder (Ctrl+C to stop)
cd /d "%~dp0.."
echo ============================================
echo  STEP 7: RECORD REHEARSAL OSC TRAFFIC
echo ============================================
echo.

set "WINGIP="
if exist "%~dp0wing-ip.txt" set /p WINGIP=<"%~dp0wing-ip.txt"
if not defined WINGIP (
  echo [X] No saved Wing IP - run 2-DUMP-WING-STATE first.
  pause
  exit /b 1
)

echo Recording all OSC traffic from %WINGIP% to data\osc-recordings\
echo Start this before rehearsal; press Ctrl+C when done (~1 hour is plenty).
echo Read-only - the console is never written to.
echo.
node scripts\record-osc.mjs --host %WINGIP%
echo.
echo Recording stopped.
pause
