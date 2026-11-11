# -*- coding: utf-8 -*-
"""خادم معزول لاختبارات الـ API.

كانت بعض الاختبارات تتصل بـ http://127.0.0.1:8000 وتفترض أن البرنامج الحقيقي شغال، فكانت:
- تفشل (Connection refused) على أي جهاز البرنامج مش شغال عليه.
- أو تعدّل قاعدة البيانات الحقيقية وكتالوج السحابة لو كان شغال.

هنا نشغّل نفس خادم البرنامج داخل عملية الاختبار على منفذ فاضي، بقاعدة بيانات مؤقتة فارغة فيها أصناف
اختبار ثابتة (FIXTURE_PRODUCTS) وبدون أي اتصال بالسحابة، فلا تعتمد النتائج على بيانات الصيدلية الحقيقية.
الاستخدام في ملف الاختبار:

    from live_server import start_live_server, stop_live_server, base_url
    def setUpModule(): start_live_server()
    def tearDownModule(): stop_live_server()
    ... urllib.request.urlopen(base_url() + '/api/...')
"""
import os
import sys
import shutil
import socket
import tempfile
import threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

# أصناف ثابتة تعتمد عليها اختبارات التصدير والاستيراد
FIXTURE_PRODUCTS = [
    {"code": "94688", "name_en": "FINJUVE 2.275MG SPRAY", "name_ar": "بخاخ فينجوف 2.275 مجم", "selling_price": 160.0,
     "unit_price": 100.0, "tax_rate": 0.0, "gtin_list": ["06285101004926"], "barcode_list": []},
    {"code": "10001", "name_en": "PANADOL EXTRA 24 TAB", "name_ar": "بنادول اكسترا 24 قرص", "selling_price": 45.0,
     "unit_price": 38.0, "tax_rate": 0.0, "gtin_list": ["06281086001234"], "barcode_list": []},
    # أصناف حقيقية من كتالوج الصيدلية تستخدمها اختبارات قراءة أكواد GS1 (نفس الـ GTIN المطبوع على العبوة)
    {"code": "14013", "name_en": "DOMPY 10MG 30TAB", "name_ar": "دومبي 10 مجم 30 قرص", "selling_price": 30.0,
     "unit_price": 0.0, "tax_rate": 0.0, "gtin_list": ["06285128000307"], "barcode_list": []},
    {"code": "27660", "name_en": "EMIFEN 600 20 TABLETS", "name_ar": "ايميفين 600 20 قرص", "selling_price": 8.25,
     "unit_price": 0.0, "tax_rate": 0.0, "gtin_list": ["06291103730435"], "barcode_list": []},
]

_state = {"httpd": None, "thread": None, "tmp": None, "old_env": {}, "port": None}


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def base_url() -> str:
    if not _state["port"]:
        raise RuntimeError("start_live_server() لم يتم استدعاؤها")
    return f"http://127.0.0.1:{_state['port']}"


def start_live_server() -> str:
    if _state["httpd"]:
        return base_url()
    tmp = tempfile.mkdtemp(prefix="rambfe_test_")
    db_path = os.path.join(tmp, "inventory.db")
    for k, v in {"INVENTORY_DB_PATH": db_path, "RAMBFE_CLOUD": "0", "RAMBFE_NO_BROWSER": "1"}.items():
        _state["old_env"][k] = os.environ.get(k)
        os.environ[k] = v

    from backend.db import init_db, save_or_update_product
    from backend import server as srv
    init_db()
    for p in FIXTURE_PRODUCTS:
        save_or_update_product(dict(p))
    port = _free_port()
    httpd = srv.ReusableThreadingHTTPServer(("127.0.0.1", port), srv.AppRequestHandler)
    t = threading.Thread(target=httpd.serve_forever, name="test-live-server", daemon=True)
    t.start()
    _state.update(httpd=httpd, thread=t, tmp=tmp, port=port)
    return base_url()


def stop_live_server() -> None:
    httpd = _state["httpd"]
    if httpd:
        httpd.shutdown()
        httpd.server_close()
    for k, v in _state["old_env"].items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    if _state["tmp"]:
        shutil.rmtree(_state["tmp"], ignore_errors=True)
    _state.update(httpd=None, thread=None, tmp=None, old_env={}, port=None)
