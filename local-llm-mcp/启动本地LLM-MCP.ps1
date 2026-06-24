param(
    [int]$Port = 7677,
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

Write-Host "=== Local LLM MCP Server ===" -ForegroundColor Cyan

$serverDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverScript = Join-Path $serverDir "local_llm_server.py"
$configFile = Join-Path $serverDir "llm_config.json"
$exampleFile = Join-Path $serverDir "llm_config.json.example"

if (-not (Test-Path $configFile) -and (Test-Path $exampleFile)) {
    Copy-Item -LiteralPath $exampleFile -Destination $configFile -Force
    Write-Host "  Created local LLM config: $configFile" -ForegroundColor Yellow
    Write-Host "  Fill api_key there, or set AGNES_API_KEY in your environment." -ForegroundColor Yellow
}

if (-not (Test-Path $PythonExe)) {
    $PythonExe = "python"
}

Write-Host "[1/3] Stopping old LLM MCP processes on port $Port..." -ForegroundColor Yellow
Stop-PortOwner -TargetPort $Port
Stop-CloudflaredForPort -TargetPort $Port
Start-Sleep -Seconds 2

$cloudflaredCmd = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cloudflaredCmd -or -not (Test-Path $cloudflaredCmd)) {
    Write-Host "[ERROR] cloudflared command not found. Make sure it is installed and on your PATH." -ForegroundColor Red
    pause
    exit 1
}

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

Write-Host "[3/3] Starting LLM MCP Server..." -ForegroundColor Yellow
$serverProc = Start-Process `
    -FilePath $PythonExe `
    -ArgumentList "`"$serverScript`" $Port" `
    -WorkingDirectory $serverDir `
    -PassThru

Start-Sleep -Seconds 5

Write-Host ""
Write-Host "=== READY ===" -ForegroundColor Green
Write-Host "  MCP URL: $tunnelUrl/sse" -ForegroundColor Green
Write-Host "  Config : $configFile"
Write-Host "  Tool   : call_llm"
Write-Host ""
Write-Host "Press Enter to stop LLM MCP services..." -ForegroundColor Gray

while ($true) {
    $key = [Console]::ReadKey($true)
    if ($key.Key -eq 'Enter') { break }
}

if ($serverProc -and -not $serverProc.HasExited) {
    Stop-Process -Id $serverProc.Id -Force -ErrorAction SilentlyContinue
}
Stop-Job $job -ErrorAction SilentlyContinue
Remove-Job $job -Force -ErrorAction SilentlyContinue
Write-Host "Stopped." -ForegroundColor Yellow
