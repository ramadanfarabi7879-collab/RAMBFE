import unittest
import json
import urllib.request
import urllib.parse
from backend.qr_parser import parse_qr_code, extract_clean_gtin
from backend.db import get_connection, save_or_update_product, search_products, get_product_by_code, init_db

import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from live_server import start_live_server, stop_live_server, base_url


def setUpModule():
    # خادم البرنامج على منفذ فاضي بنسخة مؤقتة من قاعدة البيانات وبدون سحابة
    start_live_server()


def tearDownModule():
    stop_live_server()

class TestGs1InspectionAndAutocomplete(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        init_db()

    @classmethod
    def tearDownClass(cls):
        with get_connection() as conn:
            cur = conn.cursor()
            cur.execute("DELETE FROM products WHERE code LIKE '9988%'")
            cur.execute("DELETE FROM product_barcodes WHERE product_code LIKE '9988%'")
            conn.commit()

    def test_01_gs1_qr_parsing_all_four_components(self):
        """
        اختبار قراءة كود GS1 واستخراج الحقول الأربعة المنفصلة:
        - GTIN
        - Serial Number (SN)
        - Batch Number (LOT)
        - Expiry Date (EXP)
        """
        # نموذج 1: أكواد بين أقواس GS1 Application Identifiers
        raw_brackets = "(01)06281001112223(17)261031(10)BT456(21)SN789"
        res = parse_qr_code(raw_brackets)
        self.assertTrue(res["success"])
        data = res["data"]
        self.assertEqual(data["gtin"], "06281001112223")
        self.assertEqual(data["batch"], "BT456")
        self.assertEqual(data["serial"], "SN789")
        self.assertTrue(data["expiry"].startswith("2026-10"))

        # نموذج 2: كود GS1 مع فاصل ASCII 29 / \x1d
        raw_fnc1 = "01062810011122231726103110BT456\x1d21SN789"
        res2 = parse_qr_code(raw_fnc1)
        self.assertTrue(res2["success"])
        data2 = res2["data"]
        self.assertEqual(data2["gtin"], "06281001112223")
        self.assertEqual(data2["batch"], "BT456")
        self.assertEqual(data2["serial"], "SN789")

        # نموذج 3: GS1 Digital Link URL
        raw_url = "https://id.gs1.org/01/06281001112223/10/BT456/21/SN789?17=261031"
        res3 = parse_qr_code(raw_url)
        self.assertTrue(res3["success"])
        data3 = res3["data"]
        self.assertEqual(data3["gtin"], "06281001112223")
        self.assertEqual(data3["batch"], "BT456")
        self.assertEqual(data3["serial"], "SN789")

    def test_02_server_endpoint_parse_gs1(self):
        """
        اختبار واجهة الخادم /api/catalog/parse-gs1
        """
        url = base_url() + "/api/catalog/parse-gs1"
        req_data = {
            "raw": "(01)06281001112223(17)261031(10)BT456(21)SN789"
        }
        req = urllib.request.Request(
            url,
            data=json.dumps(req_data).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data["success"])
            self.assertTrue(data["is_gs1"])
            self.assertEqual(data["gtin"], "06281001112223")
            self.assertEqual(data["batch"], "BT456")
            self.assertEqual(data["serial"], "SN789")
            self.assertTrue(data["expiry"].startswith("2026-10"))

    def test_03_final_filtering_only_gtin_saved(self):
        """
        اختبار مرحلة الفلترة النهائية:
        - يتم الاحتفاظ برقم GTIN فقط (14 رقماً)
        - لا يتم حفظ Serial Number داخل خانة GTIN أو قاعدة البيانات
        - لا يتم حفظ Batch Number داخل خانة GTIN
        - لا يتم حفظ Expiry Date داخل خانة GTIN
        """
        raw_qr = "(01)06281001112223(17)261031(10)BT456(21)SN789"
        # استخراج GTIN فقط للمرحلة النهائية
        clean_gtin = extract_clean_gtin(raw_qr)
        self.assertEqual(clean_gtin, "06281001112223")
        self.assertEqual(len(clean_gtin), 14)

        # حفظ الصنف بالـ GTIN المفلتر فقط
        test_code = "9988001"
        ok, msg, code = save_or_update_product({
            "code": test_code,
            "name_ar": "صنف تجربة GS1 مفلتر",
            "name_en": "Filtered GS1 Test Item",
            "gtin_list": [clean_gtin],
            "barcode_list": ["1234567890128"],
            "selling_price": 50.0,
            "unit_price": 35.0,
            "tax_rate": 0.0
        })
        self.assertTrue(ok)

        # استرجاع الصنف والتأكد من عدم وجود SN أو LOT أو Expiry في الباركودات
        prod = get_product_by_code(test_code)
        self.assertIsNotNone(prod)
        self.assertEqual(prod["gtin_list"], ["06281001112223"])
        self.assertNotIn("SN789", prod["gtin_list"])
        self.assertNotIn("BT456", prod["gtin_list"])
        self.assertNotIn("261031", prod["gtin_list"])

        with get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("SELECT barcode, barcode_type FROM product_barcodes WHERE product_code = ?", (test_code,))
            rows = cursor.fetchall()
            saved_codes = [r["barcode"] for r in rows]
            self.assertIn("06281001112223", saved_codes)
            self.assertIn("1234567890128", saved_codes)
            self.assertNotIn("SN789", saved_codes)
            self.assertNotIn("BT456", saved_codes)
            self.assertNotIn("261031", saved_codes)

    def test_04_autocomplete_search_api_multiple_items(self):
        """
        اختبار API البحث بالاقتراحات التلقائية والبحث المتعدد
        """
        # إضافة صنفين للاختبار
        ok1, _, code1 = save_or_update_product({
            "code": "9988002",
            "name_ar": "بنادول إكسترا أقراص مميز",
            "name_en": "Panadol Unique Extra Tablets",
            "gtin_list": ["06281001999001"],
            "barcode_list": ["6281001999001"],
            "selling_price": 12.50,
            "unit_price": 9.0,
            "tax_rate": 0.0
        })
        self.assertTrue(ok1)

        ok2, _, code2 = save_or_update_product({
            "code": "9988003",
            "name_ar": "أوجمنتين 1 جم أقراص مميز",
            "name_en": "Augmentin Unique 1g Tablets",
            "gtin_list": ["06281001999002"],
            "barcode_list": ["6281001999002"],
            "selling_price": 65.0,
            "unit_price": 48.0,
            "tax_rate": 0.0
        })
        self.assertTrue(ok2)

        # فحص استعلام Autocomplete لصنف Panadol
        url1 = base_url() + "/api/catalog/products?query=Panadol%20Unique&limit=10&offset=0"
        with urllib.request.urlopen(url1) as resp:
            data1 = json.loads(resp.read().decode("utf-8"))
            items1 = data1.get("items", [])
            codes1 = [it["code"] for it in items1]
            self.assertIn("9988002", codes1)

        # فحص استعلام Autocomplete لصنف Augmentin
        url2 = base_url() + "/api/catalog/products?query=Augmentin%20Unique&limit=10&offset=0"
        with urllib.request.urlopen(url2) as resp:
            data2 = json.loads(resp.read().decode("utf-8"))
            items2 = data2.get("items", [])
            codes2 = [it["code"] for it in items2]
            self.assertIn("9988003", codes2)

        # محاكاة التجميع في الـ Map ومنع التكرار
        accumulated = {}
        # إضافة صنف 1
        item1 = next(it for it in items1 if it["code"] == "9988002")
        accumulated[item1["code"]] = item1
        self.assertEqual(len(accumulated), 1)

        # إضافة صنف 2
        item2 = next(it for it in items2 if it["code"] == "9988003")
        accumulated[item2["code"]] = item2
        self.assertEqual(len(accumulated), 2)

        # محاولة إضافة صنف 1 مرة أخرى (يجب منع التكرار)
        is_duplicate = item1["code"] in accumulated
        self.assertTrue(is_duplicate)
        if not is_duplicate:
            accumulated[item1["code"]] = item1
        self.assertEqual(len(accumulated), 2)  # بقي 2 دون تكرار

        # اختبار حذف صنف مفرد
        del accumulated["9988002"]
        self.assertEqual(len(accumulated), 1)
        self.assertIn("9988003", accumulated)

    def test_05_saudi_datamatrix_qr_and_multi_select_flow(self):
        """
        اختبار قراءة كود داتا ماتريكس السعودي الصيدلاني المركب
        واستخراج الحقول الأربعة وفلترة GTIN بدقة 100%
        ومحاكاة التحديد المتعدد عبر Checkbox لمجموعتين مختلفتين
        """
        # كود الداتا ماتريكس الفعلي الموضح في صورة ومواصفات المستخدم
        raw_saudi = "010629110373043521lrn4u0449708qi1727041610c753"

        # 1. اختبار استدعاء الخادم لـ parse-gs1
        url = base_url() + "/api/catalog/parse-gs1"
        req = urllib.request.Request(
            url,
            data=json.dumps({"raw": raw_saudi}).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data["success"])
            self.assertTrue(data["is_gs1"])
            self.assertEqual(data["gtin"], "06291103730435")
            self.assertEqual(data["serial"], "LRN4U0449708QI")  # السيريال بأحرف كبيرة عمداً (commit 4807039)
            self.assertEqual(data["batch"], "C753")  # الباتش بأحرف كبيرة عمداً (commit 4807039)
            self.assertEqual(data["expiry"], "2027-04-16")

        # 2. التأكد من أن الفلترة النهائية تعتمد GTIN فقط
        clean = extract_clean_gtin(raw_saudi)
        self.assertEqual(clean, "06291103730435")
        self.assertNotIn("lrn4u", clean)
        self.assertNotIn("c753", clean)

        # 3. محاكاة التحديد المتعدد لمجموعتين:
        # إضافة 3 أصناف بنادول
        save_or_update_product({"code": "9988011", "name_ar": "بنادول أدفانس", "name_en": "Panadol Advance 500", "selling_price": 6.5, "unit_price": 5.0, "tax_rate": 0.0, "barcode_list": ["628011"], "gtin_list": ["06280000000011"]})
        save_or_update_product({"code": "9988012", "name_ar": "بنادول إكسترا أحمر", "name_en": "Panadol Extra Red", "selling_price": 8.5, "unit_price": 6.5, "tax_rate": 0.0, "barcode_list": ["628012"], "gtin_list": ["06280000000012"]})
        save_or_update_product({"code": "9988013", "name_ar": "بنadول كولد آند فلو", "name_en": "Panadol Cold Flu", "selling_price": 11.0, "unit_price": 8.0, "tax_rate": 0.0, "barcode_list": ["628013"], "gtin_list": ["06280000000013"]})

        # إضافة صنفين بروفين
        save_or_update_product({"code": "9988021", "name_ar": "بروفين 400 مجم", "name_en": "Brufen 400mg", "selling_price": 14.0, "unit_price": 10.0, "tax_rate": 0.0, "barcode_list": ["628021"], "gtin_list": ["06280000000021"]})
        save_or_update_product({"code": "9988022", "name_ar": "بروفين 600 مجم فوار", "name_en": "Brufen 600mg Effervescent", "selling_price": 19.5, "unit_price": 15.0, "tax_rate": 0.0, "barcode_list": ["628022"], "gtin_list": ["06280000000022"]})

        # المستخدم بحث عن "Panadol" فظهرت 3 أصناف
        url_panadol = base_url() + "/api/catalog/products?query=Panadol&limit=10&offset=0"
        with urllib.request.urlopen(url_panadol) as resp:
            panadol_results = json.loads(resp.read().decode("utf-8"))["items"]
            self.assertGreaterEqual(len(panadol_results), 3)

        # المستخدم حدد صنفين فقط من البنادول عبر الـ Checkbox (9988011 و 9988012) ولم يختر 9988013
        selected_panadol = [it for it in panadol_results if it["code"] in ("9988011", "9988012")]
        self.assertEqual(len(selected_panadol), 2)

        # ضغط المستخدم زر "إضافة الأصناف المحددة"
        accumulated_table = {}
        for it in selected_panadol:
            accumulated_table[it["code"]] = it
        self.assertEqual(len(accumulated_table), 2)
        self.assertIn("9988011", accumulated_table)
        self.assertIn("9988012", accumulated_table)
        self.assertNotIn("9988013", accumulated_table)

        # تم مسح خانة البحث وبحث المستخدم عن "Brufen"
        url_brufen = base_url() + "/api/catalog/products?query=Brufen&limit=10&offset=0"
        with urllib.request.urlopen(url_brufen) as resp:
            brufen_results = json.loads(resp.read().decode("utf-8"))["items"]
            self.assertGreaterEqual(len(brufen_results), 2)

        # المستخدم حدد صنفين من البروفين عبر Checkbox
        selected_brufen = [it for it in brufen_results if it["code"] in ("9988021", "9988022")]
        self.assertEqual(len(selected_brufen), 2)

        # ضغط المستخدم زر "إضافة الأصناف المحددة"
        for it in selected_brufen:
            accumulated_table[it["code"]] = it

        # التحقق الحاسم: الجدول الآن يحتوي على أصناف البنادول السابقة + أصناف البروفين الجديدة (إجمالي 4 أصناف)
        self.assertEqual(len(accumulated_table), 4)
        self.assertIn("9988011", accumulated_table)
        self.assertIn("9988012", accumulated_table)
        self.assertIn("9988021", accumulated_table)
        self.assertIn("9988022", accumulated_table)

    def test_06_product_card_multi_barcodes_multi_gtin_save_and_retrieve(self):
        """
        اختبار حفظ واسترجاع كرت الصنف بالباركودات المتعددة و GTINs المتعددة
        والتأكد من عدم فقدان أي بيانات وأن الضريبة البديهية 0
        """
        payload = {
            "code": "9988030",
            "name_ar": "صنف تجربة كرت الصنف متعدد الرموز",
            "name_en": "Multi Codes Card Test Product",
            "category": "مكمل غذائي",
            "selling_price": 85.0,
            "unit_price": 60.0,
            "tax_rate": 0.0,
            "primary_barcode": "62899001",
            "extra_barcodes": "62899002,62899003",
            "barcode_list": ["62899001", "62899002", "62899003"],
            "primary_gtin": "06289900000001",
            "extra_gtins": "06289900000002,06289900000003",
            "gtin_list": ["06289900000001", "06289900000002", "06289900000003"]
        }

        # حفظ عبر API الخادم
        url_save = base_url() + "/api/catalog/save"
        req = urllib.request.Request(
            url_save,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data["success"])

        # استرجاع عبر API الخادم
        url_get = base_url() + "/api/catalog/product?code=9988030"
        with urllib.request.urlopen(url_get) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(data["success"])
            p = data["product"]
            self.assertEqual(p["code"], "9988030")
            self.assertEqual(p["tax_rate"], 0.0)
            self.assertEqual(len(p["barcode_list"]), 3)
            self.assertEqual(p["barcode_list"], ["62899001", "62899002", "62899003"])
            self.assertEqual(len(p["gtin_list"]), 3)
            self.assertEqual(p["gtin_list"], ["06289900000001", "06289900000002", "06289900000003"])

    def test_07_batch_with_production_date_ai11(self):
        """
        اختبار فك واستخراج الباتش بدقة عند وجود تاريخ الإنتاج AI 11 وتاريخ الانتهاء AI 17
        مثال باركود المستخدم الحقيقي:
        010628512800030710}[03711125070117280701212072049045215
        - يجب أن يستخرج الباتش CF0371 فقط دون ابتلاع 11250701
        - يجب أن يستخرج تاريخ الصلاحية 2028-07-01
        - يجب أن يستخرج تاريخ الإنتاج 2025-07-01
        - يجب أن يستخرج السيريال 2072049045215
        """
        raw_code = "010628512800030710}[03711125070117280701212072049045215"

        # 1. اختبار استدعاء الدالة المباشرة
        res = parse_qr_code(raw_code)
        self.assertTrue(res["success"])
        data = res["data"]
        self.assertEqual(data["gtin"], "06285128000307")
        self.assertEqual(data["batch"], "CF0371")
        self.assertEqual(data["serial"], "2072049045215")
        self.assertEqual(data["expiry"], "2028-07-01")
        self.assertEqual(data["prod_date"], "2025-07-01")

        # 2. اختبار عبر واجهة الخادم /api/catalog/parse-gs1
        url = base_url() + "/api/catalog/parse-gs1"
        req = urllib.request.Request(
            url,
            data=json.dumps({"raw": raw_code}).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req) as resp:
            server_data = json.loads(resp.read().decode("utf-8"))
            self.assertTrue(server_data["success"])
            self.assertTrue(server_data["is_gs1"])
            self.assertEqual(server_data["gtin"], "06285128000307")
            self.assertEqual(server_data["batch"], "CF0371")
            self.assertEqual(server_data["serial"], "2072049045215")
            self.assertEqual(server_data["expiry"], "2028-07-01")
            self.assertEqual(server_data["prod_date"], "2025-07-01")

        # 3. اختبار مسح الصنف في الفاتورة والتأكد من حفظ رقم الباتش CF0371
        from backend.db import create_new_invoice, scan_qr_to_invoice, get_invoice_details, clear_invoice_lines
        inv = create_new_invoice(notes="فاتورة تجربة باتش")
        inv_id = inv["id"]
        try:
            scan_res = scan_qr_to_invoice(inv_id, raw_code)
            self.assertTrue(scan_res["success"])
            self.assertEqual(scan_res["batch"], "CF0371")
            self.assertEqual(scan_res["expiry"], "2028-07-01")

            # استرجاع أسطر الفاتورة
            inv_full = get_invoice_details(inv_id)
            lines = inv_full.get("lines", [])
            self.assertEqual(len(lines), 1)
            self.assertEqual(lines[0]["batch_number"], "CF0371")
            self.assertEqual(lines[0]["product_code"], "14013")
        finally:
            clear_invoice_lines(inv_id)

    def test_08_auto_open_excel_on_export(self):
        """
        اختبار سحب أصناف الفاتورة وفتح ملف Excel أوتوماتيكياً:
        - التحقق من إنشاء ملف الإكسيل بالأعمدة الـ 7 المعتمدة
        - التحقق من استجابة واجهة /api/invoice/open-excel
        - التحقق من استجابة واجهة /api/invoice/export-excel
        """
        from backend.db import create_new_invoice, scan_qr_to_invoice, clear_invoice_lines
        inv = create_new_invoice(notes="فاتورة اختبار الفتح التلقائي")
        inv_id = inv["id"]
        try:
            # مسح كود الصنف التجريبي 14013
            scan_qr_to_invoice(inv_id, "010628512800030710}[03711125070117280701212072049045215")

            # 1. اختبار استدعاء /api/invoice/open-excel
            url_open = f"{base_url()}/api/invoice/open-excel?id={inv_id}"
            with urllib.request.urlopen(url_open) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                self.assertTrue(data["success"])
                self.assertIn("Invoice_", data["file_name"])

            # 2. اختبار سحب وتصدير الفاتورة عبر /api/invoice/export-excel
            url_export = f"{base_url()}/api/invoice/export-excel?id={inv_id}"
            with urllib.request.urlopen(url_export) as resp:
                self.assertEqual(resp.status, 200)
                content_type = resp.headers.get("Content-Type", "")
                self.assertIn("spreadsheetml", content_type)
                content = resp.read()
                self.assertGreater(len(content), 1000)
        finally:
            clear_invoice_lines(inv_id)

    def test_09_second_excel_stock_count_format(self):
        """
        اختبار الإكسيل الثاني (نموذج الجرد والكميات) بالأعمدة الستة:
        Product | NAME ENGLISH | Location | Lot/Serial Number | Expiry Date | Counted quantity
        """
        import openpyxl
        from backend.excel_exporter import export_invoice_stock_count_to_excel, EXCEL_STOCK_COUNT_COLUMNS_6
        from backend.db import create_new_invoice, scan_qr_to_invoice, get_invoice_details, clear_invoice_lines

        self.assertEqual(EXCEL_STOCK_COUNT_COLUMNS_6, [
            "Product",
            "NAME ENGLISH",
            "Location",
            "Lot/Serial Number",
            "Expiry Date",
            "Counted quantity"
        ])

        inv = create_new_invoice(notes="فاتورة اختبار الإكسيل الثاني")
        inv_id = inv["id"]
        try:
            scan_qr_to_invoice(inv_id, "010629110373043521bq0amv92d356qc1727041610c753")
            scan_qr_to_invoice(inv_id, "010629110373043521lrn4u0449708qi1727041610c753")
            inv_details = get_invoice_details(inv_id)
            out_file = export_invoice_stock_count_to_excel(inv_details, "temp/test_stock_count_6cols.xlsx")
            wb = openpyxl.load_workbook(out_file)
            ws = wb.active
            rows = list(ws.iter_rows(values_only=True))
            self.assertEqual(list(rows[0]), [
                "Product",
                "NAME ENGLISH",
                "Location",
                "Lot/Serial Number",
                "Expiry Date",
                "Counted quantity"
            ])
            self.assertEqual(rows[1][0], "27660")
            self.assertEqual(rows[1][1], "EMIFEN 600 20 TABLETS")
            self.assertIn(rows[1][2], ("", None))
            self.assertEqual(rows[1][3], "C753")
            self.assertEqual(rows[1][4], "2027-04-16")
            self.assertEqual(rows[1][5], 2)
        finally:
            clear_invoice_lines(inv_id)

    def test_10_custom_columns_excel_export(self):
        """
        اختبار التصدير بالمسميات المختارة يدوياً (مثلاً دمج Lot/Serial Number مع Counted quantity أو PRODUCT):
        """
        import openpyxl
        from backend.excel_exporter import export_invoice_custom_columns_to_excel
        from backend.db import create_new_invoice, scan_qr_to_invoice, get_invoice_details, clear_invoice_lines

        inv = create_new_invoice(notes="فاتورة اختبار المسميات المختارة يدوياً")
        inv_id = inv["id"]
        try:
            scan_qr_to_invoice(inv_id, "010629110373043521bq0amv92d356qc1727041610c753")
            inv_details = get_invoice_details(inv_id)
            custom_specs = [
                {"field": "product_code", "header": "PRODUCT"},
                {"field": "name_en", "header": "NAME ENGLISH"},
                {"field": "batch_number", "header": "Lot/Serial Number"},
                {"field": "quantity", "header": "Counted quantity"},
                {"field": "expiry_date", "header": "Expiry Date"}
            ]
            out_file = export_invoice_custom_columns_to_excel(inv_details, "temp/test_custom_cols.xlsx", custom_specs)
            wb = openpyxl.load_workbook(out_file)
            ws = wb.active
            rows = list(ws.iter_rows(values_only=True))
            self.assertEqual(list(rows[0]), [
                "PRODUCT",
                "NAME ENGLISH",
                "Lot/Serial Number",
                "Counted quantity",
                "Expiry Date"
            ])
            self.assertEqual(rows[1][0], "27660")
            self.assertEqual(rows[1][1], "EMIFEN 600 20 TABLETS")
            self.assertEqual(rows[1][2], "C753")
            self.assertEqual(rows[1][3], 1)
            self.assertEqual(rows[1][4], "2027-04-16")
        finally:
            clear_invoice_lines(inv_id)

if __name__ == '__main__':
    unittest.main()
