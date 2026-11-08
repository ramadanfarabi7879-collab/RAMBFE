import os
import sys

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


def disable_windows_quick_edit():
    """
    إيقاف وضع QuickEdit في نافذة الأوامر على ويندوز.
    عند الضغط بالماوس داخل نافذة السيرفر يقوم ويندوز بتجميد البرنامج بالكامل
    (فيظهر كأنه "وقف" على الموبايل والكمبيوتر) حتى يتم الضغط على زر في النافذة.
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
    منع نظام ويندوز من إيقاف تشغيل النظام أو قطع الشبكة عند ترك الجهاز بدون استخدام لعدة ساعات.
    يضمن بقاء السيرفر ونفق Cloudflare متصلين 24/7 بدون توقف.
    """
    if os.name != 'nt':
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


from backend.server import run_server
from backend.tunnel_manager import start_tunnel_in_background

if __name__ == '__main__':
    disable_windows_quick_edit()
    prevent_windows_sleep()

    port = int(os.environ.get("PORT", 8000))
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])

    # تعطيل فتح المتصفح التلقائي على خوادم السحابة ولينكس
    is_cloud = bool(os.environ.get("RENDER") or os.environ.get("RAILWAY_STATIC_URL") or os.environ.get("PORT"))
    auto_open = not is_cloud and (os.name == 'nt') and os.environ.get("RAMBFE_NO_BROWSER", "") != "1"

    # إطلاق نفق Cloudflare الحقيقي تلقائياً في الخلفية لربط الموبايل بالمزامنة اللحظية
    if not is_cloud:
        start_tunnel_in_background(port)

    run_server(port, auto_open_browser=auto_open)
