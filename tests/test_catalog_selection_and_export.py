import unittest
import urllib.request
import json
import openpyxl
import io
from backend.db import get_or_create_draft_invoice, add_manual_item_to_invoice, clear_invoice_lines

class TestCatalogSelectionAndExport(unittest.TestCase):
    def test_export_by_selected_codes_get(self):
        # 1. Test GET with specific codes
        codes = ['94688', '10001']
        url = f"http://127.0.0.1:8000/api/catalog/export-excel?scope=selected&codes={','.join(codes)}"
        req = urllib.request.urlopen(url)
        self.assertEqual(req.status, 200)
        content = req.read()
        wb = openpyxl.load_workbook(io.BytesIO(content))
        ws = wb.active
        self.assertEqual(ws.title, "PRODUCTS_CATALOG")
        # 1 header + up to 2 items
        rows = list(ws.iter_rows(values_only=True))
        headers = rows[0]
        self.assertIn("PRODUCT CODE", headers)
        self.assertIn("SALES PRICE", headers)
        self.assertTrue(any("GTIN" in str(h) for h in headers))
        # Verify row count is <= 3
        self.assertLessEqual(len(rows), 3)
        self.assertGreaterEqual(len(rows), 2)
        exported_codes = [str(r[0]) for r in rows[1:]]
        self.assertIn('94688', exported_codes)

    def test_export_by_selected_codes_post(self):
        # 2. Test POST with specific codes
        body = json.dumps({
            'scope': 'selected',
            'codes': ['94688']
        }).encode('utf-8')
        req = urllib.request.Request(
            'http://127.0.0.1:8000/api/catalog/export-excel',
            data=body,
            headers={'Content-Type': 'application/json'}
        )
        res = urllib.request.urlopen(req)
        self.assertEqual(res.status, 200)
        wb = openpyxl.load_workbook(io.BytesIO(res.read()))
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
        self.assertEqual(len(rows), 2) # header + 1 item
        self.assertEqual(str(rows[1][0]), '94688')

    def test_export_by_current_invoice(self):
        # 3. Setup draft invoice with 1 line
        draft = get_or_create_draft_invoice()
        inv_id = draft['id']
        clear_invoice_lines(inv_id)
        res = add_manual_item_to_invoice(
            inv_id,
            gtin_or_code='94688',
            batch='BATCHTEST01',
            expiry='2028-12-31',
            quantity=2
        )
        self.assertTrue(res['success'])

        url = f"http://127.0.0.1:8000/api/catalog/export-excel?scope=invoice&invoice_id={inv_id}"
        req = urllib.request.urlopen(url)
        self.assertEqual(req.status, 200)
        wb = openpyxl.load_workbook(io.BytesIO(req.read()))
        ws = wb.active
        rows = list(ws.iter_rows(values_only=True))
        self.assertEqual(len(rows), 2)
        self.assertEqual(str(rows[1][0]), '94688')

        # Cleanup
        clear_invoice_lines(inv_id)

if __name__ == '__main__':
    unittest.main()
