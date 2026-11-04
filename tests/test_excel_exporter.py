import os
import unittest
import openpyxl
from backend.excel_exporter import export_matched_items_to_excel, EXCEL_COLUMNS

class TestExcelExporter(unittest.TestCase):
    def setUp(self):
        self.test_export_path = os.path.join(os.path.dirname(__file__), "test_export_output.xlsx")

    def tearDown(self):
        if os.path.exists(self.test_export_path):
            try:
                os.remove(self.test_export_path)
            except:
                pass

    def test_exact_10_columns_order_and_values(self):
        expected_columns = [
            "PRODUCT",
            "NAME ENGLIS",
            "SALES PRICE",
            "BATCH NUMBER",
            "Bonus Qty",
            "QUANTITE",
            "UNITPRICE",
            "Discount (%)",
            "Discount 2 (%)",
            "expiry-date"
        ]
        self.assertEqual(EXCEL_COLUMNS, expected_columns)

        sample_items = [
            {
                "matched_code": "104059",
                "matched_name_en": "XALATAN 0.005% EYE DROP 2.5ML",
                "selling_price": 42.65,
                "batch_number": "BATCH-001",
                "bonus": 1,
                "quantity": 10,
                "cost_price": 35.50,
                "discount_1": 15.00,
                "discount_2": 5.00,
                "expiry_date": "31/12/2028"
            }
        ]

        export_matched_items_to_excel(sample_items, self.test_export_path)

        wb = openpyxl.load_workbook(self.test_export_path)
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))

        # 1. التحقق من الترويسة
        self.assertEqual(list(rows[0]), expected_columns)

        # 2. التحقق من صف البيانات
        data_row = rows[1]
        self.assertEqual(data_row[0], "104059")                        # PRODUCT
        self.assertEqual(data_row[1], "XALATAN 0.005% EYE DROP 2.5ML")# NAME ENGLIS
        self.assertEqual(data_row[2], 42.65)                          # SALES PRICE
        self.assertEqual(data_row[3], "BATCH-001")                     # BATCH NUMBER
        self.assertEqual(data_row[4], 1)                              # Bonus Qty
        self.assertEqual(data_row[5], 10)                             # QUANTITE
        self.assertEqual(data_row[6], 35.50)                          # UNITPRICE
        self.assertEqual(data_row[7], 15.00)                          # Discount (%)
        self.assertEqual(data_row[8], 5.00)                           # Discount 2 (%)
        self.assertEqual(data_row[9], "31/12/2028")                   # expiry-date

if __name__ == '__main__':
    unittest.main()
