import json, re

with open('raw_ocr_dump.json', 'r', encoding='utf-8') as f:
    raw_lines = json.load(f)

from test_full_pipeline import parse_ocr_blocks

items = parse_ocr_blocks(raw_lines)
with open('debug_all_items.txt', 'w', encoding='utf-8') as out:
    for idx, it in enumerate(items):
        out.write(f"#{idx+1:2d} | Seq={it.get('seq')} | Code={it.get('item_code')} | Name={it.get('raw_name')} | Qty={it.get('quantity')} | Price={it.get('cost_price')} | D1={it.get('discount_1')} | D2={it.get('discount_2')} | Batch={it.get('batch_number')} | Exp={it.get('expiry_date')}\n")

print("Saved debug_all_items.txt")
