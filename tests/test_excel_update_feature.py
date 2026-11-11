import unittest
import urllib.request
import json
import openpyxl
import io
from backend.db import get_product_by_code, find_product_by_gtin_or_barcode, save_or_update_product, delete_product

import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from live_server import start_live_server, stop_live_server, base_url


def setUpModule():
    # خادم البرنامج على منفذ فاضي بنسخة مؤقتة من قاعدة البيانات وبدون سحابة
    start_live_server()


def tearDownModule():
    stop_live_server()

class TestExcelUpdateFeature(unittest.TestCase):
    def test_excel_update_and_export(self):
        # 1. Export test
        req = urllib.request.urlopen(base_url() + '/api/catalog/export-excel')
        self.assertEqual(req.status, 200)
        excel_bytes = req.read()
        wb_exp = openpyxl.load_workbook(io.BytesIO(excel_bytes))
        ws_exp = wb_exp.active
        headers = [c.value for c in ws_exp[1]]
        self.assertIn('PRODUCT CODE', headers)
        self.assertIn('SALES PRICE', headers)
        self.assertTrue(any('GTIN' in str(h) for h in headers))
        # تصدير الكتالوج كاملاً: صف العناوين + كل أصناف قاعدة الاختبار
        from backend.db import get_connection
        with get_connection() as conn:
            total = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        self.assertGreaterEqual(total, 2)
        self.assertEqual(ws_exp.max_row, total + 1)

        # 2. Prepare Excel update file
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(['PRODUCT CODE', 'NAME ENGLIS', 'NAME ARABIC', 'SALES PRICE', 'COST PRICE', 'TAX RATE', 'BARCODE', 'GTIN'])
        # Update existing product 94688
        ws.append(['94688', 'FINJUVE 2.275MG SPRAY UPDATED', 'بخاخ فينجوف مطور', 175.50, 120.00, 0, 'BARCODE94688', '06285101004926'])
        # New product without code
        ws.append(['', 'NEW BRAND PRODUCT 2026', 'منتج جديد 2026', 88.00, 50.00, 0, 'BARCODE99991', '06299999999991'])

        excel_buf = io.BytesIO()
        wb.save(excel_buf)
        upload_bytes = excel_buf.getvalue()

        # 3. Upload file
        boundary = '----WebKitFormBoundary7MA4YWxkTrZu0gW'
        body = (
            f'--{boundary}\r\n'
            f'Content-Disposition: form-data; name="file"; filename="test_update.xlsx"\r\n'
            f'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'
        ).encode('utf-8') + upload_bytes + f'\r\n--{boundary}--\r\n'.encode('utf-8')

        up_req = urllib.request.Request(base_url() + '/api/catalog/upload-excel', data=body)
        up_req.add_header('Content-Type', f'multipart/form-data; boundary={boundary}')
        res = urllib.request.urlopen(up_req)
        upload_info = json.loads(res.read().decode('utf-8'))
        self.assertTrue(upload_info['success'])
        file_id = upload_info['file_id']
        mapping = upload_info['suggested_mapping']

        # 4. Preview
        prev_req = urllib.request.Request(
            base_url() + '/api/catalog/preview-import',
            data=json.dumps({'file_id': file_id, 'mapping': mapping}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        prev_res = urllib.request.urlopen(prev_req)
        prev_data = json.loads(prev_res.read().decode('utf-8'))
        self.assertEqual(prev_data.get('updates_count'), 1)
        self.assertEqual(prev_data.get('new_count'), 1)

        # 5. Commit
        commit_req = urllib.request.Request(
            base_url() + '/api/catalog/commit-import',
            data=json.dumps({'file_id': file_id, 'mapping': mapping}).encode('utf-8'),
            headers={'Content-Type': 'application/json'}
        )
        commit_res = urllib.request.urlopen(commit_req)
        commit_data = json.loads(commit_res.read().decode('utf-8'))
        self.assertTrue(commit_data['success'])
        self.assertEqual(commit_data.get('updated_count'), 1)
        self.assertEqual(commit_data.get('new_count'), 1)

        # 6. Verify changes in DB
        p94688 = get_product_by_code('94688')
        self.assertEqual(p94688['name_en'], 'FINJUVE 2.275MG SPRAY UPDATED')
        self.assertEqual(p94688['selling_price'], 175.50)

        p_new = find_product_by_gtin_or_barcode('06299999999991')
        self.assertIsNotNone(p_new)
        self.assertEqual(p_new['name_en'], 'NEW BRAND PRODUCT 2026')
        self.assertEqual(p_new['selling_price'], 88.00)

        # Cleanup test changes
        save_or_update_product({
            'code': '94688',
            'name_en': 'FINJUVE 2.275MG SPRAY',
            'name_ar': 'بخاخ فينجوف 2.275 مجم',
            'selling_price': 160.00,
            'unit_price': 100.00,
            'tax_rate': 0.0,
            'gtin_list': ['06285101004926'],
            'barcode_list': []
        })
        delete_product(p_new['code'])

if __name__ == '__main__':
    unittest.main()
