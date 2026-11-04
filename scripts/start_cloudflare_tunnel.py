#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
تشغيل نفق Cloudflare Tunnel للربط المباشر مع الموبايل والمزامنة السحابية اللحظية
Starts Cloudflare Tunnel for instant real-time sync with mobile over Cloudflare domain
"""

import os
import sys
import re
import time
import socket
import subprocess
import webbrowser
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
os.chdir(BASE_DIR)
TEMP_DIR = BASE_DIR / "temp"
TEMP_DIR.mkdir(parents=True, exist_ok=True)
CF_URL_FILE = TEMP_DIR / "cloudflare_url.txt"

def find_cloudflared() -> str:
    # 1. Check in LOCALAPPDATA
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        Path(local_app_data) / "Programs" / "Cloudflare" / "cloudflared.exe",
        Path("C:/Program Files/Cloudflare/cloudflared.exe"),
        Path("C:/Program Files (x86)/Cloudflare/cloudflared.exe"),
    ]
    for c in candidates:
        if c.is_file():
            return str(c)

    # 2. Check in PATH
    import shutil
    found = shutil.which("cloudflared")
    if found:
        return found
    return ""

def is_port_open(port=8000) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0

def main():
    try:
        if hasattr(sys.stdout, 'reconfigure'):
            sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        if hasattr(sys.stderr, 'reconfigure'):
            sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

    print("=" * 65)
    print(" 🚀 جاري إطلاق نظام الجرد الذكي ونفق Cloudflare للمزامنة اللحظية")
    print("=" * 65)

    cf_exe = find_cloudflared()
    if not cf_exe:
        print("❌ لم يتم العثور على أداة cloudflared.exe في مسار النظام!")
        print("يرجى التأكد من تثبيت cloudflared.")
        sys.exit(1)

    port = 8000
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])

    # 1. التأكد من تشغيل السيرفر المحلي
    server_process = None
    if not is_port_open(port):
        print(f"[*] جاري تشغيل سيرفر التطبيق على المنفذ {port}...")
        server_process = subprocess.Popen(
            [sys.executable, "run.py", str(port)],
            cwd=str(BASE_DIR)
        )
        time.sleep(1.5)

    # 2. تشغيل نفق Cloudflare Tunnel
    print(f"[*] جاري إنشاء نفق Cloudflare آمن ومشفر للمنفذ {port}...")
    cf_cmd = [cf_exe, "tunnel", "--url", f"http://127.0.0.1:{port}"]

    cf_proc = subprocess.Popen(
        cf_cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding='utf-8',
        errors='replace'
    )

    tunnel_url = ""
    start_time = time.time()
    url_regex = re.compile(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com')

    # قراءة مخرجات cloudflared حتى ظهور الرابط
    while time.time() - start_time < 30:
        line = cf_proc.stderr.readline()
        if not line:
            if cf_proc.poll() is not None:
                break
            time.sleep(0.1)
            continue

        match = url_regex.search(line)
        if match:
            tunnel_url = match.group(0).rstrip('/')
            break

    if not tunnel_url:
        print("⚠️ لم نتمكن من التقاط رابط trycloudflare تلقائياً. تأكد من اتصال الإنترنت.")
    else:
        # حفظ الرابط في ملف temp لتقرأه واجهة التطبيق
        with open(CF_URL_FILE, "w", encoding="utf-8") as f:
            f.write(tunnel_url)

        mobile_url = f"{tunnel_url}/mobile"
        print("\n" + "★" * 65)
        print(" 🎉 تم تفعيل دومين Cloudflare بنجاح! الرابط جاهز للعمل من أي مكان:")
        print(f" 🌐 رابط الموبايل (الجرد السحابي):  {mobile_url}")
        print(f" 💻 رابط الكمبيوتر (لوحة التحكم):   {tunnel_url}")
        print("★" * 65 + "\n")
        print("📱 يمكنك الآن فتح هذا الرابط من أي موبايل عبر 4G/5G أو واي فاي.")
        print("⚡ أي عملية جرد أو مسح على الموبايل ستسمع فوراً على الكمبيوتر في نفس اللحظة!")
        print("\n[اضغط Ctrl+C لإيقاف النفق والسيرفر]")

        # فتح رابط الكمبيوتر للمستخدم
        try:
            webbrowser.open(f"http://127.0.0.1:{port}")
        except Exception:
            pass

    try:
        while True:
            time.sleep(1)
            if cf_proc.poll() is not None:
                print("Cloudflare process ended.")
                break
    except KeyboardInterrupt:
        print("\n[!] جاري إغلاق نفق Cloudflare والسيرفر...")
    finally:
        try:
            cf_proc.terminate()
        except Exception:
            pass
        if server_process:
            try:
                server_process.terminate()
            except Exception:
                pass
        if CF_URL_FILE.exists():
            try:
                CF_URL_FILE.unlink()
            except Exception:
                pass

if __name__ == '__main__':
    main()
