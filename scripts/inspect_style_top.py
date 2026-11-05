import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('frontend/style.css', 'r', encoding='utf-8') as f:
    text = f.read()

print(text[:1200])
