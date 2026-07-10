@echo off
setlocal
title Wing Toolkit - Dump console state
cd /d "%~dp0.."
echo ============================================
echo  STEP 2: DUMP WING STATE  (read-only)
echo ============================================
echo.
echo Did you make the USB backup on the console first?
echo This step is read-only, but the backup comes FIRST regardless.
echo.

rem --- Wing IP: remembered in church-kit\wing-ip.txt after first entry ---
set "WINGIP="
if exist "%~dp0wing-ip.txt" set /p WINGIP=<"%~dp0wing-ip.txt"
if defined WINGIP (
  set /p WINGIP="Wing console IP [%WINGIP%]: "
) else (
  set /p WINGIP="Wing console IP (from the Wing's network setup screen): "
)
if not defined WINGIP (
  echo [X] No IP entered.
  pause
  exit /b 1
)
>"%~dp0wing-ip.txt" echo %WINGIP%

echo.
echo Reading the full console state from %WINGIP% ...
echo (unanswered addresses are normal on the first run - see README)
echo.
node scripts\dump-wing-state.mjs --host %WINGIP%
if errorlevel 1 (
  echo.
  echo [X] Dump failed - read the error above.
  pause
  exit /b 1
)

echo.
echo ============================================
echo  [OK] Dump written to data\wing-state\
echo.
echo  If the "answered" count above is near ZERO:
echo  stop here, bring that file home - the OSC
echo  addresses need fixing before anything else.
echo.
echo  If it answered plenty: next is 3-PLAN-REMAP.
echo ============================================
pause
