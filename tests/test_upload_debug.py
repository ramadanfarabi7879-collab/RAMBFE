import os
import uuid
import sys

from backend.server import parse_multipart, extract_boundary

with open('data/product_cards_catalog.xlsx', 'rb') as f:
    content = f.read()

boundary_str = '----WebKitFormBoundary' + uuid.uuid4().hex
header_bytes = f'--{boundary_str}\r\nContent-Disposition: form-data; name="file"; filename="product_cards_catalog.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n'.encode('utf-8')
footer_bytes = f'\r\n--{boundary_str}--\r\n'.encode('utf-8')
body = header_bytes + content + footer_bytes

fields, files = parse_multipart(body, boundary_str.encode('utf-8'))
print('Files parsed:', list(files.keys()))
if 'file' in files:
    print('Orig len:', len(content), 'Parsed len:', len(files['file']['content']))
    assert len(files['file']['content']) == len(content)
    print('Multipart parsed correctly!')
else:
    print('ERROR: Multipart parse failed to find file!')
