import os
import re
import sqlite3
import datetime
from typing import Dict, Any, List, Optional
import openpyxl

from .db import (
    get_connection,
    clean_numeric_code,
    clean_barcode_preserve_zeros,
    find_product_by_gtin_or_barcode,
    get_product_by_code,
    _build_product_search_where,
    _attach_product_barcodes
)
from .qr_parser import parse_qr_code, extract_clean_gtin, parse_expiry_date

def init_stock_tables():
    """تهيئة جداول الاستورات والمخزون والجرد مع حسابات التكلفة وسعر البيع معاً"""
    conn = get_connection()
    c = conn.cursor()

    # 1. جدول الاستورات (Stores)
    c.execute("""
        CREATE TABLE IF NOT EXISTS stock_stores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store_no TEXT UNIQUE NOT NULL,
            store_name TEXT NOT NULL,
            branch_name TEXT DEFAULT 'الفرع الرئيسي',
            status TEXT DEFAULT 'new', -- new, in_progress, completed, settled
            created_by TEXT DEFAULT 'المسؤول',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            counted_at TIMESTAMP
        )
    """)

    c.execute("SELECT COUNT(*) as cnt FROM stock_stores")
    if c.fetchone()['cnt'] == 0:
        c.execute("""
            INSERT INTO stock_stores (store_no, store_name, branch_name, status, created_by)
            VALUES ('ST-001', 'الاستور الرئيسي', 'الفرع الرئيسي', 'new', 'المسؤول')
        """)

    # 2. جدول رصيد المخزون الدفتري المسجل (يحفظ سعر التكلفة وسعر البيع)
    c.execute("""
        CREATE TABLE IF NOT EXISTS inventory_records (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_code TEXT NOT NULL,
            product_name TEXT,
            barcode TEXT,
            batch_number TEXT DEFAULT '',
            expiry_date TEXT DEFAULT '',
            system_qty REAL DEFAULT 0,
            cost_price REAL DEFAULT 0,
            selling_price REAL DEFAULT 0,
            item_type TEXT DEFAULT 'medicine',
            store_no TEXT DEFAULT 'ST-001',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    c.execute("CREATE INDEX IF NOT EXISTS idx_inv_code_batch ON inventory_records(product_code, batch_number);")
    c.execute("CREATE INDEX IF NOT EXISTS idx_inv_store ON inventory_records(store_no);")

    # 3. جدول بنود الجرد الفعلي المسحوبة
    c.execute("""
        CREATE TABLE IF NOT EXISTS stocktake_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_code TEXT NOT NULL,
            product_name TEXT,
            barcode TEXT DEFAULT '',
            gtin TEXT DEFAULT '',
            batch_number TEXT DEFAULT '',
            expiry_date TEXT DEFAULT '',
            system_qty REAL DEFAULT 0,
            counted_qty REAL DEFAULT 0,
            cost_price REAL DEFAULT 0,
            selling_price REAL DEFAULT 0,
            is_new_batch INTEGER DEFAULT 0,
            item_type TEXT DEFAULT 'medicine',
            store_no TEXT DEFAULT 'ST-001',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    c.execute("CREATE INDEX IF NOT EXISTS idx_stk_code_batch ON stocktake_entries(product_code, batch_number, store_no);")

    # 4. جدول سيريالات الجرد لمنع التكرار قطعياً
    c.execute("""
        CREATE TABLE IF NOT EXISTS stocktake_scanned_serials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            serial_number TEXT NOT NULL,
            product_code TEXT NOT NULL,
            batch_number TEXT DEFAULT '',
            store_no TEXT DEFAULT 'ST-001',
            scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(serial_number, product_code, store_no)
        )
    """)
    c.execute("CREATE INDEX IF NOT EXISTS idx_stk_serials ON stocktake_scanned_serials(serial_number, product_code, store_no);")

    # تحديث وتصحيح تلقائي لبنود الجرد السابقة لضمان ظهور الاسم الإنجليزي والباتش وتاريخ الصلاحية ورصيد المخزون والتكلفة
    try:
        c.execute("UPDATE inventory_records SET batch_number = UPPER(TRIM(batch_number)) WHERE batch_number IS NOT NULL AND batch_number != UPPER(TRIM(batch_number))")
        c.execute("UPDATE stocktake_entries SET batch_number = UPPER(TRIM(batch_number)) WHERE batch_number IS NOT NULL AND batch_number != UPPER(TRIM(batch_number))")
        c.execute("UPDATE stocktake_scanned_serials SET batch_number = UPPER(TRIM(batch_number)) WHERE batch_number IS NOT NULL AND batch_number != UPPER(TRIM(batch_number))")
        c.execute("""
            UPDATE stocktake_entries
            SET 
                product_name = COALESCE((
                    SELECT COALESCE(NULLIF(name_en, ''), name)
                    FROM products
                    WHERE products.code = stocktake_entries.product_code
                ), product_name),
                batch_number = CASE 
                    WHEN batch_number = '' OR batch_number IS NULL THEN COALESCE((
                        SELECT batch_number FROM inventory_records
                        WHERE inventory_records.product_code = stocktake_entries.product_code
                          AND inventory_records.store_no = stocktake_entries.store_no
                          AND inventory_records.batch_number != ''
                        ORDER BY id DESC LIMIT 1
                    ), (
                        SELECT batch_number FROM inventory_records
                        WHERE inventory_records.product_code = stocktake_entries.product_code
                          AND inventory_records.batch_number != ''
                        ORDER BY id DESC LIMIT 1
                    ), batch_number)
                    ELSE batch_number
                END,
                expiry_date = CASE 
                    WHEN expiry_date = '' OR expiry_date IS NULL THEN COALESCE((
                        SELECT expiry_date FROM inventory_records
                        WHERE inventory_records.product_code = stocktake_entries.product_code
                          AND inventory_records.store_no = stocktake_entries.store_no
                          AND inventory_records.expiry_date != ''
                        ORDER BY id DESC LIMIT 1
                    ), (
                        SELECT expiry_date FROM inventory_records
                        WHERE inventory_records.product_code = stocktake_entries.product_code
                          AND inventory_records.expiry_date != ''
                        ORDER BY id DESC LIMIT 1
                    ), expiry_date)
                    ELSE expiry_date
                END,
                system_qty = CASE 
                    WHEN system_qty = 0 OR system_qty IS NULL THEN COALESCE((
                        SELECT system_qty FROM inventory_records
                        WHERE inventory_records.product_code = stocktake_entries.product_code
                          AND inventory_records.store_no = stocktake_entries.store_no
                        ORDER BY id DESC LIMIT 1
                    ), (
                        SELECT system_qty FROM inventory_records
                        WHERE inventory_records.product_code = stocktake_entries.product_code
                        ORDER BY id DESC LIMIT 1
                    ), 0)
                    ELSE system_qty
                END,
                cost_price = CASE 
                    WHEN cost_price = 0 OR cost_price IS NULL THEN COALESCE((
                        SELECT cost_price FROM inventory_records
                        WHERE inventory_records.product_code = stocktake_entries.product_code
                          AND inventory_records.cost_price > 0
                        LIMIT 1
                    ), (SELECT cost_price FROM products WHERE products.code = stocktake_entries.product_code AND cost_price > 0), 0)
                    ELSE cost_price
                END,
                selling_price = CASE 
                    WHEN selling_price = 0 OR selling_price IS NULL THEN COALESCE((
                        SELECT selling_price FROM inventory_records
                        WHERE inventory_records.product_code = stocktake_entries.product_code
                          AND inventory_records.selling_price > 0
                        LIMIT 1
                    ), (SELECT selling_price FROM products WHERE products.code = stocktake_entries.product_code AND selling_price > 0), 0)
                    ELSE selling_price
                END
        """)

        # إعادة ربط أي بنود جرد أو سيريالات معلقة على كود استور محذوف/غير موجود بالاستور النشط الحالي
        c.execute("SELECT store_no FROM stock_stores ORDER BY id DESC LIMIT 1")
        active_st = c.fetchone()
        if active_st:
            act_no = active_st['store_no']
            c.execute("""
                UPDATE stocktake_entries
                SET store_no = ?
                WHERE store_no NOT IN (SELECT store_no FROM stock_stores)
            """, (act_no,))
            c.execute("""
                UPDATE stocktake_scanned_serials
                SET store_no = ?
                WHERE store_no NOT IN (SELECT store_no FROM stock_stores)
            """, (act_no,))
    except Exception as e:
        logger.warning(f"Stock entries auto-repair error: {e}")

    conn.commit()
    conn.close()

init_stock_tables()

def resolve_valid_store_no(conn, store_no: str = '') -> str:
    """التحقق من صحة كود الاستور، وإذا كان فارغاً أو محذوفاً يتم إرجاع الاستور الفعلي الحالي أو إنشاء ST-001"""
    c = conn.cursor()
    clean_no = str(store_no or '').strip()
    if clean_no and clean_no != 'ALL':
        c.execute("SELECT store_no FROM stock_stores WHERE store_no = ?", (clean_no,))
        row = c.fetchone()
        if row:
            return row['store_no']
    
    # محاولة جلب أحدث استور موجود
    c.execute("SELECT store_no FROM stock_stores ORDER BY id DESC LIMIT 1")
    row = c.fetchone()
    if row:
        return row['store_no']

    # إذا لم يوجد أي استور، ننشئ الاستور الافتراضي
    c.execute("""
        INSERT INTO stock_stores (store_no, store_name, branch_name, status, created_by)
        VALUES ('ST-001', 'الاستور الرئيسي', 'الفرع الرئيسي', 'new', 'المسؤول')
    """)
    conn.commit()
    return 'ST-001'

# ==================== إدارة الاستورات ====================

def get_all_stores(search_q: str = '') -> Dict[str, Any]:
    """
    جلب الاستورات مقسمة إلى قسمين مع شريط التكلفة وسعر البيع الأوسط:
    - النصف العلوي: الاستورات المنشأة
    - النصف السفلي: الاستورات الجاري أو المكتمل جردها
    - الشريط الأوسط: إجماليات التكلفة والبيع معاً
    """
    conn = get_connection()
    c = conn.cursor()

    sql = """
        SELECT s.*,
            COALESCE((SELECT COUNT(DISTINCT product_code) FROM stocktake_entries WHERE store_no = s.store_no), 0) as counted_items,
            COALESCE((SELECT SUM(counted_qty) FROM stocktake_entries WHERE store_no = s.store_no), 0) as counted_qty,
            COALESCE((SELECT SUM(counted_qty * cost_price) FROM stocktake_entries WHERE store_no = s.store_no), 0) as counted_cost,
            COALESCE((SELECT SUM(counted_qty * selling_price) FROM stocktake_entries WHERE store_no = s.store_no), 0) as counted_sale,
            COALESCE((SELECT SUM(system_qty * cost_price) FROM inventory_records WHERE store_no = s.store_no), 0) as system_cost,
            COALESCE((SELECT SUM(system_qty * selling_price) FROM inventory_records WHERE store_no = s.store_no), 0) as system_sale,
            COALESCE((SELECT COUNT(*) FROM stocktake_entries WHERE store_no = s.store_no AND is_new_batch = 1), 0) as new_batches_count
        FROM stock_stores s
    """
    params = []
    if search_q:
        sql += " WHERE (s.store_no LIKE ? OR s.store_name LIKE ? OR s.branch_name LIKE ?)"
        q_like = f"%{search_q.strip()}%"
        params = [q_like, q_like, q_like]

    sql += " ORDER BY s.id DESC"
    c.execute(sql, tuple(params))
    rows = [dict(r) for r in c.fetchall()]

    created_stores = []
    counted_stores = []

    total_system_cost = 0.0
    total_system_sale = 0.0
    total_counted_cost = 0.0
    total_counted_sale = 0.0
    total_counted_qty = 0.0
    total_counted_items = 0

    for r in rows:
        c_qty = float(r['counted_qty'] or 0)
        c_cost = float(r['counted_cost'] or 0)
        c_sale = float(r['counted_sale'] or 0)
        s_cost = float(r['system_cost'] or 0)
        s_sale = float(r['system_sale'] or 0)

        total_system_cost += s_cost
        total_system_sale += s_sale
        total_counted_cost += c_cost
        total_counted_sale += c_sale
        total_counted_qty += c_qty
        total_counted_items += int(r['counted_items'] or 0)

        if c_qty > 0 or r['status'] in ('in_progress', 'completed'):
            counted_stores.append(r)
        created_stores.append(r)

    conn.close()

    return {
        "created_stores": created_stores,
        "counted_stores": counted_stores,
        "summary": {
            "total_stores": len(rows),
            "total_active_counted": len(counted_stores),
            "total_counted_items": total_counted_items,
            "total_counted_qty": round(total_counted_qty, 2),
            "total_system_cost": round(total_system_cost, 2),
            "total_system_sale": round(total_system_sale, 2),
            "total_counted_cost": round(total_counted_cost, 2),
            "total_counted_sale": round(total_counted_sale, 2),
            "diff_cost": round(total_counted_cost - total_system_cost, 2),
            "diff_sale": round(total_counted_sale - total_system_sale, 2)
        }
    }

def create_new_store(store_name: str, branch_name: str = 'الفرع الرئيسي', user_name: str = 'المسؤول') -> Dict[str, Any]:
    """إنشاء استور جديد"""
    name = (store_name or '').strip()
    if not name:
        return {"success": False, "message": "يُرجى إدخال اسم الاستور"}

    conn = get_connection()
    c = conn.cursor()

    c.execute("SELECT id FROM stock_stores ORDER BY id DESC LIMIT 1")
    last_id = c.fetchone()
    next_num = (last_id['id'] + 1) if last_id else 1
    store_no = f"ST-{next_num:03d}"

    c.execute("""
        INSERT INTO stock_stores (store_no, store_name, branch_name, status, created_by)
        VALUES (?, ?, ?, 'new', ?)
    """, (store_no, name, branch_name or 'الفرع الرئيسي', user_name))
    new_id = c.lastrowid
    conn.commit()
    conn.close()

    return {"success": True, "store_id": new_id, "store_no": store_no, "store_name": name, "message": "تم إنشاء الاستور بنجاح"}

def update_store(store_no: str, store_name: str, branch_name: str) -> Dict[str, Any]:
    """تعديل بيانات استور"""
    conn = get_connection()
    c = conn.cursor()
    c.execute("""
        UPDATE stock_stores
        SET store_name = ?, branch_name = ?
        WHERE store_no = ?
    """, (store_name.strip(), branch_name.strip(), store_no.strip()))
    conn.commit()
    conn.close()
    return {"success": True, "message": "تم تحديث بيانات الاستور بنجاح"}

def delete_store(store_no: str) -> Dict[str, Any]:
    """حذف استور بجميع بياناته وبنوده وسجلاته"""
    store_no = str(store_no or '').strip()
    if not store_no:
        return {"success": False, "message": "رقم الاستور غير صالح"}

    conn = get_connection()
    c = conn.cursor()

    # 1. حذف بنود الجرد والسيريالات والمخزون المرتبط بالاستور
    c.execute("DELETE FROM stocktake_entries WHERE store_no = ?", (store_no,))
    c.execute("DELETE FROM stocktake_scanned_serials WHERE store_no = ?", (store_no,))
    c.execute("DELETE FROM inventory_records WHERE store_no = ?", (store_no,))
    c.execute("DELETE FROM stock_stores WHERE store_no = ?", (store_no,))

    # 2. التأكد من وجود استور واحد على الأقل دائماً
    c.execute("SELECT COUNT(*) as cnt FROM stock_stores")
    if c.fetchone()['cnt'] == 0:
        c.execute("""
            INSERT INTO stock_stores (store_no, store_name, branch_name, status, created_by)
            VALUES ('ST-001', 'الاستور الرئيسي', 'الفرع الرئيسي', 'new', 'المسؤول')
        """)
        next_store_no = 'ST-001'
        next_store_name = 'الاستور الرئيسي'
    else:
        c.execute("SELECT store_no, store_name FROM stock_stores ORDER BY id ASC LIMIT 1")
        next_row = c.fetchone()
        next_store_no = next_row['store_no']
        next_store_name = next_row['store_name']

    conn.commit()
    conn.close()

    return {
        "success": True,
        "message": f"تم حذف الاستور ({store_no}) بالكامل وجميع بياناته بنجاح",
        "next_store_no": next_store_no,
        "next_store_name": next_store_name,
        "stores_data": get_all_stores()
    }

def reset_all_stocktake_test_data() -> Dict[str, Any]:
    """تصفير ومسح كافة بيانات وتجارب الجرد بالكامل للبدء من الصفر"""
    conn = get_connection()
    c = conn.cursor()
    c.execute("DELETE FROM inventory_records")
    c.execute("DELETE FROM stocktake_entries")
    c.execute("DELETE FROM stocktake_scanned_serials")
    c.execute("DELETE FROM stock_stores")
    c.execute("""
        INSERT INTO stock_stores (store_no, store_name, branch_name, status, created_by)
        VALUES ('ST-001', 'الاستور الرئيسي', 'الفرع الرئيسي', 'new', 'المسؤول')
    """)
    conn.commit()
    conn.close()

    return {
        "success": True,
        "message": "تم تصفير ومسح جميع بيانات وتجارب الجرد بالكامل، النظام نظيف تماماً للبدء برفع المخزون الحقيقي.",
        "store_no": "ST-001",
        "store_name": "الاستور الرئيسي",
        "stores_data": get_all_stores()
    }

# ==================== المسح والجرد الفعلي للأصناف ====================

def get_store_stocktake_details(store_no: str = 'ST-001', search_query: str = '') -> Dict[str, Any]:
    """جلب تفاصيل بنود الجرد للاستور المحدد مع إحصائيات التكلفة وسعر البيع والبحث المتقدم"""
    conn = get_connection()
    store_no = resolve_valid_store_no(conn, store_no)
    c = conn.cursor()

    c.execute("SELECT * FROM stock_stores WHERE store_no = ?", (store_no,))
    store_info = c.fetchone()

    sql = """
        SELECT * FROM stocktake_entries
        WHERE store_no = ?
    """
    params = [store_no]
    if search_query:
        like_q = f"%{search_query.strip()}%"
        sql += " AND (product_code LIKE ? OR product_name LIKE ? OR barcode LIKE ? OR gtin LIKE ? OR batch_number LIKE ?)"
        params.extend([like_q, like_q, like_q, like_q, like_q])

    sql += " ORDER BY id DESC"
    c.execute(sql, tuple(params))
    items = [dict(r) for r in c.fetchall()]

    # تعزيز أسماء الأصناف بالإنجليزية كما في كرت الصنف وتأكيد أسعار التكلفة وسعر البيع
    for it in items:
        p_code = it.get('product_code')
        c.execute("SELECT name_en, name, cost_price, selling_price, unit_price FROM products WHERE code = ?", (p_code,))
        pr = c.fetchone()
        if pr:
            if pr['name_en']:
                it['product_name'] = pr['name_en']
            elif not it.get('product_name'):
                it['product_name'] = pr['name']

            if (not it.get('cost_price') or float(it['cost_price']) == 0) and pr['cost_price']:
                it['cost_price'] = float(pr['cost_price'])
            if (not it.get('selling_price') or float(it['selling_price']) == 0):
                s_p = pr['selling_price'] or pr['unit_price']
                if s_p:
                    it['selling_price'] = float(s_p)

        if not it.get('cost_price') or float(it['cost_price']) == 0:
            c.execute("SELECT cost_price FROM inventory_records WHERE product_code = ? AND cost_price > 0 ORDER BY id DESC LIMIT 1", (p_code,))
            icr = c.fetchone()
            if icr and icr['cost_price']:
                it['cost_price'] = float(icr['cost_price'])

        if not it.get('selling_price') or float(it['selling_price']) == 0:
            c.execute("SELECT selling_price FROM inventory_records WHERE product_code = ? AND selling_price > 0 ORDER BY id DESC LIMIT 1", (p_code,))
            isr = c.fetchone()
            if isr and isr['selling_price']:
                it['selling_price'] = float(isr['selling_price'])

        # استكمال الباتش وتاريخ الصلاحية ورصيد المخزون الدفتري إذا كانت فارغة
        if not it.get('batch_number') or it['batch_number'] == '' or not it.get('expiry_date') or it['expiry_date'] == '' or not it.get('system_qty') or float(it['system_qty']) == 0:
            c.execute("""
                SELECT batch_number, expiry_date, system_qty
                FROM inventory_records
                WHERE product_code = ? AND store_no = ? AND (batch_number != '' AND batch_number IS NOT NULL)
                ORDER BY id DESC LIMIT 1
            """, (p_code, store_no))
            inv_row = c.fetchone()
            if not inv_row:
                c.execute("""
                    SELECT batch_number, expiry_date, system_qty
                    FROM inventory_records
                    WHERE product_code = ? AND (batch_number != '' AND batch_number IS NOT NULL)
                    ORDER BY id DESC LIMIT 1
                """, (p_code,))
                inv_row = c.fetchone()

            if inv_row:
                updated_b = str(it.get('batch_number') or inv_row['batch_number'] or '').strip().upper()
                updated_exp = it.get('expiry_date') or inv_row['expiry_date'] or ''
                updated_sq = it.get('system_qty') if (it.get('system_qty') and float(it['system_qty']) > 0) else float(inv_row['system_qty'] or 0.0)
                it['batch_number'] = updated_b
                it['expiry_date'] = updated_exp
                it['system_qty'] = updated_sq
                c.execute("""
                    UPDATE stocktake_entries
                    SET batch_number = ?, expiry_date = ?, system_qty = ?
                    WHERE id = ?
                """, (updated_b, updated_exp, updated_sq, it['id']))
        if it.get('batch_number'):
            it['batch_number'] = str(it['batch_number']).strip().upper()

    c.execute("""
        SELECT 
            COUNT(DISTINCT product_code) as total_products,
            COUNT(*) as total_lines,
            COALESCE(SUM(counted_qty), 0) as total_qty,
            COALESCE(SUM(CASE WHEN is_new_batch = 1 THEN 1 ELSE 0 END), 0) as new_batches_count
        FROM stocktake_entries
        WHERE store_no = ?
    """, (store_no,))
    act = c.fetchone()

    c.execute("""
        SELECT 
            COALESCE(SUM(system_qty), 0) as total_sys_qty,
            COALESCE(SUM(system_qty * cost_price), 0) as total_sys_cost,
            COALESCE(SUM(system_qty * selling_price), 0) as total_sys_sale
        FROM inventory_records
        WHERE store_no = ?
    """, (store_no,))
    sys_rec = c.fetchone()

    c.execute("SELECT COUNT(*) as cnt FROM stocktake_scanned_serials WHERE store_no = ?", (store_no,))
    ser_row = c.fetchone()

    conn.close()

    sys_cost = round(sys_rec['total_sys_cost'], 2) if sys_rec else 0.0
    sys_sale = round(sys_rec['total_sys_sale'], 2) if sys_rec else 0.0
    act_cost = round(sum(float(it.get('counted_qty') or 0) * float(it.get('cost_price') or 0) for it in items), 2)
    act_sale = round(sum(float(it.get('counted_qty') or 0) * float(it.get('selling_price') or 0) for it in items), 2)

    return {
        "store": dict(store_info) if store_info else {"store_no": store_no, "store_name": "الاستور الرئيسي"},
        "items": items,
        "stats": {
            "store_no": store_no,
            "counted_products": act['total_products'] if act else 0,
            "counted_lines": act['total_lines'] if act else 0,
            "counted_qty": round(act['total_qty'], 2) if act else 0.0,
            "system_qty": round(sys_rec['total_sys_qty'], 2) if sys_rec else 0.0,
            "system_cost": sys_cost,
            "system_sale": sys_sale,
            "counted_cost": act_cost,
            "counted_sale": act_sale,
            "diff_cost": round(act_cost - sys_cost, 2),
            "diff_sale": round(act_sale - sys_sale, 2),
            "new_batches_count": act['new_batches_count'] if act else 0,
            "scanned_serials_count": ser_row['cnt'] if ser_row else 0
        }
    }


def search_store_stocktake_items(store_no: str = 'ST-001', query: str = '', match_mode: str = 'start') -> Dict[str, Any]:
    """
    الخانة الثانية المستقلة في شاشة الجرد: البحث داخل الاستور المحدد فقط (قراءة فقط).
    - يقرأ بيانات الجرد حصراً من stocktake_entries WHERE store_no = ? (لا يتأثر أبداً بجرد أي استور آخر).
    - إذا لم يُجرد الصنف بعد في هذا الاستور: يعرض حالته صراحةً (لم يُجرد بعد / 0 معدود) ولا يستبدلها برصيد مخزون عام أو استور آخر.
    - يجمع الكميات المعدودة فعلياً عبر الدفعات/الرفوف داخل الاستور نفسه دون تكرار (حسب unique id).
    - يدعم البحث بالاسم العربي/الإنجليزي/العلمي/الشركة/الكود/الباركود/GTIN/QR-GS1/رقم الدفعة بوضعي Start و Contains.
    """
    raw_q = str(query or '').lstrip()
    q_trim = raw_q.strip()
    is_contains = str(match_mode or '').lower() in ('contains', 'generalized', 'all', 'true', '1')

    conn = get_connection()
    resolved_store = resolve_valid_store_no(conn, store_no)
    c = conn.cursor()

    c.execute("SELECT * FROM stock_stores WHERE store_no = ?", (resolved_store,))
    store_row = c.fetchone()
    store_dict = dict(store_row) if store_row else {"store_no": resolved_store, "store_name": "الاستور الرئيسي", "status": "new"}
    store_status = str(store_dict.get("status") or "new").strip().lower()

    # إحصائيات الاستور الحالية (قراءة فقط)
    c.execute("""
        SELECT
            COUNT(DISTINCT product_code) AS total_products,
            COUNT(*) AS total_lines,
            COALESCE(SUM(counted_qty), 0) AS total_qty,
            COALESCE(SUM(counted_qty * cost_price), 0) AS total_counted_cost,
            COALESCE(SUM(counted_qty * selling_price), 0) AS total_counted_sale,
            COALESCE(SUM(CASE WHEN is_new_batch = 1 THEN 1 ELSE 0 END), 0) AS new_batches_count
        FROM stocktake_entries
        WHERE store_no = ?
    """, (resolved_store,))
    act = c.fetchone()

    c.execute("""
        SELECT
            COALESCE(SUM(system_qty), 0) AS total_sys_qty,
            COALESCE(SUM(system_qty * cost_price), 0) AS total_sys_cost,
            COALESCE(SUM(system_qty * selling_price), 0) AS total_sys_sale
        FROM inventory_records
        WHERE store_no = ?
    """, (resolved_store,))
    sys_rec = c.fetchone()

    c.execute("SELECT COUNT(*) AS cnt FROM stocktake_scanned_serials WHERE store_no = ?", (resolved_store,))
    ser_row = c.fetchone()

    stats = {
        "store_no": resolved_store,
        "counted_products": act["total_products"] if act else 0,
        "counted_lines": act["total_lines"] if act else 0,
        "counted_qty": round(float(act["total_qty"] or 0.0), 2) if act else 0.0,
        "system_qty": round(float(sys_rec["total_sys_qty"] or 0.0), 2) if sys_rec else 0.0,
        "system_cost": round(float(sys_rec["total_sys_cost"] or 0.0), 2) if sys_rec else 0.0,
        "system_sale": round(float(sys_rec["total_sys_sale"] or 0.0), 2) if sys_rec else 0.0,
        "counted_cost": round(float(act["total_counted_cost"] or 0.0), 2) if act else 0.0,
        "counted_sale": round(float(act["total_counted_sale"] or 0.0), 2) if act else 0.0,
        "diff_cost": round(float((act["total_counted_cost"] or 0.0) - (sys_rec["total_sys_cost"] or 0.0)), 2) if (act and sys_rec) else 0.0,
        "diff_sale": round(float((act["total_counted_sale"] or 0.0) - (sys_rec["total_sys_sale"] or 0.0)), 2) if (act and sys_rec) else 0.0,
        "new_batches_count": act["new_batches_count"] if act else 0,
        "scanned_serials_count": ser_row["cnt"] if ser_row else 0,
    }

    if not q_trim:
        c.execute("SELECT * FROM stocktake_entries WHERE store_no = ? ORDER BY id DESC", (resolved_store,))
        all_rows = [dict(r) for r in c.fetchall()]
        prod_codes = list({str(r.get("product_code") or "").strip() for r in all_rows if r.get("product_code")})
        prod_map: Dict[str, Dict[str, Any]] = {}
        for i in range(0, len(prod_codes), 400):
            chunk = prod_codes[i:i + 400]
            ph = ",".join(["?"] * len(chunk))
            c.execute(f"SELECT code, name_en, name, cost_price, selling_price, unit_price FROM products WHERE code IN ({ph})", tuple(chunk))
            for pr in c.fetchall():
                prod_map[pr["code"]] = dict(pr)
        for it in all_rows:
            pr = prod_map.get(str(it.get("product_code") or "").strip())
            if pr:
                if pr.get("name_en"):
                    it["product_name"] = pr["name_en"]
                elif not it.get("product_name") and pr.get("name"):
                    it["product_name"] = pr["name"]
                if (not it.get("cost_price") or float(it["cost_price"]) == 0) and pr.get("cost_price"):
                    it["cost_price"] = float(pr["cost_price"])
                if not it.get("selling_price") or float(it["selling_price"]) == 0:
                    sp = pr.get("selling_price") or pr.get("unit_price")
                    if sp:
                        it["selling_price"] = float(sp)
            if it.get("batch_number"):
                it["batch_number"] = str(it["batch_number"]).strip().upper()
        conn.close()
        store_details = {"store": store_dict, "items": all_rows, "stats": stats}
        return {
            "success": True,
            "query": "",
            "store_no": resolved_store,
            "store": store_dict,
            "items": all_rows,
            "product_summaries": [],
            "store_details": store_details,
        }

    # 1. تحليل QR / GS1 إن وجد
    qr_gtin = ""
    qr_batch = ""
    parsed_qr = parse_qr_code(q_trim)
    qr_data = parsed_qr.get("data") or {}
    if parsed_qr.get("success") and (qr_data.get("gtin") or qr_data.get("batch") or parsed_qr.get("gtin")):
        raw_g = qr_data.get("gtin") or parsed_qr.get("gtin") or ""
        qr_gtin = clean_barcode_preserve_zeros(extract_clean_gtin(raw_g) or raw_g)
        qr_batch = str(qr_data.get("batch") or parsed_qr.get("batch_number") or "").strip().upper()

    effective_raw_q = qr_gtin if qr_gtin else raw_q
    effective_q = effective_raw_q.strip()

    # 2. جلب الأصناف المطابقة من كرت الصنف (مع نفس قواعد Start / Contains / Word Boundary / 500MG / العربي / الإنجليزي)
    matched_prods: Dict[str, Dict[str, Any]] = {}
    ordered_codes: List[str] = []
    if effective_q:
        where_sql, params, order_params = _build_product_search_where(effective_raw_q, match_mode)
        c.execute(f"""
            SELECT DISTINCT p.* FROM products p
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
            LIMIT 80
        """, tuple(list(params) + order_params))
        for pr in c.fetchall():
            pd = dict(pr)
            _attach_product_barcodes(pd)
            pc = pd["code"]
            if pc not in matched_prods:
                matched_prods[pc] = pd
                ordered_codes.append(pc)

    # 3. جلب بنود stocktake_entries داخل هذا الاستور فقط التي تطابق مباشرةً (شامل رقم الدفعة والإدخالات الخاصة)
    direct_st_conds = [
        "UPPER(TRIM(COALESCE(batch_number, ''))) LIKE ?",
        "product_code LIKE ?",
        "product_name LIKE ?",
        "barcode LIKE ?",
        "gtin LIKE ?",
    ]
    st_pat = f"%{q_trim}%" if is_contains else f"{q_trim}%"
    st_batch_pat = f"%{qr_batch or q_trim.upper()}%" if (is_contains or qr_batch) else f"{q_trim.upper()}%"
    direct_st_params = [st_batch_pat, st_pat, st_pat, st_pat, st_pat]
    c.execute(f"""
        SELECT * FROM stocktake_entries
        WHERE store_no = ? AND ({' OR '.join(direct_st_conds)})
        ORDER BY id DESC
    """, tuple([resolved_store] + direct_st_params))
    direct_st_rows = [dict(r) for r in c.fetchall()]

    # جمع كافة أكواد الأصناف ذات الصلة (من كرت الصنف أو من بنود الاستور المباشرة)
    all_target_codes = list(ordered_codes)
    for sr in direct_st_rows:
        spc = str(sr.get("product_code") or "").strip()
        if spc and spc not in matched_prods and spc not in all_target_codes:
            all_target_codes.append(spc)

    # جلب تعريف أي كود دخل عبر البحث برقم الدفعة فقط ولم يكن ضمن أول 80 نتيجة
    missing_meta_codes = [pc for pc in all_target_codes if pc not in matched_prods]
    for i in range(0, len(missing_meta_codes), 200):
        chunk = missing_meta_codes[i:i + 200]
        ph = ",".join(["?"] * len(chunk))
        c.execute(f"SELECT * FROM products WHERE code IN ({ph})", tuple(chunk))
        for pr in c.fetchall():
            pd = dict(pr)
            _attach_product_barcodes(pd)
            matched_prods[pd["code"]] = pd

    # 4. قراءة بنود الجرد من هذا الاستور فقط (stocktake_entries WHERE store_no = ?)
    entries_by_id: Dict[int, Dict[str, Any]] = {}
    for sr in direct_st_rows:
        if qr_batch and str(sr.get("batch_number") or "").strip().upper() != qr_batch:
            continue
        entries_by_id[sr["id"]] = sr

    if all_target_codes:
        for i in range(0, len(all_target_codes), 200):
            chunk = all_target_codes[i:i + 200]
            ph = ",".join(["?"] * len(chunk))
            c.execute(
                f"SELECT * FROM stocktake_entries WHERE store_no = ? AND product_code IN ({ph}) ORDER BY id DESC",
                tuple([resolved_store] + chunk)
            )
            for sr in c.fetchall():
                sd = dict(sr)
                if qr_batch and str(sd.get("batch_number") or "").strip().upper() != qr_batch:
                    continue
                entries_by_id[sd["id"]] = sd

    # تجميع حسب product_code بدون تكرار أي صف (unique id)
    entries_by_code: Dict[str, List[Dict[str, Any]]] = {}
    matching_items = sorted(entries_by_id.values(), key=lambda x: x["id"], reverse=True)
    for sd in matching_items:
        pc = str(sd.get("product_code") or "").strip()
        pr = matched_prods.get(pc)
        if pr:
            if pr.get("name_en"):
                sd["product_name"] = pr["name_en"]
            elif not sd.get("product_name") and pr.get("name"):
                sd["product_name"] = pr["name"]
        if sd.get("batch_number"):
            sd["batch_number"] = str(sd["batch_number"]).strip().upper()
        entries_by_code.setdefault(pc, []).append(sd)

    # 5. قراءة الرصيد الدفتري الخاص بهذا الاستور فقط (إن وُجد في inventory_records WHERE store_no = ?) دون أي استور آخر
    store_inv_by_code: Dict[str, float] = {}
    if all_target_codes:
        for i in range(0, len(all_target_codes), 200):
            chunk = all_target_codes[i:i + 200]
            ph = ",".join(["?"] * len(chunk))
            c.execute(
                f"SELECT product_code, COALESCE(SUM(system_qty), 0) AS sys_q "
                f"FROM inventory_records WHERE store_no = ? AND product_code IN ({ph}) GROUP BY product_code",
                tuple([resolved_store] + chunk)
            )
            for ir in c.fetchall():
                store_inv_by_code[ir["product_code"]] = round(float(ir["sys_q"] or 0.0), 4)

    conn.close()

    # 6. بناء ملخصات الأصناف: المجرودة في هذا الاستور أولاً ثم المطابقة غير المجرودة بعد
    counted_summaries = []
    uncounted_summaries = []
    for pc in all_target_codes:
        pr = matched_prods.get(pc, {})
        rows_for_prod = entries_by_code.get(pc, [])
        is_counted = len(rows_for_prod) > 0
        total_counted = round(sum(float(r.get("counted_qty") or 0.0) for r in rows_for_prod), 4)
        batch_rows = [
            {
                "entry_id": r["id"],
                "batch_number": str(r.get("batch_number") or "").strip().upper() or "-",
                "expiry_date": r.get("expiry_date") or "-",
                "counted_qty": round(float(r.get("counted_qty") or 0.0), 4),
                "system_qty": round(float(r.get("system_qty") or 0.0), 4),
                "is_new_batch": int(r.get("is_new_batch") or 0),
                "updated_at": r.get("updated_at") or "",
            }
            for r in rows_for_prod
        ]
        summary_obj = {
            "product_code": pc,
            "name_en": pr.get("name_en") or pr.get("name") or (rows_for_prod[0].get("product_name") if rows_for_prod else "") or "",
            "name_ar": pr.get("name_ar") or "",
            "scientific_name": pr.get("scientific_name") or "",
            "company": pr.get("company") or "",
            "barcode": (pr.get("barcode_list") or [pr.get("barcode") or ""])[0] or (rows_for_prod[0].get("barcode") if rows_for_prod else ""),
            "gtin": (pr.get("gtin_list") or [pr.get("gtin") or ""])[0] or (rows_for_prod[0].get("gtin") if rows_for_prod else ""),
            "selling_price": float(pr.get("selling_price") or pr.get("unit_price") or (rows_for_prod[0].get("selling_price") if rows_for_prod else 0.0) or 0.0),
            "store_no": resolved_store,
            "store_name": store_dict.get("store_name") or resolved_store,
            "store_status": store_status,
            "is_counted_in_store": is_counted,
            "total_counted_qty": total_counted,
            "entry_count": len(rows_for_prod),
            "store_system_qty": store_inv_by_code.get(pc, 0.0),
            "batch_rows": batch_rows,
        }
        if is_counted:
            counted_summaries.append(summary_obj)
        else:
            uncounted_summaries.append(summary_obj)

    product_summaries = (counted_summaries + uncounted_summaries)[:30]
    store_details = {"store": store_dict, "items": matching_items, "stats": stats}
    return {
        "success": True,
        "query": q_trim,
        "store_no": resolved_store,
        "store": store_dict,
        "items": matching_items,
        "product_summaries": product_summaries,
        "counted_matches_count": len(counted_summaries),
        "uncounted_matches_count": len(uncounted_summaries),
        "qr_gtin": qr_gtin,
        "qr_batch": qr_batch,
        "store_details": store_details,
    }


def scan_item_to_store(raw_code: str, store_no: str = 'ST-001', force_direct: bool = False, product_code: str = '') -> Dict[str, Any]:
    """
    مسح صنف للاستور:
    - جلب سعر البيع مباشرة من كرت الصنف المربوط به.
    - جلب سعر التكلفة من رصيد المخزون المسجل (أو كرت الصنف).
    - حساب إجمالي التكلفة وإجمالي البيع معاً.
    - منع تكرار السيريال.
    - مطابقة الباتش: مطابق -> طبيعي | غير موجود -> يُعتمد فوراً مع علامة (باتش جديد).
    - زيادة الكمية +1 تلقائياً مع كل مسحة.
    """
    raw = str(raw_code or "").strip()
    if not raw:
        return {"success": False, "message": "لم يتم إدخال أو مسح أي كود"}

    conn = get_connection()
    store_no = resolve_valid_store_no(conn, store_no)
    c = conn.cursor()

    explicit_pcode = str(product_code or "").strip()
    prod = None
    parsed = {}
    gtin = ""
    serial = ""
    batch = ""
    expiry = ""

    if explicit_pcode:
        # اختيار مباشر من نتائج البحث بكرت الصنف: نطابق الكود الداخلي بدقة دون تأويله كـ QR
        prod = get_product_by_code(clean_numeric_code(explicit_pcode)) or get_product_by_code(explicit_pcode)
        if prod:
            gtin = prod.get("gtin") or prod.get("barcode") or ""
    else:
        parsed = parse_qr_code(raw)
        pdata = parsed.get("data", {}) if parsed.get("success") else {}

        gtin = pdata.get("gtin", "")
        serial = str(pdata.get("serial", "") or "").strip().upper()
        batch = str(pdata.get("batch", "") or "").strip().upper()
        expiry = pdata.get("expiry", "")

        if not gtin:
            gtin = extract_clean_gtin(raw) or clean_barcode_preserve_zeros(raw)

        # 1. إذا كان الكود المدخل أرقاماً قصيرة تطابق كود الصنف الداخلي مباشرة
        clean_num = clean_numeric_code(raw)
        if clean_num and len(clean_num) <= 8 and raw.isdigit():
            prod = get_product_by_code(clean_num)

        # 2. البحث برقم GTIN أو الباركود
        if not prod and gtin:
            prod = find_product_by_gtin_or_barcode(gtin)
        if not prod:
            prod = get_product_by_code(clean_numeric_code(raw))
        if not prod:
            prod = find_product_by_gtin_or_barcode(clean_barcode_preserve_zeros(raw))

    if not prod:
        conn.close()
        return {
            "success": False,
            "message": f"الصنف غير مسجل في بطاقات الأصناف (الكود: {gtin or raw})",
            "is_unregistered": True,
            "raw": raw
        }

    prod_code = prod["code"]
    # عرض اسم الصنف بالإنجليزية دائماً كما في كرت الصنف
    prod_name = prod.get("name_en") or prod.get("name") or ""
    # سعر البيع أساسي ومربوط بكرت الصنف
    selling_price = float(prod.get("selling_price") or prod.get("unit_price") or prod.get("price") or 0.0)
    # سعر التكلفة من كرت الصنف كقيمة افتراضية
    cost_price = float(prod.get("cost_price") or 0.0)
    item_type = prod.get("item_type") or "medicine"

    # 1. فحص السيريال ومنع التكرار قطعياً
    if serial:
        c.execute("""
            SELECT id FROM stocktake_scanned_serials
            WHERE serial_number = ? AND product_code = ? AND store_no = ?
        """, (serial, prod_code, store_no))
        if c.fetchone():
            conn.close()
            return {
                "success": False,
                "is_duplicate_serial": True,
                "message": f"⚠️ تنبيه: العبوة ذات السيريال ({serial}) تم مسحها مسبقاً! تم منع تكرار الحساب.",
                "serial": serial,
                "product_code": prod_code,
                "product_name": prod_name
            }

    # 2. فحص الباتشات والمطابقة مع سجلات المخزون المسجلة للاستور بكل صيغ الأكواد والباركود
    c_pcode = clean_numeric_code(prod_code)
    b_code = prod.get("barcode", "")
    g_code = gtin or ""

    c.execute("""
        SELECT * FROM inventory_records
        WHERE (product_code = ? OR product_code = ? OR barcode = ? OR barcode = ?)
          AND store_no = ?
        ORDER BY expiry_date ASC, id ASC
    """, (prod_code, c_pcode, b_code, g_code, store_no))
    inv_records = [dict(r) for r in c.fetchall()]

    if not inv_records:
        c.execute("""
            SELECT * FROM inventory_records
            WHERE (product_code = ? OR product_code = ? OR barcode = ? OR barcode = ?)
            ORDER BY expiry_date ASC, id ASC
        """, (prod_code, c_pcode, b_code, g_code))
        inv_records = [dict(r) for r in c.fetchall()]

    # جلب أفضل تكلفة وسعر بيع من سجلات المخزون إن وجدت
    for ir in inv_records:
        if cost_price == 0 and ir.get('cost_price') and float(ir['cost_price']) > 0:
            cost_price = float(ir['cost_price'])
        if selling_price == 0 and ir.get('selling_price') and float(ir['selling_price']) > 0:
            selling_price = float(ir['selling_price'])

    is_2d_qr = bool(parsed.get("success") and (batch or serial))

    # إذا كان الصنف ممسوحاً بباركود عادي 1D أو إدخال كود، نعرض الصنف والتشغيلات فوق في لوحة إدخال الأعداد
    # أما الدواء المسحوب كيو ار (2D DataMatrix) فينزل مباشرة +1 مع كل سحبة كما طلب المستخدم
    if not is_2d_qr and not force_direct:
        # تجميع شامل لجميع باتشات واستوكات الصنف (سواء من المخزون أو من بنود الجرد المسجلة مسبقاً)
        batches_map = {}

        # 1. إدراج جميع تشغيلات وأرصدة المخزون المسجلة
        for ir in inv_records:
            b_num = (ir.get('batch_number') or '').strip().upper()
            exp = (ir.get('expiry_date') or '').strip()
            key = (b_num, exp)
            if key not in batches_map:
                batches_map[key] = {
                    "batch_number": b_num or "-",
                    "expiry_date": exp or "-",
                    "system_qty": float(ir.get("system_qty") or 0.0),
                    "counted_qty": 0.0,
                    "cost_price": float(ir.get("cost_price") or cost_price),
                    "selling_price": float(ir.get("selling_price") or selling_price),
                    "entry_id": None,
                    "is_new_batch": 0
                }
            else:
                batches_map[key]["system_qty"] += float(ir.get("system_qty") or 0.0)

        # 2. فحص ودمج أي تشغيلات تم جردها مسبقاً في هذا الاستور
        c.execute("""
            SELECT * FROM stocktake_entries
            WHERE (product_code = ? OR product_code = ?) AND store_no = ?
            ORDER BY id ASC
        """, (prod_code, c_pcode, store_no))
        st_entries = [dict(r) for r in c.fetchall()]

        for st in st_entries:
            b_num = (st.get('batch_number') or '').strip().upper()
            exp = (st.get('expiry_date') or '').strip()
            key = (b_num, exp)
            if key in batches_map:
                batches_map[key]["counted_qty"] = float(st.get("counted_qty") or 0.0)
                batches_map[key]["entry_id"] = st.get("id")
                if st.get("cost_price"): batches_map[key]["cost_price"] = float(st["cost_price"])
                if st.get("selling_price"): batches_map[key]["selling_price"] = float(st["selling_price"])
            else:
                batches_map[key] = {
                    "batch_number": b_num or "-",
                    "expiry_date": exp or "-",
                    "system_qty": float(st.get("system_qty") or 0.0),
                    "counted_qty": float(st.get("counted_qty") or 0.0),
                    "cost_price": float(st.get("cost_price") or cost_price),
                    "selling_price": float(st.get("selling_price") or selling_price),
                    "entry_id": st.get("id"),
                    "is_new_batch": st.get("is_new_batch") or 1
                }

        # 3. إذا لم يكن للصنف أي تشغيلة مسجلة: ننشئ سطراً افتراضياً برصيد المخزون 0
        from datetime import datetime
        current_ym = datetime.now().strftime('%y%m')
        default_auto_batch = f"B{current_ym}-01"

        if not batches_map:
            batches_map[("-", "-")] = {
                "batch_number": default_auto_batch,
                "expiry_date": "",
                "system_qty": 0.0,
                "counted_qty": 0.0,
                "cost_price": cost_price,
                "selling_price": selling_price,
                "entry_id": None,
                "is_new_batch": 1,
                "is_manual_batch": 1,
                "requires_manual_entry": True
            }
        else:
            # فحص التشغيلات السابقة: إذا كانت بدون رقم باتش أو بدون صلاحية نفتح التعديل ونولد باتش تلقائي
            for k, b_info in batches_map.items():
                b_num = str(b_info.get("batch_number") or "").strip()
                exp_d = str(b_info.get("expiry_date") or "").strip()
                if (b_num in ('-', '', 'None') and exp_d in ('-', '', 'None')) or b_info.get("is_new_batch"):
                    if b_num in ('-', '', 'None'):
                        b_info["batch_number"] = default_auto_batch
                    if exp_d in ('-', '', 'None'):
                        b_info["expiry_date"] = ""
                    b_info["is_manual_batch"] = 1
                    b_info["requires_manual_entry"] = True

        batches_list = list(batches_map.values())

        conn.close()
        return {
            "success": True,
            "requires_batch_entry": True,
            "product": {
                "code": prod_code,
                "name": prod_name,
                "barcode": prod.get("barcode", ""),
                "gtin": gtin or prod.get("barcode", ""),
                "item_type": item_type,
                "cost_price": cost_price,
                "selling_price": selling_price
            },
            "batches": batches_list,
            "store_no": store_no
        }

    target_entry_id = None
    target_batch = batch
    target_expiry = expiry
    target_system_qty = 0.0
    new_qty = 1.0
    is_new_batch = 0

    if batch:
        # حالة 1: كود داتاماتريكس 2D يحتوي على باتش محدد صراحة
        matched_inv = next((r for r in inv_records if (r.get('batch_number') or '').strip().upper() == batch.strip().upper()), None)
        
        c.execute("""
            SELECT * FROM stocktake_entries
            WHERE product_code = ? AND store_no = ? AND UPPER(TRIM(batch_number)) = ?
            ORDER BY id DESC LIMIT 1
        """, (prod_code, store_no, batch))
        entry_row = c.fetchone()
        
        if entry_row:
            target_entry_id = entry_row["id"]
            new_qty = float(entry_row["counted_qty"] or 0) + 1.0
            target_system_qty = float(entry_row["system_qty"] or (matched_inv['system_qty'] if matched_inv else 0.0))
            target_expiry = entry_row["expiry_date"] or expiry or (matched_inv['expiry_date'] if matched_inv else '')
            is_new_batch = entry_row["is_new_batch"]
            c.execute("""
                UPDATE stocktake_entries
                SET counted_qty = ?,
                    system_qty = CASE WHEN system_qty = 0 THEN ? ELSE system_qty END,
                    expiry_date = CASE WHEN expiry_date = '' THEN ? ELSE expiry_date END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            """, (new_qty, target_system_qty, target_expiry, target_entry_id))
        else:
            new_qty = 1.0
            target_system_qty = float(matched_inv['system_qty']) if matched_inv else 0.0
            is_new_batch = 0 if matched_inv else 1
            target_expiry = expiry or (matched_inv['expiry_date'] if matched_inv else '')
            row_cost = float(matched_inv['cost_price']) if (matched_inv and matched_inv.get('cost_price')) else cost_price
            row_sale = float(matched_inv['selling_price']) if (matched_inv and matched_inv.get('selling_price')) else selling_price
            c.execute("""
                INSERT INTO stocktake_entries (
                    product_code, product_name, barcode, gtin, batch_number, expiry_date,
                    system_qty, counted_qty, cost_price, selling_price, is_new_batch,
                    item_type, store_no, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """, (
                prod_code, prod_name, prod.get("barcode", ""), gtin, batch, target_expiry,
                target_system_qty, new_qty, row_cost, row_sale, is_new_batch,
                item_type, store_no
            ))
            target_entry_id = c.lastrowid

        # إدراج باقي باتشات هذا الصنف المسجلة في المخزون (إن وجدت) لكي تظهر للمستخدم فوراً برصيدها الدفتري
        for ir in inv_records:
            b_k = (ir.get('batch_number') or '').strip().upper()
            if b_k and b_k != batch.strip().upper():
                c.execute("""
                    SELECT id FROM stocktake_entries
                    WHERE product_code = ? AND store_no = ? AND UPPER(TRIM(batch_number)) = ?
                """, (prod_code, store_no, b_k))
                if not c.fetchone():
                    c.execute("""
                        INSERT INTO stocktake_entries (
                            product_code, product_name, barcode, gtin, batch_number, expiry_date,
                            system_qty, counted_qty, cost_price, selling_price, is_new_batch,
                            item_type, store_no, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0.0, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """, (
                        prod_code, prod_name, prod.get("barcode", ""), gtin, b_k, ir.get('expiry_date') or '',
                        float(ir.get('system_qty') or 0), float(ir.get('cost_price') or cost_price), float(ir.get('selling_price') or selling_price),
                        item_type, store_no
                    ))
    else:
        # حالة 2: مسح باركود 1D أو إدخال كود الصنف بدون تحديد باتش
        if inv_records:
            # 1. التأكد من إدراج جميع باتشات هذا الصنف المسجلة في المخزون في جدول الجرد
            existing_or_created = []
            for ir in inv_records:
                b_num = (ir.get('batch_number') or '').strip().upper()
                c.execute("""
                    SELECT id, counted_qty, system_qty, batch_number, expiry_date, cost_price, selling_price
                    FROM stocktake_entries
                    WHERE product_code = ? AND store_no = ? AND (batch_number = ? OR (batch_number = '' AND ? = ''))
                    ORDER BY id ASC LIMIT 1
                """, (prod_code, store_no, b_num, b_num))
                row = c.fetchone()
                if not row:
                    c.execute("""
                        INSERT INTO stocktake_entries (
                            product_code, product_name, barcode, gtin, batch_number, expiry_date,
                            system_qty, counted_qty, cost_price, selling_price, is_new_batch,
                            item_type, store_no, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, 0.0, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """, (
                        prod_code, prod_name, prod.get("barcode", ""), gtin, b_num, ir.get('expiry_date') or '',
                        float(ir.get('system_qty') or 0), float(ir.get('cost_price') or cost_price), float(ir.get('selling_price') or selling_price),
                        item_type, store_no
                    ))
                    row_id = c.lastrowid
                    existing_or_created.append({
                        'id': row_id, 'counted_qty': 0.0, 'system_qty': float(ir.get('system_qty') or 0),
                        'batch_number': b_num, 'expiry_date': ir.get('expiry_date') or '',
                        'cost_price': float(ir.get('cost_price') or cost_price),
                        'selling_price': float(ir.get('selling_price') or selling_price)
                    })
                else:
                    existing_or_created.append(dict(row))

            # 2. نظام الوارد أولاً يصرف أولاً (FIFO): نزيد الباتش الأقرب انتهاءً الذي لم يكتمل رصيده
            candidate = next((r for r in existing_or_created if float(r.get('counted_qty') or 0) < float(r.get('system_qty') or 0)), None)
            if not candidate:
                candidate = existing_or_created[-1]

            target_entry_id = candidate['id']
            new_qty = float(candidate.get('counted_qty') or 0) + 1.0
            target_batch = candidate.get('batch_number') or ''
            target_expiry = candidate.get('expiry_date') or ''
            target_system_qty = float(candidate.get('system_qty') or 0)
            cost_price = float(candidate.get('cost_price') or cost_price)
            selling_price = float(candidate.get('selling_price') or selling_price)

            c.execute("""
                UPDATE stocktake_entries
                SET counted_qty = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            """, (new_qty, target_entry_id))
        else:
            # صنف بدون أي سجلات مخزون دفتري مسبقة
            c.execute("""
                SELECT * FROM stocktake_entries
                WHERE product_code = ? AND store_no = ? AND (batch_number = '' OR batch_number IS NULL)
                ORDER BY id DESC LIMIT 1
            """, (prod_code, store_no))
            entry_row = c.fetchone()
            if entry_row:
                target_entry_id = entry_row["id"]
                new_qty = float(entry_row["counted_qty"] or 0) + 1.0
                c.execute("""
                    UPDATE stocktake_entries
                    SET counted_qty = ?, updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                """, (new_qty, target_entry_id))
            else:
                new_qty = 1.0
                c.execute("""
                    INSERT INTO stocktake_entries (
                        product_code, product_name, barcode, gtin, batch_number, expiry_date,
                        system_qty, counted_qty, cost_price, selling_price, is_new_batch,
                        item_type, store_no, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, '', '', 0.0, ?, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                """, (
                    prod_code, prod_name, prod.get("barcode", ""), gtin, new_qty,
                    cost_price, selling_price, item_type, store_no
                ))
                target_entry_id = c.lastrowid

    # تحديث حالة الاستور إلى in_progress
    c.execute("UPDATE stock_stores SET status = 'in_progress', counted_at = CURRENT_TIMESTAMP WHERE store_no = ?", (store_no,))

    if serial:
        c.execute("""
            INSERT OR IGNORE INTO stocktake_scanned_serials (
                serial_number, product_code, batch_number, store_no, scanned_at
            ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        """, (serial, prod_code, batch, store_no))

    conn.commit()
    conn.close()

    store_data = get_store_stocktake_details(store_no)

    entry_id = target_entry_id
    batch = target_batch
    expiry = target_expiry
    system_qty = target_system_qty

    msg_details = f"تم جرد: {prod_name} | باتش: {batch or '-'} | صلاحية: {expiry or '-'} | رصيد المخزون: {system_qty} | الفعلي: {int(new_qty)} | بيع: {selling_price} | تكلفة: {cost_price}" + (" (⚠️ باتش جديد)" if is_new_batch else "")

    return {
        "success": True,
        "requires_batch_entry": False,
        "direct_scan": True,
        "entry_id": entry_id,
        "product_code": prod_code,
        "product_name": prod_name,
        "batch_number": batch,
        "expiry_date": expiry,
        "serial": serial,
        "system_qty": system_qty,
        "counted_qty": new_qty,
        "cost_price": cost_price,
        "selling_price": selling_price,
        "is_new_batch": bool(is_new_batch),
        "message": msg_details,
        "store_details": store_data
    }

def save_stock_batch_count(
    store_no: str,
    product_code: str,
    batch_number: str,
    expiry_date: str,
    counted_qty: float,
    system_qty: float = 0.0,
    cost_price: float = 0.0,
    selling_price: float = 0.0,
    entry_id: Optional[int] = None
) -> Dict[str, Any]:
    """
    حفظ وتحديث الكمية الفعلية المجرودة لتشغيلة معينة (من لوحة إدخال الباتشات العلوية):
    - يحدّث الكمية في stocktake_entries
    - ينزل فوراً في جدول وفاتورة الجرد
    """
    conn = get_connection()
    store_no = resolve_valid_store_no(conn, store_no)
    c = conn.cursor()

    prod = get_product_by_code(clean_numeric_code(product_code))
    prod_name = (prod.get("name_en") or prod.get("name") or "") if prod else ""
    item_type = prod.get("item_type") or "medicine" if prod else "medicine"

    from .qr_parser import decode_arabic_keyboard_layout
    b_clean = decode_arabic_keyboard_layout(str(batch_number or '').strip()).upper()
    if b_clean == '-':
        b_clean = ''
    exp_clean = str(expiry_date or '').strip()
    if exp_clean == '-':
        exp_clean = ''
    elif exp_clean:
        norm_exp = parse_expiry_date(exp_clean)
        if norm_exp:
            exp_clean = norm_exp
    counted_val = float(counted_qty or 0.0)

    # التحقق من المخزون المسجل لهذا الباتش
    c.execute("""
        SELECT * FROM inventory_records
        WHERE product_code = ? AND store_no = ? AND (batch_number = ? OR (batch_number = '' AND ? = ''))
        LIMIT 1
    """, (product_code, store_no, b_clean, b_clean))
    inv = c.fetchone()
    is_new = 0 if inv else (1 if b_clean else 0)
    sys_val = float(inv['system_qty']) if inv else float(system_qty or 0.0)
    if not exp_clean and inv and inv['expiry_date']:
        exp_clean = inv['expiry_date']
    cost_val = float(inv['cost_price']) if (inv and inv['cost_price']) else float(cost_price or (prod.get('cost_price') if prod else 0) or 0.0)
    sale_val = float(inv['selling_price']) if (inv and inv['selling_price']) else float(selling_price or (prod.get('selling_price') if prod else 0) or 0.0)

    # فحص هل يوجد سطر سابق في stocktake_entries (بواسطة entry_id أو بـ product_code والباتش)
    row = None
    if entry_id:
        c.execute("""
            SELECT id FROM stocktake_entries
            WHERE id = ? AND store_no = ?
        """, (entry_id, store_no))
        row = c.fetchone()

    if not row:
        c.execute("""
            SELECT id FROM stocktake_entries
            WHERE product_code = ? AND store_no = ? AND (batch_number = ? OR (batch_number = '' AND ? = ''))
            ORDER BY id DESC LIMIT 1
        """, (product_code, store_no, b_clean, b_clean))
        row = c.fetchone()

    if row:
        target_id = row['id']
        c.execute("""
            UPDATE stocktake_entries
            SET counted_qty = ?,
                batch_number = CASE WHEN ? != '' THEN ? ELSE batch_number END,
                expiry_date = CASE WHEN ? != '' THEN ? ELSE expiry_date END,
                system_qty = CASE WHEN system_qty = 0 THEN ? ELSE system_qty END,
                cost_price = CASE WHEN cost_price = 0 THEN ? ELSE cost_price END,
                selling_price = CASE WHEN selling_price = 0 THEN ? ELSE selling_price END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
        """, (counted_val, b_clean, b_clean, exp_clean, exp_clean, sys_val, cost_val, sale_val, target_id))
        entry_id = target_id
    else:
        c.execute("""
            INSERT INTO stocktake_entries (
                product_code, product_name, barcode, gtin, batch_number, expiry_date,
                system_qty, counted_qty, cost_price, selling_price, is_new_batch,
                item_type, store_no, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        """, (
            product_code, prod_name, prod.get("barcode", "") if prod else "", prod.get("barcode", "") if prod else "",
            b_clean, exp_clean, sys_val, counted_val, cost_val, sale_val, is_new,
            item_type, store_no
        ))
        entry_id = c.lastrowid

    c.execute("UPDATE stock_stores SET status = 'in_progress', counted_at = CURRENT_TIMESTAMP WHERE store_no = ?", (store_no,))
    conn.commit()
    conn.close()

    return {
        "success": True,
        "requires_batch_entry": False,
        "direct_scan": True,
        "entry_id": entry_id,
        "message": f"تم حفظ: {prod_name} | تشغيلة: {b_clean or '-'} | الفعلي: {counted_val}",
        "store_details": get_store_stocktake_details(store_no)
    }

def update_entry_quantity(entry_id: int, new_qty: float, store_no: str) -> Dict[str, Any]:
    """تعديل الكمية المجرودة يدوياً"""
    conn = get_connection()
    store_no = resolve_valid_store_no(conn, store_no)
    c = conn.cursor()
    c.execute("""
        UPDATE stocktake_entries
        SET counted_qty = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND store_no = ?
    """, (float(new_qty), entry_id, store_no))
    conn.commit()
    conn.close()
    return {"success": True, "store_details": get_store_stocktake_details(store_no)}

def delete_entry_item(entry_id: int, store_no: str) -> Dict[str, Any]:
    """حذف بند من الجرد"""
    conn = get_connection()
    store_no = resolve_valid_store_no(conn, store_no)
    c = conn.cursor()
    c.execute("SELECT product_code, batch_number FROM stocktake_entries WHERE id = ? AND store_no = ?", (entry_id, store_no))
    r = c.fetchone()
    if r:
        c.execute("DELETE FROM stocktake_scanned_serials WHERE product_code = ? AND batch_number = ? AND store_no = ?", (r["product_code"], r["batch_number"], store_no))
    c.execute("DELETE FROM stocktake_entries WHERE id = ? AND store_no = ?", (entry_id, store_no))
    conn.commit()
    conn.close()
    return {"success": True, "store_details": get_store_stocktake_details(store_no)}

def bulk_delete_stock_entries(entry_ids: List[int], store_no: str = 'ST-001') -> Dict[str, Any]:
    """حذف مجموعة أصناف محددة من الجرد دفعة واحدة"""
    if not entry_ids:
        return {"success": False, "message": "لم يتم تحديد أي أصناف للحذف"}
    conn = get_connection()
    store_no = resolve_valid_store_no(conn, store_no)
    c = conn.cursor()
    placeholders = ",".join("?" * len(entry_ids))
    # جلب السيريالات المرتبطة لحذفها
    c.execute(f"SELECT product_code, batch_number FROM stocktake_entries WHERE id IN ({placeholders}) AND store_no = ?", (*entry_ids, store_no))
    rows = c.fetchall()
    for r in rows:
        c.execute("DELETE FROM stocktake_scanned_serials WHERE product_code = ? AND batch_number = ? AND store_no = ?", (r["product_code"], r["batch_number"], store_no))
    c.execute(f"DELETE FROM stocktake_entries WHERE id IN ({placeholders}) AND store_no = ?", (*entry_ids, store_no))
    conn.commit()
    conn.close()
    return {"success": True, "message": f"تم حذف {len(entry_ids)} صنف بنجاح", "store_details": get_store_stocktake_details(store_no)}

def edit_stocktake_entry(entry_id: int, updates: Dict[str, Any], store_no: str = 'ST-001') -> Dict[str, Any]:
    """تعديل بيانات بند الجرد (الكمية الفعلية، الباتش، تاريخ الصلاحية، سعر التكلفة، سعر البيع)"""
    conn = get_connection()
    store_no = resolve_valid_store_no(conn, store_no)
    c = conn.cursor()
    c.execute("SELECT * FROM stocktake_entries WHERE id = ? AND store_no = ?", (entry_id, store_no))
    row = c.fetchone()
    if not row:
        conn.close()
        return {"success": False, "message": "الصنف غير موجود بالجرد"}

    from .qr_parser import decode_arabic_keyboard_layout
    counted_qty = float(updates.get("counted_qty", row["counted_qty"]))
    batch = decode_arabic_keyboard_layout(str(updates.get("batch_number", row["batch_number"] or '')).strip()).upper()
    expiry = str(updates.get("expiry_date", row["expiry_date"] or '')).strip()
    cost = float(updates.get("cost_price", row["cost_price"] or 0))
    sale = float(updates.get("selling_price", row["selling_price"] or 0))
    
    # فحص ما إذا كان الباتش مطابق مع المخزون المسجل
    c.execute("SELECT * FROM inventory_records WHERE product_code = ? AND store_no = ? AND batch_number = ? LIMIT 1", (row["product_code"], store_no, batch))
    inv = c.fetchone()
    is_new = 0 if inv else (1 if batch else 0)

    c.execute("""
        UPDATE stocktake_entries
        SET counted_qty = ?,
            batch_number = ?,
            expiry_date = ?,
            cost_price = ?,
            selling_price = ?,
            is_new_batch = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND store_no = ?
    """, (counted_qty, batch, expiry, cost, sale, is_new, entry_id, store_no))

    conn.commit()
    conn.close()
    return {"success": True, "message": "تم تعديل بيانات الصنف بنجاح", "store_details": get_store_stocktake_details(store_no)}

def clear_inventory_records(store_no: str = 'ST-001', clear_all: bool = False) -> Dict[str, Any]:
    """حذف رصيد المخزون الدفتري المرفوع بالكامل للتمكن من رفع ملف مخزون جديد مع تصفير الأرصدة وتحديث الجرد فوراً"""
    conn = get_connection()
    c = conn.cursor()
    
    clean_store = str(store_no or '').strip()
    if clear_all or clean_store.upper() == 'ALL':
        c.execute("DELETE FROM inventory_records")
        c.execute("UPDATE stocktake_entries SET system_qty = 0")
        c.execute("DELETE FROM stocktake_entries WHERE counted_qty = 0 OR counted_qty IS NULL")
        msg = "تم حذف وتصفير رصيد المخزون السابق بالكامل لجميع الاستورات بنجاح."
        target_store = 'ST-001'
    else:
        target_store = resolve_valid_store_no(conn, clean_store)
        c.execute("SELECT COUNT(*) FROM inventory_records WHERE store_no = ?", (target_store,))
        cnt = c.fetchone()[0]
        
        # إذا لم تكن هناك سجلات للاستور المحدد ولكن توجد سجلات مخزون عامة في النظام
        if cnt == 0:
            c.execute("SELECT COUNT(*) FROM inventory_records")
            total_cnt = c.fetchone()[0]
            if total_cnt > 0:
                c.execute("DELETE FROM inventory_records")
                c.execute("UPDATE stocktake_entries SET system_qty = 0")
                c.execute("DELETE FROM stocktake_entries WHERE counted_qty = 0 OR counted_qty IS NULL")
                msg = f"تم تصفير وحذف رصيد المخزون العام السابق ({total_cnt} صنف) بنجاح."
            else:
                msg = f"رصيد المخزون السابق فارغ بالفعل للاستور ({target_store})."
        else:
            c.execute("DELETE FROM inventory_records WHERE store_no = ?", (target_store,))
            c.execute("UPDATE stocktake_entries SET system_qty = 0 WHERE store_no = ?", (target_store,))
            c.execute("DELETE FROM stocktake_entries WHERE store_no = ? AND (counted_qty = 0 OR counted_qty IS NULL)", (target_store,))
            msg = f"تم حذف رصيد المخزون السابق ({cnt} صنف) للاستور ({target_store}) بنجاح."

    conn.commit()
    conn.close()
    return {
        "success": True,
        "message": msg,
        "store_details": get_store_stocktake_details(target_store)
    }

def clear_store_stocktake(store_no: str) -> Dict[str, Any]:
    """تصفير الجرد الفعلي للاستور"""
    conn = get_connection()
    c = conn.cursor()
    c.execute("DELETE FROM stocktake_entries WHERE store_no = ?", (store_no,))
    c.execute("DELETE FROM stocktake_scanned_serials WHERE store_no = ?", (store_no,))
    c.execute("UPDATE stock_stores SET status = 'new' WHERE store_no = ?", (store_no,))
    conn.commit()
    conn.close()
    return {"success": True, "store_details": get_store_stocktake_details(store_no)}

def commit_stores_stocktake(store_nos: Optional[List[str]] = None) -> Dict[str, Any]:
    """
    تعميد وترحيل الجرد النهائي للاستورات المحددة أو جميع الاستورات:
    1. مسح الاستوك الدفتري القديم من inventory_records للاستورات المحددة.
    2. اعتماد الأرصدة والتشغيلات المجرودة فعلياً من stocktake_entries ونقلها إلى inventory_records كأرصدة جديدة.
    3. تسوية الأرصدة في stocktake_entries (system_qty = counted_qty) ليصبح الفرق 0.
    4. تغيير حالة الاستور إلى 'completed'.
    """
    conn = get_connection()
    c = conn.cursor()

    if not store_nos or 'ALL' in store_nos:
        c.execute("SELECT store_no FROM stock_stores")
        store_nos = [r['store_no'] for r in c.fetchall()]

    if not store_nos:
        conn.close()
        return {"success": False, "message": "لم يتم تحديد أي استور للترحيل والتعميد."}

    settled_stores = []
    total_adopted_records = 0

    for store_no in store_nos:
        # 1. جلب جميع الأصناف والتشغيلات المجرودة فعلياً بهذا الاستور
        c.execute("""
            SELECT * FROM stocktake_entries
            WHERE store_no = ? AND counted_qty > 0
        """, (store_no,))
        counted_entries = c.fetchall()

        # 2. مسح الاستوك القديم تماماً لهذا الاستور
        c.execute("DELETE FROM inventory_records WHERE store_no = ?", (store_no,))

        # 3. اعتماد الأرصدة والتشغيلات المجرودة فعلياً كأرصدة مخزون جديدة
        for e in counted_entries:
            c.execute("""
                INSERT INTO inventory_records (
                    product_code, product_name, barcode, batch_number, expiry_date,
                    system_qty, cost_price, selling_price, item_type, store_no, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """, (
                e['product_code'],
                e['product_name'] or '',
                e['barcode'] or e['gtin'] or '',
                str(e['batch_number'] or '').strip().upper(),
                e['expiry_date'] or '',
                float(e['counted_qty'] or 0),
                float(e['cost_price'] or 0),
                float(e['selling_price'] or 0),
                e['item_type'] or 'medicine',
                store_no
            ))
            total_adopted_records += 1

        # 4. تسوية الأرصدة الدفترية في جدول الجرد لتتطابق تماماً مع الفعلي
        c.execute("""
            UPDATE stocktake_entries
            SET system_qty = counted_qty, updated_at = CURRENT_TIMESTAMP
            WHERE store_no = ?
        """, (store_no,))

        # 5. اعتماد الاستور وتحديث حالته وتاريخ ترحيله
        c.execute("""
            UPDATE stock_stores
            SET status = 'completed', counted_at = CURRENT_TIMESTAMP
            WHERE store_no = ?
        """, (store_no,))

        settled_stores.append(store_no)

    conn.commit()
    conn.close()

    return {
        "success": True,
        "message": f"تم تعميد وترحيل الجرد بنجاح لعدد {len(settled_stores)} استور، ومسح الاستوك القديم واعتماد {total_adopted_records} تشغيلة وبند كأرصدة جديدة للمخزون.",
        "settled_stores": settled_stores,
        "total_adopted_records": total_adopted_records
    }

def settle_store_stocktake(store_no: str) -> Dict[str, Any]:
    """ترحيل واعتماد الجرد النهائي للاستور (مسح القديم واعتماد الجديد)"""
    return commit_stores_stocktake([store_no])

def populate_store_from_inventory(store_no: str = 'ST-001') -> Dict[str, Any]:
    """
    إدراج جميع أصناف وباتشات المخزون المسجلة لهذا الاستور في جدول الجرد دفعة واحدة:
    - ينزل كل بند بكل باتش وتاريخ صلاحية ورصيد دفتري مسجل.
    - البنود التي لم يتم مسحها تبدأ بالكمية الفعلية 0.
    - البنود الممسوحة مسبقاً تحتفظ بكمياتها الفعلية.
    """
    conn = get_connection()
    store_no = resolve_valid_store_no(conn, store_no)
    c = conn.cursor()

    c.execute("""
        SELECT * FROM inventory_records
        WHERE store_no = ?
        ORDER BY id ASC
    """, (store_no,))
    records = c.fetchall()

    added = 0
    for r in records:
        p_code = r['product_code']
        b_num = (r['batch_number'] or '').strip().upper()
        c.execute("""
            SELECT id FROM stocktake_entries
            WHERE product_code = ? AND store_no = ? AND (batch_number = ? OR (batch_number = '' AND ? = ''))
        """, (p_code, store_no, b_num, b_num))
        if not c.fetchone():
            c.execute("""
                INSERT INTO stocktake_entries (
                    product_code, product_name, barcode, gtin, batch_number, expiry_date,
                    system_qty, counted_qty, cost_price, selling_price, is_new_batch,
                    item_type, store_no, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 0.0, ?, ?, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """, (
                p_code, r['product_name'] or '', r['barcode'] or '', r['barcode'] or '',
                b_num, r['expiry_date'] or '', float(r['system_qty'] or 0),
                float(r['cost_price'] or 0), float(r['selling_price'] or 0),
                r['item_type'] or 'medicine', store_no
            ))
            added += 1

    conn.commit()
    conn.close()
    return {
        "success": True,
        "message": f"تم إدراج {added} باتش/بند من رصيد المخزون في جدول الجرد بنجاح (المجموع: {len(records)} بند)",
        "store_details": get_store_stocktake_details(store_no)
    }

def upload_inventory_excel(file_path: str, store_no: str = 'ST-001', replace_existing: bool = True) -> Dict[str, Any]:
    """رفع رصيد المخزون مع الكشف الذكي عن سطر العناوين والأعمدة وحفظ التكلفة وسعر البيع"""
    if not os.path.exists(file_path):
        return {"success": False, "message": "الملف غير موجود"}

    wb = openpyxl.load_workbook(file_path, data_only=True)
    sheet = wb.active
    rows = list(sheet.iter_rows(values_only=True))
    if not rows:
        return {"success": False, "message": "ملف الإكسيل فارغ"}

    # 1. كشف ذكي لسطر العناوين (Header Row) حتى لو كان مسبوقاً ببيانات التقرير من نظام الـ ERP
    header_row_idx = 0
    detected = False
    for idx, r in enumerate(rows[:25]):
        row_str = ' '.join([str(c or '').lower() for c in r])
        matches = sum(1 for k in ['batch', 'product', 'ref', 'gtin', 'expiry', 'quantity', 'price', 'كود', 'صنف', 'تشغيلة', 'كمية', 'باركود', 'مخزن'] if k in row_str)
        if matches >= 2:
            header_row_idx = idx
            detected = True
            break

    header = [str(c or '').strip().lower() for c in rows[header_row_idx]]
    col_idx = {
        "code": -1, "name": -1, "cost": -1, "sale": -1,
        "expiry": -1, "qty": -1, "batch": -1, "barcode": -1,
        "batch_val": -1
    }

    for i, h in enumerate(header):
        if any(k in h for k in ['product ref', 'product_ref', 'item code', 'product code', 'كود', 'code', 'ref', 'رقم الصنف', 'رمز الصنف', 'item_id', 'pcode', 'sku']):
            if col_idx["code"] == -1: col_idx["code"] = i
        if any(k in h for k in ['product name', 'item name', 'اسم', 'name', 'description', 'الصنف', 'المادة']):
            if col_idx["name"] == -1: col_idx["name"] = i
        if any(k in h for k in ['batch sales price', 'product sales price', 'sales price', 'سعر البيع', 'بيع', 'sale', 'retail', 'unit price', 'سعر']):
            if col_idx["sale"] == -1: col_idx["sale"] = i
        if any(k in h for k in ['cost price', 'unit cost', 'تكلفة', 'cost', 'سعر التكلفة', 'شراء']):
            if col_idx["cost"] == -1: col_idx["cost"] = i
        if any(k in h for k in ['value w/o tax', 'batch value', 'قيمة التشغيلة', 'إجمالي التكلفة', 'قيمة']):
            if col_idx["batch_val"] == -1: col_idx["batch_val"] = i
        if any(k in h for k in ['expiry date', 'صلاحية', 'expiry', 'exp', 'تاريخ الصلاحية', 'انتهاء']):
            if col_idx["expiry"] == -1: col_idx["expiry"] = i
        if any(k in h for k in ['quantity', 'كمية', 'qty', 'الرصيد', 'الكمية', 'stock', 'balance']):
            if col_idx["qty"] == -1: col_idx["qty"] = i
        if any(k in h for k in ['batch number', 'تشغيلة', 'batch', 'lot', 'الباتش', 'الدفعة']):
            if col_idx["batch"] == -1: col_idx["batch"] = i
        if any(k in h for k in ['gtin', 'باركود', 'barcode', 'ean']):
            if col_idx["barcode"] == -1: col_idx["barcode"] = i

    conn = get_connection()
    c = conn.cursor()

    if replace_existing:
        c.execute("DELETE FROM inventory_records WHERE store_no = ?", (store_no,))

    added_count = 0
    for r in rows[header_row_idx + 1:]:
        if not r or all(v is None for v in r):
            continue

        raw_code = r[col_idx["code"]] if col_idx["code"] >= 0 else None
        code = clean_numeric_code(raw_code)
        barcode = str(r[col_idx["barcode"]] if col_idx["barcode"] >= 0 and r[col_idx["barcode"]] is not None else '').strip()

        # إذا لم يكن الكود مسجلاً صراحة، نحاول مطابقته بالـ GTIN أو الباركود
        prod = None
        if code:
            prod = get_product_by_code(code)
        if not prod and barcode:
            prod = find_product_by_gtin_or_barcode(barcode)
            if prod:
                code = prod["code"]

        if not code:
            continue

        name = str(r[col_idx["name"]] if col_idx["name"] >= 0 and r[col_idx["name"]] is not None else '').strip()
        batch = str(r[col_idx["batch"]] if col_idx["batch"] >= 0 and r[col_idx["batch"]] is not None else '').strip().upper()
        expiry = str(r[col_idx["expiry"]] if col_idx["expiry"] >= 0 and r[col_idx["expiry"]] is not None else '').strip()

        try:
            qty = float(r[col_idx["qty"]] if col_idx["qty"] >= 0 and r[col_idx["qty"]] is not None else 0)
        except:
            qty = 0.0

        try:
            cost = float(r[col_idx["cost"]] if col_idx["cost"] >= 0 and r[col_idx["cost"]] is not None else 0)
        except:
            cost = 0.0

        # إذا كانت التكلفة صفر ولدينا إجمالي قيمة التشغيلة / بدون ضريبة
        if not cost and col_idx["batch_val"] >= 0 and r[col_idx["batch_val"]] is not None:
            try:
                b_val = float(r[col_idx["batch_val"]])
                if qty > 0:
                    cost = round(b_val / qty, 2)
                else:
                    cost = b_val
            except:
                pass

        try:
            sale = float(r[col_idx["sale"]] if col_idx["sale"] >= 0 and r[col_idx["sale"]] is not None else 0)
        except:
            sale = 0.0

        item_type = 'medicine'
        if prod:
            # اسم الصنف بالإنجليزية كما في كرت الصنف
            name = prod.get("name_en") or name or prod.get("name") or ""
            item_type = prod.get("item_type") or 'medicine'
            if not cost and prod.get("cost_price"):
                cost = float(prod["cost_price"])
            if not sale:
                sale = float(prod.get("selling_price") or prod.get("price") or prod.get("unit_price") or 0.0)
            if not barcode and prod.get("barcode"):
                barcode = prod["barcode"]

        c.execute("""
            INSERT INTO inventory_records (
                product_code, product_name, barcode, batch_number, expiry_date,
                system_qty, cost_price, selling_price, item_type, store_no, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """, (code, name, barcode, batch, expiry, qty, cost, sale, item_type, store_no))
        added_count += 1

    # تحديث وتحديث مطابقة بنود الجرد التي تم مسحها بالفعل في هذا الاستور (الاسم الإنجليزي، الباتش، الصلاحية، الرصيد، التكلفة، البيع)
    c.execute("""
        UPDATE stocktake_entries
        SET 
            product_name = COALESCE((
                SELECT COALESCE(NULLIF(name_en, ''), name)
                FROM products
                WHERE products.code = stocktake_entries.product_code
            ), product_name),
            batch_number = CASE 
                WHEN batch_number = '' OR batch_number IS NULL THEN COALESCE((
                    SELECT batch_number FROM inventory_records
                    WHERE inventory_records.product_code = stocktake_entries.product_code
                      AND inventory_records.store_no = stocktake_entries.store_no
                      AND inventory_records.batch_number != ''
                    ORDER BY id DESC LIMIT 1
                ), batch_number)
                ELSE batch_number
            END,
            expiry_date = CASE 
                WHEN expiry_date = '' OR expiry_date IS NULL THEN COALESCE((
                    SELECT expiry_date FROM inventory_records
                    WHERE inventory_records.product_code = stocktake_entries.product_code
                      AND inventory_records.store_no = stocktake_entries.store_no
                      AND inventory_records.expiry_date != ''
                    ORDER BY id DESC LIMIT 1
                ), expiry_date)
                ELSE expiry_date
            END,
            cost_price = CASE 
                WHEN cost_price = 0 OR cost_price IS NULL THEN COALESCE((
                    SELECT cost_price FROM inventory_records
                    WHERE inventory_records.product_code = stocktake_entries.product_code
                      AND inventory_records.cost_price > 0
                    LIMIT 1
                ), cost_price)
                ELSE cost_price
            END,
            selling_price = CASE 
                WHEN selling_price = 0 OR selling_price IS NULL THEN COALESCE((
                    SELECT selling_price FROM inventory_records
                    WHERE inventory_records.product_code = stocktake_entries.product_code
                      AND inventory_records.selling_price > 0
                    LIMIT 1
                ), selling_price)
                ELSE selling_price
            END,
            system_qty = CASE
                WHEN system_qty = 0 OR system_qty IS NULL THEN COALESCE((
                    SELECT system_qty FROM inventory_records
                    WHERE inventory_records.product_code = stocktake_entries.product_code
                      AND inventory_records.store_no = stocktake_entries.store_no
                      AND (inventory_records.batch_number = stocktake_entries.batch_number OR (stocktake_entries.batch_number = '' AND (inventory_records.batch_number IS NULL OR inventory_records.batch_number = '')))
                    LIMIT 1
                ), (
                    SELECT system_qty FROM inventory_records
                    WHERE inventory_records.product_code = stocktake_entries.product_code
                      AND inventory_records.store_no = stocktake_entries.store_no
                    ORDER BY id DESC LIMIT 1
                ), 0)
                ELSE system_qty
            END,
            is_new_batch = CASE WHEN EXISTS (
                SELECT 1 FROM inventory_records
                WHERE inventory_records.product_code = stocktake_entries.product_code
                  AND inventory_records.store_no = stocktake_entries.store_no
                  AND inventory_records.batch_number = stocktake_entries.batch_number
            ) THEN 0 ELSE (CASE WHEN stocktake_entries.batch_number != '' THEN 1 ELSE 0 END) END
        WHERE store_no = ?
    """, (store_no,))

    conn.commit()
    conn.close()

    return {
        "success": True,
        "added_count": added_count,
        "message": f"تم رفع واحتساب رصيد المخزون بنجاح ({added_count} سجل)",
        "store_details": get_store_stocktake_details(store_no)
    }

def export_store_stocktake_to_excel(out_path: str, store_no: str = 'ST-001', sheet_title: Optional[str] = None, location_val: Optional[str] = None) -> str:
    """
    تصدير ملف إكسيل الجرد متطابقاً تماماً مع نموذج جرد الفاتورة المعتمد:
    Product | NAME ENGLISH | Location | Lot/Serial Number | Expiry Date | Counted quantity
    - Sheet 1: نموذج الجرد والكميات المعتمد (Stock Count) بالأعمدة الستة المعتمدة واتجاه LTR.
    - Sheet 2: تقرير المطابقة والتكلفة وسعر البيع التفصيلي للمراجعة المالية والمخزنية.
    """
    store_data = get_store_stocktake_details(store_no)
    items = store_data.get("items", [])
    stats = store_data.get("stats", {})
    st_info = store_data.get("store", {})

    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    wb = openpyxl.Workbook()

    # ==================== الورقة الأولى: نموذج الجرد المعتمد المتطابق مع الفاتورة ====================
    ws1 = wb.active
    clean_title = re.sub(r'[\\/*?:\[\]]', '_', str(sheet_title or st_info.get('store_name') or store_no).strip())[:31] or "STOCK_COUNT"
    ws1.title = clean_title

    # اتجاه الورقة بالإنجليزية من اليسار إلى اليمين (Left-to-Right) متطابق تماماً مع الفاتورة
    ws1.sheet_view.rightToLeft = False
    ws1.views.sheetView[0].rightToLeft = False
    ws1.freeze_panes = 'A2'

    thin_border = Border(
        left=Side(style='thin', color='CBD5E1'),
        right=Side(style='thin', color='CBD5E1'),
        top=Side(style='thin', color='CBD5E1'),
        bottom=Side(style='thin', color='CBD5E1')
    )
    header_fill = PatternFill(start_color="0F766E", end_color="0F766E", fill_type="solid")
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    header_align = Alignment(horizontal="center", vertical="center", wrap_text=True)

    data_font = Font(name="Calibri", size=10)
    data_font_bold = Font(name="Calibri", size=10, bold=True)
    align_center = Alignment(horizontal="center", vertical="center")
    align_left = Alignment(horizontal="left", vertical="center")
    zebra_fill = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")

    cols_stock = [
        "Product",
        "NAME ENGLISH",
        "Location",
        "Lot/Serial Number",
        "Expiry Date",
        "Counted quantity"
    ]

    ws1.append(cols_stock)
    ws1.row_dimensions[1].height = 28

    for col_idx in range(1, len(cols_stock) + 1):
        cell = ws1.cell(row=1, column=col_idx)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = header_align
        cell.border = thin_border

    loc_str = str(location_val or "").strip()

    for row_idx, e in enumerate(items, start=2):
        ws1.row_dimensions[row_idx].height = 22

        p_code = str(e.get("product_code") or "").strip()
        p_name = str(e.get("product_name") or "").strip()
        p_batch = str(e.get("batch_number") or "").strip().upper()
        p_exp = str(e.get("expiry_date") or "").strip()

        c_qty_raw = e.get("counted_qty") or 0
        try:
            c_qty = int(float(c_qty_raw)) if float(c_qty_raw).is_integer() else float(c_qty_raw)
        except:
            c_qty = 0

        row_vals = [
            p_code,
            p_name,
            loc_str,
            p_batch,
            p_exp,
            c_qty
        ]
        ws1.append(row_vals)

        is_even = (row_idx % 2 == 0)
        row_fill = zebra_fill if is_even else PatternFill(fill_type=None)

        for col_idx in range(1, len(cols_stock) + 1):
            cell = ws1.cell(row=row_idx, column=col_idx)
            cell.font = data_font
            cell.border = thin_border
            if row_fill.fill_type:
                cell.fill = row_fill

            col_name = cols_stock[col_idx - 1]
            if col_name == "Counted quantity":
                cell.number_format = '#,##0' if isinstance(c_qty, int) else '#,##0.00'
                cell.alignment = align_center
                cell.font = data_font_bold
            elif col_name in ("Product", "Location", "Lot/Serial Number", "Expiry Date"):
                cell.alignment = align_center
            else:
                cell.alignment = align_left

    for col in ws1.columns:
        col_letter = openpyxl.utils.get_column_letter(col[0].column)
        max_len = 0
        for cell in col:
            val_str = str(cell.value or '')
            if len(val_str) > max_len:
                max_len = len(val_str)
        ws1.column_dimensions[col_letter].width = max(max_len + 4, 16)

    # ==================== الورقة الثانية: مراجعة التكلفة وسعر البيع والمطابقة الدفترية ====================
    ws2 = wb.create_sheet(title="AUDIT_VALUATION")
    ws2.sheet_view.rightToLeft = True
    ws2.views.sheetView[0].rightToLeft = True

    audit_header_fill = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid")
    kpi_fill = PatternFill(start_color="F1F5F9", end_color="F1F5F9", fill_type="solid")
    title_font = Font(name="Calibri", size=13, bold=True, color="1E293B")

    ws2.merge_cells("A1:N1")
    ws2["A1"] = f"تقرير مطابقة الجرد والتكلفة وسعر البيع – {st_info.get('store_name')} ({store_no})"
    ws2["A1"].font = title_font
    ws2["A1"].alignment = Alignment(horizontal="center", vertical="center")
    ws2.row_dimensions[1].height = 28

    ws2.merge_cells("A3:C3")
    ws2["A3"] = f"تكلفة المخزون: {stats.get('system_cost', 0):,.2f} ر.س | بيع: {stats.get('system_sale', 0):,.2f} ر.س"
    ws2["A3"].font = data_font_bold
    ws2["A3"].fill = kpi_fill

    ws2.merge_cells("D3:F3")
    ws2["D3"] = f"تكلفة الاستور: {stats.get('counted_cost', 0):,.2f} ر.س | بيع: {stats.get('counted_sale', 0):,.2f} ر.س"
    ws2["D3"].font = data_font_bold
    ws2["D3"].fill = kpi_fill

    ws2.merge_cells("G3:I3")
    ws2["G3"] = f"فرق التكلفة: {stats.get('diff_cost', 0):+,.2f} ر.س | فرق البيع: {stats.get('diff_sale', 0):+,.2f} ر.س"
    ws2["G3"].font = data_font_bold
    ws2["G3"].fill = kpi_fill

    ws2.merge_cells("J3:L3")
    ws2["J3"] = f"إجمالي الكمية الفعلية: {stats.get('counted_qty', 0):,.0f} عبوة"
    ws2["J3"].font = data_font_bold
    ws2["J3"].fill = kpi_fill

    audit_headers = [
        "م", "كود الصنف", "اسم الصنف", "الباركود / GTIN", "التشغيلة (Batch)",
        "تاريخ الصلاحية (Exp)", "رصيد المخزون (السيستم)", "الرصيد الفعلي (المجرود)", "الفرق", "سعر التكلفة",
        "سعر البيع", "إجمالي التكلفة الفعلية", "إجمالي البيع الفعلي", "حالة الباتش"
    ]
    ws2.row_dimensions[5].height = 24
    for c_idx, h in enumerate(audit_headers, 1):
        cell = ws2.cell(row=5, column=c_idx, value=h)
        cell.font = header_font
        cell.fill = audit_header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")
        cell.border = thin_border

    cur_row = 6
    new_batch_fill = PatternFill(start_color="FEF3C7", end_color="FEF3C7", fill_type="solid")

    for idx, e in enumerate(items, 1):
        ws2.row_dimensions[cur_row].height = 20
        diff = round((e.get("counted_qty") or 0) - (e.get("system_qty") or 0), 2)
        tot_c = round((e.get("counted_qty") or 0) * (e.get("cost_price") or 0), 2)
        tot_s = round((e.get("counted_qty") or 0) * (e.get("selling_price") or 0), 2)
        batch_st = "⚠️ باتش جديد" if e.get("is_new_batch") else "مطابق"

        vals = [
            idx, e.get("product_code"), e.get("product_name"), e.get("gtin") or e.get("barcode"),
            str(e.get("batch_number") or "").strip().upper(), e.get("expiry_date"), e.get("system_qty"), e.get("counted_qty"),
            diff, e.get("cost_price"), e.get("selling_price"), tot_c, tot_s, batch_st
        ]

        for col_i, v in enumerate(vals, 1):
            cell = ws2.cell(row=cur_row, column=col_i, value=v)
            cell.font = data_font_bold if col_i in (8, 9, 12, 13) else data_font
            cell.border = thin_border
            cell.alignment = Alignment(horizontal="center" if col_i not in (2, 3) else "right", vertical="center")
            if e.get("is_new_batch"):
                cell.fill = new_batch_fill

        cur_row += 1

    col_widths = [6, 14, 32, 16, 14, 14, 14, 14, 12, 12, 12, 18, 18, 14]
    for i, w in enumerate(col_widths, 1):
        ws2.column_dimensions[openpyxl.utils.get_column_letter(i)].width = w

    # إبقاء الورقة الأولى هي النشطة دائماً عند فتح الملف في Excel
    wb.active = ws1

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    wb.save(out_path)
    return out_path

def get_uncounted_store_items(store_no: str = 'ST-001', category: str = '') -> Dict[str, Any]:
    """
    جلب تقرير الأصناف التي لم تُجرد في الاستور (Estimated Not Found):
    الأصناف المسجلة في رصيد المخزون الدفتري ولم يتم مسحها أو جردها حتى الآن في هذا الاستور
    """
    conn = get_connection()
    store_no = resolve_valid_store_no(conn, store_no)
    c = conn.cursor()

    c.execute("SELECT * FROM stock_stores WHERE store_no = ?", (store_no,))
    store_info = c.fetchone()

    # فحص هل يوجد سجلات مخزون لهذا الاستور
    c.execute("SELECT COUNT(*) FROM inventory_records WHERE store_no = ?", (store_no,))
    has_store_inv = c.fetchone()[0] > 0

    if has_store_inv:
        sql = """
            SELECT ir.*
            FROM inventory_records ir
            WHERE ir.store_no = ?
              AND NOT EXISTS (
                  SELECT 1 FROM stocktake_entries se
                  WHERE se.store_no = ir.store_no
                    AND (
                        se.product_code = ir.product_code
                        OR (ir.barcode IS NOT NULL AND ir.barcode != '' AND (se.gtin = ir.barcode OR se.barcode = ir.barcode))
                    )
                    AND (
                        (ir.batch_number IS NOT NULL AND ir.batch_number != '' AND se.batch_number = ir.batch_number)
                        OR
                        ((ir.batch_number IS NULL OR ir.batch_number = '') AND (se.batch_number IS NULL OR se.batch_number = ''))
                    )
                    AND se.counted_qty > 0
              )
        """
        params = [store_no]
    else:
        # إذا لم يكن هناك مخزون مخصص برقم الاستور، نبحث في المخزون العام
        sql = """
            SELECT ir.*
            FROM inventory_records ir
            WHERE NOT EXISTS (
                SELECT 1 FROM stocktake_entries se
                WHERE (
                    se.product_code = ir.product_code
                    OR (ir.barcode IS NOT NULL AND ir.barcode != '' AND (se.gtin = ir.barcode OR se.barcode = ir.barcode))
                )
                  AND se.store_no = ?
                  AND (
                      (ir.batch_number IS NOT NULL AND ir.batch_number != '' AND se.batch_number = ir.batch_number)
                      OR
                      ((ir.batch_number IS NULL OR ir.batch_number = '') AND (se.batch_number IS NULL OR se.batch_number = ''))
                  )
                  AND se.counted_qty > 0
            )
        """
        params = [store_no]

    if category:
        sql += " AND ir.item_type = ?"
        params.append(category)

    sql += " ORDER BY ir.id ASC"
    c.execute(sql, tuple(params))
    raw_items = [dict(r) for r in c.fetchall()]

    items = []
    total_qty = 0.0
    total_cost = 0.0
    total_sale = 0.0

    for r in raw_items:
        p_code = r.get("product_code")
        c.execute("SELECT name_en, name, category, cost_price, selling_price, unit_price FROM products WHERE code = ?", (p_code,))
        pr = c.fetchone()
        if not pr:
            c_pcode = clean_numeric_code(p_code)
            if c_pcode and c_pcode != p_code:
                c.execute("SELECT name_en, name, category, cost_price, selling_price, unit_price FROM products WHERE code = ?", (c_pcode,))
                pr = c.fetchone()

        clean_name = r.get("product_name") or ""
        cat = r.get("item_type") or "medicine"
        cost = float(r.get("cost_price") or 0.0)
        sale = float(r.get("selling_price") or 0.0)
        sys_qty = float(r.get("system_qty") or 0.0)

        if pr:
            pr_dict = dict(pr)
            clean_name = pr_dict.get("name_en") or clean_name or pr_dict.get("name") or ""
            if pr_dict.get("category"):
                cat = pr_dict["category"]
            if cost == 0 and pr_dict.get("cost_price"):
                cost = float(pr_dict["cost_price"])
            if sale == 0:
                s_p = pr_dict.get("selling_price") or pr_dict.get("unit_price")
                if s_p:
                    sale = float(s_p)

        line_cost = round(sys_qty * cost, 2)
        line_sale = round(sys_qty * sale, 2)

        total_qty += sys_qty
        total_cost += line_cost
        total_sale += line_sale

        items.append({
            "id": r.get("id"),
            "product_code": p_code,
            "product_name": clean_name,
            "barcode": r.get("barcode") or "",
            "batch_number": str(r.get("batch_number") or "").strip().upper(),
            "expiry_date": r.get("expiry_date") or "",
            "system_qty": sys_qty,
            "cost_price": cost,
            "selling_price": sale,
            "total_cost": line_cost,
            "total_sale": line_sale,
            "category": cat,
            "store_no": store_no
        })

    conn.close()

    # تجميع حسب الأقسام
    categories_summary = {}
    for it in items:
        cat_key = it["category"] or "عام"
        if cat_key not in categories_summary:
            categories_summary[cat_key] = {"count": 0, "qty": 0.0, "cost": 0.0, "sale": 0.0}
        categories_summary[cat_key]["count"] += 1
        categories_summary[cat_key]["qty"] = round(categories_summary[cat_key]["qty"] + it["system_qty"], 2)
        categories_summary[cat_key]["cost"] = round(categories_summary[cat_key]["cost"] + it["total_cost"], 2)
        categories_summary[cat_key]["sale"] = round(categories_summary[cat_key]["sale"] + it["total_sale"], 2)

    return {
        "store": dict(store_info) if store_info else {"store_no": store_no, "store_name": "الاستور الرئيسي"},
        "items": items,
        "categories_summary": categories_summary,
        "stats": {
            "total_uncounted_items": len(items),
            "total_uncounted_qty": round(total_qty, 2),
            "total_uncounted_cost": round(total_cost, 2),
            "total_uncounted_sale": round(total_sale, 2)
        }
    }

def export_uncounted_items_to_excel(out_path: str, store_no: str = 'ST-001', sheet_title: Optional[str] = None) -> str:
    """
    تصدير تقرير الأصناف التي لم تُجرد إلى ملف Excel بنفس نموذج الفاتورة المعتمد
    """
    uncounted_data = get_uncounted_store_items(store_no)
    items = uncounted_data.get("items", [])
    st_info = uncounted_data.get("store", {})

    from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
    wb = openpyxl.Workbook()

    ws = wb.active
    clean_title = re.sub(r'[\\/*?:\[\]]', '_', str(sheet_title or f"NOT_FOUND_{store_no}").strip())[:31] or "ESTIMATED_NOT_FOUND"
    ws.title = clean_title

    ws.sheet_view.rightToLeft = False
    ws.views.sheetView[0].rightToLeft = False
    ws.freeze_panes = 'A2'

    thin_border = Border(
        left=Side(style='thin', color='CBD5E1'),
        right=Side(style='thin', color='CBD5E1'),
        top=Side(style='thin', color='CBD5E1'),
        bottom=Side(style='thin', color='CBD5E1')
    )
    header_fill = PatternFill(start_color="991B1B", end_color="991B1B", fill_type="solid")
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    header_align = Alignment(horizontal="center", vertical="center", wrap_text=True)

    data_font = Font(name="Calibri", size=10)
    data_font_bold = Font(name="Calibri", size=10, bold=True)
    align_center = Alignment(horizontal="center", vertical="center")
    align_left = Alignment(horizontal="left", vertical="center")
    zebra_fill = PatternFill(start_color="FFF1F2", end_color="FFF1F2", fill_type="solid")

    cols = [
        "Product",
        "NAME ENGLISH",
        "Location",
        "Lot/Serial Number",
        "Expiry Date",
        "Uncounted quantity",
        "Cost Price",
        "Sales Price",
        "Total Cost",
        "Total Sale"
    ]

    ws.append(cols)
    ws.row_dimensions[1].height = 28

    for col_idx in range(1, len(cols) + 1):
        cell = ws.cell(row=1, column=col_idx)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = header_align
        cell.border = thin_border

    loc_str = str(st_info.get("store_name") or store_no)

    for row_idx, e in enumerate(items, start=2):
        ws.row_dimensions[row_idx].height = 22

        p_code = str(e.get("product_code") or "").strip()
        p_name = str(e.get("product_name") or "").strip()
        p_batch = str(e.get("batch_number") or "").strip().upper()
        p_exp = str(e.get("expiry_date") or "").strip()
        u_qty = e.get("system_qty") or 0
        cost_p = float(e.get("cost_price") or 0.0)
        sale_p = float(e.get("selling_price") or 0.0)
        tot_c = float(e.get("total_cost") or 0.0)
        tot_s = float(e.get("total_sale") or 0.0)

        row_vals = [
            p_code,
            p_name,
            loc_str,
            p_batch,
            p_exp,
            u_qty,
            cost_p,
            sale_p,
            tot_c,
            tot_s
        ]
        ws.append(row_vals)

        is_even = (row_idx % 2 == 0)
        row_fill = zebra_fill if is_even else PatternFill(fill_type=None)

        for col_idx in range(1, len(cols) + 1):
            cell = ws.cell(row=row_idx, column=col_idx)
            cell.font = data_font
            cell.border = thin_border
            if row_fill.fill_type:
                cell.fill = row_fill

            col_name = cols[col_idx - 1]
            if col_name in ("Uncounted quantity", "Total Cost", "Total Sale"):
                cell.alignment = align_center
                cell.font = data_font_bold
                cell.number_format = '#,##0.00'
            elif col_name in ("Cost Price", "Sales Price"):
                cell.alignment = align_center
                cell.number_format = '#,##0.00'
            elif col_name in ("Product", "Location", "Lot/Serial Number", "Expiry Date"):
                cell.alignment = align_center
            else:
                cell.alignment = align_left

    for col in ws.columns:
        col_letter = openpyxl.utils.get_column_letter(col[0].column)
        max_len = 0
        for cell in col:
            val_str = str(cell.value or '')
            if len(val_str) > max_len:
                max_len = len(val_str)
        ws.column_dimensions[col_letter].width = max(max_len + 4, 15)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    wb.save(out_path)
    return out_path
