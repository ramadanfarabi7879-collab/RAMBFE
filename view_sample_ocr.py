import json
import sys

filename = sys.argv[1] if len(sys.argv) > 1 else 'ocr_inv1_14items.pdf.json'
with open(filename, 'r', encoding='utf-8') as f:
    lines = json.load(f)

print(f"=== {filename} ({len(lines)} lines) ===")
for i, l in enumerate(lines):
    print(f"L{i+1:02d} (y={l['y']:5.1f}, x={l['x']:5.1f}): {l['text']}")
