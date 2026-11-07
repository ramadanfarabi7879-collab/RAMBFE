import sys
import os
import openpyxl

sys.stdout.reconfigure(encoding='utf-8')

# Add project root to sys.path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend.excel_exporter import export_invoice_stock_count_to_excel, export_invoice_custom_columns_to_excel

BRANCH_LOCATIONS = [
    'WH001/Stock',
    'expir/Stock',
    'PH001/Stock',
    'PH002/Stock',
    'PH003/Stock',
    'PH004/Stock',
    'PH005/Stock',
    'PH006/Stock',
    'PH007/Stock',
    'PH008/Stock',
    'PH009/Stock'
]

def test_invoice_stock_count_location_export():
    sample_invoice = {
        "invoice_number": "INV-TEST-001",
        "invoice_date": "2026-11-07",
        "lines": [
            {
                "product_code": "1001",
                "name_en": "PANADOL ADVANCE 24 TAB",
                "batch_number": "BAT123",
                "expiry_date": "2027-12-31",
                "quantity": 10
            },
            {
                "product_code": "1002",
                "name_en": "ADOL 500MG CAPLETS",
                "batch_number": "BAT456",
                "expiry_date": "2028-06-30",
                "quantity": 25
            }
        ]
    }

    test_out = os.path.join(os.path.dirname(__file__), "test_stock_out.xlsx")

    for branch in BRANCH_LOCATIONS:
        res_path = export_invoice_stock_count_to_excel(
            sample_invoice,
            test_out,
            sheet_title="STOCK_TEST",
            location_value=branch
        )
        assert os.path.exists(res_path), f"Output file does not exist: {res_path}"

        wb = openpyxl.load_workbook(res_path)
        ws = wb.active
        assert ws.title == "STOCK_TEST"

        # Check headers
        headers = [cell.value for cell in ws[1]]
        assert headers == [
            "Product",
            "NAME ENGLISH",
            "Location",
            "Lot/Serial Number",
            "Expiry Date",
            "Counted quantity"
        ], f"Unexpected headers: {headers}"

        # Check rows
        for row_idx in [2, 3]:
            loc_val = ws.cell(row=row_idx, column=3).value
            assert loc_val == branch, f"Expected Location '{branch}' in row {row_idx}, got '{loc_val}'"

        wb.close()

    if os.path.exists(test_out):
        os.remove(test_out)

    print(f"PASS: test_invoice_stock_count_location_export with all {len(BRANCH_LOCATIONS)} branches!")

def test_custom_columns_location_export():
    sample_invoice = {
        "lines": [
            {
                "product_code": "2001",
                "name_en": "AUGMENTIN 1G TAB",
                "sales_price": 55.50,
                "batch_number": "AUG99",
                "quantity": 5,
                "unit_price": 40.00,
                "expiry_date": "2027-01-01"
            }
        ]
    }
    test_out = os.path.join(os.path.dirname(__file__), "test_custom_out.xlsx")
    cols = [
        {"field": "product_code", "header": "Product"},
        {"field": "name_en", "header": "Name"},
        {"field": "location", "header": "Location"},
        {"field": "quantity", "header": "Counted quantity"}
    ]
    res_path = export_invoice_custom_columns_to_excel(
        sample_invoice,
        test_out,
        column_specs=cols,
        sheet_title="CUSTOM_LOC",
        location_value="PH004/Stock"
    )
    wb = openpyxl.load_workbook(res_path)
    ws = wb.active
    assert ws.cell(row=2, column=3).value == "PH004/Stock"
    wb.close()
    if os.path.exists(test_out):
        os.remove(test_out)
    print("PASS: test_custom_columns_location_export!")

if __name__ == "__main__":
    test_invoice_stock_count_location_export()
    test_custom_columns_location_export()
    print("ALL TESTS PASSED SUCCESSFULLY!")
