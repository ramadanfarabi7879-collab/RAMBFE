import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('frontend/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

pos = text.find('function initHtml5ScannerInstance()')
if pos != -1:
    print(text[pos:pos+2500])
else:
    print("Not found")
