import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('frontend/index.html', 'r', encoding='utf-8') as f:
    text = f.read()

pos = text.find('modal-camera-scanner')
if pos != -1:
    print(text[pos-100:pos+2500])
else:
    print("Not found")
