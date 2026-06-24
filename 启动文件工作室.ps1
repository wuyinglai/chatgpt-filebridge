param(
    [Parameter(Position=0, Mandatory=$true, HelpMessage="Root directory to expose via MCP")]
    [string]$Directory,

    [int]$Port = 7676,

    [string]$PythonExe = "python"
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

function Stop-FileWorksServerProcesses {
    param(
        [string]$Script,
        [int]$ListenPort
    )
    $scriptName = Split-Path -Leaf $Script
    Get-CimInstance Win32_Process -Filter "name = 'python.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.ProcessId -ne $PID -and
            $_.CommandLine -like "*$scriptName*" -and
            $_.CommandLine -like "* $ListenPort *"
        } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Ensure-LlmConfig {
    param([string]$ServerDir)
    $configFile = Join-Path $ServerDir "llm_config.json"
    $exampleFile = Join-Path $ServerDir "llm_config.json.example"
    if (-not (Test-Path $configFile) -and (Test-Path $exampleFile)) {
        Copy-Item -LiteralPath $exampleFile -Destination $configFile -Force
        Write-Host "  Created local LLM config: $configFile" -ForegroundColor Yellow
        Write-Host "  Fill api_key there, or set AGNES_API_KEY in your environment." -ForegroundColor Yellow
    }
}

function Test-HttpOk {
    param(
        [string]$Uri,
        [int]$TimeoutSec = 5
    )
    try {
        $resp = Invoke-WebRequest -Uri $Uri -Method GET -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
        return ([int]$resp.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Start-FileWorksServer {
    param(
        [string]$Python,
        [string]$Script,
        [int]$ListenPort,
        [string]$RootDir,
        [string]$PublicUrl,
        [string]$WorkDir,
        [string]$StdoutLog,
        [string]$StderrLog
    )

    Remove-Item -LiteralPath $StdoutLog,$StderrLog -ErrorAction SilentlyContinue
    return Start-Job -ScriptBlock {
        param($PythonPath, $ScriptPath, $PortValue, $RootPath, $TunnelValue, $WorkingDirectory, $OutLog, $ErrLog)
        Set-Location -LiteralPath $WorkingDirectory
        & $PythonPath $ScriptPath $PortValue $RootPath $TunnelValue > $OutLog 2> $ErrLog
    } -ArgumentList $Python,$Script,$ListenPort,$RootDir,$PublicUrl,$WorkDir,$StdoutLog,$StderrLog
}

function Wait-LocalReady {
    param(
        [int]$ListenPort,
        [int]$Attempts = 12
    )
    for ($i = 0; $i -lt $Attempts; $i++) {
        if (Test-HttpOk -Uri "http://127.0.0.1:$ListenPort/health" -TimeoutSec 3) {
            return $true
        }
        Write-Host "  Waiting for server..." -ForegroundColor Gray
        Start-Sleep -Seconds 2
    }
    return $false
}

Write-Host "=== FileWorks MCP (Cloudflare + OAuth) ===" -ForegroundColor Cyan
Write-Host "  Root: $Directory" -ForegroundColor White

if (-not (Test-Path $Directory)) {
    Write-Host "[ERROR] Directory does not exist: $Directory" -ForegroundColor Red
    pause
    exit 1
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverDir = Join-Path $projectRoot "local-llm-mcp"
$serverScript = Join-Path $serverDir "combined_mcp_server.py"

if (-not (Test-Path $serverScript)) {
    Write-Host "[ERROR] Server script not found: $serverScript" -ForegroundColor Red
    pause
    exit 1
}

if (-not (Test-Path $PythonExe)) {
    $PythonExe = "python"
}

Ensure-LlmConfig -ServerDir $serverDir

$logFile = Join-Path $env:TEMP "fileworks_cloudflared_stdout.log"
$errFile = Join-Path $env:TEMP "fileworks_cloudflared_stderr.log"
$serverOutFile = Join-Path $env:TEMP "fileworks_server_stdout.log"
$serverErrFile = Join-Path $env:TEMP "fileworks_server_stderr.log"
Remove-Item -LiteralPath $logFile,$errFile -ErrorAction SilentlyContinue

Write-Host "[1/3] Stopping old FileWorks processes on port $Port..." -ForegroundColor Yellow
Stop-PortOwner -TargetPort $Port
Stop-FileWorksServerProcesses -Script $serverScript -ListenPort $Port
Stop-CloudflaredForPort -TargetPort $Port
Start-Sleep -Seconds 2

Write-Host "[2/3] Starting Cloudflare Tunnel..." -ForegroundColor Yellow
$cloudflaredCmd = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflaredCmd) {
    Write-Host "[ERROR] cloudflared not found on PATH. Install: winget install Cloudflare.cloudflared" -ForegroundColor Red
    pause
    exit 1
}

$cloudflaredProc = Start-Process `
    -FilePath $cloudflaredCmd `
    -ArgumentList "tunnel --protocol http2 --url http://127.0.0.1:$Port" `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError $errFile `
    -WindowStyle Hidden `
    -PassThru

$tunnelUrl = $null
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    Write-Host "." -NoNewline -ForegroundColor Gray
    $allContent = ""
    if (Test-Path $logFile) { $allContent += Get-Content $logFile -Raw -ErrorAction SilentlyContinue }
    if (Test-Path $errFile) { $allContent += Get-Content $errFile -Raw -ErrorAction SilentlyContinue }
    if ($allContent -match "https://([a-zA-Z0-9\-]+)\.trycloudflare\.com") {
        $tunnelUrl = $matches[0]
        break
    }
}
Write-Host ""

if (-not $tunnelUrl) {
    Write-Host "[ERROR] Failed to get tunnel URL." -ForegroundColor Red
    Write-Host "--- cloudflared stderr ---" -ForegroundColor Gray
    if (Test-Path $errFile) { Get-Content $errFile -ErrorAction SilentlyContinue | Select-Object -First 20 }
    pause
    exit 1
}

Write-Host "  Tunnel: $tunnelUrl" -ForegroundColor Green

Write-Host "[3/3] Starting FileWorks MCP Server..." -ForegroundColor Yellow
$serverProc = Start-FileWorksServer `
    -Python $PythonExe `
    -Script $serverScript `
    -ListenPort $Port `
    -RootDir $Directory `
    -PublicUrl $tunnelUrl `
    -WorkDir $serverDir `
    -StdoutLog $serverOutFile `
    -StderrLog $serverErrFile

$alive = Wait-LocalReady -ListenPort $Port

if (-not $alive) {
    Write-Host "[ERROR] Server failed to start." -ForegroundColor Red
    Write-Host "--- server stdout ---" -ForegroundColor Gray
    if (Test-Path $serverOutFile) { Get-Content $serverOutFile -Tail 40 -ErrorAction SilentlyContinue }
    Write-Host "--- server stderr ---" -ForegroundColor Gray
    if (Test-Path $serverErrFile) { Get-Content $serverErrFile -Tail 40 -ErrorAction SilentlyContinue }
    pause
    exit 1
}

$publicAlive = Test-HttpOk -Uri "$tunnelUrl/.well-known/oauth-authorization-server" -TimeoutSec 10

Write-Host ""
Write-Host "=== READY ===" -ForegroundColor Green
Write-Host "  Root    : $Directory"
Write-Host "  MCP URL : $tunnelUrl" -ForegroundColor Green
Write-Host "  Status  : http://127.0.0.1:$Port/status" -ForegroundColor Green
Write-Host "  Health  : http://127.0.0.1:$Port/health"
if ($publicAlive) {
    Write-Host "  Public  : OAuth discovery OK" -ForegroundColor Green
} else {
    Write-Host "  Public  : tunnel not ready yet; keep this window open and retry in ChatGPT shortly" -ForegroundColor Yellow
}
Write-Host "  Tools   : list_directory, read_file, write_file, search_files, call_llm"
Write-Host "  LLM     : local-llm-mcp\llm_config.json or AGNES_* env vars"
Write-Host "  Auth    : OAuth 2.0 username/password"
Write-Host ""
Write-Host "  Add in ChatGPT:" -ForegroundColor Yellow
Write-Host "  1. Settings > Connectors > Add custom connector"
Write-Host "  2. Paste this URL: $tunnelUrl" -ForegroundColor Green
Write-Host "  3. Auth: OAuth"
Write-Host "  4. Login with MCP_USER/MCP_PASS (check server output above for credentials)"
Write-Host ""
Write-Host "Press Enter to stop FileWorks services..." -ForegroundColor Gray
Write-Host "Supervisor: checks every 15s and restarts the Python service if it exits." -ForegroundColor Gray

$lastStatus = ""
while ($true) {
    if ([Console]::KeyAvailable) {
        $key = [Console]::ReadKey($true)
        if ($key.Key -eq 'Enter') { break }
    }

    $needsRestart = $false
    $localHealthOk = Test-HttpOk -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
    if (-not $localHealthOk) {
        $needsRestart = $true
        Write-Host "[WARN] FileWorks health check failed; restarting..." -ForegroundColor Yellow
        if ($serverProc) {
            Stop-Job $serverProc -ErrorAction SilentlyContinue
            Remove-Job $serverProc -Force -ErrorAction SilentlyContinue
        }
    }

    if ($needsRestart) {
        Stop-PortOwner -TargetPort $Port
        Stop-FileWorksServerProcesses -Script $serverScript -ListenPort $Port
        Start-Sleep -Seconds 1
        $serverProc = Start-FileWorksServer `
            -Python $PythonExe `
            -Script $serverScript `
            -ListenPort $Port `
            -RootDir $Directory `
            -PublicUrl $tunnelUrl `
            -WorkDir $serverDir `
            -StdoutLog $serverOutFile `
            -StderrLog $serverErrFile

        if (Wait-LocalReady -ListenPort $Port -Attempts 8) {
            Write-Host "[OK] FileWorks server restarted." -ForegroundColor Green
        } else {
            Write-Host "[ERROR] Restart failed. See logs:" -ForegroundColor Red
            Write-Host "  $serverOutFile"
            Write-Host "  $serverErrFile"
        }
    }

    $localOk = Test-HttpOk -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 4
    $publicOk = Test-HttpOk -Uri "$tunnelUrl/.well-known/oauth-authorization-server" -TimeoutSec 8
    $cloudflareOk = ($cloudflaredProc -and -not $cloudflaredProc.HasExited)
    $status = "local=$localOk public=$publicOk tunnel_process=$cloudflareOk"
    if ($status -ne $lastStatus) {
        if ($localOk -and $publicOk -and $cloudflareOk) {
            Write-Host "[OK] Health: $status" -ForegroundColor Green
        } elseif ($localOk -and -not $publicOk) {
            Write-Host "[WARN] Local service is OK, but public tunnel check failed. ChatGPT may see OAuth errors." -ForegroundColor Yellow
        } elseif (-not $cloudflareOk) {
            Write-Host "[ERROR] Cloudflare tunnel process exited. Restart this script to get a new ChatGPT URL." -ForegroundColor Red
        } else {
            Write-Host "[WARN] Health: $status" -ForegroundColor Yellow
        }
        $lastStatus = $status
    }

    Start-Sleep -Seconds 15
}

if ($serverProc) {
    Stop-Job $serverProc -ErrorAction SilentlyContinue
    Remove-Job $serverProc -Force -ErrorAction SilentlyContinue
}
Stop-PortOwner -TargetPort $Port
Stop-FileWorksServerProcesses -Script $serverScript -ListenPort $Port
if ($cloudflaredProc -and -not $cloudflaredProc.HasExited) {
    Stop-Process -Id $cloudflaredProc.Id -Force -ErrorAction SilentlyContinue
}
Write-Host "Stopped." -ForegroundColor Yellow
