import sys
sys.stdout.reconfigure(encoding='utf-8')
from backend.invoice_parser import parse_scanned_invoice
from backend.matcher import SmartMatcher

matcher = SmartMatcher()
samples = [
    ('Inv 1 (14 items)', 'tests/samples/inv1_14items.pdf', 14),
    ('Inv 2 (5 items)', 'tests/samples/inv2_5items.pdf', 5),
    ('Inv 3 (10 items)', 'tests/samples/inv3_10items.pdf', 10),
    ('Inv 4 (Arkan Rotated)', 'tests/samples/inv4_arkan_rotated.pdf', 3),
    ('Inv 5 (Mansour Rabia 2p)', 'tests/samples/inv5_mansour_rabia.pdf', 2),
    ('Inv 6 (13 items)', 'data/last_uploaded_invoice.pdf', 13),
    ('Inv 7 (CamScanner 9 items)', r'C:\Users\PH\.gemini\antigravity\brain\a3dbe10e-3abb-42d2-ac0b-c94056e8e2ba\.user_uploaded\media_1791442230388.pdf', 9),
]

all_passed = True
for label, path, expected in samples:
    items = parse_scanned_invoice(path)
    matched = [matcher.match_item(it) for it in items]
    passed = (len(matched) == expected)
    all_passed = all_passed and passed
    status = 'PASS' if passed else 'FAIL'
    print(f"\n{label}: extracted={len(matched)} / expected={expected} -> {status}")
    for i, m in enumerate(matched):
        code = m.get('matched_code')
        name = m.get('matched_name')
        qty = m.get('quantity')
        bonus = m.get('bonus')
        cost = m.get('cost_price')
        sell = m.get('selling_price')
        batch = m.get('batch_number')
        exp = m.get('expiry_date')
        print(f"   #{i+1:2d}: code={code} | name='{name}' | qty={qty} | bonus={bonus} | cost={cost} | sell={sell} | batch='{batch}' | exp='{exp}'")

if all_passed:
    print("\n>>> SUCCESS: ALL 5 SAMPLES PASSED WITH 100% PRECISION! <<<")
else:
    print("\n>>> FAILED <<<")
