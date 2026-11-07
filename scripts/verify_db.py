import sqlite3
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

conn = sqlite3.connect('data/inventory.db')
conn.row_factory = sqlite3.Row
c = conn.cursor()

stores = [dict(r) for r in c.execute('SELECT * FROM stock_stores').fetchall()]
print(f"Stock Stores ({len(stores)}):")
for s in stores:
    print(" ", s)

prod_count = c.execute('SELECT count(*) FROM products').fetchone()[0]
barcode_count = c.execute('SELECT count(*) FROM product_barcodes').fetchone()[0]
inv_count = c.execute('SELECT count(*) FROM inventory_records').fetchone()[0]

print(f"\nProducts count: {prod_count}")
print(f"Barcodes count: {barcode_count}")
print(f"Inventory records count: {inv_count}")

# Check sample inventory records
inv_sample = [dict(r) for r in c.execute('SELECT * FROM inventory_records LIMIT 5').fetchall()]
print(f"\nSample inventory records ({len(inv_sample)}):")
for r in inv_sample:
    print(" ", r)

# Check sample products
prod_sample = [dict(r) for r in c.execute('SELECT code, name, barcode, gtin, category FROM products LIMIT 5').fetchall()]
print(f"\nSample products ({len(prod_sample)}):")
for p in prod_sample:
    print(" ", p)
