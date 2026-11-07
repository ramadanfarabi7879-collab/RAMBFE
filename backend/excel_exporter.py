import os
import re
from datetime import datetime
from typing import List, Dict, Any, Optional
import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

from .qr_parser import ARABIC_KEYBOARD_MAP, parse_expiry_date

# خريطة تحويل الأرقام العربية الشرقية (٠-٩) إلى أرقام إنجليزية (0-9)
ARABIC_DIGITS_MAP = str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789')

# خريطة الترجمة الصوتية للحروف العربية عند غياب الاسم الإنجليزي في قاعدة البيانات
ARABIC_TO_LATIN_MAP = {
    'ا': 'A', 'أ': 'A', 'إ': 'E', 'آ': 'AA', 'ء': '', 'ؤ': 'O', 'ئ': 'Y',
    'ب': 'B', 'ت': 'T', 'ث': 'TH', 'ج': 'J', 'ح': 'H', 'خ': 'KH',
    'د': 'D', 'ذ': 'DH', 'ر': 'R', 'ز': 'Z', 'س': 'S', 'ش': 'SH',
    'ص': 'S', 'ض': 'D', 'ط': 'T', 'ظ': 'Z', 'ع': 'A', 'غ': 'GH',
    'ف': 'F', 'ق': 'Q', 'ك': 'K', 'ل': 'L', 'م': 'M', 'ن': 'N',
    'ه': 'H', 'و': 'W', 'ي': 'Y', 'ى': 'A', 'ة': 'H', 'ـ': ''
}

# قاموس ترجمة الأشكال الصيدلانية الشائعة إلى الإنجليزية
PHARMA_AR_TO_EN = {
    'اقراص': 'TABLETS', 'أقراص': 'TABLETS', 'قرص': 'TABLET',
    'كبسولات': 'CAPSULES', 'كبسول': 'CAPSULE',
    'شراب': 'SYRUP', 'معلق': 'SUSPENSION',
    'مرهم': 'OINTMENT', 'كريم': 'CREAM', 'جل': 'GEL',
    'قطرة': 'DROPS', 'بخاخ': 'SPRAY', 'محلول': 'SOLUTION',
    'حقن': 'INJECTION', 'امبول': 'AMPOULE', 'أمبول': 'AMPOULE',
    'فوار': 'EFFERVESCENT', 'مل': 'ML', 'مجم': 'MG', 'جم': 'GM',
    'علبة': 'PACK', 'شريط': 'STRIP', 'اطفال': 'KIDS', 'أطفال': 'KIDS',
    'كبار': 'ADULTS', 'سريع': 'RAPID', 'اكسترا': 'EXTRA', 'ادفانس': 'ADVANCE'
}

def to_english_text(text: str) -> str:
    """تحويل أي نص عربي متبقٍ إلى حروف إنجليزية نظيفة تماماً بدون أي أحرف عربية"""
    if not text:
        return ""
    text = str(text).translate(ARABIC_DIGITS_MAP).strip()
    if not re.search(r'[\u0600-\u06FF]', text):
        return text.strip().upper()
    words = text.split()
    res = []
    for w in words:
        clean_w = re.sub(r'[\u064B-\u065F\u0670]', '', w)
        if clean_w in PHARMA_AR_TO_EN:
            res.append(PHARMA_AR_TO_EN[clean_w])
        else:
            trans = ''.join(ARABIC_TO_LATIN_MAP.get(ch, ch) for ch in clean_w)
            res.append(trans.upper())
    result = ' '.join(res)
    # تصفية أي محارف غير لاتينية
    return re.sub(r'[\u0600-\u06FF]', '', result).strip().upper()

def resolve_english_name(item: Dict[str, Any]) -> str:
    """استخراج الاسم الإنجليزي الكامل للصنف وضمان خلوه 100% من الأحرف العربية"""
    name_en = str(item.get("matched_name_en") or item.get("name_en") or item.get("product_name_en") or "").strip()
    if name_en and not re.search(r'[\u0600-\u06FF]', name_en):
        return name_en.upper()

    code = str(item.get("product_code") or item.get("code") or item.get("matched_code") or "").strip()
    gtin = str(item.get("gtin") or item.get("raw_gtin_or_barcode") or item.get("barcode") or "").strip()

    if code or gtin:
        try:
            from .db import get_connection
            conn = get_connection()
            c = conn.cursor()
            row = None
            if code:
                c.execute("SELECT name_en FROM products WHERE code = ? LIMIT 1", (code,))
                row = c.fetchone()
            if (not row or not row["name_en"]) and gtin:
                c.execute("SELECT name_en FROM products WHERE gtin = ? OR barcode = ? LIMIT 1", (gtin, gtin))
                row = c.fetchone()
            conn.close()
            if row and row["name_en"] and str(row["name_en"]).strip():
                db_name_en = str(row["name_en"]).strip()
                if not re.search(r'[\u0600-\u06FF]', db_name_en):
                    return db_name_en.upper()
        except Exception:
            pass

    fallback_name = str(item.get("name_en") or item.get("product_name") or item.get("name") or item.get("name_ar") or "").strip()
    if fallback_name:
        return to_english_text(fallback_name)

    return f"PRODUCT {code}" if code else "ITEM"

def resolve_english_code(item: Dict[str, Any]) -> str:
    raw = str(item.get("product_code") or item.get("code") or item.get("matched_code") or "").strip()
    return raw.translate(ARABIC_DIGITS_MAP)

def resolve_english_batch(item: Dict[str, Any]) -> str:
    from .qr_parser import decode_arabic_keyboard_layout
    raw = str(item.get("batch_number") or item.get("batch") or "").strip()
    raw = raw.translate(ARABIC_DIGITS_MAP)
    raw = decode_arabic_keyboard_layout(raw)
    if any(ch in ARABIC_KEYBOARD_MAP for ch in raw):
        raw = ''.join(ARABIC_KEYBOARD_MAP.get(ch, ch) for ch in raw)
    return raw.upper()

def resolve_english_expiry(item: Dict[str, Any]) -> str:
    raw = str(item.get("expiry_date") or item.get("expiry") or "").strip()
    return raw.translate(ARABIC_DIGITS_MAP)

def resolve_english_float(val: Any) -> float:
    if val is None or val == "":
        return 0.0
    s = str(val).translate(ARABIC_DIGITS_MAP).replace(',', '').strip()
    try:
        return float(s)
    except:
        return 0.0

def resolve_english_int(val: Any) -> int:
    if val is None or val == "":
        return 0
    s = str(val).translate(ARABIC_DIGITS_MAP).replace(',', '').strip()
    try:
        return int(float(s))
    except:
        return 0

# الأعمدة المعتمدة والمطلوبة حصراً وبالترتيب المحدد من اليسار إلى اليمين:
# PRODUCT | NAME | SALES PRICE | BATCH NUMBER | QUANTITE | UNITPRICE | expiry-date
EXCEL_COLUMNS_7 = [
    "PRODUCT",
    "NAME",
    "SALES PRICE",
    "BATCH NUMBER",
    "QUANTITE",
    "UNITPRICE",
    "expiry-date"
]

EXCEL_COLUMNS = [
    "PRODUCT",
    "NAME ENGLIS",
    "SALES PRICE",
    "BATCH NUMBER",
    "Bonus Qty",
    "QUANTITE",
    "UNITPRICE",
    "Discount (%)",
    "Discount 2 (%)",
    "expiry-date"
]

def export_matched_items_to_excel(matched_items: List[Dict[str, Any]], output_path: str) -> str:
    """
    تصدير بنود الفاتورة المطابقة إلى ملف Excel بصيغة XLSX بالأعمدة العشرة المعتمدة حصراً:
    PRODUCT | NAME | SALES PRICE | BATCH NUMBER | Bonus Qty | QUANTITE | UNITPRICE | Discount (%) | Discount 2 (%) | expiry-date
    باللغة الإنجليزية بالكامل ومن اليسار إلى اليمين (LTR).
    """
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "INVOICE"

    # اتجاه الورقة بالإنجليزية من اليسار إلى اليمين (Left-to-Right)
    ws.sheet_view.rightToLeft = False
    ws.views.sheetView[0].rightToLeft = False
    ws.freeze_panes = 'A2'

    thin_border = Border(
        left=Side(style='thin', color='CBD5E1'),
        right=Side(style='thin', color='CBD5E1'),
        top=Side(style='thin', color='CBD5E1'),
        bottom=Side(style='thin', color='CBD5E1')
    )
    header_fill = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid")
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    header_align = Alignment(horizontal="center", vertical="center", wrap_text=True)

    data_font = Font(name="Calibri", size=10)
    data_font_bold = Font(name="Calibri", size=10, bold=True)
    align_center = Alignment(horizontal="center", vertical="center")
    align_left = Alignment(horizontal="left", vertical="center")
    align_right = Alignment(horizontal="right", vertical="center")
    zebra_fill = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")

    ws.append(EXCEL_COLUMNS)
    ws.row_dimensions[1].height = 28

    for col_idx in range(1, len(EXCEL_COLUMNS) + 1):
        cell = ws.cell(row=1, column=col_idx)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = header_align
        cell.border = thin_border

    for row_idx, item in enumerate(matched_items, start=2):
        ws.row_dimensions[row_idx].height = 22

        code = resolve_english_code(item)
        name_en = resolve_english_name(item)
        sales_price = resolve_english_float(item.get("selling_price") or item.get("sales_price"))
        batch = resolve_english_batch(item)
        bonus_val = resolve_english_int(item.get("bonus") or item.get("bonus_qty"))
        qty_val = resolve_english_int(item.get("quantity") or item.get("quantite"))
        unit_price = resolve_english_float(item.get("cost_price") or item.get("unit_price"))
        disc1 = resolve_english_float(item.get("discount_1") or item.get("discount"))
        disc2 = resolve_english_float(item.get("discount_2"))
        expiry = resolve_english_expiry(item)

        row_vals = [
            code,
            name_en,
            sales_price,
            batch,
            bonus_val,
            qty_val,
            unit_price,
            disc1,
            disc2,
            expiry
        ]
        ws.append(row_vals)

        is_even = (row_idx % 2 == 0)
        row_fill = zebra_fill if is_even else PatternFill(fill_type=None)

        for col_idx in range(1, len(EXCEL_COLUMNS) + 1):
            cell = ws.cell(row=row_idx, column=col_idx)
            cell.font = data_font
            cell.border = thin_border
            if row_fill.fill_type:
                cell.fill = row_fill

            col_name = EXCEL_COLUMNS[col_idx - 1]
            if col_name in ("SALES PRICE", "UNITPRICE", "Discount (%)", "Discount 2 (%)"):
                cell.number_format = '#,##0.00'
                cell.alignment = align_right
            elif col_name in ("QUANTITE", "Bonus Qty"):
                cell.number_format = '#,##0'
                cell.alignment = align_center
                cell.font = data_font_bold
            elif col_name in ("PRODUCT", "BATCH NUMBER", "expiry-date"):
                cell.alignment = align_center
            else:
                cell.alignment = align_left

    for col in ws.columns:
        col_letter = get_column_letter(col[0].column)
        max_len = 0
        for cell in col:
            val_str = str(cell.value or '')
            if len(val_str) > max_len:
                max_len = len(val_str)
        ws.column_dimensions[col_letter].width = max(max_len + 4, 14)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    try:
        wb.save(output_path)
    except (PermissionError, IOError):
        # في حال كان الملف مفتوحاً مسبقاً في برنامج Excel على Windows نقوم بإنشاء نسخة جديدة بختم زمني
        name, ext = os.path.splitext(output_path)
        ts = datetime.now().strftime("%H%M%S")
        output_path = f"{name}_{ts}{ext}"
        wb.save(output_path)
    return output_path

def _sanitize_ws_title(title: Optional[str], default: str = "INVOICE") -> str:
    if not title or not str(title).strip():
        return default
    clean = re.sub(r'[\\/*?:\[\]]', '_', str(title).strip())
    return clean[:31] or default

def export_invoice_to_excel(invoice_data: Dict[str, Any], output_path: str, use_10_columns: bool = False, sheet_title: Optional[str] = None) -> str:
    """
    تصدير الفاتورة المعتمدة إلى ملف Excel بصيغة XLSX بالأعمدة السبعة المعتمدة حصراً:
    PRODUCT | NAME | SALES PRICE | BATCH NUMBER | QUANTITE | UNITPRICE | expiry-date
    باللغة الإنجليزية بالكامل (رأس العمود والبيانات) ومن اليسار إلى اليمين (Left-to-Right).
    """
    lines = invoice_data.get("lines", [])

    if use_10_columns:
        return export_matched_items_to_excel(lines, output_path)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = _sanitize_ws_title(sheet_title, "INVOICE")

    # اتجاه الورقة بالإنجليزية من اليسار إلى اليمين (Left-to-Right)
    ws.sheet_view.rightToLeft = False
    ws.views.sheetView[0].rightToLeft = False
    ws.freeze_panes = 'A2'

    thin_border = Border(
        left=Side(style='thin', color='CBD5E1'),
        right=Side(style='thin', color='CBD5E1'),
        top=Side(style='thin', color='CBD5E1'),
        bottom=Side(style='thin', color='CBD5E1')
    )
    header_fill = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid")
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    header_align = Alignment(horizontal="center", vertical="center", wrap_text=True)

    data_font = Font(name="Calibri", size=10)
    data_font_bold = Font(name="Calibri", size=10, bold=True)
    align_center = Alignment(horizontal="center", vertical="center")
    align_left = Alignment(horizontal="left", vertical="center")
    align_right = Alignment(horizontal="right", vertical="center")
    zebra_fill = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")

    cols = EXCEL_COLUMNS_7
    ws.append(cols)
    ws.row_dimensions[1].height = 28

    for col_idx in range(1, len(cols) + 1):
        cell = ws.cell(row=1, column=col_idx)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = header_align
        cell.border = thin_border

    for row_idx, item in enumerate(lines, start=2):
        ws.row_dimensions[row_idx].height = 22

        product_code = resolve_english_code(item)
        name_en = resolve_english_name(item)
        sales_price = resolve_english_float(item.get("sales_price") or item.get("selling_price"))
        batch_number = resolve_english_batch(item)
        quantite = resolve_english_int(item.get("quantity") or item.get("quantite"))
        unit_price = resolve_english_float(item.get("unit_price") or item.get("cost_price"))
        expiry_date = resolve_english_expiry(item)

        row_values = [
            product_code,
            name_en,
            sales_price,
            batch_number,
            quantite,
            unit_price,
            expiry_date
        ]
        ws.append(row_values)

        is_even = (row_idx % 2 == 0)
        row_fill = zebra_fill if is_even else PatternFill(fill_type=None)

        for col_idx in range(1, len(cols) + 1):
            cell = ws.cell(row=row_idx, column=col_idx)
            cell.font = data_font
            cell.border = thin_border
            if row_fill.fill_type:
                cell.fill = row_fill

            col_name = cols[col_idx - 1]
            if col_name in ("SALES PRICE", "UNITPRICE"):
                cell.number_format = '#,##0.00'
                cell.alignment = align_right
            elif col_name == "QUANTITE":
                cell.number_format = '#,##0'
                cell.alignment = align_center
                cell.font = data_font_bold
            elif col_name in ("PRODUCT", "BATCH NUMBER", "expiry-date"):
                cell.alignment = align_center
            else:
                cell.alignment = align_left

    for col in ws.columns:
        col_letter = get_column_letter(col[0].column)
        max_len = 0
        for cell in col:
            val_str = str(cell.value or '')
            if len(val_str) > max_len:
                max_len = len(val_str)
        ws.column_dimensions[col_letter].width = max(max_len + 4, 14)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    try:
        wb.save(output_path)
    except (PermissionError, IOError):
        # في حال كان الملف مفتوحاً مسبقاً في برنامج Excel على Windows نقوم بإنشاء نسخة جديدة بختم زمني
        name, ext = os.path.splitext(output_path)
        ts = datetime.now().strftime("%H%M%S")
        output_path = f"{name}_{ts}{ext}"
        wb.save(output_path)
    return output_path


# الأعمدة الستة للنموذج الثاني (الجرد والكميات) بالترتيب والمسميات المطابقة تماماً للصورة:
# Product | NAME ENGLISH | Location | Lot/Serial Number | Expiry Date | Counted quantity
EXCEL_STOCK_COUNT_COLUMNS_6 = [
    "Product",
    "NAME ENGLISH",
    "Location",
    "Lot/Serial Number",
    "Expiry Date",
    "Counted quantity"
]

def export_invoice_stock_count_to_excel(invoice_data: Dict[str, Any], output_path: str, sheet_title: Optional[str] = None, location_value: Optional[str] = None) -> str:
    """
    تصدير أصناف الفاتورة إلى ملف Excel الثاني (نموذج الجرد والكميات) بالأعمدة الستة المعتمدة حصراً:
    Product | NAME ENGLISH | Location | Lot/Serial Number | Expiry Date | Counted quantity
    - Product: كود الصنف
    - NAME ENGLISH: الاسم الإنجليزي
    - Location: فارغ دائماً بناءً على طلب المستخدم (أو القيمة المختارة إذا حددها المستخدم)
    - Lot/Serial Number: رقم الباتش فقط (Batch Number)
    - Expiry Date: تاريخ انتهاء الصلاحية
    - Counted quantity: الكمية (نفس QUANTITE في الإكسيل الأول)
    """
    lines = invoice_data.get("lines", [])

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = _sanitize_ws_title(sheet_title, "STOCK_COUNT")

    # اتجاه الورقة بالإنجليزية من اليسار إلى اليمين (Left-to-Right)
    ws.sheet_view.rightToLeft = False
    ws.views.sheetView[0].rightToLeft = False
    ws.freeze_panes = 'A2'

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

    cols = EXCEL_STOCK_COUNT_COLUMNS_6
    ws.append(cols)
    ws.row_dimensions[1].height = 28

    for col_idx in range(1, len(cols) + 1):
        cell = ws.cell(row=1, column=col_idx)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = header_align
        cell.border = thin_border

    for row_idx, item in enumerate(lines, start=2):
        ws.row_dimensions[row_idx].height = 22

        product_code = resolve_english_code(item)
        name_en = resolve_english_name(item)
        location_val = str(location_value).strip() if location_value else ""  # Location تترك فارغة افتراضياً أو تملأ عند الطلب
        lot_serial_batch = resolve_english_batch(item)  # الباتش نمبر فقط بمسمى Lot/Serial Number
        expiry_date = resolve_english_expiry(item)
        counted_qty = resolve_english_int(item.get("quantity") or item.get("quantite"))

        row_values = [
            product_code,
            name_en,
            location_val,
            lot_serial_batch,
            expiry_date,
            counted_qty
        ]
        ws.append(row_values)

        is_even = (row_idx % 2 == 0)
        row_fill = zebra_fill if is_even else PatternFill(fill_type=None)

        for col_idx in range(1, len(cols) + 1):
            cell = ws.cell(row=row_idx, column=col_idx)
            cell.font = data_font
            cell.border = thin_border
            if row_fill.fill_type:
                cell.fill = row_fill

            col_name = cols[col_idx - 1]
            if col_name == "Counted quantity":
                cell.number_format = '#,##0'
                cell.alignment = align_center
                cell.font = data_font_bold
            elif col_name in ("Product", "Location", "Lot/Serial Number", "Expiry Date"):
                cell.alignment = align_center
            else:
                cell.alignment = align_left

    for col in ws.columns:
        col_letter = get_column_letter(col[0].column)
        max_len = 0
        for cell in col:
            val_str = str(cell.value or '')
            if len(val_str) > max_len:
                max_len = len(val_str)
        ws.column_dimensions[col_letter].width = max(max_len + 4, 16)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    try:
        wb.save(output_path)
    except (PermissionError, IOError):
        name, ext = os.path.splitext(output_path)
        ts = datetime.now().strftime("%H%M%S")
        output_path = f"{name}_{ts}{ext}"
        wb.save(output_path)
    return output_path


def export_invoice_custom_columns_to_excel(
    invoice_data: Dict[str, Any],
    output_path: str,
    column_specs: List[Dict[str, str]],
    sheet_title: Optional[str] = None,
    location_value: Optional[str] = None
) -> str:
    """
    تصدير أصناف الفاتورة إلى ملف Excel بناءً على اختيار المستخدم اليدوي لمسميات الأعمدة وترتيبها:
    كل عنصر في column_specs يتكون من:
    {"field": "product_code|name_en|location|sales_price|batch_number|quantity|unit_price|expiry_date", "header": "المسمى المختار"}
    """
    lines = invoice_data.get("lines", [])
    if not column_specs:
        return export_invoice_to_excel(invoice_data, output_path, sheet_title=sheet_title)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = _sanitize_ws_title(sheet_title, "INVOICE_EXPORT")

    ws.sheet_view.rightToLeft = False
    ws.views.sheetView[0].rightToLeft = False
    ws.freeze_panes = 'A2'

    thin_border = Border(
        left=Side(style='thin', color='CBD5E1'),
        right=Side(style='thin', color='CBD5E1'),
        top=Side(style='thin', color='CBD5E1'),
        bottom=Side(style='thin', color='CBD5E1')
    )
    header_fill = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid")
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    header_align = Alignment(horizontal="center", vertical="center", wrap_text=True)

    data_font = Font(name="Calibri", size=10)
    data_font_bold = Font(name="Calibri", size=10, bold=True)
    align_center = Alignment(horizontal="center", vertical="center")
    align_left = Alignment(horizontal="left", vertical="center")
    align_right = Alignment(horizontal="right", vertical="center")
    zebra_fill = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")

    headers = [spec.get("header") or spec.get("field") or "COLUMN" for spec in column_specs]
    ws.append(headers)
    ws.row_dimensions[1].height = 28

    for col_idx in range(1, len(headers) + 1):
        cell = ws.cell(row=1, column=col_idx)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = header_align
        cell.border = thin_border

    for row_idx, item in enumerate(lines, start=2):
        ws.row_dimensions[row_idx].height = 22

        field_values = {
            "product_code": resolve_english_code(item),
            "name_en": resolve_english_name(item),
            "location": str(location_value).strip() if location_value else str(item.get("location") or ""),
            "sales_price": resolve_english_float(item.get("sales_price") or item.get("selling_price")),
            "batch_number": resolve_english_batch(item),
            "quantity": resolve_english_int(item.get("quantity") or item.get("quantite")),
            "unit_price": resolve_english_float(item.get("unit_price") or item.get("cost_price")),
            "expiry_date": resolve_english_expiry(item),
        }

        row_values = [field_values.get(spec.get("field", ""), "") for spec in column_specs]
        ws.append(row_values)

        is_even = (row_idx % 2 == 0)
        row_fill = zebra_fill if is_even else PatternFill(fill_type=None)

        for col_idx, spec in enumerate(column_specs, start=1):
            cell = ws.cell(row=row_idx, column=col_idx)
            cell.font = data_font
            cell.border = thin_border
            if row_fill.fill_type:
                cell.fill = row_fill

            f_key = spec.get("field", "")
            if f_key in ("sales_price", "unit_price"):
                cell.number_format = '#,##0.00'
                cell.alignment = align_right
            elif f_key == "quantity":
                cell.number_format = '#,##0'
                cell.alignment = align_center
                cell.font = data_font_bold
            elif f_key in ("product_code", "location", "batch_number", "expiry_date"):
                cell.alignment = align_center
            else:
                cell.alignment = align_left

    for col in ws.columns:
        col_letter = get_column_letter(col[0].column)
        max_len = 0
        for cell in col:
            val_str = str(cell.value or '')
            if len(val_str) > max_len:
                max_len = len(val_str)
        ws.column_dimensions[col_letter].width = max(max_len + 4, 15)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    try:
        wb.save(output_path)
    except (PermissionError, IOError):
        name, ext = os.path.splitext(output_path)
        ts = datetime.now().strftime("%H%M%S")
        output_path = f"{name}_{ts}{ext}"
        wb.save(output_path)
    return output_path

AVAILABLE_CATALOG_FIELDS = {
    "code": {"header": "PRODUCT CODE", "width": 16, "align": "center", "format": "@", "bold": True},
    "name_en": {"header": "NAME ENGLIS", "width": 36, "align": "left", "format": None, "bold": False},
    "name_ar": {"header": "NAME ARABIC", "width": 32, "align": "left", "format": None, "bold": False},
    "scientific_name": {"header": "SCIENTIFIC NAME", "width": 28, "align": "left", "format": None, "bold": False},
    "category": {"header": "CATEGORY", "width": 16, "align": "left", "format": None, "bold": False},
    "company": {"header": "COMPANY", "width": 24, "align": "left", "format": None, "bold": False},
    "cost_price": {"header": "COST PRICE", "width": 14, "align": "right", "format": "#,##0.00", "bold": False},
    "selling_price": {"header": "SALES PRICE", "width": 14, "align": "right", "format": "#,##0.00", "bold": False},
    "wholesale_price": {"header": "WHOLESALE PRICE", "width": 16, "align": "right", "format": "#,##0.00", "bold": False},
    "tax_rate": {"header": "TAX RATE", "width": 12, "align": "right", "format": "0.00", "bold": False},
    "unit": {"header": "UNIT", "width": 12, "align": "left", "format": None, "bold": False},
    "unit_divisions": {"header": "UNIT DIVISIONS", "width": 20, "align": "left", "format": None, "bold": False},
    "barcode": {"header": "PRIMARY BARCODE", "width": 22, "align": "left", "format": "@", "bold": False},
    "extra_barcodes": {"header": "EXTRA BARCODES", "width": 26, "align": "left", "format": "@", "bold": False},
    "all_barcodes": {"header": "ALL BARCODES", "width": 30, "align": "left", "format": "@", "bold": False},
    "gtin": {"header": "PRIMARY GTIN", "width": 22, "align": "left", "format": "@", "bold": False},
    "extra_gtins": {"header": "EXTRA GTINS", "width": 26, "align": "left", "format": "@", "bold": False},
    "all_gtins": {"header": "ALL GTINS", "width": 30, "align": "left", "format": "@", "bold": False},
}

DEFAULT_CATALOG_EXPORT_FIELDS = [
    "code", "name_en", "name_ar", "selling_price", "cost_price",
    "tax_rate", "category", "unit", "barcode", "gtin"
]

def export_catalog_to_excel(
    output_path: str,
    product_codes: Optional[List[str]] = None,
    invoice_id: Optional[int] = None,
    selected_fields: Optional[List[str]] = None
) -> str:
    """
    تصدير كروت الأصناف إلى ملف Excel احترافي بصيغة XLSX
    مع دعم التحديد الكامل للخانات المراد تصديرها (Custom Fields Selection)
    ويدعم التحديد بالصنف (product_codes)، أو أصناف الفاتورة بالكامل (invoice_id)، أو كامل دليل الأصناف.
    اللغة الإنجليزية بالكامل ومن اليسار إلى اليمين (LTR).
    """
    from .db import get_connection, _attach_product_barcodes

    # تنظيف وتحديد الأعمدة المطلوبة
    fields_to_export = []
    if selected_fields:
        for f in selected_fields:
            fk = str(f).strip().lower()
            if fk in AVAILABLE_CATALOG_FIELDS and fk not in fields_to_export:
                fields_to_export.append(fk)
    if not fields_to_export:
        fields_to_export = list(DEFAULT_CATALOG_EXPORT_FIELDS)

    conn = get_connection()
    c = conn.cursor()

    clean_codes = [str(x).strip() for x in (product_codes or []) if str(x).strip()]
    if clean_codes:
        placeholders = ', '.join(['?'] * len(clean_codes))
        sql = f"""
            SELECT * FROM products
            WHERE code IN ({placeholders})
            ORDER BY CAST(code AS INTEGER) ASC, code ASC
        """
        c.execute(sql, clean_codes)
    elif invoice_id and int(invoice_id) > 0:
        sql = """
            SELECT DISTINCT p.* FROM products p
            INNER JOIN invoice_lines il ON p.code = il.product_code
            WHERE il.invoice_id = ?
            ORDER BY CAST(p.code AS INTEGER) ASC, p.code ASC
        """
        c.execute(sql, (int(invoice_id),))
    else:
        sql = """
            SELECT * FROM products
            ORDER BY CAST(code AS INTEGER) ASC, code ASC
        """
        c.execute(sql)

    raw_rows = [dict(r) for r in c.fetchall()]
    conn.close()

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "PRODUCTS_CATALOG"

    ws.sheet_view.rightToLeft = False
    ws.views.sheetView[0].rightToLeft = False
    ws.freeze_panes = 'A2'

    thin_border = Border(
        left=Side(style='thin', color='CBD5E1'),
        right=Side(style='thin', color='CBD5E1'),
        top=Side(style='thin', color='CBD5E1'),
        bottom=Side(style='thin', color='CBD5E1')
    )
    header_fill = PatternFill(start_color="1E3A8A", end_color="1E3A8A", fill_type="solid")
    header_font = Font(name="Calibri", size=11, bold=True, color="FFFFFF")
    header_align = Alignment(horizontal="center", vertical="center", wrap_text=True)

    data_font = Font(name="Calibri", size=10)
    data_font_bold = Font(name="Calibri", size=10, bold=True)
    align_center = Alignment(horizontal="center", vertical="center")
    align_left = Alignment(horizontal="left", vertical="center")
    align_right = Alignment(horizontal="right", vertical="center")
    zebra_fill = PatternFill(start_color="F8FAFC", end_color="F8FAFC", fill_type="solid")

    headers = [AVAILABLE_CATALOG_FIELDS[f]["header"] for f in fields_to_export]
    ws.append(headers)
    ws.row_dimensions[1].height = 28

    for col_idx in range(1, len(headers) + 1):
        cell = ws.cell(row=1, column=col_idx)
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = header_align
        cell.border = thin_border

    for row_idx, r in enumerate(raw_rows, start=2):
        ws.row_dimensions[row_idx].height = 20
        _attach_product_barcodes(r)

        barcode_list = r.get("barcode_list") or []
        gtin_list = r.get("gtin_list") or []

        primary_barcode = barcode_list[0] if barcode_list else (r.get("barcode") or "")
        extra_barcodes = ", ".join(barcode_list[1:]) if len(barcode_list) > 1 else ""
        all_barcodes = ", ".join(barcode_list) if barcode_list else (r.get("barcode") or "")

        primary_gtin = gtin_list[0] if gtin_list else (r.get("gtin") or "")
        extra_gtins = ", ".join(gtin_list[1:]) if len(gtin_list) > 1 else ""
        all_gtins = ", ".join(gtin_list) if gtin_list else (r.get("gtin") or "")

        field_value_map = {
            "code": str(r.get("code") or ""),
            "name_en": str(r.get("name_en") or r.get("name") or ""),
            "name_ar": str(r.get("name_ar") or ""),
            "scientific_name": str(r.get("scientific_name") or ""),
            "category": str(r.get("category") or "دواء"),
            "company": str(r.get("company") or ""),
            "cost_price": float(r.get("cost_price") or r.get("unit_price") or 0.0),
            "selling_price": float(r.get("selling_price") or 0.0),
            "wholesale_price": float(r.get("wholesale_price") or 0.0),
            "tax_rate": float(r.get("tax_rate") or 0.0),
            "unit": str(r.get("unit") or "علبة"),
            "unit_divisions": str(r.get("unit_divisions") or ""),
            "barcode": primary_barcode,
            "extra_barcodes": extra_barcodes,
            "all_barcodes": all_barcodes,
            "gtin": primary_gtin,
            "extra_gtins": extra_gtins,
            "all_gtins": all_gtins,
        }

        row_vals = [field_value_map.get(f, "") for f in fields_to_export]
        ws.append(row_vals)

        is_even = (row_idx % 2 == 0)
        row_fill = zebra_fill if is_even else PatternFill(fill_type=None)

        for col_idx, f_key in enumerate(fields_to_export, start=1):
            cell = ws.cell(row=row_idx, column=col_idx)
            cell.border = thin_border
            if row_fill.fill_type:
                cell.fill = row_fill

            f_meta = AVAILABLE_CATALOG_FIELDS[f_key]
            cell.font = data_font_bold if f_meta.get("bold") else data_font

            if f_meta.get("format"):
                cell.number_format = f_meta["format"]

            align_type = f_meta.get("align", "left")
            if align_type == "center":
                cell.alignment = align_center
            elif align_type == "right":
                cell.alignment = align_right
            else:
                cell.alignment = align_left

    for col_idx, f_key in enumerate(fields_to_export, start=1):
        col_letter = get_column_letter(col_idx)
        width = AVAILABLE_CATALOG_FIELDS[f_key]["width"]
        ws.column_dimensions[col_letter].width = width

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    try:
        wb.save(output_path)
    except (PermissionError, IOError):
        # في حال كان الملف مفتوحاً مسبقاً في برنامج Excel على Windows نقوم بإنشاء نسخة جديدة بختم زمني
        name, ext = os.path.splitext(output_path)
        ts = datetime.now().strftime("%H%M%S")
        output_path = f"{name}_{ts}{ext}"
        wb.save(output_path)
    return output_path
