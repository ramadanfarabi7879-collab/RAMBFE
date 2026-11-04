import re

TASHKEEL_REGEX = re.compile(r'[\u064B-\u065F\u0670\u06D6-\u06ED]')

def normalize_arabic(text: str) -> str:
    """تطبيع النصوص العربية"""
    if not text:
        return ""
    text = str(text).strip().lower()
    text = TASHKEEL_REGEX.sub('', text)
    text = text.replace('ـ', '')
    text = re.sub(r'[إأآاٱ]', 'ا', text)
    text = re.sub(r'[ىي]', 'ي', text)
    text = re.sub(r'ة\b', 'ه', text)
    text = re.sub(r'[ؤئ]', 'ء', text)
    text = re.sub(r'[^\w\s\d]', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def normalize_english(text: str) -> str:
    """تطبيع النصوص الإنجليزية ومعالجة أخطاء الـ OCR الشائعة"""
    if not text:
        return ""
    text = str(text).strip()
    
    # تصحيح أخطاء قراءة الحروف المتشابهة في أسماء الأدوية
    text = re.sub(r'([a-zA-Z]+)io\s*%', r'\1 10%', text, flags=re.IGNORECASE)
    text = re.sub(r'\bio\s*%', '10%', text, flags=re.IGNORECASE)
    text = re.sub(r'(\d+)\s*mu(\d+)', r'\1ml/\2', text, flags=re.IGNORECASE)
    text = re.sub(r'(\d+)\s*mu\b', r'\1ml', text, flags=re.IGNORECASE)
    text = re.sub(r'solutlon', 'solution', text, flags=re.IGNORECASE)
    text = re.sub(r'sachi\b', 'sachets', text, flags=re.IGNORECASE)
    
    text = text.lower()
    text = re.sub(r'[^a-z0-9\s]', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text

