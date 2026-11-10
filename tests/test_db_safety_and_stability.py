# -*- coding: utf-8 -*-
"""
اختبارات شاملة لإثبات ثبات مسار قاعدة البيانات، حارس الكتابة، النسخ الاحتياطي المستقل،
منع استعادة نسخة أقدم فوق قاعدة أحدث، وصلاحيات نقاط الـ API الحساسة،
وعدم مسح بيانات الواجهة عند انقطاع الاتصال.
"""

import os
import sys
import time
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

                ok, code, _ = db.save_or_update_product({
                    "code": "TST999",
                    "name_en": "STABILITY TEST ITEM",
                    "name_ar": "صنف اختبار الاستقرار",
                    "selling_price": 45.0,
                    "gtin_list": ["06289999999991"],
                })
                self.assertTrue(ok)
                self.assertEqual(code, "TST999")

                b_res = db_safety.create_backup(reason="unit_test")
                self.assertTrue(b_res["success"], b_res)
                self.assertEqual(b_res["products_count"], 1)

                # حذف الصنف -> الآن القاعدة فيها 0 أصناف (أقل من النسخة الاحتياطية)
                db.delete_product("TST999")
                self.assertIsNone(db.get_product_by_code("TST999"))

                r_res = db_safety.restore_backup(
                    b_res["path"],
                    target_db_path=test_db,
                    confirm_overwrite_newer=True,
                )
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

    def test_05_restore_blocks_older_backup_over_newer_db_without_explicit_confirm(self):
        """التأكد أن الاستعادة ترفض استبدال قاعدة أحدث بنسخة أقدم ما لم تتوفر موافقة صريحة."""
        with tempfile.TemporaryDirectory() as tmpdir:
            test_db = os.path.join(tmpdir, "test_newer.db")
            orig_env = os.environ.get("INVENTORY_DB_PATH")
            orig_backup_dir = db_safety.BACKUP_DIR
            try:
                os.environ["INVENTORY_DB_PATH"] = test_db
                db_safety.BACKUP_DIR = os.path.join(tmpdir, "backups")
                db.init_db()
                db.save_or_update_product({"code": "OLD1", "name_en": "OLD ITEM"})
                b_res = db_safety.create_backup(reason="older_snap")
                self.assertTrue(b_res["success"])

                time.sleep(1.1)
                db.save_or_update_product({"code": "NEW2", "name_en": "NEWER ITEM"})

                # محاولة الاستعادة بدون موافقة صريحة -> يجب أن تُرفض
                blocked = db_safety.restore_backup(b_res["path"], target_db_path=test_db, confirm_overwrite_newer=False)
                self.assertFalse(blocked["success"])
                self.assertTrue(blocked.get("requires_explicit_confirmation"))
                self.assertEqual(blocked.get("code"), "NEWER_DATABASE_PROTECTED")
                self.assertIsNotNone(db.get_product_by_code("NEW2"))

                # مع الموافقة الصريحة -> تنجح
                allowed = db_safety.restore_backup(b_res["path"], target_db_path=test_db, confirm_overwrite_newer=True)
                self.assertTrue(allowed["success"])
                self.assertIsNone(db.get_product_by_code("NEW2"))
            finally:
                db_safety.BACKUP_DIR = orig_backup_dir
                if orig_env is None:
                    os.environ.pop("INVENTORY_DB_PATH", None)
                else:
                    os.environ["INVENTORY_DB_PATH"] = orig_env

    def test_06_admin_authorization_blocks_proxied_and_unauthenticated_restore(self):
        """التأكد من رفض طلبات Cloudflare الممررة وطلبات الاستعادة بدون X-Admin-Token."""
        # 1. طلب قادم عبر نفق Cloudflare (يحمل CF-Connecting-IP حتى لو بدا IP محلي) -> مرفوض
        ok1, _ = db_safety.is_authorized_admin_request(
            "127.0.0.1", {"CF-Connecting-IP": "198.51.100.1"}, require_token_always=False
        )
        self.assertFalse(ok1)

        # 2. طلب استعادة محلي بدون X-Admin-Token -> مرفوض
        ok2, _ = db_safety.is_authorized_admin_request(
            "127.0.0.1", {}, require_token_always=True
        )
        self.assertFalse(ok2)

        # 3. طلب برمز X-Admin-Token الصحيح -> مسموح
        tok = db_safety.get_or_create_admin_token()
        ok3, _ = db_safety.is_authorized_admin_request(
            "127.0.0.1", {"CF-Connecting-IP": "198.51.100.1", "X-Admin-Token": tok}, require_token_always=True
        )
        self.assertTrue(ok3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
