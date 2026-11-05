import os
import re
import sys
import time
import atexit
import shutil
import threading
import subprocess
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
TEMP_DIR = BASE_DIR / "temp"
TEMP_DIR.mkdir(parents=True, exist_ok=True)
CF_URL_FILE = TEMP_DIR / "cloudflare_url.txt"

_cf_process = None
_active_tunnel_url = ""

def find_cloudflared() -> str:
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    candidates = [
        Path(local_app_data) / "Programs" / "Cloudflare" / "cloudflared.exe",
        Path("C:/Program Files/Cloudflare/cloudflared.exe"),
        Path("C:/Program Files (x86)/Cloudflare/cloudflared.exe"),
    ]
    for c in candidates:
        if c.is_file():
            return str(c)
    found = shutil.which("cloudflared")
    if found:
        return found
    return ""

def _cleanup():
    global _cf_process
    if _cf_process:
        try:
            _cf_process.terminate()
            _cf_process.poll()
        except Exception:
            pass
        _cf_process = None
    if CF_URL_FILE.exists():
        try:
            CF_URL_FILE.unlink()
        except Exception:
            pass

atexit.register(_cleanup)

def _tunnel_worker(port: int):
    global _cf_process, _active_tunnel_url
    cf_exe = find_cloudflared()
    if not cf_exe:
        print("[!] لم يتم العثور على أداة cloudflared.exe - سيعمل البرنامج محلياً فقط.")
        return

    # حذف أي رابط قديم فوراً لمنع الأخطاء في الموبايل
    if CF_URL_FILE.exists():
        try:
            CF_URL_FILE.unlink()
        except Exception:
            pass

    cmd = [cf_exe, "tunnel", "--url", f"http://127.0.0.1:{port}"]
    try:
        _cf_process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding='utf-8',
            errors='replace'
        )
    except Exception as e:
        print(f"[!] تعذر تشغيل Cloudflare Tunnel: {e}")
        return

    url_regex = re.compile(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com')
    start_time = time.time()

    while time.time() - start_time < 35:
        if _cf_process.poll() is not None:
            break
        line = _cf_process.stderr.readline()
        if not line:
            time.sleep(0.1)
            continue
        m = url_regex.search(line)
        if m:
            _active_tunnel_url = m.group(0).rstrip('/')
            with open(CF_URL_FILE, "w", encoding="utf-8") as f:
                f.write(_active_tunnel_url)

            print("\n" + "=" * 68)
            print(" 🚀 تم تفعيل نفق Cloudflare الحقيقي بنجاح للمزامنة اللحظية!")
            print(f" 🌐 رابط الموبايل السحابي الفوري: {_active_tunnel_url}")
            print(f" 📱 أو افتح كشف الجرد السريع:     {_active_tunnel_url}/mobile")
            print("=" * 68)
            print("⚡ جميع الأصناف وجداول الجرد والمسح متزامنة لحظياً بين الموبايل والكمبيوتر!\n")

            # تسجيل النفق في Cloudflare Worker الرئيسي
            try:
                import urllib.request
                import json
                reg_url = "https://rambfe.quran-halaqat.workers.dev/api/tunnel/register"
                payload = json.dumps({"tunnel_url": _active_tunnel_url}).encode('utf-8')
                req = urllib.request.Request(reg_url, data=payload, headers={'Content-Type': 'application/json', 'User-Agent': 'RAMBFE/1.0'})
                urllib.request.urlopen(req, timeout=5)
            except Exception:
                pass
            break

    # المراقبة المستمرة للنفق
    heartbeat = 0
    while _cf_process and _cf_process.poll() is None:
        time.sleep(2)
        heartbeat += 2
        if heartbeat >= 30 and _active_tunnel_url:
            heartbeat = 0
            try:
                import urllib.request
                import json
                reg_url = "https://rambfe.quran-halaqat.workers.dev/api/tunnel/register"
                payload = json.dumps({"tunnel_url": _active_tunnel_url}).encode('utf-8')
                req = urllib.request.Request(reg_url, data=payload, headers={'Content-Type': 'application/json'})
                urllib.request.urlopen(req, timeout=5)
            except Exception:
                pass

def start_tunnel_in_background(port: int = 8000):
    t = threading.Thread(target=_tunnel_worker, args=(port,), daemon=True)
    t.start()
    return t
