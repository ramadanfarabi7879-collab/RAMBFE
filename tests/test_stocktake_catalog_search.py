# -*- coding: utf-8 -*-
"""
اختبارات تكامل البحث الموحد داخل شاشة الجرد:
- التحقق من البحث في جميع الحقول الثمانية (عربي، إنجليزي، علمي، شركة، باركود، GTIN، كود، رقم داخلي).
- التحقق من وضع البداية والمعمم وقاعدة الحد اللفظي ("ADOL " مقابل "ADOL").
- التحقق من استمرارية عمل مسح 1D Barcode و 2D GS1 QR وحساب الكميات والباتشات دون تغيير.
"""

import os
import sys
import tempfile
import unittest
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from backend import db
from backend import stock_manager


class TestStocktakeUnifiedCatalogSearch(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.test_db = os.path.join(self.tmpdir.name, "test_stk_search.db")
        self.orig_env = os.environ.get("INVENTORY_DB_PATH")
        os.environ["INVENTORY_DB_PATH"] = self.test_db
        db.init_db()
        stock_manager.init_stock_tables()
        stock_manager.create_new_store("ST-TEST", "مستودع الاختبار", "الفرع الرئيسي")

        # إدخال أصناف تجريبية تغطي كافة الحقول
        db.save_or_update_product({
            "code": "0000093860",
            "name_en": "ADOL EXTRA 500MG TAB",
            "name_ar": "ادول اكسترا حبوب",
            "scientific_name": "Paracetamol Caffeine",
            "company": "Tabuk Pharma",
            "category": "Analgesic",
            "selling_price": 15.0,
            "cost_price": 10.0,
            "barcode_list": ["6281111222333", "6289998887771"],
            "gtin_list": ["06281111222334"],
        })
        db.save_or_update_product({
            "code": "26606n",
            "name_en": "ADOLIN 0.1% GEL 30GM",
            "name_ar": "ادولين جل موضعي",
            "scientific_name": "Adapalene",
            "company": "Julphar",
            "category": "Dermatology",
            "selling_price": 22.5,
            "cost_price": 14.0,
            "barcode_list": ["6291100220011"],
            "gtin_list": ["06291100220011"],
        })

    def tearDown(self):
        if self.orig_env is None:
            os.environ.pop("INVENTORY_DB_PATH", None)
        else:
            os.environ["INVENTORY_DB_PATH"] = self.orig_env
        self.tmpdir.cleanup()

    def test_01_all_eight_fields_and_search_modes(self):
        # 1. العربي + بداية
        r_ar = db.search_products("ادول اكسترا", match_mode="start")
        self.assertEqual(r_ar["total"], 1)
        self.assertEqual(r_ar["items"][0]["code"], "0000093860")

        # 2. الإنجليزي + معمم (جزء من الكلمة في المنتصف)
        r_en = db.search_products("EXTRA", match_mode="contains")
        self.assertEqual(r_en["total"], 1)
        self.assertEqual(r_en["items"][0]["code"], "0000093860")

        # 3. الاسم العلمي
        r_sci = db.search_products("Adapalene", match_mode="start")
        self.assertEqual(r_sci["total"], 1)
        self.assertEqual(r_sci["items"][0]["code"], "26606n")

        # 4. الشركة المصنعة
        r_comp = db.search_products("Tabuk", match_mode="contains")
        self.assertEqual(r_comp["total"], 1)
        self.assertEqual(r_comp["items"][0]["code"], "0000093860")

        # 5. الباركود الإضافي والأساسي
        r_bar = db.search_products("6289998887771", match_mode="start")
        self.assertEqual(r_bar["total"], 1)
        self.assertEqual(r_bar["items"][0]["code"], "0000093860")

        # 6. GTIN
        r_gtin = db.search_products("06281111222334", match_mode="start")
        self.assertEqual(r_gtin["total"], 1)
        self.assertEqual(r_gtin["items"][0]["code"], "0000093860")

        # 7. كود الصنف ذو 10 خانات بالأصفار البادئة والرقم المختلط
        r_code1 = db.search_products("0000093860", match_mode="start")
        self.assertEqual(r_code1["total"], 1)
        self.assertEqual(r_code1["items"][0]["code"], "0000093860")

        r_code2 = db.search_products("26606n", match_mode="start")
        self.assertEqual(r_code2["total"], 1)
        self.assertEqual(r_code2["items"][0]["code"], "26606n")

        # 8. قاعدة الحد اللفظي (المسطرة): "ADOL" يطابق الاثنين، أما "ADOL " فلا يطابق ADOLIN
        r_no_space = db.search_products("ADOL", match_mode="start")
        self.assertEqual(r_no_space["total"], 2)

        r_with_space = db.search_products("ADOL ", match_mode="start")
        self.assertEqual(r_with_space["total"], 1)
        self.assertEqual(r_with_space["items"][0]["code"], "0000093860")

    def test_02_stocktake_select_and_preserve_1d_2d_scanning(self):
        # 1. الاختيار الصريح من نتائج البحث (كود 10 خانات وكود بحروف)
        res_pick = stock_manager.scan_item_to_store("0000093860", store_no="ST-TEST", product_code="0000093860")
        self.assertTrue(res_pick["success"], res_pick)
        self.assertTrue(res_pick.get("requires_batch_entry"))
        self.assertEqual(res_pick["product"]["code"], "0000093860")

        res_pick_alpha = stock_manager.scan_item_to_store("26606n", store_no="ST-TEST", product_code="26606n")
        self.assertTrue(res_pick_alpha["success"], res_pick_alpha)
        self.assertEqual(res_pick_alpha["product"]["code"], "26606n")

        # 2. مسح باركود 1D بالطريقة المعتادة
        res_1d = stock_manager.scan_item_to_store("6281111222333", store_no="ST-TEST")
        self.assertTrue(res_1d["success"], res_1d)
        self.assertTrue(res_1d.get("requires_batch_entry"))
        self.assertEqual(res_1d["product"]["code"], "0000093860")

        # 3. مسح كود 2D GS1 DataMatrix بالطريقة المعتادة (+1 تلقائي + حفظ الباتش ومنع تكرار السيريال)
        qr_2d = "01062811112223341727123110bt55521sn998877"
        res_2d = stock_manager.scan_item_to_store(qr_2d, store_no="ST-TEST")
        self.assertTrue(res_2d["success"], res_2d)
        self.assertFalse(res_2d.get("requires_batch_entry", False))
        self.assertEqual(res_2d["batch_number"], "BT555")

        res_dup = stock_manager.scan_item_to_store(qr_2d, store_no="ST-TEST")
        self.assertFalse(res_dup["success"])
        self.assertTrue(res_dup.get("is_duplicate_serial"))

    def test_03_frontend_reuses_catalog_search_endpoint(self):
        idx_html = (BASE_DIR / "frontend" / "index.html").read_text(encoding="utf-8")
        app_js = (BASE_DIR / "frontend" / "app.js").read_text(encoding="utf-8")

        self.assertIn('id="btn-stk-toggle-search-mode"', idx_html)
        self.assertIn('id="stk-search-dropdown"', idx_html)
        self.assertIn('function initStocktakeCatalogSearch()', app_js)
        self.assertIn('/api/catalog/products?query=', app_js[app_js.index('fetchAndRenderStkCatalogSearch'):])


if __name__ == "__main__":
    unittest.main(verbosity=2)
