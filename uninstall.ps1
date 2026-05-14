#Requires -RunAsAdministrator
# GymSync ZKTeco Middleware — Uninstaller

param(
    [string]$InstallDir = "C:\GymSync",
    [string]$ServiceName = "GymSyncZkt"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "GymSync ZKTeco Middleware — Uninstaller" -ForegroundColor Cyan
Write-Host ""

# Stop and remove service
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq "Running") {
        Write-Host "Stopping service..." -ForegroundColor Yellow
        sc.exe stop $ServiceName | Out-Null
        Start-Sleep -Seconds 3
    }
    Write-Host "Removing service..." -ForegroundColor Yellow
    sc.exe delete $ServiceName | Out-Null
    Write-Host "Service removed" -ForegroundColor Green
} else {
    Write-Host "Service not found, skipping" -ForegroundColor Yellow
}

# Remove firewall rule
$fw = Get-NetFirewallRule -DisplayName "GymSync ZKTeco Middleware" -ErrorAction SilentlyContinue
if ($fw) {
    Remove-NetFirewallRule -DisplayName "GymSync ZKTeco Middleware"
    Write-Host "Firewall rule removed" -ForegroundColor Green
}

Write-Host ""
Write-Host "Service uninstalled." -ForegroundColor Green
Write-Host ""
Write-Host "Application files are still at: $InstallDir" -ForegroundColor Yellow
Write-Host "To remove everything: Remove-Item -Recurse -Force '$InstallDir'"
Write-Host ""
