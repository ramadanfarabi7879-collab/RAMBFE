import os
import unittest
import openpyxl
from backend import db, excel_exporter, catalog_importer

class TestCustomExportAndMultiBarcodes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Use existing db initialization
        db.init_db()

    def setUp(self):
        # Create a unique test product
        self.test_code = "9901001"
        conn = db.get_connection()
        cursor = conn.cursor()
        
        # Clean up any previous test product
        cursor.execute("DELETE FROM products WHERE code = ?", (self.test_code,))
        cursor.execute("DELETE FROM product_barcodes WHERE product_code = ?", (self.test_code,))
        cursor.execute("DELETE FROM audit_logs WHERE entity_id = ?", (self.test_code,))
        conn.commit()
        conn.close()

    def tearDown(self):
        conn = db.get_connection()
        cursor = conn.cursor()
        cursor.execute("DELETE FROM products WHERE code = ?", (self.test_code,))
        cursor.execute("DELETE FROM product_barcodes WHERE product_code = ?", (self.test_code,))
        cursor.execute("DELETE FROM audit_logs WHERE entity_id = ?", (self.test_code,))
        conn.commit()
        conn.close()

    def test_save_product_multi_barcodes_and_gtins(self):
        """Test saving a product with dynamic multiple barcodes and GTINs, scientific name, company, wholesale price."""
        data = {
            "code": self.test_code,
            "name_ar": "بنادول اكسترا تجريبي",
            "name_en": "Panadol Extra Test",
            "scientific_name": "Paracetamol 500mg + Caffeine",
            "company": "GSK Pharma",
            "category": "دواء",
            "tax_rate": 0.0,
            "selling_price": 25.50,
            "wholesale_price": 20.00,
            "unit_price": 18.00,
            "unit": "علبة",
            "unit_divisions": "24 حبة",
            "primary_barcode": "6281001112223",
            "extra_barcodes": "6281001112224,6281001112225",
            "barcode_list": ["6281001112223", "6281001112224", "6281001112225"],
            "primary_gtin": "06281001112223",
            "extra_gtins": "06281001112224",
            "gtin_list": ["06281001112223", "06281001112224"]
        }

        res = db.save_or_update_product(data, user_name="TestTester")
        self.assertTrue(res[0], res[2])

        # Verify product data in DB
        prod = db.get_product_by_code(self.test_code)
        self.assertIsNotNone(prod)
        self.assertEqual(prod["name_ar"], "بنادول اكسترا تجريبي")
        self.assertEqual(prod["scientific_name"], "Paracetamol 500mg + Caffeine")
        self.assertEqual(prod["company"], "GSK Pharma")
        self.assertEqual(prod["wholesale_price"], 20.00)
        self.assertEqual(prod["tax_rate"], 0.0)

        # Verify barcodes and gtins
        barcodes = prod.get("barcode_list", [])
        self.assertIn("6281001112223", barcodes)
        self.assertIn("6281001112224", barcodes)
        self.assertIn("6281001112225", barcodes)

        gtins = prod.get("gtin_list", [])
        self.assertIn("06281001112223", gtins)
        self.assertIn("06281001112224", gtins)

        # Verify search across scientific name and company
        found_sci = db.search_products("Caffeine")
        self.assertTrue(any(p["code"] == self.test_code for p in found_sci["items"]))

        found_comp = db.search_products("GSK Pharma")
        self.assertTrue(any(p["code"] == self.test_code for p in found_comp["items"]))

        # Verify search by extra barcode
        found_bar = db.search_products("6281001112225")
        self.assertTrue(any(p["code"] == self.test_code for p in found_bar["items"]))

        # Verify audit log
        logs = db.get_audit_logs(entity_id=self.test_code)
        self.assertTrue(len(logs) >= 1)
        self.assertEqual(logs[0]["action"], "create")

    def test_custom_fields_excel_export(self):
        """Test exporting Excel with customizable selected columns."""
        # First save the product
        data = {
            "code": self.test_code,
            "name_ar": "صنف للتصدير",
            "name_en": "Export Test Prod",
            "selling_price": 15.00,
            "primary_barcode": "1110002223334",
            "extra_barcodes": "1110002223335",
            "barcode_list": ["1110002223334", "1110002223335"],
            "primary_gtin": "01110002223334",
            "gtin_list": ["01110002223334"]
        }
        db.save_or_update_product(data)

        # Export only 4 fields: code, name_en, extra_barcodes, gtin
        selected_fields = ["code", "name_en", "extra_barcodes", "gtin"]
        out_path = f"data/test_custom_export_{self.test_code}.xlsx"

        try:
            excel_exporter.export_catalog_to_excel(
                output_path=out_path,
                product_codes=[self.test_code],
                selected_fields=selected_fields
            )
            self.assertTrue(os.path.exists(out_path))

            # Verify contents of generated Excel
            wb = openpyxl.load_workbook(out_path)
            ws = wb.active
            headers = [cell.value for cell in ws[1]]
            
            # Check exactly 4 columns
            self.assertEqual(len(headers), 4)
            self.assertEqual(headers[0], "PRODUCT CODE")
            self.assertEqual(headers[1], "NAME ENGLIS")
            self.assertEqual(headers[2], "EXTRA BARCODES")
            self.assertEqual(headers[3], "PRIMARY GTIN")

            # Check row 2 values
            row2 = [cell.value for cell in ws[2]]
            self.assertEqual(row2[0], self.test_code)
            self.assertEqual(row2[1], "Export Test Prod")
            self.assertEqual(row2[2], "1110002223335")
            self.assertEqual(row2[3], "01110002223334")
            wb.close()
        finally:
            if os.path.exists(out_path):
                os.remove(out_path)

    def test_import_partial_update_and_barcode_modes(self):
        """Test partial update via Excel: only mapped columns change; test additive vs replace barcode modes."""
        # 1. Create base product
        data = {
            "code": self.test_code,
            "name_ar": "اسم قديم عربي",
            "name_en": "Old English Name",
            "scientific_name": "Old Sci Name",
            "company": "Old Company",
            "selling_price": 50.00,
            "wholesale_price": 40.00,
            "tax_rate": 0.0,
            "barcode_list": ["BAR001", "BAR002"],
            "gtin_list": ["00011122233344"]
        }
        db.save_or_update_product(data)

        # 2. Prepare an Excel file updating ONLY selling_price and adding a new barcode
        excel_path = f"data/test_import_{self.test_code}.xlsx"
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.title = "UpdateSheet"
        ws.append(["Internal Reference", "New Sales Price", "New Barcode"])
        ws.append([self.test_code, 75.00, "BAR003"])
        wb.save(excel_path)
        wb.close()

        try:
            mapping = {
                "code_col": "Internal Reference",
                "selling_price_col": "New Sales Price",
                "barcode_cols": ["New Barcode"]
            }

            # A. Test preview import (diff detection)
            preview = catalog_importer.preview_import_catalog(
                file_path=excel_path,
                mapping=mapping,
                replace_barcodes=False
            )
            self.assertTrue(preview["success"])
            self.assertEqual(preview["updates_count"], 1)
            self.assertEqual(len(preview["preview_items"]), 1)
            item_prev = preview["preview_items"][0]
            self.assertTrue(item_prev["is_update"])
            self.assertIn("selling_price", item_prev["diff"])
            self.assertEqual(item_prev["diff"]["selling_price"]["old"], 50.0)
            self.assertEqual(item_prev["diff"]["selling_price"]["new"], 75.0)

            # B. Test commit in Additive mode (replace_barcodes=False)
            commit_res = catalog_importer.commit_import_catalog(
                file_path=excel_path,
                mapping=mapping,
                replace_barcodes=False
            )
            self.assertTrue(commit_res["success"])
            self.assertEqual(commit_res["updated_count"], 1)

            # Verify in DB:
            prod_updated = db.get_product_by_code(self.test_code)
            # 1) selling_price was updated
            self.assertEqual(prod_updated["selling_price"], 75.00)
            # 2) unmapped fields (name_ar, name_en, scientific_name, company, wholesale_price) UNTOUCHED!
            self.assertEqual(prod_updated["name_ar"], "اسم قديم عربي")
            self.assertEqual(prod_updated["name_en"], "Old English Name")
            self.assertEqual(prod_updated["scientific_name"], "Old Sci Name")
            self.assertEqual(prod_updated["company"], "Old Company")
            self.assertEqual(prod_updated["wholesale_price"], 40.00)
            # 3) Additive barcodes: old barcodes retained + new one added
            self.assertIn("BAR001", prod_updated["barcode_list"])
            self.assertIn("BAR002", prod_updated["barcode_list"])
            self.assertIn("BAR003", prod_updated["barcode_list"])

            # C. Now test Replace mode (replace_barcodes=True)
            commit_replace = catalog_importer.commit_import_catalog(
                file_path=excel_path,
                mapping=mapping,
                replace_barcodes=True
            )
            self.assertTrue(commit_replace["success"])
            prod_replaced = db.get_product_by_code(self.test_code)
            # In replace mode, barcode_list should have ONLY BAR003
            self.assertEqual(prod_replaced["barcode_list"], ["BAR003"])

            # Verify audit logs record the Excel update
            logs = db.get_audit_logs(entity_type="catalog_import", entity_id=os.path.basename(excel_path))
            self.assertTrue(len(logs) >= 1)
            self.assertEqual(logs[0]["action"], "excel_update")

        finally:
            if os.path.exists(excel_path):
                os.remove(excel_path)

if __name__ == "__main__":
    unittest.main()
