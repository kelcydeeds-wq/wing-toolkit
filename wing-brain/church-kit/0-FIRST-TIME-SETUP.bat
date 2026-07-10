@echo off
title Wing Toolkit - First-time setup
cd /d "%~dp0.."
echo ============================================
echo  STEP 0: FIRST-TIME SETUP (once per PC)
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [X] Node.js is not installed on this PC.
  echo.
  echo     Install the LTS version from https://nodejs.org
  echo     ^(accept all defaults^), then run this again.
  echo.
  pause
  exit /b 1
)
for /f "delims=" %%V in ('node --version') do echo [OK] Node.js %%V found.

echo.
echo Installing dependencies (this can take a minute)...
call npm install
if errorlevel 1 (
  echo.
  echo [X] npm install failed - is this PC online? Read the error above.
  pause
  exit /b 1
)

echo.
echo Running the test suite...
call npm test
if errorlevel 1 (
  echo.
  echo [X] Tests failed - read the output above before continuing.
  pause
  exit /b 1
)

echo.
echo ============================================
echo  [OK] Setup complete. Next: 1-SELFTEST-MOCK
echo       (or go straight to 2 at the church)
echo ============================================
pause
