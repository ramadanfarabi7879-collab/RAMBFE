# -*- coding: utf-8 -*-
"""
اختبارات تكامل البحث الموحد داخل شاشة الجرد:
- التحقق من البحث في جميع الحقول الثمانية (عربي، إنجليزي، علمي، شركة، باركود، GTIN، كود، رقم داخلي).
- التحقق من وضع البداية والمعمم وقاعدة الحد اللفظي ("ADOL " مقابل "ADOL").
- التحقق من تقييد بحث شاشة الجرد (stock_only=True) بالأصناف ذات الرصيد الفعلي أو المدرجة في الجرد الجاري للمخزن المحدد فقط.
- التحقق من بقاء الأصناف التي أُدخلت في الجرد الجاري حتى لو كانت counted_qty = 0، ومن استبعاد سجلات الجرد المنتهية/القديمة وأصناف المخازن الأخرى.
- التحقق من مراعاة تعدد التشغيلات (دفعة 0 + دفعة 5 يظهر، جميع الدفعات 0 يُستبعد).
- التحقق من بقاء محرك بحث كرت الصنف الأصلي (stock_only=False) يعرض كافة الأصناف دون تغيير.
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
        self.st_test = stock_manager.create_new_store("مستودع الاختبار", "الفرع الرئيسي")["store_no"]
        self.st_other = stock_manager.create_new_store("مستودع آخر", "الفرع الثاني")["store_no"]
        self.st_empty = stock_manager.create_new_store("مستودع فارغ", "الفرع الثالث")["store_no"]
        self.st_done = stock_manager.create_new_store("مستودع جرد منتهي", "الفرع الرابع")["store_no"]

        # 1. صنف له رصيد فعلي في st_test (8 حقول كاملة)
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
        # 2. صنف له رصيد فعلي عبر دفعة 0 + دفعة 5 في st_test
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
        # 3. صنف مسجل في كرت الصنف والباركود ولكن بدون أي رصيد مخزني في st_test (موجود في st_other فقط)
        db.save_or_update_product({
            "code": "0000077777",
            "name_en": "ADOL COLD NOSTOCK TAB",
            "name_ar": "ادول كولد بدون رصيد",
            "scientific_name": "Paracetamol Pseudoephedrine",
            "company": "Tabuk Pharma",
            "category": "Analgesic",
            "selling_price": 18.0,
            "cost_price": 12.0,
            "barcode_list": ["6287777777777"],
            "gtin_list": ["06287777777777"],
        })
        # 4. صنف في st_test ولكن جميع دفعاته رصيدها 0
        db.save_or_update_product({
            "code": "0000088888",
            "name_en": "ADOL ZERO BATCH TAB",
            "name_ar": "ادول رصيد صفر",
            "scientific_name": "Paracetamol Zero",
            "company": "Tabuk Pharma",
            "category": "Analgesic",
            "selling_price": 11.0,
            "cost_price": 7.0,
            "barcode_list": ["6288888888888"],
            "gtin_list": ["06288888888888"],
        })
        # 5. صنف بدون رصيد مخزني لكنه دخل في الجرد الجاري لـ st_test بكمية counted_qty = 0
        db.save_or_update_product({
            "code": "0000099999",
            "name_en": "PANADOL COUNTED ZERO TAB",
            "name_ar": "بنادول مجرود بصفر",
            "scientific_name": "Paracetamol Active",
            "company": "GSK",
            "category": "Analgesic",
            "selling_price": 19.0,
            "cost_price": 13.0,
            "barcode_list": ["6289999999999"],
            "gtin_list": ["06289999999999"],
        })

        conn = db.get_connection()
        c = conn.cursor()
        # st_test: رصيد موجب لـ 0000093860
        c.execute("""
            INSERT INTO inventory_records (product_code, product_name, barcode, batch_number, expiry_date, system_qty, cost_price, selling_price, store_no)
            VALUES ('0000093860', 'ADOL EXTRA 500MG TAB', '6281111222333', 'B1', '2028-12-31', 4.0, 10.0, 15.0, ?)
        """, (self.st_test,))
        # st_test: دفعة 0 ودفعة 5 لـ 26606n (يجب أن يظهر)
        c.execute("""
            INSERT INTO inventory_records (product_code, product_name, barcode, batch_number, expiry_date, system_qty, cost_price, selling_price, store_no)
            VALUES ('26606n', 'ADOLIN 0.1% GEL 30GM', '6291100220011', 'DZ0', '2026-01-01', 0.0, 14.0, 22.5, ?),
                   ('26606n', 'ADOLIN 0.1% GEL 30GM', '6291100220011', 'DZ5', '2028-06-30', 5.0, 14.0, 22.5, ?)
        """, (self.st_test, self.st_test))
        # st_test: جميع دفعات 0000088888 بصفر (يجب أن يُستبعد)
        c.execute("""
            INSERT INTO inventory_records (product_code, product_name, barcode, batch_number, expiry_date, system_qty, cost_price, selling_price, store_no)
            VALUES ('0000088888', 'ADOL ZERO BATCH TAB', '6288888888888', 'Z1', '2027-01-01', 0.0, 7.0, 11.0, ?),
                   ('0000088888', 'ADOL ZERO BATCH TAB', '6288888888888', 'Z2', '2027-05-01', 0.0, 7.0, 11.0, ?)
        """, (self.st_test, self.st_test))
        # st_other: رصيد 0000077777 في مخزن آخر فقط (يجب ألا يظهر في st_test)
        c.execute("""
            INSERT INTO inventory_records (product_code, product_name, barcode, batch_number, expiry_date, system_qty, cost_price, selling_price, store_no)
            VALUES ('0000077777', 'ADOL COLD NOSTOCK TAB', '6287777777777', 'OT1', '2028-01-01', 12.0, 12.0, 18.0, ?)
        """, (self.st_other,))
        # st_test جرد جاري: إدخال 0000099999 بكمية counted_qty = 0 وتفعيل status='in_progress'
        c.execute("UPDATE stock_stores SET status = 'in_progress' WHERE store_no = ?", (self.st_test,))
        c.execute("""
            INSERT INTO stocktake_entries (product_code, product_name, barcode, gtin, batch_number, expiry_date, system_qty, counted_qty, store_no)
            VALUES ('0000099999', 'PANADOL COUNTED ZERO TAB', '6289999999999', '06289999999999', 'P0', '2028-03-01', 0.0, 0.0, ?)
        """, (self.st_test,))
        # st_done منتهي ومعتمد: سجل قديم في stocktake_entries بدون رصيد في inventory_records (يجب أن يُستبعد)
        c.execute("UPDATE stock_stores SET status = 'completed' WHERE store_no = ?", (self.st_done,))
        c.execute("""
            INSERT INTO stocktake_entries (product_code, product_name, barcode, gtin, batch_number, expiry_date, system_qty, counted_qty, store_no)
            VALUES ('0000099999', 'PANADOL COUNTED ZERO TAB', '6289999999999', '06289999999999', 'OLD1', '2026-01-01', 0.0, 0.0, ?)
        """, (self.st_done,))
        conn.commit()
        conn.close()

    def tearDown(self):
        if self.orig_env is None:
            os.environ.pop("INVENTORY_DB_PATH", None)
        else:
            os.environ["INVENTORY_DB_PATH"] = self.orig_env
        self.tmpdir.cleanup()

    def test_01_catalog_search_unchanged_and_shows_all_products(self):
        # محرك بحث كرت الصنف الأصلي (stock_only=False) يعرض جميع الأصناف الأربعة التي تبدأ بـ ADOL بما فيها عديمة الرصيد
        r_cat = db.search_products("ADOL", match_mode="start")
        self.assertEqual(r_cat["total"], 4)
        self.assertEqual({i["code"] for i in r_cat["items"]}, {"0000093860", "26606n", "0000077777", "0000088888"})

        # قاعدة الحد اللفظي في كرت الصنف ما زالت تستبعد ADOLIN
        r_wb = db.search_products("ADOL ", match_mode="start")
        self.assertEqual({i["code"] for i in r_wb["items"]}, {"0000093860", "0000077777", "0000088888"})

    def test_02_stocktake_search_filters_by_store_stock_and_all_eight_fields(self):
        # البحث في st_test بـ "ADOL" يعرض فقط 0000093860 (رصيد 4) و 26606n (دفعة 0 + دفعة 5) ويستبعد 0000077777 (مخزن آخر) و 0000088888 (كل دفعاته 0)
        r_stk = db.search_products("ADOL", match_mode="start", stock_only=True, store_no=self.st_test)
        self.assertEqual(r_stk["total"], 2)
        self.assertEqual({i["code"] for i in r_stk["items"]}, {"0000093860", "26606n"})

        # الحقول الثمانية والأنماط في شاشة الجرد (stock_only=True):
        self.assertEqual([i["code"] for i in db.search_products("ادول اكسترا", match_mode="start", stock_only=True, store_no=self.st_test)["items"]], ["0000093860"])
        self.assertEqual([i["code"] for i in db.search_products("EXTRA", match_mode="contains", stock_only=True, store_no=self.st_test)["items"]], ["0000093860"])
        self.assertEqual([i["code"] for i in db.search_products("Adapalene", match_mode="start", stock_only=True, store_no=self.st_test)["items"]], ["26606n"])
        self.assertEqual([i["code"] for i in db.search_products("Tabuk", match_mode="contains", stock_only=True, store_no=self.st_test)["items"]], ["0000093860"])
        self.assertEqual([i["code"] for i in db.search_products("6289998887771", match_mode="start", stock_only=True, store_no=self.st_test)["items"]], ["0000093860"])
        self.assertEqual([i["code"] for i in db.search_products("06281111222334", match_mode="start", stock_only=True, store_no=self.st_test)["items"]], ["0000093860"])
        self.assertEqual([i["code"] for i in db.search_products("0000093860", match_mode="start", stock_only=True, store_no=self.st_test)["items"]], ["0000093860"])
        self.assertEqual([i["code"] for i in db.search_products("26606n", match_mode="start", stock_only=True, store_no=self.st_test)["items"]], ["26606n"])

        # قاعدة الحد اللفظي ("ADOL ") مع stock_only=True تستبعد ADOLIN وكذلك تستبعد عديمي الرصيد
        r_stk_wb = db.search_products("ADOL ", match_mode="start", stock_only=True, store_no=self.st_test)
        self.assertEqual([i["code"] for i in r_stk_wb["items"]], ["0000093860"])

        # أولوية OR/AND في SQL: البحث باسم/باركود صنف عديم الرصيد في st_test يرجع 0 نتائج حتى مع وجود كلمة/شركة مشتركة
        self.assertEqual(db.search_products("0000077777", match_mode="contains", stock_only=True, store_no=self.st_test)["total"], 0)
        self.assertEqual(db.search_products("6287777777777", match_mode="start", stock_only=True, store_no=self.st_test)["total"], 0)
        self.assertEqual(db.search_products("0000088888", match_mode="contains", stock_only=True, store_no=self.st_test)["total"], 0)

    def test_03_current_stocktake_zero_qty_and_store_isolation(self):
        # 1. الصنف 0000099999 بدون رصيد مخزني، لكنه أُدخل في الجرد الجاري لـ st_test بكمية counted_qty = 0 -> يجب أن يظهر للمراجعة والتعديل
        r_curr_zero = db.search_products("PANADOL", match_mode="start", stock_only=True, store_no=self.st_test)
        self.assertEqual(r_curr_zero["total"], 1)
        self.assertEqual(r_curr_zero["items"][0]["code"], "0000099999")
        self.assertTrue(r_curr_zero["items"][0]["in_current_stocktake"])

        # 2. في المخزن المنتهي st_done (status='completed'): سجل stocktake_entries القديم لا يُعتبر جرداً جارياً -> لا يظهر
        r_done = db.search_products("PANADOL", match_mode="start", stock_only=True, store_no=self.st_done)
        self.assertEqual(r_done["total"], 0)

        # 3. في المخزن الفارغ st_empty: لا تظهر أصناف من st_test أو st_other
        r_empty = db.search_products("ADOL", match_mode="start", stock_only=True, store_no=self.st_empty)
        self.assertEqual(r_empty["total"], 0)

        # 4. في st_other: يظهر فقط 0000077777 وليس أصناف st_test
        r_other = db.search_products("ADOL", match_mode="start", stock_only=True, store_no=self.st_other)
        self.assertEqual([i["code"] for i in r_other["items"]], ["0000077777"])

    def test_04_stocktake_select_and_preserve_1d_2d_scanning(self):
        res_pick = stock_manager.scan_item_to_store("0000093860", store_no=self.st_test, product_code="0000093860")
        self.assertTrue(res_pick["success"], res_pick)
        self.assertTrue(res_pick.get("requires_batch_entry"))
        self.assertEqual(res_pick["product"]["code"], "0000093860")

        res_1d = stock_manager.scan_item_to_store("6281111222333", store_no=self.st_test)
        self.assertTrue(res_1d["success"], res_1d)
        self.assertEqual(res_1d["product"]["code"], "0000093860")

        qr_2d = "01062811112223341727123110bt55521sn998877"
        res_2d = stock_manager.scan_item_to_store(qr_2d, store_no=self.st_test)
        self.assertTrue(res_2d["success"], res_2d)
        self.assertEqual(res_2d["batch_number"], "BT555")

        res_dup = stock_manager.scan_item_to_store(qr_2d, store_no=self.st_test)
        self.assertFalse(res_dup["success"])
        self.assertTrue(res_dup.get("is_duplicate_serial"))

    def test_05_frontend_and_server_wire_stock_search_route(self):
        idx_html = (BASE_DIR / "frontend" / "index.html").read_text(encoding="utf-8")
        app_js = (BASE_DIR / "frontend" / "app.js").read_text(encoding="utf-8")
        srv_py = (BASE_DIR / "backend" / "server.py").read_text(encoding="utf-8")

        self.assertIn('id="btn-stk-toggle-search-mode"', idx_html)
        self.assertIn('id="btn-stk-toggle-stock-filter"', idx_html)
        self.assertIn('فلترة على المخزون', idx_html)
        self.assertIn('id="stk-search-dropdown"', idx_html)
        self.assertIn("if path == '/api/stock/search':", srv_py)
        self.assertIn("stock_only=True, store_no=store_no", srv_py)
        self.assertIn('let isStkStockFilterEnabled = false;', app_js)
        fetch_body = app_js[app_js.index('fetchAndRenderStkCatalogSearch'):]
        self.assertIn('isStkStockFilterEnabled', fetch_body)
        self.assertIn('/api/stock/search?query=', fetch_body)
        self.assertIn('/api/catalog/products?query=', fetch_body)
        self.assertIn('/api/catalog/products?query=', app_js[app_js.index('loadCatalogProducts'):])


if __name__ == "__main__":
    unittest.main(verbosity=2)
