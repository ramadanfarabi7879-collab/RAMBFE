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
WORKER_JS_FILE = BASE_DIR / "worker.js"

# رابط سيرفر Cloudflare Worker الذي يمرر طلبات الموبايل إلى نفق الكمبيوتر
WORKER_REGISTER_URL = os.environ.get(
    "RAMBFE_WORKER_REGISTER_URL",
    "https://rambfe.quran-halaqat.workers.dev/api/tunnel/register"
)
HEARTBEAT_SECONDS = 20
URL_REGEX = re.compile(r'https://[a-zA-Z0-9-]+\.trycloudflare\.com')

_cf_process = None
_active_tunnel_url = ""
_stop_event = threading.Event()
_started = False
_start_lock = threading.Lock()
_git_sync_lock = threading.Lock()


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
    try:
        from backend.db_safety import get_server_logger
        clean = msg.strip()
        if clean and not clean.startswith("="):
            get_server_logger().info(f"[Tunnel] {clean}")
    except Exception:
        pass


def _remove_url_file() -> None:
    try:
        if CF_URL_FILE.exists():
            CF_URL_FILE.unlink()
    except Exception:
        pass


CF_PID_FILE = TEMP_DIR / "cloudflared.pid"


def _kill_orphan_cloudflared() -> None:
    """إنهاء عملية cloudflared السابقة الخاصة بهذا البرنامج فقط (من ملف PID)، دون المساس بأي نفق آخر."""
    try:
        if not CF_PID_FILE.exists():
            return
        pid = int(CF_PID_FILE.read_text().strip() or "0")
        CF_PID_FILE.unlink()
        if pid <= 0:
            return
        if os.name == "nt":
            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                                 capture_output=True, text=True, timeout=5,
                                 creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)).stdout
            if "cloudflared" in out.lower():
                subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True, timeout=5,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        else:
            os.kill(pid, 15)
    except Exception:
        pass


def _read_setting(env_name: str, file_name: str) -> str:
    v = os.environ.get(env_name, "").strip()
    if v:
        return v
    try:
        f = BASE_DIR / "data" / file_name
        if f.is_file():
            return f.read_text(encoding="utf-8").strip()
    except Exception:
        pass
    return ""


def get_named_tunnel_config():
    """نفق دائم (Named Tunnel) برابط ثابت لا يتغير ولا تنتهي صلاحيته: token + الرابط العام."""
    token = _read_setting("RAMBFE_TUNNEL_TOKEN", "tunnel_token.txt")
    public_url = _read_setting("RAMBFE_PUBLIC_URL", "public_url.txt").rstrip("/")
    return token, public_url


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
            headers={
                "Content-Type": "application/json",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RAMBFE-Bridge/3.0"
            }
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status == 200
    except Exception:
        return False


def _check_tunnel_health(tunnel_url: str) -> bool:
    """فحص فعلي للتأكد من أن رابط النفق يعمل ويرد من السيرفر المحلي بدون خطأ 530/502."""
    if not tunnel_url:
        return False
    try:
        req = urllib.request.Request(
            f"{tunnel_url.rstrip('/')}/api/stats",
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RAMBFE-HealthCheck/3.0",
                "Accept": "application/json"
            }
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status != 200:
                return False
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
            return isinstance(data, dict) and "products_count" in data
    except Exception:
        return False


def _sync_tunnel_to_github_async(tunnel_url: str) -> None:
    """أُلغيت: الـ Worker يحفظ رابط النفق في Workers KV عبر /api/tunnel/register، لا حاجة لرفع commits."""
    return


def _drain_output(proc: subprocess.Popen, url_found: threading.Event, tunnel_dead: threading.Event) -> None:
    """
    قراءة مخرجات cloudflared باستمرار طوال عمر العملية، واكتشاف انتهاء صلاحية النفق فوراً.
    مهم جداً: عندما تنتهي صلاحية نفق trycloudflare بعد عدة ساعات، يطبع cloudflared:
    'Unauthorized: Tunnel not found' دون أن يغلق العملية!
    لذلك نرصد هذه الرسائل هنا ونعلن وفاة النفق فوراً ليتم إنشاء نفق جديد تلقائياً خلال ثوانٍ.
    """
    global _active_tunnel_url
    consecutive_retries = 0
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

                # رصد الأخطاء القاتلة التي تعني أن النفق مات من جهة سيرفرات Cloudflare
                lower_line = line.lower()
                if (
                    "unauthorized: tunnel not found" in lower_line
                    or "tunnel not found" in lower_line
                    or "register tunnel error from server side" in lower_line
                ):
                    tunnel_dead.set()
                elif "retrying connection" in lower_line or "serve tunnel error" in lower_line:
                    consecutive_retries += 1
                    if consecutive_retries >= 4:
                        tunnel_dead.set()
                elif "registered tunnel connection" in lower_line:
                    consecutive_retries = 0
    except Exception:
        pass
    finally:
        tunnel_dead.set()


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
    _safe_print(" 🚀 تم تفعيل نفق Cloudflare الحقيقي بنجاح للمزامنة اللحظية (24/7)!")
    _safe_print(f" 🌍 رابط الموبايل عبر النفق:      {url}")
    _safe_print(f" 📱 أو افتح كشف الجرد السريع:     {url}/mobile")
    pub = os.environ.get("RAMBFE_PUBLIC_URL", "").strip()
    if pub:
        _safe_print(f" ☁️ الرابط العام المخصص:         {pub}")
    _safe_print("=" * 68 + "\n")


def _tunnel_worker(port: int):
    """تشغيل النفق ومراقبته صحياً وإعادة إنشائه تلقائياً فور انتهاء صلاحيته أو انقطاعه."""
    global _cf_process, _active_tunnel_url
    cf_exe = find_cloudflared()
    if not cf_exe:
        _safe_print("[!] لم يتم العثور على أداة cloudflared.exe - سيعمل البرنامج محلياً فقط.")
        return

    backoff = 3
    while not _stop_event.is_set():
        _remove_url_file()
        _active_tunnel_url = ""
        _rotate_log()
        _kill_orphan_cloudflared()

        # استخدام بروتوكول http2 بدلاً من QUIC لمنع انقطاع النفق بعد فترات الخمول الطويلة على ويندوز
        token, public_url = get_named_tunnel_config()
        if token:
            cmd = [cf_exe, "tunnel", "--no-autoupdate", "--protocol", "http2", "run", "--token", token]
        else:
            cmd = [
                cf_exe,
                "tunnel",
                "--no-autoupdate",
                "--protocol",
                "http2",
                "--url",
                f"http://127.0.0.1:{port}"
            ]
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
            backoff = min(backoff * 2, 60)
            continue

        try:
            CF_PID_FILE.write_text(str(_cf_process.pid))
        except Exception:
            pass
        url_found = threading.Event()
        tunnel_dead = threading.Event()
        if token and public_url:
            # النفق الدائم: الرابط معروف مسبقاً ولا يظهر في السجل
            _active_tunnel_url = public_url
            try:
                CF_URL_FILE.write_text(public_url, encoding="utf-8")
            except Exception:
                pass
            url_found.set()
        threading.Thread(
            target=_drain_output,
            args=(_cf_process, url_found, tunnel_dead),
            daemon=True
        ).start()

        if url_found.wait(timeout=45) and _active_tunnel_url:
            backoff = 3
            _print_banner(_active_tunnel_url)
            if register_with_worker(_active_tunnel_url):
                _safe_print(" [*] تم ربط النفق بسيرفر Cloudflare بنجاح.")
            else:
                _safe_print(" [!] تعذر ربط النفق بسيرفر Cloudflare الآن، ستتم إعادة المحاولة تلقائياً.")
            _sync_tunnel_to_github_async(_active_tunnel_url)
        else:
            _safe_print("[!] لم يظهر رابط النفق خلال 45 ثانية، جاري إعادة المحاولة...")
            tunnel_dead.set()

        # المراقبة المستمرة + نبضات التسجيل الدورية + فحص صلاحية النفق الفعلي + اكتشاف الخروج من السكون فوراً
        last_beat = time.time()
        last_tick = time.time()
        failed_health_checks = 0
        grace_period_until = time.time() + 25  # مهلة أولية لتسجيل النفق في DNS الخاص بـ Cloudflare

        while (
            not _stop_event.is_set()
            and not tunnel_dead.is_set()
            and _cf_process
            and _cf_process.poll() is None
        ):
            _stop_event.wait(2)
            if tunnel_dead.is_set():
                _safe_print("[!] تم رصد انتهاء صلاحية نفق Cloudflare من السجل، جاري تجديد النفق فوراً...")
                break

            now = time.time()
            # إذا قفز الوقت بأكثر من 15 ثانية فهذا يعني أن الجهاز استيقظ للتو من سكون مؤقت -> نفحص ونجدد فوراً
            if now - last_tick > 15:
                _safe_print(f"[!] تم رصد عودة الجهاز من سكون مؤقت ({int(now - last_tick)}ث) — فحص وتجديد النفق...")
                if _active_tunnel_url:
                    register_with_worker(_active_tunnel_url)
                    if not _check_tunnel_health(_active_tunnel_url):
                        _safe_print("[!] النفق لم يعد يستجيب بعد الاستيقاظ، جاري إعادة إنشاء النفق فوراً...")
                        break
            last_tick = now

            if _active_tunnel_url and now - last_beat >= HEARTBEAT_SECONDS:
                last_beat = now
                register_with_worker(_active_tunnel_url)

                if now >= grace_period_until:
                    if _check_tunnel_health(_active_tunnel_url):
                        failed_health_checks = 0
                    else:
                        failed_health_checks += 1
                        _safe_print(
                            f"[!] تحذير فحص النفق ({failed_health_checks}/3): النفق لا يستجيب، جاري التحقق..."
                        )
                        if failed_health_checks >= 3:
                            _safe_print("[!] النفق الحالي لم يعد يستجيب، جاري إنشاء نفق جديد تلقائياً...")
                            break

        if _stop_event.is_set():
            break

        # النفق توقف أو انتهت صلاحيته: إنهاء العملية القديمة وإعادة التشغيل فوراً
        try:
            if _cf_process and _cf_process.poll() is None:
                _cf_process.terminate()
                try:
                    _cf_process.wait(timeout=3)
                except Exception:
                    _cf_process.kill()
        except Exception:
            pass
        _kill_orphan_cloudflared()
        _safe_print(f"[!] جاري تجديد نفق Cloudflare تلقائياً خلال {backoff} ثوانٍ...")
        _stop_event.wait(backoff)
        backoff = min(backoff * 2, 30)


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
