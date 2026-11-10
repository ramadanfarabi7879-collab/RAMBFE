import urllib.request
import re

url = "https://rambfe.pages.dev/"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
html = urllib.request.urlopen(req, timeout=15).read().decode("utf-8", errors="ignore")

ids = set(re.findall(r'id=["\']([^"\']+)["\']', html))
targets = [
    'btn-stk-clear',
    'btn-stk-populate-inventory',
    'btn-stk-delete-active-store',
    'btn-stk-clear-inventory'
]

print("=== Cloudflare Live ID Status ===")
for t in targets:
    print(f"{t}: {t in ids}")
