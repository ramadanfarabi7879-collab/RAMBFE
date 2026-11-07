@echo off
setlocal
chcp 65001 > nul
title Invoice Matcher - Cloudflare Sync
cd /d "%~dp0"

set "PY_CMD=python"
if exist "%~dp0.venv\Scripts\python.exe" set "PY_CMD=%~dp0.venv\Scripts\python.exe"

%PY_CMD% -c "import pandas, openpyxl, pdfplumber, pypdf, rapidfuzz" > nul 2>&1
if errorlevel 1 (
    echo [*] Installing missing Python libraries from requirements.txt ...
    "%PY_CMD%" -m pip install -r requirements.txt
)

"%PY_CMD%" scripts\start_cloudflare_tunnel.py 8000

if errorlevel 1 (
    echo.
    echo Script ended with code %ERRORLEVEL%.
    pause
)
