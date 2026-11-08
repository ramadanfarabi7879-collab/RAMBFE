#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
تشغيل البرنامج مع نفق Cloudflare للربط المباشر مع الموبايل، مع مراقبة وإعادة تشغيل تلقائية 24/7.
Starts the app (server + Cloudflare tunnel) and automatically restarts it if it crashes.

- السيرفر والنفق يُداران من run.py (نفق واحد فقط يقرأ مخرجاته باستمرار ويعيد التشغيل تلقائياً).
- هذا السكربت يراقب العملية ويعيد تشغيلها فوراً إذا توقفت بشكل غير متوقع.
"""

import os
import sys
import time
import socket
import subprocess
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
os.chdir(BASE_DIR)
TEMP_DIR = BASE_DIR / "temp"
TEMP_DIR.mkdir(parents=True, exist_ok=True)


def disable_windows_quick_edit():
    if os.name != "nt":
        return
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-10)
        mode = ctypes.c_uint32()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            ENABLE_QUICK_EDIT_MODE = 0x0040
            ENABLE_EXTENDED_FLAGS = 0x0080
            new_mode = (mode.value & ~ENABLE_QUICK_EDIT_MODE) | ENABLE_EXTENDED_FLAGS
            kernel32.SetConsoleMode(handle, new_mode)
    except Exception:
        pass


def prevent_windows_sleep():
    if os.name != "nt":
        return
    try:
        import ctypes
        ES_CONTINUOUS = 0x80000000
        ES_SYSTEM_REQUIRED = 0x00000001
        ES_AWAYMODE_REQUIRED = 0x00000040
        res = ctypes.windll.kernel32.SetThreadExecutionState(
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
        )
        if not res:
            ctypes.windll.kernel32.SetThreadExecutionState(
                ES_CONTINUOUS | ES_SYSTEM_REQUIRED
            )
    except Exception:
        pass


def is_port_open(port=8000) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0


def main():
    disable_windows_quick_edit()
    prevent_windows_sleep()
    try:
        if hasattr(sys.stdout, 'reconfigure'):
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        if hasattr(sys.stderr, 'reconfigure'):
            sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

    port = 8000
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])

    print("=" * 65, flush=True)
    print(" 🚀 جاري إطلاق نظام الجرد الذكي ونفق Cloudflare للمزامنة اللحظية (24/7)", flush=True)
    print("=" * 65, flush=True)

    if is_port_open(port):
        print(f"[*] البرنامج يعمل بالفعل على المنفذ {port}: http://127.0.0.1:{port}", flush=True)
        try:
            import webbrowser
            webbrowser.open(f"http://127.0.0.1:{port}")
        except Exception:
            pass
        return 0

    restarts = 0
    first_run = True
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"

    while True:
        if not first_run:
            # لا نفتح المتصفح مرة أخرى عند إعادة التشغيل التلقائي
            env["RAMBFE_NO_BROWSER"] = "1"
        started_at = time.time()
        proc = subprocess.Popen([sys.executable, "run.py", str(port)], cwd=str(BASE_DIR), env=env)
        first_run = False
        try:
            code = proc.wait()
        except KeyboardInterrupt:
            print("\n[!] جاري إيقاف البرنامج ونفق Cloudflare...", flush=True)
            try:
                proc.terminate()
                proc.wait(timeout=10)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass
            return 0

        if code == 0:
            return 0

        # إذا كان يتعطل فور التشغيل مراراً فهناك مشكلة إعداد (مثل مكتبات ناقصة)
        if time.time() - started_at < 10:
            restarts += 1
        else:
            restarts = 0
        if restarts >= 5:
            print("[X] البرنامج يتوقف فور تشغيله بشكل متكرر. راجع رسالة الخطأ بالأعلى.", flush=True)
            return code or 1

        wait = min(3 * (restarts + 1), 15)
        print(f"\n[!] توقف البرنامج بشكل غير متوقع (كود {code}). إعادة التشغيل تلقائياً خلال {wait} ثوانٍ...\n", flush=True)
        time.sleep(wait)


if __name__ == '__main__':
    sys.exit(main())
