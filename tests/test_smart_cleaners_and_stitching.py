import unittest
from backend.invoice_parser import (
    clean_batch_smart,
    clean_expiry_smart,
    clean_code_smart,
    clean_name_smart,
    clean_cost_price_smart,
    _is_continuation_row,
    _merge_continuation_row,
)
from backend.db import (
    save_supplier_template,
    get_supplier_template,
    get_all_supplier_templates,
    delete_supplier_template,
    find_matching_supplier_template,
    init_db,
)
from backend.matcher import SmartMatcher, get_barcode_variants
from backend.normalizer import normalize_arabic, normalize_english

class TestSmartCleanersAndStitching(unittest.TestCase):
    def setUp(self):
        init_db()

    def test_clean_batch_smart(self):
        # 1. Batch# G02J5T -> G02J5T
        self.assertEqual(clean_batch_smart("Batch# G02J5T"), "G02J5T")
        # 2. LOT# 99481 -> 99481
        self.assertEqual(clean_batch_smart("LOT# 99481"), "99481")
        # 3. Lot: B123 -> B123
        self.assertEqual(clean_batch_smart("Lot: B123"), "B123")
        # 4. تشغيلة: T-908 -> T-908
        self.assertEqual(clean_batch_smart("تشغيلة: T-908"), "T-908")
        # 5. B.No: X889 -> X889
        self.assertEqual(clean_batch_smart("B.No: X889"), "X889")
        # 6. Raw value without prefix
        self.assertEqual(clean_batch_smart("G02J5T"), "G02J5T")
        # 7. With expiry mentioned after batch
        self.assertEqual(clean_batch_smart("Batch# 50.00 Exp Date 30/09/2027"), "50.00")

    def test_clean_expiry_smart(self):
        # 1. Exp Date 30-09-2027 -> 30/09/2027
        self.assertEqual(clean_expiry_smart("Exp Date 30-09-2027"), "30/09/2027")
        # 2. Expiration: 2028/11/01 -> 01/11/2028
        self.assertEqual(clean_expiry_smart("Expiration: 2028/11/01"), "01/11/2028")
        # 3. Multiple dates: Mfg: 01/2024 Exp: 12/2027 -> 01/12/2027 (picks larger date)
        exp = clean_expiry_smart("Mfg: 01/2024 Exp: 12/2027")
        self.assertTrue(exp.endswith("2027") or exp == "01/12/2027")
        # 4. Arabic انتهاء
        self.assertEqual(clean_expiry_smart("تاريخ الانتهاء 15-05-2029"), "15/05/2029")
        # 5. Simple standard date
        self.assertEqual(clean_expiry_smart("30/09/2027"), "30/09/2027")

    def test_clean_cost_price_smart(self):
        # 1. Unit Price 22.25 -> 22.25
        self.assertEqual(clean_cost_price_smart("Unit Price 22.25"), 22.25)
        # 2. Currency symbol and comma
        self.assertEqual(clean_cost_price_smart("1,250.75 SAR"), 1250.75)
        # 3. Multiple decimals / exact precision
        self.assertEqual(clean_cost_price_smart("Cost: 45.50"), 45.5)
        # 4. Zero or invalid
        self.assertEqual(clean_cost_price_smart("N/A"), 0.0)

    def test_clean_code_smart(self):
        # 1. Item Code: 9458 -> 9458
        self.assertEqual(clean_code_smart("Item Code: 9458"), "9458")
        # 2. Code: 0000094289 -> 0000094289
        self.assertEqual(clean_code_smart("Code: 0000094289"), "0000094289")
        # 3. Product Code #12045 -> 12045
        self.assertEqual(clean_code_smart("Product Code #12045"), "12045")
        # 4. Pure digits
        self.assertEqual(clean_code_smart("8969"), "8969")

    def test_clean_name_smart(self):
        # Strip trailing batch/expiry/code info from name
        name1 = clean_name_smart("PANADOL EXTRA 500MG Batch# G02J5T Exp 2028")
        self.assertEqual(name1, "PANADOL EXTRA 500MG")

        name2 = clean_name_smart("OMEZ 20MG CAP Code 1234")
        self.assertEqual(name2, "OMEZ 20MG CAP")

    def test_continuation_row_stitching(self):
        # Previous item
        prev_item = {
            'raw_name': 'AMOXIL 500MG',
            'item_code': '101',
            'barcode': '123456789',
            'gtin': '',
            'quantity': 10,
            'cost_price': 15.5,
            'batch_number': '',
            'expiry_date': '',
        }
        mapping = {
            'col_name': 0,
            'col_cost': 1,
            'col_qty': 2,
            'col_batch': 3,
            'col_expiry': 4,
        }
        # Continuation row with Batch and Expiry
        sub_row = ['', '', '', 'Batch# B123', 'Exp Date 30/12/2028']
        debug_report = {'rows_skipped': []}

        self.assertTrue(_is_continuation_row(sub_row, mapping))
        _merge_continuation_row(prev_item, sub_row, mapping, 2, debug_report)

        self.assertEqual(prev_item['batch_number'], 'B123')
        self.assertEqual(prev_item['expiry_date'], '30/12/2028')

    def test_supplier_template_persistence(self):
        supplier = "Test Supplier Al-Dawaa"
        mapping = {'name': 0, 'code': 1, 'cost_price': 3, 'batch': 4, 'expiry': 5}
        headers = ['Item Name', 'Code', 'Qty', 'Cost Price', 'Batch#', 'Exp Date']

        # Save
        save_supplier_template(supplier, mapping, headers)

        # Get
        retrieved = get_supplier_template(supplier)
        self.assertIsNotNone(retrieved)
        self.assertEqual(retrieved['supplier_name'], supplier)
        self.assertEqual(retrieved['mapping'], mapping)
        self.assertEqual(retrieved['headers'], headers)

        # Match by headers
        matched = find_matching_supplier_template(supplier, headers)
        self.assertIsNotNone(matched)
        self.assertEqual(matched['mapping'], mapping)

        # Match by supplier name even if headers vary slightly
        matched2 = find_matching_supplier_template(supplier, ['Item Name', 'Cost Price'])
        self.assertIsNotNone(matched2)

        # All templates
        all_templates = get_all_supplier_templates()
        self.assertTrue(any(t['supplier_name'] == supplier for t in all_templates))

        # Delete
        delete_supplier_template(supplier)
        self.assertIsNone(get_supplier_template(supplier))

    def test_cost_price_preservation_in_matcher(self):
        matcher = SmartMatcher()
        p = {
            'id': 1,
            'code': '9901',
            'name': 'CONCOR 5MG 30TAB',
            'name_en': 'CONCOR 5MG 30TAB',
            'name_ar': '',
            'barcode': '6281001',
            'gtin': '',
            'cost_price': 10.0,
            'selling_price': 15.0
        }
        matcher.products = [p]
        matcher.by_code['9901'] = p
        matcher.by_barcode['6281001'] = p

        # Invoice item with cost_price = 12.75 from PDF
        invoice_item = {
            'raw_name': 'CONCOR 5MG 30TAB',
            'item_code': '9901',
            'barcode': '6281001',
            'cost_price': 12.75,
            'quantity': 5,
            'batch_number': 'LOT889',
            'expiry_date': '31/12/2028'
        }

        res = matcher.match_item(invoice_item)
        # Must retain 12.75 from invoice, NOT 10.0 from catalog
        self.assertEqual(res['cost_price'], 12.75)
        self.assertEqual(res['invoice_price'], 12.75)
        self.assertEqual(res['batch_number'], 'LOT889')
        self.assertEqual(res['expiry_date'], '31/12/2028')

    def test_multi_field_matching(self):
        p1 = {
            'id': 1,
            'code': '9458',
            'name': 'PRODUCT ALPHA',
            'name_en': 'PRODUCT ALPHA',
            'name_ar': 'منتج الفا',
            'barcode': '111111111111',
            'gtin': '01111111111111',
            'cost_price': 20.0,
            'selling_price': 25.0
        }
        p2 = {
            'id': 2,
            'code': '8969',
            'name': 'PRODUCT BETA',
            'name_en': 'PRODUCT BETA',
            'name_ar': 'منتج بيتا',
            'barcode': '222222222222',
            'gtin': '02222222222222',
            'cost_price': 30.0,
            'selling_price': 35.0
        }
        matcher = SmartMatcher()
        matcher.products = [p1, p2]
        matcher.token_to_indices = {}
        matcher.by_code['9458'] = p1
        matcher.by_code['8969'] = p2
        matcher.by_barcode['111111111111'] = p1
        matcher.by_barcode['222222222222'] = p2
        matcher.by_gtin['01111111111111'] = p1
        matcher.by_gtin['02222222222222'] = p2
        matcher.catalog_names = [
            (normalize_arabic(p1['name_ar']), normalize_english(p1['name_en']), p1),
            (normalize_arabic(p2['name_ar']), normalize_english(p2['name_en']), p2)
        ]

        # 1. Match by Barcode
        res_barcode = matcher.match_item({'raw_name': 'UNKNOWN', 'barcode': '111111111111'})
        self.assertEqual(res_barcode['matched_name'], "PRODUCT ALPHA")
        self.assertEqual(res_barcode['match_type'], "barcode")

        # 2. Match by GTIN
        res_gtin = matcher.match_item({'raw_name': 'UNKNOWN', 'gtin': '02222222222222'})
        self.assertEqual(res_gtin['matched_name'], "PRODUCT BETA")
        self.assertEqual(res_gtin['match_type'], "gtin")

        # 3. Match by Item Code
        res_code = matcher.match_item({'raw_name': 'UNKNOWN', 'item_code': '9458'})
        self.assertEqual(res_code['matched_name'], "PRODUCT ALPHA")
        self.assertEqual(res_code['match_type'], "code")

        # 4. Match by Name
        res_name = matcher.match_item({'raw_name': 'PRODUCT BETA'})
        self.assertEqual(res_name['matched_name'], "PRODUCT BETA")

if __name__ == '__main__':
    unittest.main()

