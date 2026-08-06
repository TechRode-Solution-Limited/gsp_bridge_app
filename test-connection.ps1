# GymSync ZKTeco Middleware - Connection self-test
#
# Reads config.json and probes every configured device in three layers, so a
# failure lands on a specific cause instead of a bare "cannot connect":
#
#   1. TCP     - can we open a socket to <ip>:<port> at all?
#   2. SDK     - does zkemkeeper's Connect_Net succeed with the configured comm
#                password? This is the exact call DeviceClient.Connect makes, so
#                the code it reports is the same one that appears in
#                "Cannot connect to ZKTeco device at ... (SDK error=N)".
#   3. Bridge  - does POST /api/v1/connect on the running service succeed?
#
# Does NOT require Administrator. Safe to run against a live branch: the SDK
# layer is skipped while the service is running (devices accept one TCP client
# at a time, and stealing the lock would cause the very failure we're chasing) -
# pass -Direct to override.

param(
    # Explicit config.json. Default resolution order is:
    #   -ConfigPath -> <InstallDir>\config.json -> <this script's folder>\config.json
    [string]$ConfigPath = "",
    [string]$InstallDir = "C:\GymSync",
    [string]$ServiceName = "GymSyncZkt",
    # Test only the device whose name or IP matches this. Default: every device.
    [string]$Device = "",
    # Run the raw SDK probe even when the service is running. This takes the
    # device's single TCP slot away from the Bridge for the duration.
    [switch]$Direct,
    [switch]$SkipSdk,
    # Internal - set when this script relaunches itself under a different
    # apartment state or bitness, to stop it from looping.
    [switch]$NoRelaunch
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  GymSync ZKTeco - Connection Test"
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# --- COM needs an STA thread (same reason DeviceClient uses StaExecutor) ---
if (-not $NoRelaunch -and [Threading.Thread]::CurrentThread.GetApartmentState() -ne "STA") {
    Write-Host "Relaunching under an STA thread (required for the ZKTeco COM SDK)..." -ForegroundColor Yellow
    $relaunch = @("-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"", "-NoRelaunch")
    if ($ConfigPath)  { $relaunch += @("-ConfigPath", "`"$ConfigPath`"") }
    if ($InstallDir)  { $relaunch += @("-InstallDir", "`"$InstallDir`"") }
    if ($Device)      { $relaunch += @("-Device", "`"$Device`"") }
    if ($Direct)      { $relaunch += "-Direct" }
    if ($SkipSdk)     { $relaunch += "-SkipSdk" }
    $p = Start-Process -FilePath "powershell.exe" -ArgumentList $relaunch -NoNewWindow -Wait -PassThru
    exit $p.ExitCode
}

function Get-Prop($obj, [string]$name, $fallback) {
    if ($null -eq $obj) { return $fallback }
    $p = $obj.PSObject.Properties[$name]
    if ($null -eq $p -or $null -eq $p.Value) { return $fallback }
    return $p.Value
}

function Env-Or($key, $fallback) {
    $v = [Environment]::GetEnvironmentVariable($key)
    if ([string]::IsNullOrWhiteSpace($v)) { return $fallback }
    return $v
}

function Env-IntOr($key, [int]$fallback) {
    $v = [Environment]::GetEnvironmentVariable($key)
    $n = 0
    if ([int]::TryParse($v, [ref]$n)) { return $n }
    return $fallback
}

# --- Step 1: Locate and read config.json ---
Write-Host "[1/4] Reading configuration..." -ForegroundColor Yellow

$candidates = @()
if ($ConfigPath) { $candidates += $ConfigPath }
$candidates += (Join-Path $InstallDir "config.json")
$candidates += (Join-Path $scriptDir "config.json")

$resolvedConfig = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $resolvedConfig) {
    Write-Host "      ERROR: no config.json found. Looked in:" -ForegroundColor Red
    $candidates | ForEach-Object { Write-Host "        $_" }
    exit 2
}

try {
    $cfg = Get-Content $resolvedConfig -Raw | ConvertFrom-Json
} catch {
    Write-Host "      ERROR: $resolvedConfig is not valid JSON - $($_.Exception.Message)" -ForegroundColor Red
    exit 2
}

Write-Host "      Config    : $resolvedConfig" -ForegroundColor Green

# The service applies these env overrides at startup (ConfigLoader), so honour
# them here too - otherwise the script can report a device the Bridge isn't using.
$deviceCfg = Get-Prop $cfg "device" $null
$defaultTarget = [PSCustomObject]@{
    Label    = "(default)"
    Ip       = Env-Or    "ZKT_IP"       (Get-Prop $deviceCfg "ip" "")
    Port     = Env-IntOr "ZKT_PORT"     ([int](Get-Prop $deviceCfg "port" 4370))
    Password = Env-IntOr "ZKT_PASSWORD" ([int](Get-Prop $deviceCfg "password" 0))
    Timeout  = Env-IntOr "ZKT_TIMEOUT"  ([int](Get-Prop $deviceCfg "timeout" 10))
    Machine  = Env-IntOr "ZKT_MACHINE"  ([int](Get-Prop $deviceCfg "machineNumber" 1))
}

$targets = @()
if ($defaultTarget.Ip) { $targets += $defaultTarget }

foreach ($d in @(Get-Prop $cfg "devices" @())) {
    $ip = Get-Prop $d "ip" ""
    if (-not $ip) { continue }
    $name = Get-Prop $d "name" ""
    if (-not $name) { $name = $ip }
    $targets += [PSCustomObject]@{
        Label    = $name
        Ip       = $ip
        Port     = [int](Get-Prop $d "port" 4370)
        Password = [int](Get-Prop $d "password" 0)
        Timeout  = [int](Get-Prop $d "timeout" 10)
        Machine  = [int](Get-Prop $d "machineNumber" 1)
    }
}

# devices[] usually repeats the default device - probe each endpoint once.
$seen = @{}
$targets = @($targets | Where-Object {
    $key = "$($_.Ip):$($_.Port)"
    if ($seen.ContainsKey($key)) { return $false }
    $seen[$key] = $true
    return $true
})

if ($Device) {
    $targets = @($targets | Where-Object { $_.Label -eq $Device -or $_.Ip -eq $Device })
    if (-not $targets) {
        Write-Host "      ERROR: no device in config matches '$Device'" -ForegroundColor Red
        exit 2
    }
}

if (-not $targets) {
    Write-Host "      ERROR: config has no device.ip and no devices[] entries" -ForegroundColor Red
    exit 2
}

Write-Host "      Devices   : $($targets.Count)" -ForegroundColor Green

$webPort = [int](Get-Prop (Get-Prop $cfg "web" $null) "port" 5000)
$apiKey  = Env-Or "ZKT_API_KEY" (Get-Prop (Get-Prop $cfg "security" $null) "apiKey" "")

# --- Step 2: Locate the SDK interop next to the app ---
Write-Host "[2/4] Locating ZKTeco SDK..." -ForegroundColor Yellow

# install.ps1 flattens app\* straight into InstallDir; the release bundle keeps
# them under app\. Check both, plus the script's own folder.
$appDirs = @($InstallDir, (Join-Path $InstallDir "app"), (Join-Path $scriptDir "app"), $scriptDir)
$appDir = $appDirs | Where-Object { $_ -and (Test-Path (Join-Path $_ "Interop.zkemkeeper.dll")) } | Select-Object -First 1

if ($appDir) {
    Write-Host "      SDK       : $appDir" -ForegroundColor Green
} else {
    Write-Host "      Interop.zkemkeeper.dll not found - SDK layer will be skipped" -ForegroundColor Yellow
    $appDirs | ForEach-Object { Write-Host "        looked in $_" -ForegroundColor DarkGray }
}

# --- Step 3: Service state decides which layers are safe to run ---
Write-Host "[3/4] Checking service..." -ForegroundColor Yellow

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
$svcRunning = ($null -ne $svc -and $svc.Status -eq "Running")

if ($null -eq $svc) {
    Write-Host "      $ServiceName not installed - Bridge layer will be skipped" -ForegroundColor Yellow
} elseif ($svcRunning) {
    Write-Host "      $ServiceName is Running" -ForegroundColor Green
} else {
    Write-Host "      $ServiceName is $($svc.Status) - Bridge layer will be skipped" -ForegroundColor Yellow
}

$runSdk = (-not $SkipSdk) -and $appDir -and ((-not $svcRunning) -or $Direct)
if ($svcRunning -and -not $Direct -and -not $SkipSdk -and $appDir) {
    Write-Host "      Skipping the direct SDK probe so it can't steal the device" -ForegroundColor DarkGray
    Write-Host "      lock from the running service. Pass -Direct to force it." -ForegroundColor DarkGray
}

function Test-TcpPort([string]$ip, [int]$port, [int]$timeoutSec) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $iar = $client.BeginConnect($ip, $port, $null, $null)
        if (-not $iar.AsyncWaitHandle.WaitOne([TimeSpan]::FromSeconds($timeoutSec))) {
            return @{ Ok = $false; Detail = "no response within ${timeoutSec}s" }
        }
        $client.EndConnect($iar)
        return @{ Ok = $true; Detail = "port open" }
    } catch {
        $msg = $_.Exception.Message
        if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
        return @{ Ok = $false; Detail = $msg }
    } finally {
        $client.Close()
    }
}

function New-Czkem {
    # Prefer the pre-generated interop (what the Bridge itself uses) so we don't
    # depend on which ProgID this SDK version registered. Fall back to late-bound
    # COM if the interop won't load.
    try {
        return @{ Obj = (New-Object zkemkeeper.CZKEMClass); LateBound = $false }
    } catch { }
    foreach ($progId in @("zkemkeeper.ZKEM", "zkemkeeper.CZKEM")) {
        try {
            return @{ Obj = (New-Object -ComObject $progId); LateBound = $true }
        } catch { }
    }
    return $null
}

function Test-SdkConnect($target, [string]$appDir) {
    $prevCwd = [Environment]::CurrentDirectory
    Push-Location $appDir
    # Native helpers (tcpcomm.dll, comms.dll, ...) are probed relative to the
    # process working directory - getting this wrong is the classic error -201.
    [Environment]::CurrentDirectory = $appDir
    $czkem = $null
    try {
        $interop = Join-Path $appDir "Interop.zkemkeeper.dll"
        try {
            Add-Type -Path $interop -ErrorAction Stop
        } catch {
            try { [void][Reflection.Assembly]::LoadFrom($interop) } catch { }
        }

        $created = New-Czkem
        if ($null -eq $created) {
            return @{ Ok = $false; Detail = "could not create the zkemkeeper COM object"; NotRegistered = $true }
        }
        $czkem = $created.Obj

        if ($target.Password -ne 0) {
            try { [void]$czkem.SetCommPassword($target.Password) } catch { }
        }

        if ($czkem.Connect_Net($target.Ip, $target.Port)) {
            try { $czkem.Disconnect() } catch { }
            return @{ Ok = $true; Detail = "connected" }
        }

        $code = 0
        try {
            [void]$czkem.GetLastError([ref]$code)
            return @{ Ok = $false; Code = $code; Detail = "Connect_Net returned false (SDK error=$code)" }
        } catch {
            return @{ Ok = $false; Detail = "Connect_Net returned false (error code unavailable via late-bound COM)" }
        }
    } catch {
        $msg = $_.Exception.Message
        $notReg = ($_.Exception -is [System.Runtime.InteropServices.COMException]) -and
                  ($_.Exception.HResult -eq 0x80040154)
        return @{ Ok = $false; Detail = $msg; NotRegistered = $notReg }
    } finally {
        if ($czkem) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($czkem) }
        [Environment]::CurrentDirectory = $prevCwd
        Pop-Location
    }
}

function Test-BridgeConnect($target, [int]$webPort, [string]$apiKey) {
    # Always loopback: web.host may be 0.0.0.0, and loopback callers are exempt
    # from the X-Api-Key gate anyway (we send it when configured regardless).
    $uri = "http://127.0.0.1:$webPort/api/v1/connect"
    $headers = @{}
    if ($apiKey) { $headers["X-Api-Key"] = $apiKey }
    $body = @{ ip = $target.Ip; port = $target.Port } | ConvertTo-Json -Compress
    try {
        $resp = Invoke-RestMethod -Method Post -Uri $uri -Headers $headers `
            -ContentType "application/json" -Body $body -TimeoutSec ($target.Timeout + 10)
        if ($resp.ok) { return @{ Ok = $true; Detail = "/api/v1/connect ok" } }
        return @{ Ok = $false; Detail = "$($resp.error)" }
    } catch {
        $detail = $_.Exception.Message
        $resp = $_.Exception.Response
        if ($resp) {
            try {
                $reader = New-Object IO.StreamReader($resp.GetResponseStream())
                $text = $reader.ReadToEnd()
                if ($text) { $detail = "HTTP $([int]$resp.StatusCode) - $text" }
            } catch { }
        }
        return @{ Ok = $false; Detail = $detail }
    }
}

# Turn the combination of layer results into the most likely cause, so the
# operator gets an action rather than a code to go and look up.
function Get-Diagnosis($tcp, $sdk, $bridge, $target) {
    if (-not $tcp.Ok) {
        return "Device unreachable on the network. Check it is powered on, on the same " +
               "LAN, and that $($target.Ip) is still its IP (Menu > Comm > Ethernet). " +
               "Nothing below this layer can succeed."
    }
    if ($null -ne $sdk -and -not $sdk.Ok) {
        if ($sdk.NotRegistered) {
            $bits = if ([Environment]::Is64BitProcess) { "64-bit" } else { "32-bit" }
            $msg = "zkemkeeper COM is not registered for this ($bits) process. Re-run " +
                   "install.ps1 as Administrator to register it. "
            if ([Environment]::Is64BitProcess) {
                $msg += "If only the x86 SDK is registered on this box, retry under 32-bit " +
                        "PowerShell: $env:SystemRoot\SysWOW64\WindowsPowerShell\v1.0\powershell.exe " +
                        "-STA -ExecutionPolicy Bypass -File `"$PSCommandPath`""
            }
            return $msg
        }
        if ($sdk.Code -eq 0) {
            return "Port is open but the device did not complete the ZKTeco handshake. " +
                   "Usually the wrong port or a non-ZKTeco service on $($target.Port)."
        }
        if ($sdk.Code -eq -201) {
            return "Missing native helper DLLs (tcpcomm.dll, comms.dll, ...) next to the app. " +
                   "They must sit in the same folder as GymSync.Zkt.WebUI.exe."
        }
        if ($null -ne $sdk.Code) {
            $hint = "Port is open but the SDK refused the session (error=$($sdk.Code)). "
            if ($target.Password -ne 0) {
                $hint += "Most likely the comm password: config has $($target.Password), " +
                         "compare it against the device's Menu > Comm > Security > Comm Key. "
            } else {
                $hint += "Config sets no comm password - if the device has a Comm Key set, " +
                         "put it in config.json as device.password. "
            }
            return $hint + "Otherwise another client holds the device's single TCP slot " +
                   "(reception's direct-TCP fallback, the test UI, ZKAccess/ZKTime)."
        }
        return "SDK connect failed: $($sdk.Detail)"
    }
    if ($null -ne $bridge -and -not $bridge.Ok) {
        return "The device is reachable but the Bridge call failed. Check the service is " +
               "listening on port $webPort and see C:\GymSync\logs\bridge-<date>.log."
    }
    return ""
}

# --- Step 4: Probe ---
Write-Host "[4/4] Testing devices..." -ForegroundColor Yellow
Write-Host ""

$failures = 0

foreach ($t in $targets) {
    $pwLabel = if ($t.Password -eq 0) { "none" } else { "$($t.Password)" }
    Write-Host "  $($t.Label)  ->  $($t.Ip):$($t.Port)" -ForegroundColor Cyan
    Write-Host "    comm password: $pwLabel   machine: $($t.Machine)   timeout: $($t.Timeout)s" -ForegroundColor DarkGray

    $tcp = Test-TcpPort $t.Ip $t.Port $t.Timeout
    if ($tcp.Ok) {
        Write-Host "    [TCP]    PASS  $($tcp.Detail)" -ForegroundColor Green
    } else {
        Write-Host "    [TCP]    FAIL  $($tcp.Detail)" -ForegroundColor Red
    }

    $sdk = $null
    if ($runSdk -and $tcp.Ok) {
        $sdk = Test-SdkConnect $t $appDir
        if ($sdk.Ok) {
            Write-Host "    [SDK]    PASS  $($sdk.Detail)" -ForegroundColor Green
        } else {
            Write-Host "    [SDK]    FAIL  $($sdk.Detail)" -ForegroundColor Red
        }
    } else {
        Write-Host "    [SDK]    SKIP" -ForegroundColor DarkGray
    }

    $bridge = $null
    if ($svcRunning) {
        $bridge = Test-BridgeConnect $t $webPort $apiKey
        if ($bridge.Ok) {
            Write-Host "    [BRIDGE] PASS  $($bridge.Detail)" -ForegroundColor Green
        } else {
            Write-Host "    [BRIDGE] FAIL  $($bridge.Detail)" -ForegroundColor Red
        }
    } else {
        Write-Host "    [BRIDGE] SKIP" -ForegroundColor DarkGray
    }

    $bad = (-not $tcp.Ok) -or ($null -ne $sdk -and -not $sdk.Ok) -or ($null -ne $bridge -and -not $bridge.Ok)
    if ($bad) {
        $failures++
        $diagnosis = Get-Diagnosis $tcp $sdk $bridge $t
        if ($diagnosis) {
            Write-Host ""
            Write-Host "    LIKELY CAUSE:" -ForegroundColor Yellow
            Write-Host "    $diagnosis" -ForegroundColor Yellow
        }
    }
    Write-Host ""
}

Write-Host "========================================" -ForegroundColor Cyan
if ($failures -eq 0) {
    Write-Host "  All $($targets.Count) device(s) OK" -ForegroundColor Green
    Write-Host "========================================" -ForegroundColor Cyan
    Write-Host ""
    exit 0
}

Write-Host "  $failures of $($targets.Count) device(s) FAILED" -ForegroundColor Red
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
if ($svcRunning -and -not $Direct) {
    Write-Host "  To test the SDK layer directly (stops sharing the device with" -ForegroundColor Yellow
    Write-Host "  the service), stop it first and re-run:" -ForegroundColor Yellow
    Write-Host "    sc.exe stop $ServiceName" -ForegroundColor White
    Write-Host "    .\test-connection.ps1" -ForegroundColor White
    Write-Host "    sc.exe start $ServiceName" -ForegroundColor White
    Write-Host ""
}
exit 1
