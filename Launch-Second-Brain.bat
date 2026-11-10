@echo off
chcp 65001 >nul
title Second Brain - Desktop Command Center
echo ====================================================================
echo   Second Brain ^& Family Emergency Vault System
echo   Starting Local Desktop Server on http://localhost:4777 ...
echo ====================================================================
cd /d "D:\Second Brain\Second-Brain-System"
start "" "http://localhost:4777"
node src/features/dashboard-app/desktop-server.ts
pause
