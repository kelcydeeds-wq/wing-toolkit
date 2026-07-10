@echo off
setlocal enabledelayedexpansion
title Wing Toolkit - Remap EXECUTE (writes to console!)
cd /d "%~dp0.."
echo ============================================
echo  STEP 5: EXECUTE THE REMAP
echo  *** THIS WRITES TO THE CONSOLE ***
echo ============================================
echo.

set "WINGIP="
if exist "%~dp0wing-ip.txt" set /p WINGIP=<"%~dp0wing-ip.txt"
if not defined WINGIP (
  echo [X] No saved Wing IP - run 2-DUMP-WING-STATE first.
  pause
  exit /b 1
)

set "NEWESTJSON="
for /f "delims=" %%F in ('dir /b /a-d /o-d "data\remap-plans\*.remap.json" 2^>nul') do if not defined NEWESTJSON set "NEWESTJSON=%%F"
if not defined NEWESTJSON (
  echo [X] No remap plan found - run 3-PLAN-REMAP first.
  pause
  exit /b 1
)

echo Plan:     data\remap-plans\!NEWESTJSON!
echo Console:  %WINGIP%
echo.
echo Before typing YES, confirm ALL of these:
echo   [ ] USB scene/show backup exists and was reload-tested
echo   [ ] Step 3's plan table was read and looks right
echo   [ ] Step 4's dry run read real parameters (not 0/91)
echo.
echo Each channel is verified after writing; the first mismatch
echo ABORTS the rest (already-moved channels stay moved).
echo Rollback = reload the USB backup on the console.
echo.
set /p CONFIRM="Type YES (all caps) to write to the console: "
if not "%CONFIRM%"=="YES" (
  echo.
  echo Cancelled - nothing was written.
  pause
  exit /b 0
)

echo.
node scripts\apply-remap.mjs --remap "data\remap-plans\!NEWESTJSON!" --host %WINGIP% --execute
if errorlevel 1 (
  echo.
  echo [X] EXECUTION STOPPED EARLY - read the output above carefully.
  echo     Moves that printed "verified OK" ARE live on the console.
  echo     Full rollback: reload the USB backup.
  pause
  exit /b 1
)

echo.
echo ============================================
echo  [OK] Remap complete and verified.
echo  NOW: walk the console, confirm audio passes
echo  on the new channel numbers, then SAVE the
echo  new scene as baseline + fresh USB backup.
echo  After that: 6-START-TUNING-APP.
echo ============================================
pause
