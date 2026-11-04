import sys, json, os, subprocess
sys.stdout.reconfigure(encoding='utf-8')

ocr_script = os.path.join('backend', 'ocr_runner.ps1')
cmd = ['powershell', '-ExecutionPolicy', 'Bypass', '-File', ocr_script, '-InputPath', 'tests/samples/inv5_mansour_rabia.pdf', '-Rotation', '0']
proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
blocks = json.loads(proc.stdout)

for i in [13, 14, 15, 16, 40, 41, 42, 43, 44]:
    if i < len(blocks):
        print(f"L{i:2d}: {blocks[i]['text']}")
        for w in blocks[i]['words']:
            print(f"   w: x={w['x']:5.1f}, y={w['y']:5.1f}, text='{w['text']}'")
