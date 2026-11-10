# -*- coding: utf-8 -*-
"""
اختبارات شاملة لإثبات ثبات مسار قاعدة البيانات، حارس الكتابة، النسخ الاحتياطي والاستعادة،
وعدم مسح بيانات الواجهة عند انقطاع الاتصال.
"""

import os
import sys
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
if str(BASE_DIR) not in sys.path:
    sys.path.insert(0, str(BASE_DIR))

from backend import db_safety
from backend import db


class TestDatabaseSafetyAndStability(unittest.TestCase):
    def test_01_permanent_db_path_is_independent_of_cwd(self):
        """التأكد أن مسار قاعدة البيانات الدائم لا يتأثر بتغيير مجلد التشغيل الحالي (cwd)."""
        orig_cwd = os.getcwd()
        orig_env = os.environ.pop("INVENTORY_DB_PATH", None)
        try:
            os.chdir(tempfile.gettempdir())
            resolved = db_safety.get_resolved_db_path()
            self.assertEqual(resolved, db_safety.PERMANENT_DB_PATH)
            self.assertTrue(resolved.endswith(os.path.join("data", "inventory.db")))
        finally:
            os.chdir(orig_cwd)
            if orig_env is not None:
                os.environ["INVENTORY_DB_PATH"] = orig_env

    def test_02_temp_directory_db_is_blocked_by_write_guard(self):
        """التأكد أن النظام يمنع استخدام مجلد temp كمسار لقاعدة البيانات."""
        orig_env = os.environ.get("INVENTORY_DB_PATH")
        try:
            os.environ["INVENTORY_DB_PATH"] = os.path.join(str(BASE_DIR), "temp", "bad_test.db")
            with self.assertRaises(db_safety.DatabaseSafetyError):
                db_safety.ensure_safe_db_target()
        finally:
            if orig_env is None:
                os.environ.pop("INVENTORY_DB_PATH", None)
            else:
                os.environ["INVENTORY_DB_PATH"] = orig_env

    def test_03_backup_and_restore_roundtrip_on_isolated_db(self):
        """اختبار إنشاء نسخة احتياطية متسقة واستعادتها بالكامل بدون فقدان أو تكرار."""
        with tempfile.TemporaryDirectory() as tmpdir:
            test_db = os.path.join(tmpdir, "test_inventory.db")
            orig_env = os.environ.get("INVENTORY_DB_PATH")
            orig_backup_dir = db_safety.BACKUP_DIR
            try:
                os.environ["INVENTORY_DB_PATH"] = test_db
                db_safety.BACKUP_DIR = os.path.join(tmpdir, "backups")
                db.init_db()

                # إدخال بيانات تجريبية (صنف + فاتورة + سجل جرد)
                ok, code, _ = db.save_or_update_product({
                    "code": "TST999",
                    "name_en": "STABILITY TEST ITEM",
                    "name_ar": "صنف اختبار الاستقرار",
                    "selling_price": 45.0,
                    "gtin_list": ["06289999999991"],
                })
                self.assertTrue(ok)
                self.assertEqual(code, "TST999")

                # إنشاء نسخة احتياطية متسقة والتحقق منها
                b_res = db_safety.create_backup(reason="unit_test")
                self.assertTrue(b_res["success"], b_res)
                self.assertEqual(b_res["products_count"], 1)

                # حذف الصنف من القاعدة (محاكاة فقدان غير مقصود)
                db.delete_product("TST999")
                self.assertIsNone(db.get_product_by_code("TST999"))

                # الاستعادة من النسخة الاحتياطية
                r_res = db_safety.restore_backup(b_res["path"], target_db_path=test_db)
                self.assertTrue(r_res["success"], r_res)

                restored = db.get_product_by_code("TST999")
                self.assertIsNotNone(restored)
                self.assertEqual(restored["name_en"], "STABILITY TEST ITEM")
            finally:
                db_safety.BACKUP_DIR = orig_backup_dir
                if orig_env is None:
                    os.environ.pop("INVENTORY_DB_PATH", None)
                else:
                    os.environ["INVENTORY_DB_PATH"] = orig_env

    def test_04_frontend_guards_against_503_offline_wipe(self):
        """التأكد من أن واجهة app.js و mobile.html لا تمسح الجداول عند رجوع 503 أو offline_reconnecting."""
        app_js = (BASE_DIR / "frontend" / "app.js").read_text(encoding="utf-8")
        mob_html = (BASE_DIR / "frontend" / "mobile.html").read_text(encoding="utf-8")

        self.assertIn("function isUnavailableApiResponse", app_js)
        self.assertIn("initConnectionHealthMonitor()", app_js)
        # التأكد من حماية كل دوال التحميل الأساسية
        for fn_snippet in (
            "async function loadInvoicesList()",
            "async function loadStocktakeStores(",
            "async function loadCurrentStoreItems(",
            "async function loadActiveDraftInvoice()",
        ):
            idx = app_js.index(fn_snippet)
            body_slice = app_js[idx:idx + 900]
            self.assertIn("isUnavailableApiResponse", body_slice, f"{fn_snippet} missing 503 guard")

        self.assertIn("data.offline_reconnecting || data.db_error", mob_html)


if __name__ == "__main__":
    unittest.main(verbosity=2)
