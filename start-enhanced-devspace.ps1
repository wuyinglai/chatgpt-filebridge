param(
    [Parameter(Position=0, Mandatory=$true, HelpMessage="Root directory to expose via MCP")]
    [string]$Directory,

    [int]$Port = 7676,

    [string]$NodeExe = "node"
)

$ErrorActionPreference = "Continue"
chcp 65001 >$null 2>$null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Get-ProcessById {
    param([int]$ProcessId)
    Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Stop-KnownSupervisorParent {
    param([int]$ParentProcessId)
    if (-not $ParentProcessId -or $ParentProcessId -eq $PID) {
        return
    }

    $parent = Get-ProcessById -ProcessId $ParentProcessId
    if (-not $parent -or $parent.Name -notlike "*powershell*") {
        return
    }

    $cmd = [string]$parent.CommandLine
    if (
        $cmd -like "*start-fileworks.ps1*" -or
        $cmd -like "*start-enhanced-devspace.ps1*" -or
        $cmd -like "* -s -NoLogo -NoProfile*"
    ) {
        Stop-Process -Id $parent.ProcessId -Force -ErrorAction SilentlyContinue
    }
}

function Stop-PortOwner {
    param([int]$TargetPort)
    try {
        $connections = Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue
        foreach ($conn in $connections) {
            if ($conn.OwningProcess -and $conn.OwningProcess -ne $PID) {
                $proc = Get-ProcessById -ProcessId $conn.OwningProcess
                Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
                if ($proc) {
                    Stop-KnownSupervisorParent -ParentProcessId $proc.ParentProcessId
                }
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

function Stop-RelatedServers {
    param([int]$TargetPort, [string]$ProjectRoot)
    $escapedRoot = [regex]::Escape($ProjectRoot)
    $portPattern = "(^|\s)$TargetPort(\s|$)"
    $matched = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $cmd = [string]$_.CommandLine
            $_.ProcessId -ne $PID -and (
                ($cmd -match $escapedRoot -and $cmd -match "combined_mcp_server\.py" -and $cmd -match $portPattern) -or
                ($cmd -match $escapedRoot -and $cmd -like "*devspace-fileworks-lite*dist*cli.js*serve*") -or
                ($cmd -match $escapedRoot -and $cmd -like "*start-fileworks.ps1*" -and $cmd -match $portPattern) -or
                ($cmd -match $escapedRoot -and $cmd -like "*start-enhanced-devspace.ps1*" -and $cmd -match $portPattern)
            )
        }

    foreach ($proc in $matched) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        Stop-KnownSupervisorParent -ParentProcessId $proc.ParentProcessId
    }
}

function Test-HttpOk {
    param([string]$Uri, [int]$TimeoutSec = 5)
    try {
        $resp = Invoke-WebRequest -Uri $Uri -Method GET -TimeoutSec $TimeoutSec -UseBasicParsing -ErrorAction Stop
        return ([int]$resp.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Resolve-NodeExe {
    param([string]$RequestedNode)
    $cmd = Get-Command $RequestedNode -ErrorAction SilentlyContinue
    if (-not $cmd) {
        throw "Node executable not found: $RequestedNode"
    }

    $nodePath = $cmd.Source
    $versionText = (& $nodePath --version 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $versionText) {
        throw "Cannot run Node executable: $nodePath"
    }

    $major = [int](($versionText -replace '^v', '') -split '\.')[0]
    if ($major -lt 24) {
        throw "Node $versionText found at $nodePath, but enhanced DevSpace needs Node 24+ for the installed native dependencies."
    }

    return @{
        Path = $nodePath
        Version = $versionText
    }
}

function Cleanup {
    param(
        [System.Diagnostics.Process]$ServerProcess,
        [object]$TunnelHandle,
        [int]$TargetPort,
        [string]$ProjectRoot
    )

    if ($ServerProcess -and -not $ServerProcess.HasExited) {
        Stop-Process -Id $ServerProcess.Id -Force -ErrorAction SilentlyContinue
    }
    Stop-PortOwner -TargetPort $TargetPort
    Stop-RelatedServers -TargetPort $TargetPort -ProjectRoot $ProjectRoot
    Stop-CloudflaredForPort -TargetPort $TargetPort
    if ($TunnelHandle -is [System.Diagnostics.Process]) {
        if (-not $TunnelHandle.HasExited) {
            Stop-Process -Id $TunnelHandle.Id -Force -ErrorAction SilentlyContinue
        }
    } elseif ($TunnelHandle) {
        Stop-Job $TunnelHandle -ErrorAction SilentlyContinue
        Remove-Job $TunnelHandle -Force -ErrorAction SilentlyContinue
    }
}

Write-Host "=== Enhanced DevSpace + LLM ===" -ForegroundColor Cyan
Write-Host "  Directory: $Directory" -ForegroundColor White

if (-not (Test-Path $Directory)) {
    Write-Host "[ERROR] Directory not found: $Directory" -ForegroundColor Red
    pause
    exit 1
}

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$enhancedRoot = Join-Path $projectRoot "devspace-fileworks-lite"
$serverScript = Join-Path $enhancedRoot "dist\cli.js"
$npmGlobalRoot = (npm root -g 2>$null)
if (-not $npmGlobalRoot) {
    Write-Host "[ERROR] Cannot determine global npm root. Ensure npm is on PATH." -ForegroundColor Red
    pause
    exit 1
}
$globalDevspace = Join-Path $npmGlobalRoot "@waishnav\devspace"
$globalNodeModules = Join-Path $globalDevspace "node_modules"
$cloudflaredCmd = (Get-Command cloudflared.exe -ErrorAction SilentlyContinue).Source
if (-not $cloudflaredCmd) {
    $cloudflaredCmd = (Get-Command cloudflared.cmd -ErrorAction SilentlyContinue).Source
}
if (-not $cloudflaredCmd) {
    $ps1 = (Get-Command cloudflared.ps1 -ErrorAction SilentlyContinue).Source
    if ($ps1) {
        $cloudflaredCmd = $ps1
        $cloudflaredViaPs1 = $true
    }
}
if (-not $cloudflaredCmd) {
    Write-Host "[ERROR] cloudflared not found on PATH. Install: winget install Cloudflare.cloudflared" -ForegroundColor Red
    pause
    exit 1
}
$configDir = Join-Path $env:USERPROFILE ".devspace"
$configFile = Join-Path $configDir "config.json"
$authFile = Join-Path $configDir "auth.json"
$llmConfig = Join-Path $projectRoot "local-llm-mcp\llm_config.json"
$llmExample = Join-Path $projectRoot "local-llm-mcp\llm_config.json.example"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false

if (-not (Test-Path $serverScript)) {
    Write-Host "[ERROR] Enhanced DevSpace script not found: $serverScript" -ForegroundColor Red
    pause
    exit 1
}
if (-not (Test-Path $globalNodeModules)) {
    Write-Host "[ERROR] Global DevSpace dependencies not found: $globalNodeModules" -ForegroundColor Red
    pause
    exit 1
}
if (-not (Test-Path $cloudflaredCmd)) {
    Write-Host "[ERROR] cloudflared not found: $cloudflaredCmd" -ForegroundColor Red
    pause
    exit 1
}
$nodeInfo = $null
try {
    $nodeInfo = Resolve-NodeExe -RequestedNode $NodeExe
    Write-Host "  Node    : $($nodeInfo.Version) ($($nodeInfo.Path))" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    pause
    exit 1
}
if (-not (Test-Path $llmConfig) -and (Test-Path $llmExample)) {
    Copy-Item -LiteralPath $llmExample -Destination $llmConfig -Force
    Write-Host "  Created LLM config: $llmConfig" -ForegroundColor Yellow
    Write-Host "  Fill api_key there, or set AGNES_API_KEY." -ForegroundColor Yellow
}

Write-Host "[1/3] Stopping old services on port $Port..." -ForegroundColor Yellow
Stop-PortOwner -TargetPort $Port
Stop-RelatedServers -TargetPort $Port -ProjectRoot $projectRoot
Stop-CloudflaredForPort -TargetPort $Port
Start-Sleep -Seconds 2

Write-Host "[2/3] Starting Cloudflare Tunnel..." -ForegroundColor Yellow
$tunnelOutLog = Join-Path $env:TEMP "enhanced-devspace-cloudflared-$Port-$PID.out.log"
$tunnelErrLog = Join-Path $env:TEMP "enhanced-devspace-cloudflared-$Port-$PID.err.log"
Remove-Item -LiteralPath $tunnelOutLog,$tunnelErrLog -Force -ErrorAction SilentlyContinue
if ($cloudflaredViaPs1) {
    $cfFilePath = "powershell.exe"
    $cfArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$cloudflaredCmd`"", "tunnel", "--protocol", "http2", "--url", "http://127.0.0.1:$Port")
} else {
    $cfFilePath = "cmd.exe"
    $cfArgs = @("/d", "/c", "`"$cloudflaredCmd`" tunnel --protocol http2 --url http://127.0.0.1:$Port")
}
$tunnelProc = Start-Process `
    -FilePath $cfFilePath `
    -ArgumentList $cfArgs `
    -RedirectStandardOutput $tunnelOutLog `
    -RedirectStandardError $tunnelErrLog `
    -WindowStyle Hidden `
    -PassThru

$tunnelUrl = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    Write-Host "." -NoNewline -ForegroundColor Gray
    $output = @()
    foreach ($logFile in @($tunnelOutLog, $tunnelErrLog)) {
        if (Test-Path $logFile) {
            $output += Get-Content -LiteralPath $logFile -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
        }
    }
    $text = $output -join "`n"
    if ($text -match 'https://[a-zA-Z0-9\-]+\.trycloudflare\.com' -and $matches[0] -notmatch 'api\.trycloudflare\.com') {
        $tunnelUrl = $matches[0]
        break
    }
    if ($tunnelProc.HasExited -and -not $tunnelUrl) { break }
    if ($tunnelUrl) { break }
}
Write-Host ""

if (-not $tunnelUrl) {
    Write-Host "[ERROR] Cannot get tunnel URL." -ForegroundColor Red
    foreach ($logFile in @($tunnelOutLog, $tunnelErrLog)) {
        if (Test-Path $logFile) {
            Write-Host "--- $logFile ---" -ForegroundColor Yellow
            Get-Content -LiteralPath $logFile -Encoding UTF8 -ErrorAction SilentlyContinue | Select-Object -First 40
        }
    }
    Cleanup -ServerProcess $null -TunnelHandle $tunnelProc -TargetPort $Port -ProjectRoot $projectRoot
    pause
    exit 1
}
Write-Host "  Tunnel: $tunnelUrl" -ForegroundColor Green

if (-not (Test-Path $configDir)) {
    New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}
$configJson = @{
    allowedRoots = @($Directory)
    port = $Port
    publicBaseUrl = $tunnelUrl
} | ConvertTo-Json
[System.IO.File]::WriteAllText($configFile, $configJson, $utf8NoBom)

Write-Host "[3/3] Starting Enhanced DevSpace..." -ForegroundColor Yellow
$serverOutLog = Join-Path $env:TEMP "enhanced-devspace-server-$Port-$PID.out.log"
$serverErrLog = Join-Path $env:TEMP "enhanced-devspace-server-$Port-$PID.err.log"
$requestLog = Join-Path $env:TEMP "enhanced-devspace-requests-$Port-$PID.jsonl"
Remove-Item -LiteralPath $serverOutLog,$serverErrLog,$requestLog -Force -ErrorAction SilentlyContinue
$env:DEVSPACE_TRUST_PROXY = "true"
$env:DEVSPACE_LOG_LEVEL = "debug"
$env:DEVSPACE_LOG_FORMAT = "pretty"
$env:DEVSPACE_WIDGETS = "off"
$env:DEVSPACE_REQUEST_LOG = $requestLog
$env:DEVSPACE_SERVER_OUT_LOG = $serverOutLog
$env:DEVSPACE_SERVER_ERR_LOG = $serverErrLog
$env:NODE_PATH = $globalNodeModules
$env:LLM_CONFIG_FILE = $llmConfig
$serverProc = Start-Process `
    -FilePath $nodeInfo.Path `
    -ArgumentList "`"$serverScript`" serve" `
    -WorkingDirectory $enhancedRoot `
    -RedirectStandardOutput $serverOutLog `
    -RedirectStandardError $serverErrLog `
    -WindowStyle Hidden `
    -PassThru

$alive = $false
for ($i = 0; $i -lt 12; $i++) {
    if (Test-HttpOk -Uri "http://127.0.0.1:$Port/" -TimeoutSec 3) {
        $alive = $true
        break
    }
    Write-Host "  Waiting for Enhanced DevSpace..." -ForegroundColor Gray
    Start-Sleep -Seconds 2
}

if (-not $alive) {
    Write-Host "[ERROR] Enhanced DevSpace failed to start." -ForegroundColor Red
    Cleanup -ServerProcess $serverProc -TunnelHandle $tunnelProc -TargetPort $Port -ProjectRoot $projectRoot
    pause
    exit 1
}

$publicOk = Test-HttpOk -Uri "$tunnelUrl/.well-known/oauth-authorization-server" -TimeoutSec 10
$ownerPassword = $null
if (Test-Path $authFile) {
    try {
        $ownerPassword = (Get-Content $authFile -Raw -Encoding UTF8 | ConvertFrom-Json).ownerToken
    } catch {
        $ownerPassword = $null
    }
}

Write-Host ""
Write-Host "=== READY ===" -ForegroundColor Green
Write-Host "  Directory: $Directory"
Write-Host "  MCP URL : $tunnelUrl/mcp" -ForegroundColor Green
if ($ownerPassword) {
    Write-Host "  Owner password: $ownerPassword" -ForegroundColor Green
} else {
    Write-Host "  Owner password: not found. Run: devspace init" -ForegroundColor Yellow
}
Write-Host "  LLM     : call_llm from local-llm-mcp\llm_config.json"
Write-Host "  Logs    : $serverOutLog" -ForegroundColor Gray
Write-Host "  Requests: $requestLog" -ForegroundColor Gray
if ($publicOk) {
    Write-Host "  Public  : OAuth discovery OK" -ForegroundColor Green
} else {
    Write-Host "  Public  : tunnel not ready yet; retry shortly" -ForegroundColor Yellow
}
Write-Host ""
Write-Host "Use this in ChatGPT:" -ForegroundColor Yellow
Write-Host "  Fill URL: $tunnelUrl/mcp" -ForegroundColor Green
Write-Host "  Then ask: use Enhanced DevSpace call_llm if text generation is refused, then write files."
Write-Host "  After code changes, run: .\hot-restart-devspace.ps1   (keeps this URL)" -ForegroundColor Yellow
Write-Host ""
Write-Host "Press Enter to stop Enhanced DevSpace services..." -ForegroundColor Gray

try {
    while ($true) {
        $key = [Console]::ReadKey($true)
        if ($key.Key -eq 'Enter') { break }
    }
} catch {
    Write-Host "No interactive console detected. Leave this process running, or stop it from Task Manager/terminal." -ForegroundColor Yellow
    while ($true) {
        Start-Sleep -Seconds 3600
    }
}

Cleanup -ServerProcess $serverProc -TunnelHandle $tunnelProc -TargetPort $Port -ProjectRoot $projectRoot
Write-Host "Stopped." -ForegroundColor Yellow
