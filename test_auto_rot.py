import sys, json, os, subprocess, re, numpy as np
sys.stdout.reconfigure(encoding='utf-8')

ocr_script = os.path.join('backend', 'ocr_runner.ps1')

def run_ocr(path, rot):
    cmd = ['powershell', '-ExecutionPolicy', 'Bypass', '-File', ocr_script, '-InputPath', path, '-Rotation', str(rot)]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
    return json.loads(proc.stdout)

STANDARD_KEYWORDS = ['invoice', 'vat', 'tax', 'date', 'total', 'customer', 'item', 'فاتورة', 'ضريبة', 'تاريخ', 'المجموع', 'العميل', 'الصنف', 'الكمية', 'سعر', 'net', 'exp', 'price', 'disc', 'batch']

def count_keywords(blocks):
    full = " ".join(l.get('text', '') for l in blocks).lower()
    return sum(1 for kw in STANDARD_KEYWORDS if kw in full)

# Test on all 5 invoices
samples = [
    ('Inv 1 (14 items)', 'tests/samples/inv1_14items.pdf'),
    ('Inv 2 (5 items)', 'tests/samples/inv2_5items.pdf'),
    ('Inv 3 (10 items)', 'tests/samples/inv3_10items.pdf'),
    ('Inv 4 (Arkan Rotated)', 'tests/samples/inv4_arkan_rotated.pdf'),
    ('Inv 5 (Mansour Rabia 2p)', 'tests/samples/inv5_mansour_rabia.pdf'),
]

for label, path in samples:
    b0 = run_ocr(path, 0)
    c0 = count_keywords(b0)
    if c0 < 4:
        b180 = run_ocr(path, 180)
        c180 = count_keywords(b180)
        chosen_blocks = b180 if c180 > c0 else b0
        print(f"{label}: Automatically detected rotation 180 (keywords: 0 -> {c180})")
    else:
        chosen_blocks = b0
        print(f"{label}: Standard rotation 0 (keywords: {c0})")
