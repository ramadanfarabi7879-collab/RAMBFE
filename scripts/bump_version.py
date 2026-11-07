# -*- coding: utf-8 -*-
import re

with open('frontend/index.html', 'r', encoding='utf-8') as f:
    c = f.read()

c = re.sub(r'app\.js\?v=[a-zA-Z0-9_-]+', 'app.js?v=20261107_v29_taxbadge_fix', c)

with open('frontend/index.html', 'w', encoding='utf-8') as f:
    f.write(c)

print("Bumped version to 20261107_v29_taxbadge_fix successfully!")
