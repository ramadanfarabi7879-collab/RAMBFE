import json
import re

with open('raw_ocr_dump.json', 'r', encoding='utf-8') as f:
    lines = json.load(f)

print(f"Total lines: {len(lines)}")

# Let's inspect how the items are structured
# An item begins with a sequence number or a line containing batch/date or item code
# Let's find all lines with item numbers (Seq 1, 2, 3...) or dates
for i, l in enumerate(lines):
    txt = l.get('text', '')
    # Check if line contains a date like DD.MM.YYYY
    date_m = re.search(r'\b\d{1,2}[\./\-]\d{1,2}[\./\-]20\d{2}\b', txt)
    # Check if line has item code (6 digits like 100xxx)
    code_m = re.search(r'\b10\d{4}\b', txt)
    if date_m or code_m or re.match(r'^\d{1,2}\s+', txt):
        print(f"L{i+1:03d} (y={l['y']:6.1f}): {txt}")
