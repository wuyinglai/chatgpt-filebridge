param(
    [Parameter(Position=0, Mandatory=$true, HelpMessage="Root directory to expose")]
    [string]$Directory,

    [int]$Port = 7676
)

$ErrorActionPreference = "Continue"
chcp 65001 >$null 2>$null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Stop-PortOwner {
    param([int]$TargetPort)
    try {
        $connections = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue
        foreach ($conn in $connections) {
            if ($conn.OwningProcess -and $conn.OwningProcess -ne $PID) {
                Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
}

function Stop-CloudflaredForPort {
    param([int]$TargetPort)
    $needle = "127.0.0.1:$TargetPort"
    Get-CimInstance Win32_Process -Filter "name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*$needle*" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

Write-Host "=== DevSpace + Cloudflare Tunnel ===" -ForegroundColor Cyan
Write-Host "  Directory: $Directory" -ForegroundColor White

if (-not (Test-Path $Directory)) {
    Write-Host "[ERROR] Directory not found: $Directory" -ForegroundColor Red
    pause
    exit 1
}

$devspaceCmd = (Get-Command devspace -ErrorAction SilentlyContinue).Source
$cloudflaredCmd = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $devspaceCmd -or -not (Test-Path $devspaceCmd)) {
    Write-Host "[ERROR] devspace command not found. Make sure it is installed and on your PATH." -ForegroundColor Red
    pause
    exit 1
}
if (-not $cloudflaredCmd -or -not (Test-Path $cloudflaredCmd)) {
    Write-Host "[ERROR] cloudflared command not found. Make sure it is installed and on your PATH." -ForegroundColor Red
    pause
    exit 1
}

$configDir = Join-Path $env:USERPROFILE ".devspace"
$configFile = Join-Path $configDir "config.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

$existingUrl = $null
if (Test-Path $configFile) {
    try {
        $oldConfig = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($oldConfig.publicBaseUrl) {
            try {
                $check = Invoke-WebRequest -Uri "$($oldConfig.publicBaseUrl)/mcp" -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop
                $existingUrl = $oldConfig.publicBaseUrl
            } catch {
                $sc = $null
                try { $sc = $_.Exception.Response.StatusCode.value__ } catch {}
                if ($sc -eq 401) { $existingUrl = $oldConfig.publicBaseUrl }
            }
        }
    } catch {
        Write-Host "  Existing DevSpace config is unreadable; creating a fresh one." -ForegroundColor Yellow
    }
}

if ($existingUrl) {
    Write-Host "  Reusing tunnel: $existingUrl" -ForegroundColor Green
    Write-Host "[1/2] Restarting DevSpace on port $Port..." -ForegroundColor Yellow
    Stop-PortOwner -TargetPort $Port
    Start-Sleep -Seconds 2
} else {
    Write-Host "[1/3] Stopping old DevSpace tunnel on port $Port..." -ForegroundColor Yellow
    Stop-PortOwner -TargetPort $Port
    Stop-CloudflaredForPort -TargetPort $Port
    Start-Sleep -Seconds 2

    Write-Host "[2/3] Starting Cloudflare Tunnel..." -ForegroundColor Yellow
    $job = Start-Job -ScriptBlock {
        param($Cloudflared, $ForwardPort)
        & $Cloudflared tunnel --protocol http2 --url "http://127.0.0.1:$ForwardPort" 2>&1
    } -ArgumentList $cloudflaredCmd,$Port

    $tunnelUrl = $null
    for ($i = 0; $i -lt 15; $i++) {
        Start-Sleep -Seconds 2
        $output = Receive-Job $job -ErrorAction SilentlyContinue
        if ($output) {
            foreach ($line in $output) {
                if ($line -match 'https://[a-zA-Z0-9\-]+\.trycloudflare\.com' -and $line -notmatch 'api\.trycloudflare\.com') {
                    $tunnelUrl = $matches[0]
                    break
                }
            }
        }
        if ($tunnelUrl) { break }
    }

    if (-not $tunnelUrl) {
        Write-Host "[ERROR] Cannot get tunnel URL." -ForegroundColor Red
        Receive-Job $job -ErrorAction SilentlyContinue | Select-Object -First 10
        pause
        exit 1
    }
    Write-Host "  Tunnel: $tunnelUrl" -ForegroundColor Green
    $existingUrl = $tunnelUrl
}

if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}

$configJson = @{
    allowedRoots = @($Directory)
    port = $Port
    publicBaseUrl = $existingUrl
} | ConvertTo-Json
[System.IO.File]::WriteAllText($configFile, $configJson, $utf8NoBom)

Write-Host "Starting DevSpace..." -ForegroundColor Yellow
$env:DEVSPACE_TRUST_PROXY = "true"
$devspaceProc = Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList "/k set DEVSPACE_TRUST_PROXY=true && `"$devspaceCmd`" serve" `
    -PassThru

Start-Sleep -Seconds 5

$alive = $false
for ($i = 0; $i -lt 5; $i++) {
    try {
        $req = [System.Net.WebRequest]::Create("http://127.0.0.1:$Port/mcp")
        $req.Timeout = 2000
        $resp = $req.GetResponse()
        $code = [int]$resp.StatusCode
        $resp.Close()
        if ($code -eq 200 -or $code -eq 401) {
            $alive = $true
            break
        }
    } catch [System.Net.WebException] {
        $code = $null
        try { $code = [int]$_.Exception.Response.StatusCode } catch {}
        if ($code -eq 200 -or $code -eq 401) {
            $alive = $true
            break
        }
    } catch {}
    Start-Sleep -Seconds 2
}

if (-not $alive) {
    Write-Host "[ERROR] DevSpace failed to start." -ForegroundColor Red
    pause
    exit 1
}

Write-Host ""
Write-Host "=== READY ===" -ForegroundColor Green
Write-Host "  Directory: $Directory"
Write-Host "  MCP URL : $existingUrl/mcp" -ForegroundColor Green
Write-Host ""

if ($job) {
    Write-Host "Tunnel job is running. Press Ctrl+C to stop this window." -ForegroundColor Gray
    while ($job.State -eq "Running") { Start-Sleep -Seconds 5 }
}
