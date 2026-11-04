@echo off
chcp 65001 > nul
title تشغيل برنامج الجرد ومطابقة الفواتير مع دومين Cloudflare والمزامنة اللحظية
cls

echo ====================================================================
echo  نظام مطابقة الفواتير والجرد السحابي اللحظي عبر دومين Cloudflare
echo ====================================================================
echo.

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

:: التأكد من مسار أداة Cloudflare
set "CF_EXE=%LOCALAPPDATA%\Programs\Cloudflare\cloudflared.exe"
if exist "%CF_EXE%" (
    set "PATH=%PATH%;%LOCALAPPDATA%\Programs\Cloudflare"
)

:: التأكد من مسار Git
set "GIT_EXE=%LOCALAPPDATA%\Programs\MinGit\cmd\git.exe"
if exist "%GIT_EXE%" (
    set "PATH=%PATH%;%LOCALAPPDATA%\Programs\MinGit\cmd"
)

echo [*] جاري تشغيل التطبيق وتوليد دومين Cloudflare الآمن المشفر...
echo.

python "%SCRIPT_DIR%scripts\start_cloudflare_tunnel.py" 8000

pause
