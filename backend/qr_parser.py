import re
import calendar
from urllib.parse import urlparse, parse_qs
from typing import Dict, Any, Optional

def parse_expiry_date(val: Optional[str]) -> Optional[str]:
    """
    تحويل صيغة تاريخ الانتهاء إلى YYYY-MM-DD أو YYYY-MM
    يدعم:
    - الصيغ الرقمية المباشرة: 01012028 (DDMMYYYY) أو 20280101 (YYYYMMDD) أو 15102027
    - الصيغ المفصولة: 1-1-2028، 01/01/2028، 1.1.2028
    - سنوات ثنائية: 1-1-28، 010128
    - شهر وسنة: 10/27، 10-2027، 1027
    - صيغة GS1 القياسية (YYMMDD - 6 أرقام)
    """
    if not val:
        return None
    s = str(val).strip()
    s = re.sub(r'[\s./\\]+', '-', s).strip('-')
    if not s or s == '-':
        return None

    # إذا كان بالفعل بتنسيق YYYY-MM-DD أو YYYY-MM
    if re.match(r'^\d{4}-\d{2}-\d{2}$', s):
        return s
    if re.match(r'^\d{4}-\d{2}$', s):
        return s

    # D-M-YYYY أو DD-MM-YYYY (مثل 1-1-2028 أو 15-10-2027)
    m = re.match(r'^(\d{1,2})-(\d{1,2})-(\d{4})$', s)
    if m:
        d = int(m.group(1))
        mo = int(m.group(2))
        y = m.group(3)
        if mo > 12 and d <= 12:
            d, mo = mo, d
        return f"{y}-{mo:02d}-{d:02d}"

    # D-M-YY أو DD-MM-YY (مثل 1-1-28 أو 01-01-28)
    m = re.match(r'^(\d{1,2})-(\d{1,2})-(\d{2})$', s)
    if m:
        d = int(m.group(1))
        mo = int(m.group(2))
        y = "20" + m.group(3)
        if mo > 12 and d <= 12:
            d, mo = mo, d
        return f"{y}-{mo:02d}-{d:02d}"

    # MM-YYYY (مثل 10-2027 أو 01-2028)
    m = re.match(r'^(\d{1,2})-(\d{4})$', s)
    if m:
        return f"{m.group(2)}-{int(m.group(1)):02d}"

    # MM-YY (مثل 10-27 أو 01-28)
    m = re.match(r'^(\d{1,2})-(\d{2})$', s)
    if m:
        return f"20{m.group(2)}-{int(m.group(1)):02d}"

    digits = re.sub(r'\D', '', s)

    # صيغة 8 أرقام (01012028 DDMMYYYY أو 20280101 YYYYMMDD)
    if len(digits) == 8:
        if digits.startswith('20') and int(digits[4:6]) <= 12 and int(digits[6:8]) <= 31:
            return f"{digits[0:4]}-{digits[4:6]}-{digits[6:8]}"
        else:
            d = digits[0:2]
            mo = digits[2:4]
            y = digits[4:8]
            return f"{y}-{mo}-{d}"

    # صيغة 7 أرقام (مثل 1012028 -> 2028-01-01)
    if len(digits) == 7:
        d = '0' + digits[0:1]
        mo = digits[1:3]
        y = digits[3:7]
        if int(mo) <= 12:
            return f"{y}-{mo}-{d}"

    # صيغة GS1 القياسية (YYMMDD - 6 أرقام) أو 6 أرقام YYYYMM / MMYYYY / DDMMYY
    if len(digits) == 6:
        if digits.startswith('20'):
            y = digits[0:4]
            mo = digits[4:6]
            if 1 <= int(mo) <= 12:
                return f"{y}-{mo}"
        if digits.endswith(('2026', '2027', '2028', '2029', '2030')):
            mo = digits[0:2]
            y = digits[2:6]
            return f"{y}-{mo}"
        
        # GS1 YYMMDD
        yy = int(digits[0:2])
        mm = int(digits[2:4])
        dd = int(digits[4:6])
        year = 2000 + yy if yy < 70 else 1900 + yy
        if 1 <= mm <= 12:
            if dd == 0:
                _, last_day = calendar.monthrange(year, mm)
                dd = last_day
            else:
                _, max_day = calendar.monthrange(year, mm)
                if dd > max_day:
                    dd = max_day
            return f"{year:04d}-{mm:02d}-{dd:02d}"

    # صيغة 4 أرقام (MMYY أو YYMM)
    if len(digits) == 4:
        p1 = int(digits[0:2])
        p2 = int(digits[2:4])
        if 1 <= p1 <= 12 and 24 <= p2 <= 40:
            return f"20{digits[2:4]}-{digits[0:2]}"
        elif 24 <= p1 <= 40 and 1 <= p2 <= 12:
            return f"20{digits[0:2]}-{digits[2:4]}"

    return s

# خريطة تحويل ضغطات قارئ الباركود عند ضبط لغة لوحة المفاتيح في Windows على العربية (Arabic Keyboard Wedge)
ARABIC_KEYBOARD_MAP = {
    # أحرف وحركات الشفت (Arabic Shifted keys) -> الحروف الإنجليزية الكبيرة
    '\u064e': 'Q',  # َ (Fatha -> Shift+Q)
    '\u064b': 'W',  # ً (Tanween Fath -> Shift+W)
    '\u064f': 'E',  # ُ (Damma -> Shift+E)
    '\u064c': 'R',  # ٌ (Tanween Damm -> Shift+R)
    '\ufef7': 'T',  # لإ (Shift+T)
    '\u0625': 'Y',  # إ (Shift+Y)
    '\u2018': 'U',  # ‘ (Shift+U)
    '\u00f7': 'I',  # ÷ (Shift+I)
    '\u00d7': 'O',  # × (Shift+O)
    '\u061b': 'P',  # ؛ (Shift+P)
    '\u0650': 'A',  # ِ (Kasra -> Shift+A)
    '\u064d': 'S',  # ٍ (Tanween Kasr -> Shift+S)
    ']': 'D',       # ] (Shift+D)
    '[': 'F',       # [ (Shift+F)
    '\ufef5': 'G',  # لأ (Shift+G)
    '\u0623': 'H',  # أ (Shift+H)
    '\u0640': 'J',  # ـ (Tatweel -> Shift+J)
    '\u060c': 'K',  # ، (Arabic comma -> Shift+K)
    '/': 'L',       # / (Shift+L)
    '~': 'Z',       # ~ (Shift+Z)
    '\u0652': 'X',  # ْ (Sukun -> Shift+X)
    '}': 'C',       # } (Shift+C)
    '{': 'V',       # { (Shift+V)
    '\ufef9': 'B',  # لآ (Shift+B)
    '\u0622': 'N',  # آ (Shift+N)
    '\u2019': 'M',  # ’ (Shift+M)
    '\u061f': '?',  # ؟ (Shift+?)

    # الحروف العربية العادية (Arabic Unshifted keys) -> الحروف الإنجليزية
    '\u0636': 'q',  # ض
    '\u0635': 'w',  # ص
    '\u062b': 'e',  # ث
    '\u0642': 'r',  # ق
    '\u0641': 't',  # ف
    '\u063a': 'y',  # غ
    '\u0639': 'u',  # ع
    '\u0647': 'i',  # ه
    '\u062e': 'o',  # خ
    '\u062d': 'p',  # ح
    '\u062c': '[',  # ج
    '\u062f': ']',  # د
    '\u0634': 'a',  # ش
    '\u0633': 's',  # س
    '\u064a': 'd',  # ي
    '\u0628': 'f',  # ب
    '\u0644': 'g',  # ل
    '\u0627': 'h',  # ا
    '\u062a': 'j',  # ت
    '\u0646': 'k',  # ن
    '\u0645': 'l',  # م
    '\u0643': ';',  # ك
    '\u0637': "'",  # ط
    '\u0626': 'z',  # ئ
    '\u0621': 'x',  # ء
    '\u0624': 'c',  # ؤ
    '\u0631': 'v',  # ر
    '\ufefb': 'b',  # لا
    '\u0649': 'n',  # ى
    '\u0629': 'm',  # ة
    '\u0648': ',',  # و
    '\u0632': '.',  # ز
    '\u0638': '/',  # ظ
    '\u0630': '`',  # ذ

    # الأرقام العربية الهندية (Arabic-Indic & Eastern Digits)
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
    '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
}

def decode_arabic_keyboard_layout(text: str) -> str:
    """
    معالجة ذكية لأجهزة المسح الضوئي (Barcode Scanners):
    عندما يمسح المستخدم كود QR ولغة الإدخال في Windows مضبوطة على العربية (AR)،
    يقوم الماسح بإرسال الحروف اللاتينية فتترجمها Windows إلى حروف وحركات عربية أو أقواس معقوفة.
    تقوم هذه الدالة بإعادة تحويلها فورياً إلى حروفها الإنجليزية اللاتينية الأصلية.
    """
    if not text:
        return ""
    
    # 1. التحقق من احتواء النص على محارف عربية أو أرقام مشرقية
    has_arabic = bool(re.search(r'[\u0600-\u06ff\u0750-\u077f\ufb50-\ufc3f\ufe70-\ufefc]', text))
    
    # 2. فحص آثار الرموز الناتجة عن مفتاح Shift في الكيبورد العربي (مثل } لـ C و ] لـ D و ~ لـ Z و / لـ L)
    has_barcode_artifacts = bool(re.search(r'(?:^01|\(01\)|^\d{14})', text)) and bool(re.search(r'[}\]\[{~/]', text))
    
    # 3. فحص وجود أي محرف من خريطة التحويل
    has_any_mapped = any(ch in ARABIC_KEYBOARD_MAP and not ch.isascii() for ch in text) or ('}' in text or '~' in text or '{' in text)
    
    if not (has_arabic or has_barcode_artifacts or has_any_mapped):
        return text

    # معالجة التركيبات المزدوجة (Ligatures)
    s = text.replace('\u0644\u0625', 'T')
    s = s.replace('\u0644\u0623', 'G')
    s = s.replace('\u0644\u0622', 'B')
    s = s.replace('\u0644\u0627', 'B')

    out = []
    for ch in s:
        out.append(ARABIC_KEYBOARD_MAP.get(ch, ch))
    return ''.join(out)

def clean_alphanumeric(val: Optional[str]) -> str:
    """تنظيف السلسلة النصية مع الحفاظ على الأحرف والأرقام والعلامات الأساسية"""
    if val is None:
        return ""
    # إزالة محارف التحكم مثل GS
    return re.sub(r'[\x00-\x1f\x7f]', '', str(val)).strip()

def parse_qr_code(raw_input: str) -> Dict[str, Any]:
    """
    تحليل كود QR أو الباركود واستخراج:
    - GTIN (AI 01)
    - رقم الباتش / التشغيلة (AI 10)
    - السيريال (AI 21)
    - تاريخ الانتهاء (AI 17)
    
    يدعم المعايير التالية:
    1. معيار GS1 بالأقواس: (01)...(17)...(10)...(21)...
    2. معيار GS1 الخام بفواصل الفاصل الجماعي GS / 0x1D / <GS>
    3. معيار GS1 Digital Link (روابط الويب)
    4. الصيغ المفتاحية (Key-Value: GTIN:..., BATCH:..., SN:...)
    5. كائنات JSON المباشرة
    """
    if not raw_input or not str(raw_input).strip():
        return {
            "success": False,
            "error": "كود QR فارغ",
            "message": "كود QR فارغ ولا يحتوي على أي بيانات."
        }
        
    # تصحيح وتحويل ضغطات لوحة المفاتيح العربية تلقائياً إذا كُتب الكود بينما اللغة عربية
    raw = decode_arabic_keyboard_layout(str(raw_input).strip())
    
    # توحيد فواصل GS الشائعة إلى المحرف القياسي \x1d
    normalized = re.sub(r'<\s*GS\s*>', '\x1d', raw, flags=re.IGNORECASE)
    normalized = re.sub(r'\[\s*GS\s*\]', '\x1d', normalized, flags=re.IGNORECASE)
    normalized = re.sub(r'\{\s*GS\s*\}', '\x1d', normalized, flags=re.IGNORECASE)
    normalized = normalized.replace('^]', '\x1d')
    # إزالة بادئة أجهزة المسح الضوئي الخاصة بـ AIM Code مثل ]d2 أو ]Q3
    normalized = re.sub(r'^\][dqcQDC][0-9]', '', normalized)

    data = {
        "gtin": None,
        "batch": None,
        "serial": None,
        "raw_expiry": None,
        "expiry": None,
        "raw_prod_date": None,
        "prod_date": None,
        "raw": raw
    }

    # 1. فحص كائن JSON إن وجد
    if normalized.startswith('{') and normalized.endswith('}'):
        try:
            import json
            j = json.loads(normalized)
            for k, v in j.items():
                kl = str(k).lower().strip()
                val = str(v).strip()
                if kl in ('gtin', '01', 'barcode', 'item'):
                    data['gtin'] = val
                elif kl in ('batch', '10', 'lot', 'lot_number', 'batch_number'):
                    data['batch'] = val
                elif kl in ('serial', '21', 'sn', 'serial_number'):
                    data['serial'] = val
                elif kl in ('expiry', '17', 'exp', 'expiry_date', 'exp_date'):
                    data['raw_expiry'] = val
                elif kl in ('prod', 'mfg', '11', 'prod_date', 'mfg_date', 'production_date'):
                    data['raw_prod_date'] = val
            if data['gtin'] or data['batch'] or data['serial']:
                return _finalize(data)
        except:
            pass

    # 2. فحص صيغة الأقواس القياسية: (01)062810...(17)261031(10)BT456(21)SN789
    if '(' in normalized and ')' in normalized:
        matches = re.findall(r'\(([0-9]{2,4})\)([^()]+)', normalized)
        if matches:
            for ai, val in matches:
                v = clean_alphanumeric(val)
                if ai == '01':
                    data['gtin'] = v
                elif ai == '10':
                    data['batch'] = v
                elif ai == '21':
                    data['serial'] = v
                elif ai == '17':
                    data['raw_expiry'] = v
                elif ai == '11':
                    data['raw_prod_date'] = v
            if data['gtin'] or data['batch'] or data['serial']:
                return _finalize(data)

    # 3. فحص صيغة GS1 Digital Link (URL)
    if normalized.startswith('http://') or normalized.startswith('https://'):
        parsed_url = urlparse(normalized)
        parts = [p for p in parsed_url.path.split('/') if p]
        i = 0
        while i < len(parts) - 1:
            key = parts[i].strip()
            val = parts[i+1].strip()
            if key == '01':
                data['gtin'] = val
            elif key == '10':
                data['batch'] = val
            elif key == '21':
                data['serial'] = val
            elif key == '17':
                data['raw_expiry'] = val
            elif key == '11':
                data['raw_prod_date'] = val
            i += 2
        # معاملات الاستعلام في الرابط (Query Params)
        qs = parse_qs(parsed_url.query)
        for k, v in qs.items():
            val = v[0] if v else ''
            ks = k.strip()
            if ks == '01':
                data['gtin'] = val
            elif ks == '10':
                data['batch'] = val
            elif ks == '21':
                data['serial'] = val
            elif ks == '17':
                data['raw_expiry'] = val
            elif ks == '11':
                data['raw_prod_date'] = val
        if data['gtin'] or data['batch'] or data['serial']:
            return _finalize(data)

    # 4. فحص صيغ النصوص المباشرة أو المتعددة الأسطر (Key-Value)
    # مثل: GTIN: 0628..., BATCH: 123, EXP: 261031, SN: S001
    kv_patterns = [
        (r'(?:gtin|barcode|الباركود|كود الصنف|01)[\s:=]+([^\s,;\r\n]+)', 'gtin'),
        (r'(?:batch|lot|التشغيلة|الدفعة|الباتش|10)[\s:=]+([^\s,;\r\n]+)', 'batch'),
        (r'(?:serial|sn|السيريال|الرقم التسلسلي|21)[\s:=]+([^\s,;\r\n]+)', 'serial'),
        (r'(?:exp|expiry|صلاحية|تاريخ الانتهاء|الانتهاء|17)[\s:=]+([^\s,;\r\n]+)', 'raw_expiry'),
        (r'(?:mfg|prod|production|انتاج|تاريخ الانتاج|11)[\s:=]+([^\s,;\r\n]+)', 'raw_prod_date')
    ]
    matched_kv = False
    for pat, field in kv_patterns:
        m = re.search(pat, normalized, flags=re.IGNORECASE)
        if m:
            data[field] = clean_alphanumeric(m.group(1))
            matched_kv = True
    if matched_kv and (data['gtin'] or data['batch'] or data['serial']):
        return _finalize(data)

    # 4.ب فحص سلاسل GS1 المتسلسلة بدون فواصل (Concatenated Raw GS1 DataMatrix)
    # شائعة جداً في مسح كود داتا ماتريكس الطبي مثل: 010629110373043521lrn4u0449708qi1727041610c753
    # ومثل: 010628512800030710CF03711125070117280701212072049045215
    concatenated_patterns = [
        # --- أنماط تحتوي على تاريخ الإنتاج (11) وتاريخ الانتهاء (17) معاً ---
        # 01 + GTIN(14) + 10 + Batch + 11 + Prod(6) + 17 + Exp(6) + 21 + Serial (الباركود الدوائي المستخدم)
        (r'^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)11(\d{6})17(\d{6})21([a-zA-Z0-9_\-\.]+)$', 'gtin', 'batch', 'raw_prod_date', 'raw_expiry', 'serial'),
        # 01 + GTIN(14) + 10 + Batch + 17 + Exp(6) + 11 + Prod(6) + 21 + Serial
        (r'^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})11(\d{6})21([a-zA-Z0-9_\-\.]+)$', 'gtin', 'batch', 'raw_expiry', 'raw_prod_date', 'serial'),
        # 01 + GTIN(14) + 11 + Prod(6) + 17 + Exp(6) + 10 + Batch + 21 + Serial
        (r'^01(\d{14})11(\d{6})17(\d{6})10([a-zA-Z0-9_\-\.]{1,20}?)21([a-zA-Z0-9_\-\.]+)$', 'gtin', 'raw_prod_date', 'raw_expiry', 'batch', 'serial'),
        # 01 + GTIN(14) + 17 + Exp(6) + 11 + Prod(6) + 10 + Batch + 21 + Serial
        (r'^01(\d{14})17(\d{6})11(\d{6})10([a-zA-Z0-9_\-\.]{1,20}?)21([a-zA-Z0-9_\-\.]+)$', 'gtin', 'raw_expiry', 'raw_prod_date', 'batch', 'serial'),
        # 01 + GTIN(14) + 21 + Serial + 11 + Prod(6) + 17 + Exp(6) + 10 + Batch
        (r'^01(\d{14})21([a-zA-Z0-9_\-\.]{1,20}?)11(\d{6})17(\d{6})10([a-zA-Z0-9_\-\.]+)$', 'gtin', 'serial', 'raw_prod_date', 'raw_expiry', 'batch'),
        # 01 + GTIN(14) + 21 + Serial + 17 + Exp(6) + 11 + Prod(6) + 10 + Batch
        (r'^01(\d{14})21([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})11(\d{6})10([a-zA-Z0-9_\-\.]+)$', 'gtin', 'serial', 'raw_expiry', 'raw_prod_date', 'batch'),
        # 01 + GTIN(14) + 21 + Serial + 10 + Batch + 11 + Prod(6) + 17 + Exp(6)
        (r'^01(\d{14})21([a-zA-Z0-9_\-\.]{1,20}?)10([a-zA-Z0-9_\-\.]{1,20}?)11(\d{6})17(\d{6})$', 'gtin', 'serial', 'batch', 'raw_prod_date', 'raw_expiry'),
        # 01 + GTIN(14) + 21 + Serial + 10 + Batch + 17 + Exp(6) + 11 + Prod(6)
        (r'^01(\d{14})21([a-zA-Z0-9_\-\.]{1,20}?)10([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})11(\d{6})$', 'gtin', 'serial', 'batch', 'raw_expiry', 'raw_prod_date'),
        # 01 + GTIN(14) + 17 + Exp(6) + 11 + Prod(6) + 21 + Serial + 10 + Batch
        (r'^01(\d{14})17(\d{6})11(\d{6})21([a-zA-Z0-9_\-\.]{1,20}?)10([a-zA-Z0-9_\-\.]+)$', 'gtin', 'raw_expiry', 'raw_prod_date', 'serial', 'batch'),
        # 01 + GTIN(14) + 11 + Prod(6) + 17 + Exp(6) + 21 + Serial + 10 + Batch
        (r'^01(\d{14})11(\d{6})17(\d{6})21([a-zA-Z0-9_\-\.]{1,20}?)10([a-zA-Z0-9_\-\.]+)$', 'gtin', 'raw_prod_date', 'raw_expiry', 'serial', 'batch'),

        # --- أنماط مع تاريخ الإنتاج (11) وتاريخ الانتهاء (17) بدون سيريال ---
        # 01 + GTIN(14) + 10 + Batch + 11 + Prod(6) + 17 + Exp(6)
        (r'^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)11(\d{6})17(\d{6})$', 'gtin', 'batch', 'raw_prod_date', 'raw_expiry'),
        # 01 + GTIN(14) + 10 + Batch + 17 + Exp(6) + 11 + Prod(6)
        (r'^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})11(\d{6})$', 'gtin', 'batch', 'raw_expiry', 'raw_prod_date'),
        # 01 + GTIN(14) + 11 + Prod(6) + 17 + Exp(6) + 10 + Batch
        (r'^01(\d{14})11(\d{6})17(\d{6})10([a-zA-Z0-9_\-\.]+)$', 'gtin', 'raw_prod_date', 'raw_expiry', 'batch'),
        # 01 + GTIN(14) + 17 + Exp(6) + 11 + Prod(6) + 10 + Batch
        (r'^01(\d{14})17(\d{6})11(\d{6})10([a-zA-Z0-9_\-\.]+)$', 'gtin', 'raw_expiry', 'raw_prod_date', 'batch'),

        # --- أنماط مع تاريخ الإنتاج (11) فقط بدون 17 ---
        # 01 + GTIN(14) + 10 + Batch + 11 + Prod(6) + 21 + Serial
        (r'^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)11(\d{6})21([a-zA-Z0-9_\-\.]+)$', 'gtin', 'batch', 'raw_prod_date', 'serial'),
        # 01 + GTIN(14) + 11 + Prod(6) + 10 + Batch + 21 + Serial
        (r'^01(\d{14})11(\d{6})10([a-zA-Z0-9_\-\.]{1,20}?)21([a-zA-Z0-9_\-\.]+)$', 'gtin', 'raw_prod_date', 'batch', 'serial'),
        # 01 + GTIN(14) + 21 + Serial + 11 + Prod(6) + 10 + Batch
        (r'^01(\d{14})21([a-zA-Z0-9_\-\.]{1,20}?)11(\d{6})10([a-zA-Z0-9_\-\.]+)$', 'gtin', 'serial', 'raw_prod_date', 'batch'),
        # 01 + GTIN(14) + 10 + Batch + 11 + Prod(6)
        (r'^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)11(\d{6})$', 'gtin', 'batch', 'raw_prod_date'),
        # 01 + GTIN(14) + 11 + Prod(6) + 10 + Batch
        (r'^01(\d{14})11(\d{6})10([a-zA-Z0-9_\-\.]+)$', 'gtin', 'raw_prod_date', 'batch'),

        # --- أنماط مع تاريخ الانتهاء (17) والسيريال والباتش (الأنماط القياسية) ---
        # 01 + GTIN(14) + 21 + Serial + 17 + Exp(6) + 10 + Batch
        (r'^01(\d{14})21([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})10([a-zA-Z0-9_\-\.]+)$', 'gtin', 'serial', 'raw_expiry', 'batch'),
        # 01 + GTIN(14) + 17 + Exp(6) + 10 + Batch + 21 + Serial
        (r'^01(\d{14})17(\d{6})10([a-zA-Z0-9_\-\.]{1,20}?)21([a-zA-Z0-9_\-\.]+)$', 'gtin', 'raw_expiry', 'batch', 'serial'),
        # 01 + GTIN(14) + 17 + Exp(6) + 21 + Serial + 10 + Batch
        (r'^01(\d{14})17(\d{6})21([a-zA-Z0-9_\-\.]{1,20}?)10([a-zA-Z0-9_\-\.]+)$', 'gtin', 'raw_expiry', 'serial', 'batch'),
        # 01 + GTIN(14) + 10 + Batch + 17 + Exp(6) + 21 + Serial
        (r'^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})21([a-zA-Z0-9_\-\.]+)$', 'gtin', 'batch', 'raw_expiry', 'serial'),
        # 01 + GTIN(14) + 21 + Serial + 10 + Batch + 17 + Exp(6)
        (r'^01(\d{14})21([a-zA-Z0-9_\-\.]{1,20}?)10([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})$', 'gtin', 'serial', 'batch', 'raw_expiry'),
        # 01 + GTIN(14) + 17 + Exp(6) + 10 + Batch (بدون سيريال)
        (r'^01(\d{14})17(\d{6})10([a-zA-Z0-9_\-\.]+)$', 'gtin', 'raw_expiry', 'batch'),
        # 01 + GTIN(14) + 10 + Batch + 17 + Exp(6) (بدون سيريال)
        (r'^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})$', 'gtin', 'batch', 'raw_expiry'),
    ]

    for item in concatenated_patterns:
        pat = item[0]
        fields = item[1:]
        m = re.match(pat, normalized)
        if m:
            for idx_f, fld in enumerate(fields):
                if fld and idx_f < len(m.groups()):
                    data[fld] = m.group(idx_f + 1)
            return _finalize(data)

    # 5. معيار GS1 الخام غير المقوس باستخدام فواصل GS أو تقسيم متسلسل
    # AI 01: طول ثابت 14 رقماً
    # AI 17: طول ثابت 6 أرقام (YYMMDD)
    # AI 11: طول ثابت 6 أرقام (YYMMDD)
    # AI 10: طول متغير (ينتهي بـ \x1d أو نهاية السلسلة)
    # AI 21: طول متغير (ينتهي بـ \x1d أو نهاية السلسلة)
    tokens = normalized.split('\x1d')
    for token in tokens:
        idx = 0
        t_len = len(token)
        while idx < t_len:
            # التحقق من AI 01 (GTIN)
            if token[idx:idx+2] == '01' and t_len >= idx + 16 and token[idx+2:idx+16].isdigit():
                data['gtin'] = token[idx+2:idx+16]
                idx += 16
                continue
            # التحقق من AI 17 (Expiry)
            if token[idx:idx+2] == '17' and t_len >= idx + 8 and token[idx+2:idx+8].isdigit():
                data['raw_expiry'] = token[idx+2:idx+8]
                idx += 8
                continue
            # التحقق من AI 11 (Production Date)
            if token[idx:idx+2] == '11' and t_len >= idx + 8 and token[idx+2:idx+8].isdigit():
                data['raw_prod_date'] = token[idx+2:idx+8]
                idx += 8
                continue
            # التحقق من AI 10 (Batch) أو 21 (Serial)
            if token[idx:idx+2] in ('10', '21'):
                ai = token[idx:idx+2]
                rest = token[idx+2:]
                # إذا كانت السلسلة تحتوي على محددات واضحة بمسافات
                parts_space = rest.split(' ')
                val = parts_space[0]
                if ai == '10':
                    data['batch'] = clean_alphanumeric(val)
                else:
                    data['serial'] = clean_alphanumeric(val)
                idx = t_len # انتهى التوكن
                break
            idx += 1

    return _finalize(data)

def _finalize(data: Dict[str, Any]) -> Dict[str, Any]:
    """معالجة وتدقيق النتائج النهائية وفحص الحقول الإلزامية"""
    if data.get('gtin'):
        data['gtin'] = clean_alphanumeric(data['gtin'])
    if data.get('batch'):
        data['batch'] = clean_alphanumeric(data['batch'])
    if data.get('serial'):
        data['serial'] = clean_alphanumeric(data['serial'])
    if data.get('raw_expiry'):
        data['expiry'] = parse_expiry_date(data['raw_expiry'])
    if data.get('raw_prod_date'):
        data['prod_date'] = parse_expiry_date(data['raw_prod_date'])
        
    has_gtin = bool(data['gtin'])
    has_batch = bool(data['batch'])
    has_serial = bool(data['serial'])
    
    if not has_batch and not has_serial:
        return {
            "success": False,
            "code": "MISSING_BATCH_OR_SERIAL",
            "message": "كود QR لا يحتوي على رقم الباتش أو السيريال المطلوب.",
            "data": data
        }
        
    if not has_gtin:
        return {
            "success": False,
            "code": "MISSING_GTIN",
            "message": "كود QR لا يحتوي على كود الصنف أو GTIN للتعرف عليه.",
            "data": data
        }

    return {
        "success": True,
        "code": "OK",
        "message": "تمت قراءة كود QR بنجاح.",
        "data": data
    }

def extract_clean_gtin(raw_input: Optional[str]) -> str:
    """
    استخراج رقم بند التجارة العالمي (GTIN) النظيف تماماً من أي مسح QR أو DataMatrix أو باركود:
    - يفك تشفير ضغطات الكيبورد العربي تلقائياً
    - يستخرج معرف التطبيق GS1 (01) بطول 14 رقماً
    - يستخرج الـ GTIN من روابط GS1 Digital Link
    - يستخرج الـ GTIN من السلاسل المتسلسلة بدون فواصل
    - يدعم أكواد الباركود 13 رقماً و 12 رقماً مع ملء الأصفار في البداية لتصبح 14 رقماً
    - يعيد حصراً رقم بند التجارة العالمي فقط (GTIN)
    """
    if not raw_input:
        return ""
    
    s = str(raw_input).strip()
    # تحويل الأرقام العربية الشرقية إن وجدت
    ar_digits_map = str.maketrans('٠١٢٣٤٥٦٧٨٩', '0123456789')
    s = s.translate(ar_digits_map)
    
    # فك تشفير الكيبورد العربي إذا ضُغط الكود أثناء تفعيل اللغة العربية
    s = decode_arabic_keyboard_layout(s)

    # إزالة بادئات الماسح مثل ]d2 أو ]Q3
    s = re.sub(r'^\][dqcQDC][0-9]', '', s)
    s = re.sub(r'<\s*GS\s*>', '\x1d', s, flags=re.IGNORECASE)
    s = re.sub(r'\[\s*GS\s*\]', '\x1d', s, flags=re.IGNORECASE)
    s = re.sub(r'\{\s*GS\s*\}', '\x1d', s, flags=re.IGNORECASE)
    s = s.replace('^]', '\x1d')

    # 1. فحص صيغة الأقواس القياسية: (01)...
    m = re.search(r'\(01\)(\d{8,14})', s)
    if m:
        val = m.group(1)
        return val.zfill(14) if len(val) in (8, 12, 13) else val

    # 2. فحص روابط الويب GS1 Digital Link: /01/...
    m = re.search(r'/01/(\d{8,14})', s)
    if m:
        val = m.group(1)
        return val.zfill(14) if len(val) in (8, 12, 13) else val

    # 3. فحص كود GS1 المتسلسل المباشر: يبدأ بـ 01 ويليه 14 رقماً
    m = re.search(r'(?:^|[^\d])01(\d{14})', s)
    if m:
        return m.group(1)

    # 4. فحص صيغ Key-Value: GTIN: ...
    m = re.search(r'(?:gtin|barcode|01)[\s:=]+(\d{8,14})', s, flags=re.IGNORECASE)
    if m:
        val = m.group(1)
        return val.zfill(14) if len(val) in (8, 12, 13) else val

    # 5. إذا كانت أرقاماً مباشرة
    digits = re.sub(r'\D', '', s)
    if len(digits) == 14:
        return digits
    elif len(digits) in (8, 12, 13):
        return digits.zfill(14)
    elif len(digits) > 14 and digits.startswith('01'):
        return digits[2:16]

    # إذا لم يكن GTIN صالحاً، لا نعتبر أي نص عشوائي GTIN
    return ""

