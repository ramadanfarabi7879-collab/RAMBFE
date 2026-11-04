import sys, json, os, subprocess, re, numpy as np
sys.stdout.reconfigure(encoding='utf-8')

ocr_script = os.path.join('backend', 'ocr_runner.ps1')
cmd = ['powershell', '-ExecutionPolicy', 'Bypass', '-File', ocr_script, '-InputPath', 'tests/samples/inv2_5items.pdf', '-Rotation', '0']
proc = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
line_infos = json.loads(proc.stdout)

all_raw_words = [w for li in line_infos for w in li.get('words', [])]
def _calc_skew(words_list):
    slopes = np.linspace(-0.08, 0.08, 65)
    y_arr = np.array([w['y'] for w in words_list])
    x_arr = np.array([w['x'] for w in words_list])
    best_s = 0.0
    best_sc = -1.0
    for m in slopes:
        y_p = y_arr - m * x_arr
        bins = np.arange(np.min(y_p), np.max(y_p) + 6, 4.0)
        hist, _ = np.histogram(y_p, bins=bins)
        sc = np.sum(hist ** 2)
        if sc > best_sc:
            best_sc = sc
            best_s = m
    return best_s

skew_slope = _calc_skew(all_raw_words)
words_corr = []
for w in all_raw_words:
    wn = dict(w)
    wn['y_corr'] = w['y'] - skew_slope * w['x']
    words_corr.append(wn)
words_corr.sort(key=lambda w: (w['y_corr'], w['x']))

deskewed_lines = []
for w in words_corr:
    placed = False
    for dl in deskewed_lines:
        if abs(dl['y_corr'] - w['y_corr']) < 7.0:
            dl['words'].append(w)
            dl['y_corr'] = sum(x['y_corr'] for x in dl['words']) / len(dl['words'])
            dl['y'] = sum(x['y'] for x in dl['words']) / len(dl['words'])
            placed = True
            break
    if not placed:
        deskewed_lines.append({'y_corr': w['y_corr'], 'y': w['y'], 'words': [w]})

for dl in deskewed_lines:
    dl['words'].sort(key=lambda x: x['x'])
    dl['text'] = " ".join(w['text'] for w in dl['words'])

pharma_h_idx = 0
for i in range(min(35, len(deskewed_lines))):
    t_low = deskewed_lines[i]['text'].lower()
    if any(fw in t_low for fw in ['grand total', 'total (excluding', 'invoice total', 'net total', 'camscanner']):
        break
    header_score = sum(1 for k in ['u.price', 'u.pr1ce', 'unit price', 'item description', 'item name', 'exp date', 'exp.lot', 'exp.uot', 'totat', 'disc.', 'سعر الوحدة', 'تاريخ الصلاحية', 'اسم الصنف', 'الكمية', 'الصنف', 'uantit'] if k in t_low)
    if header_score >= 2 or any(k in t_low for k in ['item description', 'unit price', 'u.price', 'u.pr1ce', 'سعر الوحدة']):
        pharma_h_idx = max(pharma_h_idx, i)

# Advance past bilingual subheaders
if pharma_h_idx > 0 and pharma_h_idx + 1 < len(deskewed_lines):
    next_t = deskewed_lines[pharma_h_idx + 1]['text'].lower()
    if any(k in next_t for k in ['الصنف', 'الصلاحية', 'الوحدة', 'الكمية', 'الاجمالي', 'الهرمة', 'رلم', 'لمصافه']):
        pharma_h_idx += 1

print(f"pharma_h_idx = {pharma_h_idx}")

pharma_f_idx = len(deskewed_lines)
for i in range(pharma_h_idx + 1, len(deskewed_lines)):
    t_low = deskewed_lines[i]['text'].lower()
    if any(kw in t_low for kw in ['total (excluding', 'grand total', 'net total', 'invoice total', 'camscanner', 'المسح الضوئي', 'salesman', 'توقيع المستلم', 'شروط السداد', 'فقط لاغير', 'four thousand']):
        pharma_f_idx = min(pharma_f_idx, i)
        break

print(f"pharma_f_idx = {pharma_f_idx}")
p_table_lines = deskewed_lines[pharma_h_idx + 1:pharma_f_idx]
print(f"p_table_lines count = {len(p_table_lines)}")
for l in p_table_lines:
    print(f"  {l['text']}")
