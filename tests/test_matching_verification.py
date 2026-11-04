import io, sys, unittest
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

from backend.db import find_product_by_gtin_or_barcode, scan_qr_to_invoice, clear_invoice_lines
from backend.qr_parser import extract_clean_gtin

class TestMatchingVerification(unittest.TestCase):

    def test_emifen_match(self):
        # EMIFEN GTIN
        p = find_product_by_gtin_or_barcode('06291103730435')
        self.assertIsNotNone(p)
        self.assertEqual(p['code'], '27660')
        self.assertEqual(p['name_en'], 'EMIFEN 600 20 TABLETS')
        self.assertEqual(p['selling_price'], 8.25)

    def test_decozal_match(self):
        # DECOZAL GTIN
        p = find_product_by_gtin_or_barcode('06251151000850')
        self.assertIsNotNone(p)
        self.assertEqual(p['code'], '24636')
        self.assertEqual(p['name_en'], 'DECOZAL 1% NASAL SPRAY 15ML')
        self.assertEqual(p['selling_price'], 7.55)

    def test_lulab_match(self):
        # LULAB GTIN
        p = find_product_by_gtin_or_barcode('18906028600033')
        self.assertIsNotNone(p)
        self.assertEqual(p['code'], '0000094680')
        self.assertEqual(p['name_en'], 'SMB TCU 380 AG NORMAL')
        self.assertEqual(p['name_ar'], 'لولب نحاسي سيلفر TUC 380 AG هندي')

    def test_gtin_filter_values(self):
        # Check extraction of 14-digit GTIN only
        self.assertEqual(extract_clean_gtin('010629110373043521ً،~46/4}]7ِ5َ،1727041810}754'), '06291103730435')
        self.assertEqual(extract_clean_gtin('01062911037304351727041810C75321WKZ46L4CD7A5QK'), '06291103730435')
        self.assertEqual(extract_clean_gtin('01062511510008501728102810MgN535210KE2ESX535'), '06251151000850')
        self.assertEqual(extract_clean_gtin('01189060286000331729083110ugn01092024'), '18906028600033')

if __name__ == '__main__':
    unittest.main()
