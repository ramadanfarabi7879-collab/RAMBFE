import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('frontend/index.html', 'r', encoding='utf-8') as f:
    text = f.read()

pos = text.find('id="stk-scan-input"')
if pos != -1:
    print(text[pos-200:pos+400])
else:
    print("Not found")
