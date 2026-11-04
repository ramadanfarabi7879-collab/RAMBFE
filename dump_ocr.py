import subprocess
import json
import os

ocr_script = os.path.join("backend", "ocr_runner.ps1")
cmd = [
    "powershell",
    "-ExecutionPolicy", "Bypass",
    "-File", ocr_script,
    "-InputPath", "data/last_uploaded_invoice.pdf",
    "-Rotation", "0"
]
proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
print("Returncode:", proc.returncode)
try:
    blocks = json.loads(proc.stdout)
    print(f"Total lines extracted: {len(blocks)}")
    with open("raw_ocr_dump.json", "w", encoding="utf-8") as f:
        json.dump(blocks, f, ensure_ascii=False, indent=2)
    print("Saved raw_ocr_dump.json successfully!")
except Exception as e:
    print("JSON load error:", e)
    print("Stdout length:", len(proc.stdout))
    print("Stderr:", proc.stderr[:500])
