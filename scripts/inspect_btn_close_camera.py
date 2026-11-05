import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('frontend/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

pos = text.find("const btnClose = document.getElementById('btn-close-camera');")
if pos != -1:
    print(text[pos:pos+500])
else:
    print("Not found")
