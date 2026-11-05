import sys
sys.stdout.reconfigure(encoding='utf-8')

with open('frontend/index.html', 'r', encoding='utf-8') as f:
    text = f.read()

pos = text.find('id="modal-camera-scanner"')
pos_end = text.find('</div>\n    </div>\n\n    <!-- =================== نافذة', pos)
if pos_end == -1:
    pos_end = pos + 3500

print(text[pos:pos_end])
