-- الصيدليات (البروفايلات): كل صيدلية لها استوراتها ومخزونها وجردها وفواتيرها المستقلة، وكتالوج الأصناف مشترك
CREATE TABLE IF NOT EXISTS profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
INSERT OR IGNORE INTO profiles (id, name) VALUES (1, 'صيدلية 1');
ALTER TABLE stock_stores ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1;
ALTER TABLE invoices ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_stores_profile ON stock_stores(profile_id);
CREATE INDEX IF NOT EXISTS idx_invoices_profile ON invoices(profile_id, status);
