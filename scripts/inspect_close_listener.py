import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('frontend/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

pos = text.find("const btnClose = document.getElementById('btn-close-camera');")
pos2 = text.find('btnClose', pos+50)
print(text[pos2-20:pos2+300])
