# -*- coding: utf-8 -*-
"""
الربط التلقائي لملف الأصناف (product.template.xlsx) مع قاعدة بيانات البرنامج.

- يبحث عن ملف product.template.(xlsx|xls|csv) في مجلد المشروع.
- عند تشغيل السيرفر، وكلما تغيّر الملف (تاريخ التعديل أو الحجم)، يستورده تلقائياً
  بنفس محرك الاستيراد المعتمد (commit_import_catalog) وبالتعيين الذكي للأعمدة.
- الاستيراد تراكمي وآمن: يحدّث الأصناف الموجودة بالكود الداخلي ويضيف الجديد
  دون حذف أي باركود أو بيانات قديمة.
- يحفظ حالة آخر مزامنة في data/catalog_autosync.json حتى لا يعيد الاستيراد بلا داعٍ.
"""

import os
import json
import time
import glob
import shutil
import threading
import traceback
from datetime import datetime
from typing import Any, Callable, Dict, Optional

try:
    from .catalog_importer import inspect_excel_catalog, commit_import_catalog
except (ImportError, ValueError):
    from backend.catalog_importer import inspect_excel_catalog, commit_import_catalog

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
TEMP_DIR = os.path.join(BASE_DIR, "temp")
STATE_FILE = os.path.join(DATA_DIR, "catalog_autosync.json")

# اسم الملف الافتراضي (يمكن تغييره بمتغير البيئة CATALOG_AUTO_FILE)
DEFAULT_PATTERNS = ["product.template.xlsx", "product.template.xls", "product.template.csv",
                    "product.template*.xlsx", "product_template*.xlsx"]
CHECK_INTERVAL_SECONDS = int(os.environ.get("CATALOG_AUTO_INTERVAL", "20"))

_lock = threading.Lock()
_thread: Optional[threading.Thread] = None
_stop_event = threading.Event()
_on_synced: Optional[Callable[[Dict[str, Any]], None]] = None

_status: Dict[str, Any] = {
    "enabled": True,
    "running": False,
    "file_path": "",
    "file_name": "",
    "file_found": False,
    "last_check": None,
    "last_sync": None,
    "last_result": None,
    "last_error": None,
}


def _log(msg: str) -> None:
    try:
        print(f"[Catalog Auto-Sync] {msg}", flush=True)
    except Exception:
        pass


def find_catalog_file() -> str:
    """إيجاد ملف الأصناف المرتبط (الأحدث تعديلاً إن وُجد أكثر من ملف)."""
    custom = os.environ.get("CATALOG_AUTO_FILE", "").strip()
    if custom:
        p = custom if os.path.isabs(custom) else os.path.join(BASE_DIR, custom)
        return p if os.path.isfile(p) else ""

    candidates = []
    for pat in DEFAULT_PATTERNS:
        for p in glob.glob(os.path.join(BASE_DIR, pat)):
            name = os.path.basename(p)
            # تجاهل ملفات Excel المؤقتة (~$file.xlsx)
            if name.startswith("~$") or not os.path.isfile(p):
                continue
            if p not in candidates:
                candidates.append(p)
    if not candidates:
        return ""
    return max(candidates, key=lambda x: os.path.getmtime(x))


def _file_signature(path: str) -> Dict[str, Any]:
    st = os.stat(path)
    return {"path": os.path.abspath(path), "mtime": round(st.st_mtime, 3), "size": st.st_size}


def _load_state() -> Dict[str, Any]:
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f) or {}
    except Exception:
        pass
    return {}


def _save_state(state: Dict[str, Any]) -> None:
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        tmp = STATE_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        os.replace(tmp, STATE_FILE)
    except Exception as e:
        _log(f"تعذر حفظ حالة المزامنة: {e}")


def _is_file_stable(path: str, wait: float = 1.5) -> bool:
    """التأكد أن الملف لا يزال يُكتب (مثلاً أثناء الحفظ من Excel أو النسخ)."""
    try:
        s1 = os.path.getsize(path)
        time.sleep(wait)
        s2 = os.path.getsize(path)
        return s1 == s2
    except Exception:
        return False


def get_status() -> Dict[str, Any]:
    with _lock:
        st = dict(_status)
    path = find_catalog_file()
    st["file_found"] = bool(path)
    st["file_path"] = path
    st["file_name"] = os.path.basename(path) if path else ""
    if path:
        try:
            st["file_modified"] = datetime.fromtimestamp(os.path.getmtime(path)).strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            pass
    st["check_interval_seconds"] = CHECK_INTERVAL_SECONDS
    return st


def sync_now(force: bool = False) -> Dict[str, Any]:
    """مزامنة ملف الأصناف الآن (يتخطى الاستيراد إذا لم يتغير الملف إلا عند force=True)."""
    path = find_catalog_file()
    with _lock:
        _status["last_check"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        if not path:
            _status["file_found"] = False
            return {"success": False, "skipped": True,
                    "message": "لم يتم العثور على ملف product.template.xlsx في مجلد المشروع."}
        if _status["running"]:
            return {"success": False, "skipped": True, "message": "المزامنة قيد التنفيذ بالفعل."}
        _status["running"] = True

    try:
        sig = _file_signature(path)
        state = _load_state()
        prev = state.get("signature") or {}

        # فحص أمان ذكي: إذا كانت قاعدة البيانات خالية من الأصناف يتم الاستيراد فوراً بدون تخطي
        try:
            from backend.db import get_stats
            has_no_products = (get_stats().get("products_count", 0) == 0)
        except Exception:
            has_no_products = False

        if not force and not has_no_products and prev.get("path") == sig["path"] and prev.get("mtime") == sig["mtime"] and prev.get("size") == sig["size"]:
            return {"success": True, "skipped": True, "message": "ملف الأصناف لم يتغير منذ آخر مزامنة."}

        if not _is_file_stable(path):
            return {"success": False, "skipped": True, "message": "الملف قيد الحفظ حالياً، ستتم المزامنة في الفحص القادم."}

        # نسخ الملف لنسخة مؤقتة حتى لا نتعارض مع Excel إذا كان الملف مفتوحاً
        os.makedirs(TEMP_DIR, exist_ok=True)
        ext = os.path.splitext(path)[1].lower() or ".xlsx"
        work_copy = os.path.join(TEMP_DIR, f"autosync_catalog{ext}")
        shutil.copy2(path, work_copy)

        started = time.time()
        _log(f"بدء استيراد {os.path.basename(path)} ...")
        info = inspect_excel_catalog(work_copy)
        if not info.get("success"):
            raise RuntimeError(info.get("message") or "تعذر قراءة ملف الأصناف.")

        mapping = info.get("suggested_mapping") or {}
        if not (mapping.get("code_col") or mapping.get("name_en_col") or mapping.get("name_ar_col")):
            raise RuntimeError("لم يتم التعرف على أعمدة الكود أو اسم الصنف في الملف.")

        res = commit_import_catalog(work_copy, mapping, replace_barcodes=False)
        elapsed = round(time.time() - started, 1)
        if not res.get("success"):
            raise RuntimeError(res.get("message") or "فشل استيراد ملف الأصناف.")

        result = {
            "success": True,
            "skipped": False,
            "message": res.get("message"),
            "imported_count": res.get("imported_count", 0),
            "updated_count": res.get("updated_count", 0),
            "new_count": res.get("new_count", 0),
            "total_rows": info.get("total_rows", 0),
            "elapsed_seconds": elapsed,
            "file_name": os.path.basename(path),
        }
        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        _save_state({"signature": sig, "last_sync": now_str, "last_result": result, "mapping": mapping})
        with _lock:
            _status["last_sync"] = now_str
            _status["last_result"] = result
            _status["last_error"] = None
        _log(f"تمت المزامنة في {elapsed} ث: {result['message']}")

        if _on_synced:
            try:
                _on_synced(result)
            except Exception:
                pass
        return result
    except Exception as e:
        err = str(e)
        _log(f"خطأ أثناء المزامنة: {err}")
        traceback.print_exc()
        with _lock:
            _status["last_error"] = err
        return {"success": False, "skipped": False, "message": f"فشل مزامنة ملف الأصناف: {err}"}
    finally:
        with _lock:
            _status["running"] = False


def _watch_loop() -> None:
    # مهلة قصيرة حتى يكتمل إقلاع السيرفر
    time.sleep(3)
    while not _stop_event.is_set():
        try:
            sync_now(force=False)
        except Exception as e:
            _log(f"خطأ غير متوقع في المراقب: {e}")
        _stop_event.wait(CHECK_INTERVAL_SECONDS)


def start_autosync(on_synced: Optional[Callable[[Dict[str, Any]], None]] = None) -> None:
    """تشغيل مراقب ملف الأصناف في الخلفية (مرة واحدة فقط)."""
    global _thread, _on_synced
    if os.environ.get("CATALOG_AUTO_SYNC", "1").strip() in ("0", "false", "no"):
        with _lock:
            _status["enabled"] = False
        return
    _on_synced = on_synced
    state = _load_state()
    with _lock:
        _status["last_sync"] = state.get("last_sync")
        _status["last_result"] = state.get("last_result")
    if _thread and _thread.is_alive():
        return
    _stop_event.clear()
    _thread = threading.Thread(target=_watch_loop, name="catalog-autosync", daemon=True)
    _thread.start()
