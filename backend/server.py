import os
import sys
import re
import json
import uuid
import logging
import mimetypes
import time
import socket
from urllib.parse import urlparse, parse_qs, quote
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from datetime import datetime

logger = logging.getLogger("server")

try:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    if hasattr(sys.stderr, 'reconfigure'):
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except:
    pass

try:
    from .db import (
        init_db, get_stats, get_next_product_code,
        save_or_update_product, delete_product, bulk_delete_products, search_products, search_preinventory_products,
        get_product_by_code, find_product_by_gtin_or_barcode,
        get_or_create_draft_invoice, create_new_invoice, get_invoice_details,
        scan_qr_to_invoice, delete_scanned_serial, delete_invoice_line,
        clear_invoice_lines, update_invoice_line_quantity, add_manual_item_to_invoice,
        confirm_invoice, process_serial_return, get_all_invoices,
        get_all_products, get_aliases, save_alias, clear_catalog,
        get_all_supplier_templates, save_supplier_template, delete_supplier_template,
        get_audit_logs
    )
    from .qr_parser import parse_qr_code, extract_clean_gtin
    from .catalog_importer import (
        inspect_excel_catalog, preview_import_catalog, commit_import_catalog
    )
    from .invoice_file_importer import import_invoice_file_to_active_invoice
    from .excel_exporter import export_invoice_to_excel, export_invoice_stock_count_to_excel, export_invoice_custom_columns_to_excel, export_catalog_to_excel
    from .stock_manager import (
        get_all_stores, create_new_store, update_store, delete_store,
        get_store_stocktake_details, search_store_stocktake_items, scan_item_to_store,
        update_entry_quantity, delete_entry_item,
        clear_store_stocktake, settle_store_stocktake, commit_stores_stocktake, populate_store_from_inventory, save_stock_batch_count,
        upload_inventory_excel, export_store_stocktake_to_excel,
        clear_inventory_records, bulk_delete_stock_entries, edit_stocktake_entry,
        reset_all_stocktake_test_data, get_uncounted_store_items, export_uncounted_items_to_excel
    )
except (ImportError, ValueError):
    from backend.db import (
        init_db, get_stats, get_next_product_code,
        save_or_update_product, delete_product, bulk_delete_products, search_products, search_preinventory_products,
        get_product_by_code, find_product_by_gtin_or_barcode,
        get_or_create_draft_invoice, create_new_invoice, get_invoice_details,
        scan_qr_to_invoice, delete_scanned_serial, delete_invoice_line,
        clear_invoice_lines, update_invoice_line_quantity, add_manual_item_to_invoice,
        confirm_invoice, process_serial_return, get_all_invoices,
        get_all_products, get_aliases, save_alias, clear_catalog,
        get_all_supplier_templates, save_supplier_template, delete_supplier_template,
        get_audit_logs
    )
    from backend.qr_parser import parse_qr_code, extract_clean_gtin
    from backend.catalog_importer import (
        inspect_excel_catalog, preview_import_catalog, commit_import_catalog
    )
    from backend.invoice_file_importer import import_invoice_file_to_active_invoice
    from backend.excel_exporter import export_invoice_to_excel, export_invoice_stock_count_to_excel, export_invoice_custom_columns_to_excel, export_catalog_to_excel
    from backend.stock_manager import (
        get_all_stores, create_new_store, update_store, delete_store,
        get_store_stocktake_details, search_store_stocktake_items, scan_item_to_store,
        update_entry_quantity, delete_entry_item,
        clear_store_stocktake, settle_store_stocktake, commit_stores_stocktake, populate_store_from_inventory, save_stock_batch_count,
        upload_inventory_excel, export_store_stocktake_to_excel,
        clear_inventory_records, bulk_delete_stock_entries, edit_stocktake_entry,
        reset_all_stocktake_test_data, get_uncounted_store_items, export_uncounted_items_to_excel
    )

try:
    from .catalog_autosync import start_autosync, sync_now as catalog_sync_now, get_status as catalog_sync_status
    from .db_safety import (
        DatabaseSafetyError,
        AUTO_BACKUP_INTERVAL_SECONDS,
        get_server_logger,
        check_db_health,
        checkpoint_wal,
        create_backup,
        list_backups,
        restore_backup,
        ensure_safe_db_target,
        get_or_create_admin_token,
        is_authorized_admin_request,
        BACKUP_DIR,
        EXTERNAL_BACKUP_DIR,
    )
except (ImportError, ValueError):
    from backend.catalog_autosync import start_autosync, sync_now as catalog_sync_now, get_status as catalog_sync_status
    from backend.db_safety import (
        DatabaseSafetyError,
        AUTO_BACKUP_INTERVAL_SECONDS,
        get_server_logger,
        check_db_health,
        checkpoint_wal,
        create_backup,
        list_backups,
        restore_backup,
        ensure_safe_db_target,
        get_or_create_admin_token,
        is_authorized_admin_request,
        BACKUP_DIR,
        EXTERNAL_BACKUP_DIR,
    )

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
TEMP_DIR = os.path.join(BASE_DIR, "temp")
os.makedirs(TEMP_DIR, exist_ok=True)

def auto_open_file(file_path: str) -> bool:
    """
    1. ضمان حفظ ونسخ الملف مباشرة في مجلد التنزيلات C:\\Users\\PH\\Downloads ليكون في متناول يد المستخدم فوراً
    2. تشغيل الملف أوتوماتيكياً في برنامج Microsoft Excel أو المشغل الافتراضي
    """
    if not file_path or not os.path.exists(file_path):
        return False
    abs_path = os.path.abspath(file_path)

    # 1. نسخ أو حفظ الملف مباشرة في مجلد Downloads الخاص بالمستخدم
    saved_target = abs_path
    try:
        downloads_dir = os.path.join(os.path.expanduser('~'), 'Downloads')
        if os.path.isdir(downloads_dir):
            file_name = os.path.basename(abs_path)
            target = os.path.join(downloads_dir, file_name)
            try:
                import shutil
                shutil.copy2(abs_path, target)
                saved_target = target
                logger.info(f"File copied directly to Downloads: {target}")
            except Exception:
                # إذا كان الملف محجوزاً حالياً في برنامج Excel، نحفظه باسم مميز مع التوقيت
                ts = datetime.now().strftime("%Y%m%d_%H%M%S")
                base, ext = os.path.splitext(file_name)
                target = os.path.join(downloads_dir, f"{base}_{ts}{ext}")
                try:
                    import shutil
                    shutil.copy2(abs_path, target)
                    saved_target = target
                    logger.info(f"File copied to Downloads with timestamp: {target}")
                except Exception:
                    pass
    except Exception as e:
        logger.warning(f"Error copying to downloads: {e}")

    # 2. تشغيل الملف في برنامج Microsoft Excel
    opened = False
    if sys.platform == 'win32':
        # أ) البحث عن مسار تطبيق Microsoft Excel وتشغيله بالملف
        excel_candidates = [
            r"C:\Program Files (x86)\Microsoft Office\Root\Office16\EXCEL.EXE",
            r"C:\Program Files\Microsoft Office\Root\Office16\EXCEL.EXE",
            r"C:\Program Files (x86)\Microsoft Office\Office16\EXCEL.EXE",
            r"C:\Program Files\Microsoft Office\Office16\EXCEL.EXE",
            r"C:\Program Files (x86)\Microsoft Office\Office15\EXCEL.EXE",
            r"C:\Program Files\Microsoft Office\Office15\EXCEL.EXE",
        ]
        excel_exe = next((p for p in excel_candidates if os.path.isfile(p)), None)
        if excel_exe:
            try:
                import subprocess
                flags = 0x00000008 | 0x00000200 # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
                subprocess.Popen([excel_exe, saved_target], creationflags=flags)
                opened = True
                logger.info(f"Launched Excel directly: {excel_exe} on {saved_target}")
            except Exception as e:
                logger.warning(f"Failed to launch Excel directly: {e}")

        # ب) استخدام os.startfile كخيار مساند قياسي
        if not opened and hasattr(os, 'startfile'):
            try:
                os.startfile(saved_target)
                opened = True
                logger.info(f"Opened via os.startfile: {saved_target}")
            except Exception as e:
                logger.warning(f"os.startfile failed: {e}")

        # ج) فتح عبر أمر cmd start
        if not opened:
            try:
                import subprocess
                subprocess.Popen(f'cmd.exe /c start "" "{saved_target}"', shell=True)
                opened = True
                logger.info(f"Opened via cmd start: {saved_target}")
            except Exception as e:
                logger.warning(f"cmd start failed: {e}")

    elif sys.platform == 'darwin':
        import subprocess
        subprocess.Popen(['open', saved_target])
        opened = True
    else:
        import subprocess
        subprocess.Popen(['xdg-open', saved_target])
        opened = True

    return opened

# تهيئة قاعدة البيانات عند بدء السيرفر
init_db()

def make_content_disposition(file_name: str, disposition: str = "attachment") -> str:
    """
    تكوين ترويسة Content-Disposition متوافقة تماماً مع معيار RFC 5987 / RFC 6266
    تمنع خطأ الترميز latin-1 في http.server عند وجود أسماء باللغة العربية
    مع الحفاظ على الاسم العربي الأصلي للملف داخل المتصفحات ونظام التشغيل
    """
    clean_fn = os.path.basename(file_name or "export.xlsx")
    ascii_name = re.sub(r'[^a-zA-Z0-9_\.-]', '_', clean_fn).strip('_')
    ext = os.path.splitext(clean_fn)[1] or '.xlsx'
    if not ascii_name or not ascii_name.lower().endswith(('.xlsx', '.xls', '.csv', '.pdf', '.txt')):
        ascii_name = f"export{ext}"
    encoded_fn = quote(clean_fn)
    return f"{disposition}; filename=\"{ascii_name}\"; filename*=UTF-8''{encoded_fn}"

MOBILE_SCANS_QUEUE = []
SYNC_EVENTS_QUEUE = []

def get_cloudflare_url() -> str:
    """قراءة رابط نفق Cloudflare النشط إن وجد"""
    try:
        cf_file = os.path.join(TEMP_DIR, "cloudflare_url.txt")
        if os.path.exists(cf_file):
            with open(cf_file, "r", encoding="utf-8") as f:
                url = f.read().strip()
                if url.startswith("http"):
                    # الرابط الثابت الخاص بالبرنامج (لا يتغير مع تجديد النفق المؤقت)
                    fixed = os.environ.get("RAMBFE_FIXED_URL", "https://rambfe.pages.dev").strip()
                    return (fixed or url).rstrip('/')
    except Exception:
        pass
    return ""

def broadcast_sync(evt_type: str, payload: dict) -> dict:
    """بث أحداث المزامنة اللحظية لجميع الأجهزة المتصلة (كمبيوتر وموبايل)"""
    evt = {
        "id": uuid.uuid4().hex[:8],
        "type": evt_type,
        "payload": payload or {},
        "timestamp": time.time()
    }
    SYNC_EVENTS_QUEUE.append(evt)
    if len(SYNC_EVENTS_QUEUE) > 300:
        del SYNC_EVENTS_QUEUE[:150]
    return evt

def get_local_ip() -> str:
    """استخراج عنوان IP المحلي للجهاز على الشبكة المحلية / الواي فاي بدقة"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(('8.8.8.8', 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"

def extract_boundary(content_type_header: str) -> bytes:
    """استخراج قيمة الـ boundary بأمان من ترويسة الطلب"""
    if not content_type_header:
        return b""
    m = re.search(r'boundary=(?:"([^"]+)"|([^;]+))', content_type_header, re.IGNORECASE)
    if m:
        val = m.group(1) or m.group(2)
        return val.strip().encode('utf-8')
    return b""

def parse_multipart(body_bytes: bytes, boundary: bytes):
    """محلل مدمج متين لملفات Multipart Form Data يدعم الملفات الكبيرة والأسماء العربية"""
    if not boundary:
        return {}, {}
    parts = body_bytes.split(b"--" + boundary)
    files = {}
    fields = {}

    for part in parts:
        if not part or part in (b"--\r\n", b"--", b"\r\n"):
            continue
        if b"\r\n\r\n" in part:
            header_data, content = part.split(b"\r\n\r\n", 1)
            if content.endswith(b"\r\n"):
                content = content[:-2]
            elif content.endswith(b"\r\n--"):
                content = content[:-4]
                
            header_str = header_data.decode("utf-8", errors="ignore")
            name = None
            filename = None
            
            m_name = re.search(r'name="([^"]+)"', header_str)
            if m_name:
                name = m_name.group(1)
            else:
                m_name2 = re.search(r'name=([^;\r\n]+)', header_str)
                if m_name2:
                    name = m_name2.group(1).strip('"\' ')
            
            m_file = re.search(r'filename="([^"]+)"', header_str)
            if m_file:
                filename = m_file.group(1)
            else:
                m_file2 = re.search(r'filename\*?=(?:UTF-8\'\')?"?([^\r\n";]+)"?', header_str)
                if m_file2:
                    filename = m_file2.group(1).strip('"\' ')
                            
            if filename and name:
                files[name] = {"filename": filename, "content": content}
            elif name:
                fields[name] = content.decode("utf-8", errors="ignore")
                
    return fields, files

class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    # على ويندوز SO_REUSEADDR يسمح لعدة نسخ بفتح نفس المنفذ معاً (سبب تشغيل 3 خوادم متصارعة).
    # نستخدم ربطاً حصرياً بحيث تفشل أي نسخة ثانية فوراً بدلاً من العمل بصمت.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

class AppRequestHandler(BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        """توجيه سجلات الوصول إلى stdout لتجنب إيقاف PowerShell للعملية"""
        try:
            sys.stdout.write("%s - - [%s] %s\n" % (self.address_string(), self.log_date_time_string(), format % args))
            sys.stdout.flush()
        except:
            pass

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_full_body(self) -> bytes:
        """قراءة كامل جسم الطلب بدقة ومنع اقتطاع الملفات الكبيرة في مقبس ويندوز"""
        content_length = int(self.headers.get('Content-Length', 0))
        if content_length <= 0:
            return b""
        remaining = content_length
        chunks = []
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 65536))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        # 0. فحص صحة الخادم وقاعدة البيانات (Health Check)
        if path == '/api/health':
            deep = params.get('deep', ['0'])[0] == '1'
            health = check_db_health(deep=deep)
            health["cloudflare_url"] = get_cloudflare_url() or None
            health["success"] = bool(health.get("healthy"))
            self.send_json(health, status=200 if health["healthy"] else 503)
            return

        # 0.ب عرض قائمة النسخ الاحتياطية المتوفرة (محلي أو بتفويض إداري فقط)
        if path == '/api/backup/list':
            ok_auth, auth_msg = is_authorized_admin_request(self.client_address[0], dict(self.headers), require_token_always=False)
            if not ok_auth:
                get_server_logger().warning(f"Unauthorized /api/backup/list attempt from {self.client_address[0]}: {auth_msg}")
                self.send_json({"success": False, "message": auth_msg}, 403)
                return
            self.send_json({"success": True, "backups": list_backups()})
            return

        # 1. إحصائيات النظام
        if path == '/api/stats':
            try:
                self.send_json(get_stats())
            except DatabaseSafetyError as e:
                self.send_json({"success": False, "db_error": True, "message": str(e)}, 503)
            return

        # 1.ب بيانات شبكة الواي فاي ورابط Cloudflare للربط مع الجوال
        if path == '/api/network-info':
            ip = get_local_ip()
            port = self.server.server_address[1]
            cf_url = get_cloudflare_url()
            # الرابط السحابي المباشر لكامل ميزات البرنامج على الموبايل
            mobile_url = cf_url if cf_url else f"http://{ip}:{port}/"
            self.send_json({
                "ip": ip,
                "port": port,
                "mobile_url": mobile_url,
                "companion_url": f"{cf_url}/mobile" if cf_url else f"http://{ip}:{port}/mobile",
                "local_mobile_url": f"http://{ip}:{port}/",
                "cloudflare_url": cf_url or None,
                "is_cloudflare_active": bool(cf_url)
            })
            return

        # 1.ج استطلاع مسحات الجوال اللحظية (Polling للكمبيوتر)
        if path == '/api/mobile/poll':
            try:
                since = float(params.get('since', [0])[0] or 0)
            except:
                since = 0.0
            scans = [s for s in MOBILE_SCANS_QUEUE if s.get('timestamp', 0) > since]
            events = [e for e in SYNC_EVENTS_QUEUE if e.get('timestamp', 0) > since]
            self.send_json({"scans": scans, "events": events, "timestamp": time.time()})
            return

        # 1.د مسار استعلام أحداث المزامنة اللحظية الشاملة لجميع الأجهزة
        if path == '/api/sync/events':
            try:
                since = float(params.get('since', [0])[0] or 0)
            except:
                since = 0.0
            events = [e for e in SYNC_EVENTS_QUEUE if e.get('timestamp', 0) > since]
            self.send_json({"events": events, "timestamp": time.time()})
            return

        # 1.هـ حالة الربط التلقائي لملف الأصناف product.template.xlsx
        if path == '/api/catalog/auto-sync/status':
            self.send_json(catalog_sync_status())
            return

        # 2. توليد الكود الداخلي الرقمي التالي للصنف
        if path == '/api/catalog/next-code':
            self.send_json({"code": get_next_product_code()})
            return

        # 3. استعراض وبحث الأصناف (مع دعم وضع البداية الافتراضي أو البحث المعمم)
        if path == '/api/catalog/products':
            q = (params.get('query', [''])[0] or params.get('q', [''])[0]).lstrip()
            mode = params.get('mode', ['start'])[0].strip().lower()
            limit_str = params.get('limit', ['50'])[0]
            offset_str = params.get('offset', ['0'])[0]
            limit = int(limit_str) if limit_str.isdigit() else 50
            offset = int(offset_str) if offset_str.isdigit() else 0
            self.send_json(search_products(q, limit, offset, match_mode=mode))
            return

        # 3b. بحث شاشة الجرد المحصور بالأصناف ذات الرصيد الفعلي أو الجرد الجاري في المخزن المحدد فقط
        if path == '/api/stock/search':
            q = (params.get('query', [''])[0] or params.get('q', [''])[0]).lstrip()
            mode = params.get('mode', ['start'])[0].strip().lower()
            store_no = params.get('store_no', [''])[0].strip()
            limit_str = params.get('limit', ['50'])[0]
            offset_str = params.get('offset', ['0'])[0]
            limit = int(limit_str) if limit_str.isdigit() else 50
            offset = int(offset_str) if offset_str.isdigit() else 0
            self.send_json(search_products(q, limit, offset, match_mode=mode, stock_only=True, store_no=store_no))
            return

        # 3c. الخانة الأولى المستقلة في شاشة الجرد: البحث في المخزون الفعلي بالنظام قبل الجرد (عبر كافة المخازن)
        if path == '/api/stock/preinventory-search':
            q = (params.get('query', [''])[0] or params.get('q', [''])[0]).lstrip()
            mode = params.get('mode', ['start'])[0].strip().lower()
            stock_only = params.get('stock_only', ['0'])[0].strip().lower() in ('1', 'true', 'yes')
            limit_str = params.get('limit', ['100'])[0]
            offset_str = params.get('offset', ['0'])[0]
            limit = int(limit_str) if limit_str.isdigit() else 100
            offset = int(offset_str) if offset_str.isdigit() else 0
            self.send_json(search_preinventory_products(q, limit, offset, match_mode=mode, stock_only=stock_only))
            return

        # 3d. الخانة الثانية المستقلة في شاشة الجرد: البحث داخل جرد الاستور المحدد فقط
        if path == '/api/stock/store/search':
            q = (params.get('query', [''])[0] or params.get('q', [''])[0]).lstrip()
            mode = params.get('mode', ['start'])[0].strip().lower()
            store_no = params.get('store_no', [''])[0].strip()
            self.send_json(search_store_stocktake_items(store_no=store_no, query=q, match_mode=mode))
            return

        # 4. جلب صنف واحد بالكود
        if path == '/api/catalog/product':
            code = params.get('code', [''])[0].strip()
            prod = get_product_by_code(code)
            if prod:
                self.send_json({"success": True, "product": prod})
            else:
                self.send_json({"success": False, "message": "الصنف غير موجود"}, 404)
            return

        # 5. جلب مسودة الفاتورة الحالية أو إنشاء واحدة
        if path == '/api/invoice/active':
            inv = get_or_create_draft_invoice()
            self.send_json({"success": True, "invoice": inv})
            return

        # 6. استعراض قائمة الفواتير
        if path == '/api/invoices/list':
            limit_str = params.get('limit', ['50'])[0]
            offset_str = params.get('offset', ['0'])[0]
            limit = int(limit_str) if limit_str.isdigit() else 50
            offset = int(offset_str) if offset_str.isdigit() else 0
            invoices = get_all_invoices(limit, offset)
            self.send_json({"success": True, "invoices": invoices})
            return

        # 7. جلب تفاصيل فاتورة محددة
        if path == '/api/invoices/get':
            inv_id_str = params.get('id', ['0'])[0].strip()
            inv_id = int(inv_id_str) if inv_id_str.isdigit() else 0
            inv = get_invoice_details(inv_id)
            if inv:
                self.send_json({"success": True, "invoice": inv})
            else:
                self.send_json({"success": False, "message": "الفاتورة غير موجودة"}, 404)
            return

        # 8. تصدير وسحب أصناف الفاتورة إلى Excel (يدعم النموذج الأول للفاتورة والنموذج الثاني للجرد والكميات) وفتح الملف أوتوماتيكياً
        if path in ('/api/invoice/export-excel', '/api/invoice/export', '/api/invoice/export-stock-excel', '/api/invoice/export-stock'):
            inv_id_str = params.get('id', [''])[0].strip() or params.get('invoice_id', [''])[0].strip()
            inv_id = int(inv_id_str) if inv_id_str.isdigit() else 0
            if not inv_id:
                draft = get_or_create_draft_invoice()
                inv_id = draft['id']
            inv = get_invoice_details(inv_id)
            if not inv:
                self.send_json({"detail": "الفاتورة غير موجودة"}, 404)
                return

            fmt = params.get('format', [''])[0].strip().lower() or params.get('type', [''])[0].strip().lower()
            is_stock_format = (path in ('/api/invoice/export-stock-excel', '/api/invoice/export-stock')) or (fmt in ('stock', 'stock_count', 'counted', '2'))

            custom_sheet_name = params.get('sheet_name', [''])[0].strip() or params.get('title', [''])[0].strip()
            location_val = params.get('location_val', [''])[0].strip()
            safe_custom_file = re.sub(r'[\\/*?:"<>|]', '_', custom_sheet_name).strip() if custom_sheet_name else ""

            inv_number = inv.get("invoice_number", "INV")
            inv_date = inv.get("invoice_date", "2026-10-29")
            if is_stock_format:
                file_name = f"{safe_custom_file}.xlsx" if safe_custom_file else f"StockCount_{inv_number}_{inv_date}.xlsx"
                out_path = os.path.join(TEMP_DIR, file_name)
                out_path = export_invoice_stock_count_to_excel(inv, out_path, sheet_title=custom_sheet_name or None, location_value=location_val or None)
            else:
                file_name = f"{safe_custom_file}.xlsx" if safe_custom_file else f"Invoice_{inv_number}_{inv_date}.xlsx"
                out_path = os.path.join(TEMP_DIR, file_name)
                out_path = export_invoice_to_excel(inv, out_path, sheet_title=custom_sheet_name or None)

            file_name = os.path.basename(out_path)

            if os.path.exists(out_path):
                with open(out_path, 'rb') as f:
                    file_data = f.read()

                # فتح الملف أوتوماتيكياً في برنامج Excel فور سحبه
                auto_open_file(out_path)

                self.send_response(200)
                self.send_header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                self.send_header('Content-Disposition', make_content_disposition(file_name))
                self.send_header('Access-Control-Expose-Headers', 'Content-Disposition')
                self.send_header('Content-Length', str(len(file_data)))
                self.end_headers()
                self.wfile.write(file_data)
                return
            else:
                self.send_json({"detail": "فشل إنشاء ملف الإكسيل"}, 500)
                return

        # 8.أ-2 فتح ملف إكسيل الفاتورة مباشرة بدون انتظار التحميل (يدعم النموذج الأول والثاني)
        if path in ('/api/invoice/open-excel', '/api/invoice/open', '/api/invoice/open-stock-excel'):
            try:
                inv_id_str = params.get('id', [''])[0].strip() or params.get('invoice_id', [''])[0].strip()
                inv_id = int(inv_id_str) if inv_id_str.isdigit() else 0
                if not inv_id:
                    draft = get_or_create_draft_invoice()
                    inv_id = draft['id']
                inv = get_invoice_details(inv_id)
                if not inv:
                    self.send_json({"success": False, "message": "الفاتورة غير موجودة"}, 404)
                    return

                fmt = params.get('format', [''])[0].strip().lower() or params.get('type', [''])[0].strip().lower()
                is_stock_format = (path == '/api/invoice/open-stock-excel') or (fmt in ('stock', 'stock_count', 'counted', '2'))

                inv_number = inv.get("invoice_number", "INV")
                inv_date = inv.get("invoice_date", "2026-10-29")
                if is_stock_format:
                    file_name = f"StockCount_{inv_number}_{inv_date}.xlsx"
                    out_path = os.path.join(TEMP_DIR, file_name)
                    out_path = export_invoice_stock_count_to_excel(inv, out_path)
                else:
                    file_name = f"Invoice_{inv_number}_{inv_date}.xlsx"
                    out_path = os.path.join(TEMP_DIR, file_name)
                    out_path = export_invoice_to_excel(inv, out_path)

                file_name = os.path.basename(out_path)
                opened = auto_open_file(out_path)
                self.send_json({
                    "success": True,
                    "opened": opened,
                    "file_name": file_name,
                    "file_path": out_path,
                    "message": "تم سحب أصناف الفاتورة وفتح ملف Excel بنجاح." if opened else "تم سحب أصناف الفاتورة بنجاح."
                })
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 500)
            return

        # 8.ب تصدير كروت الأصناف إلى Excel (XLSX) مع فتح الملف أوتوماتيكياً ودعم النطاقات المحددة
        if path in ('/api/catalog/export-excel', '/api/catalog/export'):
            try:
                scope = params.get('scope', ['all'])[0].strip().lower()
                codes_param = params.get('codes', [''])[0].strip()
                selected_codes = [c.strip() for c in codes_param.split(',') if c.strip()] if codes_param else None

                inv_id_param = params.get('invoice_id', [''])[0].strip() or params.get('id', [''])[0].strip()
                inv_id = int(inv_id_param) if inv_id_param.isdigit() else None

                fields_param = params.get('fields', [''])[0].strip()
                selected_fields = [f.strip() for f in fields_param.split(',') if f.strip()] if fields_param else None

                if scope == 'invoice' and not inv_id:
                    draft = get_or_create_draft_invoice()
                    inv_id = draft['id'] if draft else None

                today_str = datetime.now().strftime("%Y%m%d_%H%M")
                if scope == 'selected' and selected_codes:
                    file_name = f"Products_Selected_{len(selected_codes)}_{today_str}.xlsx"
                elif scope == 'invoice' and inv_id:
                    file_name = f"Products_Invoice_{inv_id}_{today_str}.xlsx"
                else:
                    file_name = f"Products_Catalog_{today_str}.xlsx"

                out_path = os.path.join(TEMP_DIR, file_name)
                out_path = export_catalog_to_excel(out_path, product_codes=selected_codes, invoice_id=inv_id if scope == 'invoice' else None, selected_fields=selected_fields)
                file_name = os.path.basename(out_path)

                if os.path.exists(out_path):
                    with open(out_path, 'rb') as f:
                        file_data = f.read()

                    # فتح الملف أوتوماتيكياً في برنامج Excel فور سحبه
                    auto_open_file(out_path)

                    self.send_response(200)
                    self.send_header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                    self.send_header('Content-Disposition', make_content_disposition(file_name))
                    self.send_header('Access-Control-Expose-Headers', 'Content-Disposition')
                    self.send_header('Content-Length', str(len(file_data)))
                    self.end_headers()
                    self.wfile.write(file_data)
                    return
                else:
                    self.send_json({"detail": "فشل إنشاء ملف إكسيل دليل الأصناف"}, 500)
                    return
            except Exception as e:
                self.send_json({"detail": f"خطأ أثناء تصدير دليل الأصناف: {str(e)}"}, 500)
                return

        # 8.ج استعراض سجل المراجعة والتعديلات (Audit Log)
        if path == '/api/catalog/audit-logs':
            try:
                limit_str = params.get('limit', ['100'])[0]
                limit = int(limit_str) if limit_str.isdigit() else 100
                entity_type = params.get('type', [None])[0]
                entity_id = params.get('code', [None])[0] or params.get('id', [None])[0]
                logs = get_audit_logs(limit=limit, entity_type=entity_type, entity_id=entity_id)
                self.send_json({"success": True, "logs": logs})
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 9. نظام الجرد الفعلي ومطابقة الأرصدة (GET)
        if path == '/api/stock/stores':
            try:
                q = params.get('q', [''])[0].strip() or params.get('query', [''])[0].strip()
                self.send_json(get_all_stores(q))
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path == '/api/stock/store/details':
            try:
                store_no = params.get('store_no', ['ST-001'])[0].strip() or 'ST-001'
                q = (params.get('query', [''])[0] or params.get('q', [''])[0]).lstrip()
                res = get_store_stocktake_details(store_no, q)
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path in ('/api/stock/export-excel', '/api/stock/export'):
            try:
                store_no = params.get('store_no', ['ST-001'])[0].strip() or 'ST-001'
                sheet_title = params.get('sheet_name', [''])[0].strip() or params.get('title', [''])[0].strip()
                location_val = params.get('location_val', [''])[0].strip()
                safe_title = re.sub(r'[\\/*?:"<>|]', '_', sheet_title or store_no).strip()
                today_str = datetime.now().strftime("%Y%m%d_%H%M")
                file_name = f"Stocktake_{safe_title}_{today_str}.xlsx"
                out_path = os.path.join(TEMP_DIR, file_name)
                out_path = export_store_stocktake_to_excel(out_path, store_no, sheet_title=sheet_title or None, location_val=location_val or None)

                if os.path.exists(out_path):
                    with open(out_path, 'rb') as f:
                        file_data = f.read()

                    auto_open_file(out_path)

                    self.send_response(200)
                    self.send_header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                    self.send_header('Content-Disposition', make_content_disposition(file_name))
                    self.send_header('Access-Control-Expose-Headers', 'Content-Disposition')
                    self.send_header('Content-Length', str(len(file_data)))
                    self.end_headers()
                    self.wfile.write(file_data)
                    return
                else:
                    self.send_json({"detail": "فشل إنشاء ملف إكسيل الجرد"}, 500)
                    return
            except Exception as e:
                self.send_json({"detail": f"خطأ أثناء تصدير الجرد: {str(e)}"}, 500)
                return

        # تقرير الأصناف التي لم تُجرد (Estimated Not Found)
        if path == '/api/stock/uncounted':
            try:
                store_no = params.get('store_no', ['ST-001'])[0].strip() or 'ST-001'
                category = params.get('category', [''])[0].strip()
                data = get_uncounted_store_items(store_no, category)
                self.send_json(data)
                return
            except Exception as e:
                self.send_json({"detail": f"خطأ في جلب الأصناف غير المجرودة: {str(e)}"}, 500)
                return

        # تصدير إكسيل الأصناف التي لم تُجرد
        if path in ('/api/stock/uncounted/export-excel', '/api/stock/uncounted-export'):
            try:
                store_no = params.get('store_no', ['ST-001'])[0].strip() or 'ST-001'
                sheet_title = params.get('sheet_name', [''])[0].strip() or params.get('title', [''])[0].strip()
                safe_title = re.sub(r'[\\/*?:"<>|]', '_', sheet_title or f"NOT_FOUND_{store_no}").strip()
                today_str = datetime.now().strftime("%Y%m%d_%H%M")
                file_name = f"EstimatedNotFound_{safe_title}_{today_str}.xlsx"
                out_path = os.path.join(TEMP_DIR, file_name)
                out_path = export_uncounted_items_to_excel(out_path, store_no, sheet_title=sheet_title or None)

                if os.path.exists(out_path):
                    with open(out_path, 'rb') as f:
                        file_data = f.read()

                    auto_open_file(out_path)

                    self.send_response(200)
                    self.send_header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                    self.send_header('Content-Disposition', make_content_disposition(file_name))
                    self.send_header('Access-Control-Expose-Headers', 'Content-Disposition')
                    self.send_header('Content-Length', str(len(file_data)))
                    self.end_headers()
                    self.wfile.write(file_data)
                    return
                else:
                    self.send_json({"detail": "فشل إنشاء ملف إكسيل الأصناف غير المجرودة"}, 500)
                    return
            except Exception as e:
                self.send_json({"detail": f"خطأ أثناء تصدير إكسيل الأصناف غير المجرودة: {str(e)}"}, 500)
                return

        # خدمة ملفات الواجهة (Frontend Static Files)
        file_path = FRONTEND_DIR
        rel_path = path.lstrip('/')
        if not rel_path or rel_path == '/' or rel_path in ('app', 'index', 'index.html'):
            # شاشة التطبيق الكاملة للكمبيوتر والشاشات
            file_path = os.path.join(FRONTEND_DIR, 'index.html')
        elif rel_path in ('mobile', 'mobile.html', 'mobile-scanner', 'scanner', 'scanner-only'):
            # شاشة الجرد والمسح السريع المخصصة للموبايل
            file_path = os.path.join(FRONTEND_DIR, 'mobile.html')
        else:
            file_path = os.path.join(FRONTEND_DIR, rel_path)

        if os.path.exists(file_path) and os.path.isfile(file_path):
            mime_type, _ = mimetypes.guess_type(file_path)
            if not mime_type:
                mime_type = 'application/octet-stream'
            if mime_type.startswith('text/') or mime_type in ('application/javascript', 'application/json'):
                mime_type += '; charset=utf-8'

            with open(file_path, 'rb') as f:
                content = f.read()

            self.send_response(200)
            self.send_header('Content-Type', mime_type)
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
            self.end_headers()
            self.wfile.write(content)
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"404 Not Found")

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        body_bytes = self.read_full_body()
        content_type = self.headers.get('Content-Type', '')

        # نقاط نهاية النسخ الاحتياطي والاستعادة (محمية بالصلاحيات ومنع التراجع للخلف بدون موافقة صريحة)
        if path == '/api/backup/create':
            ok_auth, auth_msg = is_authorized_admin_request(self.client_address[0], dict(self.headers), require_token_always=False)
            if not ok_auth:
                get_server_logger().warning(f"Unauthorized /api/backup/create attempt from {self.client_address[0]}")
                self.send_json({"success": False, "message": auth_msg}, 403)
                return
            res = create_backup(reason="manual")
            self.send_json(res, status=200 if res.get("success") else 500)
            return

        if path == '/api/backup/restore':
            ok_auth, auth_msg = is_authorized_admin_request(self.client_address[0], dict(self.headers), require_token_always=True)
            if not ok_auth:
                get_server_logger().warning(f"Unauthorized /api/backup/restore attempt from {self.client_address[0]}")
                self.send_json({"success": False, "message": auth_msg}, 403)
                return
            try:
                data = json.loads(body_bytes.decode('utf-8') or '{}') if body_bytes else {}
                file_name = os.path.basename(str(data.get('file_name') or '').strip())
                if not file_name:
                    self.send_json({"success": False, "message": "يجب تحديد اسم ملف النسخة الاحتياطية."}, 400)
                    return
                confirm_newer = bool(data.get('confirm_overwrite_newer', False))
                cand_primary = os.path.join(BACKUP_DIR, file_name)
                cand_ext = os.path.join(EXTERNAL_BACKUP_DIR, file_name)
                chosen = cand_primary if os.path.isfile(cand_primary) else cand_ext
                res = restore_backup(chosen, confirm_overwrite_newer=confirm_newer)
                if res.get("requires_explicit_confirmation"):
                    self.send_json(res, status=409)
                    return
                self.send_json(res, status=200 if res.get("success") else 400)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # حارس الكتابة: إذا تعذر الوصول الآمن لقاعدة البيانات الدائمة، نوقف الحفظ فوراً برسالة واضحة
        try:
            ensure_safe_db_target(require_existing_if_populated=True)
        except DatabaseSafetyError as e:
            get_server_logger().error(f"Write blocked on {path}: {e}")
            self.send_json({"success": False, "db_error": True, "message": str(e)}, 503)
            return

        # 0. مزامنة ملف الأصناف المرتبط (product.template.xlsx) يدوياً الآن
        if path == '/api/catalog/auto-sync/run':
            try:
                data = json.loads(body_bytes.decode('utf-8') or '{}') if body_bytes else {}
            except Exception:
                data = {}
            force = bool(data.get('force', True))
            res = catalog_sync_now(force=force)
            res["status"] = catalog_sync_status()
            self.send_json(res)
            return

        # 1. حفظ أو تعديل بطاقة صنف
        if path == '/api/catalog/save':
            try:
                data = json.loads(body_bytes.decode('utf-8'))
                ok, code, msg = save_or_update_product(data)
                self.send_json({"success": ok, "code": code, "message": msg})
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 2. حذف بطاقة صنف أو حذف متعدد أو تفريغ الكتالوج
        if path == '/api/catalog/delete':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                code = data.get('code')
                codes = data.get('codes')
                clear_all = data.get('clear_all', False)
                if clear_all:
                    clear_catalog()
                    broadcast_sync('catalog_cleared', {})
                    self.send_json({"success": True, "message": "تم تفريغ دليل الأصناف بالكامل بنجاح"})
                    return
                if codes and isinstance(codes, list):
                    cnt = bulk_delete_products(codes)
                    broadcast_sync('catalog_bulk_deleted', {"codes": codes, "count": cnt})
                    self.send_json({"success": True, "deleted_count": cnt, "message": f"تم حذف {cnt} صنف بنجاح"})
                    return
                ok = delete_product(code)
                if ok:
                    broadcast_sync('catalog_deleted', {"code": code})
                self.send_json({"success": ok, "message": "تم حذف بطاقة الصنف بنجاح" if ok else "فشل الحذف"})
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 2.ب استخراج رقم GTIN النظيف من أي مسح QR أو باركود لكرت الصنف
        if path == '/api/catalog/parse-gtin':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                raw = str(data.get('raw', '')).strip()
                clean = extract_clean_gtin(raw)
                self.send_json({"success": True, "gtin": clean, "raw": raw})
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 2.ب-2 تحليل وقراءة كود GS1 QR بالكامل (GTIN, Serial, Batch, Expiry) للعرض قبل الفلترة
        if path == '/api/catalog/parse-gs1':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                raw = str(data.get('raw', '')).strip()
                parsed = parse_qr_code(raw)
                gtin = ""
                serial = ""
                batch = ""
                expiry = ""
                prod_date = ""
                if parsed and parsed.get("success"):
                    pdata = parsed.get("data", {})
                    gtin = pdata.get("gtin", "")
                    serial = pdata.get("serial", "")
                    batch = str(pdata.get("batch", "") or "").strip().upper()
                    expiry = pdata.get("expiry", "")
                    prod_date = pdata.get("prod_date", "")

                if not gtin:
                    gtin = extract_clean_gtin(raw)

                is_gs1 = bool(serial or batch or expiry or prod_date or (gtin and (raw.startswith("01") or "(01)" in raw or "/01/" in raw or len(raw) > 14)))

                self.send_json({
                    "success": True,
                    "is_gs1": is_gs1,
                    "gtin": gtin,
                    "serial": serial,
                    "batch": batch,
                    "expiry": expiry,
                    "prod_date": prod_date,
                    "raw": raw
                })
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 2.ج تصدير كروت أصناف محددة عبر POST (لتجنب قيود طول الرابط)
        if path in ('/api/catalog/export-excel', '/api/catalog/export'):
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                scope = str(data.get('scope', 'all')).strip().lower()
                selected_codes = data.get('codes')
                selected_fields = data.get('fields')
                inv_id = data.get('invoice_id')
                if scope == 'invoice' and not inv_id:
                    draft = get_or_create_draft_invoice()
                    inv_id = draft['id'] if draft else None

                today_str = datetime.now().strftime("%Y%m%d_%H%M")
                if scope == 'selected' and selected_codes:
                    file_name = f"Products_Selected_{len(selected_codes)}_{today_str}.xlsx"
                elif scope == 'invoice' and inv_id:
                    file_name = f"Products_Invoice_{inv_id}_{today_str}.xlsx"
                else:
                    file_name = f"Products_Catalog_{today_str}.xlsx"

                out_path = os.path.join(TEMP_DIR, file_name)
                out_path = export_catalog_to_excel(out_path, product_codes=selected_codes, invoice_id=inv_id if scope == 'invoice' else None, selected_fields=selected_fields)
                file_name = os.path.basename(out_path)

                if os.path.exists(out_path):
                    with open(out_path, 'rb') as f:
                        file_data = f.read()

                    # فتح الملف أوتوماتيكياً في برنامج Excel فور سحبه
                    auto_open_file(out_path)

                    self.send_response(200)
                    self.send_header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                    self.send_header('Content-Disposition', make_content_disposition(file_name))
                    self.send_header('Access-Control-Expose-Headers', 'Content-Disposition')
                    self.send_header('Content-Length', str(len(file_data)))
                    self.end_headers()
                    self.wfile.write(file_data)
                    return
                else:
                    self.send_json({"detail": "فشل إنشاء ملف الإكسيل"}, 500)
                    return
            except Exception as e:
                self.send_json({"detail": f"خطأ أثناء تصدير الأصناف: {str(e)}"}, 500)
                return

        # 2.ج-1 تصدير أصناف الفاتورة بمسميات أعمدة يحددها المستخدم يدوياً قبل التصدير
        if path == '/api/invoice/export-custom-excel':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                inv_id = int(data.get('id') or data.get('invoice_id') or 0)
                if not inv_id:
                    draft = get_or_create_draft_invoice()
                    inv_id = draft['id']
                inv = get_invoice_details(inv_id)
                if not inv:
                    self.send_json({"detail": "الفاتورة غير موجودة"}, 404)
                    return

                column_specs = data.get('columns') or []
                custom_sheet_name = str(data.get('sheet_name') or data.get('title') or '').strip()
                location_val = str(data.get('location_val') or '').strip()
                safe_custom_file = re.sub(r'[\\/*?:"<>|]', '_', custom_sheet_name).strip() if custom_sheet_name else ""

                inv_number = inv.get("invoice_number", "INV")
                inv_date = inv.get("invoice_date", "2026-10-29")
                file_name = f"{safe_custom_file}.xlsx" if safe_custom_file else f"Invoice_Custom_{inv_number}_{inv_date}.xlsx"
                out_path = os.path.join(TEMP_DIR, file_name)
                out_path = export_invoice_custom_columns_to_excel(
                    inv,
                    out_path,
                    column_specs,
                    sheet_title=custom_sheet_name or None,
                    location_value=location_val or None
                )
                file_name = os.path.basename(out_path)

                if os.path.exists(out_path):
                    with open(out_path, 'rb') as f:
                        file_data = f.read()

                    auto_open_file(out_path)

                    self.send_response(200)
                    self.send_header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
                    self.send_header('Content-Disposition', make_content_disposition(file_name))
                    self.send_header('Access-Control-Expose-Headers', 'Content-Disposition')
                    self.send_header('Content-Length', str(len(file_data)))
                    self.end_headers()
                    self.wfile.write(file_data)
                    return
                else:
                    self.send_json({"detail": "فشل إنشاء ملف الإكسيل المخصص"}, 500)
                    return
            except Exception as e:
                self.send_json({"detail": f"خطأ أثناء تصدير الإكسيل المخصص: {str(e)}"}, 500)
                return

        # 2.ج-2 فتح أي ملف في التطبيق الافتراضي (Excel) عند الطلب
        if path == '/api/system/open-file':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                target_path = data.get('file_path') or data.get('path')
                file_name = data.get('file_name')
                if not target_path and file_name:
                    target_path = os.path.join(TEMP_DIR, file_name)
                opened = auto_open_file(target_path) if target_path else False
                self.send_json({"success": opened, "opened": opened, "path": target_path})
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 3. رفع ملف Excel الأصناف لفحص الأعمدة والقيم (يدعم كلاً من /upload و /upload-excel)
        if path in ('/api/catalog/upload-excel', '/api/catalog/upload'):
            try:
                boundary = extract_boundary(content_type)
                fields, files = parse_multipart(body_bytes, boundary)
                file_obj = files.get('file') or files.get('excel') or (list(files.values())[0] if files else None)
                if not file_obj:
                    self.send_json({"success": False, "message": "لم يتم إرسال ملف Excel. يرجى اختيار ملف صالح."}, 400)
                    return

                raw_fn = file_obj.get('filename') or 'catalog.xlsx'
                clean_fn = re.sub(r'[^\w\.-]', '_', os.path.basename(raw_fn))
                if not clean_fn.lower().endswith(('.xlsx', '.xls', '.csv')):
                    clean_fn += '.xlsx'

                saved_name = f"catalog_{uuid.uuid4().hex[:8]}_{clean_fn}"
                saved_path = os.path.join(TEMP_DIR, saved_name)
                with open(saved_path, 'wb') as f:
                    f.write(file_obj['content'])

                info = inspect_excel_catalog(saved_path)
                info["file_id"] = saved_name
                self.send_json(info)
            except Exception as e:
                self.send_json({"success": False, "message": f"خطأ أثناء رفع ملف كروت الأصناف: {str(e)}"}, 500)
            return

        # 3.ب رفع ملف الفاتورة الموردة أو الإكسيل وتفريغها مباشرة داخل الفاتورة
        if path in ('/api/invoice/upload', '/api/invoice/upload-excel', '/api/invoice/upload-file', '/api/invoice/import-file'):
            try:
                boundary = extract_boundary(content_type)
                fields, files = parse_multipart(body_bytes, boundary)
                file_obj = files.get('file') or files.get('invoice') or (list(files.values())[0] if files else None)
                if not file_obj:
                    self.send_json({"success": False, "message": "لم يتم إرسال ملف الفاتورة."}, 400)
                    return

                raw_fn = file_obj.get('filename') or 'invoice.xlsx'
                clean_fn = re.sub(r'[^\w\.-]', '_', os.path.basename(raw_fn))
                if not clean_fn.lower().endswith(('.xlsx', '.xls', '.csv')):
                    clean_fn += '.xlsx'
                saved_name = f"invoice_{uuid.uuid4().hex[:8]}_{clean_fn}"
                saved_path = os.path.join(TEMP_DIR, saved_name)
                with open(saved_path, 'wb') as f:
                    f.write(file_obj['content'])

                # استيراد وتفريغ الفاتورة مباشرة داخل المسودة النشطة
                inv_id_val = int(fields.get('invoice_id', 0)) if str(fields.get('invoice_id', '')).isdigit() else None
                user_name_val = fields.get('user_name', 'المسؤول')
                res = import_invoice_file_to_active_invoice(saved_path, invoice_id=inv_id_val, user_name=user_name_val)
                res["file_id"] = saved_name
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": f"خطأ أثناء استيراد وتفريغ الفاتورة: {str(e)}"}, 500)
            return

        # 4. معاينة استيراد الأصناف مع فحص التعارض والصفوف المتخطاة
        if path == '/api/catalog/preview-import':
            try:
                data = json.loads(body_bytes.decode('utf-8'))
                file_id = data.get('file_id')
                mapping = data.get('mapping') or {}
                replace_barcodes = bool(data.get('replace_barcodes', False))
                file_path = os.path.join(TEMP_DIR, file_id)
                res = preview_import_catalog(file_path, mapping, replace_barcodes=replace_barcodes)
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 5. تأكيد وحفظ استيراد بطاقات الأصناف
        if path == '/api/catalog/commit-import':
            try:
                data = json.loads(body_bytes.decode('utf-8'))
                file_id = data.get('file_id')
                mapping = data.get('mapping') or {}
                replace_barcodes = bool(data.get('replace_barcodes', False))
                file_path = os.path.join(TEMP_DIR, file_id)
                res = commit_import_catalog(file_path, mapping, replace_barcodes=replace_barcodes)
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 6. إنشاء فاتورة جديدة
        if path == '/api/invoice/new':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                notes = data.get('notes', '')
                user_name = data.get('user_name', 'المسؤول')
                inv = create_new_invoice(notes=notes, user_name=user_name)
                self.send_json({"success": True, "invoice": inv})
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 7. مسح كود QR وإضافته إلى الفاتورة وتفريغ بياناته بالكامل
        if path == '/api/invoice/scan':
            try:
                data = json.loads(body_bytes.decode('utf-8'))
                inv_id = int(data.get('invoice_id', 0))
                qr_text = str(data.get('qr_text', '')).strip()
                user_name = str(data.get('user_name', 'المسؤول')).strip()
                quantity = int(data.get('quantity', 1))

                if not inv_id:
                    active_inv = get_or_create_draft_invoice(user_name)
                    inv_id = active_inv["id"]

                # أولاً: تفريغ بيانات كود QR الممسوح دائماً
                parsed_qr = parse_qr_code(qr_text)
                
                # مسح كود QR بالماسح يضيف عبوة واحدة (1 حبة) تلقائياً لكل مسحة
                res = scan_qr_to_invoice(inv_id, qr_text, user_name, quantity=1)
                inv_details = get_invoice_details(inv_id)
                res["invoice"] = inv_details
                
                qr_data = parsed_qr.get("data", {}) if parsed_qr.get("success") else {}
                res["parsed_qr"] = qr_data
                if qr_data.get("gtin") and "gtin" not in res:
                    res["gtin"] = qr_data.get("gtin")
                if qr_data.get("batch") and "batch" not in res:
                    res["batch"] = qr_data.get("batch")
                if qr_data.get("serial") and "serial" not in res:
                    res["serial"] = qr_data.get("serial")
                if qr_data.get("expiry") and "expiry" not in res:
                    res["expiry"] = qr_data.get("expiry")
                
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 8. حذف عبوة (سيريال) من الفاتورة المسودة
        if path == '/api/invoice/delete-serial':
            try:
                data = json.loads(body_bytes.decode('utf-8'))
                inv_id = int(data.get('invoice_id', 0))
                serial_id = int(data.get('serial_id', 0))
                res = delete_scanned_serial(inv_id, serial_id)
                res["invoice"] = get_invoice_details(inv_id)
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 9. حذف سطر بالكامل من الفاتورة المسودة
        if path == '/api/invoice/delete-line':
            try:
                data = json.loads(body_bytes.decode('utf-8'))
                inv_id = int(data.get('invoice_id', 0))
                line_id = int(data.get('line_id', 0))
                res = delete_invoice_line(inv_id, line_id)
                res["invoice"] = get_invoice_details(inv_id)
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 9.ب مسح وتفريغ جميع أصناف الفاتورة بالكامل بعد العملية
        if path in ('/api/invoice/clear-lines', '/api/invoice/clear'):
            try:
                data = json.loads(body_bytes.decode('utf-8'))
                inv_id = int(data.get('invoice_id', 0))
                if not inv_id:
                    draft = get_or_create_draft_invoice()
                    inv_id = draft['id']
                res = clear_invoice_lines(inv_id)
                res["invoice"] = get_invoice_details(inv_id)
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 9.ج تعديل كمية سطر الفاتورة يدوياً
        if path == '/api/invoice/update-line-qty':
            try:
                data = json.loads(body_bytes.decode('utf-8'))
                inv_id = int(data.get('invoice_id', 0))
                if not inv_id:
                    draft = get_or_create_draft_invoice()
                    inv_id = draft['id']
                line_id = int(data.get('line_id', 0))
                new_qty = int(data.get('quantity', 1))
                res = update_invoice_line_quantity(inv_id, line_id, new_qty)
                res["invoice"] = get_invoice_details(inv_id)
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 9.د إدخال صنف وكمية وباتش يدوياً
        if path == '/api/invoice/manual-item':
            try:
                data = json.loads(body_bytes.decode('utf-8'))
                inv_id = int(data.get('invoice_id', 0))
                if not inv_id:
                    draft = get_or_create_draft_invoice()
                    inv_id = draft['id']
                gtin = str(data.get('gtin', '')).strip()
                batch = str(data.get('batch', '')).strip().upper()
                expiry = str(data.get('expiry', '')).strip()
                qty = int(data.get('quantity', 1))
                user_name = str(data.get('user_name', 'المسؤول')).strip()
                res = add_manual_item_to_invoice(inv_id, gtin, batch, expiry, quantity=qty, user_name=user_name)
                res["invoice"] = get_invoice_details(inv_id)
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 10. اعتماد الفاتورة
        if path == '/api/invoice/confirm':
            try:
                data = json.loads(body_bytes.decode('utf-8'))
                inv_id = int(data.get('invoice_id', 0))
                res = confirm_invoice(inv_id)
                res["invoice"] = get_invoice_details(inv_id)
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 11. إرجاع عبوة موثق
        if path == '/api/returns/process':
            try:
                data = json.loads(body_bytes.decode('utf-8'))
                serial_number = data.get('serial_number', '')
                invoice_number = data.get('invoice_number', '')
                reason = data.get('reason', 'إرجاع عبوة')
                user_name = data.get('user_name', 'المسؤول')
                res = process_serial_return(serial_number, invoice_number, reason, user_name)
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # 12. نظام الجرد الفعلي ومطابقة الأرصدة (POST)
        if path == '/api/stock/stores/create':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                name = str(data.get('store_name') or '').strip()
                branch = str(data.get('branch_name') or 'الفرع الرئيسي').strip()
                user = str(data.get('user_name') or 'المسؤول').strip()
                res = create_new_store(name, branch_name=branch, user_name=user)
                if res.get("success"):
                    broadcast_sync("store_created", {"store_no": res.get("store_no"), "store_name": name})
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path == '/api/stock/stores/update':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                no = str(data.get('store_no') or '').strip()
                name = str(data.get('store_name') or '').strip()
                branch = str(data.get('branch_name') or '').strip()
                res = update_store(no, name, branch)
                if res.get("success"):
                    broadcast_sync("store_updated", {"store_no": no, "store_name": name})
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path == '/api/stock/stores/delete':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                no = str(data.get('store_no') or '').strip()
                res = delete_store(no)
                if res.get("success"):
                    broadcast_sync("store_deleted", {"store_no": no})
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path == '/api/stock/reset-all':
            ok_auth, auth_msg = is_authorized_admin_request(self.client_address[0], dict(self.headers), require_token_always=False)
            if not ok_auth:
                get_server_logger().warning(f"Unauthorized /api/stock/reset-all attempt from {self.client_address[0]}")
                self.send_json({"success": False, "message": auth_msg}, 403)
                return
            try:
                res = reset_all_stocktake_test_data()
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        # مسح الأصناف عبر الجوال لاسلكياً (Mobile Wireless Scanner)
        if path == '/api/mobile/scan':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                code = str(data.get('code') or data.get('raw_code') or '').strip()
                target = str(data.get('target') or 'stocktake').strip()
                store_no = str(data.get('store_no') or 'ST-001').strip()
                inv_id = data.get('invoice_id')

                if not code:
                    self.send_json({"success": False, "message": "لم يتم إرسال أي كود"}, 400)
                    return

                res = {}
                if target == 'stocktake':
                    force_direct = bool(data.get('force_direct', False))
                    res = scan_item_to_store(code, store_no=store_no, force_direct=force_direct)
                else:
                    if not inv_id:
                        draft = get_or_create_draft_invoice()
                        inv_id = draft['id']
                    res = scan_qr_to_invoice(int(inv_id), code)

                p_name = res.get("product_name") or (res.get("product", {}).get("name") if isinstance(res.get("product"), dict) else "") or ""
                p_code = res.get("product_code") or (res.get("product", {}).get("code") if isinstance(res.get("product"), dict) else "") or ""

                event = {
                    "id": uuid.uuid4().hex[:8],
                    "code": code,
                    "target": target,
                    "store_no": store_no,
                    "invoice_id": inv_id,
                    "success": bool(res.get("success", False)),
                    "product_name": p_name,
                    "product_code": p_code,
                    "batch": str(res.get("batch") or res.get("batch_number") or "").strip().upper(),
                    "message": res.get("message") or "",
                    "timestamp": time.time()
                }
                MOBILE_SCANS_QUEUE.append(event)
                if len(MOBILE_SCANS_QUEUE) > 100:
                    del MOBILE_SCANS_QUEUE[:50]
                broadcast_sync("mobile_scan", event)

                res["event"] = event
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path == '/api/stock/scan':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                code = str(data.get('code') or data.get('qr_text') or '').strip()
                product_code = str(data.get('product_code') or '').strip()
                store_no = str(data.get('store_no') or 'ST-001').strip()
                force_direct = bool(data.get('force_direct', False))
                res = scan_item_to_store(code, store_no=store_no, force_direct=force_direct, product_code=product_code)
                if res.get("success"):
                    broadcast_sync("stock_scan", {
                        "store_no": store_no,
                        "code": code,
                        "product_name": res.get("product_name") or "",
                        "product_code": res.get("product_code") or ""
                    })
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path == '/api/stock/save-batch-qty':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                store_no = str(data.get('store_no') or 'ST-001').strip()
                prod_code = str(data.get('product_code') or '').strip()
                batch_number = str(data.get('batch_number') or '').strip().upper()
                expiry_date = str(data.get('expiry_date') or '').strip()
                counted_qty = float(data.get('counted_qty') or 0.0)
                system_qty = float(data.get('system_qty') or 0.0)
                cost_price = float(data.get('cost_price') or 0.0)
                selling_price = float(data.get('selling_price') or 0.0)
                entry_id = int(data.get('entry_id')) if data.get('entry_id') else None

                res = save_stock_batch_count(
                    store_no=store_no,
                    product_code=prod_code,
                    batch_number=batch_number,
                    expiry_date=expiry_date,
                    counted_qty=counted_qty,
                    system_qty=system_qty,
                    cost_price=cost_price,
                    selling_price=selling_price,
                    entry_id=entry_id
                )
                if res.get("success"):
                    broadcast_sync("stock_qty_updated", {
                        "store_no": store_no,
                        "product_code": prod_code,
                        "counted_qty": counted_qty
                    })
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path == '/api/stock/update-qty':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                entry_id = int(data.get('entry_id') or data.get('id') or 0)
                new_qty = float(data.get('quantity') or data.get('qty') or 0)
                store_no = str(data.get('store_no') or 'ST-001').strip()
                res = update_entry_quantity(entry_id, new_qty, store_no=store_no)
                if res.get("success"):
                    broadcast_sync("stock_qty_updated", {
                        "store_no": store_no,
                        "entry_id": entry_id,
                        "quantity": new_qty
                    })
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path == '/api/stock/delete-item':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                entry_id = int(data.get('entry_id') or data.get('id') or 0)
                store_no = str(data.get('store_no') or 'ST-001').strip()
                res = delete_entry_item(entry_id, store_no=store_no)
                if res.get("success"):
                    broadcast_sync("stock_item_deleted", {
                        "store_no": store_no,
                        "entry_id": entry_id
                    })
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path == '/api/stock/bulk-delete':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                entry_ids = [int(i) for i in data.get('entry_ids', []) if str(i).isdigit()]
                store_no = str(data.get('store_no') or 'ST-001').strip()
                res = bulk_delete_stock_entries(entry_ids, store_no=store_no)
                if res.get("success"):
                    broadcast_sync("stock_item_deleted", {
                        "store_no": store_no,
                        "entry_ids": entry_ids
                    })
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path == '/api/stock/edit-item':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                entry_id = int(data.get('entry_id') or data.get('id') or 0)
                store_no = str(data.get('store_no') or 'ST-001').strip()
                updates = data.get('updates', {})
                res = edit_stocktake_entry(entry_id, updates, store_no=store_no)
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path == '/api/stock/clear-inventory':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                store_no = str(data.get('store_no') or 'ST-001').strip()
                clear_all = bool(data.get('clear_all') or store_no.upper() == 'ALL')
                res = clear_inventory_records(store_no=store_no, clear_all=clear_all)
                if res.get("success"):
                    broadcast_sync("inventory_cleared", {"store_no": store_no, "clear_all": clear_all})
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path == '/api/stock/clear':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                store_no = str(data.get('store_no') or 'ST-001').strip()
                res = clear_store_stocktake(store_no=store_no)
                if res.get("success"):
                    broadcast_sync("stock_cleared", {"store_no": store_no})
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path in ('/api/stock/settle', '/api/stock/commit-bulk', '/api/stock/stores/commit-all'):
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                commit_all = data.get('commit_all', False)
                store_nos = data.get('store_nos', [])
                if commit_all:
                    res = commit_stores_stocktake(store_nos=['ALL'])
                elif store_nos and isinstance(store_nos, list):
                    res = commit_stores_stocktake(store_nos=store_nos)
                else:
                    store_no = str(data.get('store_no') or 'ST-001').strip()
                    res = commit_stores_stocktake(store_nos=[store_no])
                if res.get("success"):
                    broadcast_sync("stock_settled", {"store_nos": store_nos or ['ALL' if commit_all else store_no]})
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path == '/api/stock/populate-all':
            try:
                data = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                store_no = str(data.get('store_no') or 'ST-001').strip()
                res = populate_store_from_inventory(store_no=store_no)
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": str(e)}, 400)
            return

        if path in ('/api/stock/upload-excel', '/api/stock/upload'):
            try:
                boundary = extract_boundary(content_type)
                fields, files = parse_multipart(body_bytes, boundary)
                file_obj = files.get('file') or files.get('excel') or (list(files.values())[0] if files else None)
                if not file_obj:
                    self.send_json({"success": False, "message": "لم يتم إرسال ملف الإكسيل."}, 400)
                    return

                raw_fn = file_obj.get('filename') or 'stock.xlsx'
                clean_fn = re.sub(r'[^\w\.-]', '_', os.path.basename(raw_fn))
                if not clean_fn.lower().endswith(('.xlsx', '.xls', '.csv')):
                    clean_fn += '.xlsx'
                saved_name = f"stock_{uuid.uuid4().hex[:8]}_{clean_fn}"
                saved_path = os.path.join(TEMP_DIR, saved_name)
                with open(saved_path, 'wb') as f:
                    f.write(file_obj['content'])

                store_no = fields.get('store_no', 'ST-001')
                replace_existing = fields.get('replace_existing', 'true').lower() in ('true', '1')
                res = upload_inventory_excel(saved_path, store_no=store_no, replace_existing=replace_existing)
                self.send_json(res)
            except Exception as e:
                self.send_json({"success": False, "message": f"خطأ أثناء رفع المخزون: {str(e)}"}, 500)
            return

        self.send_json({"detail": "المسار غير معروف"}, 404)

def run_server(port=8000, auto_open_browser=True):
    import webbrowser
    import threading
    import time
    import urllib.request

    # فحص ما إذا كان الخادم يعمل بالفعل على هذا المنفذ
    try:
        req = urllib.request.urlopen(f"http://127.0.0.1:{port}/api/stats", timeout=1)
        if req.status == 200:
            print(f"===========================================================")
            print(f"  نظام إدارة بطاقات الأصناف والمسح بكود QR وتصدير الإكسيل")
            print(f"  الخادم يعمل بالفعل بنجاح على الرابط: http://127.0.0.1:{port}")
            print(f"===========================================================")
            if auto_open_browser:
                webbrowser.open(f"http://127.0.0.1:{port}")
            print("البرنامج جاهز للاستخدام في المتصفح. اضغط Ctrl + C للخروج.")
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                return
    except:
        pass

    server_address = ('0.0.0.0', port)
    # لا ننتقل لمنفذ 8001 أبداً: ذلك كان يخلق خادماً ثانياً منفصلاً عن الموبايل والنفق
    httpd = ReusableThreadingHTTPServer(server_address, AppRequestHandler)

    srv_logger = get_server_logger()
    try:
        get_or_create_admin_token()
    except Exception:
        pass
    try:
        init_db()
    except Exception as e:
        srv_logger.error(f"init_db error on startup: {e}")

    health = check_db_health(deep=False)
    srv_logger.info(
        f"Server started on port {port} | DB={health.get('db_path')} | "
        f"healthy={health.get('healthy')} | counts={health.get('counts')}"
    )

    # إنشاء نسخة احتياطية متسقة فور إقلاع الخادم
    try:
        create_backup(reason="startup")
    except Exception as e:
        srv_logger.error(f"Startup backup warning: {e}")

    # صيانة دورية في الخلفية: فحص السلامة + دمج WAL + نسخ احتياطي تلقائي كل 4 ساعات
    def _db_maintenance_loop():
        last_backup_ts = time.time()
        while True:
            time.sleep(900)  # كل 15 دقيقة
            try:
                h = check_db_health(deep=False)
                checkpoint_wal(mode="PASSIVE")
                if not h.get("healthy"):
                    srv_logger.error(f"Periodic health check FAILED: {h.get('error')}")
                if time.time() - last_backup_ts >= AUTO_BACKUP_INTERVAL_SECONDS:
                    b_res = create_backup(reason="scheduled")
                    if b_res.get("success"):
                        last_backup_ts = time.time()
            except Exception as exc:
                srv_logger.error(f"Maintenance loop exception: {exc}")

    threading.Thread(target=_db_maintenance_loop, name="db-maintenance", daemon=True).start()

    import atexit
    def _on_server_exit():
        try:
            checkpoint_wal(mode="TRUNCATE")
            srv_logger.info("Server shutting down cleanly (WAL truncated).")
        except Exception:
            pass
    atexit.register(_on_server_exit)

    print(f"===========================================================")
    print(f"  نظام إدارة بطاقات الأصناف والمسح بكود QR وتصدير الإكسيل")
    print(f"  يعمل الآن على الرابط: http://127.0.0.1:{port}")
    print(f"  قاعدة البيانات الدائمة: {health.get('db_path')}")
    print(f"===========================================================")

    # الربط التلقائي لملف الأصناف: يستورد product.template.xlsx عند الإقلاع وكلما تغيّر
    try:
        start_autosync(on_synced=lambda res: broadcast_sync('catalog_updated', res))
    except Exception as e:
        print(f"[!] تعذر تشغيل الربط التلقائي لملف الأصناف: {e}")

    if auto_open_browser:
        def open_browser_later():
            time.sleep(0.6)
            try:
                webbrowser.open(f"http://127.0.0.1:{port}")
            except:
                pass
        threading.Thread(target=open_browser_later, daemon=True).start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nتم إيقاف الخادم.")
        httpd.server_close()

if __name__ == '__main__':
    port = 8000
    if len(sys.argv) > 1 and sys.argv[1].isdigit():
        port = int(sys.argv[1])
    run_server(port)
