import sys
sys.stdout.reconfigure(encoding='utf-8')
import os, glob

print('=== DATA FILES ===')
for f in sorted(glob.glob('data/*'), key=os.path.getmtime, reverse=True):
    print(f"{f}: size={os.path.getsize(f)} mtime={os.path.getmtime(f)}")

print('\n=== TEMP FILES ===')
for f in sorted(glob.glob('temp/*'), key=os.path.getmtime, reverse=True)[:15]:
    print(f"{f}: size={os.path.getsize(f)} mtime={os.path.getmtime(f)}")
