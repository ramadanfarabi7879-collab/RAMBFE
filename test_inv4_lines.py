import sys, json, os, subprocess
sys.stdout.reconfigure(encoding='utf-8')
from backend.invoice_parser import _parse_scanned_ocr_blocks

ocr_script = os.path.join('backend', 'ocr_runner.ps1')
cmd = ['powershell', '-ExecutionPolicy', 'Bypass', '-File', ocr_script, '-InputPath', 'tests/samples/inv4_arkan_rotated.pdf', '-Rotation', '180']
proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
blocks = json.loads(proc.stdout)

for i in range(15, len(blocks)):
    print(f"L{i:2d}: {blocks[i]['text']}")
