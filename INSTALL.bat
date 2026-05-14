@echo off
echo ============================================
echo   GymSync ZKTeco Middleware - Installer
echo ============================================
echo.
echo This will install the GymSync ZKTeco middleware
echo as a Windows service on this PC.
echo.
echo Press any key to continue or close this window to cancel...
pause >nul
powershell -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
