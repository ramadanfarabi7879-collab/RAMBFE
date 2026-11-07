# -*- coding: utf-8 -*-
with open('frontend/app.js', 'r', encoding='utf-8') as f:
    c = f.read()

target = 'title="خاضع لضريبة القيمة المضافة ${taxBadge}"'
replacement = 'title="خاضع لضريبة القيمة المضافة ${taxRate.toFixed(0)}%"'

if target in c:
    c = c.replace(target, replacement, 1)
    with open('frontend/app.js', 'w', encoding='utf-8') as f:
        f.write(c)
    print("Fixed taxBadge reference in app.js successfully!")
else:
    print("Target not found!")
