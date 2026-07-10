@echo off
title Wing Toolkit - Mock self-test
cd /d "%~dp0.."
echo ============================================
echo  STEP 1: SELF-TEST AGAINST THE MOCK CONSOLE
echo  (run this at home BEFORE the church visit)
echo ============================================
echo.
echo No hardware is touched - this exercises the whole
echo dump -^> plan -^> apply chain against a simulated Wing.
echo.

set "SELFTEST=%TEMP%\wing-church-selftest"
if not exist "%SELFTEST%" mkdir "%SELFTEST%"

echo --- 1/3 dump-wing-state (mock) ---
node scripts\dump-wing-state.mjs --mock --out "%SELFTEST%\dump.json"
if errorlevel 1 goto :fail

echo.
echo --- 2/3 plan-remap ---
node scripts\plan-remap.mjs --dump "%SELFTEST%\dump.json" --out-json "%SELFTEST%\remap.json" --out-md "%SELFTEST%\remap.md"
if errorlevel 1 goto :fail

echo.
echo --- 3/3 apply-remap dry run (mock) ---
node scripts\apply-remap.mjs --remap "%SELFTEST%\remap.json" --mock
if errorlevel 1 goto :fail

echo.
echo ============================================
echo  [OK] Self-test passed. The software side is
echo       healthy - you're ready for the church.
echo ============================================
pause
exit /b 0

:fail
echo.
echo [X] Self-test FAILED at the step above. Fix before the church visit.
pause
exit /b 1
