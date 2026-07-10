@echo off
setlocal enabledelayedexpansion
title Wing Toolkit - Remap DRY RUN
cd /d "%~dp0.."
echo ============================================
echo  STEP 4: APPLY-REMAP DRY RUN  (read-only)
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

echo Using plan:  data\remap-plans\!NEWESTJSON!
echo Console at:  %WINGIP%
echo.
echo Nothing will be written - this only READS each source
echo channel and shows what WOULD happen.
echo.
node scripts\apply-remap.mjs --remap "data\remap-plans\!NEWESTJSON!" --host %WINGIP%
if errorlevel 1 (
  echo.
  echo [X] Dry run reported a problem - read the output above.
  pause
  exit /b 1
)

echo.
echo ============================================
echo  CHECK: did each move read a sensible number
echo  of source parameters? "read 0/91" on every
echo  channel means the addresses are wrong -
echo  STOP and do not run step 5.
echo.
echo  Looks right + USB backup exists:
echo  5-APPLY-REMAP-EXECUTE is next.
echo ============================================
pause
