# -*- coding: utf-8 -*-
import sys
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
import urllib.request
import urllib.parse
import json
import uuid

url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000/api/catalog/upload-excel"

with open("product.template.xlsx", "rb") as f:
    file_bytes = f.read()

boundary = f"----WebKitFormBoundary{uuid.uuid4().hex}"
body_parts = [
    f"--{boundary}\r\n".encode("utf-8"),
    b'Content-Disposition: form-data; name="file"; filename="product.template.xlsx"\r\n',
    b'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n',
    file_bytes,
    f"\r\n--{boundary}--\r\n".encode("utf-8"),
]
body_data = b"".join(body_parts)

headers = {
    "Content-Type": f"multipart/form-data; boundary={boundary}",
    "Content-Length": str(len(body_data)),
    "User-Agent": "Mozilla/5.0"
}

req = urllib.request.Request(url, data=body_data, headers=headers, method="POST")
try:
    with urllib.request.urlopen(req, timeout=15) as res:
        res_text = res.read().decode("utf-8")
        print("Raw response:", res_text[:300])
        res_data = json.loads(res_text)
        print("Upload Status:", res.status)
        print("Success:", res_data.get("success"))
        print("Headers found:", len(res_data.get("headers", [])))
        print("Total rows:", res_data.get("total_rows"))
        print("Suggested mapping keys:", list(res_data.get("suggested_mapping", {}).keys()))
except Exception as e:
    print("FAILED:", e)
    sys.exit(1)
