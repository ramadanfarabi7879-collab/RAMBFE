import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, PageBreak, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib import colors

from backend.invoice_parser import parse_pdf_invoice_with_debug
from backend.matcher import SmartMatcher

class TestPdfDigitalInvoices(unittest.TestCase):

    def setUp(self):
        self.test_pdf_path = os.path.join(os.path.dirname(__file__), "test_temp_invoice.pdf")

    def tearDown(self):
        if os.path.exists(self.test_pdf_path):
            try:
                os.remove(self.test_pdf_path)
            except:
                pass

    def test_multipage_pdf_table_extraction(self):
        """اختبار الجداول متعددة الصفحات مع تكرار الترويسة"""
        doc = SimpleDocTemplate(self.test_pdf_path, pagesize=letter)
        elements = []
        styles = getSampleStyleSheet()

        elements.append(Paragraph("Tax Invoice", styles['Title']))
        elements.append(Spacer(1, 10))

        # جدول الصفحة الأولى: 5 أصناف
        page1_data = [
            ["Item No", "Description", "Barcode", "Cost Price", "Qty", "Total"],
            ["1", "PANADOL EXTRA 24TAB", "6281001234567", "14.50", "10", "145.00"],
            ["2", "FEVADOL 500MG 20TAB", "6281007654321", "8.25", "20", "165.00"],
            ["3", "BRUFEN 400MG 30TAB", "6281009876543", "12.75", "15", "191.25"],
            ["4", "CONCOR 5MG 30TAB", "6281003456789", "24.50", "5", "122.50"],
            ["5", "AUGMENTIN 1GM 14TAB", "6281005555555", "55.00", "8", "440.00"],
        ]
        t1 = Table(page1_data)
        t1.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), colors.navy),
            ('TEXTCOLOR', (0,0), (-1,0), colors.whitesmoke),
            ('GRID', (0,0), (-1,-1), 1, colors.black),
        ]))
        elements.append(t1)
        elements.append(PageBreak())

        # جدول الصفحة الثانية: 5 أصناف أخرى
        page2_data = [
            ["Item No", "Description", "Barcode", "Cost Price", "Qty", "Total"],
            ["6", "GLUCOPHAGE 1000MG 30TAB", "6281006666666", "19.85", "12", "238.20"],
            ["7", "AMARYL 2MG 30TAB", "6281007777777", "28.50", "6", "171.00"],
            ["8", "NEXIUM 40MG 28TAB", "6281008888888", "82.50", "4", "330.00"],
            ["9", "VOLTAREN 50MG 20TAB", "6281009999999", "18.25", "10", "182.50"],
            ["10", "ZITHROMAX 500MG 3TAB", "6281001111111", "34.00", "7", "238.00"],
        ]
        t2 = Table(page2_data)
        t2.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (-1,0), colors.navy),
            ('TEXTCOLOR', (0,0), (-1,0), colors.whitesmoke),
            ('GRID', (0,0), (-1,-1), 1, colors.black),
        ]))
        elements.append(t2)

        doc.build(elements)

        items, report = parse_pdf_invoice_with_debug(self.test_pdf_path)

        # 100% من صفوف الجدول مستخرجة
        self.assertEqual(len(items), 10)
        self.assertEqual(report["total_pages"], 2)
        self.assertIn("Cost Price", report["cost_price_column"])

        expected_prices = [14.50, 8.25, 12.75, 24.50, 55.00, 19.85, 28.50, 82.50, 18.25, 34.00]
        for item, exp_p in zip(items, expected_prices):
            self.assertEqual(item["cost_price"], exp_p)
            self.assertGreater(item["cost_price"], 0)

    def test_multiple_tables_same_page_merged(self):
        """اختبار دمج أكثر من جدول في الصفحة الواحدة تلقائياً"""
        doc = SimpleDocTemplate(self.test_pdf_path, pagesize=letter)
        elements = []

        # جدول أول: 3 أصناف
        t1_data = [
            ["Item", "Barcode", "Unit Cost", "Qty"],
            ["MED A", "1111222233334", "10.50", "2"],
            ["MED B", "2222333344445", "20.75", "4"],
            ["MED C", "3333444455556", "30.00", "1"],
        ]
        elements.append(Table(t1_data))
        elements.append(Spacer(1, 20))

        # جدول ثانٍ في نفس الصفحة: 3 أصناف
        t2_data = [
            ["Item", "Barcode", "Unit Cost", "Qty"],
            ["MED D", "4444555566667", "40.25", "3"],
            ["MED E", "5555666677778", "50.50", "5"],
            ["MED F", "6666777788889", "60.00", "2"],
        ]
        elements.append(Table(t2_data))

        doc.build(elements)

        items, report = parse_pdf_invoice_with_debug(self.test_pdf_path)

        # دمج نتائج الجدولين تلقائياً (3 + 3 = 6 أصناف)
        self.assertEqual(len(items), 6)
        expected_names = ["MED A", "MED B", "MED C", "MED D", "MED E", "MED F"]
        for it, exp_n in zip(items, expected_names):
            self.assertEqual(it["raw_name"], exp_n)
            self.assertGreater(it["cost_price"], 0)

    def test_cost_price_priority_multiple_columns(self):
        """اختبار أولوية سعر التكلفة عند وجود عمودين للسعر (Cost Price vs Unit Price)"""
        doc = SimpleDocTemplate(self.test_pdf_path, pagesize=letter)
        elements = []

        # الجدول يحتوي على كل من Unit Price و Cost Price
        data = [
            ["Item", "Unit Price", "Cost Price", "Qty"],
            ["TEST PRODUCT 1", "50.00", "35.50", "2"],
            ["TEST PRODUCT 2", "100.00", "70.25", "5"],
        ]
        elements.append(Table(data))
        doc.build(elements)

        items, report = parse_pdf_invoice_with_debug(self.test_pdf_path)

        self.assertEqual(len(items), 2)
        # يجب اختيار Cost Price (35.50 و 70.25) وليس Unit Price (50.00 و 100.00)
        self.assertEqual(items[0]["cost_price"], 35.50)
        self.assertEqual(items[1]["cost_price"], 70.25)

    def test_empty_cells_and_no_premature_stopping(self):
        """اختبار استمرار القراءة حتى آخر سطر عند وجود خلايا فارغة في بعض الأعمدة"""
        doc = SimpleDocTemplate(self.test_pdf_path, pagesize=letter)
        elements = []

        data = [
            ["Item", "Barcode", "Cost Price", "Qty", "Expiry"],
            ["ITEM 1", "12345678", "10.00", "1", "01/01/2028"],
            ["ITEM 2", "", "15.00", "2", ""],  # باركود وتاريخ فارغان
            ["ITEM 3", "87654321", "20.00", "", "01/05/2029"],  # كمية فارغة
            ["ITEM 4", "", "25.00", "3", ""],
            ["ITEM 5", "11223344", "30.00", "4", "01/12/2027"],  # السطر الأخير
        ]
        elements.append(Table(data))
        doc.build(elements)

        items, report = parse_pdf_invoice_with_debug(self.test_pdf_path)

        # قراءة جميع الصفوف حتى آخر سطر (5 من 5) دون توقف عند الخلايا الفارغة
        self.assertEqual(len(items), 5)
        self.assertEqual(items[4]["raw_name"], "ITEM 5")
        self.assertEqual(items[4]["cost_price"], 30.00)

if __name__ == '__main__':
    unittest.main()
