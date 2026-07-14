@echo off
setlocal
title Wing Toolkit - Identify outputs
cd /d "%~dp0.."
echo ============================================
echo  STEP 2b: IDENTIFY OUTPUTS  (read-only, optional)
echo ============================================
echo.
echo Quickly prints the name + mute state of every main and matrix number
echo on the console, so you can match config\default.json's outputs[].wing.num
echo "TODO: confirm at audit" markers against what the console actually
echo calls them. Faster than reading through the full state dump for this.
echo.
echo READ-ONLY - touches nothing.
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
node scripts\identify-outputs.mjs --host %WINGIP%
if errorlevel 1 (
  echo.
  echo [X] Failed - read the error above.
  pause
  exit /b 1
)

echo.
echo ============================================
echo  Update config\default.json's outputs[].wing.num to match, then
echo  remove the "TODO: confirm at audit" note on each one you confirmed.
echo ============================================
pause
