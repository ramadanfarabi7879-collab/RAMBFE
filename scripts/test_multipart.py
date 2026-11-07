import openpyxl, io, zipfile, sys, os
sys.path.insert(0, os.path.abspath('.'))
from backend.server import parse_multipart

with open('product.template.xlsx', 'rb') as f:
    orig_bytes = f.read()

boundary = b'----WebKitFormBoundaryX999'
multipart_data = (
    b'--' + boundary + b'\r\n'
    b'Content-Disposition: form-data; name="file"; filename="product.template.xlsx"\r\n'
    b'Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'
    + orig_bytes +
    b'\r\n--' + boundary + b'--\r\n'
)

fields, files = parse_multipart(multipart_data, boundary)
if 'file' not in files:
    print("FAILED: 'file' not found in files")
    sys.exit(1)

extracted_bytes = files['file']['content']
print(f"Original size: {len(orig_bytes)}, Extracted size: {len(extracted_bytes)}")

if orig_bytes != extracted_bytes:
    print(f"FAILED: Size or byte mismatch! Orig: {len(orig_bytes)}, Extracted: {len(extracted_bytes)}")
    sys.exit(1)

zf = zipfile.ZipFile(io.BytesIO(extracted_bytes))
print(f"Zip test passed! Found {len(zf.namelist())} files in archive.")
