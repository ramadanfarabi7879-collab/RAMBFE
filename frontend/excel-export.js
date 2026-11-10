// بناء ملفات الإكسيل في المتصفح (بدون الكمبيوتر) بنفس تنسيق backend/excel_exporter.py و stock_manager.py حرفياً.
// السحابة تجهّز القيم (/api/export/data) والمتصفح يبني الملف بمكتبة ExcelJS ويحفظه.
(function (root) {
    const BORDER_C = 'CBD5E1';
    const argb = (hex) => 'FF' + hex;
    const thin = { style: 'thin', color: { argb: argb(BORDER_C) } };
    const BORDER = { left: thin, right: thin, top: thin, bottom: thin };
    const fill = (hex) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: argb(hex) }, bgColor: { argb: argb(hex) } });
    const font = (size, bold, color) => Object.assign({ name: 'Calibri', size, bold: Boolean(bold) }, color ? { color: { argb: argb(color) } } : {});
    const HEADER_FONT = font(11, true, 'FFFFFF');
    const HEADER_ALIGN = { horizontal: 'center', vertical: 'middle', wrapText: true };
    const A = (h) => ({ horizontal: h, vertical: 'middle' });

    // str(value or '') بنفس تمثيل بايثون للأرقام العشرية (12.0) — لحساب عرض الأعمدة
    function pyStr(v, isFloat) {
        if (v === null || v === undefined || v === '' || v === 0 || v === false) return '';
        if (typeof v === 'number') {
            if (isFloat && Number.isInteger(v)) return v.toFixed(1);
            return String(v);
        }
        return String(v);
    }
function pyRound(x, n = 0) {
    x = Number(x);
    if (!Number.isFinite(x)) return x;
    const neg = x < 0, a = Math.abs(x);
    const s = a.toFixed(Math.min(100, n + 25));
    const dot = s.indexOf('.');
    const tail = s.slice(dot + 1 + n);
    let r;
    if (/^50*$/.test(tail)) {
        const base = Number(s.slice(0, dot + 1 + n).replace(/\.$/, ''));
        const unit = 10 ** -n;
        const lastDigit = Number(s.slice(0, dot + 1 + n).replace('.', '').slice(-1));
        r = lastDigit % 2 === 0 ? base : Number((base + unit).toFixed(n));
    } else {
        r = Number(a.toFixed(n));
    }
    return neg ? -r : r;
}
    const plen = (s) => [...s].length;
    const cleanTitle = (t) => String(t).replace(/[\\/*?:\[\]]/g, '_');
    function sanitizeTitle(title, def) {
        if (!title || !String(title).trim()) return def;
        return cleanTitle(String(title).trim()).slice(0, 31) || def;
    }
    // تنسيق بايثون f"{x:,.2f}" و f"{x:+,.2f}"
    function pyFmt(x, dec, sign) {
        const n = Number(x || 0);
        const neg = n < 0;
        let s = pyRound(Math.abs(n), dec).toFixed(dec);  // نفس تقريب بايثون في التنسيق
        const [ip, fp] = s.split('.');
        const g = ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        s = fp !== undefined ? `${g}.${fp}` : g;
        return (neg ? '-' : (sign ? '+' : '')) + s;
    }

    // ورقة جدول بسيط (الفاتورة/الجرد/غير المجرود/المخصص): نفس منطق بايثون
    function simpleSheet(wb, opt) {
        const ws = wb.addWorksheet(opt.title, { views: [{ state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2', rightToLeft: false }] });
        const headers = opt.headers;
        const hr = ws.getRow(1);
        headers.forEach((h, i) => {
            const c = hr.getCell(i + 1);
            c.value = h; c.fill = fill(opt.headerFill); c.font = HEADER_FONT; c.alignment = HEADER_ALIGN; c.border = BORDER;
        });
        hr.height = 28;
        const widths = headers.map(h => plen(pyStr(h)));
        opt.rows.forEach((r, i) => {
            const rowIdx = i + 2;
            const row = ws.getRow(rowIdx);
            row.height = opt.rowHeight || 22;
            const zebra = rowIdx % 2 === 0;
            r.values.forEach((v, ci) => {
                const c = row.getCell(ci + 1);
                c.value = (v === undefined || v === '') ? null : v;  // openpyxl يكتب النص الفارغ كخلية فارغة
                const st = opt.style(ci, r);
                c.font = st.bold ? font(10, true) : font(10, false);
                c.border = BORDER;
                if (zebra) c.fill = fill(opt.zebra || 'F8FAFC');
                if (st.numFmt) c.numFmt = st.numFmt;
                c.alignment = A(st.align || 'left');
                const L = plen(pyStr(v, st.isFloat));
                if (L > widths[ci]) widths[ci] = L;
            });
        });
        if (opt.fixedWidths) opt.fixedWidths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
        else widths.forEach((w, i) => { ws.getColumn(i + 1).width = Math.max(w + 4, opt.minWidth); });
        return ws;
    }

    const INV7 = ['PRODUCT', 'NAME', 'SALES PRICE', 'BATCH NUMBER', 'QUANTITE', 'UNITPRICE', 'expiry-date'];
    const STOCK6 = ['Product', 'NAME ENGLISH', 'Location', 'Lot/Serial Number', 'Expiry Date', 'Counted quantity'];

    function buildInvoice(wb, d) {
        simpleSheet(wb, {
            title: sanitizeTitle(d.sheet_title, 'INVOICE'), headers: INV7, headerFill: '1E3A8A', minWidth: 14,
            rows: d.rows.map(r => ({ values: [r.product_code, r.name_en, r.sales_price, r.batch_number, r.quantity, r.unit_price, r.expiry_date] })),
            style: (ci) => {
                const n = INV7[ci];
                if (n === 'SALES PRICE' || n === 'UNITPRICE') return { numFmt: '#,##0.00', align: 'right', isFloat: true };
                if (n === 'QUANTITE') return { numFmt: '#,##0', align: 'center', bold: true };
                if (n === 'PRODUCT' || n === 'BATCH NUMBER' || n === 'expiry-date') return { align: 'center' };
                return { align: 'left' };
            }
        });
    }
    function buildInvoiceStock(wb, d) {
        const loc = d.location_val ? String(d.location_val).trim() : '';
        simpleSheet(wb, {
            title: sanitizeTitle(d.sheet_title, 'STOCK_COUNT'), headers: STOCK6, headerFill: '0F766E', minWidth: 16,
            rows: d.rows.map(r => ({ values: [r.product_code, r.name_en, loc, r.batch_number, r.expiry_date, r.quantity] })),
            style: (ci) => {
                const n = STOCK6[ci];
                if (n === 'Counted quantity') return { numFmt: '#,##0', align: 'center', bold: true };
                if (['Product', 'Location', 'Lot/Serial Number', 'Expiry Date'].includes(n)) return { align: 'center' };
                return { align: 'left' };
            }
        });
    }
    function buildInvoiceCustom(wb, d) {
        const specs = d.columns || [];
        if (!specs.length) return buildInvoice(wb, d);
        const loc = d.location_val ? String(d.location_val).trim() : null;
        simpleSheet(wb, {
            title: sanitizeTitle(d.sheet_title, 'INVOICE_EXPORT'), headers: specs.map(s => s.header || s.field || 'COLUMN'), headerFill: '1E3A8A', minWidth: 15,
            rows: d.rows.map(r => {
                const fv = { product_code: r.product_code, name_en: r.name_en, location: loc !== null ? loc : r.location, sales_price: r.sales_price,
                    batch_number: r.batch_number, quantity: r.quantity, unit_price: r.unit_price, expiry_date: r.expiry_date };
                return { values: specs.map(s => (s.field in fv ? fv[s.field] : '')) };
            }),
            style: (ci) => {
                const f = specs[ci].field || '';
                if (f === 'sales_price' || f === 'unit_price') return { numFmt: '#,##0.00', align: 'right', isFloat: true };
                if (f === 'quantity') return { numFmt: '#,##0', align: 'center', bold: true };
                if (['product_code', 'location', 'batch_number', 'expiry_date'].includes(f)) return { align: 'center' };
                return { align: 'left' };
            }
        });
    }
    const str0 = (v) => (v === null || v === undefined || v === '' || v === 0 || v === false) ? '' : String(v);
    function buildStocktake(wb, d) {
        const det = d.details || {}, items = det.items || [], stats = det.stats || {}, st = det.store || {}, storeNo = d.store_no;
        const t1 = cleanTitle(String(d.sheet_title || st.store_name || storeNo).trim()).slice(0, 31) || 'STOCK_COUNT';
        const loc = String(d.location_val || '').trim();
        const rows = items.map(e => {
            const raw = Number(e.counted_qty || 0);
            const q = Number.isFinite(raw) ? raw : 0;
            return { isInt: Number.isInteger(q), values: [str0(e.product_code).trim(), str0(e.product_name).trim(), loc, str0(e.batch_number).trim().toUpperCase(), str0(e.expiry_date).trim(), q] };
        });
        simpleSheet(wb, {
            title: t1, headers: STOCK6, headerFill: '0F766E', minWidth: 16, rows,
            style: (ci, r) => {
                const n = STOCK6[ci];
                if (n === 'Counted quantity') return { numFmt: r.isInt ? '#,##0' : '#,##0.00', align: 'center', bold: true, isFloat: !r.isInt };
                if (['Product', 'Location', 'Lot/Serial Number', 'Expiry Date'].includes(n)) return { align: 'center' };
                return { align: 'left' };
            }
        });
        // الورقة الثانية: مراجعة التكلفة وسعر البيع (من اليمين لليسار)
        const ws2 = wb.addWorksheet('AUDIT_VALUATION', { views: [{ rightToLeft: true }] });
        const bold10 = font(10, true), norm10 = font(10, false), kpi = fill('F1F5F9');
        ws2.mergeCells('A1:N1');
        const pyNone = (v) => (v === null || v === undefined) ? 'None' : String(v);
        ws2.getCell('A1').value = `تقرير مطابقة الجرد والتكلفة وسعر البيع – ${pyNone(st.store_name)} (${storeNo})`;
        ws2.getCell('A1').font = font(13, true, '1E293B');
        ws2.getCell('A1').alignment = A('center');
        ws2.getRow(1).height = 28;
        const kpis = [['A3:C3', 'A3', `تكلفة المخزون: ${pyFmt(stats.system_cost, 2)} ر.س | بيع: ${pyFmt(stats.system_sale, 2)} ر.س`],
            ['D3:F3', 'D3', `تكلفة الاستور: ${pyFmt(stats.counted_cost, 2)} ر.س | بيع: ${pyFmt(stats.counted_sale, 2)} ر.س`],
            ['G3:I3', 'G3', `فرق التكلفة: ${pyFmt(stats.diff_cost, 2, true)} ر.س | فرق البيع: ${pyFmt(stats.diff_sale, 2, true)} ر.س`],
            ['J3:L3', 'J3', `إجمالي الكمية الفعلية: ${pyFmt(stats.counted_qty, 0)} عبوة`]];
        for (const [rng, cellRef, text] of kpis) { ws2.mergeCells(rng); const c = ws2.getCell(cellRef); c.value = text; c.font = bold10; c.fill = kpi; }
        const ah = ['م', 'كود الصنف', 'اسم الصنف', 'الباركود / GTIN', 'التشغيلة (Batch)', 'تاريخ الصلاحية (Exp)', 'رصيد المخزون (السيستم)', 'الرصيد الفعلي (المجرود)',
            'الفرق', 'سعر التكلفة', 'سعر البيع', 'إجمالي التكلفة الفعلية', 'إجمالي البيع الفعلي', 'حالة الباتش'];
        ws2.getRow(5).height = 24;
        ah.forEach((h, i) => { const c = ws2.getRow(5).getCell(i + 1); c.value = h; c.font = HEADER_FONT; c.fill = fill('1E3A8A'); c.alignment = A('center'); c.border = BORDER; });
        const pr = pyRound;
        items.forEach((e, i) => {
            const rowNo = 6 + i, row = ws2.getRow(rowNo);
            row.height = 20;
            const cq = Number(e.counted_qty || 0), sq = Number(e.system_qty || 0);
            const vals = [i + 1, e.product_code ?? null, e.product_name ?? null, (e.gtin || e.barcode) ?? null, str0(e.batch_number).trim().toUpperCase(), e.expiry_date ?? null,
                e.system_qty ?? null, e.counted_qty ?? null, pr(cq - sq, 2), e.cost_price ?? null, e.selling_price ?? null,
                pr(cq * Number(e.cost_price || 0), 2), pr(cq * Number(e.selling_price || 0), 2), e.is_new_batch ? '⚠️ باتش جديد' : 'مطابق'];
            vals.forEach((v, ci) => {
                const c = row.getCell(ci + 1);
                c.value = (v === '') ? null : v;
                c.font = [8, 9, 12, 13].includes(ci + 1) ? bold10 : norm10;
                c.border = BORDER;
                c.alignment = A((ci + 1 === 2 || ci + 1 === 3) ? 'right' : 'center');
                if (e.is_new_batch) c.fill = fill('FEF3C7');
            });
        });
        [6, 14, 32, 16, 14, 14, 14, 14, 12, 12, 12, 18, 18, 14].forEach((w, i) => { ws2.getColumn(i + 1).width = w; });
    }
    function buildUncounted(wb, d) {
        const data = d.data || {}, st = data.store || {}, storeNo = d.store_no;
        const title = cleanTitle(String(d.sheet_title || `NOT_FOUND_${storeNo}`).trim()).slice(0, 31) || 'ESTIMATED_NOT_FOUND';
        const cols = ['Product', 'NAME ENGLISH', 'Location', 'Lot/Serial Number', 'Expiry Date', 'Uncounted quantity', 'Cost Price', 'Sales Price', 'Total Cost', 'Total Sale'];
        const loc = String(st.store_name || storeNo);
        simpleSheet(wb, {
            title, headers: cols, headerFill: '991B1B', zebra: 'FFF1F2', minWidth: 15,
            rows: (data.items || []).map(e => ({ values: [str0(e.product_code).trim(), str0(e.product_name).trim(), loc, str0(e.batch_number).trim().toUpperCase(),
                str0(e.expiry_date).trim(), e.system_qty || 0, Number(e.cost_price || 0), Number(e.selling_price || 0), Number(e.total_cost || 0), Number(e.total_sale || 0)] })),
            style: (ci) => {
                const n = cols[ci];
                if (['Uncounted quantity', 'Total Cost', 'Total Sale'].includes(n)) return { align: 'center', bold: true, numFmt: '#,##0.00', isFloat: true };
                if (n === 'Cost Price' || n === 'Sales Price') return { align: 'center', numFmt: '#,##0.00', isFloat: true };
                if (['Product', 'Location', 'Lot/Serial Number', 'Expiry Date'].includes(n)) return { align: 'center' };
                return { align: 'left' };
            }
        });
    }
    const CAT = {
        code: ['PRODUCT CODE', 16, 'center', '@', true], name_en: ['NAME ENGLIS', 36, 'left', null, false], name_ar: ['NAME ARABIC', 32, 'left', null, false],
        scientific_name: ['SCIENTIFIC NAME', 28, 'left', null, false], category: ['CATEGORY', 16, 'left', null, false], company: ['COMPANY', 24, 'left', null, false],
        cost_price: ['COST PRICE', 14, 'right', '#,##0.00', false], selling_price: ['SALES PRICE', 14, 'right', '#,##0.00', false],
        wholesale_price: ['WHOLESALE PRICE', 16, 'right', '#,##0.00', false], tax_rate: ['TAX RATE', 12, 'right', '0.00', false], unit: ['UNIT', 12, 'left', null, false],
        unit_divisions: ['UNIT DIVISIONS', 20, 'left', null, false], barcode: ['PRIMARY BARCODE', 22, 'left', '@', false], extra_barcodes: ['EXTRA BARCODES', 26, 'left', '@', false],
        all_barcodes: ['ALL BARCODES', 30, 'left', '@', false], gtin: ['PRIMARY GTIN', 22, 'left', '@', false], extra_gtins: ['EXTRA GTINS', 26, 'left', '@', false],
        all_gtins: ['ALL GTINS', 30, 'left', '@', false]
    };
    const CAT_DEFAULT = ['code', 'name_en', 'name_ar', 'selling_price', 'cost_price', 'tax_rate', 'category', 'unit', 'barcode', 'gtin'];
    function buildCatalog(wb, d) {
        let fields = [];
        for (const f of d.fields || []) { const k = String(f).trim().toLowerCase(); if (k in CAT && !fields.includes(k)) fields.push(k); }
        if (!fields.length) fields = CAT_DEFAULT.slice();
        const ws = wb.addWorksheet('PRODUCTS_CATALOG', { views: [{ state: 'frozen', xSplit: 0, ySplit: 1, topLeftCell: 'A2', rightToLeft: false }] });
        const hr = ws.getRow(1);
        fields.forEach((f, i) => { const c = hr.getCell(i + 1); c.value = CAT[f][0]; c.fill = fill('1E3A8A'); c.font = HEADER_FONT; c.alignment = HEADER_ALIGN; c.border = BORDER; });
        hr.height = 28;
        const s = (v) => (v === null || v === undefined || v === '' || v === 0) ? '' : String(v);
        d.rows.forEach((r, i) => {
            const rowIdx = i + 2, row = ws.getRow(rowIdx);
            row.height = 20;
            const bl = r.barcode_list || [], gl = r.gtin_list || [];
            const m = {
                code: s(r.code), name_en: s(r.name_en || r.name), name_ar: s(r.name_ar), scientific_name: s(r.scientific_name), category: s(r.category || 'دواء'),
                company: s(r.company), cost_price: Number(r.cost_price || r.unit_price || 0), selling_price: Number(r.selling_price || 0),
                wholesale_price: Number(r.wholesale_price || 0), tax_rate: Number(r.tax_rate || 0), unit: s(r.unit || 'علبة'), unit_divisions: s(r.unit_divisions),
                barcode: bl.length ? bl[0] : (r.barcode || ''), extra_barcodes: bl.length > 1 ? bl.slice(1).join(', ') : '', all_barcodes: bl.length ? bl.join(', ') : (r.barcode || ''),
                gtin: gl.length ? gl[0] : (r.gtin || ''), extra_gtins: gl.length > 1 ? gl.slice(1).join(', ') : '', all_gtins: gl.length ? gl.join(', ') : (r.gtin || '')
            };
            fields.forEach((f, ci) => {
                const c = row.getCell(ci + 1), meta = CAT[f];
                c.value = (m[f] === undefined || m[f] === '') ? null : m[f];
                c.border = BORDER;
                if (rowIdx % 2 === 0) c.fill = fill('F8FAFC');
                c.font = meta[4] ? font(10, true) : font(10, false);
                if (meta[3]) c.numFmt = meta[3];
                c.alignment = A(meta[2]);
            });
        });
        fields.forEach((f, i) => { ws.getColumn(i + 1).width = CAT[f][1]; });
    }

    function build(ExcelJS, d) {
        const wb = new ExcelJS.Workbook();
        ({ invoice: buildInvoice, invoice_stock: buildInvoiceStock, invoice_custom: buildInvoiceCustom, stocktake: buildStocktake,
            uncounted: buildUncounted, catalog: buildCatalog })[d.kind](wb, d);
        return wb;
    }

    root.RambfeExcel = Object.assign(root.RambfeExcel || {}, { build, pyRound });
    if (typeof window === 'undefined') return;

    // ---------------- في المتصفح: اعتراض أزرار التصدير ----------------
    let loading = null;
    function loadExcelJS() {
        if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
        if (!loading) loading = new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js';
            s.onload = () => res(window.ExcelJS); s.onerror = () => rej(new Error('تعذر تحميل مكتبة الإكسيل'));
            document.head.appendChild(s);
        });
        return loading;
    }
    async function exportData(kind, params) {
        const res = await fetch('/api/export/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, params }) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok || d.success === false) throw new Error(d.detail || d.message || 'فشل تجهيز بيانات الملف');
        return d;
    }
    function classify(url, postData) {
        const u = new URL(url, location.origin);
        const p = Object.fromEntries(u.searchParams.entries());
        const path = u.pathname;
        if (['/api/invoice/export-excel', '/api/invoice/export', '/api/invoice/export-stock-excel', '/api/invoice/export-stock'].includes(path)) {
            const fmt = (p.format || p.type || '').trim().toLowerCase();
            const stock = path.includes('stock') || ['stock', 'stock_count', 'counted', '2'].includes(fmt);
            return { kind: stock ? 'invoice_stock' : 'invoice', params: p };
        }
        if (path === '/api/invoice/export-custom-excel') return { kind: 'invoice_custom', params: Object.assign({}, postData || {}) };
        if (path === '/api/stock/export-excel' || path === '/api/stock/export') return { kind: 'stocktake', params: p };
        if (path === '/api/stock/uncounted/export-excel' || path === '/api/stock/uncounted-export') return { kind: 'uncounted', params: p };
        if (path === '/api/catalog/export-excel' || path === '/api/catalog/export') return { kind: 'catalog', params: Object.assign({}, p, postData || {}) };
        return null;
    }
    async function saveWorkbook(wb, fileName) {
        const buf = await wb.xlsx.writeBuffer();
        const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = fileName;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
    const toast = (m) => { try { if (typeof window.showCatalogToast === 'function') window.showCatalogToast(m); } catch (_) { } };
    async function exportFromUrl(url, fallbackName, postData) {
        const c = classify(url, postData);
        if (!c) return null;
        const [ExcelJS, first] = await Promise.all([loadExcelJS(), exportData(c.kind, Object.assign({}, c.params, c.kind === 'catalog' ? { offset: 0 } : {}))]);
        let d = first;
        if (c.kind === 'catalog' && first.total > first.rows.length) {
            const rows = first.rows.slice();
            for (let off = first.rows.length; off < first.total; off += first.limit) {
                toast(`⏳ جاري تجهيز دليل الأصناف… ${rows.length} / ${first.total}`);
                const part = await exportData('catalog', Object.assign({}, c.params, { offset: off }));
                rows.push(...part.rows);
                if (!part.rows.length) break;
            }
            d = Object.assign({}, first, { rows });
        }
        await saveWorkbook(build(ExcelJS, d), d.file_name || fallbackName || 'Export.xlsx');
        toast('✅ تم حفظ ملف الإكسيل في التنزيلات');
        return true;
    }
    window.RambfeExcel.exportFromUrl = exportFromUrl;

    // استبدال دالة التحميل الأصلية في الشاشة بعد تحميلها
    function hook() {
        const orig = window.downloadAndTriggerSave;
        if (typeof orig !== 'function' || orig.__rambfeHooked) return false;
        const wrapped = async function (url, fallbackFilename, postData) {
            try {
                const r = await exportFromUrl(url, fallbackFilename, postData);
                if (r) return true;
            } catch (e) {
                alert('تعذر إنشاء ملف الإكسيل: ' + e.message);
                return false;
            }
            return orig.apply(this, arguments);
        };
        wrapped.__rambfeHooked = true;
        window.downloadAndTriggerSave = wrapped;
        return true;
    }
    if (!hook()) { const t = setInterval(() => { if (hook()) clearInterval(t); }, 300); setTimeout(() => clearInterval(t), 20000); }
})(typeof window !== 'undefined' ? window : globalThis);
