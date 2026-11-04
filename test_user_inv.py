import sys, json, os, subprocess, re
sys.stdout.reconfigure(encoding='utf-8')
from backend.invoice_parser import clean_date_str
from backend.matcher import SmartMatcher

ocr_script = os.path.join('backend', 'ocr_runner.ps1')
cmd = ['powershell', '-ExecutionPolicy', 'Bypass', '-File', ocr_script, '-InputPath', 'data/last_uploaded_invoice.pdf', '-Rotation', '0']
proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
blocks = json.loads(proc.stdout)

t_lines = blocks[2:]
anchors = []
for i, l in enumerate(t_lines):
    txt = l['text']
    w0 = l['words'][0]['text'] if l['words'] else ''
    x0 = l['words'][0]['x'] if l['words'] else 999
    
    fw_clean = re.sub(r'^[^\d]+|[^\d]+$', '', w0)
    is_num = (fw_clean.isdigit() and 1 <= int(fw_clean) <= 200 and x0 < 140)
    has_item_code = any(w['x'] < 200 and (re.match(r'^(1010\d{5}|IOA\w{6,8})$', w['text'])) for w in l['words'])
    has_date = bool(re.search(r'\b(20\d{2}[-/]\d{2}[-/]\d{2}|\d{2}[-/]\d{2}[-/]20\d{2})\b', txt)) and x0 < 120
    
    if is_num or has_item_code or has_date:
        if not anchors:
            anchors.append(i)
        elif t_lines[i]['y'] - t_lines[anchors[-1]]['y'] >= 16.0:
            anchors.append(i)

grouped = []
for a_idx, pos in enumerate(anchors):
    end_pos = anchors[a_idx + 1] if a_idx + 1 < len(anchors) else len(t_lines)
    grouped.append(t_lines[pos:end_pos])

matcher = SmartMatcher()
for idx, b in enumerate(grouped):
    all_w = [w for l in b for w in l['words']]
    full_text = ' '.join(l['text'] for l in b)
    
    # 1. Name
    en_words = []
    for w in all_w:
        wt = w['text'].strip()
        if w['x'] < 540:
            if re.match(r'^(1010\d{5}|IOA\w{6,8}|\d{1,2})$', wt) and w['x'] < 200: continue
            if re.match(r'^\d{2}[-/]\d{2}[-/]\d{4}$', wt) or re.match(r'^\d{4}[-/]\d{2}[-/]\d{2}$', wt): continue
            if any(c.isalpha() and ord(c) < 128 for c in wt):
                w_cl = re.sub(r'^[^\w]+|[^\w]+$', '', wt)
                if w_cl.upper() not in ('TACH', 'BATCH', 'EA', 'NO', 'EXP', 'LOT', 'DATE', 'PRICE', 'TOTAL', 'VAT', 'DISC'):
                    en_words.append(w_cl)
    name_en = ' '.join(en_words)
    
    # 2. Expiry date
    dates = re.findall(r'\b(\d{2}[-/]\d{2}[-/]20\d{2}|20\d{2}[-/]\d{2}[-/]\d{2})\b', full_text)
    exp = clean_date_str(dates[0]) if dates else ''
    
    # 3. Batch
    batch = ''
    m_bt = re.search(r'(?:tach|batch|btach)[\s\:\#]*([A-Za-z0-9]{4,12})', full_text, re.I)
    if m_bt and m_bt.group(1).upper() not in ('CANESTEN', 'CIPROGEN', 'CENTRUM', 'CLARA'):
        batch = m_bt.group(1)
    if not batch:
        for w in all_w:
            wt = w['text'].strip()
            if 140 <= w['x'] <= 180 and re.match(r'^[A-Za-z0-9]{4,10}$', wt):
                if wt.upper() not in ('TABLET', 'CREAM', 'SACHETS', 'ENERGY', 'SILVER', 'LUTEIN'):
                    batch = wt
                    break
                    
    # 4. Price & Qty
    price = 0.0
    qty = 1
    for w in all_w:
        if 630 <= w['x'] <= 670 and re.match(r'^\d+(\.\d+)?$', w['text']):
            price = float(w['text'])
            break
            
    line_total = 0.0
    for w in all_w:
        wt = w['text'].replace(',', '')
        if 920 <= w['x'] <= 970 and re.match(r'^\d+(\.\d+)?$', wt):
            line_total = float(wt)
            break
            
    cand_q = []
    for w in all_w:
        wt = w['text'].replace(',', '').replace('"', '').strip()
        if 580 <= w['x'] <= 620:
            if re.match(r'^\d+(\.\d+)?$', wt):
                cand_q.append(float(wt))
            elif wt == 'OO.':
                cand_q.append(50.0)
            elif wt in ('noo', 'moo', 'zoo'):
                cand_q.append(20.0)
            elif wt == '200':
                cand_q.append(2.0)
                
    if cand_q:
        qty = int(cand_q[0])
    elif price > 0 and line_total > 0:
        qty = int(round(line_total / price))
        
    m_item = matcher.match_item({'raw_name': name_en, 'quantity': qty, 'invoice_price': price, 'batch_number': batch, 'expiry_date': exp})
    c = m_item.get('matched_code')
    n = m_item.get('matched_name')
    q = m_item.get('quantity')
    p = m_item.get('cost_price')
    s = m_item.get('selling_price')
    b_val = m_item.get('batch_number')
    e_val = m_item.get('expiry_date')
    print(f"Item #{idx+1:02d}: code={c} | name={n} | qty={q} | cost={p} | sell={s} | batch={b_val} | exp={e_val}")
