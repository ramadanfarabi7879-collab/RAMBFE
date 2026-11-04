import sys, json, os, subprocess, re

ocr_script = os.path.join('backend', 'ocr_runner.ps1')

def get_ocr(path, rot):
    cmd = ['powershell', '-ExecutionPolicy', 'Bypass', '-File', ocr_script, '-InputPath', path, '-Rotation', str(rot)]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
    return json.loads(proc.stdout)

STANDARD_KEYWORDS = ['invoice', 'vat', 'tax', 'date', 'total', 'customer', 'item', 'فاتورة', 'ضريبة', 'تاريخ', 'المجموع', 'العميل', 'الصنف', 'الكمية', 'سعر', 'net', 'exp', 'price', 'disc', 'batch']

def count_keywords(blocks):
    full = " ".join(l.get('text', '') for l in blocks).lower()
    return sum(1 for kw in STANDARD_KEYWORDS if kw in full)

for label, p in [('Inv 4', 'tests/samples/inv4_arkan_rotated.pdf'), ('Inv 5', 'tests/samples/inv5_mansour_rabia.pdf')]:
    b0 = get_ocr(p, 0)
    c0 = count_keywords(b0)
    print(f"{label} at rot 0 keyword count: {c0}")
    if c0 < 4:
        b180 = get_ocr(p, 180)
        c180 = count_keywords(b180)
        print(f"{label} at rot 180 keyword count: {c180}")
