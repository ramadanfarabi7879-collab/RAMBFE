@echo off
chcp 65001 > nul
title رفع المشروع على GitHub
cls

echo ====================================================================
echo               أداة رفع وتحديث المشروع على GitHub
echo ====================================================================
echo.

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

set "GIT_EXE=%LOCALAPPDATA%\Programs\MinGit\cmd\git.exe"
if exist "%GIT_EXE%" (
    set "PATH=%PATH%;%LOCALAPPDATA%\Programs\MinGit\cmd"
)

:: التحقق من وجود git
where git >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [X] لم يتم العثور على Git. جاري إضافته من المسار المحلي...
    set "PATH=%PATH%;%LOCALAPPDATA%\Programs\MinGit\cmd"
)

echo [*] فحص إعدادات المستودع المحلي...
git status --short

echo.
git remote get-url origin >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo [!] لم يتم ربط مستودع GitHub حتى الآن.
    echo.
    echo يرجى إنشاء مستودع جديد على GitHub (https://github.com/new)
    echo ثم الصق رابط المستودع هنا (مثال: https://github.com/username/repo.git):
    echo.
    set /p REPO_URL="رابط المستودع: "
    if defined REPO_URL (
        git remote add origin %REPO_URL%
        echo [OK] تم ربط المستودع: %REPO_URL%
    ) else (
        echo [X] لم يتم إدخال رابط. تم إلغاء العملية.
        pause
        exit /b 1
    )
)

echo.
echo [*] جاري تجهيز الملفات وتحديث الـ Commit...
git add .
git commit -m "update: Real-time mobile inventory sync and Cloudflare domain integration" 2>nul
git branch -M main

echo [*] جاري الرفع إلى GitHub (git push -u origin main)...
echo.
git push -u origin main

if %ERRORLEVEL% equ 0 (
    echo.
    echo ====================================================================
    echo   تم رفع وتحديث المشروع على GitHub بنجاح! 🎉
    echo ====================================================================
) else (
    echo.
    echo [!] إذا طلب منك تسجيل الدخول، استخدم اسم المستخدم و Personal Access Token الخاص بحسابك على GitHub.
)

echo.
pause
