// استيراد كتالوج الأصناف من إكسيل في المتصفح (منقول من backend/catalog_importer.py) — يعمل من الرابط بدون الكمبيوتر.
// يعترض نفس مسارات الشاشة الحالية: /api/catalog/upload-excel و preview-import و commit-import.
(function (root) {
    // ---------------- قراءة الملف بنفس سلوك pandas (dtype=str) ----------------
    function pyFloatRepr(v) {
        if (Number.isInteger(v) && Math.abs(v) < 1e16) return v.toFixed(1);
        const a = Math.abs(v);
        if (a !== 0 && (a >= 1e16 || a < 1e-4)) {
            let [m, e] = v.toExponential().split('e');
            const en = parseInt(e, 10);
            return `${m}e${en < 0 ? '-' : '+'}${String(Math.abs(en)).padStart(2, '0')}`;
        }
        return String(v);
    }
    const p2 = (n) => String(n).padStart(2, '0');
    // تحويل قيمة الخلية إلى نص كما يفعل pandas مع openpyxl (أو null للخلية الفارغة)
    function cellToStr(XLSX, cell) {
        if (!cell || cell.t === 'z' || cell.v === undefined || cell.v === null) return null;
        if (cell.t === 'e') return cell.w || '#N/A';
        if (cell.t === 'b') return cell.v ? 'True' : 'False';
        if (cell.t === 'n') {
            if (cell.z && XLSX.SSF.is_date(cell.z)) {
                const d = XLSX.SSF.parse_date_code(cell.v);
                if (cell.v < 1 && cell.v >= 0) return `${p2(d.H)}:${p2(d.M)}:${p2(Math.floor(d.S))}`;
                return `${d.y}-${p2(d.m)}-${p2(d.d)} ${p2(d.H)}:${p2(d.M)}:${p2(Math.floor(d.S))}`;
            }
            return Number.isInteger(cell.v) && Math.abs(cell.v) < 1e16 ? String(cell.v) : pyFloatRepr(cell.v);
        }
        if (cell.t === 'd') { const d = cell.v; return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; }
        return String(cell.v);
    }
    // كل صفوف الورقة الأولى من الخلية A1 مع حذف الصفوف الفارغة في النهاية
    function sheetMatrix(XLSX, wb) {
        const ws = wb.Sheets[wb.SheetNames[0]];
        if (!ws || !ws['!ref']) return [];
        const rng = XLSX.utils.decode_range(ws['!ref']);
        const rows = [];
        for (let r = 0; r <= rng.e.r; r++) {
            const row = [];
            for (let c = 0; c <= rng.e.c; c++) row.push(cellToStr(XLSX, ws[XLSX.utils.encode_cell({ r, c })]));
            rows.push(row);
        }
        while (rows.length && rows[rows.length - 1].every(v => v === null)) rows.pop();
        let width = 0;
        for (const r of rows) { let w = r.length; while (w > 0 && r[w - 1] === null) w--; if (w > width) width = w; }
        return rows.map(r => r.slice(0, width));
    }
    const blank = (r) => r.every(v => v === null || v === '');
    const KEYWORDS = ['name', 'item', 'product', 'code', 'barcode', 'gtin', 'price', 'qty', 'batch', 'serial', 'cost', 'sale', 'sold', 'category', 'unit', 'tax', 'profit', 'vat',
        'اسم', 'صنف', 'منتج', 'كود', 'رمز', 'باركود', 'سعر', 'تكلفة', 'كمية', 'باتش', 'سيريال', 'تصنيف', 'ضريبة', 'وحدة'];

    // نفس read_spreadsheet_dataframe: يرجع الأعمدة والصفوف (كقواميس) ورقم صف العناوين
    function readDataframe(XLSX, wb) {
        const all = sheetMatrix(XLSX, wb);   // pandas يحتفظ بالصفوف الفارغة داخل الملف (ويحذف الفارغة في النهاية فقط)
        let best = 0, maxScore = -1;
        for (let i = 0; i < Math.min(15, all.length); i++) {
            const vals = all[i].filter(x => x !== null && String(x).trim() !== '' && String(x).trim().toLowerCase() !== 'nan').map(x => String(x).trim());
            if (vals.length < 2) continue;
            let score = vals.length;
            for (const v of vals) if (KEYWORDS.some(k => v.toLowerCase().includes(k))) score += 6;
            if (score > maxScore) { maxScore = score; best = i; }
        }
        const hdr = all[best] || [];
        const width = Math.max(hdr.length, ...all.slice(best + 1).map(r => r.length), 0);
        const raw = [];
        const seen = {};
        for (let i = 0; i < width; i++) {
            let h = hdr[i];
            let name = (h === null || h === undefined || h === '') ? `Unnamed: ${i}` : String(h);
            if (seen[name] !== undefined) { let k = seen[name] + 1; while (seen[`${name}.${k}`] !== undefined) k++; seen[name] = k; name = `${name}.${k}`; }
            seen[name] = seen[name] ?? 0;
            raw.push(name);
        }
        const cols = raw.map((c, i) => {
            const s = String(c).trim();
            return (!s || s.toLowerCase().startsWith('unnamed:') || s.toLowerCase() === 'nan') ? `عمود_${i + 1}` : s;
        });
        const rows = all.slice(best + 1).map(r => { const o = {}; cols.forEach((c, i) => { const v = r[i]; o[c] = (v === null || v === undefined) ? '' : v; }); return o; });
        return { columns: cols, rows, header_row_idx: best, sheet_names: wb.SheetNames.slice() };
    }

    function suggestColumnsMapping(headers) {
        const find = (cands) => {
            for (const cand of cands) { const cl = cand.toLowerCase().trim(); for (const h of headers) { const hl = h.toLowerCase().trim(); if (hl === cl || hl.includes(cl)) return h; } }
            return '';
        };
        const code = find(['internal reference', 'item code', 'product code', 'كود الصنف', 'رمز الصنف', 'code', 'default_code', 'reference', 'sequence']);
        return {
            code_col: code,
            name_ar_col: find(['name (ar)', 'name_ar', 'name arabic', 'arabic', 'الاسم بالعربي', 'اسم عربي', 'اسم الصنف عربي', 'عربي']),
            name_en_col: find(['name (en)', 'name_en', 'name englis', 'name english', 'english', 'name', 'product_name', 'item name', 'اسم الصنف', 'اسم المنتج', 'description']),
            scientific_name_col: find(['scientific name', 'scientific_name', 'scientific', 'الاسم العلمي', 'المادة الفعالة']),
            company_col: find(['company', 'manufacturer', 'الشركة', 'المصنع', 'الشركة المصنعة']),
            category_col: find(['product category', 'category 2', 'category', 'تصنيف', 'التصنيف', 'النوع', 'القسم']),
            selling_price_col: find(['sales price', 'sale_price', 'selling_price', 'price', 'سعر البيع', 'سعر']),
            unit_price_col: find(['cost price', 'unit price', 'unit cost', 'purchase price', 'unit_price', 'unitprice', 'cost', 'سعر التكلفة', 'سعر الوحدة', 'التكلفة']),
            wholesale_price_col: find(['wholesale price', 'wholesale_price', 'wholesale', 'سعر الجملة', 'جملة']),
            tax_rate_col: find(['customer tax', 'customer_tax', 'customer taxes', 'customer_taxes', 'customertax', 'customertaxes', 'tax customer',
                'tax rate', 'tax_rate', 'نسبة الضريبة', 'الضريبة', 'ضريبة', 'vat', 'tax', 'taxes', 'خاضع للضريبة']),
            unit_col: find(['unit', 'وحدة']),
            unit_divisions_col: find(['unit_divisions', 'divisions', 'معامل التحويل', 'تقسيم الوحدات']),
            grouping_col: code || '',
            barcode_cols: headers.filter(h => ['barcode', 'باركود', 'ean'].some(k => h.toLowerCase().includes(k)) && !['gtin', 'جي تي ان'].some(k => h.toLowerCase().includes(k))),
            gtin_cols: headers.filter(h => ['gtin', 'جي تي ان'].some(k => h.toLowerCase().includes(k)))
        };
    }

    function parseTaxRateCell(val) {
        if (val === null || val === undefined) return [false, 0];
        const s = String(val).trim();
        if (!s || ['nan', 'null', 'none', '<na>', ''].includes(s.toLowerCase())) return [false, 0];
        const sl = s.toLowerCase();
        if (['false', 'f', '0', '0.0', '0%', 'no', 'off', 'غير خاضع', 'معفى', 'معفي', 'بدون', 'exempt'].includes(sl)) return [true, 0];
        if (['vat', 'true', 't', 'yes', 'on', 'خاضع', 'ضريبة', 'خاضع للضريبة', 'خاضع للقيمة المضافة', 'قيمة مضافة'].includes(sl)) return [true, 15];
        const m = s.replaceAll(',', '').match(/(\d+(?:\.\d+)?)/);
        if (m) {
            const n = parseFloat(m[1]);
            if (n > 0 && n <= 1) return [true, pyRound(n * 100, 2)];
            return [true, pyRound(n, 2)];
        }
        if (sl.includes('vat') || sl.includes('tax') || s.includes('ضريب')) return [true, 15];
        return [false, 0];
    }

    // ---------------- أدوات منقولة من qr_parser/db (نسخة المتصفح) ----------------
    let Q = null;  // تُحمّل من /cloud-qr.js (نفس كود السحابة)
    let pyRound = (x, n) => Number(Number(x).toFixed(n));

    async function api(path, body) {
        const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || d.success === false) throw new Error(d.message || d.detail || `HTTP ${res.status}`);
        return d;
    }
    async function lookup(codes, barcodes) {
        const out = { products: {}, barcodes: {}, max_code: null };
        const C = [...new Set(codes)], B = [...new Set(barcodes)];
        for (let i = 0; i < Math.max(C.length, B.length); i += 600) {
            const r = await api('/api/catalog/import/lookup', { codes: C.slice(i, i + 600), barcodes: B.slice(i, i + 600) });
            Object.assign(out.products, r.products);
            // ترتيب "آخر صف يفوز" يُحفظ داخل كل دفعة؛ الباركود الواحد يظهر في دفعة واحدة فقط
            Object.assign(out.barcodes, r.barcodes);
            out.max_code = r.max_code;
        }
        return out;
    }

    const cleanCell = (v) => { if (v === null || v === undefined) return ''; const s = String(v).trim(); return ['nan', 'null', 'none'].includes(s.toLowerCase()) ? '' : s; };
    const toFloat = (v, def = 0) => { const s = cleanCell(v).replaceAll(',', ''); if (!s) return def; const n = Number(s); return (Number.isFinite(n) || /^[+-]?(inf|infinity)$/i.test(s)) ? (Number.isFinite(n) ? n : def) : def; };
    const has = (row, col) => Object.prototype.hasOwnProperty.call(row, col);
    const get = (row, col, def) => (col !== '' && has(row, col)) ? row[col] : (has(row, col) ? row[col] : def);
    const isPyDigit = (s) => /^\p{Nd}+$/u.test(s);

    // نفس parse_and_validate_import_data
    async function parseAndValidate(df, mapping) {
        const m = (a, b) => mapping[a] || mapping[b] || '';
        const codeCol = m('code_col', 'code'), arCol = m('name_ar_col', 'name_ar'), enCol = m('name_en_col', 'name_en'), sciCol = m('scientific_name_col', 'scientific_name'),
            compCol = m('company_col', 'company'), catCol = m('category_col', 'category'), sellCol = m('selling_price_col', 'selling_price'), unitPCol = m('unit_price_col', 'unit_price'),
            wholeCol = m('wholesale_price_col', 'wholesale_price'), taxCol = m('tax_rate_col', 'tax_rate'), unitCol = m('unit_col', 'unit'), divCol = m('unit_divisions_col', 'unit_divisions'),
            grpCol = m('grouping_col', 'grouping');
        const bCols = mapping.barcode_cols || mapping.barcode_columns || [], gCols = mapping.gtin_cols || mapping.gtin_columns || [];
        const mapped = [];
        const add = (f) => { if (!mapped.includes(f)) mapped.push(f); };
        if (codeCol) add('code'); if (arCol) add('name_ar'); if (enCol) add('name_en'); if (sciCol) add('scientific_name'); if (compCol) add('company');
        if (catCol) add('category'); if (sellCol) add('selling_price'); if (unitPCol) { add('unit_price'); add('cost_price'); } if (wholeCol) add('wholesale_price');
        if (taxCol) add('tax_rate'); if (unitCol) add('unit'); if (divCol) add('unit_divisions'); if (bCols.length) add('barcode'); if (gCols.length) add('gtin');

        // المرحلة 1: استخراج الأكواد والباركودات من الملف للبحث عنها في قاعدة البيانات دفعة واحدة
        const pre = df.rows.map(row => {
            const rawCode = codeCol ? cleanCell(get(row, codeCol, '')) : '';
            let code = rawCode ? Q.cleanNumericCode(rawCode) : '';
            if (!code && rawCode) code = rawCode.replace(/[^\p{L}\p{N}_\.-]/gu, '');
            const gl = [], bl = [];
            for (const bc of bCols) if (has(row, bc)) for (const b of Q.splitBarcodes(cleanCell(row[bc]))) {
                const cb = Q.cleanBarcodePreserveZeros(b);
                if (cb && !['false', 'true'].includes(cb.toLowerCase()) && !bl.includes(cb)) {
                    bl.push(cb);
                    const cg = Q.extractCleanGtin(cb);
                    if (cg && !['false', 'true'].includes(cg.toLowerCase()) && !gl.includes(cg)) gl.push(cg);
                }
            }
            for (const gc of gCols) if (has(row, gc)) for (const g of Q.splitBarcodes(cleanCell(row[gc]))) {
                const cg = Q.extractCleanGtin(g) || Q.cleanBarcodePreserveZeros(g);
                if (cg && !['false', 'true'].includes(cg.toLowerCase()) && !gl.includes(cg)) gl.push(cg);
            }
            return { code, gl, bl };
        });
        const codeSet = new Set(), bcSet = new Set();
        for (const p of pre) {
            if (p.code) { codeSet.add(p.code); if (isPyDigit(p.code)) { codeSet.add(p.code.padStart(10, '0')); codeSet.add(p.code.replace(/^0+/, '')); } }
            for (const x of [...p.gl, ...p.bl]) bcSet.add(x);
        }
        const L = await lookup([...codeSet], [...bcSet]);
        const dbProducts = Object.fromEntries(Object.entries(L.products).map(([c, p]) => [c, p.name]));
        const dbBarcodes = L.barcodes;

        const grouped = {}, items = [], skipped = [], conflicts = [], owner = {};
        df.rows.forEach((row, idx) => {
            const excelRow = idx + df.header_row_idx + 2;
            let { code, gl, bl } = pre[idx];
            const nameAr = cleanCell(get(row, arCol, '')), nameEn = cleanCell(get(row, enCol, ''));
            let name = nameAr || nameEn;
            const sci = sciCol ? cleanCell(get(row, sciCol, '')) : '', comp = compCol ? cleanCell(get(row, compCol, '')) : '';
            const sell = toFloat(get(row, sellCol, 0)), unitPrice = toFloat(get(row, unitPCol, 0)), whole = toFloat(get(row, wholeCol, 0));
            let hasTax = false, tax = 0;
            if (taxCol && has(row, taxCol)) [hasTax, tax] = parseTaxRateCell(row[taxCol]);
            const cat = cleanCell(get(row, catCol, '')), unit = cleanCell(get(row, unitCol, 'علبة')) || 'علبة', divs = cleanCell(get(row, divCol, ''));
            if (!code) { for (const cv of [...gl, ...bl]) if (cv in dbBarcodes) { code = dbBarcodes[cv]; break; } }
            else if (isPyDigit(code) && !(code in dbProducts)) {
                const pad = code.padStart(10, '0');
                if (pad in dbProducts) code = pad; else { const st = code.replace(/^0+/, ''); if (st in dbProducts) code = st; }
            }
            let groupKey = null;
            if (grpCol && has(row, grpCol)) { const rg = cleanCell(row[grpCol]); if (rg) groupKey = rg; }
            else if (code) groupKey = code;
            if (groupKey && groupKey in grouped) {
                const t = grouped[groupKey];
                for (const b of bl) if (!t.barcode_list.includes(b)) t.barcode_list.push(b);
                for (const g of gl) if (!t.gtin_list.includes(g)) t.gtin_list.push(g);
                if (!t.name_ar && nameAr) t.name_ar = nameAr;
                if (!t.name_en && nameEn) t.name_en = nameEn;
                if (!t.scientific_name && sci) t.scientific_name = sci;
                if (!t.company && comp) t.company = comp;
                if (t.selling_price === 0 && sell > 0) t.selling_price = sell;
                if (t.wholesale_price === 0 && whole > 0) t.wholesale_price = whole;
                if (t.unit_price === 0 && unitPrice > 0) t.unit_price = unitPrice;
                if ((t.tax_rate ?? 0) === 0 && tax > 0) { t.tax_rate = tax; if (!(t.mapped_fields || []).includes('tax_rate')) (t.mapped_fields ||= []).push('tax_rate'); }
                t.source_rows.push(excelRow);
                return;
            }
            if (!name) {
                if (code && code in dbProducts) name = dbProducts[code];
                else { skipped.push({ row_number: excelRow, reason: 'اسم الصنف فارغ (لم يتم العثور على اسم عربي أو إنجليزي في هذا الصف).' }); return; }
            }
            const rowMapped = mapped.slice();
            if (taxCol && !hasTax && rowMapped.includes('tax_rate')) rowMapped.splice(rowMapped.indexOf('tax_rate'), 1);
            const isUpd = Boolean(code && code in dbProducts);
            const obj = {
                code, group_key: groupKey || `row_${excelRow}`, name_ar: nameAr, name_en: nameEn, scientific_name: sci, company: comp, name, category: cat,
                selling_price: sell, wholesale_price: whole, unit_price: unitPrice, tax_rate: tax, unit, unit_divisions: divs, barcode_list: bl, gtin_list: gl,
                mapped_fields: rowMapped, source_rows: [excelRow], is_update: isUpd, status_label: isUpd ? 'تحديث صنف موجود' : 'إضافة صنف جديد'
            };
            if (groupKey) grouped[groupKey] = obj;
            items.push(obj);
        });
        for (const it of items) {
            for (const cv of [...it.barcode_list, ...it.gtin_list]) {
                if (cv in owner) {
                    if (owner[cv] !== it.name) conflicts.push({ barcode: cv, conflict_type: 'تعارض داخل الملف نفسه', item_name: it.name,
                        details: `الباركود/GTIN مسند لصنفين مختلفين داخل الملف: (${owner[cv]}) و (${it.name})` });
                } else owner[cv] = it.name;
                if (cv in dbBarcodes) {
                    const ep = dbBarcodes[cv];
                    if (!it.code || it.code !== ep) {
                        const en = (ep in dbProducts) ? dbProducts[ep] : ep;
                        conflicts.push({ barcode: cv, conflict_type: 'مسجل مسبقاً في قاعدة البيانات', item_name: it.name, existing_code: ep, existing_name: en,
                            details: `الباركود/GTIN مسجل مسبقاً للصنف [${ep}] ${en}` });
                    }
                }
            }
        }
        return { items, skipped, conflicts, total: df.rows.length, lookup: L };
    }

    const f = (v) => Number(v || 0);
    function pyFmt0(x) { return pyRound(Math.abs(x), 0).toFixed(0) * (x < 0 ? -1 : 1); }
    async function preview(df, mapping, replace, maxPreview = 50, onlyNew = false) {
        const { items, skipped, conflicts, total, lookup: L } = await parseAndValidate(df, mapping);
        const dbProds = L.products;
        const next = await (await fetch('/api/catalog/next-code')).json();
        const start = parseInt(next.code, 10);
        const previewItems = items.slice(0, maxPreview).map((it, idx) => {
            const pc = Object.assign({}, it);
            pc.system_code_preview = it.code || String(start + idx);
            const isUpd = Boolean(it.code && it.code in dbProds);
            pc.is_update = isUpd;
            pc.status_label = isUpd ? 'تحديث صنف موجود' : 'إضافة صنف جديد';
            const diff = {};
            if (isUpd) {
                const ex = dbProds[it.code], mp = new Set(it.mapped_fields || []);
                if (mp.has('selling_price') && Math.abs(f(ex.selling_price) - f(it.selling_price)) > 0.001) diff.selling_price = { label: 'سعر البيع', old: f(ex.selling_price), new: f(it.selling_price) };
                if (mp.has('wholesale_price') && Math.abs(f(ex.wholesale_price) - f(it.wholesale_price)) > 0.001) diff.wholesale_price = { label: 'سعر الجملة', old: f(ex.wholesale_price), new: f(it.wholesale_price) };
                if (mp.has('cost_price') && Math.abs(f(ex.cost_price || ex.unit_price) - f(it.unit_price)) > 0.001) diff.cost_price = { label: 'سعر التكلفة', old: f(ex.cost_price), new: f(it.unit_price) };
                if (mp.has('tax_rate') && Math.abs(f(ex.tax_rate) - f(it.tax_rate)) > 0.001) {
                    const o = f(ex.tax_rate), n = f(it.tax_rate);
                    diff.tax_rate = { label: 'الضريبة', old: o > 0 ? `${pyFmt0(o)}% (VAT)` : 'غير خاضع (0%)', new: n > 0 ? `${pyFmt0(n)}% (VAT)` : 'غير خاضع (0%)' };
                }
                for (const [k, label] of [['name_ar', 'الاسم بالعربي'], ['name_en', 'الاسم بالإنجليزي'], ['scientific_name', 'الاسم العلمي'], ['company', 'الشركة']])
                    if (mp.has(k) && it[k] && it[k] !== (ex[k] || '')) diff[k] = { label, old: ex[k] || '', new: it[k] };
                const eb = ex.barcode_list || [], nb = it.barcode_list || [], ab = nb.filter(b => !eb.includes(b));
                if (replace) { const rb = eb.filter(b => !nb.includes(b)); if (ab.length || rb.length) diff.barcodes = { label: 'الباركودات (وضع الاستبدال)', added: ab, removed: rb }; }
                else if (ab.length) diff.barcodes = { label: 'الباركودات (إضافة)', added: ab };
                const eg = ex.gtin_list || [], ng = it.gtin_list || [], ag = ng.filter(g => !eg.includes(g));
                if (replace) { const rg = eg.filter(g => !ng.includes(g)); if (ag.length || rg.length) diff.gtins = { label: 'GTIN (وضع الاستبدال)', added: ag, removed: rg }; }
                else if (ag.length) diff.gtins = { label: 'GTIN (إضافة)', added: ag };
            }
            pc.diff = diff; pc.changed_fields_count = Object.keys(diff).length;
            return pc;
        });
        const upd = items.filter(it => it.code && it.code in dbProds).length;
        if (onlyNew) {
            // وضع "إضافة الجديد فقط": الأصناف الموجودة لا تتغير، فتظهر في المعاينة كأصناف ستُتخطى
            for (const pc of previewItems) if (pc.is_update) { pc.status_label = 'موجود بالفعل (لن يتغير)'; pc.diff = {}; pc.changed_fields_count = 0; }
        }
        return {
            success: true, only_new: onlyNew, existing_count: upd, total_file_rows: total, valid_products_count: items.length, valid_count: items.length,
            updates_count: onlyNew ? 0 : upd, new_count: items.length - upd,
            conflicts_count: conflicts.length, skipped_count: skipped.length, replace_barcodes: replace, preview_items: previewItems,
            conflicts: conflicts.slice(0, 100), skipped_rows: skipped.slice(0, 100)
        };
    }
    async function commit(df, mapping, replace, fileName, onProgress, onlyNew = false) {
        const { items, skipped, total } = await parseAndValidate(df, mapping);
        if (!items.length) return { success: false, message: 'لا توجد أصناف صالحة للاستيراد في الملف.', skipped_rows: skipped };
        let upd = 0, added = 0, bc = 0, skippedExisting = 0;
        const CH = 150;
        for (let i = 0; i < items.length; i += CH) {
            const part = items.slice(i, i + CH).map(it => ({ code: it.code, name_ar: it.name_ar, name_en: it.name_en, name: it.name, scientific_name: it.scientific_name,
                company: it.company, category: it.category, selling_price: it.selling_price, wholesale_price: it.wholesale_price, unit_price: it.unit_price,
                tax_rate: it.tax_rate, unit: it.unit, unit_divisions: it.unit_divisions, barcode_list: it.barcode_list, gtin_list: it.gtin_list, mapped_fields: it.mapped_fields }));
            const r = await api('/api/catalog/import/commit', { items: part, replace_barcodes: replace, only_new: onlyNew });
            upd += r.updated_count; added += r.new_count; bc += r.barcodes_registered_count; skippedExisting += r.skipped_existing_count || 0;
            if (onProgress) onProgress(Math.min(items.length, i + CH), items.length);
        }
        await api('/api/catalog/import/finish', { file_name: fileName, updated_count: upd, new_count: added, replace_barcodes: replace });
        return {
            success: true, skipped_existing_count: skippedExisting, only_new: onlyNew,
            message: onlyNew ? `تمت إضافة ${added} صنف جديد. الأصناف الموجودة بالفعل (${skippedExisting}) لم تتغير.`
                : `تمت معالجة ${items.length} صنف بنجاح (تحديث ${upd} صنف موجود، وإضافة ${added} صنف جديد).`,
            imported_count: items.length, updated_count: upd, new_count: added, total_file_rows: total, barcodes_registered_count: bc,
            replace_barcodes: replace, skipped_count: skipped.length, skipped_rows: skipped.slice(0, 100)
        };
    }

    async function inspect(XLSX, file) {
        const name = file.name || 'catalog.xlsx';
        const isCsv = /\.csv$/i.test(name);
        const wb = isCsv ? XLSX.read(await file.text(), { type: 'string', cellNF: true, raw: true }) : XLSX.read(await file.arrayBuffer(), { type: 'array', cellNF: true });
        const df = readDataframe(XLSX, wb);
        const sample = df.rows.slice(0, 5).map(r => { const o = {}; for (const h of df.columns) { const v = String(r[h] ?? ''); o[h] = v.toLowerCase() !== 'nan' ? v : ''; } return o; });
        return { df, info: { success: true, filename: name, file_path: name, sheet_name: df.sheet_names[0] || 'Sheet 1', sheet_names: df.sheet_names, headers: df.columns,
            sample_rows: sample, total_rows: df.rows.length, header_row_index: df.header_row_idx, suggested_mapping: suggestColumnsMapping(df.columns) } };
    }

    // ملف كتالوج (مثل product.template.xlsx) اترفع من زر "رفع مخزون": نضيف الأصناف الجديدة فقط بالأعمدة المقترحة تلقائياً
    async function importNewOnlyFromFile(XLSX, file, onProgress) {
        if (!Q) { const q = await import('/cloud-qr.js'); Q = q; pyRound = q.pyRound; }
        const { df, info } = await inspect(XLSX, file);
        return commit(df, info.suggested_mapping || {}, false, file.name || 'catalog.xlsx', onProgress, true);
    }
    root.RambfeCatalogImport = { readDataframe, suggestColumnsMapping, parseTaxRateCell, parseAndValidate, preview, commit, inspect, importNewOnlyFromFile,
        _setDeps(q, pr) { Q = q; if (pr) pyRound = pr; } };
    if (typeof window === 'undefined') return;

    // ---------------- في المتصفح: اعتراض مسارات الاستيراد في الشاشة الحالية ----------------
    const files = {};
    let xlsxP = null;
    const loadXlsx = () => window.XLSX ? Promise.resolve(window.XLSX) : (xlsxP ||= new Promise((res, rej) => {
        const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = () => res(window.XLSX); s.onerror = () => rej(new Error('تعذر تحميل قارئ ملفات الإكسيل')); document.head.appendChild(s);
    }));
    const depsP = import('/cloud-qr.js').then(q => { Q = q; pyRound = q.pyRound; });
    const jsonRes = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'Content-Type': 'application/json' } });
    const origFetch = window.fetch;
    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const path = url.split('?')[0].replace(/^https?:\/\/[^/]+/, '');
        try {
            if (path === '/api/catalog/upload-excel' || path === '/api/catalog/upload') {
                const fd = init && init.body;
                const file = fd && typeof fd.get === 'function' ? (fd.get('file') || fd.get('excel')) : null;
                if (!file) return jsonRes({ success: false, message: 'لم يتم إرسال ملف Excel. يرجى اختيار ملف صالح.' }, 400);
                const [XLSX] = await Promise.all([loadXlsx(), depsP]);
                const { df, info } = await inspect(XLSX, file);
                const id = `catalog_${Math.random().toString(16).slice(2, 10)}_${file.name}`;
                files[id] = { df, name: file.name };
                info.file_id = id;
                return jsonRes(info);
            }
            // استيراد ملف فاتورة (Excel/CSV/TXT) وتفريغه في الفاتورة النشطة — يعمل من الرابط
            if (['/api/invoice/upload-file', '/api/invoice/upload', '/api/invoice/upload-excel', '/api/invoice/import-file'].includes(path)) {
                const fd = init && init.body;
                const file = fd && typeof fd.get === 'function' ? (fd.get('file') || fd.get('invoice')) : null;
                if (!file) return jsonRes({ success: false, message: 'لم يتم إرسال ملف الفاتورة.' }, 400);
                const invId = String(fd.get('invoice_id') || '');
                const user = String(fd.get('user_name') || 'المسؤول');
                let columns, rows;
                if (/\.txt$/i.test(file.name || '')) {
                    const lines = (await file.text()).split(/\r\n|\n|\r/).map(l => l.trim()).filter(Boolean);
                    if (!lines.length) return jsonRes({ success: false, message: 'الملف النصي فارغ.' });
                    columns = ['qr_code']; rows = lines.map(l => ({ qr_code: l }));
                } else {
                    const [XLSX] = await Promise.all([loadXlsx(), depsP]);
                    const isCsv = /\.csv$/i.test(file.name || '');
                    const wb = isCsv ? XLSX.read(await file.text(), { type: 'string', cellNF: true, raw: true }) : XLSX.read(await file.arrayBuffer(), { type: 'array', cellNF: true });
                    const df = readDataframe(XLSX, wb);
                    columns = df.columns; rows = df.rows;
                }
                if (!rows.length) return jsonRes({ success: false, message: 'ملف الفاتورة فارغ.' });
                let target = /^\d+$/.test(invId) ? invId : '', imported = 0, skipped = 0;
                for (let i = 0; i < rows.length; i += 80) {
                    const r = await api('/api/invoice/import/rows', { invoice_id: target, columns, rows: rows.slice(i, i + 80), idx_offset: i, user_name: user });
                    target = String(r.invoice_id); imported += r.imported_count; skipped += r.skipped_count;
                }
                return jsonRes(await api('/api/invoice/import/finish', { invoice_id: target, imported_count: imported, skipped_count: skipped }));
            }
            if (path === '/api/catalog/preview-import' || path === '/api/catalog/commit-import') {
                await depsP;
                const d = JSON.parse(init.body || '{}');
                const fobj = files[d.file_id];
                if (!fobj) return jsonRes({ success: false, message: 'انتهت صلاحية الملف المرفوع، يرجى رفعه مرة أخرى.' }, 400);
                const replace = Boolean(d.replace_barcodes);
                // الافتراضي: إضافة الأصناف الجديدة فقط بدون تغيير الموجود (إلا لو اخترت تحديث الموجود)
                const onlyNew = !d.update_existing;
                if (path === '/api/catalog/preview-import') return jsonRes(await preview(fobj.df, d.mapping || {}, replace, 50, onlyNew));
                const res = await commit(fobj.df, d.mapping || {}, replace, fobj.name, (done, all) => {
                    const b = document.getElementById('btn-commit-import'); if (b) b.textContent = `جاري الحفظ… ${done} / ${all} صنف`;
                }, onlyNew);
                return jsonRes(res);
            }
        } catch (e) {
            return jsonRes({ success: false, message: e.message }, 400);
        }
        return origFetch.apply(this, arguments);
    };
})(typeof window !== 'undefined' ? window : globalThis);
