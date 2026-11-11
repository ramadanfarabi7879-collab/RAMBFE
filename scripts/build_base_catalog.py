# -*- coding: utf-8 -*-
"""بناء كتالوج الأصناف الأساسي المدمج في البرنامج (frontend/base-catalog.json).

المصدر: قاعدة بيانات الكمبيوتر data/inventory.db (الكتالوج المستورد من product.template.xlsx).
الملف الناتج يُنشر مع الموقع كملف ثابت، فكل موبايل/كمبيوتر يقدر يبحث ويمسح الأصناف حتى لو
قاعدة البيانات السحابية وقفت (الحد اليومي) أو مفيش إنترنت، ومن غير ما يقرا أي صف من D1.
نفس شكل /api/catalog/snapshot بالضبط.

التشغيل بعد أي تحديث كبير للكتالوج:
    python scripts/build_base_catalog.py
"""
import json
import os
import sqlite3
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COLS = ['id', 'code', 'name_en', 'name_ar', 'name', 'gtin', 'barcode', 'selling_price', 'cost_price', 'unit_price',
        'scientific_name', 'company', 'category', 'tax_rate', 'unit']


def main(db_path: str, out_path: str) -> None:
    conn = sqlite3.connect(db_path)
    products = conn.execute(f"SELECT {', '.join(COLS)} FROM products ORDER BY id DESC").fetchall()
    barcodes = conn.execute("SELECT product_code, barcode, barcode_type FROM product_barcodes").fetchall()
    conn.close()
    snap = {
        "version": 1, "base": True, "source": "product.template.xlsx", "generated_at": int(time.time() * 1000),
        "count": len(products), "cols": COLS,
        "products": [list(p) for p in products],
        "barcodes": [[b[0], b[1], 1 if b[2] == 'gtin' else 0] for b in barcodes],
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(snap, f, ensure_ascii=False, separators=(',', ':'))
    print(f"{out_path}: {len(products)} products, {len(barcodes)} barcodes, {os.path.getsize(out_path) / 1e6:.1f} MB")


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'data', 'inventory.db'),
         sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'frontend', 'base-catalog.json'))
