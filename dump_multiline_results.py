import json, re

with open('raw_ocr_dump.json', 'r', encoding='utf-8') as f:
    raw_lines = json.load(f)

from test_multiline_engine import parse_multiline_invoice_page, pages

all_items = []
for p_num, p_lines in pages.items():
    page_items = parse_multiline_invoice_page(p_lines)
    all_items.extend(page_items)

print(f"Total items: {len(all_items)}, Total Qty: {sum(it['quantity'] for it in all_items)}")
with open('multiline_engine_results.txt', 'w', encoding='utf-8') as out:
    for idx, it in enumerate(all_items):
        out.write(f"#{idx+1:2d} | Code={it['code']:6} | Qty={it['quantity']:2d} | Price={it['cost_price']:6.2f} | D1={it['discount_1']:5.2f}% | D2={it['discount_2']:5.2f}% | Batch={it['batch_number']:8} | Exp={it['expiry_date']} | Name={it['raw_name']}\n")
print("Saved multiline_engine_results.txt")
