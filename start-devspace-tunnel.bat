@echo off
chcp 65001 >nul
set "SCRIPT_DIR=%~dp0"

echo ============================================
echo   DevSpace + Cloudflare Tunnel
echo ============================================
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%start-devspace-tunnel.ps1" %*

pause
