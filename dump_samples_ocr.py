import subprocess
import json
import os

ocr_script = os.path.join("backend", "ocr_runner.ps1")

for s in ['inv1_14items.pdf', 'inv2_5items.pdf', 'inv3_10items.pdf']:
    path = os.path.join("tests", "samples", s)
    cmd = ["powershell", "-ExecutionPolicy", "Bypass", "-File", ocr_script, "-InputPath", path, "-Rotation", "0"]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
    try:
        blocks = json.loads(proc.stdout)
        print(f"{s}: Extracted {len(blocks)} lines")
        with open(f"ocr_{s}.json", "w", encoding="utf-8") as f:
            json.dump(blocks, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"{s} error: {e}")
