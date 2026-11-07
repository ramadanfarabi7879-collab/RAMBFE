import os
import re
import pandas as pd
from typing import List, Dict, Any, Optional, Tuple
from .db import (
    get_connection, get_next_product_code, clean_barcode_preserve_zeros,
    split_barcodes, find_product_by_gtin_or_barcode, clean_numeric_code,
    save_or_update_product, log_audit_event, _attach_product_barcodes
)
from .normalizer import normalize_arabic, normalize_english
from .qr_parser import extract_clean_gtin

def read_spreadsheet_dataframe(file_path: str, nrows: Optional[int] = None) -> Tuple[pd.DataFrame, List[str], int]:
    """
    قراءة أي ملف جدول بيانات (XLSX, XLS, CSV) بدقة وسرعة مع الحفاظ التام على الأصفار في البداية (dtype=str)
    واكتشاف صف الترويسة الحقيقي تلقائياً حتى عند وجود ترويسات تقارير أو صفوف تعريفية في البداية.
    """
    ext = os.path.splitext(file_path)[1].lower()
    sheet_names = ["الورقة 1"]
    header_row_idx = 0

    if ext == '.csv':
        encodings = ['utf-8-sig', 'utf-8', 'cp1256', 'latin1']
        df = None
        for enc in encodings:
            try:
                df = pd.read_csv(file_path, dtype=str, nrows=nrows, sep=None, engine='python', encoding=enc)
                break
            except Exception:
                continue
        if df is None:
            df = pd.read_csv(file_path, dtype=str, nrows=nrows, encoding='utf-8', errors='ignore')
    else:
        xl = None
        try:
            try:
                xl = pd.ExcelFile(file_path)
                sheet_names = xl.sheet_names
                sheet_to_read = sheet_names[0] if sheet_names else 0
            except Exception:
                xl = None
                sheet_to_read = 0

            try:
                if xl is not None:
                    df_raw = pd.read_excel(xl, sheet_name=sheet_to_read, header=None, nrows=15, dtype=str)
                else:
                    df_raw = pd.read_excel(file_path, header=None, nrows=15, dtype=str)
            except Exception:
                df_raw = pd.DataFrame()

            best_header = 0
            max_score = -1
            keywords = [
                'name', 'item', 'product', 'code', 'barcode', 'gtin', 'price', 'qty', 'batch', 'serial',
                'cost', 'sale', 'sold', 'category', 'unit', 'tax', 'profit', 'vat',
                'اسم', 'صنف', 'منتج', 'كود', 'رمز', 'باركود', 'سعر', 'تكلفة', 'كمية', 'باتش', 'سيريال',
                'تصنيف', 'ضريبة', 'وحدة'
            ]

            if not df_raw.empty:
                for r_idx in range(min(15, len(df_raw))):
                    row_vals = [str(x).strip() for x in df_raw.iloc[r_idx] if pd.notna(x) and str(x).strip() != '' and str(x).strip().lower() != 'nan']
                    if len(row_vals) < 2:
                        continue
                    score = len(row_vals)
                    for val in row_vals:
                        v_low = val.lower()
                        if any(k in v_low for k in keywords):
                            score += 6
                    if score > max_score:
                        max_score = score
                        best_header = r_idx

            header_row_idx = best_header
            try:
                if xl is not None:
                    df = pd.read_excel(xl, sheet_name=sheet_to_read, header=header_row_idx, dtype=str, nrows=nrows)
                else:
                    df = pd.read_excel(file_path, header=header_row_idx, dtype=str, nrows=nrows)
            except Exception:
                df = pd.read_excel(file_path, dtype=str, nrows=nrows)
        finally:
            if xl is not None:
                try:
                    xl.close()
                except Exception:
                    pass

    # تنظيف أسماء الأعمدة واستبدال nan
    clean_cols = []
    for i, c in enumerate(df.columns):
        col_str = str(c).strip() if c is not None else ''
        if not col_str or col_str.lower().startswith('unnamed:') or col_str.lower() == 'nan':
            clean_cols.append(f"عمود_{i+1}")
        else:
            clean_cols.append(col_str)
    df.columns = clean_cols
    df.fillna('', inplace=True)
    return df, sheet_names, header_row_idx

def parse_tax_rate_cell(val: Any) -> Tuple[bool, float]:
    """
    تحليل وتفسير قيمة خانة الضريبة (مثل عمود CUSTOMER TAX أو غيره من ملفات Excel):
    - يرجع (is_specified, tax_rate_value)
    - إذا كانت القيمة VAT أو True أو خاضع للضريبة: (True, 15.0)
    - إذا كانت القيمة FALSE أو 0 أو لا أو غير خاضع: (True, 0.0)
    - إذا كانت قيمة رقمية (مثل 15 أو 14 أو 5 أو 0.15): (True, numeric_val)
    - إذا كانت الخانة فارغة أو NaN: (False, 0.0)
    """
    if val is None:
        return False, 0.0
    s = str(val).strip()
    if not s or s.lower() in ('nan', 'null', 'none', '<na>', ''):
        return False, 0.0
    s_low = s.lower()
    
    # 1. فحص عدم الخضوع للضريبة (FALSE)
    if s_low in ('false', 'f', '0', '0.0', '0%', 'no', 'off', 'غير خاضع', 'معفى', 'معفي', 'بدون', 'exempt'):
        return True, 0.0
        
    # 2. فحص الخضوع لضريبة القيمة المضافة (VAT / TRUE)
    if s_low in ('vat', 'true', 't', 'yes', 'on', 'خاضع', 'ضريبة', 'خاضع للضريبة', 'خاضع للقيمة المضافة', 'قيمة مضافة'):
        return True, 15.0
        
    # 3. فحص الأرقام الصريحة والنسب المئوية (مثل 15% أو 0.15 أو 14)
    m = re.search(r'(\d+(?:\.\d+)?)', s.replace(',', ''))
    if m:
        try:
            num = float(m.group(1))
            if 0.0 < num <= 1.0:
                return True, round(num * 100.0, 2)
            return True, round(num, 2)
        except Exception:
            pass
            
    # 4. إذا كانت تحتوي على كلمة vat أو tax أو ضريبة
    if 'vat' in s_low or 'tax' in s_low or 'ضريب' in s:
        return True, 15.0
        
    return False, 0.0

def suggest_columns_mapping(headers: List[str]) -> Dict[str, Any]:
    """
    نظام التعرف الذكي التلقائي على الأعمدة وفق أحدث معايير ملفات كرت الصنف والفواتير
    """
    def find_match(candidates: List[str]) -> str:
        for cand in candidates:
            c_low = cand.lower().strip()
            for h in headers:
                h_low = h.lower().strip()
                if h_low == c_low or c_low in h_low:
                    return h
        return ""

    code_col = find_match(['internal reference', 'item code', 'product code', 'كود الصنف', 'رمز الصنف', 'code', 'default_code', 'reference', 'sequence'])
    name_ar_col = find_match(['name (ar)', 'name_ar', 'name arabic', 'arabic', 'الاسم بالعربي', 'اسم عربي', 'اسم الصنف عربي', 'عربي'])
    name_en_col = find_match(['name (en)', 'name_en', 'name englis', 'name english', 'english', 'name', 'product_name', 'item name', 'اسم الصنف', 'اسم المنتج', 'description'])
    scientific_name_col = find_match(['scientific name', 'scientific_name', 'scientific', 'الاسم العلمي', 'المادة الفعالة'])
    company_col = find_match(['company', 'manufacturer', 'الشركة', 'المصنع', 'الشركة المصنعة'])
    category_col = find_match(['product category', 'category 2', 'category', 'تصنيف', 'التصنيف', 'النوع', 'القسم'])
    selling_price_col = find_match(['sales price', 'sale_price', 'selling_price', 'price', 'سعر البيع', 'سعر'])
    unit_price_col = find_match(['cost price', 'unit price', 'unit cost', 'purchase price', 'unit_price', 'unitprice', 'cost', 'سعر التكلفة', 'سعر الوحدة', 'التكلفة'])
    wholesale_price_col = find_match(['wholesale price', 'wholesale_price', 'wholesale', 'سعر الجملة', 'جملة'])
    tax_rate_col = find_match([
        'customer tax', 'customer_tax', 'customer taxes', 'customer_taxes',
        'customertax', 'customertaxes', 'tax customer',
        'tax rate', 'tax_rate', 'نسبة الضريبة', 'الضريبة', 'ضريبة',
        'vat', 'tax', 'taxes', 'خاضع للضريبة'
    ])
    unit_col = find_match(['unit', 'وحدة'])
    unit_divisions_col = find_match(['unit_divisions', 'divisions', 'معامل التحويل', 'تقسيم الوحدات'])

    barcode_cols = [
        h for h in headers
        if any(k in h.lower() for k in ['barcode', 'باركود', 'ean']) and not any(k in h.lower() for k in ['gtin', 'جي تي ان'])
    ]
    gtin_cols = [
        h for h in headers
        if any(k in h.lower() for k in ['gtin', 'جي تي ان'])
    ]

    return {
        "code_col": code_col,
        "name_ar_col": name_ar_col,
        "name_en_col": name_en_col,
        "scientific_name_col": scientific_name_col,
        "company_col": company_col,
        "category_col": category_col,
        "selling_price_col": selling_price_col,
        "unit_price_col": unit_price_col,
        "wholesale_price_col": wholesale_price_col,
        "tax_rate_col": tax_rate_col,
        "unit_col": unit_col,
        "unit_divisions_col": unit_divisions_col,
        "grouping_col": code_col or "",
        "barcode_cols": barcode_cols,
        "gtin_cols": gtin_cols
    }

def inspect_excel_catalog(file_path: str) -> Dict[str, Any]:
    """
    قراءة أسماء أعمدة ملف Excel أو CSV مع الاقتراح الذكي الفوري لربط الأعمدة
    """
    if not os.path.exists(file_path):
        return {"success": False, "message": "الملف غير موجود على الخادم."}

    try:
        df_full, sheet_names, header_row_idx = read_spreadsheet_dataframe(file_path)
        total_rows = len(df_full)
        headers = list(df_full.columns)

        sample_rows = []
        df_sample = df_full.head(5)
        for idx in range(len(df_sample)):
            row_dict = {}
            for h in headers:
                val = str(df_sample.iloc[idx].get(h, ''))
                row_dict[h] = val if val.lower() != 'nan' else ''
            sample_rows.append(row_dict)

        suggested = suggest_columns_mapping(headers)

        return {
            "success": True,
            "filename": os.path.basename(file_path),
            "file_path": file_path,
            "sheet_name": sheet_names[0] if sheet_names else "Sheet 1",
            "sheet_names": sheet_names,
            "headers": headers,
            "sample_rows": sample_rows,
            "total_rows": total_rows,
            "header_row_index": header_row_idx,
            "suggested_mapping": suggested
        }
    except Exception as e:
        return {"success": False, "message": f"حدث خطأ أثناء قراءة ملف الأصناف: {str(e)}"}

def parse_and_validate_import_data(
    file_path: str,
    mapping: Dict[str, Any]
) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]], List[Dict[str, Any]], int]:
    """
    تحليل ومعالجة وتدقيق بيانات الاستيراد بالاعتماد على التعيين اليدوي للمستخدم أو الاقتراح التلقائي
    مع المعالجة الفائقة في الذاكرة لمنع أي بطء أو تعليق عند استيراد آلاف الصفوف.
    """
    code_col = mapping.get("code_col") or mapping.get("code") or ""
    name_ar_col = mapping.get("name_ar_col") or mapping.get("name_ar") or ""
    name_en_col = mapping.get("name_en_col") or mapping.get("name_en") or ""
    scientific_name_col = mapping.get("scientific_name_col") or mapping.get("scientific_name") or ""
    company_col = mapping.get("company_col") or mapping.get("company") or ""
    category_col = mapping.get("category_col") or mapping.get("category") or ""
    selling_price_col = mapping.get("selling_price_col") or mapping.get("selling_price") or ""
    unit_price_col = mapping.get("unit_price_col") or mapping.get("unit_price") or ""
    wholesale_price_col = mapping.get("wholesale_price_col") or mapping.get("wholesale_price") or ""
    tax_rate_col = mapping.get("tax_rate_col") or mapping.get("tax_rate") or ""
    unit_col = mapping.get("unit_col") or mapping.get("unit") or ""
    unit_divisions_col = mapping.get("unit_divisions_col") or mapping.get("unit_divisions") or ""
    grouping_col = mapping.get("grouping_col") or mapping.get("grouping") or ""

    barcode_cols = mapping.get("barcode_cols") or mapping.get("barcode_columns") or []
    gtin_cols = mapping.get("gtin_cols") or mapping.get("gtin_columns") or []

    # تحديد الحقول الواردة فعلياً في الملف حتى لا يتم تعديل أي حقول أخرى
    mapped_fields = set()
    if code_col: mapped_fields.add("code")
    if name_ar_col: mapped_fields.add("name_ar")
    if name_en_col: mapped_fields.add("name_en")
    if scientific_name_col: mapped_fields.add("scientific_name")
    if company_col: mapped_fields.add("company")
    if category_col: mapped_fields.add("category")
    if selling_price_col: mapped_fields.add("selling_price")
    if unit_price_col: mapped_fields.add("unit_price"); mapped_fields.add("cost_price")
    if wholesale_price_col: mapped_fields.add("wholesale_price")
    if tax_rate_col: mapped_fields.add("tax_rate")
    if unit_col: mapped_fields.add("unit")
    if unit_divisions_col: mapped_fields.add("unit_divisions")
    if barcode_cols: mapped_fields.add("barcode")
    if gtin_cols: mapped_fields.add("gtin")

    try:
        df, _, header_row_idx = read_spreadsheet_dataframe(file_path)
    except Exception as e:
        return [], [{"row_number": 0, "reason": f"فشل فتح الملف: {str(e)}"}], [], 0

    total_rows = len(df)
    grouped_items: Dict[str, Dict[str, Any]] = {}
    items_list: List[Dict[str, Any]] = []
    skipped_rows: List[Dict[str, Any]] = []
    conflicts: List[Dict[str, Any]] = []
    file_barcode_owner: Dict[str, str] = {}

    def clean_cell(val):
        if val is None:
            return ""
        s = str(val).strip()
        return "" if s.lower() in ('nan', 'null', 'none') else s

    def to_float(val, default=0.0):
        try:
            s = clean_cell(val).replace(',', '')
            if not s:
                return default
            return float(s)
        except:
            return default

    # جلب جميع الباركودات والأصناف المسجلة مسبقاً في استعلام واحد وسريع جداً في الذاكرة
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT barcode, product_code FROM product_barcodes")
    db_barcodes = {row["barcode"]: row["product_code"] for row in cursor.fetchall()}
    cursor.execute("SELECT code, name FROM products")
    db_products = {row["code"]: row["name"] for row in cursor.fetchall()}
    conn.close()

    for row_idx, row in df.iterrows():
        excel_row_num = row_idx + header_row_idx + 2

        raw_code = clean_cell(row.get(code_col, '')) if code_col else ''
        clean_code = clean_numeric_code(raw_code) if raw_code else ''
        if not clean_code and raw_code:
            clean_code = re.sub(r'[^\w\.-]', '', raw_code)

        name_ar = clean_cell(row.get(name_ar_col, ''))
        name_en = clean_cell(row.get(name_en_col, ''))
        name = name_ar or name_en

        scientific_name = clean_cell(row.get(scientific_name_col, '')) if scientific_name_col else ''
        company = clean_cell(row.get(company_col, '')) if company_col else ''

        selling_price = to_float(row.get(selling_price_col, 0.0))
        unit_price = to_float(row.get(unit_price_col, 0.0))
        wholesale_price = to_float(row.get(wholesale_price_col, 0.0))
        
        # قراءة وتفسير الضريبة بذكاء (VAT / FALSE / نسبة مئوية)
        has_tax_val = False
        tax_rate = 0.0
        if tax_rate_col and tax_rate_col in row:
            has_tax_val, tax_rate = parse_tax_rate_cell(row.get(tax_rate_col))
        
        category = clean_cell(row.get(category_col, ''))
        unit = clean_cell(row.get(unit_col, 'علبة')) or 'علبة'
        unit_divisions = clean_cell(row.get(unit_divisions_col, ''))

        # استخراج الباركودات و GTINs مع حفظ الأصفار البادئة
        g_list = []
        b_list = []
        for b_col in barcode_cols:
            if b_col in row:
                raw_b = clean_cell(row[b_col])
                for b in split_barcodes(raw_b):
                    clean_b = clean_barcode_preserve_zeros(b)
                    if clean_b and clean_b.lower() not in ('false', 'true') and clean_b not in b_list:
                        b_list.append(clean_b)
                        # إذا كان الباركود كود داتا ماتريكس أو QR يحتوي على GTIN
                        cg = extract_clean_gtin(clean_b)
                        if cg and cg.lower() not in ('false', 'true') and cg not in g_list:
                            g_list.append(cg)

        # استخراج GTINs مع حفظ الأصفار البادئة (المعرف 01 القياسي)
        for g_col in gtin_cols:
            if g_col in row:
                raw_g = clean_cell(row[g_col])
                for g in split_barcodes(raw_g):
                    clean_g = extract_clean_gtin(g) or clean_barcode_preserve_zeros(g)
                    if clean_g and clean_g.lower() not in ('false', 'true') and clean_g not in g_list:
                        g_list.append(clean_g)

        # إذا لم يتم تعيين كود الصنف في الملف، نحاول مطابقته ذكياً مع صنف موجود عبر GTIN أو الباركود
        if not clean_code:
            for c_val in (g_list + b_list):
                if c_val in db_barcodes:
                    clean_code = db_barcodes[c_val]
                    break
        elif clean_code.isdigit() and clean_code not in db_products:
            # مطابقة ذكية في حال أزال الإكسيل الأصفار البادئة (مثل 94688 مقابل 0000094688)
            padded = clean_code.zfill(10)
            if padded in db_products:
                clean_code = padded
            else:
                stripped = clean_code.lstrip('0')
                if stripped in db_products:
                    clean_code = stripped

        # عمود التجميع الاختياري
        group_key = None
        if grouping_col and grouping_col in row:
            raw_group = clean_cell(row[grouping_col])
            if raw_group:
                group_key = raw_group
        elif clean_code:
            group_key = clean_code

        # تجميع صفوف الصنف الواحد
        if group_key and group_key in grouped_items:
            target = grouped_items[group_key]
            for b in b_list:
                if b not in target["barcode_list"]:
                    target["barcode_list"].append(b)
            for g in g_list:
                if g not in target["gtin_list"]:
                    target["gtin_list"].append(g)
            if not target["name_ar"] and name_ar:
                target["name_ar"] = name_ar
            if not target["name_en"] and name_en:
                target["name_en"] = name_en
            if not target["scientific_name"] and scientific_name:
                target["scientific_name"] = scientific_name
            if not target["company"] and company:
                target["company"] = company
            if target["selling_price"] == 0.0 and selling_price > 0.0:
                target["selling_price"] = selling_price
            if target["wholesale_price"] == 0.0 and wholesale_price > 0.0:
                target["wholesale_price"] = wholesale_price
            if target["unit_price"] == 0.0 and unit_price > 0.0:
                target["unit_price"] = unit_price
            if target.get("tax_rate", 0.0) == 0.0 and tax_rate > 0.0:
                target["tax_rate"] = tax_rate
                if "tax_rate" not in target.get("mapped_fields", []):
                    target.setdefault("mapped_fields", []).append("tax_rate")
            target["source_rows"].append(excel_row_num)
            continue

        if not name:
            if clean_code and clean_code in db_products:
                name = db_products[clean_code]
            else:
                skipped_rows.append({
                    "row_number": excel_row_num,
                    "reason": "اسم الصنف فارغ (لم يتم العثور على اسم عربي أو إنجليزي في هذا الصف)."
                })
                continue

        row_mapped = list(mapped_fields)
        if tax_rate_col and not has_tax_val and "tax_rate" in row_mapped:
            row_mapped.remove("tax_rate")

        is_item_update = bool(clean_code and (clean_code in db_products))
        item_obj = {
            "code": clean_code,
            "group_key": group_key or f"row_{excel_row_num}",
            "name_ar": name_ar,
            "name_en": name_en,
            "scientific_name": scientific_name,
            "company": company,
            "name": name,
            "category": category,
            "selling_price": selling_price,
            "wholesale_price": wholesale_price,
            "unit_price": unit_price,
            "tax_rate": tax_rate,
            "unit": unit,
            "unit_divisions": unit_divisions,
            "barcode_list": b_list,
            "gtin_list": g_list,
            "mapped_fields": row_mapped,
            "source_rows": [excel_row_num],
            "is_update": is_item_update,
            "status_label": "تحديث صنف موجود" if is_item_update else "إضافة صنف جديد"
        }
        if group_key:
            grouped_items[group_key] = item_obj
        items_list.append(item_obj)

    # فحص التعارضات بسرعة البرق داخل الذاكرة
    for item in items_list:
        item_label = item["name"]
        item_code = item["code"]
        all_codes = item["barcode_list"] + item["gtin_list"]

        for code_val in all_codes:
            if code_val in file_barcode_owner:
                prev_owner = file_barcode_owner[code_val]
                if prev_owner != item_label:
                    conflicts.append({
                        "barcode": code_val,
                        "conflict_type": "تعارض داخل الملف نفسه",
                        "item_name": item_label,
                        "details": f"الباركود/GTIN مسند لصنفين مختلفين داخل الملف: ({prev_owner}) و ({item_label})"
                    })
            else:
                file_barcode_owner[code_val] = item_label

            if code_val in db_barcodes:
                exist_pcode = db_barcodes[code_val]
                if not item_code or item_code != exist_pcode:
                    exist_name = db_products.get(exist_pcode, exist_pcode)
                    conflicts.append({
                        "barcode": code_val,
                        "conflict_type": "مسجل مسبقاً في قاعدة البيانات",
                        "item_name": item_label,
                        "existing_code": exist_pcode,
                        "existing_name": exist_name,
                        "details": f"الباركود/GTIN مسجل مسبقاً للصنف [{exist_pcode}] {exist_name}"
                    })

    return items_list, skipped_rows, conflicts, total_rows

def preview_import_catalog(
    file_path: str,
    mapping: Dict[str, Any],
    replace_barcodes: bool = False,
    max_preview: int = 50
) -> Dict[str, Any]:
    """معاينة استيراد وتحديث الأصناف مع كشف التعارض والصفوف المتخطاة والتقرير المقارن للتغييرات"""
    items_list, skipped_rows, conflicts, total_rows = parse_and_validate_import_data(file_path, mapping)

    conn = get_connection()
    c = conn.cursor()
    c.execute("SELECT * FROM products")
    db_prods = {r["code"]: dict(r) for r in c.fetchall()}
    c.execute("SELECT product_code, barcode, barcode_type FROM product_barcodes")
    barcodes_map = {}
    for r in c.fetchall():
        pcode = r["product_code"]
        if pcode not in barcodes_map:
            barcodes_map[pcode] = {"barcodes": [], "gtins": []}
        b = r["barcode"]
        if r["barcode_type"] == "gtin":
            if b not in barcodes_map[pcode]["gtins"]:
                barcodes_map[pcode]["gtins"].append(b)
        else:
            if b not in barcodes_map[pcode]["barcodes"]:
                barcodes_map[pcode]["barcodes"].append(b)
    conn.close()

    for pcode, p in db_prods.items():
        bdata = barcodes_map.get(pcode, {"barcodes": [], "gtins": []})
        p["barcode_list"] = list(bdata["barcodes"])
        p["gtin_list"] = list(bdata["gtins"])
        if p.get("barcode") and not p["barcode_list"]:
            p["barcode_list"] = split_barcodes(p["barcode"])
        if p.get("gtin") and not p["gtin_list"]:
            p["gtin_list"] = split_barcodes(p["gtin"])

    start_code = int(get_next_product_code())
    preview_items = []

    for idx, it in enumerate(items_list[:max_preview]):
        preview_copy = dict(it)
        assigned_code = it.get("code") or str(start_code + idx)
        preview_copy["system_code_preview"] = assigned_code
        is_upd = bool(it.get("code") and (it.get("code") in db_prods))
        preview_copy["is_update"] = is_upd
        preview_copy["status_label"] = "تحديث صنف موجود" if is_upd else "إضافة صنف جديد"

        # حساب تقرير التغييرات التفصيلي (Diff) إذا كان تحديثاً
        diff = {}
        if is_upd:
            existing = db_prods.get(it.get("code"))
            if existing:
                it_mapped = set(it.get("mapped_fields") or [])

                if "selling_price" in it_mapped and abs(float(existing.get("selling_price") or 0.0) - float(it.get("selling_price") or 0.0)) > 0.001:
                    diff["selling_price"] = {"label": "سعر البيع", "old": float(existing.get("selling_price") or 0.0), "new": float(it.get("selling_price") or 0.0)}

                if "wholesale_price" in it_mapped and abs(float(existing.get("wholesale_price") or 0.0) - float(it.get("wholesale_price") or 0.0)) > 0.001:
                    diff["wholesale_price"] = {"label": "سعر الجملة", "old": float(existing.get("wholesale_price") or 0.0), "new": float(it.get("wholesale_price") or 0.0)}

                if "cost_price" in it_mapped and abs(float(existing.get("cost_price") or existing.get("unit_price") or 0.0) - float(it.get("unit_price") or 0.0)) > 0.001:
                    diff["cost_price"] = {"label": "سعر التكلفة", "old": float(existing.get("cost_price") or 0.0), "new": float(it.get("unit_price") or 0.0)}

                if "tax_rate" in it_mapped and abs(float(existing.get("tax_rate") or 0.0) - float(it.get("tax_rate") or 0.0)) > 0.001:
                    old_t = float(existing.get("tax_rate") or 0.0)
                    new_t = float(it.get("tax_rate") or 0.0)
                    old_lbl = f"{old_t:.0f}% (VAT)" if old_t > 0 else "غير خاضع (0%)"
                    new_lbl = f"{new_t:.0f}% (VAT)" if new_t > 0 else "غير خاضع (0%)"
                    diff["tax_rate"] = {"label": "الضريبة", "old": old_lbl, "new": new_lbl}

                if "name_ar" in it_mapped and it.get("name_ar") and it.get("name_ar") != (existing.get("name_ar") or ""):
                    diff["name_ar"] = {"label": "الاسم بالعربي", "old": existing.get("name_ar") or "", "new": it.get("name_ar")}

                if "name_en" in it_mapped and it.get("name_en") and it.get("name_en") != (existing.get("name_en") or ""):
                    diff["name_en"] = {"label": "الاسم بالإنجليزي", "old": existing.get("name_en") or "", "new": it.get("name_en")}

                if "scientific_name" in it_mapped and it.get("scientific_name") and it.get("scientific_name") != (existing.get("scientific_name") or ""):
                    diff["scientific_name"] = {"label": "الاسم العلمي", "old": existing.get("scientific_name") or "", "new": it.get("scientific_name")}

                if "company" in it_mapped and it.get("company") and it.get("company") != (existing.get("company") or ""):
                    diff["company"] = {"label": "الشركة", "old": existing.get("company") or "", "new": it.get("company")}

                # مقارنة الباركودات
                exist_b = existing.get("barcode_list") or []
                new_b = it.get("barcode_list") or []
                added_b = [b for b in new_b if b not in exist_b]
                if replace_barcodes:
                    rem_b = [b for b in exist_b if b not in new_b]
                    if added_b or rem_b:
                        diff["barcodes"] = {"label": "الباركودات (وضع الاستبدال)", "added": added_b, "removed": rem_b}
                else:
                    if added_b:
                        diff["barcodes"] = {"label": "الباركودات (إضافة)", "added": added_b}

                # مقارنة GTINs
                exist_g = existing.get("gtin_list") or []
                new_g = it.get("gtin_list") or []
                added_g = [g for g in new_g if g not in exist_g]
                if replace_barcodes:
                    rem_g = [g for g in exist_g if g not in new_g]
                    if added_g or rem_g:
                        diff["gtins"] = {"label": "GTIN (وضع الاستبدال)", "added": added_g, "removed": rem_g}
                else:
                    if added_g:
                        diff["gtins"] = {"label": "GTIN (إضافة)", "added": added_g}

        preview_copy["diff"] = diff
        preview_copy["changed_fields_count"] = len(diff)
        preview_items.append(preview_copy)

    total_updates = sum(1 for it in items_list if it.get("code") and it.get("code") in db_prods)
    total_new = len(items_list) - total_updates

    return {
        "success": True,
        "total_file_rows": total_rows,
        "valid_products_count": len(items_list),
        "valid_count": len(items_list),
        "updates_count": total_updates,
        "new_count": total_new,
        "conflicts_count": len(conflicts),
        "skipped_count": len(skipped_rows),
        "replace_barcodes": replace_barcodes,
        "preview_items": preview_items,
        "conflicts": conflicts[:100],
        "skipped_rows": skipped_rows[:100]
    }

def commit_import_catalog(
    file_path: str,
    mapping: Dict[str, Any],
    replace_barcodes: bool = False
) -> Dict[str, Any]:
    """
    اعتماد وحفظ بطاقات الأصناف في قاعدة البيانات:
    - يعتمد على الكود الداخلي لتحديد الصنف، ولا ينشئ صنفاً جديداً إذا كان الكود موجوداً.
    - يُحدّث فقط الحقول الواردة في ملف Excel، والحقول غير الموجودة في الملف لا تتغير نهائياً.
    - يضيف الباركود و GTIN الجديد دون حذف البيانات القديمة (الوضع الافتراضي) أو يستبدلها عند اختيار وضع الاستبدال الصريح.
    - يوثق العملية في سجل المراجعة (Audit Log).
    """
    items_list, skipped_rows, conflicts, total_rows = parse_and_validate_import_data(file_path, mapping)

    if not items_list:
        return {
            "success": False,
            "message": "لا توجد أصناف صالحة للاستيراد في الملف.",
            "skipped_rows": skipped_rows
        }

    conn = get_connection()
    cursor = conn.cursor()

    # جلب جميع الأصناف الحالية مع باركوداتها دفعة واحدة بسرعة فائقة
    cursor.execute("SELECT * FROM products")
    db_prods = {r["code"]: dict(r) for r in cursor.fetchall()}
    cursor.execute("SELECT product_code, barcode, barcode_type FROM product_barcodes")
    barcodes_map = {}
    for r in cursor.fetchall():
        pcode = r["product_code"]
        if pcode not in barcodes_map:
            barcodes_map[pcode] = {"barcodes": [], "gtins": []}
        b = r["barcode"]
        if r["barcode_type"] == "gtin":
            if b not in barcodes_map[pcode]["gtins"]:
                barcodes_map[pcode]["gtins"].append(b)
        else:
            if b not in barcodes_map[pcode]["barcodes"]:
                barcodes_map[pcode]["barcodes"].append(b)

    for pcode, p in db_prods.items():
        bdata = barcodes_map.get(pcode, {"barcodes": [], "gtins": []})
        p["barcode_list"] = list(bdata["barcodes"])
        p["gtin_list"] = list(bdata["gtins"])
        if p.get("barcode") and not p["barcode_list"]:
            p["barcode_list"] = split_barcodes(p["barcode"])
        if p.get("gtin") and not p["gtin_list"]:
            p["gtin_list"] = split_barcodes(p["gtin"])

    # جلب أعلى كود موجود حالياً
    cursor.execute("""
        SELECT MAX(CAST(code AS INTEGER)) FROM products 
        WHERE code GLOB '[0-9]*' AND length(code) <= 10
    """)
    row = cursor.fetchone()
    current_max = row[0] if row and row[0] is not None else 10000
    if current_max < 10000:
        current_max = 10000

    existing_codes = set(db_prods.keys())

    imported_count = 0
    updated_count = 0
    new_count = 0
    barcodes_registered_count = 0

    cursor.execute("BEGIN TRANSACTION;")
    try:
        for it in items_list:
            item_code = it.get("code")
            is_update = bool(item_code and (item_code in existing_codes))
            mapped = set(it.get("mapped_fields") or [])

            if is_update:
                # 1. تحديث صنف موجود: نعدل فقط الحقول المحددة في الملف!
                existing_item = db_prods[item_code]
                update_clauses = []
                update_params = []

                if "name_ar" in mapped and it.get("name_ar"):
                    update_clauses.extend(["name_ar = ?", "normalized_name_ar = ?"])
                    update_params.extend([it["name_ar"], normalize_arabic(it["name_ar"])])

                if "name_en" in mapped and it.get("name_en"):
                    update_clauses.extend(["name_en = ?", "normalized_name_en = ?"])
                    update_params.extend([it["name_en"], normalize_english(it["name_en"])])

                if ("name_ar" in mapped or "name_en" in mapped) and it.get("name"):
                    update_clauses.extend(["name = ?", "normalized_name = ?"])
                    update_params.extend([it["name"], normalize_arabic(it["name"])])

                if "scientific_name" in mapped and it.get("scientific_name"):
                    update_clauses.append("scientific_name = ?")
                    update_params.append(it["scientific_name"])

                if "company" in mapped and it.get("company"):
                    update_clauses.append("company = ?")
                    update_params.append(it["company"])

                if "category" in mapped and it.get("category"):
                    update_clauses.append("category = ?")
                    update_params.append(it["category"])

                if "selling_price" in mapped and it.get("selling_price") is not None:
                    update_clauses.append("selling_price = ?")
                    update_params.append(float(it["selling_price"]))

                if "wholesale_price" in mapped and it.get("wholesale_price") is not None:
                    update_clauses.append("wholesale_price = ?")
                    update_params.append(float(it["wholesale_price"]))

                if "cost_price" in mapped or "unit_price" in mapped:
                    cost_val = float(it.get("unit_price") or 0.0)
                    update_clauses.extend(["cost_price = ?", "unit_price = ?"])
                    update_params.extend([cost_val, cost_val])

                if "tax_rate" in mapped and it.get("tax_rate") is not None:
                    update_clauses.append("tax_rate = ?")
                    update_params.append(float(it["tax_rate"]))

                if "unit" in mapped and it.get("unit"):
                    update_clauses.append("unit = ?")
                    update_params.append(it["unit"])

                if "unit_divisions" in mapped and it.get("unit_divisions"):
                    update_clauses.append("unit_divisions = ?")
                    update_params.append(it["unit_divisions"])

                # معالجة الباركودات و GTINs
                if replace_barcodes:
                    # وضع الاستبدال الصريح: استبدال قائمة الباركودات و GTINs الحالية
                    if "barcode" in mapped and it.get("barcode_list"):
                        cursor.execute("DELETE FROM product_barcodes WHERE product_code = ? AND barcode_type = 'barcode'", (item_code,))
                        update_clauses.append("barcode = ?")
                        update_params.append(", ".join(it["barcode_list"]))
                        for b in it["barcode_list"]:
                            cursor.execute("INSERT OR IGNORE INTO product_barcodes (product_code, barcode, barcode_type) VALUES (?, ?, 'barcode')", (item_code, b))
                            barcodes_registered_count += 1

                    if "gtin" in mapped and it.get("gtin_list"):
                        cursor.execute("DELETE FROM product_barcodes WHERE product_code = ? AND barcode_type = 'gtin'", (item_code,))
                        update_clauses.append("gtin = ?")
                        update_params.append(", ".join(it["gtin_list"]))
                        for g in it["gtin_list"]:
                            cursor.execute("INSERT OR IGNORE INTO product_barcodes (product_code, barcode, barcode_type) VALUES (?, ?, 'gtin')", (item_code, g))
                            barcodes_registered_count += 1
                else:
                    # الوضع الافتراضي التراكمي: إضافة الجديد دون حذف القديم
                    if "barcode" in mapped and it.get("barcode_list"):
                        existing_b = existing_item.get("barcode_list") or []
                        merged_b = list(existing_b)
                        for b in it["barcode_list"]:
                            if b not in merged_b:
                                merged_b.append(b)
                            cursor.execute("INSERT OR IGNORE INTO product_barcodes (product_code, barcode, barcode_type) VALUES (?, ?, 'barcode')", (item_code, b))
                            barcodes_registered_count += 1
                        update_clauses.append("barcode = ?")
                        update_params.append(", ".join(merged_b))

                    if "gtin" in mapped and it.get("gtin_list"):
                        existing_g = existing_item.get("gtin_list") or []
                        merged_g = list(existing_g)
                        for g in it["gtin_list"]:
                            if g not in merged_g:
                                merged_g.append(g)
                            cursor.execute("INSERT OR IGNORE INTO product_barcodes (product_code, barcode, barcode_type) VALUES (?, ?, 'gtin')", (item_code, g))
                            barcodes_registered_count += 1
                        update_clauses.append("gtin = ?")
                        update_params.append(", ".join(merged_g))

                if update_clauses:
                    update_clauses.append("updated_at = CURRENT_TIMESTAMP")
                    sql = f"UPDATE products SET {', '.join(update_clauses)} WHERE code = ?"
                    update_params.append(item_code)
                    cursor.execute(sql, tuple(update_params))

                updated_count += 1

            else:
                # 2. إضافة صنف جديد بالكامل
                if not item_code:
                    current_max += 1
                    while str(current_max) in existing_codes:
                        current_max += 1
                    item_code = str(current_max)
                    existing_codes.add(item_code)

                gtin_str = ", ".join(it["gtin_list"]) if it["gtin_list"] else ""
                bcode_str = ", ".join(it["barcode_list"]) if it["barcode_list"] else ""

                norm_name = normalize_arabic(it["name"])
                norm_ar = normalize_arabic(it["name_ar"])
                norm_en = normalize_english(it["name_en"])

                cursor.execute("""
                    INSERT INTO products (
                        code, gtin, barcode, name_ar, name_en, name, scientific_name, company,
                        normalized_name_ar, normalized_name_en, normalized_name,
                        selling_price, wholesale_price, cost_price, unit_price, tax_rate, unit, unit_divisions, category,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                """, (
                    item_code, gtin_str, bcode_str, it["name_ar"], it["name_en"], it["name"], it["scientific_name"], it["company"],
                    norm_ar, norm_en, norm_name,
                    it["selling_price"], it["wholesale_price"], it["unit_price"], it["unit_price"], it["tax_rate"], it["unit"], it["unit_divisions"], it["category"]
                ))

                for b in it["barcode_list"]:
                    cursor.execute("INSERT OR IGNORE INTO product_barcodes (product_code, barcode, barcode_type) VALUES (?, ?, 'barcode')", (item_code, b))
                    barcodes_registered_count += 1
                for g in it["gtin_list"]:
                    cursor.execute("INSERT OR IGNORE INTO product_barcodes (product_code, barcode, barcode_type) VALUES (?, ?, 'gtin')", (item_code, g))
                    barcodes_registered_count += 1

                new_count += 1

            imported_count += 1

        conn.commit()
    except Exception as e:
        conn.rollback()
        conn.close()
        return {
            "success": False,
            "message": f"فشل الحفظ المجمع في قاعدة البيانات: {str(e)}"
        }

    conn.close()

    # تسجيل العملية في سجل المراجعة (Audit Log)
    log_audit_event(
        entity_type="catalog_import",
        entity_id=os.path.basename(file_path),
        action="excel_update" if updated_count > 0 else "excel_import",
        old_values=None,
        new_values={"updated_count": updated_count, "new_count": new_count, "replace_barcodes": replace_barcodes},
        details=f"تحديث {updated_count} صنف وإضافة {new_count} صنف جديد عبر Excel (وضع الباركود: {'استبدال' if replace_barcodes else 'تراكمي'})"
    )

    message = f"تمت معالجة {imported_count} صنف بنجاح (تحديث {updated_count} صنف موجود، وإضافة {new_count} صنف جديد)."
    return {
        "success": True,
        "message": message,
        "imported_count": imported_count,
        "updated_count": updated_count,
        "new_count": new_count,
        "total_file_rows": total_rows,
        "barcodes_registered_count": barcodes_registered_count,
        "replace_barcodes": replace_barcodes,
        "skipped_count": len(skipped_rows),
        "skipped_rows": skipped_rows[:100]
    }
