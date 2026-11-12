# -*- coding: utf-8 -*-
"""
ربط برنامج الكمبيوتر بقاعدة البيانات السحابية الدائمة (Cloudflare D1 على https://rambfe.pages.dev).

- عمليات الجرد (المسح، الكميات، الاستورات، الترحيل) مصدرها الوحيد هو السحابة: الكمبيوتر يمررها كما هي،
  فيرى الكمبيوتر والموبايل نفس البيانات دائماً حتى لو كان الكمبيوتر مطفأً وقت الجرد من الموبايل.
- عمليات الكمبيوتر الثقيلة (تصدير الإكسيل، رفع ملف المخزون، البحث المسبق) تسحب نسخة حديثة من جداول
  الجرد قبل التنفيذ محلياً، وما يكتب منها يُرفع للسحابة بعدها.
- كتالوج الأصناف مصدره الكمبيوتر (الاستيراد من ملف الإكسيل): أي تغيير يُرفع للسحابة تلقائياً (التغييرات فقط).
"""
import os
import json
import time
import sqlite3
import hashlib
import threading
import urllib.request
import urllib.error
from typing import Optional, Dict, Any, List, Tuple

from .db_safety import BASE_DIR, DATA_DIR, get_server_logger
from .db import get_connection

CLOUD_URL = os.environ.get("RAMBFE_CLOUD_URL", "https://rambfe.pages.dev").rstrip("/")
TOKEN_FILE = os.path.join(DATA_DIR, "cloud_admin_token.txt")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RAMBFE-Desktop/4.0"
STOCK_TABLES = ["stock_stores", "inventory_records", "stocktake_entries", "stocktake_scanned_serials"]
INVOICE_TABLES = ["invoices", "invoice_lines", "scanned_serials", "returns_log", "product_aliases", "audit_logs"]
SYNC_TABLES = STOCK_TABLES + INVOICE_TABLES

# نفس قائمة المسارات في cloud/router.js
CLOUD_GET = {"/api/catalog/products", "/api/stock/stores", "/api/stock/store/details", "/api/stock/store/search",
             "/api/sync/events", "/api/mobile/poll", "/api/stats", "/api/catalog/product", "/api/catalog/next-code",
             "/api/stock/uncounted", "/api/stock/preinventory-search", "/api/invoice/active", "/api/invoices/list", "/api/invoices/get",
             "/api/profiles", "/api/stock/trash", "/api/catalog/snapshot", "/api/catalog/changes", "/api/stock/offline-pack", "/api/cloud/usage"}
CLOUD_POST = {"/api/mobile/scan", "/api/stock/scan", "/api/stock/save-batch-qty", "/api/stock/update-qty", "/api/stock/delete-item",
              "/api/stock/bulk-delete", "/api/stock/edit-item", "/api/stock/clear", "/api/stock/clear-inventory", "/api/stock/settle",
              "/api/stock/commit-bulk", "/api/stock/stores/commit-all", "/api/stock/trash/restore", "/api/stock/stores/create", "/api/stock/stores/update",
              "/api/stock/stores/delete", "/api/stock/reset-all", "/api/stock/populate-all",
              "/api/catalog/save", "/api/catalog/delete", "/api/catalog/parse-gs1", "/api/catalog/parse-gtin", "/api/invoice/new",
              "/api/invoice/scan", "/api/invoice/delete-serial", "/api/invoice/delete-line", "/api/invoice/clear-lines", "/api/invoice/clear",
              "/api/invoice/update-line-qty", "/api/invoice/manual-item", "/api/invoice/confirm", "/api/returns/process",
              "/api/profiles/create", "/api/profiles/rename", "/api/profiles/delete", "/api/stock/upload/detect",
              "/api/stock/upload/rows", "/api/stock/upload/finish", "/api/export/data",
              "/api/catalog/import/lookup", "/api/catalog/import/commit", "/api/catalog/import/finish",
              "/api/invoice/import/rows", "/api/invoice/import/finish",
              "/api/invoice/ai/extract", "/api/invoice/ai/match", "/api/invoice/ai/commit"}
# مسارات تعمل محلياً على الكمبيوتر بعد سحب نسخة حديثة من جداول الجرد
PULL_BEFORE_GET = {"/api/stock/search", "/api/stock/export-excel", "/api/stock/export", "/api/stock/uncounted/export-excel",
                   "/api/stock/uncounted-export", "/api/invoice/export-excel", "/api/invoice/export", "/api/invoice/export-stock-excel",
                   "/api/invoice/export-stock", "/api/catalog/export-excel", "/api/catalog/export"}
PULL_BEFORE_POST = {"/api/invoice/export-custom-excel", "/api/catalog/export-excel", "/api/catalog/export"}
# عمليات الكمبيوتر التي تكتب في الفواتير (قراءة ملف PDF/صورة) ثم تُرفع للسحابة
INVOICE_WRITE_POST = {"/api/invoice/upload-file"}
# عمليات الكمبيوتر التي تكتب في الكتالوج محلياً (استيراد إكسيل) ثم تُرفع التغييرات للسحابة
CATALOG_WRITE_POST = {"/api/catalog/upload-excel", "/api/catalog/commit-import"}

# بصمة الصنف: نفس التعبير بالضبط في cloud/router.js (CATALOG_SIG_SQL)
CATALOG_SIG_SQL = (
    "p.id||'|'||ifnull(p.gtin,'')||'|'||ifnull(p.barcode,'')||'|'||ifnull(p.name_ar,'')||'|'||ifnull(p.name_en,'')||'|'||ifnull(p.name,'')"
    "||'|'||ifnull(p.category,'')||'|'||ifnull(p.selling_price,'')||'|'||ifnull(p.unit_price,'')||'|'||ifnull(p.cost_price,'')"
    "||'|'||ifnull(p.tax_rate,'')||'|'||ifnull(p.unit,'')||'|'||ifnull(p.unit_divisions,'')||'|'||ifnull(p.normalized_name,'')"
    "||'|'||ifnull(p.normalized_name_ar,'')||'|'||ifnull(p.normalized_name_en,'')||'|'||ifnull(p.scientific_name,'')||'|'||ifnull(p.company,'')"
    "||'|'||ifnull(p.wholesale_price,'')||'|'||ifnull((SELECT group_concat(x, ',') FROM (SELECT barcode||':'||ifnull(barcode_type,'') AS x "
    "FROM product_barcodes WHERE product_code = p.code ORDER BY barcode, barcode_type)),'')"
)
PRODUCT_COLS = ["id", "code", "gtin", "barcode", "name_ar", "name_en", "name", "category", "selling_price", "unit_price", "cost_price",
                "tax_rate", "unit", "unit_divisions", "normalized_name", "normalized_name_ar", "normalized_name_en", "created_at",
                "updated_at", "scientific_name", "company", "wholesale_price"]

_pull_lock = threading.Lock()
_last_pull = 0.0
_catalog_lock = threading.Lock()
_status: Dict[str, Any] = {"last_error": None, "last_catalog_push": None, "last_pull": None}


def is_enabled() -> bool:
    flag = os.environ.get("RAMBFE_CLOUD", "").strip().lower()
    if flag in ("0", "false", "no", "off"):
        return False
    if flag in ("1", "true", "yes", "on"):
        return True
    # الاختبارات تستخدم قاعدة بيانات مؤقتة: لا نلمس السحابة أبداً منها
    return not os.environ.get("INVENTORY_DB_PATH", "").strip()


def admin_token() -> str:
    tok = os.environ.get("RAMBFE_CLOUD_TOKEN", "").strip()
    if tok:
        return tok
    try:
        with open(TOKEN_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


def status() -> Dict[str, Any]:
    return {"enabled": is_enabled(), "cloud_url": CLOUD_URL, "has_admin_token": bool(admin_token()), **_status}


def _request(method: str, path: str, body: Optional[bytes] = None, headers: Optional[Dict[str, str]] = None, timeout: int = 30) -> Tuple[int, bytes, str]:
    h = {"User-Agent": UA, "Accept": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(CLOUD_URL + path, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), resp.headers.get("Content-Type", "application/json")
    except urllib.error.HTTPError as he:
        return he.code, he.read(), he.headers.get("Content-Type", "application/json")


def forward(method: str, path_qs: str, body: Optional[bytes], profile_id: str = "") -> Tuple[int, bytes, str]:
    """تمرير طلب الجرد كما هو إلى السحابة. عند انقطاع الإنترنت نعيد 503 برسالة واضحة (لا نكتب محلياً لمنع تضارب البيانات)."""
    try:
        h = {"Content-Type": "application/json"} if body else {}
        if profile_id:
            h["X-Profile-Id"] = str(profile_id)
        return _request(method, path_qs, body, h or None, timeout=45)
    except Exception as e:
        _status["last_error"] = f"forward {path_qs}: {e}"
        msg = {"success": False, "offline_reconnecting": True,
               "message": "لا يوجد اتصال بالإنترنت حالياً: بيانات الجرد محفوظة على السحابة وستظهر فور عودة الاتصال."}
        return 503, json.dumps(msg, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8"


def _admin(path: str, payload: Dict[str, Any], timeout: int = 120) -> Dict[str, Any]:
    tok = admin_token()
    if not tok:
        raise RuntimeError("ملف data/cloud_admin_token.txt غير موجود على هذا الجهاز")
    code, raw, _ = _request("POST", path, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                            {"Content-Type": "application/json", "X-Admin-Token": tok}, timeout=timeout)
    data = json.loads(raw.decode("utf-8") or "{}")
    if code != 200 or not data.get("success"):
        raise RuntimeError(f"cloud admin {path} -> {code}: {data.get('message')}")
    return data


# ---------------- جداول الجرد ----------------
def pull_stock_tables(max_age: float = 3.0, tables_list: Optional[List[str]] = None) -> bool:
    """تحديث نسخة الكمبيوتر من جداول الجرد والفواتير من السحابة (بحد أقصى مرة كل max_age ثانية)."""
    global _last_pull
    if not is_enabled() or not admin_token():
        return False
    with _pull_lock:
        if time.time() - _last_pull < max_age:
            return True
        try:
            wanted = tables_list or SYNC_TABLES
            tables = _admin("/api/_admin/pull", {"tables": wanted}).get("tables", {})
            conn = get_connection()
            try:
                c = conn.cursor()
                c.execute("BEGIN")
                for t in wanted:
                    rows = tables.get(t)
                    if rows is None:
                        continue
                    c.execute(f"DELETE FROM {t}")
                    if rows:
                        local_cols = {r[1] for r in c.execute(f"PRAGMA table_info({t})").fetchall()}
                        # أعمدة جديدة في السحابة (مثل profile_id للصيدليات) تُضاف محلياً حتى لا تضيع عند الرفع
                        for k in rows[0].keys():
                            if k not in local_cols and k.replace("_", "").isalnum():
                                c.execute(f"ALTER TABLE {t} ADD COLUMN {k}")
                                local_cols.add(k)
                        cols = [k for k in rows[0].keys() if k in local_cols]
                        c.executemany(f"INSERT INTO {t} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                                      [tuple(r.get(k) for k in cols) for r in rows])
                conn.commit()
            except Exception:
                conn.rollback()
                raise
            finally:
                conn.close()
            _last_pull = time.time()
            _status["last_pull"] = time.strftime("%Y-%m-%d %H:%M:%S")
            return True
        except Exception as e:
            _status["last_error"] = f"pull: {e}"
            get_server_logger().warning(f"[Cloud] pull stock tables failed: {e}")
            return False


def push_stock_tables(event: str = "inventory_uploaded", tables_list: Optional[List[str]] = None) -> bool:
    """(معطّل) كان يستبدل جداول الجرد/الفواتير في السحابة بنسخة الكمبيوتر فيمسح ما أُضيف من الموبايل في الأثناء.
    السحابة الآن المصدر الوحيد لهذه الجداول ولا تقبل الاستبدال الكامل إلا بتأكيد صريح."""
    raise RuntimeError("استبدال جداول الجرد في السحابة من الكمبيوتر معطّل لحماية بيانات الجرد")
    global _last_pull
    if not is_enabled() or not admin_token():
        return False
    conn = get_connection()
    try:
        tables = {t: [dict(r) for r in conn.execute(f"SELECT * FROM {t} ORDER BY id")] for t in (tables_list or STOCK_TABLES)}
    finally:
        conn.close()
    _admin("/api/_admin/replace", {"tables": tables, "event": event}, timeout=300)
    _last_pull = time.time()
    return True


# ---------------- كتالوج الأصناف ----------------
def _local_catalog_sigs() -> Dict[str, str]:
    conn = get_connection()
    try:
        return {r[0]: r[1] for r in conn.execute(f"SELECT code, {CATALOG_SIG_SQL} FROM products p")}
    finally:
        conn.close()


def _cloud_catalog_sigs() -> Dict[str, str]:
    out: Dict[str, str] = {}
    offset = 0
    while True:
        rows = _admin("/api/_admin/catalog_rows", {"offset": offset, "limit": 5000}).get("rows", [])
        for r in rows:
            out[r["code"]] = r["s"]
        if len(rows) < 5000:
            return out
        offset += 5000


def _state_path() -> str:
    return os.path.join(DATA_DIR, "cloud_catalog_state.json")


def _load_state() -> Optional[Dict[str, str]]:
    try:
        with open(_state_path(), "r", encoding="utf-8") as f:
            d = json.load(f)
        if d.get("cloud_url") == CLOUD_URL:
            return d.get("sigs")
    except Exception:
        pass
    return None


def _save_state(sigs: Dict[str, str]) -> None:
    tmp = _state_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"cloud_url": CLOUD_URL, "sigs": sigs}, f, ensure_ascii=False)
    os.replace(tmp, _state_path())


def push_catalog(full_compare: bool = False) -> Dict[str, Any]:
    """رفع التغييرات فقط في كتالوج الأصناف للسحابة."""
    if not is_enabled() or not admin_token():
        return {"success": False, "skipped": True}
    with _catalog_lock:
        local = _local_catalog_sigs()
        known = None if full_compare else _load_state()
        remote = known if known is not None else _cloud_catalog_sigs()
        changed = [c for c, s in local.items() if remote.get(c) != s]
        deleted = [c for c in remote if c not in local]
        if not changed and not deleted:
            if known is None:
                _save_state(local)
            return {"success": True, "changed": 0, "deleted": 0}

        conn = get_connection()
        try:
            def rows_for(codes: List[str]):
                prods, bcs = [], []
                for i in range(0, len(codes), 500):
                    part = codes[i:i + 500]
                    ph = ",".join("?" * len(part))
                    for r in conn.execute(f"SELECT {','.join(PRODUCT_COLS)} FROM products WHERE code IN ({ph})", part):
                        prods.append(dict(r))
                    for r in conn.execute(f"SELECT product_code, barcode, barcode_type, created_at FROM product_barcodes WHERE product_code IN ({ph})", part):
                        bcs.append(dict(r))
                return prods, bcs

            # المرحلة 1: حذف الأصناف المتغيرة/المحذوفة (يمنع تعارض أرقام id بين الدفعات)
            to_delete = changed + deleted
            for i in range(0, len(to_delete), 2000):
                _admin("/api/_admin/catalog_apply", {"delete_codes": to_delete[i:i + 2000], "delete_only": True}, timeout=300)
            # المرحلة 2: إدراج النسخ الحالية مع باركوداتها
            for i in range(0, len(changed), 300):
                prods, bcs = rows_for(changed[i:i + 300])
                _admin("/api/_admin/catalog_apply", {"products": prods, "barcodes": bcs}, timeout=300)
        finally:
            conn.close()
        _save_state(local)
        _status["last_catalog_push"] = time.strftime("%Y-%m-%d %H:%M:%S")
        get_server_logger().info(f"[Cloud] catalog pushed: changed={len(changed)} deleted={len(deleted)}")
        return {"success": True, "changed": len(changed), "deleted": len(deleted)}


def _load_seq() -> int:
    try:
        with open(os.path.join(DATA_DIR, "cloud_catalog_seq.txt"), "r", encoding="utf-8") as f:
            return int(f.read().strip() or 0)
    except Exception:
        return -1


def _save_seq(seq: int) -> None:
    with open(os.path.join(DATA_DIR, "cloud_catalog_seq.txt"), "w", encoding="utf-8") as f:
        f.write(str(seq))


def pull_catalog_changes() -> int:
    """جلب تعديلات الأصناف التي تمت من السحابة (الموبايل/الرابط) وتطبيقها على نسخة الكمبيوتر."""
    if not is_enabled() or not admin_token():
        return 0
    with _catalog_lock:
        since = _load_seq()
        if since < 0:
            # أول مرة: نبدأ من آخر تغيير حالي (المطابقة الكاملة تتم في push_catalog)
            d = _admin("/api/_admin/catalog_changes", {"since": 10 ** 12})
            _save_seq(int(d.get("max_seq") or 0))
            return 0
        applied = 0
        while True:
            d = _admin("/api/_admin/catalog_changes", {"since": since})
            changes = d.get("changes") or []
            if not changes:
                break
            codes = list({c["code"] for c in changes})
            conn = get_connection()
            try:
                c = conn.cursor()
                if "*" in codes:
                    c.execute("DELETE FROM products")
                    c.execute("DELETE FROM product_barcodes")
                real = [x for x in codes if x != "*"]
                for i in range(0, len(real), 500):
                    part = real[i:i + 500]
                    ph = ",".join("?" * len(part))
                    c.execute(f"DELETE FROM product_barcodes WHERE product_code IN ({ph})", part)
                    c.execute(f"DELETE FROM products WHERE code IN ({ph})", part)
                local_cols = {r[1] for r in c.execute("PRAGMA table_info(products)").fetchall()}
                for pr in d.get("products") or []:
                    cols = [k for k in pr.keys() if k in local_cols]
                    c.execute(f"INSERT INTO products ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})", tuple(pr[k] for k in cols))
                for b in d.get("barcodes") or []:
                    c.execute("INSERT OR IGNORE INTO product_barcodes (product_code, barcode, barcode_type, created_at) VALUES (?, ?, ?, ?)",
                              (b["product_code"], b["barcode"], b.get("barcode_type") or "barcode", b.get("created_at")))
                conn.commit()
            finally:
                conn.close()
            # تحديث بصمات هذه الأصناف حتى لا تُرفع مرة أخرى للسحابة
            state = _load_state()
            if state is not None:
                fresh = _local_catalog_sigs()
                if "*" in codes:
                    state = dict(fresh)
                else:
                    for code in codes:
                        if code in fresh:
                            state[code] = fresh[code]
                        else:
                            state.pop(code, None)
                _save_state(state)
            since = int(d.get("last_seq") or since)
            _save_seq(since)
            applied += len(codes)
        if applied:
            get_server_logger().info(f"[Cloud] pulled {applied} catalog changes from the cloud")
        return applied


def _catalog_fingerprint() -> str:
    conn = get_connection()
    try:
        r = conn.execute("SELECT COUNT(*), MAX(id), MAX(updated_at), TOTAL(selling_price), TOTAL(cost_price), TOTAL(LENGTH(name)), "
                         "TOTAL(LENGTH(name_ar)), TOTAL(LENGTH(name_en)) FROM products").fetchone()
        b = conn.execute("SELECT COUNT(*), MAX(id), TOTAL(LENGTH(barcode)) FROM product_barcodes").fetchone()
        return hashlib.sha1(repr((tuple(r), tuple(b))).encode()).hexdigest()
    finally:
        conn.close()


def initial_sync() -> None:
    """أول تشغيل على أي جهاز: مطابقة الكتالوج كاملاً، وتسليم بيانات الجرد للسحابة إن كانت السحابة ما زالت بالنسخة المؤقتة ولم يُستخدم الجرد بعد."""
    meta = _admin("/api/_admin/meta", {})
    m = meta.get("meta", {})
    if m.get("seed_source") == "provisional":
        # لا نستبدل جداول الجرد في السحابة بنسخة الكمبيوتر أبداً (السحابة هي المصدر الوحيد للجرد)
        _admin("/api/_admin/meta", {"set": {"seed_source": "pc"}})
    push_catalog(full_compare=_load_state() is None)


def start_background_sync() -> None:
    if not is_enabled():
        return
    if not admin_token():
        get_server_logger().warning("[Cloud] data/cloud_admin_token.txt missing: catalog changes will not sync to the cloud.")
        return

    def loop():
        try:
            initial_sync()
        except Exception as e:
            _status["last_error"] = f"initial: {e}"
            get_server_logger().warning(f"[Cloud] initial sync failed: {e}")
        last_fp = None
        while True:
            try:
                pull_catalog_changes()
                fp = _catalog_fingerprint()
                if fp != last_fp:
                    push_catalog()
                    last_fp = fp
            except Exception as e:
                _status["last_error"] = f"catalog: {e}"
                get_server_logger().warning(f"[Cloud] catalog sync failed: {e}")
            time.sleep(30)

    threading.Thread(target=loop, name="cloud-sync", daemon=True).start()


# ---------------- أحداث المزامنة (ذاكرة مؤقتة على الكمبيوتر) ----------------
# كل تبويبات الكمبيوتر تقرأ من هذه الذاكرة، والكمبيوتر يسأل السحابة مرة واحدة كل 3 ثوانٍ كحد أقصى
_events_lock = threading.Lock()
_events: List[Dict[str, Any]] = []
_events_cloud_ts = time.time()
_events_last_fetch = 0.0
EVENTS_MIN_INTERVAL = 3.0


def get_events(since: float) -> Dict[str, Any]:
    global _events_cloud_ts, _events_last_fetch
    with _events_lock:
        now = time.time()
        if now - _events_last_fetch >= EVENTS_MIN_INTERVAL:
            _events_last_fetch = now
            try:
                code, raw, _ = _request("GET", f"/api/sync/events?since={_events_cloud_ts}", timeout=15)
                if code == 200:
                    d = json.loads(raw.decode("utf-8") or "{}")
                    new = d.get("events") or []
                    seen = {e.get("id") for e in _events}
                    _events.extend(e for e in new if e.get("id") not in seen)
                    if new:
                        _events_cloud_ts = max(float(e.get("timestamp") or 0) for e in new)
                    cutoff = now - 600
                    _events[:] = [e for e in _events if float(e.get("timestamp") or 0) > cutoff]
            except Exception as e:
                _status["last_error"] = f"events: {e}"
        evts = [e for e in _events if float(e.get("timestamp") or 0) > since]
        latest = max([float(e.get("timestamp") or 0) for e in evts] + [since])
        return {"events": evts, "scans": [e.get("payload") for e in evts if e.get("type") == "mobile_scan"], "timestamp": latest}
