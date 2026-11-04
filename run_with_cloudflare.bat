@echo off
setlocal
title Invoice Matcher - Cloudflare Sync
cd /d "%~dp0"

python scripts\start_cloudflare_tunnel.py 8000

if errorlevel 1 (
    echo.
    echo Script ended with code %ERRORLEVEL%.
    pause
)
