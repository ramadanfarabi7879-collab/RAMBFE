import os
import sys

# التأكد من أن مجلد العمل هو مجلد المشروع دائماً
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
os.chdir(BASE_DIR)
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)

from backend.server import run_server

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8000))
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])
    # تعطيل فتح المتصفح التلقائي على خوادم السحابة ولينكس
    is_cloud = bool(os.environ.get("RENDER") or os.environ.get("RAILWAY_STATIC_URL") or os.environ.get("PORT"))
    auto_open = not is_cloud and (os.name == 'nt')
    run_server(port, auto_open_browser=auto_open)
