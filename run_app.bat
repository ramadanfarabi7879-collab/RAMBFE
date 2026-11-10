@echo off
chcp 65001 > nul
title نظام إدارة بطاقات الأصناف والمسح بكود QR

echo ========================================================
echo   نظام إدارة بطاقات الأصناف والمسح بكود QR وتصدير الإكسيل
echo ========================================================
echo.

set "PROJECT_DIR=%~dp0"
if not exist "%PROJECT_DIR%run.py" (
    set "PROJECT_DIR=C:\Users\PH\.gemini\antigravity\scratch\invoice-matcher-app\"
)

if not exist "%PROJECT_DIR%run.py" (
    echo [خطأ] تعذر العثور على مجلد المشروع: %PROJECT_DIR%
    pause
    exit /b 1
)

cd /d "%PROJECT_DIR%"
echo [1/3] تم تحديد مجلد العمل: %CD%

set "PY_CMD="
if exist "%PROJECT_DIR%.venv\Scripts\python.exe" (
    set "PY_CMD=%PROJECT_DIR%.venv\Scripts\python.exe"
    goto :PYTHON_FOUND
)
if exist "C:\Users\PH\AppData\Local\Programs\Python\Python312\python.exe" (
    set "PY_CMD=C:\Users\PH\AppData\Local\Programs\Python\Python312\python.exe"
    goto :PYTHON_FOUND
)
set "PY_CMD=python"

:PYTHON_FOUND
echo [2/3] التأكد من المكتبات وتشغيل مراقب الخلفية الدائم 24/7...
"%PY_CMD%" -c "import pandas, openpyxl, pdfplumber, pypdf, rapidfuzz" > nul 2>&1
if %errorlevel% neq 0 (
    "%PY_CMD%" -m pip install -r requirements.txt
)

:: تشغيل الخادم عبر مراقب الخلفية المستقل (يبقى شغالاً حتى بعد إغلاق هذه النافذة)
start "" wscript.exe "%PROJECT_DIR%scripts\launch_hidden.vbs"

echo [3/3] انتظار جاهزية السيرفر وفتح المتصفح على http://127.0.0.1:8000 ...
"%PY_CMD%" -c "import time, urllib.request, webbrowser; [time.sleep(0.5) for _ in range(30) if not (lambda: (urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=1).status == 200))()]; webbrowser.open('http://127.0.0.1:8000')" 2>nul
if %errorlevel% neq 0 (
    timeout /t 3 /nobreak > nul
    start "" "http://127.0.0.1:8000"
)

echo.
echo ===========================================================
echo   الخادم يعمل الآن بشكل مستقل في الخلفية 24/7.
echo   يمكنك إغلاق هذه النافذة بأمان ولن يتوقف البرنامج.
echo ===========================================================
timeout /t 4 > nul
