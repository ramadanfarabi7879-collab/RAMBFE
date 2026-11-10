-- جداول الفواتير والمرتجعات وسجل المراجعة (نفس backend/db.py)
CREATE TABLE IF NOT EXISTS invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number TEXT NOT NULL UNIQUE, invoice_date TEXT NOT NULL,
    status TEXT DEFAULT 'draft', total_items INTEGER DEFAULT 0, total_packages INTEGER DEFAULT 0, total_amount REAL DEFAULT 0.0,
    user_name TEXT DEFAULT 'المسؤول', notes TEXT DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, confirmed_at TIMESTAMP
);
CREATE TABLE IF NOT EXISTS invoice_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL, invoice_number TEXT NOT NULL, product_code TEXT NOT NULL,
    product_name TEXT DEFAULT '', name_ar TEXT DEFAULT '', name_en TEXT DEFAULT '', batch_number TEXT NOT NULL, expiry_date TEXT NOT NULL,
    quantity INTEGER DEFAULT 0, sales_price REAL DEFAULT 0.0, unit_price REAL DEFAULT 0.0, tax_rate REAL DEFAULT 0.0, unit TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(invoice_id, product_code, batch_number, expiry_date)
);
CREATE INDEX IF NOT EXISTS idx_lines_invoice ON invoice_lines(invoice_id);
CREATE TABLE IF NOT EXISTS scanned_serials (
    id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL, invoice_number TEXT NOT NULL, line_id INTEGER, product_code TEXT NOT NULL,
    raw_code TEXT NOT NULL, raw_gtin_or_barcode TEXT NOT NULL, batch_number TEXT NOT NULL, serial_number TEXT NOT NULL, expiry_date TEXT NOT NULL,
    unit TEXT DEFAULT '', quantity INTEGER DEFAULT 1, user_name TEXT DEFAULT 'المسؤول', scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    is_confirmed INTEGER DEFAULT 0, is_returned INTEGER DEFAULT 0, return_reason TEXT DEFAULT '', returned_at TIMESTAMP, returned_by TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_serials_invoice ON scanned_serials(invoice_id);
CREATE INDEX IF NOT EXISTS idx_serials_line ON scanned_serials(line_id);
CREATE INDEX IF NOT EXISTS idx_serials_sn ON scanned_serials(serial_number);
CREATE TABLE IF NOT EXISTS returns_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, serial_id INTEGER, serial_number TEXT NOT NULL, product_code TEXT NOT NULL,
    invoice_number TEXT NOT NULL, return_reason TEXT NOT NULL, returned_by TEXT DEFAULT 'المسؤول', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS product_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_name TEXT NOT NULL UNIQUE, product_code TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, action TEXT NOT NULL,
    old_values TEXT DEFAULT '', new_values TEXT DEFAULT '', details TEXT DEFAULT '', user_name TEXT DEFAULT 'المسؤول', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS catalog_changes (seq INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, ts REAL NOT NULL);
