import os
import sys
import unittest

# Ensure project root is in path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.invoice_parser import (
    clean_cost_price, find_cost_price_column_idx,
    parse_pdf_invoice, parse_pdf_invoice_with_debug,
    COST_PRICE_KEYWORDS_PRIORITY
)
from backend.matcher import SmartMatcher

class TestCostPriceExtraction(unittest.TestCase):

    def test_clean_cost_price(self):
        # 1. Standard decimals
        self.assertEqual(clean_cost_price("12.50"), 12.50)
        self.assertEqual(clean_cost_price(15.75), 15.75)
        self.assertEqual(clean_cost_price("0.0"), 0.0)
        self.assertEqual(clean_cost_price(""), 0.0)
        self.assertEqual(clean_cost_price(None), 0.0)

        # 2. Arabic/Eastern numerals
        self.assertEqual(clean_cost_price("١٢.٥٠"), 12.50)
        self.assertEqual(clean_cost_price("٤٥.٢٥"), 45.25)

        # 3. Currency symbols
        self.assertEqual(clean_cost_price("12.50 SAR"), 12.50)
        self.assertEqual(clean_cost_price("SAR 12.50"), 12.50)
        self.assertEqual(clean_cost_price("12.50 ريال"), 12.50)
        self.assertEqual(clean_cost_price("12.50 ر.س"), 12.50)

        # 4. Thousands separators and commas
        self.assertEqual(clean_cost_price("1,250.50"), 1250.50)
        self.assertEqual(clean_cost_price("12,50"), 12.50)

        # 5. OCR character confusion (o/O -> 0, l/I -> 1, S/s -> 5)
        self.assertEqual(clean_cost_price("12.5O"), 12.50)
        self.assertEqual(clean_cost_price("2O.50"), 20.50)

    def test_cost_price_priority_ordering(self):
        # Scenario 1: Cost Price vs Unit Price -> Cost Price wins
        headers_1 = ["الرقم", "اسم الصنف", "سعر الوحدة", "سعر التكلفة", "الكمية"]
        idx_1, kw_1 = find_cost_price_column_idx(headers_1)
        self.assertEqual(idx_1, 3)
        self.assertEqual(kw_1, "سعر التكلفة")

        # Scenario 2: English priority: Unit Cost vs Price -> Unit Cost wins
        headers_2 = ["Item", "Unit Cost", "Price", "Qty"]
        idx_2, kw_2 = find_cost_price_column_idx(headers_2)
        self.assertEqual(idx_2, 1)
        self.assertEqual(kw_2, "unit cost")

        # Scenario 3: Purchase Price vs Unit Price -> Purchase Price wins
        headers_3 = ["Description", "Unit Price", "Purchase Price"]
        idx_3, kw_3 = find_cost_price_column_idx(headers_3)
        self.assertEqual(idx_3, 2)
        self.assertEqual(kw_3, "purchase price")

        # Scenario 4: Cost vs Unit Price -> Cost wins
        headers_4 = ["Item Name", "Cost", "Unit Price"]
        idx_4, kw_4 = find_cost_price_column_idx(headers_4)
        self.assertEqual(idx_4, 1)
        self.assertEqual(kw_4, "cost")

        # Scenario 5: Only Unit Price exists -> Unit Price selected
        headers_5 = ["Item Name", "Unit Price", "Total"]
        idx_5, kw_5 = find_cost_price_column_idx(headers_5, exclude_indices=[2])
        self.assertEqual(idx_5, 1)
        self.assertEqual(kw_5, "unit price")

    def test_cost_price_retained_in_matching(self):
        matcher = SmartMatcher()
        # Item with custom cost_price from invoice
        item = {
            "raw_name": "PANADOL EXTRA 24TAB",
            "barcode": "6281001234567",
            "quantity": 10,
            "cost_price": 14.85,
            "invoice_price": 14.85
        }
        res = matcher.match_item(item)
        # Verify that cost_price in matched result is exactly what came from invoice
        self.assertEqual(res.get("cost_price"), 14.85)

        # Another item with cost_price passed
        item2 = {
            "raw_name": "GLUCOPHAGE 1000MG",
            "barcode": "",
            "quantity": 5,
            "cost_price": 18.50,
            "invoice_price": 18.50
        }
        res2 = matcher.match_item(item2)
        self.assertEqual(res2.get("cost_price"), 18.50)

    def test_unmatched_item_price_safety(self):
        """ضمان عدم حدوث أي خطأ NameError أو استثناء عند معالجة صنف غير موجود في قاعدة البيانات"""
        matcher = SmartMatcher()
        unmatched_item = {
            "raw_name": "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
            "quantity": 3,
            "cost_price": 25.50,
            "selling_price": 35.00,
            "batch_number": "BATCH-001",
            "expiry_date": "30/12/2028"
        }
        res = matcher.match_item(unmatched_item)
        self.assertEqual(res.get("cost_price"), 25.50)
        self.assertEqual(res.get("selling_price"), 35.00)
        self.assertEqual(res.get("batch_number"), "BATCH-001")
        self.assertEqual(res.get("expiry_date"), "30/12/2028")

    def test_none_matched_build_result(self):
        """فحص الاستدعاء المباشر لـ _build_result مع matched=None وبدون أسعار مسبقة"""
        matcher = SmartMatcher()
        item = {"raw_name": "TEST", "cost_price": 10.0}
        res = matcher._build_result(item, None, 0, "low", "none")
        self.assertEqual(res.get("cost_price"), 10.0)
        self.assertEqual(res.get("selling_price"), 10.0)
        self.assertEqual(res.get("score"), 0)

if __name__ == '__main__':
    unittest.main()
