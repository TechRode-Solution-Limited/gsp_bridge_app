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
    # API key for a fresh config.json (or for a rotation, below) so LAN callers must
    # send X-Api-Key. Leave blank to auto-generate a random one. Loopback callers
    # (the local test UI) are always exempt.
    [string]$ApiKey = "",
    # Monitoring-page password for a fresh config.json (or a rotation). Leave blank
    # to auto-generate one. There is no default any more — without one the page is off.
    [string]$MonitorPassword = "",
    # After a rotation the old API key stays valid this many days (as a
    # security.additionalApiKeys grace key) so reception keeps working until its
    # ZKTECO_BRIDGE key is updated.
    [int]$GraceDays = 7
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ---------------------------------------------------------------------------
# Secrets. Up to 1.0 every branch got the SAME API key and monitor password
# (committed in config.example.json). Only the SHA-256 of that key is kept here;
# an install that still uses it — or the old "Dev@0987" monitor password — is
# rotated on upgrade.
# ---------------------------------------------------------------------------
$LeakedApiKeySha256    = "66b808262f744615323fa0e0e3984c38ee291b2755c1d0d166ac20cfe48eae92"
$LeakedMonitorPassword = "Dev@0987"

function New-Secret([int]$Bytes) {
    $buf = New-Object byte[] $Bytes
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buf) } finally { $rng.Dispose() }
    return -join ($buf | ForEach-Object { $_.ToString("x2") })
}

function Get-Sha256Hex([string]$Value) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Value)) } finally { $sha.Dispose() }
    return -join ($hash | ForEach-Object { $_.ToString("x2") })
}

function Set-JsonProp($Obj, [string]$Name, $Value) {
    if ($Obj.PSObject.Properties[$Name]) { $Obj.$Name = $Value }
    else { $Obj | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

function Get-Block($Cfg, [string]$Name) {
    if (-not $Cfg.PSObject.Properties[$Name] -or $null -eq $Cfg.$Name) {
        Set-JsonProp $Cfg $Name ([pscustomobject]@{})
    }
    return $Cfg.$Name
}

function Get-Str($Obj, [string]$Name) {
    if ($null -ne $Obj -and $Obj.PSObject.Properties[$Name] -and $null -ne $Obj.$Name) { return [string]$Obj.$Name }
    return ""
}

function Save-Config($Cfg, [string]$Path) {
    ConvertTo-Json -InputObject $Cfg -Depth 10 | Set-Content $Path -Encoding UTF8
}

# secrets.txt is readable by Administrators and SYSTEM only. The ACL is set on an
# empty file BEFORE the secrets are written, so they never sit under inherited ACLs.
function Write-Secrets([string]$Path, [string[]]$Lines) {
    Set-Content -Path $Path -Value "" -Encoding UTF8
    & icacls $Path /inheritance:r /grant:r "*S-1-5-32-544:(F)" "*S-1-5-18:(F)" | Out-Null
    $header = @(
        "GymSync ZKT Bridge secrets - $(Get-Date -Format 'yyyy-MM-dd HH:mm') on $env:COMPUTERNAME",
        "Keep this file private. Reception sends the API key as the X-Api-Key header",
        "(Reception -> API Management -> ZKTECO_BRIDGE -> key).",
        ""
    )
    Set-Content -Path $Path -Value ($header + $Lines) -Encoding UTF8
}

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

# --- Step 5: config.json + secrets ---
Write-Host "[5/7] Setting up configuration..." -ForegroundColor Yellow
$configPath  = "$InstallDir\config.json"
$secretsPath = "$InstallDir\secrets.txt"
$printApiKey = ""
$printMonitorPassword = ""
$graceNote = ""

$templateSource = Join-Path $scriptDir "config.template.json"
if (Test-Path $templateSource) { Copy-Item $templateSource "$InstallDir\config.template.json" -Force }

if (-not (Test-Path $configPath)) {
    # Fresh install. Start from an operator-supplied config.json in the bundle if
    # there is one, else the shipped template, else a built-in default.
    $bundleConfig = Join-Path $scriptDir "config.json"
    if (Test-Path $bundleConfig) {
        $cfg = Get-Content $bundleConfig -Raw | ConvertFrom-Json
        Write-Host "      config.json taken from the installer bundle"
    } elseif (Test-Path $templateSource) {
        $cfg = Get-Content $templateSource -Raw | ConvertFrom-Json
        Write-Host "      config.json created from config.template.json - UPDATE DEVICE IPs!" -ForegroundColor Yellow
    } else {
        $cfg = @"
{
  "device":  { "ip": "192.168.1.201", "port": 4370, "password": 0, "timeout": 10, "machineNumber": 1 },
  "devices": [],
  "storage": { "path": "storage/templates" },
  "web":     { "host": "0.0.0.0", "port": $Port },
  "security": { "apiKey": "", "additionalApiKeys": [] },
  "monitorPage": { "password": "" }
}
"@ | ConvertFrom-Json
        Write-Host "      Default config.json created - UPDATE DEVICE IPs!" -ForegroundColor Yellow
    }

    $web = Get-Block $cfg "web"
    Set-JsonProp $web "port" $Port

    # Never keep an empty or leaked secret: generate per-branch ones.
    $security = Get-Block $cfg "security"
    $key = Get-Str $security "apiKey"
    if ($ApiKey) { $key = $ApiKey }
    elseif (-not $key -or (Get-Sha256Hex $key) -eq $LeakedApiKeySha256) { $key = New-Secret 32 }
    Set-JsonProp $security "apiKey" $key

    $monitorPage = Get-Block $cfg "monitorPage"
    $pw = Get-Str $monitorPage "password"
    if ($MonitorPassword) { $pw = $MonitorPassword }
    elseif (-not $pw -or $pw -eq $LeakedMonitorPassword) { $pw = New-Secret 10 }
    Set-JsonProp $monitorPage "password" $pw

    Save-Config $cfg $configPath
    Write-Secrets $secretsPath @("API key:               $key", "Monitor page password: $pw")
    $printApiKey = $key
    $printMonitorPassword = $pw
    Write-Host "      API key + monitor password generated - saved to $secretsPath (admins only)" -ForegroundColor Yellow
} else {
    Write-Host "      config.json already exists, keeping it" -ForegroundColor Green
    $cfg = $null
    try { $cfg = Get-Content $configPath -Raw | ConvertFrom-Json }
    catch { Write-Host "      WARNING: config.json could not be parsed - secrets NOT checked: $($_.Exception.Message)" -ForegroundColor Red }

    if ($cfg) {
        $security    = Get-Block $cfg "security"
        $monitorPage = Get-Block $cfg "monitorPage"
        $oldKey = Get-Str $security "apiKey"
        $oldPw  = Get-Str $monitorPage "password"

        $keyLeaked = $oldKey -and ((Get-Sha256Hex $oldKey) -eq $LeakedApiKeySha256)
        $pwLeaked  = $oldPw -eq $LeakedMonitorPassword
        $changed = $false

        if ($keyLeaked -or $pwLeaked) {
            # Rotate BOTH. The old key stays valid for $GraceDays days as a grace key
            # so reception keeps working until its key is updated.
            Copy-Item $configPath "$configPath.bak-$(Get-Date -Format 'yyyyMMddHHmmss')"

            $newKey = if ($ApiKey) { $ApiKey } else { New-Secret 32 }
            $newPw  = if ($MonitorPassword) { $MonitorPassword } else { New-Secret 10 }

            if ($oldKey) {
                $expires = (Get-Date).ToUniversalTime().AddDays($GraceDays).ToString("yyyy-MM-ddTHH:mm:ssZ")
                $grace = @()
                if ($security.PSObject.Properties["additionalApiKeys"] -and $security.additionalApiKeys) {
                    $grace = @($security.additionalApiKeys)
                }
                $grace += [pscustomobject]@{ key = $oldKey; expiresAt = $expires }
                Set-JsonProp $security "additionalApiKeys" $grace
                $graceNote = "The previous API key is still accepted until $expires (UTC)."
            }

            Set-JsonProp $security "apiKey" $newKey
            Set-JsonProp $monitorPage "password" $newPw
            $changed = $true
            $printApiKey = $newKey
            $printMonitorPassword = $newPw
            Write-Host "      SECURITY: this install used the API key / monitor password that shipped" -ForegroundColor Red
            Write-Host "      with every branch up to 1.0 - both have been ROTATED." -ForegroundColor Red
        } elseif (-not $oldPw) {
            # 1.0 fell back to a built-in password when none was set; 1.1 has none and
            # disables the page instead. Give this branch its own so the page still works.
            $newPw = if ($MonitorPassword) { $MonitorPassword } else { New-Secret 10 }
            Set-JsonProp $monitorPage "password" $newPw
            $changed = $true
            $printMonitorPassword = $newPw
            Write-Host "      No monitor password was set - generated one for this branch" -ForegroundColor Yellow
        }

        if ($changed) {
            Save-Config $cfg $configPath
            $lines = @("API key:               $(Get-Str $security 'apiKey')", "Monitor page password: $(Get-Str $monitorPage 'password')")
            if ($graceNote) { $lines += $graceNote }
            Write-Secrets $secretsPath $lines
            Write-Host "      Secrets saved to $secretsPath (admins only)" -ForegroundColor Yellow
        }

        if (-not (Get-Str $security "apiKey")) {
            Write-Host "      WARNING: security.apiKey is empty - the API is open to the LAN." -ForegroundColor Red
            Write-Host "      Re-run with -ApiKey <key>, or set security.apiKey in config.json." -ForegroundColor Red
        }
    }
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
    if ($printApiKey) {
        Write-Host ""
        Write-Host "  API KEY   : $printApiKey" -ForegroundColor Cyan
        Write-Host "  Configure reception to send it as the 'X-Api-Key' header" -ForegroundColor Yellow
        Write-Host "  (Reception -> API Management -> ZKTECO_BRIDGE -> key)." -ForegroundColor Yellow
        Write-Host "  (Local/loopback calls and the test UI on this PC don't need it.)"
        if ($graceNote) { Write-Host "  $graceNote" -ForegroundColor Yellow }
    }
    if ($printMonitorPassword) {
        Write-Host "  MONITOR   : http://localhost:$Port/monitor.html  password: $printMonitorPassword" -ForegroundColor Cyan
    }
    if ($printApiKey -or $printMonitorPassword) {
        Write-Host "  Both are saved in $secretsPath (Administrators only)."
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
