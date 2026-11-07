import os
import re
import sys
import json
import time
import atexit
import shutil
import threading
import subprocess
import urllib.request
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
TEMP_DIR = BASE_DIR / "temp"
TEMP_DIR.mkdir(parents=True, exist_ok=True)
CF_URL_FILE = TEMP_DIR / "cloudflare_url.txt"
CF_LOG_FILE = TEMP_DIR / "cloudflared.log"

# رابط سيرفر Cloudflare Worker الذي يمرر طلبات الموبايل إلى نفق الكمبيوتر
WORKER_REGISTER_URL = os.environ.get(
    "RAMBFE_WORKER_REGISTER_URL",
    "https://rambfe.quran-halaqat.workers.dev/api/tunnel/register"
)
HEARTBEAT_SECONDS = 30
URL_REGEX = re.compile(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com')

_cf_process = None
_active_tunnel_url = ""
_stop_event = threading.Event()
_started = False
_start_lock = threading.Lock()


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


def get_active_tunnel_url() -> str:
    return _active_tunnel_url


def _safe_print(msg: str) -> None:
    try:
        print(msg, flush=True)
    except Exception:
        pass


def _remove_url_file() -> None:
    try:
        if CF_URL_FILE.exists():
            CF_URL_FILE.unlink()
    except Exception:
        pass


def _cleanup():
    global _cf_process
    _stop_event.set()
    if _cf_process:
        try:
            _cf_process.terminate()
            _cf_process.wait(timeout=5)
        except Exception:
            try:
                _cf_process.kill()
            except Exception:
                pass
        _cf_process = None
    _remove_url_file()


atexit.register(_cleanup)


def register_with_worker(tunnel_url: str) -> bool:
    """تسجيل رابط النفق الحالي في Cloudflare Worker حتى يمرر له طلبات الموبايل."""
    if not tunnel_url:
        return False
    try:
        payload = json.dumps({"tunnel_url": tunnel_url}).encode("utf-8")
        req = urllib.request.Request(
            WORKER_REGISTER_URL,
            data=payload,
            headers={"Content-Type": "application/json", "User-Agent": "RAMBFE-Bridge/2.0"}
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception:
        return False


def _drain_output(proc: subprocess.Popen, url_found: threading.Event) -> None:
    """
    قراءة مخرجات cloudflared باستمرار طوال عمر العملية.
    مهم جداً: إذا توقفنا عن القراءة يمتلئ الـ pipe وتتجمد عملية cloudflared
    فيتوقف النفق ويظهر البرنامج كأنه "وقف" على الموبايل.
    """
    global _active_tunnel_url
    try:
        with open(CF_LOG_FILE, "a", encoding="utf-8", errors="replace") as log:
            for line in iter(proc.stdout.readline, ""):
                if not line:
                    break
                try:
                    log.write(line)
                    log.flush()
                except Exception:
                    pass
                if not url_found.is_set():
                    m = URL_REGEX.search(line)
                    if m:
                        _active_tunnel_url = m.group(0).rstrip("/")
                        try:
                            CF_URL_FILE.write_text(_active_tunnel_url, encoding="utf-8")
                        except Exception:
                            pass
                        url_found.set()
    except Exception:
        pass


def _rotate_log() -> None:
    try:
        if CF_LOG_FILE.exists() and CF_LOG_FILE.stat().st_size > 2 * 1024 * 1024:
            backup = CF_LOG_FILE.with_suffix(".old.log")
            if backup.exists():
                backup.unlink()
            CF_LOG_FILE.rename(backup)
    except Exception:
        pass


def _print_banner(url: str) -> None:
    _safe_print("\n" + "=" * 68)
    _safe_print(" 🚀 تم تفعيل نفق Cloudflare الحقيقي بنجاح للمزامنة اللحظية!")
    _safe_print(f" 🌍 رابط الموبايل عبر النفق:      {url}")
    _safe_print(f" 📱 أو افتح كشف الجرد السريع:     {url}/mobile")
    _safe_print(" ☁️ رابط Cloudflare الثابت:        https://rambfe.quran-halaqat.workers.dev")
    _safe_print("=" * 68 + "\n")


def _tunnel_worker(port: int):
    """تشغيل النفق ومراقبته وإعادة تشغيله تلقائياً إذا توقف لأي سبب."""
    global _cf_process, _active_tunnel_url
    cf_exe = find_cloudflared()
    if not cf_exe:
        _safe_print("[!] لم يتم العثور على أداة cloudflared.exe - سيعمل البرنامج محلياً فقط.")
        return

    backoff = 5
    while not _stop_event.is_set():
        _remove_url_file()
        _active_tunnel_url = ""
        _rotate_log()

        cmd = [cf_exe, "tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"]
        creationflags = 0
        if os.name == "nt":
            creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        try:
            _cf_process = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
                creationflags=creationflags
            )
        except Exception as e:
            _safe_print(f"[!] تعذر تشغيل Cloudflare Tunnel: {e}")
            _stop_event.wait(backoff)
            backoff = min(backoff * 2, 120)
            continue

        url_found = threading.Event()
        threading.Thread(target=_drain_output, args=(_cf_process, url_found), daemon=True).start()

        if url_found.wait(timeout=45) and _active_tunnel_url:
            backoff = 5
            _print_banner(_active_tunnel_url)
            if register_with_worker(_active_tunnel_url):
                _safe_print(" [*] تم ربط النفق بسيرفر Cloudflare بنجاح.")
            else:
                _safe_print(" [!] تعذر ربط النفق بسيرفر Cloudflare الآن، ستتم إعادة المحاولة تلقائياً.")
        else:
            _safe_print("[!] لم يظهر رابط النفق خلال 45 ثانية، جاري إعادة المحاولة...")

        # المراقبة المستمرة + نبضات التسجيل الدورية في Worker
        last_beat = time.time()
        while not _stop_event.is_set() and _cf_process and _cf_process.poll() is None:
            _stop_event.wait(2)
            if _active_tunnel_url and time.time() - last_beat >= HEARTBEAT_SECONDS:
                last_beat = time.time()
                register_with_worker(_active_tunnel_url)

        if _stop_event.is_set():
            break

        # النفق توقف: إعادة تشغيل تلقائية
        try:
            if _cf_process and _cf_process.poll() is None:
                _cf_process.terminate()
        except Exception:
            pass
        _safe_print(f"[!] توقف نفق Cloudflare، ستتم إعادة تشغيله خلال {backoff} ثانية...")
        _stop_event.wait(backoff)
        backoff = min(backoff * 2, 120)


def start_tunnel_in_background(port: int = 8000):
    """تشغيل نفق واحد فقط لكل عملية (يمنع تشغيل نفقين متنافسين على نفس السيرفر)."""
    global _started
    if os.environ.get("RAMBFE_DISABLE_TUNNEL", "").strip() in ("1", "true", "yes"):
        return None
    with _start_lock:
        if _started:
            return None
        _started = True
    t = threading.Thread(target=_tunnel_worker, args=(port,), name="cloudflare-tunnel", daemon=True)
    t.start()
    return t
