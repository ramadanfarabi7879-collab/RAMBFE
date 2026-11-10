# -*- coding: utf-8 -*-
"""
مراقب التشغيل المستقل 24/7 (Independent Windows Server Watchdog).

- يعمل بشكل مستقل تماماً عن نافذة الأوامر أو بيئة Antigravity IDE.
- يضمن وجود نسخة واحدة فقط (Single Instance) باستخدام Windows Mutex لمنع تشغيل نسختين متعارضتين.
- يفحص صحة الخادم وقاعدة البيانات كل 15 ثانية عبر /api/health.
- يعيد تشغيل run.py تلقائياً عند أي توقف ويسجل السبب في logs/server.log.
"""

import os
import sys
import time
import socket
import subprocess
import urllib.request
import json
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
os.chdir(BASE_DIR)
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from backend.db_safety import get_server_logger, check_db_health

PORT = int(os.environ.get("RAMBFE_PORT", "8000"))
HEALTH_URL = f"http://127.0.0.1:{PORT}/api/health"
CHECK_INTERVAL = 15


def acquire_single_instance_mutex():
    """ضمان عمل نسخة واحدة فقط من المراقب على ويندوز."""
    if os.name != "nt":
        return True
    try:
        import ctypes
        ERROR_ALREADY_EXISTS = 183
        mutex = ctypes.windll.kernel32.CreateMutexW(None, False, "Local\\RAMBFE_Watchdog_24_7_Mutex")
        last_err = ctypes.windll.kernel32.GetLastError()
        if last_err == ERROR_ALREADY_EXISTS or not mutex:
            return False
        # نحتفظ بالمرجع في الذاكرة طوال عمر العملية
        globals()["_watchdog_mutex_handle"] = mutex
        return True
    except Exception:
        return True


def find_python_exe() -> str:
    venv_pyw = BASE_DIR / ".venv" / "Scripts" / "pythonw.exe"
    venv_py = BASE_DIR / ".venv" / "Scripts" / "python.exe"
    if venv_pyw.is_file():
        return str(venv_pyw)
    if venv_py.is_file():
        return str(venv_py)
    sys_pyw = Path(sys.executable).with_name("pythonw.exe")
    if sys_pyw.is_file():
        return str(sys_pyw)
    return sys.executable


def is_port_listening(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1.0)
        return s.connect_ex(("127.0.0.1", port)) == 0


def probe_server_health() -> dict:
    try:
        req = urllib.request.Request(HEALTH_URL, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8", errors="replace"))
            return {"reachable": True, "status": resp.status, "data": data}
    except urllib.error.HTTPError as he:
        try:
            data = json.loads(he.read().decode("utf-8", errors="replace"))
        except Exception:
            data = {}
        return {"reachable": True, "status": he.code, "data": data}
    except Exception as e:
        return {"reachable": False, "error": str(e)}


def launch_server_process(logger) -> subprocess.Popen:
    py_exe = find_python_exe()
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["RAMBFE_NO_BROWSER"] = "1"
    creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
    logger.info(f"[Watchdog] Starting independent server process: {py_exe} run.py {PORT}")
    return subprocess.Popen(
        [py_exe, "run.py", str(PORT)],
        cwd=str(BASE_DIR),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        stdin=subprocess.DEVNULL,
        creationflags=creationflags,
    )


def main():
    logger = get_server_logger()
    if not acquire_single_instance_mutex():
        logger.info("[Watchdog] Another watchdog instance is already running; exiting cleanly.")
        return 0

    logger.info(f"[Watchdog] Independent 24/7 Watchdog initialized (PID={os.getpid()}, port={PORT}).")
    server_proc = None
    consecutive_failures = 0

    while True:
        try:
            # إذا كانت لدينا عملية خادم نراقب خروجها
            if server_proc is not None and server_proc.poll() is not None:
                exit_code = server_proc.returncode
                logger.warning(f"[Watchdog] Managed server exited unexpectedly with code {exit_code}. Restarting...")
                server_proc = None
                consecutive_failures = 0

            health = probe_server_health()
            if health.get("reachable"):
                consecutive_failures = 0
                time.sleep(CHECK_INTERVAL)
                continue

            # غير قابل للوصول: نتحقق إذا كان المنفذ مغلقاً أم فقط مشغولاً مؤقتاً
            if not is_port_listening(PORT):
                logger.warning("[Watchdog] Port 8000 is not listening -> launching server now.")
                server_proc = launch_server_process(logger)
                consecutive_failures = 0
                time.sleep(6)
                continue

            consecutive_failures += 1
            logger.warning(f"[Watchdog] Health probe failed ({consecutive_failures}/3): {health.get('error')}")
            if consecutive_failures >= 3:
                logger.error("[Watchdog] Server hung (3 failed health checks). Terminating hung process & restarting...")
                if server_proc and server_proc.poll() is None:
                    try:
                        server_proc.terminate()
                        server_proc.wait(timeout=5)
                    except Exception:
                        try:
                            server_proc.kill()
                        except Exception:
                            pass
                server_proc = launch_server_process(logger)
                consecutive_failures = 0
                time.sleep(6)
                continue

        except Exception as e:
            logger.error(f"[Watchdog] Loop exception: {e}")

        time.sleep(CHECK_INTERVAL)


if __name__ == "__main__":
    sys.exit(main())
