import sys, json, os
sys.stdout.reconfigure(encoding='utf-8')
from backend.invoice_parser import parse_scanned_invoice
from backend.matcher import SmartMatcher

matcher = SmartMatcher()

samples = [
    ('Inv 1 (14 items)', 'tests/samples/inv1_14items.pdf'),
    ('Inv 2 (5 items)', 'tests/samples/inv2_5items.pdf'),
    ('Inv 3 (10 items)', 'tests/samples/inv3_10items.pdf'),
    ('Inv 4 (Arkan Rotated)', 'tests/samples/inv4_arkan_rotated.pdf'),
    ('Inv 5 (Mansour Rabia 2p)', 'tests/samples/inv5_mansour_rabia.pdf'),
]

for label, path in samples:
    print(f"\n==========================================")
    print(f"Testing {label} -> {path}")
    print(f"==========================================")
    try:
        raw_items = parse_scanned_invoice(path)
        print(f"Extracted: {len(raw_items)} items")
        for i, item in enumerate(raw_items):
            m = matcher.match_item(item)
            print(f"  #{i+1:2d}: raw='{item.get('raw_name')}' | code='{m.get('matched_code')}' | matched='{m.get('matched_name')}' | qty={item.get('quantity')} | bonus={item.get('bonus')} | cost={m.get('cost_price')} | sell={m.get('selling_price')} | d1={item.get('discount_1')} | batch='{item.get('batch_number')}' | exp='{item.get('expiry_date')}'")
    except Exception as e:
        print(f"Error on {label}: {e}")
        import traceback
        traceback.print_exc()
