import os, json, subprocess, re
from backend.normalizer import normalize_arabic, normalize_english
from backend.matcher import SmartMatcher

fpath = r'C:\Users\PH\.gemini\antigravity\brain\a3dbe10e-3abb-42d2-ac0b-c94056e8e2ba\.user_uploaded\media_1791442230388.pdf'
ocr_script = os.path.join('backend', 'ocr_runner.ps1')
cmd = ['powershell', '-ExecutionPolicy', 'Bypass', '-File', ocr_script, '-InputPath', fpath, '-Rotation', '0']
proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
blocks = json.loads(proc.stdout) if proc.returncode == 0 and proc.stdout.strip() else []

matcher = SmartMatcher()

# Find header and footer
h_idx = -1
for i in range(min(30, len(blocks))):
    t_low = blocks[i]['text'].lower()
    if any(k in t_low for k in ['product', 'item description', 'unit price', 'qty', 'value', 'discl', 'disc1']):
        h_idx = max(h_idx, i)

f_idx = len(blocks)
for i in range(h_idx + 1, len(blocks)):
    t_low = blocks[i]['text'].lower()
    if any(kw in t_low for kw in ['camscanner', 'المسح الضوئي']):
        f_idx = min(f_idx, i)
        break

t_lines = blocks[h_idx + 1:f_idx]
print(f"Table lines: {len(t_lines)}")

# Group lines by barcode anchors at the bottom of each item block
bc_indices = []
for idx, l in enumerate(t_lines):
    txt = l['text']
    # A line with long barcode-like numbers (e.g. 0000001000978 or 10020656000013 or 0193991030503)
    if re.search(r'\b000000\d{5,8}\b|\b019399\d{5,8}\b|\b10020\d{8,11}\b', txt):
        bc_indices.append(idx)

print(f"Detected {len(bc_indices)} barcode lines: {bc_indices}")

items = []
prev_idx = 0
for bc_idx in bc_indices:
    item_lines = t_lines[prev_idx:bc_idx + 1]
    prev_idx = bc_idx + 1
    
    # Analyze item_lines
    bc_line = item_lines[-1]['text']
    desc_lines = item_lines[:-1]
    
    # 1. Barcode and item code
    m_bc = re.search(r'\b(000000\d{5,8}|019399\d{5,8})\b', bc_line)
    barcode = m_bc.group(1) if m_bc else ""
    
    m_code = re.search(r'\b(100\d{4}|101\d{4}|102\d{4}|103\d{4})\b', bc_line)
    code = m_code.group(1) if m_code else (barcode.lstrip('0') if barcode else "")
    
    # Batch & Expiry from barcode line
    m_exp = re.search(r'\b(\d{2}[-/]\d{2}[-/]20\d{2}|\d{2}[-/]\d{2}[-/]zc\w+)\b', bc_line, re.I)
    exp = m_exp.group(1).replace('-', '/') if m_exp else ""
    if 'zc' in exp.lower():
        exp = exp.replace('zczs', '2028').replace('ZCZS', '2028')
    
    # Batch is token between GTIN/code and date
    bc_tokens = bc_line.split()
    batch = ""
    for tok in bc_tokens:
        tok_cl = tok.strip('.,-')
        if tok_cl not in (barcode, code) and not re.match(r'^\d{12,16}$', tok_cl) and not re.search(r'\d{2}[-/]\d{2}', tok_cl):
            if len(tok_cl) >= 4 and any(c.isdigit() for c in tok_cl) and not tok_cl.isdigit() or len(tok_cl) in (5, 6, 7):
                batch = tok_cl
                break
    
    # 2. Name from desc_lines
    en_name = ""
    ar_name = ""
    prices = []
    qtys = []
    discs = []
    
    for dl in desc_lines:
        txt = dl['text']
        # Extract percentage discount
        m_disc = re.search(r'(\d+(?:\.\d+)?)\s*%', txt)
        if m_disc:
            discs.append(float(m_disc.group(1)))
            
        # Extract numbers on the right (x > 400)
        line_num_words = [w for w in dl['words'] if w['x'] > 420 and re.match(r'^\d+(?:\.\d+)?$', w['text'].replace(',', ''))]
        for w in line_num_words:
            val = float(w['text'].replace(',', ''))
            if '.' in w['text']:
                if val <= 200.0: prices.append(val)
            else:
                int_v = int(val)
                if 0 <= int_v <= 500: qtys.append(int_v)
                
        # Words for name (x < 420)
        name_words_en = [w['text'] for w in dl['words'] if w['x'] < 420 and any(c.isalpha() and ord(c) < 128 for c in w['text'])]
        name_words_ar = [w['text'] for w in dl['words'] if w['x'] < 420 and any('\u0600' <= c <= '\u06FF' for c in w['text'])]
        
        if name_words_en and not en_name:
            en_name = " ".join(name_words_en)
        if name_words_ar and not ar_name:
            ar_name = " ".join(name_words_ar)
            
    # Clean OCR corruptions in en_name
    en_clean = en_name.replace(')NADOæ', 'FENADEX').replace('IZOMG', '120MG').replace('æXODINE', 'FEXODINE').replace('@EH•+', 'HYFRESH').replace('fiEH++', 'HYFRESH').replace('INHD(A', 'INHIXA').replace("INOCOOY'L", 'LAXOCODYL')
    
    # Sort out paid qty and bonus qty
    paid_qty = max(qtys) if qtys else 1
    bonus_qty = min(qtys) if len(qtys) > 1 else 0
    unit_price = min(prices) if prices else 0.0
    disc1 = discs[0] if discs else 0.0
    
    raw_item = {
        "raw_name": en_clean or ar_name,
        "item_code": code,
        "barcode": barcode,
        "quantity": paid_qty,
        "bonus": bonus_qty,
        "cost_price": unit_price,
        "invoice_price": unit_price,
        "discount_1": disc1,
        "batch_number": batch,
        "expiry_date": exp
    }
    
    m = matcher.match_item(raw_item)
    items.append((raw_item, m))

with open('debug_3line_output.txt', 'w', encoding='utf-8') as f:
    f.write(f"Total matched items: {len(items)}\n")
    for i, (raw, m) in enumerate(items):
        f.write(f"#{i+1}: MatchedName='{m.get('matched_name_en')}' | MatchedCode='{m.get('matched_code')}' | Score={m.get('score')} | Qty={raw['quantity']} | Bonus={raw['bonus']} | Price={raw['cost_price']} | Batch='{raw['batch_number']}' | Exp='{raw['expiry_date']}'\n")
        f.write(f"     RawName='{raw['raw_name']}' | Barcode='{raw['barcode']}' | Code='{raw['item_code']}'\n")

print(f"Successfully processed {len(items)} items! Check debug_3line_output.txt")
