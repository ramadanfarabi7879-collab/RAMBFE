import os
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def cleanup_artifacts():
    with open("frontend/app.js", "rb") as f:
        lines = f.read().decode("utf-8").splitlines(True)
    # Remove duplicate lines 1463-1465 if present
    cleaned = []
    i = 0
    while i < len(lines):
        if (
            i + 2 < len(lines)
            and "const el = document.getElementById('field-batch');" in lines[i]
            and "if (el) el.value = '';" in lines[i + 1]
            and lines[i + 2].strip() == "});"
            and i > 1455
        ):
            i += 3
            continue
        cleaned.append(lines[i])
        i += 1
    with open("frontend/app.js", "wb") as f:
        f.write("".join(cleaned).encode("utf-8"))

    with open("backend/db.py", "rb") as f:
        db_lines = f.read().decode("utf-8").splitlines(True)
    db_cleaned = []
    for idx, line in enumerate(db_lines):
        if (
            idx + 1 < len(db_lines)
            and 'if not line.get("name_en") and line.get("product_name"):' in line
            and 'if not line.get("name_en") and line.get("product_name"):' in db_lines[idx + 1]
        ):
            continue
        db_cleaned.append(line)
    with open("backend/db.py", "wb") as f:
        f.write("".join(db_cleaned).encode("utf-8"))


def test_user_barcode_batch_uppercase():
    from backend.qr_parser import parse_qr_code
    # 1. Exact barcode provided by user (with shifted Arabic keyboard layout)
    raw_user = "010628514700092017271204104لإـ65621ْلآ2،ْ0}لآِ74ِ774لآلآ8×9"
    res1 = parse_qr_code(raw_user)
    assert res1["success"] is True
    assert res1["data"]["gtin"] == "06285147000920"
    assert res1["data"]["expiry"] == "2027-12-04"
    assert res1["data"]["batch"] == "4TJ656"
    assert res1["data"]["batch"].isupper()
    assert res1["data"]["serial"] == "XB2KX0CBA74A774BB8O9"

    # 2. Unshifted Arabic keyboard layout (when CapsLock is ON or scanner sends unshifted Arabic keys)
    raw_unshifted = "010628514700092017271204104فت65621ءلا2نء0ؤلاش74ش774لالا8خ9"
    res2 = parse_qr_code(raw_unshifted)
    assert res2["success"] is True
    assert res2["data"]["gtin"] == "06285147000920"
    assert res2["data"]["expiry"] == "2027-12-04"
    assert res2["data"]["batch"] == "4TJ656"
    assert res2["data"]["batch"].isupper()

    # 3. Direct English lowercase batch in GS1 barcode
    raw_lower = "010628514700092017271204104tj656\x1d21xb2kx0cba74a774bb8o9"
    res3 = parse_qr_code(raw_lower)
    assert res3["success"] is True
    assert res3["data"]["batch"] == "4TJ656"
    assert res3["data"]["serial"] == "XB2KX0CBA74A774BB8O9"


def test_database_batches_all_uppercase():
    from backend.db import init_db, get_connection
    from backend.stock_manager import init_stock_tables
    init_db()
    init_stock_tables()
    conn = get_connection()
    c = conn.cursor()
    for table in ("inventory_records", "stocktake_entries", "stocktake_scanned_serials", "invoice_lines", "scanned_serials"):
        c.execute(f"SELECT COUNT(*) FROM {table} WHERE batch_number IS NOT NULL AND batch_number != UPPER(batch_number)")
        cnt = c.fetchone()[0]
        assert cnt == 0, f"Table {table} still has {cnt} rows with lowercase batch_number"
    conn.close()


if __name__ == "__main__":
    cleanup_artifacts()
    test_user_barcode_batch_uppercase()
    test_database_batches_all_uppercase()
    print("ALL UPPERCASE BATCH TESTS PASSED SUCCESSFULLY!")
