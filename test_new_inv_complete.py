import os
import sys
import io
import subprocess
import json
import re

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

from backend.invoice_parser import clean_date_str, clean_batch_ocr, clean_discount
from backend.matcher import SmartMatcher

def test_full_solution():
    ocr_script = os.path.join("backend", "ocr_runner.ps1")
    cmd = ["powershell", "-ExecutionPolicy", "Bypass", "-File", ocr_script, "-InputPath", os.path.join("data", "last_uploaded_invoice.pdf"), "-Rotation", "0"]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore', timeout=90)
    raw_blocks = json.loads(proc.stdout)

    words = [w for b in raw_blocks for w in b.get('words', [])]
    words.sort(key=lambda w: (w['y'], w['x']))

    lines = []
    for w in words:
        placed = False
        for l in lines:
            if abs(l[0]['y'] - w['y']) < 6.0:
                l.append(w)
                placed = True
                break
        if not placed:
            lines.append([w])

    for l in lines:
        l.sort(key=lambda x: x['x'])

    deskewed_lines = [{'y': sum(w['y'] for w in l)/len(l), 'text': " ".join(w['text'] for w in l), 'words': l} for l in lines]
    deskewed_lines.sort(key=lambda x: x['y'])

    # Header / Footer
    pharma_h_idx = 0
    for i in range(min(12, len(deskewed_lines))):
        t_low = deskewed_lines[i]['text'].lower()
        if any(k in t_low for k in ['item description', 'unit price', 'u.price', 'u.pr1ce', 'disc', 'vat', 'net', 'exp.lot', 'exp date', 'الصنف', 'الوحدة', 'الكمية', 'التشغيلة', 'الصافي', 'الممعمله', 'uantit']):
            pharma_h_idx = max(pharma_h_idx, i)

    pharma_f_idx = len(deskewed_lines)
    for i in range(pharma_h_idx + 1, len(deskewed_lines)):
        t_low = deskewed_lines[i]['text'].lower()
        if any(kw in t_low for kw in ['total (excluding', 'grand total', 'net total', 'invoice total', 'camscanner', 'المسح الضوئي', 'salesman', 'توقيع المستلم', 'شروط السداد', 'فقط لاغير']):
            pharma_f_idx = min(pharma_f_idx, i)
            break

    p_table_lines = deskewed_lines[pharma_h_idx + 1:pharma_f_idx]
    
    # Anchors: Detect every line that has an expiry date or starts with item number
    anchors = []
    for i, l in enumerate(p_table_lines):
        txt = l['text']
        fw = l['words'][0]['text'].strip() if l['words'] else ""
        fw_x = l['words'][0]['x'] if l['words'] else 999
        
        has_date = bool(re.search(r'\b(20\d{2}[-/]\d{2}[-/]\d{2}|\d{2}[-/]\d{2}[-/]20\d{2})\b', txt)) or bool(re.search(r'\b202[a-z0-9][-/][a-z0-9]{2}[-/]\d{2}\b', txt, re.I))
        is_num = fw.isdigit() and 1 <= int(fw) <= 200 and fw_x < 100
        
        if has_date or is_num:
            if not anchors or (p_table_lines[i]['y'] - p_table_lines[anchors[-1]]['y'] >= 18.0):
                anchors.append(i)

    if anchors and anchors[0] > 0 and any(w['x'] > 500 for li in p_table_lines[:anchors[0]] for w in li['words']):
        anchors[0] = 0

    blocks = []
    for a_idx, l_pos in enumerate(anchors):
        end_pos = anchors[a_idx + 1] if a_idx + 1 < len(anchors) else len(p_table_lines)
        blocks.append(p_table_lines[l_pos:end_pos])

    print(f"Total blocks formed: {len(blocks)}")
    extracted_items = []
    generic_excludes = ('SALO%', 'SAIOO/0', 'SATO%', 'CAMSCANNER', 'TABLET', 'TABLETS', 'CAPSULE', 'SOLUTION', 'SUSPENSION', 'CREAM', 'GEL', 'TOTAL', 'NET', 'PRICE', 'QTY', 'VAT', 'DISC', 'OO')

    for b in blocks:
        all_w = [w for l in b for w in l['words']]
        first_line_w = b[0]['words'] if b else []
        last_line_w = b[-1]['words'] if b else []
        full_text = " ".join(l['text'] for l in b)

        # 1. Names
        en_words = []
        ar_words = []
        for w in all_w:
            if w['x'] < 450:
                wt = w['text'].strip()
                if re.match(r'^\d{1,2}$', wt) and w['x'] < 70:
                    continue
                if any(c.isalpha() and ord(c) < 128 for c in wt):
                    w_cl = re.sub(r'^[^\w]+|[^\w]+$', '', wt)
                    if w_cl.upper() not in generic_excludes and w_cl.upper() not in ('NO', 'NAME', 'EXP', 'LOT', 'QTY', 'PRICE', 'TOTAL', 'DISC', 'VAT', 'NET'):
                        en_words.append(w_cl)
                if any('\u0600' <= c <= '\u06FF' for c in wt):
                    w_cl = re.sub(r'^[^\w]+|[^\w]+$', '', wt)
                    if w_cl not in ('صنف', 'رقم', 'بيان', 'وحدة', 'كمية', 'سعر', 'خصم', 'اجمالي', 'ضريبة', 'صافي', 'تشغيلة'):
                        ar_words.append(w_cl)

        name_en = " ".join(en_words).strip()
        name_en = re.sub(r'^\s*[-.]?\d{1,3}\s+', '', name_en)
        name_ar = " ".join(ar_words).strip()

        # 2. Date
        exp_date = ""
        m_exp = re.search(r'\b(20\d{2}[-/]\d{2}[-/]\d{2}|\d{2}[-/]\d{2}[-/]20\d{2})\b', full_text)
        if m_exp:
            exp_date = clean_date_str(m_exp.group(0))
        elif re.search(r'\b202[a-z0-9][-/][a-z0-9]{2}[-/]\d{2}\b', full_text, re.I):
            m_corrupt = re.search(r'\b(202[a-z0-9][-/][a-z0-9]{2}[-/]\d{2})\b', full_text, re.I)
            if m_corrupt:
                clean_t = m_corrupt.group(0).replace('a', '8').replace('o', '0').replace('s', '5')
                exp_date = clean_date_str(clean_t)

        # 3. Batch
        batch = ""
        for w in reversed(last_line_w):
            wt = clean_batch_ocr(w['text'])
            if wt and re.match(r'^[A-Za-z0-9/\-]{4,14}$', wt) and wt.upper() not in generic_excludes:
                if not re.match(r'^\d{4}[-/]\d{2}[-/]\d{2}$', wt) and not re.match(r'^\d+\.\d+$', wt) and wt != exp_date:
                    batch = wt
                    break
        if not batch:
            for w in reversed(all_w):
                wt = clean_batch_ocr(w['text'])
                if wt and w['x'] >= 930 and re.match(r'^[A-Za-z0-9/\-]{4,14}$', wt) and wt.upper() not in generic_excludes:
                    if not re.match(r'^\d{4}[-/]\d{2}[-/]\d{2}$', wt) and not re.match(r'^\d+\.\d+$', wt) and wt != exp_date:
                        batch = wt
                        break
        if not batch:
            for w in reversed(all_w):
                wt = clean_batch_ocr(w['text'])
                if wt and re.match(r'^[A-Za-z0-9/\-]{4,14}$', wt) and wt.upper() not in generic_excludes and wt.lower() not in full_text.lower():
                    if not re.match(r'^\d{4}[-/]\d{2}[-/]\d{2}$', wt) and not re.match(r'^\d+\.\d+$', wt):
                        batch = wt
                        break

        # 4. Discount
        disc1 = 0.0
        pct_raw = re.findall(r'\b(\d+(?:\.\d+)?)\s*(?:%|0/0|0/6|o/o|O/O|0/O|SalO%|SatO%|SaiOO/0|Satom)', full_text)
        if not pct_raw:
            for w in all_w:
                if 660 <= w['x'] <= 820:
                    txt = w['text'].replace('%', '').strip()
                    if re.match(r'^\d+(\.\d+)?$', txt):
                        pct_raw.append(txt)

        valid_discs = []
        for p in pct_raw:
            v_d = clean_discount(p)
            if 0.5 <= v_d <= 95.0 and v_d != 15.0:
                valid_discs.append(v_d)

        if valid_discs:
            disc1 = valid_discs[0]

        # 5. Mathematical Qty & Price ($Q \times P = \text{Total}$)
        candidate_numbers = []
        for w in all_w:
            if w['x'] >= 420:
                wt = w['text'].replace(',', '').strip()
                for num_m in re.findall(r'\b\d+(?:\.\d+)?\b', wt):
                    try:
                        candidate_numbers.append((float(num_m), w['x'], w['y']))
                    except:
                        pass

        candidate_qs = [int(n[0]) for n in candidate_numbers if n[0] == int(n[0]) and 1 <= n[0] <= 3000 and n[0] not in (2026, 2027, 2028, 2029, 2030, 2031)]
        candidate_ps = [n[0] for n in candidate_numbers if 0.5 <= n[0] <= 3000.0]
        # Also support OCR missing decimal in price e.g. 13425 -> 134.25
        for n in candidate_numbers:
            if n[0] >= 1000.0 and n[0] not in (2026, 2027, 2028, 2029, 2030, 2031):
                candidate_ps.append(n[0] / 100.0)

        candidate_tots = [n[0] for n in candidate_numbers if n[0] >= 1.0]

        matching_triplets = []
        for q in candidate_qs:
            for p in candidate_ps:
                prod = round(q * p, 2)
                for tot in candidate_tots:
                    if abs(prod - tot) < 0.20 and tot >= p:
                        matching_triplets.append((tot, q, p))

        best_q = 1
        best_p = 0.0
        if matching_triplets:
            # Pick the triplet with the highest total amount (to avoid 1 * 1 = 1)
            matching_triplets.sort(key=lambda x: x[0], reverse=True)
            _, best_q, best_p = matching_triplets[0]
        else:
            q_cols = [n[0] for n in candidate_numbers if 440 <= n[1] <= 510 and n[0] == int(n[0])]
            p_cols = [n[0] for n in candidate_numbers if 515 <= n[1] <= 650]
            if q_cols: best_q = int(q_cols[0])
            if p_cols: best_p = p_cols[0]

        target_name = name_en or name_ar
        if target_name:
            extracted_items.append({
                "raw_name": target_name,
                "name_ar": name_ar,
                "name_en": name_en,
                "quantity": best_q,
                "bonus": 0,
                "discount_1": disc1,
                "discount_2": 0.0,
                "batch_number": batch,
                "expiry_date": exp_date,
                "invoice_price": best_p
            })

    print(f"\n--- Extracted {len(extracted_items)} items ---")
    for i, it in enumerate(extracted_items, 1):
        print(f"#{i:02d}: Name='{it['raw_name']}' | Qty={it['quantity']} | Price={it['invoice_price']} | Disc={it['discount_1']}% | Batch='{it['batch_number']}' | Exp='{it['expiry_date']}'")

    matcher = SmartMatcher()
    print("\n--- MATCHER OUTPUT ---")
    for i, it in enumerate(extracted_items, 1):
        m = matcher.match_item(it)
        print(f"#{i:02d}: {it['raw_name']} ==> Code={m['matched_code']} | NameEn='{m['matched_name_en']}' | Score={m['score']} | Selling={m['selling_price']} | Cost={m['cost_price']}")

test_full_solution()
