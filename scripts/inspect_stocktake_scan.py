import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('frontend/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

pos = text.find("if (cameraScanMode === 'stocktake')")
if pos != -1:
    print(text[pos:pos+1500])
else:
    print("Not found")
