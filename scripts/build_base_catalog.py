# -*- coding: utf-8 -*-
"""بناء كتالوج الأصناف الأساسي المدمج في البرنامج (frontend/base-catalog.json).

المصدر: قاعدة بيانات الكمبيوتر data/inventory.db (الكتالوج المستورد من product.template.xlsx).
الملف الناتج يُنشر مع الموقع كملف ثابت، فكل موبايل/كمبيوتر يقدر يبحث ويمسح الأصناف حتى لو
قاعدة البيانات السحابية وقفت (الحد اليومي) أو مفيش إنترنت، ومن غير ما يقرا أي صف من D1.
نفس شكل /api/catalog/snapshot بالضبط.

التشغيل بعد أي تحديث كبير للكتالوج (من السحابة نفسها = المصدر الصحيح، بيقرا ~92 ألف صف مرة واحدة):
    python scripts/build_base_catalog.py --from-cloud
أو من قاعدة بيانات الكمبيوتر:
    python scripts/build_base_catalog.py
"""
import subprocess
import json
import os
import sqlite3
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COLS = ['id', 'code', 'name_en', 'name_ar', 'name', 'gtin', 'barcode', 'selling_price', 'cost_price', 'unit_price',
        'scientific_name', 'company', 'category', 'tax_rate', 'unit']


def cloud_query(sql: str) -> list:
    out = subprocess.run(f'npx wrangler d1 execute rambfe-db --remote --json --command "{sql}"', shell=True, cwd=ROOT,
                         capture_output=True, text=True, encoding='utf-8')
    data = json.loads(out.stdout)
    if isinstance(data, dict) and data.get('error'):
        raise SystemExit(f"cloud query failed: {data['error']}")
    return data[0]['results']


def main(db_path: str, out_path: str, from_cloud: bool = False) -> None:
    if from_cloud:
        products = [tuple(r[c] for c in COLS) for r in cloud_query(f"SELECT {', '.join(COLS)} FROM products ORDER BY id DESC")]
        barcodes = [(r['product_code'], r['barcode'], r['barcode_type']) for r in cloud_query("SELECT product_code, barcode, barcode_type FROM product_barcodes")]
    else:
        conn = sqlite3.connect(db_path)
        products = conn.execute(f"SELECT {', '.join(COLS)} FROM products ORDER BY id DESC").fetchall()
        barcodes = conn.execute("SELECT product_code, barcode, barcode_type FROM product_barcodes").fetchall()
        conn.close()
    snap = {
        "version": 1, "base": True, "source": "cloud" if from_cloud else "product.template.xlsx", "generated_at": int(time.time() * 1000),
        "count": len(products), "cols": COLS,
        "products": [list(p) for p in products],
        "barcodes": [[b[0], b[1], 1 if b[2] == 'gtin' else 0] for b in barcodes],
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(snap, f, ensure_ascii=False, separators=(',', ':'))
    # ملف صغير برقم إصدار الكتالوج المدمج: الأجهزة تعرف منه إن فيه نسخة أحدث نزلت مع تحديث الموقع
    with open(os.path.join(os.path.dirname(out_path), 'base-catalog.version.json'), 'w', encoding='utf-8') as f:
        json.dump({"generated_at": snap["generated_at"], "count": len(products)}, f)
    print(f"{out_path}: {len(products)} products, {len(barcodes)} barcodes, {os.path.getsize(out_path) / 1e6:.1f} MB")


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if a != '--from-cloud']
    main(args[0] if len(args) > 0 else os.path.join(ROOT, 'data', 'inventory.db'),
         args[1] if len(args) > 1 else os.path.join(ROOT, 'frontend', 'base-catalog.json'),
         from_cloud='--from-cloud' in sys.argv)
