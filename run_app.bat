@echo off
chcp 65001 > nul
title نظام إدارة بطاقات الأصناف والمسح بكود QR

echo ========================================================
echo   نظام إدارة بطاقات الأصناف والمسح بكود QR وتصدير الإكسيل
echo ========================================================
echo.

:: 1. الانتقال إلى مجلد المشروع
set "PROJECT_DIR=%~dp0"
if not exist "%PROJECT_DIR%run.py" (
    set "PROJECT_DIR=C:\Users\PH\.gemini\antigravity\scratch\invoice-matcher-app\"
)

if not exist "%PROJECT_DIR%run.py" (
    echo [خطأ] تعذر العثور على مجلد المشروع!
    echo المسار المفحوص: %PROJECT_DIR%
    pause
    exit /b 1
)

cd /d "%PROJECT_DIR%"
echo [1/3] تم تحديد مجلد العمل: %CD%

:: 2. فحص وتحديد بيئة Python (الأولوية لـ .venv ثم بايثون 3.12 ثم المسار العام)
set "PY_CMD="

if exist "%PROJECT_DIR%.venv\Scripts\python.exe" (
    set "PY_CMD=%PROJECT_DIR%.venv\Scripts\python.exe"
    goto :PYTHON_FOUND
)

if exist "C:\Users\PH\AppData\Local\Programs\Python\Python312\python.exe" (
    set "PY_CMD=C:\Users\PH\AppData\Local\Programs\Python\Python312\python.exe"
    goto :PYTHON_FOUND
)

python --version > nul 2>&1
if %errorlevel% equ 0 (
    set "PY_CMD=python"
    goto :PYTHON_FOUND
)

py -3 --version > nul 2>&1
if %errorlevel% equ 0 (
    set "PY_CMD=py -3"
    goto :PYTHON_FOUND
)

echo [خطأ] لم يتم العثور على بيئة Python مثبتة في جهازك!
pause
exit /b 1

:PYTHON_FOUND
echo [2/3] تم العثور على Python: %PY_CMD%
echo [3/3] جاري بدء تشغيل الخادم وفتح الواجهة في المتصفح تلقائياً...
echo.
echo ===========================================================
echo   جاري إطلاق نظام الجرد الذكي ومزامنة Cloudflare مع الموبايل...
echo   الرابط المحلي: http://127.0.0.1:8000
echo   اترك هذه النافذة مفتوحة أثناء استخدامك للبرنامج.
echo ===========================================================
echo.

:: التأكد من وجود كل المكتبات المطلوبة وتثبيت الناقص تلقائياً (يمنع توقف البرنامج فور تشغيله)
%PY_CMD% -c "import pandas, openpyxl, pdfplumber, pypdf, rapidfuzz" > nul 2>&1
if %errorlevel% neq 0 (
    echo [*] Installing missing Python libraries from requirements.txt ...
    %PY_CMD% -m pip install -r requirements.txt
)

%PY_CMD% scripts\start_cloudflare_tunnel.py 8000

if %errorlevel% neq 0 (
    echo.
    echo [تنبيه] توقف البرنامج أو حدث خطأ.
)

pause
