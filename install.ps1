#Requires -RunAsAdministrator
# GymSync ZKTeco Middleware - One-click installer
# Run this script as Administrator on the client PC.

param(
    [string]$InstallDir = "C:\GymSync",
    [int]$Port = 5000,
    [string]$ServiceName = "GymSyncZkt",
    # Firewall scope for the inbound rule. Default "LocalSubnet" keeps the control
    # plane off the wider network / any bridged guest WiFi; pass the reception PC's
    # IP (or a comma-separated list) to lock it down further, or "Any" to allow all.
    [string]$AllowedSource = "LocalSubnet",
    # API key written into a freshly-generated config.json so LAN callers must send
    # X-Api-Key. Leave blank to auto-generate one (printed at the end). Loopback
    # callers (the local test UI) are always exempt. Ignored if config.json exists.
    [string]$ApiKey = ""
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  GymSync ZKTeco Middleware Installer"
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Install directory : $InstallDir"
Write-Host "Service name      : $ServiceName"
Write-Host "Port              : $Port"
Write-Host ""

# --- Step 1: Stop existing service if running ---
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "[1/7] Stopping existing service..." -ForegroundColor Yellow
    if ($existing.Status -eq "Running") {
        sc.exe stop $ServiceName | Out-Null
        Start-Sleep -Seconds 3
    }
    Write-Host "      Removing old service..."
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
} else {
    Write-Host "[1/7] No existing service found" -ForegroundColor Green
}

# --- Step 2: Create directory structure ---
Write-Host "[2/7] Creating directory structure..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
New-Item -ItemType Directory -Force -Path "$InstallDir\logs" | Out-Null
New-Item -ItemType Directory -Force -Path "$InstallDir\storage\templates" | Out-Null

# --- Step 3: Copy application files ---
Write-Host "[3/7] Copying application files..." -ForegroundColor Yellow
$appSource = Join-Path $scriptDir "app"
if (-not (Test-Path "$appSource\GymSync.Zkt.WebUI.exe")) {
    Write-Host "ERROR: app\ folder not found next to this script." -ForegroundColor Red
    Write-Host "Expected: $appSource\GymSync.Zkt.WebUI.exe"
    exit 1
}
Copy-Item -Path "$appSource\*" -Destination $InstallDir -Recurse -Force

# Leave the connection tester on the box so it can be run later without the
# installer bundle (it reads $InstallDir\config.json by default).
$testerSource = Join-Path $scriptDir "test-connection.ps1"
if (Test-Path $testerSource) {
    Copy-Item $testerSource "$InstallDir\test-connection.ps1" -Force
    @"
@echo off
powershell -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0test-connection.ps1" %*
echo.
pause
"@ | Set-Content "$InstallDir\TEST-CONNECTION.bat" -Encoding ASCII
    Write-Host "      Connection tester installed: $InstallDir\TEST-CONNECTION.bat"
}

# --- Step 4: Copy SDK and register COM DLL ---
Write-Host "[4/7] Registering ZKTeco COM SDK..." -ForegroundColor Yellow
$sdkSource = Join-Path $scriptDir "sdk"
if (Test-Path $sdkSource) {
    New-Item -ItemType Directory -Force -Path "$InstallDir\sdk" | Out-Null
    Copy-Item -Path "$sdkSource\*" -Destination "$InstallDir\sdk" -Recurse -Force
}

$comDll = "$InstallDir\sdk\x64\zkemkeeper.dll"
if (Test-Path $comDll) {
    & regsvr32 /s $comDll
    $check = [Type]::GetTypeFromProgID('zkemkeeper.ZKEM')
    if ($check) {
        Write-Host "      COM DLL registered successfully" -ForegroundColor Green
    } else {
        # Try x86 fallback
        $comDll86 = "$InstallDir\sdk\x86\zkemkeeper.dll"
        if (Test-Path $comDll86) {
            & "$env:SystemRoot\SysWOW64\regsvr32.exe" /s $comDll86
        }
        Write-Host "      COM DLL registered (x86 fallback)" -ForegroundColor Yellow
    }
} else {
    Write-Host "      WARNING: zkemkeeper.dll not found in sdk\x64\" -ForegroundColor Red
}

# --- Step 5: Create config.json if not exists ---
Write-Host "[5/7] Setting up configuration..." -ForegroundColor Yellow
$configPath = "$InstallDir\config.json"
$generatedApiKey = ""
if (-not (Test-Path $configPath)) {
    $configSource = Join-Path $scriptDir "config.json"
    if (Test-Path $configSource) {
        Copy-Item $configSource $configPath
        Write-Host "      config.json copied from installer bundle"
    } else {
        # Generate (or accept) an API key so the LAN-exposed control plane isn't open.
        $generatedApiKey = if ([string]::IsNullOrWhiteSpace($ApiKey)) { [guid]::NewGuid().ToString('N') } else { $ApiKey }
        # Generate default config
        @"
{
  "device": {
    "ip": "192.168.1.201",
    "port": 4370,
    "password": 0,
    "timeout": 10,
    "machineNumber": 1
  },
  "devices": [],
  "storage": {
    "path": "$($InstallDir -replace '\\', '\\')\\storage\\templates"
  },
  "web": {
    "host": "0.0.0.0",
    "port": $Port
  },
  "security": {
    "apiKey": "$generatedApiKey"
  }
}
"@ | Set-Content $configPath -Encoding UTF8
        Write-Host "      Default config.json created - UPDATE DEVICE IPs!" -ForegroundColor Yellow
        Write-Host "      API key generated - reception must send it as X-Api-Key" -ForegroundColor Yellow
    }
} else {
    Write-Host "      config.json already exists, keeping it" -ForegroundColor Green
}

# --- Step 6: Install Windows service ---
Write-Host "[6/7] Installing Windows service..." -ForegroundColor Yellow
$exePath = "$InstallDir\GymSync.Zkt.WebUI.exe"

sc.exe create $ServiceName `
    binPath= "`"$exePath`" --contentRoot `"$InstallDir`"" `
    start= auto `
    DisplayName= "GymSync ZKTeco Middleware" | Out-Null

sc.exe description $ServiceName "ZKTeco device middleware for GymSync - manages biometric templates and attendance" | Out-Null
sc.exe failure $ServiceName reset= 86400 actions= restart/10000/restart/10000/restart/10000 | Out-Null

Write-Host "      Service installed: $ServiceName" -ForegroundColor Green

# --- Step 7: Firewall rule + Start service ---
Write-Host "[7/7] Configuring firewall and starting service..." -ForegroundColor Yellow

$fwRule = Get-NetFirewallRule -DisplayName "GymSync ZKTeco Middleware" -ErrorAction SilentlyContinue
if (-not $fwRule) {
    # Scope the inbound rule to the Private profile and a trusted source (LocalSubnet
    # by default) rather than opening the port to every profile/address. The control
    # plane is high-impact (door unlock, member/biometric wipe), so don't publish it
    # to bridged guest WiFi or any untrusted network the host might later join.
    $fwParams = @{
        DisplayName = "GymSync ZKTeco Middleware"
        Direction   = "Inbound"
        Protocol    = "TCP"
        LocalPort   = $Port
        Action      = "Allow"
        Profile     = "Private"
    }
    if ($AllowedSource -and $AllowedSource -ne "Any") {
        $fwParams.RemoteAddress = ($AllowedSource -split ',' | ForEach-Object { $_.Trim() })
    }
    New-NetFirewallRule @fwParams | Out-Null
    Write-Host "      Firewall rule created for port $Port (profile=Private, source=$AllowedSource)" -ForegroundColor Green
} else {
    Write-Host "      Firewall rule already exists" -ForegroundColor Green
}

sc.exe start $ServiceName | Out-Null
Start-Sleep -Seconds 3

$svc = Get-Service -Name $ServiceName
if ($svc.Status -eq "Running") {
    Write-Host ""
    Write-Host "========================================" -ForegroundColor Green
    Write-Host "  Installation complete!" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "  Service   : $ServiceName (Running)"
    Write-Host "  URL       : http://localhost:$Port"

    $lanIp = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.InterfaceAlias -notmatch 'Loopback' -and $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.*' } |
        Select-Object -First 1).IPAddress
    if ($lanIp) {
        Write-Host "  LAN URL   : http://${lanIp}:$Port"
    }
    Write-Host "  Config    : $configPath"
    Write-Host "  Logs      : $InstallDir\logs\"
    if ($generatedApiKey) {
        Write-Host ""
        Write-Host "  API KEY   : $generatedApiKey" -ForegroundColor Cyan
        Write-Host "  Configure reception to send it as the 'X-Api-Key' header." -ForegroundColor Yellow
        Write-Host "  (Local/loopback calls and the test UI on this PC don't need it.)"
    }
    Write-Host ""
    Write-Host "  NEXT: Edit config.json with your device IPs, then restart:" -ForegroundColor Yellow
    Write-Host "    sc.exe stop $ServiceName; sc.exe start $ServiceName"
    Write-Host ""
    Write-Host "  Then verify every configured device:" -ForegroundColor Yellow
    Write-Host "    $InstallDir\TEST-CONNECTION.bat"
    Write-Host ""
} else {
    Write-Host ""
    Write-Host "  WARNING: Service installed but not running." -ForegroundColor Red
    Write-Host "  Check: sc.exe query $ServiceName"
    Write-Host "  Logs:  $InstallDir\logs\"
    Write-Host ""
}
