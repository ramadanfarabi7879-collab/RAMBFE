#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
إصلاح فوري لخطأ async/await و activeEditingProductCode في frontend/app.js
"""

import os

APP_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "frontend", "app.js")

with open(APP_PATH, "r", encoding="utf-8") as f:
    content = f.read()

# 1. إصلاح openCreateProductModal لتكون async
content = content.replace(
    "function openCreateProductModal(prefillGtin = null, initialData = {}) {",
    "async function openCreateProductModal(prefillGtin = null, initialData = {}) {"
)

# 2. إضافة activeEditingProductCode في أعلى الملف إذا لم يكن موجوداً في البداية
if "let activeEditingProductCode" not in content[:1500]:
    content = content.replace(
        "let html5QrScannerInstance = null;",
        "let html5QrScannerInstance = null;\nlet activeEditingProductCode = null;"
    )

# 3. إزالة التصريح المكرر في أسفل الملف
content = content.replace(
    "    let activeEditingProductCode = null;",
    "    // activeEditingProductCode معرف في بداية الملف"
)

with open(APP_PATH, "w", encoding="utf-8") as f:
    f.write(content)

print("[OK] app.js syntax fixed successfully")
