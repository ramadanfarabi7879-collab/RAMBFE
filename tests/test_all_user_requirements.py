import os
import sys
import unittest
import openpyxl

from backend.db import init_db, get_connection, create_new_invoice, get_invoice_details, scan_qr_to_invoice, find_product_by_gtin_or_barcode
from backend.catalog_importer import inspect_excel_catalog, preview_import_catalog, commit_import_catalog
from backend.excel_exporter import export_invoice_to_excel, EXCEL_COLUMNS_7

class TestAllUserRequirements(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        test_db = os.path.abspath("data/test_inventory.db")
        if os.path.exists(test_db):
            try:
                os.remove(test_db)
            except:
                pass
        os.environ["INVENTORY_DB_PATH"] = test_db
        init_db()

    @classmethod
    def tearDownClass(cls):
        test_db = os.environ.pop("INVENTORY_DB_PATH", None)
        if test_db and os.path.exists(test_db):
            try:
                os.remove(test_db)
            except:
                pass

    def test_01_catalog_upload_and_mapping(self):
        """المعيار 1: رفع كرت الصنف وتحديد الأعمدة يدويًا بدون ربط تلقائي وتوليد الأكواد الداخلية تلقائياً"""
        catalog_path = os.path.abspath('sample_data/catalog_sample_official.xlsx')
        self.assertTrue(os.path.exists(catalog_path), "ملف كرت الصنف التجريبي غير موجود")

        # 1. فحص أعمدة الملف
        inspect_res = inspect_excel_catalog(catalog_path)
        self.assertTrue(inspect_res["success"])
        headers = inspect_res["headers"]
        self.assertIn("اسم الصنف عربي", headers)
        self.assertIn("رقم بند التجارة GTIN 1", headers)

        # 2. تعيين الأعمدة يدوياً
        mapping = {
            "name_ar": "اسم الصنف عربي",
            "name_en": "اسم الصنف إنجليزي",
            "code": "",  # تركها فارغة ليولد النظام الكود تلقائياً
            "barcode_columns": ["الباركود 1", "الباركود 2 (إضافي)"],
            "gtin_columns": ["رقم بند التجارة GTIN 1", "رقم بند التجارة GTIN 2 (إضافي)"],
            "selling_price": "سعر البيع",
            "unit_price": "سعر الوحدة والتكلفة",
            "tax_rate": "نسبة الضريبة",
            "category": "التصنيف",
            "unit": "الوحدة الأساسية"
        }

        # 3. معاينة الاستيراد
        preview_res = preview_import_catalog(catalog_path, mapping)
        self.assertTrue(preview_res["success"])
        self.assertEqual(preview_res["valid_count"], 4)

        # 4. تأكيد وحفظ الاستيراد
        commit_res = commit_import_catalog(catalog_path, mapping)
        self.assertTrue(commit_res["success"])
        self.assertGreaterEqual(commit_res["imported_count"], 4)

        # 5. التحقق من قاعدة البيانات: الأكواد مولدة تلقائياً ورقمية فريدة للأصناف المستوردة
        conn = get_connection()
        c = conn.cursor()
        c.execute("SELECT code, gtin, barcode, name_ar, name_en, selling_price FROM products WHERE name_en IN ('Panadol Advance 500mg 24 Tablets', 'Augmentin 625mg 14 Tablets', 'Congestal Cold and Flu 20 Tablets', 'Vitamin C Effervescent 1000mg')")
        products = [dict(r) for r in c.fetchall()]
        conn.close()

        codes = [p["code"] for p in products]
        # التحقق من أن الأكواد رقمية وفريدة
        self.assertEqual(len(codes), len(set(codes)), "يوجد تكرار في الأكواد الداخلية")
        for code in codes:
            self.assertTrue(code.isdigit(), f"الكود الداخلي {code} ليس رقمياً")

        # التحقق من التعرف على الأصناف بواسطة GTIN مع الحفاظ على الأصفار في البداية
        p1 = find_product_by_gtin_or_barcode("06281086001234")
        self.assertIsNotNone(p1, "فشل العثور على صنف البنادول عبر GTIN المحتوي على صفر بالبداية")
        self.assertIn("بنادول", p1["name_ar"])

        p2 = find_product_by_gtin_or_barcode("06291103730435")
        self.assertIsNotNone(p2, "فشل العثور على صنف الأوجمنتين عبر GTIN الخاص بصورة المستخدم")
        self.assertIn("أوجمنتين", p2["name_ar"])

    def test_02_scanner_entry_and_datamatrix_extraction(self):
        """المعيار 2: إدخال الأصناف بالماسح واستخراج GTIN والباتش والسيريال وتاريخ الصلاحية وإضافة عبوة تلقائياً"""
        inv = create_new_invoice(notes="فاتورة اختبار المسح", user_name="المسؤول")
        inv_id = inv["id"]

        # كود الداتا ماتريكس الموضح في صورة المستخدم
        dm_string = "010629110373043521lrn4u0449708qi1727041610c753"

        scan_res = scan_qr_to_invoice(inv_id, dm_string, user_name="المسؤول")
        self.assertTrue(scan_res["success"], f"فشل مسح كود الصورة: {scan_res.get('message')}")
        self.assertEqual(scan_res["line_qty"], 1)
        self.assertEqual(scan_res["batch"].lower(), "c753")
        self.assertEqual(scan_res["expiry"], "2027-04-16")
        # السيريال يُحفظ بأحرف كبيرة عمداً منذ commit 4807039 (توحيد الباتش والسيريال لمنع تكرار نفس العبوة)
        self.assertEqual(scan_res["serial"], "LRN4U0449708QI")

        # التحقق من تفاصيل الفاتورة
        details = get_invoice_details(inv_id)
        self.assertEqual(details["total_packages"], 1)
        self.assertEqual(len(details["lines"]), 1)
        line = details["lines"][0]
        self.assertEqual(line["batch_number"].lower(), "c753")
        self.assertEqual(line["quantity"], 1)
        self.assertEqual(line["expiry_date"], "2027-04-16")

    def test_03_batch_grouping_and_duplicate_rejection(self):
        """المعيار 3: تجميع الباتشات المتطابقة في سطر واحد ورفض السيريال المكرر وفصل الباتش المختلف بسطر مستقل"""
        inv = create_new_invoice(notes="فاتورة اختبار التجميع", user_name="المسؤول")
        inv_id = inv["id"]

        import uuid
        uid = uuid.uuid4().hex[:4]

        # 1. مسح عبوة أولى: الباتش 456، السيريال A001
        sn_a1 = f"A001_{uid}"
        sn_a2 = f"A002_{uid}"
        sn_b1 = f"B001_{uid}"

        qr1 = f"(01)06281086001234(17)261031(10)456(21){sn_a1}"
        res1 = scan_qr_to_invoice(inv_id, qr1)
        self.assertTrue(res1["success"])
        self.assertEqual(res1["line_qty"], 1)

        # 2. مسح عبوة ثانية نفس الباتش 456، سيريال A002 -> تزيد الكمية إلى 2 في السطر نفسه
        qr2 = f"(01)06281086001234(17)261031(10)456(21){sn_a2}"
        res2 = scan_qr_to_invoice(inv_id, qr2)
        self.assertTrue(res2["success"])
        self.assertEqual(res2["line_qty"], 2)

        # 3. إعادة مسح السيريال A001 -> يرفض البرنامج احتسابه مرة أخرى ولا يزيد العدد
        res3 = scan_qr_to_invoice(inv_id, qr1)
        self.assertFalse(res3["success"])
        self.assertEqual(res3["code"], "DUPLICATE_IN_CURRENT")
        self.assertIn("مسجل بالفعل", res3["message"])

        # التأكد من أن الكمية لم تزد
        details_after_dup = get_invoice_details(inv_id)
        line_456 = [l for l in details_after_dup["lines"] if l["batch_number"] == "456"][0]
        self.assertEqual(line_456["quantity"], 2, "زاد العدد بالرغم من تكرار السيريال!")

        # 4. مسح عبوة بباتش مختلف: الباتش 789، السيريال B001 -> ينشئ سطرًا جديدًا واضحًا
        qr4 = f"(01)06281086001234(17)261031(10)789(21){sn_b1}"
        res4 = scan_qr_to_invoice(inv_id, qr4)
        self.assertTrue(res4["success"])
        self.assertEqual(res4["line_qty"], 1)

        # التأكد من وجود سطرين مستقلين
        details_final = get_invoice_details(inv_id)
        self.assertEqual(len(details_final["lines"]), 2, "لم يتم إنشاء سطر مستقل للباتش المختلف!")
        batches_in_invoice = [l["batch_number"] for l in details_final["lines"]]
        self.assertIn("456", batches_in_invoice)
        self.assertIn("789", batches_in_invoice)

        # 5. فحص رفض صنف غير مسجل
        unreg_qr = "(01)00000099999999(17)261031(10)999(21)Z999"
        res_unreg = scan_qr_to_invoice(inv_id, unreg_qr)
        self.assertFalse(res_unreg["success"])
        self.assertEqual(res_unreg["code"], "ITEM_NOT_FOUND")

    def test_04_export_to_excel_7_columns_rtl(self):
        """المعيار 4: تصدير النتيجة إلى Excel بالأعمدة السبعة المعتمدة وترتيب اليمين إلى اليسار وتجميد A2"""
        inv = create_new_invoice(notes="فاتورة اختبار التصدير", user_name="المسؤول")
        inv_id = inv["id"]

        import uuid
        uid = uuid.uuid4().hex[:4]

        # مسح عدة عبوات لتكوين فاتورة جاهزة للتصدير
        scan_qr_to_invoice(inv_id, f"(01)06281086001234(17)261031(10)456(21)EA1_{uid}")
        scan_qr_to_invoice(inv_id, f"(01)06281086001234(17)261031(10)456(21)EA2_{uid}")
        scan_qr_to_invoice(inv_id, f"(01)06281086001234(17)261031(10)789(21)EB1_{uid}")
        scan_qr_to_invoice(inv_id, f"010629110373043521lrn_{uid}1727041610c753")

        inv_details = get_invoice_details(inv_id)
        output_xlsx = os.path.abspath("sample_data/test_exported_invoice.xlsx")
        export_invoice_to_excel(inv_details, output_xlsx)

        self.assertTrue(os.path.exists(output_xlsx), "لم يتم توليد ملف الإكسيل")

        # فتح وقراءة الملف للتأكد من المعايير
        wb = openpyxl.load_workbook(output_xlsx)
        ws = wb.active

        # 1. اتجاه الورقة بالإنجليزية LTR وفق طلب المستخدم
        self.assertFalse(ws.views.sheetView[0].rightToLeft, "ورقة العمل يجب أن تكون بالإنجليزية Left-To-Right")

        # 2. تجميد رأس الجدول على A2
        self.assertEqual(ws.freeze_panes, "A2", "تجميد الخلايا ليس A2")

        # 3. التحقق من الأعمدة السبعة بالترتيب الدقيق
        first_row = [cell.value for cell in ws[1]]
        self.assertEqual(first_row, EXCEL_COLUMNS_7, f"ترتيب أو أسماء الأعمدة غير متطابقة: {first_row}")

        # 4. التحقق من صفوف البيانات والأسماء بالإنجليزية
        rows_data = []
        for r in ws.iter_rows(min_row=2, values_only=True):
            if any(r):
                rows_data.append(r)

        self.assertEqual(len(rows_data), 3, "يجب أن يكون هناك 3 سطور مجمعة (باتش 456، باتش 789، باتش C753)")

        # فحص سطر الباتش 456: يجب أن تكون الكمية 2 واسم الصنف بالإنجليزية وخالياً تماماً من الأحرف العربية
        batch_456_row = [r for r in rows_data if r[3] == "456"][0]
        self.assertEqual(batch_456_row[4], 2, "كمية الباتش 456 في ملف الإكسيل يجب أن تكون 2")
        self.assertTrue(isinstance(batch_456_row[2], (int, float)), "سعر البيع ليس قيمة رقمية")
        self.assertTrue(isinstance(batch_456_row[5], (int, float)), "سعر الوحدة ليس قيمة رقمية")
        self.assertIn("PANADOL", batch_456_row[1].upper(), "اسم الصنف يجب أن يكون بالإنجليزية")

        # التحقق من أن كامل ملف الإكسيل لا يحتوي على أي حرف عربي في البيانات أو العناوين
        import re
        for r_idx, row in enumerate(rows_data, start=2):
            for c_idx, val in enumerate(row):
                if val:
                    self.assertFalse(bool(re.search(r'[\u0600-\u06FF]', str(val))), f"تم العثور على حرف عربي في الصف {r_idx} العمود {c_idx+1}: {val}")

    def test_05_arabic_keyboard_scan_and_search(self):
        """المعيار 5: معالجة ضغطات قارئ الباركود أثناء تفعيل الكيبورد العربي والبحث الذكي بالأصناف"""
        from backend.db import search_products
        
        # 1. فحص مسح باركود أثناء تفعيل اللغة العربية في ويندوز
        inv = create_new_invoice(notes="فاتورة كيبورد عربي", user_name="المسؤول")
        arabic_qr = "010629110373043521ً،~46/4}]7ِ5َ،1727041810}754"
        res = scan_qr_to_invoice(inv["id"], arabic_qr)
        self.assertTrue(res["success"], f"فشل مسح كود الكيبورد العربي: {res.get('message')}")
        self.assertEqual(res["gtin"], "06291103730435")
        self.assertEqual(res["batch"], "C754")
        self.assertEqual(res["serial"], "WKZ46L4CD7A5QK")
        self.assertEqual(res["expiry"], "2027-04-18")

        # 2. فحص البحث الذكي في الأصناف باللغة العربية (مع وبدون همزة)
        search_hamza = search_products("أوجمنتين", 5, 0)
        search_no_hamza = search_products("اوجمنتين", 5, 0)
        self.assertGreaterEqual(search_hamza["total"], 1, "فشل البحث بكلمة أوجمنتين (بالهمزة)")
        self.assertGreaterEqual(search_no_hamza["total"], 1, "فشل البحث بكلمة اوجمنتين (بدون همزة)")

    def test_06_manual_quantity_and_edit(self):
        """المعيار 6: تعديل الكميات يدوياً وإدخال كميات مخصصة للعبوات"""
        from backend.db import update_invoice_line_quantity, add_manual_item_to_invoice
        
        inv = create_new_invoice(notes="فاتورة اختبار تعديل الكمية", user_name="المسؤول")
        inv_id = inv["id"]

        # 1. إدخال يدوي مباشر لكمية 5 عبوات
        res = add_manual_item_to_invoice(inv_id, "06281086001234", "BATCH_MANUAL", "2027-10-10", quantity=5)
        self.assertTrue(res["success"])
        self.assertEqual(res["line_qty"], 5)

        # 2. فحص تفاصيل الفاتورة
        details = get_invoice_details(inv_id)
        self.assertEqual(details["total_packages"], 5)
        line_id = details["lines"][0]["id"]

        # 3. تعديل الكمية يدوياً إلى 12
        upd = update_invoice_line_quantity(inv_id, line_id, 12)
        self.assertTrue(upd["success"])

        # 4. التأكد من انعكاس الكمية الجديدة
        updated_details = get_invoice_details(inv_id)
        self.assertEqual(updated_details["lines"][0]["quantity"], 12)
        self.assertEqual(updated_details["total_packages"], 12)

    def test_07_gtin_extraction_and_tax_manual_default_zero(self):
        """المعيار 7: استخراج GTIN في كرت الصنف مثل سحب الفاتورة وإظهار GTIN فقط، والضريبة بديهياً 0 وإدخال يدوي (منول)"""
        from backend.qr_parser import extract_clean_gtin
        from backend.db import save_or_update_product, get_product_by_code, find_product_by_gtin_or_barcode

        # 1. استخراج GTIN النظيف من صيغ QR متعددة مثل سحب الفاتورة
        raw_dm = "01062911037304351727041810C75321WKZ46L4CD7A5QK"
        clean_gtin = extract_clean_gtin(raw_dm)
        self.assertEqual(clean_gtin, "06291103730435", "فشل استخراج GTIN النظيف من كود DataMatrix")

        raw_parens = "(01)06281086001234(17)261031(10)BT456(21)SN789"
        clean_gtin2 = extract_clean_gtin(raw_parens)
        self.assertEqual(clean_gtin2, "06281086001234", "فشل استخراج GTIN من صيغة الأقواس")

        # 2. حفظ كرت صنف عند مسح كود DataMatrix في خانة الـ GTIN: يجب أن يحفظ ويعرض GTIN فقط
        p_data = {
            "name_ar": "صنف اختبار استخراج جي تي ان",
            "name_en": "TEST GTIN EXTRACTION PRODUCT",
            "gtin_list": [raw_dm],
            "selling_price": 45.0
            # لم يتم تحديد الضريبة -> يجب أن تكون البديهي 0.0
        }
        ok, code, msg = save_or_update_product(p_data)
        self.assertTrue(ok)

        # التحقق من أن المخزن في بطاقة الصنف هو GTIN فقط وليس كامل كود الـ QR
        prod = get_product_by_code(code)
        self.assertEqual(prod["gtin"], "06291103730435", "يجب أن يكون العرض والمخزن رقم GTIN فقط")
        self.assertEqual(prod["tax_rate"], 0.0, "خانة الضريبة يجب أن تكون البديهي 0.0")

        # 3. حفظ صنف مع إدخال الضريبة يدوياً (منول)
        p_manual_tax = {
            "name_ar": "صنف ضريبة يدوية",
            "name_en": "MANUAL TAX PRODUCT",
            "gtin_list": [clean_gtin2],
            "tax_rate": 15.0
        }
        ok2, code2, _ = save_or_update_product(p_manual_tax)
        self.assertTrue(ok2)
        prod2 = get_product_by_code(code2)
        self.assertEqual(prod2["tax_rate"], 15.0, "فشل تعيين الضريبة يدوياً")

if __name__ == '__main__':
    unittest.main()
