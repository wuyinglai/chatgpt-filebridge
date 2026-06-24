param(
    [int]$Port = 7676,
    [string]$NodeExe = "node",
    [switch]$Watch
)

$ErrorActionPreference = "Continue"
chcp 65001 >$null 2>$null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$script:ProjectRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

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
        throw "Node $versionText found at $nodePath, but enhanced DevSpace needs Node 24+."
    }

    return @{
        Path = $nodePath
        Version = $versionText
    }
}

function Stop-EnhancedDevSpaceBackend {
    param([string]$ProjectRoot, [int]$TargetPort)

    $escapedRoot = [regex]::Escape($ProjectRoot)
    $listeners = @(Get-NetTCPConnection -LocalPort $TargetPort -State Listen -ErrorAction SilentlyContinue)
    $listenerPids = @($listeners | Where-Object { $_.OwningProcess } | Select-Object -ExpandProperty OwningProcess -Unique)

    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $cmd = [string]$_.CommandLine
            (
                ($cmd -match $escapedRoot -and $cmd -like "*devspace-fileworks-lite*dist*cli.js*serve*") -or
                ($listenerPids -contains $_.ProcessId -and $cmd -like "*node*")
            ) -and
            $cmd -notlike "*cloudflared*"
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
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

function Start-Backend {
    param(
        [string]$ProjectRoot,
        [int]$TargetPort,
        [string]$NodePath,
        [string]$GlobalNodeModules,
        [string]$LlmConfig
    )

    $enhancedRoot = Join-Path $ProjectRoot "devspace-fileworks-lite"
    $serverScript = Join-Path $enhancedRoot "dist\cli.js"
    if (-not (Test-Path $serverScript)) {
        throw "Enhanced DevSpace script not found: $serverScript"
    }

    $serverOutLog = Join-Path $env:TEMP "enhanced-devspace-server-$TargetPort-hot-$PID.out.log"
    $serverErrLog = Join-Path $env:TEMP "enhanced-devspace-server-$TargetPort-hot-$PID.err.log"
    $requestLog = Join-Path $env:TEMP "enhanced-devspace-requests-$TargetPort-hot-$PID.jsonl"
    Remove-Item -LiteralPath $serverOutLog,$serverErrLog,$requestLog -Force -ErrorAction SilentlyContinue

    $env:DEVSPACE_TRUST_PROXY = "true"
    $env:DEVSPACE_LOG_LEVEL = "debug"
    $env:DEVSPACE_LOG_FORMAT = "pretty"
    $env:DEVSPACE_WIDGETS = "off"
    $env:DEVSPACE_REQUEST_LOG = $requestLog
    $env:DEVSPACE_SERVER_OUT_LOG = $serverOutLog
    $env:DEVSPACE_SERVER_ERR_LOG = $serverErrLog
    $env:NODE_PATH = $GlobalNodeModules
    $env:LLM_CONFIG_FILE = $LlmConfig

    $proc = Start-Process `
        -FilePath $NodePath `
        -ArgumentList "`"$serverScript`" serve" `
        -WorkingDirectory $enhancedRoot `
        -RedirectStandardOutput $serverOutLog `
        -RedirectStandardError $serverErrLog `
        -WindowStyle Hidden `
        -PassThru

    return @{
        Process = $proc
        OutLog = $serverOutLog
        ErrLog = $serverErrLog
        RequestLog = $requestLog
    }
}

function Invoke-HotRestart {
    param([int]$TargetPort, [string]$RequestedNode)

    $projectRoot = $script:ProjectRoot
    $configFile = Join-Path $env:USERPROFILE ".devspace\config.json"
    $authFile = Join-Path $env:USERPROFILE ".devspace\auth.json"
    $npmGlobalRoot = (npm root -g 2>$null)
    $globalNodeModules = Join-Path (Join-Path $npmGlobalRoot "@waishnav\devspace") "node_modules"
    $llmConfig = Join-Path $projectRoot "local-llm-mcp\llm_config.json"

    if (-not (Test-Path $configFile)) {
        throw "Missing DevSpace config: $configFile. Run start-enhanced-devspace.ps1 first."
    }
    if (-not (Test-Path $globalNodeModules)) {
        throw "Global DevSpace dependencies not found: $globalNodeModules"
    }

    $config = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $publicBaseUrl = [string]$config.publicBaseUrl
    if (-not $publicBaseUrl) {
        throw "publicBaseUrl is missing in $configFile"
    }

    $nodeInfo = Resolve-NodeExe -RequestedNode $RequestedNode

    Write-Host "=== Hot Restart Enhanced DevSpace ===" -ForegroundColor Cyan
    Write-Host "  Public URL stays: $publicBaseUrl" -ForegroundColor Green
    Write-Host "  MCP URL         : $publicBaseUrl/mcp" -ForegroundColor Green
    Write-Host "  Node            : $($nodeInfo.Version) ($($nodeInfo.Path))" -ForegroundColor Green
    Write-Host "  Tunnel          : unchanged" -ForegroundColor Green

    Stop-EnhancedDevSpaceBackend -ProjectRoot $projectRoot -TargetPort $TargetPort
    Start-Sleep -Seconds 1

    $started = Start-Backend `
        -ProjectRoot $projectRoot `
        -TargetPort $TargetPort `
        -NodePath $nodeInfo.Path `
        -GlobalNodeModules $globalNodeModules `
        -LlmConfig $llmConfig

    $alive = $false
    for ($i = 0; $i -lt 15; $i++) {
        if (Test-HttpOk -Uri "http://127.0.0.1:$TargetPort/healthz" -TimeoutSec 3) {
            $alive = $true
            break
        }
        Start-Sleep -Seconds 1
    }

    if (-not $alive) {
        Write-Host "[ERROR] Backend failed to restart." -ForegroundColor Red
        Write-Host "  stderr: $($started.ErrLog)" -ForegroundColor Yellow
        if (Test-Path $started.ErrLog) {
            Get-Content $started.ErrLog -Tail 80 -Encoding UTF8
        }
        exit 1
    }

    $publicOk = Test-HttpOk -Uri "$publicBaseUrl/.well-known/oauth-authorization-server" -TimeoutSec 10
    $ownerPassword = $null
    if (Test-Path $authFile) {
        try {
            $ownerPassword = (Get-Content $authFile -Raw -Encoding UTF8 | ConvertFrom-Json).ownerToken
        } catch {}
    }

    Write-Host ""
    Write-Host "=== HOT READY ===" -ForegroundColor Green
    Write-Host "  MCP URL : $publicBaseUrl/mcp" -ForegroundColor Green
    if ($ownerPassword) {
        Write-Host "  Owner password: $ownerPassword" -ForegroundColor Green
    }
    Write-Host "  Requests: $($started.RequestLog)" -ForegroundColor Gray
    if ($publicOk) {
        Write-Host "  Public  : OAuth discovery OK" -ForegroundColor Green
    } else {
        Write-Host "  Public  : tunnel is not responding yet; retry shortly" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "ChatGPT side: do not reconnect. Just click Retry or send the prompt again." -ForegroundColor Yellow
}

if ($Watch) {
    $projectRoot = $script:ProjectRoot
    $watchPaths = @(
        (Join-Path $projectRoot "devspace-fileworks-lite\dist\server.js"),
        (Join-Path $projectRoot "devspace-fileworks-lite\dist\cli.js"),
        (Join-Path $projectRoot "start-enhanced-devspace.ps1")
    )
    $lastStamp = ""
    while ($true) {
        $stamp = ($watchPaths | Where-Object { Test-Path $_ } | ForEach-Object {
            "$_=$((Get-Item $_).LastWriteTimeUtc.Ticks)"
        }) -join "|"
        if ($stamp -ne $lastStamp) {
            if ($lastStamp) {
                Write-Host ""
                Write-Host "Change detected. Hot restarting..." -ForegroundColor Yellow
            }
            Invoke-HotRestart -TargetPort $Port -RequestedNode $NodeExe
            $lastStamp = $stamp
        }
        Start-Sleep -Seconds 2
    }
} else {
    Invoke-HotRestart -TargetPort $Port -RequestedNode $NodeExe
}
