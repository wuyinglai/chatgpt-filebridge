param(
    [switch]$Watch,
    [int]$Tail = 80
)

$ErrorActionPreference = "Continue"
chcp 65001 >$null 2>$null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Test-Url {
    param([string]$Name, [string]$Uri, [string]$Method = "GET")
    try {
        $resp = Invoke-WebRequest -Uri $Uri -Method $Method -UseBasicParsing -TimeoutSec 12 -ErrorAction Stop
        [pscustomobject]@{
            Name = $Name
            Uri = $Uri
            Status = [int]$resp.StatusCode
            Ok = $true
            Note = ""
        }
    } catch {
        $status = $null
        if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
            $status = [int]$_.Exception.Response.StatusCode
        }
        [pscustomobject]@{
            Name = $Name
            Uri = $Uri
            Status = $status
            Ok = ($status -eq 401 -and $Name -eq "MCP no-token")
            Note = $_.Exception.Message
        }
    }
}

function Get-LatestRequestLog {
    Get-ChildItem $env:TEMP -Filter "enhanced-devspace-requests-7676-*.jsonl" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
}

function Read-RequestEvents {
    param([string]$Path, [int]$Count)
    if (-not $Path -or -not (Test-Path $Path)) {
        return @()
    }
    Get-Content -LiteralPath $Path -Tail $Count -Encoding UTF8 -ErrorAction SilentlyContinue |
        ForEach-Object {
            try { $_ | ConvertFrom-Json } catch { $null }
        } |
        Where-Object { $_ }
}

function Show-Diagnosis {
    Clear-Host
    Write-Host "=== Enhanced DevSpace Diagnostics ===" -ForegroundColor Cyan

    $configPath = Join-Path $env:USERPROFILE ".devspace\config.json"
    if (-not (Test-Path $configPath)) {
        Write-Host "[ERROR] Missing config: $configPath" -ForegroundColor Red
        return
    }

    $config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $baseUrl = [string]$config.publicBaseUrl
    $mcpUrl = "$baseUrl/mcp"
    Write-Host "Public : $baseUrl"
    Write-Host "MCP    : $mcpUrl" -ForegroundColor Green
    Write-Host "Roots  : $($config.allowedRoots -join ', ')"
    Write-Host ""

    $checks = @(
        Test-Url -Name "Local health" -Uri "http://127.0.0.1:7676/.well-known/oauth-authorization-server"
        Test-Url -Name "Public health" -Uri "$baseUrl/.well-known/oauth-authorization-server"
        Test-Url -Name "OAuth metadata" -Uri "$baseUrl/.well-known/oauth-authorization-server"
        Test-Url -Name "OIDC metadata" -Uri "$baseUrl/.well-known/openid-configuration"
        Test-Url -Name "Resource metadata" -Uri "$baseUrl/.well-known/oauth-protected-resource/mcp"
        Test-Url -Name "MCP no-token" -Uri $mcpUrl
    )
    $checks | Select-Object Name,Status,Ok,Note | Format-Table -AutoSize

    $log = Get-LatestRequestLog
    if (-not $log) {
        Write-Host "No request log found. Restart with the latest startup script." -ForegroundColor Yellow
        return
    }

    Write-Host ""
    Write-Host "Request log: $($log.FullName)" -ForegroundColor Gray
    Write-Host "Updated    : $($log.LastWriteTime)"

    $events = @(Read-RequestEvents -Path $log.FullName -Count $Tail)
    $mcpEvents = @($events | Where-Object { $_.path -eq "/mcp" -or $_.event })
    $chatEvents = @($events | Where-Object { $_.userAgent -like "*openai-mcp*" -or $_.mcpMethod })
    $errors = @($events | Where-Object { $_.status -ge 400 -or $_.event -like "*error*" })

    Write-Host ""
    Write-Host "Recent MCP requests:" -ForegroundColor Cyan
    if ($mcpEvents.Count -eq 0) {
        Write-Host "  No /mcp requests yet. ChatGPT may not have reached this server." -ForegroundColor Yellow
    } else {
        $mcpEvents |
            Select-Object -Last 20 |
            ForEach-Object {
                $label = $_.mcpMethod
                if (-not $label) { $label = $_.event }
                if (-not $label) { $label = $_.path }
                "{0} {1,-5} {2,-28} status={3,-4} auth={4} session={5} ua={6}" -f `
                    $_.ts, $_.method, $label, $_.status, $_.hasAuthorization, $_.hasMcpSession, $_.userAgent
            } |
            Write-Host
    }

    Write-Host ""
    Write-Host "Diagnosis:" -ForegroundColor Cyan
    $lastToolList = $chatEvents | Where-Object { $_.mcpMethod -eq "tools/list" -and $_.status -eq 200 } | Select-Object -Last 1
    $lastInit = $chatEvents | Where-Object { $_.mcpMethod -eq "initialize" -and $_.status -eq 200 } | Select-Object -Last 1
    $resourceRead = $chatEvents | Where-Object { $_.mcpMethod -eq "resources/read" } | Select-Object -Last 1
    $serverError = $errors | Where-Object { $_.status -ge 500 -or $_.event -like "*error*" } | Select-Object -Last 1

    if ($serverError) {
        Write-Host "  Server error: $($serverError.mcpMethod) status=$($serverError.status) $($serverError.error)" -ForegroundColor Red
    } elseif ($lastToolList) {
        Write-Host "  ChatGPT reached tools/list successfully: 200." -ForegroundColor Green
        if ($resourceRead) {
            Write-Host "  ChatGPT still read resources: $($resourceRead.mcpMethod) status=$($resourceRead.status). If stream error remains, make sure widgets are off and restart." -ForegroundColor Yellow
        } else {
            Write-Host "  No resources/read seen. Pure-tool mode looks healthy." -ForegroundColor Green
        }
    } elseif ($lastInit) {
        Write-Host "  initialize succeeded, but tools/list has not appeared yet. Click retry in ChatGPT, then run this again." -ForegroundColor Yellow
    } else {
        Write-Host "  No successful ChatGPT initialize yet. Confirm the ChatGPT URL is exactly: $mcpUrl" -ForegroundColor Yellow
    }
}

if ($Watch) {
    while ($true) {
        Show-Diagnosis
        Start-Sleep -Seconds 3
    }
} else {
    Show-Diagnosis
}
