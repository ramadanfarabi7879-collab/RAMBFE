import os, json, subprocess
from backend.invoice_parser import _parse_page_lines_unified

fpath = r'C:\Users\PH\.gemini\antigravity\brain\a3dbe10e-3abb-42d2-ac0b-c94056e8e2ba\.user_uploaded\media_1791442230388.pdf'
ocr_script = os.path.join('backend', 'ocr_runner.ps1')
cmd = ['powershell', '-ExecutionPolicy', 'Bypass', '-File', ocr_script, '-InputPath', fpath, '-Rotation', '0']
proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
blocks = json.loads(proc.stdout) if proc.returncode == 0 and proc.stdout.strip() else []

res = _parse_page_lines_unified(blocks)
print(f'_parse_page_lines_unified returned {len(res)} items')
with open('debug_unified_res.txt', 'w', encoding='utf-8') as f:
    for i, it in enumerate(res):
        f.write(f"#{i+1}: raw_name={it.get('raw_name')} | code={it.get('item_code')} | barcode={it.get('barcode')} | qty={it.get('quantity')} | bonus={it.get('bonus')} | price={it.get('cost_price') or it.get('invoice_price')} | disc1={it.get('discount_1')} | batch={it.get('batch_number')} | exp={it.get('expiry_date')}\n")
