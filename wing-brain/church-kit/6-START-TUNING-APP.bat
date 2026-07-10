@echo off
title Wing Toolkit - Tuning app (leave this window open)
cd /d "%~dp0.."
echo ============================================
echo  STEP 6: START THE TUNING APP
echo ============================================
echo.
echo Open the "Phone:" address printed below on your phone
echo (same WiFi as this PC).
echo.
echo In the app, tap the gear (top right) to:
echo   - switch Mock / Live mode
echo   - set the Wing IP + Test connection
echo Run a PRE-FLIGHT CHECK before any Full Tune.
echo.
echo A LIVE full tune also needs the measurement mic + audio
echo interface on THIS PC. Without them, stay in mock mode.
echo.
echo Leave this window open while using the app.
echo Close it (or press Ctrl+C) to stop the server.
echo ============================================
echo.
call npm start
pause
