import sqlite3

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from backend.db_safety import get_resolved_db_path
conn = sqlite3.connect(get_resolved_db_path())
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
