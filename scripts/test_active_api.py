import urllib.request
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

res = urllib.request.urlopen('http://127.0.0.1:8000/api/stock/stores')
data = json.loads(res.read().decode('utf-8'))
print("=== STORES RAW ===")
print(json.dumps(data, indent=2, ensure_ascii=False))

res_st27 = urllib.request.urlopen('http://127.0.0.1:8000/api/stock/store/details?store_no=ST-027')
data_st27 = json.loads(res_st27.read().decode('utf-8'))
print("=== STORE ST-027 RAW ===")
print("Keys:", data_st27.keys())
print("Items count:", len(data_st27.get('items', [])))
if data_st27.get('items'):
    print("First item:", json.dumps(data_st27['items'][0], indent=2, ensure_ascii=False))

res_st28 = urllib.request.urlopen('http://127.0.0.1:8000/api/stock/store/details?store_no=ST-028')
data_st28 = json.loads(res_st28.read().decode('utf-8'))
print("=== STORE ST-028 RAW ===")
print("Keys:", data_st28.keys())
print("Items count:", len(data_st28.get('items', [])))
if data_st28.get('items'):
    print("First item:", json.dumps(data_st28['items'][0], indent=2, ensure_ascii=False))
