import unittest
import os
import sys

# Add project root to sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from backend.catalog_importer import parse_tax_rate_cell, suggest_columns_mapping
from backend.db import search_products, get_product_by_code, save_or_update_product

class TestTaxAndSearchFeatures(unittest.TestCase):

    def test_parse_tax_rate_cell(self):
        # 1. 'VAT' or contains VAT -> (True, 15.0)
        self.assertEqual(parse_tax_rate_cell('VAT'), (True, 15.0))
        self.assertEqual(parse_tax_rate_cell('vat'), (True, 15.0))
        self.assertEqual(parse_tax_rate_cell('Customer Tax VAT'), (True, 15.0))
        self.assertEqual(parse_tax_rate_cell('15%'), (True, 15.0))
        self.assertEqual(parse_tax_rate_cell(0.15), (True, 15.0))
        self.assertEqual(parse_tax_rate_cell(15), (True, 15.0))

        # 2. 'FALSE' or zero tax -> (True, 0.0)
        self.assertEqual(parse_tax_rate_cell('FALSE'), (True, 0.0))
        self.assertEqual(parse_tax_rate_cell('false'), (True, 0.0))
        self.assertEqual(parse_tax_rate_cell('False'), (True, 0.0))
        self.assertEqual(parse_tax_rate_cell('0%'), (True, 0.0))
        self.assertEqual(parse_tax_rate_cell(0), (True, 0.0))
        self.assertEqual(parse_tax_rate_cell('غير خاضع'), (True, 0.0))

        # 3. None or empty preserves existing tax -> (False, 0.0)
        self.assertEqual(parse_tax_rate_cell(None), (False, 0.0))
        self.assertEqual(parse_tax_rate_cell(''), (False, 0.0))

    def test_suggest_columns_mapping_tax(self):
        headers = ['Internal Reference', 'Name (EN)', 'Sales Price', 'CUSTOMER TAX', 'Barcode']
        mapping = suggest_columns_mapping(headers)
        self.assertEqual(mapping.get('tax_rate_col'), 'CUSTOMER TAX')

        headers2 = ['code', 'name', 'Customer Taxes']
        mapping2 = suggest_columns_mapping(headers2)
        self.assertEqual(mapping2.get('tax_rate_col'), 'Customer Taxes')

    def test_search_mode_start_vs_contains(self):
        # Create test products
        p1 = {
            "code": "888001",
            "name_en": "ADOL EXTRA TABLETS 500MG",
            "name_ar": "ادول اكسترا حبوب 500 ملغ",
            "selling_price": 10.0,
            "cost_price": 7.0,
            "tax_rate": 15.0
        }
        p2 = {
            "code": "888002",
            "name_en": "PANADOL ADVANCE 500MG (CONTAINS ADOL IN MIDDLE)",
            "name_ar": "بنادول ادفانس 500 ملغ",
            "selling_price": 12.0,
            "cost_price": 8.0,
            "tax_rate": 0.0
        }
        save_or_update_product(p1)
        save_or_update_product(p2)

        # Test mode='start'
        res_start = search_products("ADOL", limit=100, offset=0, match_mode="start")
        items_start = res_start.get("items", [])
        start_codes = [it["code"] for it in items_start]

        self.assertIn("888001", start_codes)
        self.assertNotIn("888002", start_codes)

        # Test mode='contains'
        res_contains = search_products("ADOL", limit=100, offset=0, match_mode="contains")
        items_contains = res_contains.get("items", [])
        contains_codes = [it["code"] for it in items_contains]

        self.assertIn("888001", contains_codes)
        self.assertIn("888002", contains_codes)

    def test_word_boundary_space_rule(self):
        # Rule: "ADOL" matches both ADOL and ADOLIN
        # But "ADOL " (with space) matches ONLY ADOL and excludes ADOLIN
        p_adol = {
            "code": "888101",
            "name_en": "ADOL 500MG 24 TAB",
            "name_ar": "ادول 500 مجم 24 قرص",
            "tax_rate": 15.0
        }
        p_adolin = {
            "code": "888102",
            "name_en": "ADOLIN 0.1% GEL 30GM",
            "name_ar": "ادولين جل",
            "tax_rate": 15.0
        }
        save_or_update_product(p_adol)
        save_or_update_product(p_adolin)

        # 1. Without space: "ADOL" -> matches both
        res_without_space = search_products("ADOL", limit=100, match_mode="start")
        codes_no_space = [it["code"] for it in res_without_space.get("items", [])]
        self.assertIn("888101", codes_no_space)
        self.assertIn("888102", codes_no_space)

        # 2. With space: "ADOL " -> matches ADOL, EXCLUDES ADOLIN!
        res_with_space = search_products("ADOL ", limit=100, match_mode="start")
        codes_with_space = [it["code"] for it in res_with_space.get("items", [])]
        self.assertIn("888101", codes_with_space)
        self.assertNotIn("888102", codes_with_space)

        # 3. With space in contains mode: "ADOL " -> matches ADOL as distinct word, excludes ADOLIN
        res_contains_space = search_products("ADOL ", limit=100, match_mode="contains")
        codes_contains_space = [it["code"] for it in res_contains_space.get("items", [])]
        self.assertIn("888101", codes_contains_space)
        self.assertNotIn("888102", codes_contains_space)

    def test_search_code_start_vs_contains(self):
        p1 = {"code": "9468810", "name_en": "TEST PRODUCT CODE START", "tax_rate": 15.0}
        p2 = {"code": "00094688", "name_en": "TEST PRODUCT CODE CONTAINS", "tax_rate": 0.0}
        save_or_update_product(p1)
        save_or_update_product(p2)

        # mode='start': starts with 94688
        res_start = search_products("94688", limit=100, offset=0, match_mode="start")
        start_codes = [it["code"] for it in res_start.get("items", [])]
        self.assertIn("9468810", start_codes)

        # mode='contains': contains 94688 anywhere
        res_contains = search_products("94688", limit=100, offset=0, match_mode="contains")
        contains_codes = [it["code"] for it in res_contains.get("items", [])]
        self.assertIn("9468810", contains_codes)
        self.assertIn("00094688", contains_codes)

    def test_full_product_card_data(self):
        p = {
            "code": "777001",
            "name_en": "TEST CARD PRODUCT FULL",
            "name_ar": "صنف تجريبي كامل",
            "scientific_name": "Paracetamol",
            "company": "Pharma Co",
            "category": "Analgesic",
            "selling_price": 25.5,
            "cost_price": 18.0,
            "tax_rate": 15.0,
            "unit": "علبة",
            "primary_barcode": "1234567890123",
            "primary_gtin": "06281234567890"
        }
        save_or_update_product(p)
        prod = get_product_by_code("777001")
        self.assertIsNotNone(prod)
        self.assertEqual(prod["code"], "777001")
        self.assertEqual(prod["name_en"], "TEST CARD PRODUCT FULL")
        self.assertEqual(prod["scientific_name"], "Paracetamol")
        self.assertEqual(prod["company"], "Pharma Co")
        self.assertEqual(prod["tax_rate"], 15.0)
        self.assertIn("barcode_list", prod)
        self.assertIn("gtin_list", prod)

if __name__ == '__main__':
    unittest.main()
