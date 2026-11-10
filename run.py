import os
import sys
import time
import threading

# التأكد من أن مجلد العمل هو مجلد المشروع دائماً
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(BASE_DIR)
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

_power_request_handle = None


def disable_windows_quick_edit():
    """
    إيقاف وضع QuickEdit في نافذة الأوامر على ويندوز.
    عند الضغط بالماوس داخل نافذة السيرفر يقوم ويندوز بتجميد البرنامج بالكامل
    حتى يتم الضغط على زر في النافذة.
    """
    if os.name != 'nt':
        return
    try:
        import ctypes
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.GetStdHandle(-10)  # STD_INPUT_HANDLE
        mode = ctypes.c_uint32()
        if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
            ENABLE_QUICK_EDIT_MODE = 0x0040
            ENABLE_EXTENDED_FLAGS = 0x0080
            new_mode = (mode.value & ~ENABLE_QUICK_EDIT_MODE) | ENABLE_EXTENDED_FLAGS
            kernel32.SetConsoleMode(handle, new_mode)
    except Exception:
        pass


def prevent_windows_sleep():
    """
    منع ويندوز (بما في ذلك Modern Standby S0 في ويندوز 10/11) من إيقاف العملية أو قطع الشبكة
    عند ترك الجهاز دون استخدام لعدة ساعات أو عند إطفاء الشاشة.
    """
    global _power_request_handle
    if os.name != 'nt':
        return
    try:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.windll.kernel32
        ES_CONTINUOUS = 0x80000000
        ES_SYSTEM_REQUIRED = 0x00000001
        ES_AWAYMODE_REQUIRED = 0x00000040

        res = kernel32.SetThreadExecutionState(
            ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
        )
        if not res:
            kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)

        # طلب الطاقة الرسمي لنظام Modern Standby S0: يمنع Windows من تجميد الخادم عند إطفاء الشاشة
        class REASON_CONTEXT(ctypes.Structure):
            _fields_ = [
                ("Version", wintypes.ULONG),
                ("Flags", wintypes.ULONG),
                ("SimpleReasonString", wintypes.LPWSTR),
            ]

        POWER_REQUEST_CONTEXT_VERSION = 0
        POWER_REQUEST_CONTEXT_SIMPLE_STRING = 1
        PowerRequestSystemRequired = 1
        PowerRequestExecutionRequired = 3

        kernel32.PowerCreateRequest.argtypes = [ctypes.POINTER(REASON_CONTEXT)]
        kernel32.PowerCreateRequest.restype = wintypes.HANDLE
        kernel32.PowerSetRequest.argtypes = [wintypes.HANDLE, ctypes.c_int]
        kernel32.PowerSetRequest.restype = wintypes.BOOL

        ctx = REASON_CONTEXT(
            POWER_REQUEST_CONTEXT_VERSION,
            POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            "RAMBFE Invoice Matcher & Stocktake Server 24/7",
        )
        handle = kernel32.PowerCreateRequest(ctypes.byref(ctx))
        if handle and handle != wintypes.HANDLE(-1).value:
            _power_request_handle = handle
            kernel32.PowerSetRequest(handle, PowerRequestExecutionRequired)
            kernel32.PowerSetRequest(handle, PowerRequestSystemRequired)

        # خيط دوري كل 60 ثانية لتجديد حالة عدم السكون
        def _keep_awake_loop():
            while True:
                time.sleep(60)
                try:
                    kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)
                except Exception:
                    pass

        threading.Thread(target=_keep_awake_loop, name="power-keepalive", daemon=True).start()
    except Exception:
        pass


from backend.db_safety import get_server_logger
from backend.server import run_server
from backend.tunnel_manager import start_tunnel_in_background

if __name__ == '__main__':
    logger = get_server_logger()
    disable_windows_quick_edit()
    prevent_windows_sleep()

    port = int(os.environ.get("PORT", 8000))
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])

    logger.info(f"Launching run.py on port {port} (cwd={os.getcwd()})")

    # تعطيل فتح المتصفح التلقائي على خوادم السحابة ولينكس
    is_cloud = bool(os.environ.get("RENDER") or os.environ.get("RAILWAY_STATIC_URL") or os.environ.get("PORT"))
    auto_open = not is_cloud and (os.name == 'nt') and os.environ.get("RAMBFE_NO_BROWSER", "") != "1"

    # إطلاق نفق Cloudflare الحقيقي تلقائياً في الخلفية لربط الموبايل بالمزامنة اللحظية
    if not is_cloud:
        start_tunnel_in_background(port)

    try:
        run_server(port, auto_open_browser=auto_open)
    except Exception as exc:
        logger.exception(f"Unhandled crash in run_server: {exc}")
        raise
