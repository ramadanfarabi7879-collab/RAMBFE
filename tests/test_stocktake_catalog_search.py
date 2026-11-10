# -*- coding: utf-8 -*-
"""
اختبارات الفصل الكامل بين خانتي البحث في شاشة الجرد:
1. الخانة الأولى (/api/stock/preinventory-search): البحث في المخزون الفعلي بالنظام قبل الجرد (inventory_records عبر كل المخازن، دون التأثر بجرد الاستور).
2. الخانة الثانية (/api/stock/store/search): البحث داخل جرد الاستور المحدد فقط (stocktake_entries WHERE store_no = ?، تجميع الدفعات/الرفوف، وحالة لم يُجرد بعد).
3. بقاء بحث كرت الصنف الأصلي (search_products without stock_only) وتجاوز الأكواد والباركودات وQR/GS1 لفلترة المخزون دون تغيير.
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


class TestDualStocktakeSearchSeparation(unittest.TestCase):
    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.test_db = os.path.join(self.tmpdir.name, "test_dual_stk_search.db")
        self.orig_env = os.environ.get("INVENTORY_DB_PATH")
        os.environ["INVENTORY_DB_PATH"] = self.test_db
        db.init_db()
        stock_manager.init_stock_tables()

        self.st_return = stock_manager.create_new_store("RETURN", "الفرع الرئيسي")["store_no"]
        self.st_cosm2 = stock_manager.create_new_store("COSMETAIC RETURN 2", "الفرع الرئيسي")["store_no"]
        self.st_empty = stock_manager.create_new_store("EMPTY STORE", "الفرع الثاني")["store_no"]

        # 1. الصنف المطلوب في الاختبار: REXONA MEN DEO ROLL ADVENTURE 40ML (code=12162) برصيد 6 وحدات على دفعتين في st_cosm2
        db.save_or_update_product({
            "code": "12162",
            "name_en": "REXONA MEN DEO ROLL ADVENTURE 40ML",
            "name_ar": "ركسونا رول 40 مل ادفنتوري",
            "scientific_name": "Aluminum Chlorohydrate",
            "company": "Unilever",
            "category": "Cosmetics",
            "selling_price": 15.0,
            "cost_price": 4.43,
            "barcode_list": ["4800888158499", "8999999580759"],
            "gtin_list": ["04800888158499", "08999999580759"],
        })
        # 2. صنف بـ 500MG في الاسم وله رصيد في st_cosm2
        db.save_or_update_product({
            "code": "0000093860",
            "name_en": "ADOL EXTRA 500MG TAB",
            "name_ar": "ادول اكسترا 500 مجم",
            "scientific_name": "Paracetamol Caffeine",
            "company": "Tabuk Pharma",
            "category": "Analgesic",
            "selling_price": 15.0,
            "cost_price": 10.0,
            "barcode_list": ["6281111222333"],
            "gtin_list": ["06281111222334"],
        })
        # 3. صنف بـ 500MG في الاسم وبدون أي رصيد في inventory_records
        db.save_or_update_product({
            "code": "0000077777",
            "name_en": "PANADOL ADVANCE 500MG",
            "name_ar": "بنادول ادفانس 500 مجم",
            "scientific_name": "Paracetamol",
            "company": "GSK",
            "category": "Analgesic",
            "selling_price": 18.0,
            "cost_price": 12.0,
            "barcode_list": ["6287777777777"],
            "gtin_list": ["06287777777777"],
        })
        # 4. صنف بكود مختلط (26606n) ودفعتين في inventory_records (0 + 5)
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
        # 5. صنف بكود حرفي (BDN) بدون رصيد مخزني
        db.save_or_update_product({
            "code": "BDN",
            "name_en": "BDN SPECIAL ITEM",
            "name_ar": "صنف كود حرفي",
            "scientific_name": "Special",
            "company": "Generic",
            "category": "Misc",
            "selling_price": 5.0,
            "cost_price": 3.0,
            "barcode_list": ["6285555555555"],
            "gtin_list": ["06285555555555"],
        })

        conn = db.get_connection()
        c = conn.cursor()
        # رصيد ركسونا الأصلي في st_cosm2 (4 + 2 = 6 وحدات)
        c.execute("""
            INSERT INTO inventory_records (product_code, product_name, barcode, batch_number, expiry_date, system_qty, cost_price, selling_price, store_no)
            VALUES ('12162', 'REXONA MEN DEO ROLL ADVENTURE 40ML', '4800888158499', '12162004', '2026-07-04', 4.0, 4.43, 15.0, ?),
                   ('12162', 'REXONA MEN DEO ROLL ADVENTURE 40ML', '4800888158499', '454', '2026-07-05', 2.0, 4.43, 15.0, ?)
        """, (self.st_cosm2, self.st_cosm2))
        # رصيد 0000093860 في st_cosm2 ورصيد إضافي في st_return لفحص عدم دمج المخازن
        c.execute("""
            INSERT INTO inventory_records (product_code, product_name, barcode, batch_number, expiry_date, system_qty, cost_price, selling_price, store_no)
            VALUES ('0000093860', 'ADOL EXTRA 500MG TAB', '6281111222333', 'AD1', '2028-01-01', 3.0, 10.0, 15.0, ?),
                   ('0000093860', 'ADOL EXTRA 500MG TAB', '6281111222333', 'AD2', '2028-06-01', 2.0, 10.0, 15.0, ?)
        """, (self.st_cosm2, self.st_return))
        # رصيد 26606n (دفعة 0 + دفعة 5)
        c.execute("""
            INSERT INTO inventory_records (product_code, product_name, barcode, batch_number, expiry_date, system_qty, cost_price, selling_price, store_no)
            VALUES ('26606n', 'ADOLIN 0.1% GEL 30GM', '6291100220011', 'DZ0', '2026-01-01', 0.0, 14.0, 22.5, ?),
                   ('26606n', 'ADOLIN 0.1% GEL 30GM', '6291100220011', 'DZ5', '2028-06-30', 5.0, 14.0, 22.5, ?)
        """, (self.st_cosm2, self.st_cosm2))
        conn.commit()
        conn.close()

    def tearDown(self):
        if self.orig_env is None:
            os.environ.pop("INVENTORY_DB_PATH", None)
        else:
            os.environ["INVENTORY_DB_PATH"] = self.orig_env
        self.tmpdir.cleanup()

    def test_01_catalog_search_unchanged(self):
        r = db.search_products("ADOL", match_mode="start")
        self.assertEqual({i["code"] for i in r["items"]}, {"0000093860", "26606n"})
        r_wb = db.search_products("ADOL ", match_mode="start")
        self.assertEqual([i["code"] for i in r_wb["items"]], ["0000093860"])

    def test_02_box1_preinventory_finds_rexona_regardless_of_selected_store(self):
        # 1. البحث عن ركسونا في الخانة الأولى (المخزون قبل الجرد) مع تفعيل الفلترة يجد الصنف برصيده الأصلي 6 في st_cosm2 حتى لو كان الاستور الحالي st_return فارغاً
        r_on = db.search_preinventory_products("REXONA MEN DEO ROLL ADVENTURE 40ML", match_mode="start", stock_only=True)
        self.assertEqual(r_on["total"], 1)
        item = r_on["items"][0]
        self.assertEqual(item["code"], "12162")
        self.assertEqual(item["pre_inventory_total_qty"], 6.0)
        self.assertEqual(len(item["pre_inventory_stores"]), 1)
        self.assertEqual(item["pre_inventory_stores"][0]["store_no"], self.st_cosm2)
        self.assertEqual(item["pre_inventory_stores"][0]["system_qty"], 6.0)
        self.assertEqual(item["pre_inventory_stores"][0]["batch_count"], 2)

        # 2. عند وجود الصنف في أكثر من مخزن (0000093860) يظهر كل مخزن برصيده مفصلاً دون دمج ملبس
        r_multi = db.search_preinventory_products("0000093860", stock_only=True)
        stores_map = {s["store_no"]: s["system_qty"] for s in r_multi["items"][0]["pre_inventory_stores"]}
        self.assertEqual(stores_map, {self.st_return: 2.0, self.st_cosm2: 3.0})

        # 3. 500MG بالاسم: مع الفلترة مغلقة يعرض الاثنين (المخزني وغير المخزني)، ومع تفعيلها يعرض المخزني فقط (0000093860)
        r_500_off = db.search_preinventory_products("500MG", match_mode="contains", stock_only=False)
        self.assertEqual({i["code"] for i in r_500_off["items"]}, {"0000093860", "0000077777"})
        r_500_on = db.search_preinventory_products("500MG", match_mode="contains", stock_only=True)
        self.assertEqual([i["code"] for i in r_500_on["items"]], ["0000093860"])

        # 4. البحث بالباركود أو الكود أو GTIN أو QR أو رقم الدفعة يتجاوز الفلترة أو يعثر على الصنف
        self.assertEqual([i["code"] for i in db.search_preinventory_products("0000077777", stock_only=True)["items"]], ["0000077777"])
        self.assertEqual([i["code"] for i in db.search_preinventory_products("6287777777777", stock_only=True)["items"]], ["0000077777"])
        self.assertEqual([i["code"] for i in db.search_preinventory_products("BDN", stock_only=True)["items"]], ["BDN"])
        r_qr = db.search_preinventory_products("0104800888158499172607041012162004\x1d21SN001", stock_only=True)
        self.assertEqual([i["code"] for i in r_qr["items"]], ["12162"])
        self.assertEqual(r_qr["qr_batch"], "12162004")
        r_qr_paren = db.search_preinventory_products("(01)04800888158499(17)260704(10)12162004(21)SN001", stock_only=True)
        self.assertEqual([i["code"] for i in r_qr_paren["items"]], ["12162"])
        self.assertEqual(r_qr_paren["qr_batch"], "12162004")
        r_batch = db.search_preinventory_products("12162004", match_mode="start", stock_only=True)
        self.assertEqual([i["code"] for i in r_batch["items"]], ["12162"])

    def test_03_box2_store_search_isolation_aggregation_and_preinventory_independence(self):
        # الحالة 2: قبل جرد ركسونا في st_return -> الخانة الثانية تعرض أنه غير مجرود بعد في st_return (0 معدود) ولا تسحب رصيد st_cosm2
        s0 = stock_manager.search_store_stocktake_items(self.st_return, "REXONA MEN DEO ROLL ADVENTURE 40ML", match_mode="start")
        self.assertEqual(len(s0["items"]), 0)
        self.assertEqual(len(s0["product_summaries"]), 1)
        sum0 = s0["product_summaries"][0]
        self.assertEqual(sum0["product_code"], "12162")
        self.assertFalse(sum0["is_counted_in_store"])
        self.assertEqual(sum0["total_counted_qty"], 0.0)
        self.assertEqual(sum0["store_system_qty"], 0.0)

        # الحالة 3 و 4: جرد 4 وحدات في st_return على رفين/دفعتين (2 + 2) بدلاً من 6
        stock_manager.save_stock_batch_count(self.st_return, "12162", "12162004", "2026-07-04", 2.0)
        stock_manager.save_stock_batch_count(self.st_return, "12162", "454", "2026-07-05", 2.0)

        s_ret = stock_manager.search_store_stocktake_items(self.st_return, "ركسونا رول", match_mode="start")
        self.assertEqual(s_ret["counted_matches_count"], 1)
        ret_sum = s_ret["product_summaries"][0]
        self.assertTrue(ret_sum["is_counted_in_store"])
        self.assertEqual(ret_sum["total_counted_qty"], 4.0)
        self.assertEqual(len(ret_sum["batch_rows"]), 2)
        self.assertEqual({b["batch_number"]: b["counted_qty"] for b in ret_sum["batch_rows"]}, {"12162004": 2.0, "454": 2.0})

        # الحالة 5 و 10: جرد 1 وحدة من نفس الصنف في st_cosm2، ثم فحص استقلال st_return و st_cosm2 و st_empty
        stock_manager.save_stock_batch_count(self.st_cosm2, "12162", "12162004", "2026-07-04", 1.0)
        s_ret_after = stock_manager.search_store_stocktake_items(self.st_return, "12162", match_mode="start")
        s_cosm_after = stock_manager.search_store_stocktake_items(self.st_cosm2, "12162", match_mode="start")
        s_empty_after = stock_manager.search_store_stocktake_items(self.st_empty, "12162", match_mode="start")
        self.assertEqual(s_ret_after["product_summaries"][0]["total_counted_qty"], 4.0)
        self.assertEqual(s_cosm_after["product_summaries"][0]["total_counted_qty"], 1.0)
        self.assertFalse(s_empty_after["product_summaries"][0]["is_counted_in_store"])
        self.assertEqual(s_empty_after["product_summaries"][0]["total_counted_qty"], 0.0)

        # الحالة 6: الخانة الأولى (المخزون الأصلي قبل الجرد) لم تتأثر بعمليات الجرد وظلت تعرض 6.0 في st_cosm2!
        pre_after = db.search_preinventory_products("REXONA", match_mode="start", stock_only=True)
        self.assertEqual(pre_after["items"][0]["pre_inventory_total_qty"], 6.0)
        self.assertEqual(pre_after["items"][0]["pre_inventory_stores"][0]["system_qty"], 6.0)

        # الحالة 7 و 8 في الخانة الثانية: العلمي + الكود + الباركود + GTIN + QR + الدفعة + 500MG
        self.assertEqual(stock_manager.search_store_stocktake_items(self.st_return, "Aluminum", match_mode="start")["product_summaries"][0]["total_counted_qty"], 4.0)
        self.assertEqual(stock_manager.search_store_stocktake_items(self.st_return, "4800888158499", match_mode="start")["product_summaries"][0]["total_counted_qty"], 4.0)
        self.assertEqual(stock_manager.search_store_stocktake_items(self.st_return, "04800888158499", match_mode="start")["product_summaries"][0]["total_counted_qty"], 4.0)
        self.assertEqual(stock_manager.search_store_stocktake_items(self.st_return, "454", match_mode="start")["product_summaries"][0]["batch_rows"][0]["counted_qty"], 2.0)
        qr_res = stock_manager.search_store_stocktake_items(self.st_return, "0104800888158499172607041012162004\x1d21SN001", match_mode="start")
        self.assertEqual(qr_res["qr_batch"], "12162004")
        self.assertEqual(qr_res["product_summaries"][0]["total_counted_qty"], 2.0)
        r_500_store = stock_manager.search_store_stocktake_items(self.st_return, "500MG", match_mode="contains")
        self.assertEqual({s["product_code"] for s in r_500_store["product_summaries"]}, {"0000093860", "0000077777"})

    def test_04_preserve_1d_2d_scanning(self):
        res_pick = stock_manager.scan_item_to_store("12162", store_no=self.st_return, product_code="12162")
        self.assertTrue(res_pick["success"], res_pick)
        self.assertTrue(res_pick.get("requires_batch_entry"))

        qr_2d = "01062811112223341727123110bt55521sn998877"
        res_2d = stock_manager.scan_item_to_store(qr_2d, store_no=self.st_return)
        self.assertTrue(res_2d["success"], res_2d)
        self.assertEqual(res_2d["batch_number"], "BT555")

        res_dup = stock_manager.scan_item_to_store(qr_2d, store_no=self.st_return)
        self.assertFalse(res_dup["success"])
        self.assertTrue(res_dup.get("is_duplicate_serial"))

    def test_05_frontend_and_server_wiring(self):
        idx_html = (BASE_DIR / "frontend" / "index.html").read_text(encoding="utf-8")
        app_js = (BASE_DIR / "frontend" / "app.js").read_text(encoding="utf-8")
        srv_py = (BASE_DIR / "backend" / "server.py").read_text(encoding="utf-8")

        self.assertIn('id="stk-scan-input"', idx_html)
        self.assertIn('id="btn-stk-toggle-stock-filter"', idx_html)
        self.assertIn('id="stk-items-search-filter"', idx_html)
        self.assertIn('id="btn-stk-store-search-mode"', idx_html)
        self.assertIn('id="stk-store-search-summary"', idx_html)
        self.assertIn("if path == '/api/stock/preinventory-search':", srv_py)
        self.assertIn("if path == '/api/stock/store/search':", srv_py)
        self.assertIn('/api/stock/preinventory-search?query=', app_js[app_js.index('fetchAndRenderStkCatalogSearch'):])
        self.assertIn('/api/stock/store/search?store_no=', app_js[app_js.index('loadCurrentStoreItems'):])


if __name__ == "__main__":
    unittest.main(verbosity=2)
