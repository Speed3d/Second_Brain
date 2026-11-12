@echo off
chcp 65001 >nul
title Second Brain - Desktop Command Center
setlocal

rem ======================================================================
rem  Second Brain launcher
rem  - Works from any drive or USB stick (uses the folder of this file).
rem  - Opens the browser only after the server answers /api/health.
rem  - Closing this window stops the server.
rem ======================================================================

set "SB_ROOT=%~dp0"
cd /d "%SB_ROOT%Second-Brain-System" || (
  echo [ERROR] Folder "Second-Brain-System" was not found next to this file.
  pause
  exit /b 1
)

where node >nul 2>nul || (
  echo [ERROR] Node.js is not installed. Install Node.js 24 or newer from https://nodejs.org
  pause
  exit /b 1
)

echo ====================================================================
echo   Second Brain ^& Family Emergency Vault
echo   Starting the local server (this computer only) ...
echo ====================================================================

rem Open the browser in the background once the server is ready (port read from settings).
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$port = 4777;" ^
  "foreach ($f in @('config\settings.json','config\branding.json')) { try { $c = Get-Content $f -Raw -Encoding UTF8 | ConvertFrom-Json; if ($c.serverPort) { $port = [int]$c.serverPort; break } } catch {} };" ^
  "for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 ('http://127.0.0.1:' + $port + '/api/health') | Out-Null; Start-Process ('http://localhost:' + $port); exit 0 } catch { Start-Sleep -Milliseconds 500 } };" ^
  "Write-Host '[WARN] The server did not answer within 30 seconds.'"

node src/features/dashboard-app/desktop-server.ts
echo.
echo The server has stopped.
pause
