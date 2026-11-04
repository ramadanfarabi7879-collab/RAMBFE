@echo off
setlocal
title GitHub Uploader
cd /d "%~dp0"

python scripts\push_to_github.py

if errorlevel 1 (
    echo.
    echo Script ended with code %ERRORLEVEL%.
    pause
)
