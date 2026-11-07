import time
import os
import urllib.request
import json
import re

tunnel_url = ''
for _ in range(15):
    time.sleep(1)
    if os.path.exists('temp/cloudflare_url.txt'):
        with open('temp/cloudflare_url.txt', 'r', encoding='utf-8') as f:
            u = f.read().strip()
            if u.startswith('http'):
                tunnel_url = u
                break

print('Active tunnel:', tunnel_url)

if tunnel_url:
    reg_url = 'https://rambfe.quran-halaqat.workers.dev/api/tunnel/register'
    payload = json.dumps({'tunnel_url': tunnel_url}).encode('utf-8')
    req = urllib.request.Request(reg_url, data=payload, headers={'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0'})
    try:
        res = urllib.request.urlopen(req, timeout=10)
        print('Worker registration:', res.status)
    except Exception as e:
        print('Worker reg error:', e)

    with open('worker.js', 'r', encoding='utf-8') as f:
        w_code = f.read()

    w_code = re.sub(r'let activeTunnelUrl = "[^"]*";', f'let activeTunnelUrl = "{tunnel_url}";', w_code)
    with open('worker.js', 'w', encoding='utf-8') as f:
        f.write(w_code)
    print('Updated worker.js with', tunnel_url)
