import sys
sys.stdout.reconfigure(encoding='utf-8')
with open('frontend/app.js', 'r', encoding='utf-8') as f:
    lines = f.readlines()

for i, l in enumerate(lines):
    if 'parse_qr' in l or 'parseGs1' in l or '01(\\d{14})' in l or 'parseGS1' in l or 'parseQr' in l:
        print(f"{i+1}: {l.strip()[:100]}")
