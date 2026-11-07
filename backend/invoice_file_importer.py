import os
import re
from typing import Dict, Any, List, Optional
import pandas as pd
from .db import (
    get_connection, get_or_create_draft_invoice, get_invoice_details,
    find_product_by_gtin_or_barcode, get_product_by_code,
    save_or_update_product, clean_barcode_preserve_zeros,
    clean_numeric_code
)
from .qr_parser import parse_qr_code
from .catalog_importer import read_spreadsheet_dataframe

def normalize_date_str(date_str: str) -> str:
    """تحويل تواريخ الصلاحية المختلفة إلى YYYY-MM-DD"""
    if not date_str:
        return ""
    s = str(date_str).strip().split(' ')[0]
    if re.match(r'^\d{4}-\d{2}-\d{2}$', s):
        return s
    m = re.match(r'^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$', s)
    if m:
        d, mon, y = m.groups()
        return f"{y}-{int(mon):02d}-{int(d):02d}"
    if re.match(r'^\d{6}$', s):
        y = 2000 + int(s[0:2])
        mon = int(s[2:4])
        d = int(s[4:6])
        if d == 0:
            import calendar
            _, d = calendar.monthrange(y, mon)
        return f"{y}-{mon:02d}-{d:02d}"
    return s

def import_invoice_file_to_active_invoice(file_path: str, invoice_id: Optional[int] = None, user_name: str = "المسؤول") -> Dict[str, Any]:
    """
    استيراد ملف إكسيل أو CSV أو ملف نصي يحتوي على بنود فاتورة أو قائمة أكواد QR
    وتفريغها مباشرة داخل الفاتورة النشطة، مع تجميع البنود المتطابقة (الصنف + الباتش + الصلاحية)
    وحفظ السيريالات والكميات بدقة مع التعرف الكامل بالـ GTIN.
    """
    if not os.path.exists(file_path):
        return {"success": False, "message": "ملف الفاتورة غير موجود."}

    ext = os.path.splitext(file_path)[1].lower()

    if not invoice_id:
        active_inv = get_or_create_draft_invoice(user_name)
        invoice_id = active_inv["id"]

    inv_details = get_invoice_details(invoice_id)
    if not inv_details or inv_details.get("status") == "confirmed":
        return {"success": False, "message": "لا يمكن إضافة بنود إلى فاتورة معتمدة أو غير موجودة."}

    invoice_number = inv_details.get("invoice_number", "INV")

    # 1. إذا كان الملف نصياً (.txt) يحتوي على أكواد QR ممسوحة سطراً بسطر
    if ext == '.txt':
        qr_lines = []
        try:
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                for line in f:
                    l = line.strip()
                    if l:
                        qr_lines.append(l)
        except Exception as e:
            return {"success": False, "message": f"فشل قراءة الملف النصي: {str(e)}"}

        if not qr_lines:
            return {"success": False, "message": "الملف النصي فارغ."}

        df = pd.DataFrame({"qr_code": qr_lines})
    else:
        try:
            df, sheet_names, header_row = read_spreadsheet_dataframe(file_path)
        except Exception as e:
            return {"success": False, "message": f"فشل قراءة ملف الفاتورة: {str(e)}"}

    if df.empty:
        return {"success": False, "message": "ملف الفاتورة فارغ."}

    # اكتشاف الأعمدة بمرونة وذكاء
    cols = {c.lower().strip(): c for c in df.columns}
    
    def find_col(keywords: List[str]) -> Optional[str]:
        for k in keywords:
            for c_low, c_orig in cols.items():
                if k == c_low or k in c_low:
                    return c_orig
        return None

    qr_col = find_col(['qr', 'qr_code', 'datamatrix', 'barcode_data', 'كود qr', 'كيو ار', 'gs1', 'qr text'])
    gtin_col = find_col(['gtin', 'باركود', 'barcode', 'ean', 'جي تي ان'])
    code_col = find_col(['product', 'item code', 'كود الصنف', 'رمز الصنف', 'كود', 'code', 'default_code', 'reference', 'sequence'])
    name_col = find_col(['name', 'product_name', 'item name', 'اسم الصنف', 'اسم المنتج', 'البيان', 'description'])
    batch_col = find_col(['batch', 'batch number', 'bn', 'lot', 'تشغيلة', 'رقم الباتش', 'الدفعة'])
    serial_col = find_col(['serial', 'sn', 'سيريال', 'الرقم التسلسلي'])
    expiry_col = find_col(['expiry', 'expiry-date', 'xd', 'exp', 'صلاحية', 'تاريخ الانتهاء', 'الصلاحية'])
    qty_col = find_col(['quantite', 'quantity', 'qty', 'الكمية', 'العدد', 'الكميه', 'sold_qty', 'count'])
    price_col = find_col(['sales price', 'sale_price', 'price', 'سعر البيع', 'سعر'])
    unit_price_col = find_col(['unitprice', 'cost', 'unit cost', 'purchase price', 'سعر الوحدة', 'التكلفة'])

    resolved_rows = []
    skipped_count = 0

    for idx, row in df.iterrows():
        qr_raw = str(row.get(qr_col, '')).strip() if qr_col else ''
        if not qr_raw:
            # فحص إذا كان أي عمود يحتوي على كود QR بمعيار GS1
            for col_val in row.values:
                val_s = str(col_val).strip()
                if ('(01)' in val_s and '(10)' in val_s) or (val_s.startswith('01') and len(val_s) > 25):
                    qr_raw = val_s
                    break

        gtin_val = ''
        batch_val = ''
        serial_val = ''
        expiry_val = ''

        # إذا وُجد كود QR كامل في السطر، نقوم بتفريغه فوراً
        if qr_raw:
            parsed = parse_qr_code(qr_raw)
            if parsed.get("success"):
                d = parsed["data"]
                gtin_val = d.get("gtin") or ''
                batch_val = str(d.get("batch") or '').strip().upper()
                serial_val = str(d.get("serial") or '').strip().upper()
                expiry_val = d.get("expiry") or ''

        if not gtin_val and gtin_col:
            gtin_val = clean_barcode_preserve_zeros(str(row.get(gtin_col, '')))
        if not batch_val and batch_col:
            batch_val = str(row.get(batch_col, '')).strip().upper()
        if not serial_val and serial_col:
            serial_val = str(row.get(serial_col, '')).strip().upper()
        if not expiry_val and expiry_col:
            expiry_val = normalize_date_str(str(row.get(expiry_col, '')))

        if not batch_val or batch_val.lower() == 'nan':
            batch_val = 'BATCH-01'
        else:
            batch_val = batch_val.upper()
        if serial_val.lower() == 'nan':
            serial_val = ''
        if not expiry_val or expiry_val.lower() == 'nan':
            expiry_val = '2028-12-31'

        code_val = clean_numeric_code(str(row.get(code_col, '')).strip()) if code_col else ''
        name_val = str(row.get(name_col, '')).strip() if name_col else ''

        qty = 1
        if qty_col:
            try:
                q_raw = float(row.get(qty_col, 1))
                qty = max(1, int(q_raw))
            except:
                qty = 1

        sales_price = 0.0
        if price_col:
            try:
                sales_price = float(str(row.get(price_col, 0.0)).replace(',', '').strip())
            except:
                sales_price = 0.0

        unit_price = 0.0
        if unit_price_col:
            try:
                unit_price = float(str(row.get(unit_price_col, 0.0)).replace(',', '').strip())
            except:
                unit_price = 0.0

        # مطابقة الصنف بالـ GTIN أولاً (الأولوية القصوى لمعيار GS1)
        product = None
        if gtin_val:
            product = find_product_by_gtin_or_barcode(gtin_val)
        if not product and code_val:
            product = get_product_by_code(code_val)
        if not product and name_val:
            conn_temp = get_connection()
            c_temp = conn_temp.cursor()
            c_temp.execute("SELECT * FROM products WHERE name_en = ? OR name_ar = ? LIMIT 1", (name_val, name_val))
            row_p = c_temp.fetchone()
            if row_p:
                product = dict(row_p)
            conn_temp.close()

        # في حال كان الصنف غير موجود، يتم تسجيله تلقائياً
        if not product:
            if not name_val and not code_val and not gtin_val:
                skipped_count += 1
                continue
            prod_name = name_val or f"صنف مستورد {code_val or gtin_val}"
            ok, new_code, _ = save_or_update_product({
                "code": code_val or None,
                "name_en": prod_name,
                "name_ar": prod_name,
                "selling_price": sales_price,
                "unit_price": unit_price,
                "gtin_list": [gtin_val] if gtin_val else [],
                "barcode_list": []
            })
            product = get_product_by_code(new_code)

        resolved_rows.append({
            "idx": idx,
            "product": product,
            "batch": batch_val,
            "serial": serial_val,
            "expiry": expiry_val,
            "qty": qty,
            "sales_price": sales_price or product.get("selling_price", 0.0),
            "unit_price": unit_price or product.get("unit_price", 0.0),
            "gtin": gtin_val
        })

    # إضافة السطور والسيريالات إلى الفاتورة في معاملة واحدة سريعة
    conn = get_connection()
    c = conn.cursor()
    imported_count = 0

    try:
        for item in resolved_rows:
            product = item["product"]
            prod_code = product["code"]
            prod_name_ar = product.get("name_ar", "")
            prod_name_en = product.get("name_en", "")
            prod_name = prod_name_en or prod_name_ar or product.get("name") or f"صنف {prod_code}"
            batch_val = item["batch"]
            serial_val = item["serial"]
            expiry_val = item["expiry"]
            qty = item["qty"]
            s_price = item["sales_price"]
            u_price = item["unit_price"]
            tax_rate = float(product.get("tax_rate") or 0.0)
            unit = str(product.get("unit") or "علبة").strip()
            gtin_val = item["gtin"]
            idx = item["idx"]

            c.execute("""
                SELECT id, quantity FROM invoice_lines
                WHERE invoice_id = ? AND product_code = ? AND batch_number = ? AND expiry_date = ?
                LIMIT 1
            """, (invoice_id, prod_code, batch_val, expiry_val))
            existing_line = c.fetchone()

            if existing_line:
                line_id = existing_line["id"]
            else:
                c.execute("""
                    INSERT INTO invoice_lines (
                        invoice_id, invoice_number, product_code, product_name,
                        name_ar, name_en, batch_number, expiry_date, quantity,
                        sales_price, unit_price, tax_rate, unit
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
                """, (
                    invoice_id, invoice_number, prod_code, prod_name,
                    prod_name_ar, prod_name_en, batch_val, expiry_val,
                    s_price, u_price, tax_rate, unit
                ))
                line_id = c.lastrowid

            # إضافة السيريالات ومنع التكرار
            serials_to_add = []
            if serial_val:
                serials_to_add.append(serial_val)
            else:
                base_s = f"{prod_code}-{batch_val}"
                for i in range(qty):
                    serials_to_add.append(f"{base_s}-N{idx+1:03d}_{i+1:02d}")

            for s_num in serials_to_add:
                c.execute("SELECT id FROM scanned_serials WHERE invoice_id = ? AND serial_number = ?", (invoice_id, s_num))
                if c.fetchone():
                    continue

                c.execute("""
                    INSERT INTO scanned_serials (
                        invoice_id, invoice_number, line_id, product_code,
                        raw_code, raw_gtin_or_barcode, batch_number, serial_number,
                        expiry_date, unit, quantity, user_name, is_confirmed, is_returned
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 0)
                """, (
                    invoice_id, invoice_number, line_id, prod_code,
                    prod_code, gtin_val or prod_code, batch_val, s_num,
                    expiry_val, unit, user_name
                ))
                imported_count += 1

            c.execute("SELECT COUNT(*) FROM scanned_serials WHERE line_id = ? AND is_returned = 0", (line_id,))
            new_qty = c.fetchone()[0]
            c.execute("UPDATE invoice_lines SET quantity = ? WHERE id = ?", (new_qty, line_id))

        conn.commit()

        # تحديث إجماليات الفاتورة
        c.execute("SELECT COUNT(*), SUM(quantity), SUM(quantity * sales_price) FROM invoice_lines WHERE invoice_id = ?", (invoice_id,))
        tot_row = c.fetchone()
        tot_items = tot_row[0] or 0
        tot_pkgs = tot_row[1] or 0
        tot_amt = tot_row[2] or 0.0

        c.execute("""
            UPDATE invoices SET total_items = ?, total_packages = ?, total_amount = ?
            WHERE id = ?
        """, (tot_items, tot_pkgs, tot_amt, invoice_id))
        conn.commit()

    finally:
        conn.close()

    updated_inv = get_invoice_details(invoice_id)
    return {
        "success": True,
        "message": f"تم استيراد الفاتورة وتفريغ {imported_count} عبوة بنجاح مع ربط GTIN.",
        "imported_count": imported_count,
        "skipped_count": skipped_count,
        "invoice": updated_inv
    }
