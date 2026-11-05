import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('frontend/app.js', 'r', encoding='utf-8') as f:
    text = f.read()

pos = text.find("// 4. البحث في الأصناف المجرودة داخل الاستور المختار")
if pos != -1:
    print(text[pos-100:pos+800])
else:
    print("Not found")
