# -*- coding: utf-8 -*-
"""
نظام حماية وسلامة قاعدة البيانات والنسخ الاحتياطي التلقائي وسجلات الخادم الدائمة والصلاحيات.
"""

import os
import sys
import glob
import time
import hmac
import shutil
import secrets
import logging
import sqlite3
import threading
from datetime import datetime
from logging.handlers import RotatingFileHandler
from typing import Dict, Any, List, Optional

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, "data")
BACKUP_DIR = os.path.join(BASE_DIR, "backups")
# مسار مستقل تماماً خارج مجلد المشروع لحماية النسخ الاحتياطية حتى لو تأثر مجلد المشروع
EXTERNAL_BACKUP_DIR = os.path.join(
    os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"),
    "RAMBFE_Backups",
)
LOGS_DIR = os.path.join(BASE_DIR, "logs")
SERVER_LOG_FILE = os.path.join(LOGS_DIR, "server.log")
PERMANENT_DB_PATH = os.path.abspath(os.path.join(DATA_DIR, "inventory.db"))
ADMIN_TOKEN_FILE = os.path.abspath(os.path.join(DATA_DIR, ".admin_token"))

CORE_TABLES = (
    "products",
    "product_barcodes",
    "invoices",
    "invoice_lines",
    "stock_stores",
    "inventory_records",
    "stocktake_entries",
)

MAX_BACKUPS_TO_KEEP = 60
AUTO_BACKUP_INTERVAL_SECONDS = 3600  # كل ساعة

_log_lock = threading.Lock()
_logger_configured = False
_db_guard_lock = threading.Lock()
_db_state: Dict[str, Any] = {
    "healthy": True,
    "write_blocked": False,
    "last_error": None,
    "last_check_at": None,
    "last_backup_at": None,
    "last_backup_path": None,
    "last_external_backup_path": None,
    "server_started_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    "server_pid": os.getpid(),
}


class DatabaseSafetyError(RuntimeError):
    """يُطلق عند تعذر الوصول الآمن لقاعدة البيانات أو فشل فحص السلامة لإيقاف الكتابة ومنع تلف/فقدان البيانات."""
    pass


def get_server_logger() -> logging.Logger:
    """تهيئة وإرجاع مسجل الأحداث الدائم في logs/server.log."""
    global _logger_configured
    logger = logging.getLogger("rambfe")
    with _log_lock:
        if not _logger_configured:
            try:
                os.makedirs(LOGS_DIR, exist_ok=True)
                logger.setLevel(logging.INFO)
                formatter = logging.Formatter(
                    "%(asctime)s [%(levelname)s] [PID:%(process)d] [%(threadName)s] %(message)s",
                    datefmt="%Y-%m-%d %H:%M:%S",
                )
                fh = RotatingFileHandler(
                    SERVER_LOG_FILE,
                    maxBytes=5 * 1024 * 1024,
                    backupCount=5,
                    encoding="utf-8",
                )
                fh.setFormatter(formatter)
                logger.addHandler(fh)
                logger.propagate = False
                _logger_configured = True
            except Exception:
                pass
    return logger


def get_or_create_admin_token() -> str:
    """جلب أو توليد رمز صلاحيات إداري محلي محفوظ في data/.admin_token (لا يُكشف عبر الشبكة)."""
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.isfile(ADMIN_TOKEN_FILE):
        try:
            with open(ADMIN_TOKEN_FILE, "r", encoding="utf-8") as f:
                tok = f.read().strip()
            if len(tok) >= 32:
                return tok
        except Exception:
            pass
    tok = secrets.token_urlsafe(32)
    with open(ADMIN_TOKEN_FILE, "w", encoding="utf-8") as f:
        f.write(tok)
    return tok


def is_authorized_admin_request(client_ip: str, headers: Dict[str, str], require_token_always: bool = False) -> tuple[bool, str]:
    """
    التحقق من صلاحية تنفيذ عمليات خطيرة أو إدارية (مثل استعادة نسخة احتياطية أو إعادة التهيئة):
    - يرفض أي طلب قادم عبر بروكسي الإنترنت/Cloudflare (وجود CF-Connecting-IP أو CF-Ray أو X-Forwarded-For) ما لم يحمل X-Admin-Token صحيح.
    - للاستعادة (require_token_always=True)، يشترط إما رمز X-Admin-Token المطابق أو استدعاء محلي مباشر صريح مع تأكيد كتابي.
    """
    norm_headers = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
    supplied_token = norm_headers.get("x-admin-token", "").strip()
    auth_hdr = norm_headers.get("authorization", "").strip()
    if not supplied_token and auth_hdr.lower().startswith("bearer "):
        supplied_token = auth_hdr[7:].strip()

    expected_token = get_or_create_admin_token()
    if supplied_token and hmac.compare_digest(supplied_token, expected_token):
        return True, "authorized_by_admin_token"

    if require_token_always:
        return False, "ممنوع: تتطلب هذه العملية الحساسة رمز الصلاحية الإداري (X-Admin-Token)."

    # الكشف الصارم عن الطلبات الممررة عبر نفق Cloudflare أو أي بروكسي خارجي
    proxy_markers = ("cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-real-ip", "cf-visitor")
    is_proxied = any(h in norm_headers and norm_headers[h].strip() for h in proxy_markers)
    is_loopback = client_ip in ("127.0.0.1", "::1", "localhost")

    if is_loopback and not is_proxied:
        return True, "authorized_direct_localhost"

    return False, "غير مصرح: هذه العملية محظورة عبر الاتصال الخارجي وتتطلب رمز الصلاحية الإداري (X-Admin-Token)."


def get_resolved_db_path() -> str:
    """إرجاع المسار المطلق الفعلي لقاعدة البيانات مع منع المسارات النسبية العشوائية."""
    env_path = os.environ.get("INVENTORY_DB_PATH", "").strip()
    if not env_path:
        return PERMANENT_DB_PATH
    if env_path == ":memory:":
        return ":memory:"
    return os.path.abspath(env_path)


def is_using_permanent_db() -> bool:
    return get_resolved_db_path() == PERMANENT_DB_PATH


def ensure_safe_db_target(require_existing_if_populated: bool = True) -> str:
    """
    التأكد أن المسار المستخدم آمن وليس قاعدة فارغة جديدة محل قاعدة موجودة،
    وأن الحفظ مسموح ولم يتعطل بفحص السلامة.
    """
    db_path = get_resolved_db_path()
    if db_path == ":memory:":
        return db_path

    temp_dir = os.path.abspath(os.path.join(BASE_DIR, "temp"))
    if os.path.commonpath([db_path, temp_dir]) == temp_dir:
        raise DatabaseSafetyError(
            f"مسار قاعدة البيانات غير آمن (داخل temp): {db_path}. تم إيقاف الكتابة لحماية البيانات."
        )

    with _db_guard_lock:
        if _db_state["write_blocked"]:
            raise DatabaseSafetyError(
                _db_state["last_error"]
                or "تم إيقاف الكتابة مؤقتاً لحماية قاعدة البيانات بعد فشل فحص السلامة."
            )

    if (
        require_existing_if_populated
        and db_path == PERMANENT_DB_PATH
        and not os.path.exists(db_path)
    ):
        existing_backups = list_backups()
        if existing_backups:
            msg = (
                "تنبيه أمني: ملف قاعدة البيانات الدائم (data/inventory.db) غير موجود رغم وجود نسخ احتياطية سابقة! "
                "تم منع إنشاء قاعدة بيانات فارغة لحماية بياناتك. قم بالاستعادة من مجلد backups."
            )
            with _db_guard_lock:
                _db_state["healthy"] = False
                _db_state["write_blocked"] = True
                _db_state["last_error"] = msg
            get_server_logger().critical(msg)
            raise DatabaseSafetyError(msg)

    return db_path


def checkpoint_wal(db_path: Optional[str] = None, mode: str = "PASSIVE") -> Dict[str, Any]:
    """دمج بيانات WAL في ملف القاعدة الرئيسي لضمان عدم بقاء أي تعديلات غير مدمجة."""
    target = db_path or get_resolved_db_path()
    if target == ":memory:" or not os.path.exists(target):
        return {"ok": False, "reason": "no_file"}
    valid_mode = mode.upper() if mode.upper() in ("PASSIVE", "FULL", "RESTART", "TRUNCATE") else "PASSIVE"
    conn = None
    try:
        conn = sqlite3.connect(target, timeout=15)
        res = conn.execute(f"PRAGMA wal_checkpoint({valid_mode});").fetchone()
        return {"ok": True, "mode": valid_mode, "result": list(res) if res else []}
    except Exception as e:
        get_server_logger().warning(f"WAL checkpoint ({valid_mode}) warning: {e}")
        return {"ok": False, "error": str(e)}
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def _read_table_counts(conn: sqlite3.Connection) -> Dict[str, int]:
    existing_tables = {
        r[0]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    counts: Dict[str, int] = {}
    for t in CORE_TABLES:
        if t in existing_tables:
            counts[t] = conn.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
    return counts


def check_db_health(deep: bool = False) -> Dict[str, Any]:
    """فحص شامل لسلامة قاعدة البيانات، المسار الدائم، ملفات WAL/SHM، وعدد السجلات."""
    db_path = get_resolved_db_path()
    logger = get_server_logger()
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    result: Dict[str, Any] = {
        "healthy": False,
        "write_blocked": False,
        "db_path": db_path,
        "is_permanent_path": is_using_permanent_db(),
        "external_backup_dir": EXTERNAL_BACKUP_DIR,
        "db_exists": False,
        "db_size_bytes": 0,
        "wal_exists": False,
        "wal_size_bytes": 0,
        "shm_exists": False,
        "integrity": "unknown",
        "missing_tables": [],
        "counts": {},
        "last_check_at": now_str,
        "last_backup_at": _db_state.get("last_backup_at"),
        "last_backup_path": _db_state.get("last_backup_path"),
        "last_external_backup_path": _db_state.get("last_external_backup_path"),
        "server_started_at": _db_state.get("server_started_at"),
        "server_pid": os.getpid(),
        "error": None,
    }

    if db_path == ":memory:":
        result["healthy"] = True
        result["integrity"] = "ok"
        return result

    if not os.path.exists(db_path):
        msg = f"ملف قاعدة البيانات غير موجود في المسار الدائم: {db_path}"
        result["error"] = msg
        existing_backups = list_backups()
        if db_path == PERMANENT_DB_PATH and existing_backups:
            result["write_blocked"] = True
            with _db_guard_lock:
                _db_state["healthy"] = False
                _db_state["write_blocked"] = True
                _db_state["last_error"] = msg
                _db_state["last_check_at"] = now_str
        logger.error(msg)
        return result

    result["db_exists"] = True
    try:
        result["db_size_bytes"] = os.path.getsize(db_path)
        wal_path = db_path + "-wal"
        shm_path = db_path + "-shm"
        if os.path.exists(wal_path):
            result["wal_exists"] = True
            result["wal_size_bytes"] = os.path.getsize(wal_path)
        if os.path.exists(shm_path):
            result["shm_exists"] = True
    except Exception:
        pass

    conn = None
    try:
        conn = sqlite3.connect(db_path, timeout=15)
        conn.execute("PRAGMA busy_timeout = 15000;")
        pragma_cmd = "PRAGMA integrity_check;" if deep else "PRAGMA quick_check;"
        check_rows = conn.execute(pragma_cmd).fetchall()
        integrity_val = check_rows[0][0] if check_rows else "unknown"
        result["integrity"] = integrity_val
        if integrity_val != "ok":
            raise DatabaseSafetyError(f"فشل فحص سلامة SQLite ({pragma_cmd}): {integrity_val}")

        counts = _read_table_counts(conn)
        result["missing_tables"] = [t for t in CORE_TABLES if t not in counts]
        result["counts"] = counts
        result["healthy"] = True
        with _db_guard_lock:
            _db_state["healthy"] = True
            _db_state["write_blocked"] = False
            _db_state["last_error"] = None
            _db_state["last_check_at"] = now_str
        return result
    except sqlite3.OperationalError as e:
        # قفل مؤقت أثناء كتابة أخرى ليس تلفاً: لا نوقف الحفظ (كان يعطل الحفظ 15 دقيقة كاملة)
        if "locked" in str(e).lower() or "busy" in str(e).lower():
            result["healthy"] = True
            result["integrity"] = "skipped_busy"
            result["error"] = f"transient: {e}"
            logger.warning(f"DB health check skipped (busy): {e}")
            return result
        err = f"خطأ في فحص قاعدة البيانات: {e}"
        result["healthy"] = False
        result["write_blocked"] = True
        result["error"] = err
        with _db_guard_lock:
            _db_state["healthy"] = False
            _db_state["write_blocked"] = True
            _db_state["last_error"] = err
            _db_state["last_check_at"] = now_str
        logger.error(err)
        return result
    except Exception as e:
        err = f"خطأ في فحص قاعدة البيانات: {e}"
        result["healthy"] = False
        result["write_blocked"] = True
        result["error"] = err
        with _db_guard_lock:
            _db_state["healthy"] = False
            _db_state["write_blocked"] = True
            _db_state["last_error"] = err
            _db_state["last_check_at"] = now_str
        logger.error(err)
        return result
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass


def fast_health_status() -> Dict[str, Any]:
    """فحص خفيف وفوري لـ /api/health بدون قراءة قاعدة البيانات.

    الفحص الكامل (quick_check + عدّ الجداول) كان يُنفَّذ مع كل طلب صحة من الواجهة والمراقب،
    وأثناء أي كتابة ثقيلة (استيراد/مزامنة) كان ينتظر القفل حتى 15 ثانية فيظن المراقب أن الخادم معلّق
    فيقتله، وتظهر للمستخدم رسالة "جاري تجديد الاتصال". الفحص الكامل يعمل دورياً في الخلفية كل 15 دقيقة،
    وهنا نعيد آخر نتيجة له فقط. إذا كانت آخر نتيجة غير سليمة نعيد الفحص الكامل لاكتشاف التعافي.
    """
    try:
        db_path = get_resolved_db_path()
    except Exception:
        return check_db_health(deep=False)
    with _db_guard_lock:
        state = dict(_db_state)
    exists = db_path == ":memory:" or os.path.exists(db_path)
    if not state.get("healthy") or state.get("write_blocked") or not exists:
        return check_db_health(deep=False)
    return {
        "healthy": True,
        "write_blocked": False,
        "mode": "fast",
        "db_path": db_path,
        "db_exists": True,
        "is_permanent_path": is_using_permanent_db(),
        "last_check_at": state.get("last_check_at"),
        "last_backup_at": state.get("last_backup_at"),
        "server_started_at": state.get("server_started_at"),
        "server_pid": os.getpid(),
        "error": None,
    }


def list_backups() -> List[Dict[str, Any]]:
    """إرجاع قائمة النسخ الاحتياطية المتوفرة (داخل backups/ ونسخ المجلد المستقل)."""
    os.makedirs(BACKUP_DIR, exist_ok=True)
    seen_names = set()
    items = []
    search_dirs = [BACKUP_DIR]
    if is_using_permanent_db() and os.path.isdir(EXTERNAL_BACKUP_DIR):
        search_dirs.append(EXTERNAL_BACKUP_DIR)

    for folder in search_dirs:
        files = sorted(
            glob.glob(os.path.join(folder, "inventory_backup_*.db")),
            key=lambda p: os.path.getmtime(p),
            reverse=True,
        )
        for f in files:
            name = os.path.basename(f)
            if name in seen_names:
                continue
            seen_names.add(name)
            try:
                st = os.stat(f)
                items.append({
                    "file_name": name,
                    "path": os.path.abspath(f),
                    "location": "external_independent" if folder == EXTERNAL_BACKUP_DIR else "project_backups",
                    "size_bytes": st.st_size,
                    "created_at": datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"),
                })
            except Exception:
                pass
    items.sort(key=lambda x: x["created_at"], reverse=True)
    return items


def _prune_old_backups(folder: str, keep: int = MAX_BACKUPS_TO_KEEP) -> None:
    files = sorted(
        glob.glob(os.path.join(folder, "inventory_backup_*.db")),
        key=lambda p: os.path.getmtime(p),
        reverse=True,
    )
    for old_path in files[keep:]:
        try:
            os.remove(old_path)
        except Exception:
            pass


def create_backup(reason: str = "auto") -> Dict[str, Any]:
    """
    إنشاء نسخة احتياطية متسقة وآمنة باستخدام sqlite3.Connection.backup()
    مع التحقق من سلامتها (PRAGMA quick_check) وحفظ نسخة مطابقة مستقلة في EXTERNAL_BACKUP_DIR.
    """
    db_path = get_resolved_db_path()
    logger = get_server_logger()

    if db_path == ":memory:" or not os.path.exists(db_path):
        return {"success": False, "message": "لا يوجد ملف قاعدة بيانات فعلي لعمل نسخة احتياطية."}

    os.makedirs(BACKUP_DIR, exist_ok=True)
    safe_reason = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in (reason or "auto"))[:24]
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    file_name = f"inventory_backup_{ts}_{safe_reason}.db"
    backup_path = os.path.abspath(os.path.join(BACKUP_DIR, file_name))
    tmp_path = backup_path + ".tmp"

    src_conn = None
    dst_conn = None
    try:
        checkpoint_wal(db_path, mode="PASSIVE")

        src_conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=30)
        dst_conn = sqlite3.connect(tmp_path, timeout=30)
        with dst_conn:
            src_conn.backup(dst_conn)
        dst_conn.close()
        dst_conn = None
        src_conn.close()
        src_conn = None

        verify_conn = sqlite3.connect(tmp_path, timeout=15)
        try:
            chk = verify_conn.execute("PRAGMA quick_check;").fetchone()
            if not chk or chk[0] != "ok":
                raise RuntimeError(f"فشل التحقق من سلامة النسخة الاحتياطية: {chk}")
            prod_cnt = verify_conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        finally:
            verify_conn.close()

        os.replace(tmp_path, backup_path)
        _prune_old_backups(BACKUP_DIR)

        ext_path = None
        if is_using_permanent_db():
            try:
                os.makedirs(EXTERNAL_BACKUP_DIR, exist_ok=True)
                ext_target = os.path.abspath(os.path.join(EXTERNAL_BACKUP_DIR, file_name))
                ext_tmp = ext_target + ".tmp"
                shutil.copy2(backup_path, ext_tmp)
                os.replace(ext_tmp, ext_target)
                _prune_old_backups(EXTERNAL_BACKUP_DIR)
                ext_path = ext_target
            except Exception as ext_err:
                logger.warning(f"External backup mirror warning: {ext_err}")

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with _db_guard_lock:
            _db_state["last_backup_at"] = now_str
            _db_state["last_backup_path"] = backup_path
            if ext_path:
                _db_state["last_external_backup_path"] = ext_path

        logger.info(
            f"Backup created & verified: {file_name} "
            f"(size={os.path.getsize(backup_path)} bytes, products={prod_cnt}, external={ext_path}, reason={safe_reason})"
        )
        return {
            "success": True,
            "path": backup_path,
            "external_path": ext_path,
            "file_name": file_name,
            "size_bytes": os.path.getsize(backup_path),
            "products_count": prod_cnt,
            "created_at": now_str,
        }
    except Exception as e:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except Exception:
                pass
        logger.error(f"Failed to create backup ({safe_reason}): {e}")
        return {"success": False, "message": f"فشل إنشاء النسخة الاحتياطية: {e}"}
    finally:
        for c in (dst_conn, src_conn):
            if c:
                try:
                    c.close()
                except Exception:
                    pass


def restore_backup(
    backup_path: str,
    target_db_path: Optional[str] = None,
    confirm_overwrite_newer: bool = False,
) -> Dict[str, Any]:
    """
    استعادة قاعدة البيانات من نسخة احتياطية بعد التحقق من سلامتها.
    يحمي القاعدة الأحدث أو الأكثر بيانات: إذا كانت القاعدة الحالية أحدث زمنياً أو تحتوي على سجلات أكثر
    من النسخة الاحتياطية، تُرفض الاستعادة تلقائياً ما لم يتم تمرير confirm_overwrite_newer=True صراحةً.
    """
    logger = get_server_logger()
    target = os.path.abspath(target_db_path or get_resolved_db_path())
    src = os.path.abspath(backup_path)

    if not os.path.isfile(src):
        return {"success": False, "message": f"ملف النسخة الاحتياطية غير موجود: {src}"}

    # 1. فحص سلامة النسخة الاحتياطية
    chk_conn = sqlite3.connect(src, timeout=15)
    try:
        chk = chk_conn.execute("PRAGMA quick_check;").fetchone()
        if not chk or chk[0] != "ok":
            return {"success": False, "message": f"النسخة الاحتياطية تالفة ولا يمكن استعادتها: {chk}"}
        backup_counts = _read_table_counts(chk_conn)
    finally:
        chk_conn.close()

    # 2. التحقق الصارم: هل القاعدة الحالية أحدث أو فيها بيانات أكثر؟
    if os.path.isfile(target) and os.path.getsize(target) > 0:
        try:
            tgt_conn = sqlite3.connect(f"file:{target}?mode=ro", uri=True, timeout=15)
            try:
                tgt_ok = tgt_conn.execute("PRAGMA quick_check;").fetchone()
                target_healthy = bool(tgt_ok and tgt_ok[0] == "ok")
                target_counts = _read_table_counts(tgt_conn) if target_healthy else {}
            finally:
                tgt_conn.close()

            if target_healthy:
                target_mtime = os.path.getmtime(target)
                backup_mtime = os.path.getmtime(src)
                target_has_more = any(
                    target_counts.get(k, 0) > backup_counts.get(k, 0) for k in CORE_TABLES
                )
                is_target_newer = target_mtime > backup_mtime + 1.0

                if (is_target_newer or target_has_more) and not confirm_overwrite_newer:
                    msg = (
                        "تم رفض الاستعادة تلقائياً: قاعدة البيانات الحالية أحدث أو تحتوي على بيانات أكثر "
                        "من هذه النسخة الاحتياطية. تتطلب الاستعادة موافقة صريحة (confirm_overwrite_newer=true)."
                    )
                    logger.warning(f"Blocked downgrade restore without explicit confirmation: {src} -> {target}")
                    return {
                        "success": False,
                        "requires_explicit_confirmation": True,
                        "code": "NEWER_DATABASE_PROTECTED",
                        "message": msg,
                        "target_counts": target_counts,
                        "backup_counts": backup_counts,
                    }
        except Exception:
            pass

        # أخذ نسخة أمان إضافية قبل الاستبدال
        try:
            create_backup(reason="pre_restore")
        except Exception:
            pass

    src_conn = None
    dst_conn = None
    try:
        os.makedirs(os.path.dirname(target), exist_ok=True)
        src_conn = sqlite3.connect(src, timeout=30)
        dst_conn = sqlite3.connect(target, timeout=30)
        with dst_conn:
            src_conn.backup(dst_conn)
        dst_conn.execute("PRAGMA wal_checkpoint(TRUNCATE);")
        dst_conn.close()
        dst_conn = None
        src_conn.close()
        src_conn = None

        with _db_guard_lock:
            _db_state["write_blocked"] = False
            _db_state["healthy"] = True
            _db_state["last_error"] = None

        logger.warning(f"Database restored from backup (explicit={confirm_overwrite_newer}): {src} -> {target}")
        return {"success": True, "restored_from": src, "target": target}
    except Exception as e:
        logger.error(f"Database restore failed: {e}")
        return {"success": False, "message": f"فشل استعادة النسخة الاحتياطية: {e}"}
    finally:
        for c in (dst_conn, src_conn):
            if c:
                try:
                    c.close()
                except Exception:
                    pass


def get_db_state_snapshot() -> Dict[str, Any]:
    with _db_guard_lock:
        return dict(_db_state)
