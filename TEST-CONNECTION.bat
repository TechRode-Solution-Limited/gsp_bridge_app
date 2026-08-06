@echo off
echo ============================================
echo   GymSync ZKTeco Middleware - Connection Test
echo ============================================
echo.
echo Reads config.json and tests every configured device:
echo   1. TCP reachability
echo   2. ZKTeco SDK connect (comm password)
echo   3. Bridge HTTP API
echo.
powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0test-connection.ps1" %*
echo.
pause
