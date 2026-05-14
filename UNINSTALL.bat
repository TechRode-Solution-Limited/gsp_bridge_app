@echo off
echo Uninstalling GymSync ZKTeco Middleware...
echo.
powershell -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
echo.
pause
