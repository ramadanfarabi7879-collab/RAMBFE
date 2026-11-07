# -*- coding: utf-8 -*-
import unittest
import os
import sqlite3
import pandas as pd
from backend.catalog_importer import (
    parse_tax_rate_cell,
    suggest_columns_mapping,
    inspect_excel_catalog,
    commit_import_catalog
)
from backend.db import search_products, get_product_by_code, save_or_update_product

class TestTaxAndSearchFeatures(unittest.TestCase):

    def test_parse_tax_rate_cell(self):
        """اختبار دالة استخراج وتفسير الضريبة"""
        # VAT / True -> 15%
        self.assertEqual(parse_tax_rate_cell("VAT"), (True, 15.0))
        self.assertEqual(parse_tax_rate_cell("vat"), (True, 15.0))
        self.assertEqual(parse_tax_rate_cell("True"), (True, 15.0))
        self.assertEqual(parse_tax_rate_cell("خاضع للضريبة"), (True, 15.0))
        self.assertEqual(parse_tax_rate_cell("خاضع"), (True, 15.0))
        self.assertEqual(parse_tax_rate_cell(True), (True, 15.0))

        # FALSE / False -> 0%
        self.assertEqual(parse_tax_rate_cell("FALSE"), (True, 0.0))
        self.assertEqual(parse_tax_rate_cell("false"), (True, 0.0))
        self.assertEqual(parse_tax_rate_cell(False), (True, 0.0))
        self.assertEqual(parse_tax_rate_cell("0"), (True, 0.0))
        self.assertEqual(parse_tax_rate_cell("0.0"), (True, 0.0))
        self.assertEqual(parse_tax_rate_cell("غير خاضع"), (True, 0.0))
        self.assertEqual(parse_tax_rate_cell("معفى"), (True, 0.0))

        # أرقام ونسب مئوية
        self.assertEqual(parse_tax_rate_cell("15%"), (True, 15.0))
        self.assertEqual(parse_tax_rate_cell("15"), (True, 15.0))
        self.assertEqual(parse_tax_rate_cell(15), (True, 15.0))
        self.assertEqual(parse_tax_rate_cell("14%"), (True, 14.0))
        self.assertEqual(parse_tax_rate_cell(0.15), (True, 15.0))

        # فارغ / NaN -> غير محدد (False, 0.0)
        self.assertEqual(parse_tax_rate_cell(""), (False, 0.0))
        self.assertEqual(parse_tax_rate_cell(None), (False, 0.0))
        self.assertEqual(parse_tax_rate_cell("nan"), (False, 0.0))
        self.assertEqual(parse_tax_rate_cell("<NA>"), (False, 0.0))

    def test_suggest_columns_mapping_tax(self):
        """اختبار التعرف الذكي على عمود CUSTOMER TAX في مختلف الملفات"""
        h1 = ['Sequence', 'Internal Reference', 'Name', 'CUSTOMER TAX', 'Sales Price']
        s1 = suggest_columns_mapping(h1)
        self.assertEqual(s1.get('tax_rate_col'), 'CUSTOMER TAX')

        h2 = ['Code', 'Product Name', 'Customer Taxes', 'Price']
        s2 = suggest_columns_mapping(h2)
        self.assertEqual(s2.get('tax_rate_col'), 'Customer Taxes')

        h3 = ['كود الصنف', 'اسم الصنف', 'نسبة الضريبة', 'السعر']
        s3 = suggest_columns_mapping(h3)
        self.assertEqual(s3.get('tax_rate_col'), 'نسبة الضريبة')

    def test_excel_tax_import_lifecycle(self):
        """اختبار دورة استيراد ملف إكسيل كامل مع عمود CUSTOMER TAX"""
        test_file = "temp/test_tax_import_lifecycle.xlsx"
        os.makedirs("temp", exist_ok=True)

        df = pd.DataFrame([
            {"Internal Reference": "TAX-TEST-01", "Name": "TAXABLE ITEM 1", "Sales Price": 50.0, "CUSTOMER TAX": "VAT"},
            {"Internal Reference": "TAX-TEST-02", "Name": "NON TAXABLE ITEM 2", "Sales Price": 30.0, "CUSTOMER TAX": "FALSE"},
            {"Internal Reference": "TAX-TEST-03", "Name": "EMPTY TAX ITEM 3", "Sales Price": 20.0, "CUSTOMER TAX": None}
        ])
        df.to_excel(test_file, index=False)

        info = inspect_excel_catalog(test_file)
        self.assertTrue(info.get('success'))
        self.assertEqual(info['suggested_mapping']['tax_rate_col'], 'CUSTOMER TAX')

        res = commit_import_catalog(test_file, info['suggested_mapping'], replace_barcodes=False)
        self.assertTrue(res.get('success'))

        p1 = get_product_by_code("TAX-TEST-01")
        self.assertIsNotNone(p1)
        self.assertEqual(p1['tax_rate'], 15.0, "الصنف الأول ذو قيمة VAT يجب أن يكون خاضعاً للضريبة بنسبة 15%")

        p2 = get_product_by_code("TAX-TEST-02")
        self.assertIsNotNone(p2)
        self.assertEqual(p2['tax_rate'], 0.0, "الصنف الثاني ذو قيمة FALSE يجب أن يكون غير خاضع للضريبة (0%)")

        p3 = get_product_by_code("TAX-TEST-03")
        self.assertIsNotNone(p3)
        self.assertEqual(p3['tax_rate'], 0.0, "الصنف الثالث ذو القيمة الفارغة يجب أن يكون الافتراضي غير خاضع (0%)")

        # تنظيف
        if os.path.exists(test_file):
            os.remove(test_file)

    def test_product_search_modes(self):
        """اختبار البحث الافتراضي (البداية فقط) والبحث المعمم (في أي مكان)"""
        # التأكد من وجود أصناف اختبارية
        save_or_update_product({
            "code": "SRCH-001",
            "name_en": "ADOL EXTRA 500MG",
            "name_ar": "أدول إكسترا 500 ملغ",
            "selling_price": 10.0
        })
        save_or_update_product({
            "code": "SRCH-002",
            "name_en": "PANADOL COLD AND FLU",
            "name_ar": "بنادول كولد آند فلو",
            "selling_price": 15.0
        })

        # 1. البحث في وضع البداية الافتراضي (start)
        res_start = search_products("ADOL", limit=20, match_mode="start")
        start_names = [p['name_en'] or p['name'] for p in res_start['items']]
        self.assertIn("ADOL EXTRA 500MG", start_names, "يجب أن يظهر ADOL في وضع البداية")
        self.assertNotIn("PANADOL COLD AND FLU", start_names, "يجب ألا يظهر PANADOL في وضع البداية الافتراضي عند البحث عن ADOL")

        # 2. البحث في وضع المعمم (contains)
        res_contains = search_products("ADOL", limit=20, match_mode="contains")
        contains_names = [p['name_en'] or p['name'] for p in res_contains['items']]
        self.assertIn("ADOL EXTRA 500MG", contains_names, "يجب أن يظهر ADOL في وضع البحث المعمم")
        self.assertIn("PANADOL COLD AND FLU", contains_names, "يجب أن يظهر PANADOL في وضع البحث المعمم لاحتوائه على ADOL في المنتصف")

        # 3. اختبار كود الصنف
        res_code_start = search_products("001", limit=20, match_mode="start")
        start_codes = [p['code'] for p in res_code_start['items']]
        self.assertNotIn("SRCH-001", start_codes, "كود SRCH-001 لا يبدأ بـ 001 فلا يظهر في وضع البداية")

        res_code_contains = search_products("SRCH-001", limit=20, match_mode="contains")
        contains_codes = [p['code'] for p in res_code_contains['items']]
        self.assertIn("SRCH-001", contains_codes, "يجب أن يظهر كود الصنف في وضع البحث المعمم")

if __name__ == '__main__':
    unittest.main()
