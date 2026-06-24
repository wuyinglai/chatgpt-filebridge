param(
    [Parameter(Position=0, Mandatory=$true)]
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

if (-not (Test-Path $Directory)) {
    Write-Host "[ERROR] Directory not found: $Directory" -ForegroundColor Red
    pause
    exit 1
}

$devspaceCmd = (Get-Command devspace -ErrorAction SilentlyContinue).Source
if (-not $devspaceCmd -or -not (Test-Path $devspaceCmd)) {
    Write-Host "[ERROR] devspace command not found. Make sure it is installed and on your PATH." -ForegroundColor Red
    pause
    exit 1
}

$configFile = Join-Path $env:USERPROFILE ".devspace\config.json"
if (-not (Test-Path $configFile)) {
    Write-Host "[ERROR] DevSpace config not found. Run 启动DevSpace隧道.ps1 first." -ForegroundColor Red
    pause
    exit 1
}

$oldConfig = Get-Content $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$tunnelUrl = $oldConfig.publicBaseUrl
if (-not $tunnelUrl) {
    Write-Host "[ERROR] publicBaseUrl missing in $configFile." -ForegroundColor Red
    pause
    exit 1
}

Write-Host "Tunnel: $tunnelUrl"
Write-Host "Dir   : $Directory"

Stop-PortOwner -TargetPort $Port
Start-Sleep -Seconds 2

$configJson = @{
    allowedRoots = @($Directory)
    port = $Port
    publicBaseUrl = $tunnelUrl
} | ConvertTo-Json
[System.IO.File]::WriteAllText($configFile, $configJson, (New-Object System.Text.UTF8Encoding $false))

Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/k set DEVSPACE_TRUST_PROXY=true && `"$devspaceCmd`" serve"

Start-Sleep -Seconds 3
Write-Host "Done. MCP URL unchanged; no need to reconfigure ChatGPT." -ForegroundColor Green
