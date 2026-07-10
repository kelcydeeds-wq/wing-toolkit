@echo off
setlocal enabledelayedexpansion
title Wing Toolkit - Plan the channel remap
cd /d "%~dp0.."
echo ============================================
echo  STEP 3: PLAN THE REMAP  (read-only)
echo ============================================
echo.
echo Building the remap plan from the most recent dump...
echo.
node scripts\plan-remap.mjs
if errorlevel 1 (
  echo.
  echo [X] Planning failed - did step 2 produce a dump? Read the error above.
  pause
  exit /b 1
)

rem --- open the newest plan table in Notepad for review ---
set "NEWESTMD="
for /f "delims=" %%F in ('dir /b /a-d /o-d "data\remap-plans\*.remap.md" 2^>nul') do if not defined NEWESTMD set "NEWESTMD=%%F"
if defined NEWESTMD (
  echo Opening the plan in Notepad: data\remap-plans\!NEWESTMD!
  start notepad "data\remap-plans\!NEWESTMD!"
)

echo.
echo ============================================
echo  READ THE PLAN THAT JUST OPENED. Every row
echo  under "Moves" is a channel that will change
echo  number. Check names landed in the right
echo  category, check the Downstream refs column,
echo  read every Warning.
echo.
echo  Wrong move? Hand-edit the matching
echo  .remap.json in data\remap-plans\ (Notepad is
echo  fine) - step 4/5 read whatever is in it.
echo.
echo  When the plan reads right: 4-APPLY-REMAP-DRYRUN.
echo ============================================
pause
