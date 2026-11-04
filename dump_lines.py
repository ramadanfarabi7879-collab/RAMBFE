import os
import sys
import io
import subprocess
import json

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

ocr_script = os.path.join("backend", "ocr_runner.ps1")
cmd = ["powershell", "-ExecutionPolicy", "Bypass", "-File", ocr_script, "-InputPath", os.path.join("data", "last_uploaded_invoice.pdf"), "-Rotation", "0"]
proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore', timeout=90)
raw_blocks = json.loads(proc.stdout)

words = [w for b in raw_blocks for w in b.get('words', [])]
words.sort(key=lambda w: (w['y'], w['x']))

lines = []
for w in words:
    placed = False
    for l in lines:
        if abs(l[0]['y'] - w['y']) < 6.0:
            l.append(w)
            placed = True
            break
    if not placed:
        lines.append([w])

for l in lines:
    l.sort(key=lambda x: x['x'])

line_objs = [{'y': sum(w['y'] for w in l)/len(l), 'text': " ".join(w['text'] for w in l), 'words': l} for l in lines]
line_objs.sort(key=lambda x: x['y'])

print(f"Total lines: {len(line_objs)}")
for idx, l in enumerate(line_objs):
    print(f"Line {idx:02d} (y={l['y']:.1f}): {l['text']}")
    print(f"   Words: {[(w['text'], round(w['x'], 1)) for w in l['words']]}")
