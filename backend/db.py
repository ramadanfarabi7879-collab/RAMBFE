import sqlite3
import os
import re
import json
import datetime
from typing import List, Dict, Any, Optional, Tuple

try:
    from .db_safety import (
        BASE_DIR,
        DATA_DIR as DB_DIR,
        PERMANENT_DB_PATH,
        DatabaseSafetyError,
        get_resolved_db_path,
        ensure_safe_db_target,
        is_using_permanent_db,
        get_server_logger,
        create_backup,
    )
except (ImportError, ValueError):
    from backend.db_safety import (
        BASE_DIR,
        DATA_DIR as DB_DIR,
        PERMANENT_DB_PATH,
        DatabaseSafetyError,
        get_resolved_db_path,
        ensure_safe_db_target,
        is_using_permanent_db,
        get_server_logger,
        create_backup,
    )

DB_PATH = get_resolved_db_path()

def get_connection():
    db_path = ensure_safe_db_target(require_existing_if_populated=True)
    if db_path != ":memory:":
        os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA busy_timeout = 30000;")
    if db_path != ":memory:":
        try:
            # WAL يسمح بالقراءة أثناء الكتابة (مثل الاستيراد التلقائي للأصناف أثناء الجرد) دون تعليق
            conn.execute("PRAGMA journal_mode = WAL;")
            # synchronous=FULL يضمن كتابة المعاملات فعلياً على القرص وعدم فقدانها
            conn.execute("PRAGMA synchronous = FULL;")
        except sqlite3.DatabaseError:
            pass
    return conn

def clean_numeric_code(val: Any) -> str:
    """تنظيف واستخراج كود الصنف مع الحفاظ التام على الأصفار في البداية والحروف إن وجدت (مثل 0000094684)"""
    if val is None:
        return ""
    if isinstance(val, float):
        if val.is_integer():
            val = int(val)
    s = str(val).strip()
    if not s or s.lower() in ('nan', 'null', 'none'):
        return ""
    if re.match(r'^[0-9]+(\.[0-9]+)?[eE]\+[0-9]+$', s):
        try:
            return f"{int(float(s))}"
        except:
            pass
    if s.endswith('.0') and s[:-2].isdigit():
        s = s[:-2]
    # تنظيف المسافات الفاصلة ونهايات الأسطر مع الحفاظ التام على الأصفار البادئة
    cleaned = re.sub(r'[\r\n\t]+', '', s).strip()
    return cleaned

def clean_barcode_preserve_zeros(val: Any) -> str:
    """تنظيف الباركود أو الـ GTIN مع الحفاظ التام على الأصفار في البداية"""
    if val is None:
        return ""
    s = str(val).strip()
    if s.endswith('.0') and s[:-2].isdigit():
        s = s[:-2]
    # إزالة المحارف غير الأبجدية الرقمية
    clean = re.sub(r'[^0-9a-zA-Z]', '', s)
    return clean

def split_barcodes(val: Any) -> List[str]:
    """استخراج جميع أرقام الباركود أو GTIN من النصوص أو القوائم مع الحفاظ الصارم على الأصفار في البداية"""
    if val is None:
        return []
        
    raw_strings = []
    if isinstance(val, (list, tuple, set)):
        for x in val:
            if x is not None:
                raw_strings.append(x)
    else:
        raw_strings.append(val)

    tokens = []
    for raw in raw_strings:
        if raw is None:
            continue
        s = str(raw).strip()
        if not s or s.lower() in ('none', 'nan', 'null', '-', 'false', 'true'):
            continue
        if s.endswith('.0') and s[:-2].isdigit():
            s = s[:-2]
        for part in re.split(r'[,;\/\n\|\s]+', s):
            if part:
                tokens.append(part)

    res = []
    seen = set()
    for it in tokens:
        clean = clean_barcode_preserve_zeros(it)
        if clean and clean.lower() not in ('none', 'nan', 'null', 'false', 'true') and clean not in seen:
            seen.add(clean)
            res.append(clean)
    return res

def init_db():
    conn = get_connection()
    cursor = conn.cursor()
    
    # 1. جدول بطاقات الأصناف الرئيسي
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        gtin TEXT DEFAULT '',
        barcode TEXT DEFAULT '',
        name_ar TEXT DEFAULT '',
        name_en TEXT DEFAULT '',
        name TEXT NOT NULL,
        category TEXT DEFAULT '',
        selling_price REAL DEFAULT 0.0,
        unit_price REAL DEFAULT 0.0,
        cost_price REAL DEFAULT 0.0,
        tax_rate REAL DEFAULT 0.0,
        unit TEXT DEFAULT 'علبة',
        unit_divisions TEXT DEFAULT '',
        normalized_name TEXT DEFAULT '',
        normalized_name_ar TEXT DEFAULT '',
        normalized_name_en TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # فحص وإضافة أي أعمدة ناقصة في جدول products
    cursor.execute("PRAGMA table_info(products);")
    cols = [col[1] for col in cursor.fetchall()]
    needed_cols = {
        "unit_price": "REAL DEFAULT 0.0",
        "tax_rate": "REAL DEFAULT 0.0",
        "unit": "TEXT DEFAULT 'علبة'",
        "unit_divisions": "TEXT DEFAULT ''",
        "gtin": "TEXT DEFAULT ''",
        "name_ar": "TEXT DEFAULT ''",
        "name_en": "TEXT DEFAULT ''",
        "scientific_name": "TEXT DEFAULT ''",
        "company": "TEXT DEFAULT ''",
        "wholesale_price": "REAL DEFAULT 0.0",
        "normalized_name": "TEXT DEFAULT ''",
        "normalized_name_ar": "TEXT DEFAULT ''",
        "normalized_name_en": "TEXT DEFAULT ''",
        "updated_at": "TEXT DEFAULT ''"
    }
    for col_name, col_def in needed_cols.items():
        if col_name not in cols:
            cursor.execute(f"ALTER TABLE products ADD COLUMN {col_name} {col_def};")

    # 2. جدول الباركودات والـ GTINs المتعددة للصنف مع المحافظة التامة على الأصفار في البداية
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS product_barcodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_code TEXT NOT NULL,
        barcode TEXT NOT NULL,
        barcode_type TEXT DEFAULT 'barcode',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_code) REFERENCES products(code) ON DELETE CASCADE,
        UNIQUE(product_code, barcode, barcode_type)
    );
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_prod_barcodes_val ON product_barcodes(barcode);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_prod_barcodes_code ON product_barcodes(product_code);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_products_code ON products(code);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_products_gtin ON products(gtin);")

    # 3. جدول الفواتير (Invoices)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_number TEXT NOT NULL UNIQUE,
        invoice_date TEXT NOT NULL,
        status TEXT DEFAULT 'draft',
        total_items INTEGER DEFAULT 0,
        total_packages INTEGER DEFAULT 0,
        total_amount REAL DEFAULT 0.0,
        user_name TEXT DEFAULT 'المسؤول',
        notes TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        confirmed_at TIMESTAMP
    );
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices(invoice_number);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);")

    # 4. جدول سطور الفاتورة المجمعة (Invoice Lines)
    # التجميع على: الصنف + رقم الباتش + تاريخ الانتهاء
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS invoice_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id INTEGER NOT NULL,
        invoice_number TEXT NOT NULL,
        product_code TEXT NOT NULL,
        product_name TEXT DEFAULT '',
        name_ar TEXT DEFAULT '',
        name_en TEXT DEFAULT '',
        batch_number TEXT NOT NULL,
        expiry_date TEXT NOT NULL,
        quantity INTEGER DEFAULT 0,
        sales_price REAL DEFAULT 0.0,
        unit_price REAL DEFAULT 0.0,
        tax_rate REAL DEFAULT 0.0,
        unit TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
        UNIQUE(invoice_id, product_code, batch_number, expiry_date)
    );
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_inv_lines_inv ON invoice_lines(invoice_id);")

    # 5. جدول السيريالات الممسوحة لكل عبوة (Scanned Serials Log)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS scanned_serials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_id INTEGER NOT NULL,
        invoice_number TEXT NOT NULL,
        line_id INTEGER,
        product_code TEXT NOT NULL,
        raw_code TEXT NOT NULL,
        raw_gtin_or_barcode TEXT NOT NULL,
        batch_number TEXT NOT NULL,
        serial_number TEXT NOT NULL,
        expiry_date TEXT NOT NULL,
        unit TEXT DEFAULT '',
        quantity INTEGER DEFAULT 1,
        user_name TEXT DEFAULT 'المسؤول',
        scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_confirmed INTEGER DEFAULT 0,
        is_returned INTEGER DEFAULT 0,
        return_reason TEXT DEFAULT '',
        returned_at TIMESTAMP,
        returned_by TEXT DEFAULT '',
        FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE,
        FOREIGN KEY(line_id) REFERENCES invoice_lines(id) ON DELETE CASCADE
    );
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_scanned_serials_sn ON scanned_serials(serial_number);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_scanned_serials_inv ON scanned_serials(invoice_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_scanned_serials_code ON scanned_serials(product_code);")

    # 6. جدول سجل الإرجاعات والإلغاءات الموثقة
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS returns_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        serial_id INTEGER,
        serial_number TEXT NOT NULL,
        product_code TEXT NOT NULL,
        invoice_number TEXT NOT NULL,
        return_reason TEXT NOT NULL,
        returned_by TEXT DEFAULT 'المسؤول',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 7. الجداول الإضافية السابقة (للتوافق)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS product_aliases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        invoice_name TEXT NOT NULL UNIQUE,
        product_code TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(product_code) REFERENCES products(code) ON DELETE CASCADE
    );
    """)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS processed_invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        total_items INTEGER DEFAULT 0,
        matched_items INTEGER DEFAULT 0,
        processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS supplier_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_name TEXT NOT NULL UNIQUE,
        mapping TEXT NOT NULL,
        headers TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # 8. جدول سجل المراجعة وتتبع التعديلات (Audit Log)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        old_values TEXT DEFAULT '',
        new_values TEXT DEFAULT '',
        details TEXT DEFAULT '',
        user_name TEXT DEFAULT 'المسؤول',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity_type, entity_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);")
    cursor.execute("UPDATE invoice_lines SET batch_number = UPPER(TRIM(batch_number)) WHERE batch_number IS NOT NULL AND batch_number != UPPER(TRIM(batch_number));")
    cursor.execute("UPDATE scanned_serials SET batch_number = UPPER(TRIM(batch_number)) WHERE batch_number IS NOT NULL AND batch_number != UPPER(TRIM(batch_number));")

    conn.commit()
    conn.close()

# استدعاء التهيئة تلقائياً
init_db()

def log_audit_event(entity_type: str, entity_id: str, action: str,
                    old_values: Any = None, new_values: Any = None,
                    details: str = "", user_name: str = "المسؤول") -> int:
    """تسجيل حدث في سجل المراجعة والتعديلات (Audit Log)"""
    import json
    old_str = json.dumps(old_values, ensure_ascii=False) if isinstance(old_values, (dict, list)) else str(old_values or '')
    new_str = json.dumps(new_values, ensure_ascii=False) if isinstance(new_values, (dict, list)) else str(new_values or '')
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO audit_logs (entity_type, entity_id, action, old_values, new_values, details, user_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, (entity_type, str(entity_id), action, old_str, new_str, details, user_name))
    log_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return log_id

def get_audit_logs(limit: int = 100, entity_type: Optional[str] = None, entity_id: Optional[str] = None) -> List[Dict[str, Any]]:
    """استرجاع سجلات المراجعة"""
    conn = get_connection()
    cursor = conn.cursor()
    query = "SELECT * FROM audit_logs WHERE 1=1"
    params = []
    if entity_type:
        query += " AND entity_type = ?"
        params.append(entity_type)
    if entity_id:
        query += " AND entity_id = ?"
        params.append(str(entity_id))
    query += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    cursor.execute(query, tuple(params))
    rows = [dict(r) for r in cursor.fetchall()]
    conn.close()
    return rows

def get_next_product_code() -> str:
    """
    توليد كود داخلي رقمي فريد للصنف تلقائياً من النظام
    يبدأ من 10001 أو أعلى رقم مسجل، ويكون فريداً ولا يتكرر
    """
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT MAX(CAST(code AS INTEGER)) FROM products 
        WHERE code GLOB '[0-9]*' AND length(code) <= 10
    """)
    row = cursor.fetchone()
    val = row[0] if row else None
    conn.close()
    
    if val is None or val < 10000:
        next_val = 10001
    else:
        next_val = val + 1
        
    # التأكد من عدم وجوده مسبقاً
    conn = get_connection()
    cursor = conn.cursor()
    while True:
        code_str = str(next_val)
        cursor.execute("SELECT 1 FROM products WHERE code = ?", (code_str,))
        if not cursor.fetchone():
            break
        next_val += 1
    conn.close()
    return str(next_val)

def find_product_by_gtin_or_barcode(val: str) -> Optional[Dict[str, Any]]:
    """
    البحث عن الصنف والتعرف عليه باستخدام أي باركود أو GTIN مسجل له،
    مع المحافظة التامة على الأصفار في بداية الرقم، ودعم توافق GTIN-13 و GTIN-14.
    """
    if not val:
        return None
    clean_val = clean_barcode_preserve_zeros(val)
    if not clean_val:
        return None

    # تنويعات الكود المحتملة (مثل إضافة أو إزالة الصفر البادئ بين 13 و 14 رقماً)
    from .qr_parser import extract_clean_gtin
    candidates = [clean_val]
    pure_gtin = extract_clean_gtin(val)
    if pure_gtin and pure_gtin not in candidates:
        candidates.append(pure_gtin)
    if len(clean_val) == 14 and clean_val.startswith('0'):
        candidates.append(clean_val[1:])
    elif len(clean_val) == 13 and clean_val.isdigit():
        candidates.append('0' + clean_val)
    if pure_gtin:
        if len(pure_gtin) == 14 and pure_gtin.startswith('0') and pure_gtin[1:] not in candidates:
            candidates.append(pure_gtin[1:])
        elif len(pure_gtin) == 13 and pure_gtin.isdigit() and ('0' + pure_gtin) not in candidates:
            candidates.append('0' + pure_gtin)

    conn = get_connection()
    cursor = conn.cursor()
    
    # 1. البحث في جدول الباركودات المتعددة
    placeholders = ','.join(['?'] * len(candidates))
    cursor.execute(f"""
        SELECT p.* FROM products p
        JOIN product_barcodes pb ON p.code = pb.product_code
        WHERE pb.barcode IN ({placeholders})
        ORDER BY p.id DESC
        LIMIT 1
    """, candidates)
    row = cursor.fetchone()
    if row:
        product = dict(row)
        conn.close()
        _attach_product_barcodes(product)
        return product

    # 1.ب فحص ما إذا كان الباركود المخزن كود داتا ماتريكس خام يحتوي على الـ GTIN
    if pure_gtin:
        cursor.execute("""
            SELECT p.* FROM products p
            JOIN product_barcodes pb ON p.code = pb.product_code
            WHERE pb.barcode LIKE ? OR pb.barcode LIKE ?
            ORDER BY p.id DESC
            LIMIT 1
        """, (f"%01{pure_gtin}%", f"%{pure_gtin}%"))
        row = cursor.fetchone()
        if row:
            product = dict(row)
            conn.close()
            _attach_product_barcodes(product)
            return product

    # 2. البحث المباشر في حقول products (gtin أو barcode أو code)
    for c in candidates:
        cursor.execute("""
            SELECT * FROM products
            WHERE code = ? OR gtin LIKE ? OR barcode LIKE ?
            ORDER BY id DESC
            LIMIT 1
        """, (c, f"%{c}%", f"%{c}%"))
        row = cursor.fetchone()
        if row:
            product = dict(row)
            conn.close()
            _attach_product_barcodes(product)
            return product

    conn.close()
    return None

def _attach_product_barcodes(product: Dict[str, Any]):
    """جلب وتجميع كافة الباركودات و GTINs للصنف كقوائم منفصلة"""
    code = product.get("code")
    if not code:
        return
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT barcode, barcode_type FROM product_barcodes WHERE product_code = ?", (code,))
    rows = cursor.fetchall()
    conn.close()
    
    gtins = []
    barcodes = []
    for r in rows:
        b = r["barcode"]
        if r["barcode_type"] == "gtin":
            if b not in gtins:
                gtins.append(b)
        else:
            if b not in barcodes:
                barcodes.append(b)
                
    # التأكد من تضمين ما كان مسجلاً في النص الأصلي إن لم يكن مضافاً
    if product.get("gtin"):
        for g in split_barcodes(product["gtin"]):
            if g not in gtins:
                gtins.append(g)
    if product.get("barcode"):
        for b in split_barcodes(product["barcode"]):
            if b not in barcodes and b not in gtins:
                barcodes.append(b)
                
    product["gtin_list"] = gtins
    product["barcode_list"] = barcodes

def get_product_by_code(code: str) -> Optional[Dict[str, Any]]:
    clean_code = clean_numeric_code(code)
    if not clean_code:
        return None
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM products WHERE code = ? LIMIT 1", (clean_code,))
    row = cursor.fetchone()
    conn.close()
    if row:
        p = dict(row)
        _attach_product_barcodes(p)
        return p
    return None

def save_or_update_product(p: Dict[str, Any], user_name: str = "المسؤول") -> Tuple[bool, str, str]:
    """
    إدخال أو تعديل بطاقة صنف بكافة بياناتها:
    - كود داخلي رقمي مولد من النظام فريد
    - اسما الصنف (عربي وانجليزي) والاسم العلمي والشركة المصنعة
    - تصنيف الصنف
    - سعر البيع وسعر الجملة وسعر الوحدة/التكلفة
    - نسبة الضريبة
    - وحدة البيع الأساسية وتقسيم ومعامل تحويل الوحدات
    - عدة باركودات وعدة GTINs مع المحافظة على الأصفار في البداية
    - توثيق العملية في سجل المراجعة (Audit Log)
    """
    from .normalizer import normalize_arabic, normalize_english
    from .qr_parser import extract_clean_gtin

    code = clean_numeric_code(p.get("code"))
    is_new = False
    old_product = None
    if not code:
        code = get_next_product_code()
        is_new = True
    else:
        old_product = get_product_by_code(code)
        if not old_product:
            is_new = True

    name_ar = str(p.get("name_ar") or "").strip()
    name_en = str(p.get("name_en") or "").strip()
    name = name_en or name_ar or str(p.get("name") or "").strip()
    if not name:
        name = f"صنف {code}"

    scientific_name = str(p.get("scientific_name") or "").strip()
    company = str(p.get("company") or "").strip()
    category = str(p.get("category") or "").strip()
    selling_price = float(p.get("selling_price") or 0.0)
    wholesale_price = float(p.get("wholesale_price") or 0.0)
    unit_price = float(p.get("unit_price") or p.get("cost_price") or 0.0)
    cost_price = unit_price
    tax_rate = float(p.get("tax_rate") or 0.0)
    unit = str(p.get("unit") or "علبة").strip()
    unit_divisions = str(p.get("unit_divisions") or "").strip()

    # تجميع الباركودات: الأساسي + الإضافي
    barcodes_source = []
    if p.get("primary_barcode"):
        barcodes_source.append(str(p.get("primary_barcode")).strip())
    if p.get("extra_barcodes"):
        barcodes_source.extend(split_barcodes(p.get("extra_barcodes")))
    if p.get("barcode_list"):
        barcodes_source.extend(p.get("barcode_list") if isinstance(p.get("barcode_list"), list) else split_barcodes(p.get("barcode_list")))
    if p.get("barcode") and not barcodes_source:
        barcodes_source.extend(split_barcodes(p.get("barcode")))

    raw_barcodes = []
    for b in barcodes_source:
        cb = clean_barcode_preserve_zeros(b)
        if cb and cb not in raw_barcodes:
            raw_barcodes.append(cb)

    # تجميع GTINs: الأساسي + الإضافي
    gtins_source = []
    if p.get("primary_gtin"):
        gtins_source.append(str(p.get("primary_gtin")).strip())
    if p.get("extra_gtins"):
        gtins_source.extend(split_barcodes(p.get("extra_gtins")))
    if p.get("gtin_list"):
        gtins_source.extend(p.get("gtin_list") if isinstance(p.get("gtin_list"), list) else split_barcodes(p.get("gtin_list")))
    if p.get("gtin") and not gtins_source:
        gtins_source.extend(split_barcodes(p.get("gtin")))

    raw_gtins = []
    for g in gtins_source:
        cg = extract_clean_gtin(g) or clean_barcode_preserve_zeros(g)
        if cg and cg not in raw_gtins:
            raw_gtins.append(cg)

    # فحص إذا تم إدخال كود داتا ماتريكس أو QR يحتوي على GTIN في خانة الباركود (طوله أكبر من 14 أو به بادئات GS1)
    for b in raw_barcodes:
        if len(b) > 14 or "(01)" in b or "\x1d" in b or "http" in b or (b.startswith("01") and len(b) > 14):
            cg = extract_clean_gtin(b)
            if cg and cg not in raw_gtins:
                raw_gtins.append(cg)

    norm_ar = normalize_arabic(name_ar or name)
    norm_en = normalize_english(name_en or name)
    norm_name = norm_ar or norm_en or name

    gtin_str = ", ".join(raw_gtins)
    barcode_str = ", ".join(raw_barcodes)

    conn = get_connection()
    cursor = conn.cursor()

    # التحقق من أن الكود الداخلي فريد إذا كان صنفاً جديداً
    if is_new:
        cursor.execute("SELECT 1 FROM products WHERE code = ?", (code,))
        if cursor.fetchone():
            code = get_next_product_code()

    cursor.execute("""
    INSERT INTO products (
        code, gtin, barcode, name_ar, name_en, name, scientific_name, company, category,
        selling_price, wholesale_price, unit_price, cost_price, tax_rate, unit, unit_divisions,
        normalized_name, normalized_name_ar, normalized_name_en, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(code) DO UPDATE SET
        gtin = excluded.gtin,
        barcode = excluded.barcode,
        name_ar = excluded.name_ar,
        name_en = excluded.name_en,
        name = excluded.name,
        scientific_name = excluded.scientific_name,
        company = excluded.company,
        category = excluded.category,
        selling_price = excluded.selling_price,
        wholesale_price = excluded.wholesale_price,
        unit_price = excluded.unit_price,
        cost_price = excluded.cost_price,
        tax_rate = excluded.tax_rate,
        unit = excluded.unit,
        unit_divisions = excluded.unit_divisions,
        normalized_name = excluded.normalized_name,
        normalized_name_ar = excluded.normalized_name_ar,
        normalized_name_en = excluded.normalized_name_en,
        updated_at = CURRENT_TIMESTAMP
    """, (
        code, gtin_str, barcode_str, name_ar, name_en, name, scientific_name, company, category,
        selling_price, wholesale_price, unit_price, cost_price, tax_rate, unit, unit_divisions,
        norm_name, norm_ar, norm_en
    ))

    # تحديث جدول الباركودات والـ GTINs
    cursor.execute("DELETE FROM product_barcodes WHERE product_code = ?", (code,))
    for g in raw_gtins:
        cursor.execute("""
            INSERT OR IGNORE INTO product_barcodes (product_code, barcode, barcode_type)
            VALUES (?, ?, 'gtin')
        """, (code, g))
    for b in raw_barcodes:
        cursor.execute("""
            INSERT OR IGNORE INTO product_barcodes (product_code, barcode, barcode_type)
            VALUES (?, ?, 'barcode')
        """, (code, b))

    conn.commit()
    conn.close()

    new_product_data = {
        "code": code,
        "name_ar": name_ar,
        "name_en": name_en,
        "scientific_name": scientific_name,
        "company": company,
        "category": category,
        "selling_price": selling_price,
        "wholesale_price": wholesale_price,
        "unit_price": unit_price,
        "tax_rate": tax_rate,
        "unit": unit,
        "barcode_list": raw_barcodes,
        "gtin_list": raw_gtins
    }

    if is_new:
        log_audit_event("product", code, "create", None, new_product_data, "إنشاء بطاقة صنف جديدة", user_name=user_name)
    else:
        log_audit_event("product", code, "update", old_product, new_product_data, "تعديل بطاقة الصنف", user_name=user_name)

    return True, code, "تم حفظ بطاقة الصنف بنجاح"

def delete_product(code: str) -> bool:
    clean_code = clean_numeric_code(code)
    if not clean_code:
        return False
    old_product = get_product_by_code(clean_code)
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM products WHERE code = ?", (clean_code,))
    cursor.execute("DELETE FROM product_barcodes WHERE product_code = ?", (clean_code,))
    cursor.execute("DELETE FROM product_aliases WHERE product_code = ?", (clean_code,))
    conn.commit()
    conn.close()
    if old_product:
        log_audit_event("product", clean_code, "delete", old_product, None, "حذف بطاقة الصنف")
    return True

def bulk_delete_products(codes: List[str]) -> int:
    """حذف مجموعة محددة من كروت الأصناف دفعة واحدة بسرعة فائقة"""
    clean_codes = [clean_numeric_code(c) for c in codes if clean_numeric_code(c)]
    if not clean_codes:
        return 0
    conn = get_connection()
    cursor = conn.cursor()
    placeholders = ",".join(["?"] * len(clean_codes))
    cursor.execute(f"DELETE FROM products WHERE code IN ({placeholders})", tuple(clean_codes))
    deleted_count = cursor.rowcount
    cursor.execute(f"DELETE FROM product_barcodes WHERE product_code IN ({placeholders})", tuple(clean_codes))
    cursor.execute(f"DELETE FROM product_aliases WHERE product_code IN ({placeholders})", tuple(clean_codes))
    conn.commit()
    conn.close()
    log_audit_event("product", "bulk", "bulk_delete", None, {"count": deleted_count}, f"حذف مجمع لـ {deleted_count} صنف")
    return deleted_count

def _resolve_canonical_product_code_map(cursor: sqlite3.Cursor, raw_pairs: List[Tuple[str, str]]) -> Dict[Tuple[str, str], str]:
    """مطابقة أكواد/باركودات المخزون والجرد مع كود الصنف الأساسي في جدول products بدقة وسرعة."""
    mapping: Dict[Tuple[str, str], str] = {}
    candidate_codes = set()
    for p_code, _b_code in raw_pairs:
        c = clean_numeric_code(p_code)
        if not c:
            continue
        candidate_codes.add(c)
        if c.isdigit():
            candidate_codes.add(c.zfill(10))
            candidate_codes.add(c.lstrip('0') or '0')

    found_codes = set()
    cand_list = list(candidate_codes)
    for i in range(0, len(cand_list), 500):
        chunk = cand_list[i:i + 500]
        placeholders = ",".join(["?"] * len(chunk))
        cursor.execute(f"SELECT code FROM products WHERE code IN ({placeholders})", tuple(chunk))
        for r in cursor.fetchall():
            found_codes.add(r["code"])

    for p_code, b_code in raw_pairs:
        key = (p_code, b_code)
        if p_code in found_codes:
            mapping[key] = p_code
            continue
        c = clean_numeric_code(p_code)
        matched = ""
        if c:
            if c in found_codes:
                matched = c
            elif c.isdigit():
                z10 = c.zfill(10)
                stripped = c.lstrip('0') or '0'
                if z10 in found_codes:
                    matched = z10
                elif stripped in found_codes:
                    matched = stripped
        if not matched and b_code:
            b_clean = clean_barcode_preserve_zeros(b_code)
            if b_clean:
                cursor.execute("SELECT code FROM products WHERE barcode = ? OR gtin = ? LIMIT 1", (b_clean, b_clean))
                row = cursor.fetchone()
                if not row:
                    cursor.execute("SELECT product_code AS code FROM product_barcodes WHERE barcode = ? LIMIT 1", (b_clean,))
                    row = cursor.fetchone()
                if row:
                    matched = row["code"]
        if matched:
            mapping[key] = matched
    return mapping


def _get_stocktake_eligible_map(cursor: sqlite3.Cursor, store_no: str) -> Tuple[str, Dict[str, Dict[str, Any]]]:
    """
    تحديد الأصناف المؤهلة للظهور في بحث شاشة الجرد للمخزن المحدد فقط:
    1. وجود رصيد دفتري موجب فعلي في inventory_records لنفس store_no (MAX(system_qty) > 0 AND SUM(system_qty) > 0).
    2. أو وجود سجل للصنف في stocktake_entries لنفس store_no ضمن الجرد الجاري (حالة الاستور 'new' أو 'in_progress')،
       حتى لو كانت counted_qty = 0.
    لا يشمل أصناف مخازن أخرى ولا سجلات الجرد القديمة/المنتهية ('completed' أو 'settled').
    """
    cursor.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('stock_stores', 'inventory_records', 'stocktake_entries')"
    )
    existing_tables = {r["name"] for r in cursor.fetchall()}
    if not {"stock_stores", "inventory_records", "stocktake_entries"}.issubset(existing_tables):
        return "", {}

    target_store = str(store_no or "").strip()
    if target_store and target_store.upper() != "ALL":
        cursor.execute("SELECT store_no, status FROM stock_stores WHERE store_no = ?", (target_store,))
        store_row = cursor.fetchone()
        if not store_row:
            return "", {}
    else:
        cursor.execute("SELECT store_no, status FROM stock_stores ORDER BY id DESC LIMIT 1")
        store_row = cursor.fetchone()
        if not store_row:
            return "", {}

    resolved_store = store_row["store_no"]
    store_status = str(store_row["status"] or "new").strip().lower()
    is_active_stocktake = store_status in ("new", "in_progress")

    cursor.execute(
        "SELECT product_code, COALESCE(barcode, '') AS barcode, COALESCE(system_qty, 0) AS system_qty "
        "FROM inventory_records WHERE store_no = ?",
        (resolved_store,)
    )
    inv_rows = cursor.fetchall()

    st_rows = []
    if is_active_stocktake:
        cursor.execute(
            "SELECT product_code, COALESCE(barcode, '') AS barcode, COALESCE(counted_qty, 0) AS counted_qty "
            "FROM stocktake_entries WHERE store_no = ?",
            (resolved_store,)
        )
        st_rows = cursor.fetchall()

    raw_pairs = list({
        (str(r["product_code"] or "").strip(), str(r["barcode"] or "").strip())
        for r in inv_rows
    } | {
        (str(r["product_code"] or "").strip(), str(r["barcode"] or "").strip())
        for r in st_rows
    })
    if not raw_pairs:
        return resolved_store, {}

    code_map = _resolve_canonical_product_code_map(cursor, raw_pairs)

    inv_agg: Dict[str, Dict[str, Any]] = {}
    for r in inv_rows:
        key = (str(r["product_code"] or "").strip(), str(r["barcode"] or "").strip())
        canon = code_map.get(key)
        if not canon:
            continue
        qty = float(r["system_qty"] or 0.0)
        entry = inv_agg.setdefault(canon, {"sum_qty": 0.0, "max_qty": float("-inf"), "batches": 0})
        entry["sum_qty"] += qty
        if qty > entry["max_qty"]:
            entry["max_qty"] = qty
        entry["batches"] += 1

    st_agg: Dict[str, Dict[str, Any]] = {}
    if is_active_stocktake:
        for r in st_rows:
            key = (str(r["product_code"] or "").strip(), str(r["barcode"] or "").strip())
            canon = code_map.get(key)
            if not canon:
                continue
            cqty = float(r["counted_qty"] or 0.0)
            entry = st_agg.setdefault(canon, {"counted_qty": 0.0, "entries": 0})
            entry["counted_qty"] += cqty
            entry["entries"] += 1

    eligible: Dict[str, Dict[str, Any]] = {}
    all_canons = set(inv_agg.keys()) | set(st_agg.keys())
    for canon in all_canons:
        inv_info = inv_agg.get(canon)
        st_info = st_agg.get(canon)
        has_positive_stock = bool(inv_info and inv_info["max_qty"] > 0 and inv_info["sum_qty"] > 0)
        in_current_stk = bool(st_info is not None)
        if not has_positive_stock and not in_current_stk:
            continue
        eligible[canon] = {
            "store_stock_qty": round(inv_info["sum_qty"], 4) if inv_info else 0.0,
            "store_batch_count": inv_info["batches"] if inv_info else 0,
            "in_current_stocktake": in_current_stk,
            "store_counted_qty": round(st_info["counted_qty"], 4) if st_info else 0.0,
        }

    return resolved_store, eligible


def _is_exact_code_or_barcode_query(cursor: sqlite3.Cursor, raw_query: str) -> bool:
    """
    تمييز البحث بالكود/الباركود/GTIN عن البحث بالاسم:
    - أي استعلام رقمي خالص (مثل الباركود أو GTIN أو كود الصنف الرقمي أو بعد فك لوحة المفاتيح العربية) يُعد بحث كود/باركود.
    - أو أي استعلام يطابق بدقة كود صنف (p.code) أو باركوداً/GTIN في قاعدة البيانات (مثل 26606n أو BDN).
    - أسماء الأدوية المحتوية على أرقام مثل '500MG' أو 'ADOL 500' ليست أرقاماً خالصة ولا تطابق كود/باركوداً فتبقى بحث اسم.
    """
    q = str(raw_query or "").strip()
    if not q:
        return False

    from .qr_parser import decode_arabic_keyboard_layout
    candidates = {q, q.lower(), q.upper()}
    decoded = decode_arabic_keyboard_layout(q).strip()
    if decoded:
        candidates.update({decoded, decoded.lower(), decoded.upper()})

    for cand in list(candidates):
        c_clean = clean_numeric_code(cand)
        b_clean = clean_barcode_preserve_zeros(cand)
        if cand.isdigit():
            return True
        if c_clean:
            candidates.add(c_clean)
            if c_clean.isdigit():
                candidates.add(c_clean.zfill(10))
                candidates.add(c_clean.lstrip('0') or '0')
        if b_clean:
            candidates.add(b_clean)

    cand_list = [c for c in candidates if c]
    if not cand_list:
        return False

    placeholders = ",".join(["?"] * len(cand_list))
    cursor.execute(
        f"SELECT 1 FROM products WHERE code IN ({placeholders}) OR barcode IN ({placeholders}) OR gtin IN ({placeholders}) LIMIT 1",
        tuple(cand_list) * 3
    )
    if cursor.fetchone():
        return True

    cursor.execute(
        f"SELECT 1 FROM product_barcodes WHERE barcode IN ({placeholders}) LIMIT 1",
        tuple(cand_list)
    )
    return bool(cursor.fetchone())


def search_products(query: str = "", limit: int = 50, offset: int = 0, match_mode: str = "start", stock_only: bool = False, store_no: str = "") -> Dict[str, Any]:
    """
    البحث في الأصناف بالاسم أو الكود أو الباركود أو GTIN مع دعم:
    - وضع البداية الافتراضي (يبدأ بـ): يبحث عن الكلمة في بداية الاسم أو الكود فقط
    - وضع البحث المعمم (يحتوي على): يبحث عن الكلمة في أي مكان (البداية أو المنتصف أو النهاية)
    - قاعدة المسطرة / الفصلة (Word Boundary): بمجرد كتابة الكلمة وأخذ مسافة بعدها (مثل "ADOL ") تعتبر الكلمة مكتملة
      ولا يجوز مطابقة أصناف تبدأ بأحرف متصلة بها مثل ADOLIN، وتطابق فقط ما يبدأ بـ ADOL ككلمة مستقلة.
    - تطبيع اللغة وتخطيط لوحة المفاتيح
    - عند stock_only=True (شاشة الجرد فقط): يطبّق فلترة المخزون الموجب والجرد الجاري على البحث بالاسم فقط،
      بينما يستثني البحث بالكود أو الباركود أو GTIN ليعرض الصنف المطابق مباشرةً في جميع الحالات.
    """
    conn = get_connection()
    cursor = conn.cursor()

    raw_q = str(query or "").lstrip()
    has_trailing_space = raw_q.endswith(' ')
    q = raw_q.strip()
    is_contains = str(match_mode or "").lower() in ("contains", "generalized", "all", "true", "1")

    bypassed_stock_filter = bool(stock_only and q and _is_exact_code_or_barcode_query(cursor, q))
    apply_stock_filter = bool(stock_only and not bypassed_stock_filter)

    eligible_map: Dict[str, Dict[str, Any]] = {}
    resolved_store = ""
    if stock_only:
        resolved_store, eligible_map = _get_stocktake_eligible_map(cursor, store_no)
        if apply_stock_filter:
            if not eligible_map:
                conn.close()
                return {
                    "items": [],
                    "total": 0,
                    "limit": limit,
                    "offset": offset,
                    "store_no": resolved_store,
                    "bypassed_stock_filter": False,
                }
            cursor.execute("CREATE TEMP TABLE IF NOT EXISTS _stk_eligible (code TEXT PRIMARY KEY)")
            cursor.execute("DELETE FROM _stk_eligible")
            cursor.executemany(
                "INSERT OR IGNORE INTO _stk_eligible (code) VALUES (?)",
                [(c,) for c in eligible_map.keys()]
            )

    stk_join_sql = "INNER JOIN _stk_eligible stk_e ON stk_e.code = p.code" if apply_stock_filter else ""

    if not q:
        cursor.execute(f"SELECT COUNT(*) FROM products p {stk_join_sql}")
        total = cursor.fetchone()[0]
        cursor.execute(f"SELECT p.* FROM products p {stk_join_sql} ORDER BY p.id DESC LIMIT ? OFFSET ?", (limit, offset))
        rows = cursor.fetchall()
    else:
        from .normalizer import normalize_arabic, normalize_english
        from .qr_parser import extract_clean_gtin
        from .qr_parser import decode_arabic_keyboard_layout
        
        words = q.split()
        q_clean = clean_barcode_preserve_zeros(q)
        norm_ar = normalize_arabic(q)
        norm_en = normalize_english(q)

        where_clauses = []
        params = []

        text_fields = [
            'p.name_en', 'p.normalized_name_en',
            'p.name_ar', 'p.normalized_name_ar',
            'p.name', 'p.normalized_name',
            'p.scientific_name', 'p.company', 'p.category'
        ]

        if has_trailing_space or len(words) > 1:
            # قاعدة المسطرة / الفصلة: الكلمة السابقة انتهت ولا يجوز إدخال أي حروف متصلة بها (مثل منع ADOLIN عند كتابة "ADOL ")
            if len(words) == 1 and has_trailing_space:
                tok = words[0]
                search_tokens = [tok]
                if norm_en and norm_en != tok: search_tokens.append(norm_en)
                if norm_ar and norm_ar != tok: search_tokens.append(norm_ar)

                token_conditions = []
                for t in set(search_tokens):
                    for f in text_fields:
                        if is_contains:
                            token_conditions.append(f"({f} = ? OR {f} LIKE ? OR {f} LIKE ? OR {f} LIKE ? OR {f} LIKE ?)")
                            params.extend([t, f"{t} %", f"% {t} %", f"% {t}", f"{t}-%"])
                        else:
                            token_conditions.append(f"({f} = ? OR {f} LIKE ? OR {f} LIKE ? OR {f} LIKE ?)")
                            params.extend([t, f"{t} %", f"{t}-%", f"{t}/%"])

                token_conditions.append("(p.code = ? OR p.code LIKE ?)")
                params.extend([tok, f"{tok} %"])

                if q_clean:
                    token_conditions.append("(p.barcode = ? OR p.gtin = ? OR pb.barcode = ?)")
                    params.extend([q_clean, q_clean, q_clean])

                where_clauses.append(f"({' OR '.join(token_conditions)})")

                # معالجة فك الكيبورد العربي مع المسطرة
                raw_dec = decode_arabic_keyboard_layout(raw_q)
                if raw_dec != raw_q:
                    dec = raw_dec.strip()
                    if dec:
                        dec_conds = []
                        for f in ['p.name_en', 'p.normalized_name_en', 'p.scientific_name']:
                            if is_contains:
                                dec_conds.append(f"({f} = ? OR {f} LIKE ? OR {f} LIKE ? OR {f} LIKE ?)")
                                params.extend([dec, f"{dec} %", f"% {dec} %", f"% {dec}"])
                            else:
                                dec_conds.append(f"({f} = ? OR {f} LIKE ? OR {f} LIKE ?)")
                                params.extend([dec, f"{dec} %", f"{dec}-%"])
                        if dec_conds:
                            where_clauses.append(f"({' OR '.join(dec_conds)})")
            else:
                # كلمات متعددة مفصولة بمسافات (مثل "ADOL EXTRA" أو "ADOL 500")
                w_first = words[0]
                first_conds = []
                for f in text_fields:
                    if is_contains:
                        first_conds.append(f"({f} = ? OR {f} LIKE ? OR {f} LIKE ? OR {f} LIKE ? OR {f} LIKE ?)")
                        params.extend([w_first, f"{w_first} %", f"% {w_first} %", f"% {w_first}", f"{w_first}-%"])
                    else:
                        first_conds.append(f"({f} = ? OR {f} LIKE ? OR {f} LIKE ? OR {f} LIKE ?)")
                        params.extend([w_first, f"{w_first} %", f"{w_first}-%", f"{w_first}/%"])
                first_conds.append("(p.code = ? OR p.code LIKE ?)")
                params.extend([w_first, f"{w_first} %"])

                where_clauses.append(f"({' OR '.join(first_conds)})")

                # باقي الكلمات
                for i, w in enumerate(words[1:]):
                    is_last = (i == len(words) - 2)
                    w_conds = []
                    for f in text_fields:
                        if is_last and has_trailing_space:
                            w_conds.append(f"({f} LIKE ? OR {f} LIKE ? OR {f} LIKE ? OR {f} = ?)")
                            params.extend([f"% {w} %", f"% {w}", f"{w} %", w])
                        else:
                            w_conds.append(f"{f} LIKE ?")
                            params.append(f"%{w}%")
                    where_clauses.append(f"({' OR '.join(w_conds)})")
        else:
            # الوضع بدون مسطرة وبكلمة واحدة: يبدأ بـ أو يحتوي على
            if is_contains:
                q_pattern = f"%{q}%"
                norm_ar_pattern = f"%{norm_ar}%" if norm_ar else q_pattern
                norm_en_pattern = f"%{norm_en}%" if norm_en else q_pattern
                clean_pattern = f"%{q_clean}%" if q_clean else ""
            else:
                q_pattern = f"{q}%"
                norm_ar_pattern = f"{norm_ar}%" if norm_ar else q_pattern
                norm_en_pattern = f"{norm_en}%" if norm_en else q_pattern
                clean_pattern = f"{q_clean}%" if q_clean else ""

            where_clauses.extend([
                'p.name_ar LIKE ?',
                'p.name LIKE ?',
                'p.normalized_name_ar LIKE ?',
                'p.normalized_name LIKE ?',
                'p.name_en LIKE ?',
                'p.normalized_name_en LIKE ?',
                'p.scientific_name LIKE ?',
                'p.company LIKE ?',
                'p.category LIKE ?'
            ])
            params.extend([q_pattern, q_pattern, norm_ar_pattern, norm_ar_pattern, norm_en_pattern, norm_en_pattern, q_pattern, q_pattern, q_pattern])

            where_clauses.extend(['p.code = ?', 'p.code LIKE ?'])
            params.extend([q, q_pattern])

            if q_clean and clean_pattern and q_clean != q:
                where_clauses.extend(['p.code = ?', 'p.code LIKE ?'])
                params.extend([q_clean, clean_pattern])

            if q_clean and clean_pattern:
                where_clauses.extend([
                    'p.barcode = ?', 'p.barcode LIKE ?',
                    'p.gtin = ?', 'p.gtin LIKE ?',
                    'pb.barcode = ?', 'pb.barcode LIKE ?'
                ])
                params.extend([
                    q_clean, clean_pattern,
                    q_clean, clean_pattern,
                    q_clean, clean_pattern
                ])
                if q_clean.isdigit():
                    padded_10 = q_clean.zfill(10)
                    if padded_10 != q_clean:
                        where_clauses.extend(['p.code = ?', 'p.code LIKE ?'])
                        params.extend([padded_10, f"%{padded_10}%" if is_contains else f"{padded_10}%"])
                    if is_contains:
                        stripped_zeros = q_clean.lstrip('0') or '0'
                        if stripped_zeros != q_clean:
                            where_clauses.extend(['p.code = ?', 'p.code LIKE ?'])
                            params.extend([stripped_zeros, f"%{stripped_zeros}%"])

            # معالجة ذكية إذا كُتب البحث الإنجليزي أو الباركود أثناء تفعيل الكيبورد العربي
            decoded_q = decode_arabic_keyboard_layout(q).strip()
            if decoded_q and decoded_q.lower() != q.lower():
                dec_pattern = f"%{decoded_q}%" if is_contains else f"{decoded_q}%"
                where_clauses.extend(['p.name_en LIKE ?', 'p.normalized_name_en LIKE ?'])
                params.extend([dec_pattern, dec_pattern])
                if is_contains:
                    where_clauses.append('p.scientific_name LIKE ?')
                    params.append(dec_pattern)
                dec_clean = clean_barcode_preserve_zeros(decoded_q)
                if dec_clean:
                    dec_clean_pat = f"%{dec_clean}%" if is_contains else f"{dec_clean}%"
                    where_clauses.extend(['p.code = ?', 'p.code LIKE ?', 'p.barcode = ?', 'p.barcode LIKE ?', 'p.gtin = ?', 'p.gtin LIKE ?', 'pb.barcode = ?', 'pb.barcode LIKE ?'])
                    params.extend([dec_clean, dec_clean_pat, dec_clean, dec_clean_pat, dec_clean, dec_clean_pat, dec_clean, dec_clean_pat])

        where_sql = " AND ".join(where_clauses) if len(words) > 1 else " OR ".join(where_clauses)

        cursor.execute(f"""
            SELECT COUNT(DISTINCT p.id) FROM products p
            {stk_join_sql}
            LEFT JOIN product_barcodes pb ON p.code = pb.product_code
            WHERE ({where_sql})
        """, tuple(params))
        total = cursor.fetchone()[0]
        
        # ترتيب النتائج الذكي حسب الأقرب لمطابقة كود الصنف ثم الاسم ثم الباركود
        order_params = [
            q_clean, f"{q_clean}%",
            f"{q}%", f"{norm_en}%" if norm_en else f"{q}%", f"{q}%",
            q_clean, q_clean,
            f"{q_clean}%", f"{q_clean}%"
        ]
        query_params = list(params) + order_params + [limit, offset]
        cursor.execute(f"""
            SELECT DISTINCT p.* FROM products p
            {stk_join_sql}
            LEFT JOIN product_barcodes pb ON p.code = pb.product_code
            WHERE ({where_sql})
            ORDER BY 
                CASE
                    WHEN p.code = ? THEN 1
                    WHEN p.code LIKE ? THEN 2
                    WHEN p.name_en LIKE ? OR p.normalized_name_en LIKE ? THEN 3
                    WHEN p.name_ar LIKE ? THEN 4
                    WHEN p.barcode = ? OR p.gtin = ? THEN 5
                    WHEN p.barcode LIKE ? OR p.gtin LIKE ? THEN 6
                    ELSE 7
                END,
                p.id DESC
            LIMIT ? OFFSET ?
        """, tuple(query_params))
        rows = cursor.fetchall()

    items = [dict(r) for r in rows]
    conn.close()
    for item in items:
        _attach_product_barcodes(item)
        if stock_only and item.get("code") in eligible_map:
            item.update(eligible_map[item["code"]])
    res_payload = {
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset
    }
    if stock_only:
        res_payload["store_no"] = resolved_store
        res_payload["bypassed_stock_filter"] = bypassed_stock_filter
    return res_payload

# ==================== إدارة الفواتير والمسح الضوئي ====================

def generate_invoice_number() -> str:
    """توليد رقم فاتورة تسلسلي يومي فريد (INV-YYYYMMDD-XXXX)"""
    today_str = datetime.datetime.now().strftime("%Y%m%d")
    prefix = f"INV-{today_str}-"
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1", (f"{prefix}%",))
    row = cursor.fetchone()
    conn.close()
    
    seq = 1
    if row:
        last_num = row[0]
        parts = last_num.split('-')
        if len(parts) >= 3 and parts[-1].isdigit():
            seq = int(parts[-1]) + 1
    return f"{prefix}{seq:04d}"

def get_or_create_draft_invoice(user_name: str = "المسؤول") -> Dict[str, Any]:
    """استرجاع مسودة الفاتورة النشطة الحالية أو إنشاء مسودة جديدة إذا لم تكن موجودة"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM invoices WHERE status = 'draft' ORDER BY id DESC LIMIT 1")
    row = cursor.fetchone()
    
    if row:
        inv = dict(row)
        conn.close()
        return get_invoice_details(inv["id"])
        
    inv_number = generate_invoice_number()
    inv_date = datetime.datetime.now().strftime("%Y-%m-%d")
    cursor.execute("""
        INSERT INTO invoices (invoice_number, invoice_date, status, user_name)
        VALUES (?, ?, 'draft', ?)
    """, (inv_number, inv_date, user_name))
    new_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return get_invoice_details(new_id)

def create_new_invoice(notes: str = "", user_name: str = "المسؤول") -> Dict[str, Any]:
    """إنشاء فاتورة مسودة جديدة فورية"""
    conn = get_connection()
    cursor = conn.cursor()
    inv_number = generate_invoice_number()
    inv_date = datetime.datetime.now().strftime("%Y-%m-%d")
    cursor.execute("""
        INSERT INTO invoices (invoice_number, invoice_date, status, notes, user_name)
        VALUES (?, ?, 'draft', ?, ?)
    """, (inv_number, inv_date, notes, user_name))
    new_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return get_invoice_details(new_id)

def get_invoice_details(invoice_id: int) -> Dict[str, Any]:
    """جلب تفاصيل الفاتورة كاملة مع سطورها المجمعة وقائمة سيريالات كل سطر"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM invoices WHERE id = ?", (invoice_id,))
    inv_row = cursor.fetchone()
    if not inv_row:
        conn.close()
        return {}
    inv = dict(inv_row)

    # جلب السطور المجمعة مع رقم GTIN والباركود والاسم الإنجليزي من بطاقة الصنف
    cursor.execute("""
        SELECT l.*, 
               COALESCE(p.gtin, '') as gtin, 
               COALESCE(p.barcode, '') as barcode,
               COALESCE(p.name_en, l.name_en, '') as product_name_en,
               COALESCE(p.name_ar, l.name_ar, '') as product_name_ar
        FROM invoice_lines l
        LEFT JOIN products p ON l.product_code = p.code
        WHERE l.invoice_id = ?
        ORDER BY l.id ASC
    """, (invoice_id,))
    lines = [dict(r) for r in cursor.fetchall()]

    # جلب السيريالات لكل سطر وضمان الاسم الإنجليزي بالكامل
    for line in lines:
        if line.get("product_name_en"):
            line["name_en"] = line["product_name_en"]
        if line.get("product_name_ar"):
            line["name_ar"] = line["product_name_ar"]
        if not line.get("name_en") and line.get("product_name"):
            line["name_en"] = line["product_name"]
        if line.get("batch_number"):
            line["batch_number"] = str(line["batch_number"]).strip().upper()

        line_id = line["id"]
        cursor.execute("""
            SELECT id, serial_number, scanned_at, user_name, is_confirmed, is_returned, return_reason
            FROM scanned_serials
            WHERE line_id = ?
            ORDER BY id ASC
        """, (line_id,))
        line["serials"] = [dict(s) for s in cursor.fetchall()]

    inv["lines"] = lines
    conn.close()
    return inv

def scan_qr_to_invoice(
    invoice_id: int,
    raw_qr_input: str,
    user_name: str = "المسؤول",
    quantity: int = 1
) -> Dict[str, Any]:
    """
    تحليل ومعالجة كود QR وإضافته إلى الفاتورة النشطة:
    1. استخراج GTIN، رقم الباتش، السيريال، تاريخ الانتهاء.
    2. التحقق من التعرف على الصنف.
    3. التحقق من تكرار السيريال في الفاتورة الحالية أو الفواتير المعتمدة السابقة.
    4. تجميع العبوات المتطابقة في الصنف والباتش وتاريخ الانتهاء في سطر واحد وزيادة الكمية.
    5. إنشاء سطر جديد في حال اختلاف الباتش أو تاريخ الانتهاء.
    6. حفظ وتوثيق كامل تفاصيل المسح وإمكانية إدخال الكمية يدوياً (quantity).
    """
    from .qr_parser import parse_qr_code

    # كل مسحة صحيحة لكود QR بالماسح تضيف عبوة واحدة (1 حبة) تلقائياً مع السيريال الخاص بها
    add_qty = 1

    # 1. تحليل كود QR
    parsed = parse_qr_code(raw_qr_input)
    if not parsed["success"]:
        return {
            "success": False,
            "code": parsed.get("code", "INVALID_QR"),
            "message": parsed.get("message", "صيغة كود QR غير صالحة أو غير معروفة.")
        }

    qr_data = parsed["data"]
    gtin = qr_data.get("gtin")
    batch = str(qr_data.get("batch") or "").strip().upper()
    serial = str(qr_data.get("serial") or "").strip()
    expiry = qr_data.get("expiry") or ""

    if not batch or not serial:
        return {
            "success": False,
            "code": "MISSING_BATCH_OR_SERIAL",
            "message": "كود QR لا يحتوي على رقم الباتش أو السيريال المطلوب."
        }

    # 2. التعرف على الصنف
    product = find_product_by_gtin_or_barcode(gtin)
    if not product:
        return {
            "success": False,
            "code": "ITEM_NOT_FOUND",
            "message": f"لم يتم العثور على الصنف المرتبط بهذا GTIN أو الباركود ({gtin}).",
            "gtin": gtin,
            "batch": batch,
            "serial": serial,
            "expiry": expiry
        }

    product_code = product["code"]
    product_name_ar = product.get("name_ar") or ""
    product_name_en = product.get("name_en") or ""
    product_name = product.get("name") or product_name_ar or product_name_en or f"صنف {product_code}"
    sales_price = float(product.get("selling_price") or 0.0)
    unit_price = float(product.get("unit_price") or product.get("cost_price") or 0.0)
    tax_rate = float(product.get("tax_rate") or 0.0)
    unit = str(product.get("unit") or "علبة").strip()

    conn = get_connection()
    cursor = conn.cursor()

    # التحقق من أن الفاتورة ما زالت مسودة
    cursor.execute("SELECT invoice_number, status FROM invoices WHERE id = ?", (invoice_id,))
    inv_info = cursor.fetchone()
    if not inv_info:
        conn.close()
        return {"success": False, "code": "NO_INVOICE", "message": "الفاتورة غير موجودة"}
    if inv_info["status"] != "draft":
        conn.close()
        return {"success": False, "code": "INVOICE_LOCKED", "message": "هذه الفاتورة معتمدة ولا يمكن إضافة عبوات جديدة إليها"}

    invoice_number = inv_info["invoice_number"]

    # 3. التحقق من تكرار السيريال:
    # أ) في الفاتورة الحالية المفتوحة
    cursor.execute("""
        SELECT id FROM scanned_serials
        WHERE invoice_id = ? AND serial_number = ? AND is_returned = 0
        LIMIT 1
    """, (invoice_id, serial))
    if cursor.fetchone():
        conn.close()
        return {
            "success": False,
            "code": "DUPLICATE_IN_CURRENT",
            "message": "هذا السيريال مسجل بالفعل، ولم تتم إضافة العبوة مرة أخرى.",
            "serial": serial,
            "gtin": gtin,
            "batch": batch,
            "expiry": expiry,
            "product_code": product_code,
            "name": product_name
        }

    # ب) في سجل الفواتير المعتمدة السابقة
    cursor.execute("""
        SELECT invoice_number FROM scanned_serials
        WHERE serial_number = ? AND product_code = ? AND is_confirmed = 1 AND is_returned = 0
        LIMIT 1
    """, (serial, product_code))
    prev_row = cursor.fetchone()
    if prev_row:
        prev_inv = prev_row["invoice_number"]
        conn.close()
        return {
            "success": False,
            "code": "ALREADY_CONFIRMED",
            "message": f"هذا السيريال مسجل بالفعل في فاتورة معتمدة سابقة (رقم: {prev_inv})، ولم تتم إضافة العبوة.",
            "serial": serial,
            "prev_invoice": prev_inv,
            "gtin": gtin,
            "batch": batch,
            "expiry": expiry,
            "product_code": product_code,
            "name": product_name
        }

    # 4. التجميع الذكي:
    # إذا كان الصنف والباتش وتاريخ الانتهاء متطابقة، تُجمع العبوات في سطر واحد وتزداد الكمية.
    # إذا اختلف الباتش أو تاريخ الانتهاء، ينشئ البرنامج سطرًا جديدًا.
    cursor.execute("""
        SELECT id, quantity FROM invoice_lines
        WHERE invoice_id = ? AND product_code = ? AND batch_number = ? AND expiry_date = ?
        LIMIT 1
    """, (invoice_id, product_code, batch, expiry))
    line_row = cursor.fetchone()

    if line_row:
        line_id = line_row["id"]
        new_line_qty = line_row["quantity"] + add_qty
        cursor.execute("""
            UPDATE invoice_lines SET quantity = ? WHERE id = ?
        """, (new_line_qty, line_id))
    else:
        cursor.execute("""
            INSERT INTO invoice_lines (
                invoice_id, invoice_number, product_code, product_name,
                name_ar, name_en, batch_number, expiry_date, quantity,
                sales_price, unit_price, tax_rate, unit
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            invoice_id, invoice_number, product_code, product_name,
            product_name_ar, product_name_en, batch, expiry, add_qty,
            sales_price, unit_price, tax_rate, unit
        ))
        line_id = cursor.lastrowid
        new_line_qty = add_qty

    # 5. حفظ سجل السيريال المفصل لكل مسح
    cursor.execute("""
        INSERT INTO scanned_serials (
            invoice_id, invoice_number, line_id, product_code,
            raw_code, raw_gtin_or_barcode, batch_number, serial_number,
            expiry_date, unit, quantity, user_name, is_confirmed, is_returned
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    """, (
        invoice_id, invoice_number, line_id, product_code,
        raw_qr_input, gtin, batch, serial,
        expiry, unit, add_qty, user_name
    ))

    # 6. تحديث إجماليات الفاتورة
    cursor.execute("""
        SELECT COUNT(*), COALESCE(SUM(quantity), 0), COALESCE(SUM(quantity * sales_price), 0)
        FROM invoice_lines WHERE invoice_id = ?
    """, (invoice_id,))
    totals = cursor.fetchone()
    total_items = totals[0]
    total_packages = totals[1]
    total_amount = totals[2]

    cursor.execute("""
        UPDATE invoices SET
            total_items = ?,
            total_packages = ?,
            total_amount = ?
        WHERE id = ?
    """, (total_items, total_packages, total_amount, invoice_id))

    conn.commit()
    conn.close()

    msg = f"تمت إضافة عبوة واحدة (حبة)، والكمية الحالية: {new_line_qty}."
    return {
        "success": True,
        "code": "ADDED",
        "message": msg,
        "line_qty": new_line_qty,
        "added_qty": add_qty,
        "product_code": product_code,
        "name": product_name,
        "name_en": product_name_en,
        "name_ar": product_name_ar,
        "gtin": gtin,
        "batch": batch,
        "serial": serial,
        "expiry": expiry
    }

def update_invoice_line_quantity(invoice_id: int, line_id: int, new_quantity: int) -> Dict[str, Any]:
    """تعديل كمية سطر الفاتورة يدوياً وتحديث إجماليات الفاتورة فوراً"""
    new_qty = int(new_quantity)
    if new_qty <= 0:
        return {"success": False, "message": "يجب أن تكون الكمية أكبر من الصفر (1 على الأقل)."}
    
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT status FROM invoices WHERE id = ?", (invoice_id,))
    inv = cursor.fetchone()
    if not inv:
        conn.close()
        return {"success": False, "message": "الفاتورة غير موجودة"}
    if inv["status"] != "draft":
        conn.close()
        return {"success": False, "message": "الفاتورة معتمدة ولا يمكن تعديل كمياتها"}

    cursor.execute("SELECT id, product_code, batch_number, expiry_date, quantity FROM invoice_lines WHERE id = ? AND invoice_id = ?", (line_id, invoice_id))
    line = cursor.fetchone()
    if not line:
        conn.close()
        return {"success": False, "message": "سطر البند غير موجود في هذه الفاتورة"}

    cursor.execute("UPDATE invoice_lines SET quantity = ? WHERE id = ?", (new_qty, line_id))

    # تحديث إجماليات الفاتورة
    cursor.execute("""
        SELECT COUNT(*), COALESCE(SUM(quantity), 0), COALESCE(SUM(quantity * sales_price), 0)
        FROM invoice_lines WHERE invoice_id = ?
    """, (invoice_id,))
    totals = cursor.fetchone()
    total_items = totals[0]
    total_packages = totals[1]
    total_amount = totals[2]

    cursor.execute("""
        UPDATE invoices SET
            total_items = ?,
            total_packages = ?,
            total_amount = ?
        WHERE id = ?
    """, (total_items, total_packages, total_amount, invoice_id))

    conn.commit()
    conn.close()
    return {
        "success": True,
        "message": f"تم تعديل الكمية بنجاح إلى {new_qty}",
        "new_quantity": new_qty
    }

def add_manual_item_to_invoice(
    invoice_id: int,
    gtin_or_code: str,
    batch: str,
    expiry: str,
    quantity: int = 1,
    user_name: str = "المسؤول"
) -> Dict[str, Any]:
    """إدخال صنف وكمية وباتش وتاريخ صلاحية يدوياً بدون مسح QR"""
    val = str(gtin_or_code or "").strip()
    if not val:
        return {"success": False, "message": "يرجى كتابة كود الصنف أو الباركود أو GTIN."}
    
    product = find_product_by_gtin_or_barcode(val) or get_product_by_code(val)
    if not product:
        return {"success": False, "code": "ITEM_NOT_FOUND", "message": f"لم يتم العثور على الصنف ({val})."}
    
    from .qr_parser import decode_arabic_keyboard_layout
    clean_batch = decode_arabic_keyboard_layout(str(batch or "").strip()).upper() or "BATCH1"
    from .qr_parser import parse_expiry_date
    clean_exp = parse_expiry_date(expiry) or expiry or "2027-12-31"
    clean_qty = max(1, int(quantity or 1))
    
    import uuid
    dummy_serial = f"MANUAL-{uuid.uuid4().hex[:6].upper()}"
    raw_str = f"MANUAL|{val}|{clean_batch}|{clean_exp}|{dummy_serial}|QTY:{clean_qty}"
    
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT invoice_number, status FROM invoices WHERE id = ?", (invoice_id,))
    inv = cursor.fetchone()
    if not inv or inv["status"] != "draft":
        conn.close()
        return {"success": False, "message": "الفاتورة غير موجودة أو معتمدة."}
    
    inv_num = inv["invoice_number"]
    p_code = product["code"]
    p_name_ar = product.get("name_ar") or ""
    p_name_en = product.get("name_en") or ""
    p_name = p_name_en or product.get("name") or p_name_ar or f"صنف {p_code}"
    sales_price = float(product.get("selling_price") or 0.0)
    unit_price = float(product.get("unit_price") or product.get("cost_price") or 0.0)
    tax_rate = float(product.get("tax_rate") or 0.0)
    unit = str(product.get("unit") or "علبة").strip()
    
    cursor.execute("""
        SELECT id, quantity FROM invoice_lines
        WHERE invoice_id = ? AND product_code = ? AND batch_number = ? AND expiry_date = ?
        LIMIT 1
    """, (invoice_id, p_code, clean_batch, clean_exp))
    l_row = cursor.fetchone()
    if l_row:
        line_id = l_row["id"]
        new_line_qty = l_row["quantity"] + clean_qty
        cursor.execute("UPDATE invoice_lines SET quantity = ? WHERE id = ?", (new_line_qty, line_id))
    else:
        cursor.execute("""
            INSERT INTO invoice_lines (
                invoice_id, invoice_number, product_code, product_name,
                name_ar, name_en, batch_number, expiry_date, quantity,
                sales_price, unit_price, tax_rate, unit
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            invoice_id, inv_num, p_code, p_name,
            p_name_ar, p_name_en, clean_batch, clean_exp, clean_qty,
            sales_price, unit_price, tax_rate, unit
        ))
        line_id = cursor.lastrowid
        new_line_qty = clean_qty
        
    cursor.execute("""
        INSERT INTO scanned_serials (
            invoice_id, invoice_number, line_id, product_code,
            raw_code, raw_gtin_or_barcode, batch_number, serial_number,
            expiry_date, unit, quantity, user_name, is_confirmed, is_returned
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
    """, (
        invoice_id, inv_num, line_id, p_code,
        raw_str, val, clean_batch, dummy_serial,
        clean_exp, unit, clean_qty, user_name
    ))
    
    cursor.execute("""
        SELECT COUNT(*), COALESCE(SUM(quantity), 0), COALESCE(SUM(quantity * sales_price), 0)
        FROM invoice_lines WHERE invoice_id = ?
    """, (invoice_id,))
    totals = cursor.fetchone()
    cursor.execute("""
        UPDATE invoices SET
            total_items = ?,
            total_packages = ?,
            total_amount = ?
        WHERE id = ?
    """, (totals[0], totals[1], totals[2], invoice_id))
    
    conn.commit()
    conn.close()
    
    return {
        "success": True,
        "code": "ADDED",
        "message": f"تمت إضافة {clean_qty} عبوة من الصنف ({p_name_en or p_name}) بنجاح.",
        "product_code": p_code,
        "name": p_name,
        "name_en": p_name_en,
        "batch": clean_batch,
        "expiry": clean_exp,
        "serial": dummy_serial,
        "line_qty": new_line_qty,
        "added_qty": clean_qty
    }

def delete_scanned_serial(invoice_id: int, serial_id: int) -> Dict[str, Any]:
    """
    حذف عبوة أضيفت بالخطأ من مسودة الفاتورة:
    يُحذف سيريالها من تفاصيل الفاتورة ويُعاد احتساب الكمية، وإن أصبحت الكمية 0 يُحذف السطر.
    """
    conn = get_connection()
    cursor = conn.cursor()
    
    # التحقق من أن الفاتورة ما زالت مسودة
    cursor.execute("SELECT status FROM invoices WHERE id = ?", (invoice_id,))
    inv = cursor.fetchone()
    if not inv or inv["status"] != "draft":
        conn.close()
        return {"success": False, "message": "لا يمكن حذف عبوات من فاتورة معتمدة."}

    # العثور على السيريال والسطر المرتبط به
    cursor.execute("SELECT line_id FROM scanned_serials WHERE id = ? AND invoice_id = ?", (serial_id, invoice_id))
    s_row = cursor.fetchone()
    if not s_row:
        conn.close()
        return {"success": False, "message": "لم يتم العثور على السيريال المحدد."}
        
    line_id = s_row["line_id"]

    # حذف السيريال من سجل الفاتورة المسودة
    cursor.execute("DELETE FROM scanned_serials WHERE id = ?", (serial_id,))

    # إعادة احتساب كمية السطر
    cursor.execute("SELECT COUNT(*) FROM scanned_serials WHERE line_id = ? AND is_returned = 0", (line_id,))
    remaining_in_line = cursor.fetchone()[0]

    if remaining_in_line <= 0:
        cursor.execute("DELETE FROM invoice_lines WHERE id = ?", (line_id,))
    else:
        cursor.execute("UPDATE invoice_lines SET quantity = ? WHERE id = ?", (remaining_in_line, line_id))

    # تحديث إجماليات الفاتورة
    cursor.execute("""
        SELECT COUNT(*), COALESCE(SUM(quantity), 0), COALESCE(SUM(quantity * sales_price), 0)
        FROM invoice_lines WHERE invoice_id = ?
    """, (invoice_id,))
    totals = cursor.fetchone()
    cursor.execute("""
        UPDATE invoices SET
            total_items = ?,
            total_packages = ?,
            total_amount = ?
        WHERE id = ?
    """, (totals[0], totals[1], totals[2], invoice_id))

    conn.commit()
    conn.close()
    return {"success": True, "message": "تم حذف العبوة بنجاح وتحديث الكمية."}

def delete_invoice_line(invoice_id: int, line_id: int) -> Dict[str, Any]:
    """حذف سطر بالكامل بسيريالاته من الفاتورة المسودة"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT status FROM invoices WHERE id = ?", (invoice_id,))
    inv = cursor.fetchone()
    if not inv or inv["status"] != "draft":
        conn.close()
        return {"success": False, "message": "لا يمكن حذف سطور من فاتورة معتمدة."}

    cursor.execute("DELETE FROM scanned_serials WHERE line_id = ? AND invoice_id = ?", (line_id, invoice_id))
    cursor.execute("DELETE FROM invoice_lines WHERE id = ? AND invoice_id = ?", (line_id, invoice_id))

    cursor.execute("""
        SELECT COUNT(*), COALESCE(SUM(quantity), 0), COALESCE(SUM(quantity * sales_price), 0)
        FROM invoice_lines WHERE invoice_id = ?
    """, (invoice_id,))
    totals = cursor.fetchone()
    cursor.execute("""
        UPDATE invoices SET
            total_items = ?,
            total_packages = ?,
            total_amount = ?
        WHERE id = ?
    """, (totals[0], totals[1], totals[2], invoice_id))

    conn.commit()
    conn.close()
    return {"success": True, "message": "تم حذف السطر وسيريالاته بنجاح."}

def clear_invoice_lines(invoice_id: int) -> Dict[str, Any]:
    """مسح وتفريغ جميع الأصناف والعبوات من الفاتورة بالكامل بعد العملية"""
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT status FROM invoices WHERE id = ?", (invoice_id,))
    inv = cursor.fetchone()
    if not inv:
        conn.close()
        return {"success": False, "message": "الفاتورة غير موجودة."}
    if inv["status"] != "draft":
        conn.close()
        return {"success": False, "message": "لا يمكن تفريغ فاتورة معتمدة."}

    cursor.execute("DELETE FROM scanned_serials WHERE invoice_id = ?", (invoice_id,))
    cursor.execute("DELETE FROM invoice_lines WHERE invoice_id = ?", (invoice_id,))
    cursor.execute("""
        UPDATE invoices SET
            total_items = 0,
            total_packages = 0,
            total_amount = 0.0
        WHERE id = ?
    """, (invoice_id,))

    conn.commit()
    conn.close()
    return {"success": True, "message": "تم مسح وتفريغ جميع أصناف الفاتورة بالكامل بنجاح."}

def confirm_invoice(invoice_id: int) -> Dict[str, Any]:
    """
    اعتماد الفاتورة نهائياً:
    - نقل الحالة إلى 'confirmed'
    - تعيين is_confirmed = 1 لجميع السيريالات الممسوحة لحمايتها ومنع مسحها مجدداً في أي فاتورة أخرى
    """
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT status, total_packages FROM invoices WHERE id = ?", (invoice_id,))
    row = cursor.fetchone()
    if not row:
        conn.close()
        return {"success": False, "message": "الفاتورة غير موجودة."}
    if row["status"] == "confirmed":
        conn.close()
        return {"success": True, "message": "تم اعتماد الفاتورة ويمكن تصديرها إلى Excel."}
    if row["total_packages"] <= 0:
        conn.close()
        return {"success": False, "message": "لا يمكن اعتماد فاتورة فارغة بدون عبوات ممسوحة."}

    cursor.execute("""
        UPDATE invoices SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?
    """, (invoice_id,))
    cursor.execute("""
        UPDATE scanned_serials SET is_confirmed = 1 WHERE invoice_id = ?
    """, (invoice_id,))

    conn.commit()
    conn.close()
    return {"success": True, "message": "تم اعتماد الفاتورة ويمكن تصديرها إلى Excel."}

def process_serial_return(
    serial_number: str,
    invoice_number: str = "",
    reason: str = "إرجاع عبوة",
    user_name: str = "المسؤول"
) -> Dict[str, Any]:
    """
    معالجة الإرجاعات أو الإلغاءات بعكس موثق للعملية، لا بحذف سجل السيريال.
    يتم تمييز السيريال بأنه مرتجع مع تسجيل وقت وسبب الإرجاع واسم المستخدم.
    """
    clean_sn = str(serial_number).strip()
    if not clean_sn:
        return {"success": False, "message": "رقم السيريال غير صالح"}

    conn = get_connection()
    cursor = conn.cursor()

    query = """
        SELECT id, invoice_number, product_code, is_returned FROM scanned_serials
        WHERE serial_number = ? AND is_confirmed = 1
    """
    params = [clean_sn]
    if invoice_number:
        query += " AND invoice_number = ?"
        params.append(invoice_number.strip())

    cursor.execute(query, params)
    row = cursor.fetchone()
    if not row:
        conn.close()
        return {"success": False, "message": "لم يتم العثور على سيريال معتمد مطابق للبيانات المدخلة."}

    if row["is_returned"]:
        conn.close()
        return {"success": False, "message": "هذا السيريال مسجل كمرتجع بالفعل مسبقاً."}

    serial_id = row["id"]
    inv_num = row["invoice_number"]
    p_code = row["product_code"]

    # توثيق الإرجاع في جدول scanned_serials دون حذف السجل
    cursor.execute("""
        UPDATE scanned_serials SET
            is_returned = 1,
            return_reason = ?,
            returned_at = CURRENT_TIMESTAMP,
            returned_by = ?
        WHERE id = ?
    """, (reason, user_name, serial_id))

    # تسجيل حركة الإرجاع في returns_log
    cursor.execute("""
        INSERT INTO returns_log (serial_id, serial_number, product_code, invoice_number, return_reason, returned_by)
        VALUES (?, ?, ?, ?, ?, ?)
    """, (serial_id, clean_sn, p_code, inv_num, reason, user_name))

    conn.commit()
    conn.close()
    return {
        "success": True,
        "message": f"تم توثيق إرجاع العبوة (السيريال: {clean_sn}) بنجاح وحفظ سجل العملية كاملاً."
    }

def get_all_invoices(limit: int = 50, offset: int = 0) -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM invoices ORDER BY id DESC LIMIT ? OFFSET ?", (limit, offset))
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def get_stats() -> Dict[str, int]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM products")
    products_count = cursor.fetchone()[0]
    cursor.execute("SELECT COUNT(*) FROM product_barcodes")
    barcodes_count = cursor.fetchone()[0]
    cursor.execute("SELECT COUNT(*) FROM invoices WHERE status = 'confirmed'")
    confirmed_invoices = cursor.fetchone()[0]
    cursor.execute("SELECT COUNT(*) FROM scanned_serials WHERE is_confirmed = 1 AND is_returned = 0")
    active_serials = cursor.fetchone()[0]
    conn.close()
    return {
        "products_count": products_count,
        "barcodes_count": barcodes_count,
        "invoices_count": confirmed_invoices,
        "active_serials": active_serials
    }

# ==================== التوافق مع بقية النظام السابق ====================
def get_all_products() -> List[Dict[str, Any]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM products ORDER BY id DESC")
    rows = cursor.fetchall()
    conn.close()
    items = [dict(r) for r in rows]
    for it in items:
        _attach_product_barcodes(it)
    return items

def get_all_product_barcodes() -> List[Dict[str, str]]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT product_code, barcode, barcode_type FROM product_barcodes")
    rows = cursor.fetchall()
    conn.close()
    return [dict(r) for r in rows]

def clear_catalog():
    try:
        if is_using_permanent_db():
            create_backup(reason="pre_clear_catalog")
    except Exception:
        pass
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM products")
    cursor.execute("DELETE FROM product_barcodes")
    cursor.execute("DELETE FROM product_aliases")
    conn.commit()
    conn.close()
    # تسجيل التفريغ المتعمد حتى لا تعيد المزامنة التلقائية استيراد product.template.xlsx بعد 20 ثانية
    try:
        state_file = os.path.join(DB_DIR, "catalog_autosync.json")
        state = {}
        if os.path.exists(state_file):
            with open(state_file, "r", encoding="utf-8") as f:
                state = json.load(f) or {}
        state["catalog_intentionally_cleared"] = True
        state["cleared_at"] = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with open(state_file, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
    except Exception:
        pass

def save_alias(invoice_name: str, product_code: str):
    clean_code = clean_numeric_code(product_code)
    if not invoice_name or not clean_code:
        return
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("""
    INSERT INTO product_aliases (invoice_name, product_code)
    VALUES (?, ?)
    ON CONFLICT(invoice_name) DO UPDATE SET product_code = excluded.product_code
    """, (invoice_name.strip(), clean_code))
    conn.commit()
    conn.close()

def get_aliases() -> Dict[str, str]:
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT invoice_name, product_code FROM product_aliases")
    rows = cursor.fetchall()
    conn.close()
    return {r["invoice_name"]: r["product_code"] for r in rows}

def save_supplier_template(supplier_name: str, mapping: Dict[str, Any], headers: List[str] = None) -> bool:
    import json
    if not supplier_name:
        return False
    conn = get_connection()
    cursor = conn.cursor()
    m_json = json.dumps(mapping, ensure_ascii=False)
    h_json = json.dumps(headers or [], ensure_ascii=False)
    cursor.execute("""
    INSERT INTO supplier_templates (supplier_name, mapping, headers, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(supplier_name) DO UPDATE SET
        mapping = excluded.mapping,
        headers = excluded.headers,
        updated_at = CURRENT_TIMESTAMP
    """, (supplier_name.strip(), m_json, h_json))
    conn.commit()
    conn.close()
    return True

def get_all_supplier_templates() -> List[Dict[str, Any]]:
    import json
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM supplier_templates ORDER BY updated_at DESC")
    rows = cursor.fetchall()
    conn.close()
    res = []
    for r in rows:
        d = dict(r)
        try:
            d["mapping"] = json.loads(d["mapping"])
        except:
            d["mapping"] = {}
        try:
            d["headers"] = json.loads(d["headers"]) if d["headers"] else []
        except:
            d["headers"] = []
        res.append(d)
    return res

def delete_supplier_template(supplier_name: str) -> bool:
    if not supplier_name:
        return False
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DELETE FROM supplier_templates WHERE supplier_name = ?", (supplier_name.strip(),))
    conn.commit()
    conn.close()
    return True

def get_supplier_template(supplier_name: str) -> Optional[Dict[str, Any]]:
    import json
    if not supplier_name:
        return None
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM supplier_templates WHERE supplier_name = ? LIMIT 1", (supplier_name.strip(),))
    row = cursor.fetchone()
    conn.close()
    if not row:
        return None
    d = dict(row)
    try:
        d["mapping"] = json.loads(d["mapping"])
    except:
        d["mapping"] = {}
    try:
        d["headers"] = json.loads(d["headers"]) if d["headers"] else []
    except:
        d["headers"] = []
    return d

def find_matching_supplier_template(supplier_name: Any = "", headers: Optional[List[str]] = None) -> Optional[Dict[str, Any]]:
    if isinstance(supplier_name, list) and headers is None:
        headers = supplier_name
        supplier_name = ""

    all_tpls = get_all_supplier_templates()
    if not all_tpls:
        return None

    if supplier_name and str(supplier_name).strip():
        s_norm = str(supplier_name).strip().lower()
        for tpl in all_tpls:
            if str(tpl.get("supplier_name", "")).strip().lower() == s_norm:
                return tpl

    if headers:
        h_set = set(str(h).strip().lower() for h in headers)
        for tpl in all_tpls:
            tpl_headers = set(str(h).strip().lower() for h in tpl.get("headers", []))
            if tpl_headers and tpl_headers.issubset(h_set):
                return tpl

    return None
