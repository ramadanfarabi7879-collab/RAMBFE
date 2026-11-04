import os
import sys
import openpyxl

try:
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')
except:
    pass
from backend.db import (
    init_db, save_or_update_product, create_new_invoice,
    scan_qr_to_invoice, delete_scanned_serial, confirm_invoice,
    get_invoice_details, process_serial_return
)
from backend.excel_exporter import export_invoice_to_excel

def test_full_qr_invoice_lifecycle():
    init_db()

    # 1. Create a sample product with multiple GTINs and Barcodes
    sample_gtin = "06281086001234"
    sample_barcode = "6281086001234"
    
    saved, code, msg = save_or_update_product({
        "code": "888801",
        "name_ar": "بنادول إكسترا 500 ملغ",
        "name_en": "PANADOL EXTRA 500MG",
        "category": "دواء",
        "selling_price": 18.5,
        "unit_price": 14.0,
        "tax_rate": 15.0,
        "unit": "علبة",
        "unit_divisions": "علبة = 1، شريط = 2، حبة = 20",
        "gtin_list": [sample_gtin, "01234567890123"],
        "barcode_list": [sample_barcode, "00012345"]
    })
    assert saved is True
    print(f"Sample product created with code {code}")

    # 2. Create a new draft invoice
    inv = create_new_invoice(notes="فاتورة اختبار معايير القبول")
    inv_id = inv["id"]
    inv_num = inv["invoice_number"]
    print(f"Created draft invoice {inv_num} (id: {inv_id})")

    # 3. Test Scan 1: BT456 with serial S001
    qr1 = f"(01){sample_gtin}(17)261031(10)BT456(21)S001"
    res1 = scan_qr_to_invoice(inv_id, qr1)
    assert res1["success"] is True, f"Failed res1: {res1}"
    assert res1["line_qty"] == 1
    assert "تمت إضافة العبوة، والكمية الحالية: 1." in res1["message"]
    print("Scan 1 Passed:", res1["message"])

    # 4. Test Scan 2: BT456 with serial S002 (Same item, same batch, same expiry, different serial)
    qr2 = f"(01){sample_gtin}(17)261031(10)BT456(21)S002"
    res2 = scan_qr_to_invoice(inv_id, qr2)
    assert res2["success"] is True
    assert res2["line_qty"] == 2
    assert "تمت إضافة العبوة، والكمية الحالية: 2." in res2["message"]
    print("Scan 2 Passed:", res2["message"])

    # 5. Test Scan 3: Duplicate scan of S001 -> MUST BE REJECTED, quantity unchanged!
    res3 = scan_qr_to_invoice(inv_id, qr1)
    assert res3["success"] is False
    assert res3["code"] == "DUPLICATE_IN_CURRENT"
    assert "هذا السيريال مسجل بالفعل، ولم تتم إضافة العبوة مرة أخرى." in res3["message"]
    print("Scan 3 Duplicate Rejection Passed:", res3["message"])

    # Verify line still has quantity 2
    inv_details = get_invoice_details(inv_id)
    assert len(inv_details["lines"]) == 1
    assert inv_details["lines"][0]["quantity"] == 2
    assert len(inv_details["lines"][0]["serials"]) == 2

    # 6. Test Scan 4: Same item, DIFFERENT BATCH BT789 -> MUST CREATE NEW INDEPENDENT LINE
    qr4 = f"(01){sample_gtin}(17)261031(10)BT789(21)S003"
    res4 = scan_qr_to_invoice(inv_id, qr4)
    assert res4["success"] is True
    assert res4["line_qty"] == 1
    print("Scan 4 Different Batch Passed:", res4["message"])

    # Verify invoice now has 2 distinct lines
    inv_details = get_invoice_details(inv_id)
    assert len(inv_details["lines"]) == 2
    print("Verified 2 distinct lines for different batches.")

    # 7. Test Scan 5: Same item, same batch BT456, DIFFERENT EXPIRY -> MUST CREATE NEW LINE
    qr5 = f"(01){sample_gtin}(17)270515(10)BT456(21)S004"
    res5 = scan_qr_to_invoice(inv_id, qr5)
    assert res5["success"] is True
    assert res5["line_qty"] == 1
    print("Scan 5 Different Expiry Passed:", res5["message"])

    inv_details = get_invoice_details(inv_id)
    assert len(inv_details["lines"]) == 3
    print("Verified 3 distinct lines total.")

    # 8. Test deleting an erroneously added serial:
    # Delete S002 from the first line (which has 2 serials: S001 and S002)
    first_line_serials = inv_details["lines"][0]["serials"]
    s002_id = next(s["id"] for s in first_line_serials if s["serial_number"] == "S002")
    del_res = delete_scanned_serial(inv_id, s002_id)
    assert del_res["success"] is True
    print("Delete serial S002 passed:", del_res["message"])

    # Verify line 1 quantity dropped from 2 to 1
    inv_details = get_invoice_details(inv_id)
    assert inv_details["lines"][0]["quantity"] == 1

    # 9. Test Confirming the invoice
    conf_res = confirm_invoice(inv_id)
    assert conf_res["success"] is True
    assert "تم اعتماد الفاتورة ويمكن تصديرها إلى Excel." in conf_res["message"]
    print("Invoice confirmation passed:", conf_res["message"])

    # 10. Test duplicate serial check across CONFIRMED invoices:
    # Create another new invoice and try to scan S001
    inv2 = create_new_invoice(notes="فاتورة جديدة ثانية")
    inv2_id = inv2["id"]
    res_confirmed_dup = scan_qr_to_invoice(inv2_id, qr1)
    assert res_confirmed_dup["success"] is False
    assert res_confirmed_dup["code"] == "ALREADY_CONFIRMED"
    assert "هذا السيريال مسجل بالفعل في فاتورة معتمدة سابقة" in res_confirmed_dup["message"]
    print("Confirmed serial cross-invoice duplicate rejection passed:", res_confirmed_dup["message"])

    # 11. Test Documented Return (الإرجاع الموثق)
    ret_res = process_serial_return("S001", invoice_number=inv_num, reason="تالفة أثناء النقل")
    assert ret_res["success"] is True
    print("Documented return passed:", ret_res["message"])

    # 12. Test Excel Export
    excel_path = os.path.join("temp", f"Test_{inv_num}.xlsx")
    export_invoice_to_excel(inv_details, excel_path)
    assert os.path.exists(excel_path)
    
    # Inspect exported Excel
    wb = openpyxl.load_workbook(excel_path)
    ws = wb.active
    assert ws.views.sheetView[0].rightToLeft is True, "Sheet must be RTL!"
    assert ws.freeze_panes == 'A2', "Header row must be frozen!"

    rows = list(ws.iter_rows(values_only=True))
    headers = list(rows[0])
    expected_headers = ['PRODUCT', 'NAME', 'SALES PRICE', 'BATCH NUMBER', 'QUANTITE', 'UNITPRICE', 'expiry-date']
    assert headers == expected_headers, f"Expected {expected_headers}, got {headers}"
    print("Excel Export verified with exact headers, RTL sheet, and freeze panes!")
    print(f"Excel row 1: {rows[1]}")

    print("\nALL INVOICE & SCANNING ACCEPTANCE CRITERIA VERIFIED 100%!")

if __name__ == '__main__':
    test_full_qr_invoice_lifecycle()
