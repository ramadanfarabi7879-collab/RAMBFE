import sqlite3

conn = sqlite3.connect('data/inventory.db')
c = conn.cursor()
c.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = [r[0] for r in c.fetchall()]
print('Tables in inventory.db:', tables)

for t in tables:
    try:
        c.execute(f"SELECT COUNT(*) FROM `{t}`")
        print(f"{t}: {c.fetchone()[0]}")
    except Exception as e:
        print(f"{t}: {e}")

conn.close()
