-- قاعدة بيانات Cloudflare D1 الدائمة للبرنامج (نفس جداول backend/db.py و backend/stock_manager.py)
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    gtin TEXT DEFAULT '', barcode TEXT DEFAULT '',
    name_ar TEXT DEFAULT '', name_en TEXT DEFAULT '', name TEXT NOT NULL,
    category TEXT DEFAULT '',
    selling_price REAL DEFAULT 0.0, unit_price REAL DEFAULT 0.0, cost_price REAL DEFAULT 0.0,
    tax_rate REAL DEFAULT 0.0, unit TEXT DEFAULT 'علبة', unit_divisions TEXT DEFAULT '',
    normalized_name TEXT DEFAULT '', normalized_name_ar TEXT DEFAULT '', normalized_name_en TEXT DEFAULT '',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    scientific_name TEXT DEFAULT '', company TEXT DEFAULT '', wholesale_price REAL DEFAULT 0.0
);
CREATE INDEX IF NOT EXISTS idx_products_gtin ON products(gtin);
CREATE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode);

CREATE TABLE IF NOT EXISTS product_barcodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_code TEXT NOT NULL, barcode TEXT NOT NULL, barcode_type TEXT DEFAULT 'barcode',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(product_code, barcode, barcode_type)
);
CREATE INDEX IF NOT EXISTS idx_prod_barcodes_val ON product_barcodes(barcode);
CREATE INDEX IF NOT EXISTS idx_prod_barcodes_code ON product_barcodes(product_code);

CREATE TABLE IF NOT EXISTS stock_stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_no TEXT UNIQUE NOT NULL, store_name TEXT NOT NULL,
    branch_name TEXT DEFAULT 'الفرع الرئيسي', status TEXT DEFAULT 'new',
    created_by TEXT DEFAULT 'المسؤول', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, counted_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS inventory_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_code TEXT NOT NULL, product_name TEXT, barcode TEXT,
    batch_number TEXT DEFAULT '', expiry_date TEXT DEFAULT '',
    system_qty REAL DEFAULT 0, cost_price REAL DEFAULT 0, selling_price REAL DEFAULT 0,
    item_type TEXT DEFAULT 'medicine', store_no TEXT DEFAULT 'ST-001', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_inv_code_batch ON inventory_records(product_code, batch_number);
CREATE INDEX IF NOT EXISTS idx_inv_store ON inventory_records(store_no);
CREATE INDEX IF NOT EXISTS idx_inv_barcode ON inventory_records(barcode);

CREATE TABLE IF NOT EXISTS stocktake_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_code TEXT NOT NULL, product_name TEXT, barcode TEXT DEFAULT '', gtin TEXT DEFAULT '',
    batch_number TEXT DEFAULT '', expiry_date TEXT DEFAULT '',
    system_qty REAL DEFAULT 0, counted_qty REAL DEFAULT 0, cost_price REAL DEFAULT 0, selling_price REAL DEFAULT 0,
    is_new_batch INTEGER DEFAULT 0, item_type TEXT DEFAULT 'medicine', store_no TEXT DEFAULT 'ST-001',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_stk_code_batch ON stocktake_entries(product_code, batch_number, store_no);
CREATE INDEX IF NOT EXISTS idx_stk_store ON stocktake_entries(store_no);

CREATE TABLE IF NOT EXISTS stocktake_scanned_serials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    serial_number TEXT NOT NULL, product_code TEXT NOT NULL, batch_number TEXT DEFAULT '',
    store_no TEXT DEFAULT 'ST-001', scanned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(serial_number, product_code, store_no)
);
CREATE INDEX IF NOT EXISTS idx_stk_serials_store ON stocktake_scanned_serials(store_no);

-- أحداث المزامنة اللحظية بين الكمبيوتر والموبايل
CREATE TABLE IF NOT EXISTS sync_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT DEFAULT '{}', ts REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_ts ON sync_events(ts);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

-- فهرس البحث السريع (trigram) لتقليل القراءات: rowid = products.id
CREATE VIRTUAL TABLE IF NOT EXISTS product_search USING fts5(txt, tokenize = 'trigram');
CREATE INDEX IF NOT EXISTS idx_products_numcode ON products(CAST(code AS INTEGER)) WHERE code GLOB '[0-9]*' AND length(code) <= 10;
