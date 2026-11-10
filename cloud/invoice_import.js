// استيراد ملف فاتورة (Excel/CSV/TXT) وتفريغه في الفاتورة النشطة (منقول من backend/invoice_file_importer.py).
import { first, run } from './products.js';
import { getProductByCode, findProductByGtinOrBarcode } from './products.js';
import { parseQrCode, cleanBarcodePreserveZeros, cleanNumericCode } from './qr.js';
import { getOrCreateDraftInvoice, getInvoiceDetails, saveOrUpdateProduct } from './extra.js';

const pid = (db) => Number(db.pid || 1);
function normalizeDateStr(ds) {
    if (!ds) return '';
    const s = String(ds).trim().split(' ')[0];
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    let m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (m) return `${m[3]}-${String(+m[2]).padStart(2, '0')}-${String(+m[1]).padStart(2, '0')}`;
    if (/^\d{6}$/.test(s)) {
        const y = 2000 + +s.slice(0, 2), mon = +s.slice(2, 4);
        let d = +s.slice(4, 6);
        if (d === 0) d = new Date(Date.UTC(y, mon, 0)).getUTCDate();
        return `${y}-${String(mon).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    return s;
}
const pyFloat = (v) => { const t = String(v ?? '').trim(); if (!t) return NaN; return Number(t); };

export async function resolveTargetInvoice(db, invoiceId) {
    let id = parseInt(invoiceId || '0', 10) || 0;
    if (!id) id = (await getOrCreateDraftInvoice(db)).id;
    const inv = await getInvoiceDetails(db, id);
    if (!inv || !Object.keys(inv).length || inv.status === 'confirmed') return { error: 'لا يمكن إضافة بنود إلى فاتورة معتمدة أو غير موجودة.' };
    return { id, inv };
}

// columns: أسماء الأعمدة بالترتيب، rows: قواميس القيم النصية، idxOffset: رقم أول صف في هذه الدفعة
export async function importInvoiceRows(db, invoiceId, columns, rows, idxOffset, userName = 'المسؤول') {
    const t = await resolveTargetInvoice(db, invoiceId);
    if (t.error) return { success: false, message: t.error };
    const { id, inv } = t;
    const invNo = inv.invoice_number || 'INV';
    const cols = new Map();
    for (const c of columns) cols.set(String(c).toLowerCase().trim(), c);
    const findCol = (kws) => { for (const k of kws) for (const [cl, co] of cols) if (k === cl || cl.includes(k)) return co; return null; };
    const qrCol = findCol(['qr', 'qr_code', 'datamatrix', 'barcode_data', 'كود qr', 'كيو ار', 'gs1', 'qr text']);
    const gtinCol = findCol(['gtin', 'باركود', 'barcode', 'ean', 'جي تي ان']);
    const codeCol = findCol(['product', 'item code', 'كود الصنف', 'رمز الصنف', 'كود', 'code', 'default_code', 'reference', 'sequence']);
    const nameCol = findCol(['name', 'product_name', 'item name', 'اسم الصنف', 'اسم المنتج', 'البيان', 'description']);
    const batchCol = findCol(['batch', 'batch number', 'bn', 'lot', 'تشغيلة', 'رقم الباتش', 'الدفعة']);
    const serialCol = findCol(['serial', 'sn', 'سيريال', 'الرقم التسلسلي']);
    const expiryCol = findCol(['expiry', 'expiry-date', 'xd', 'exp', 'صلاحية', 'تاريخ الانتهاء', 'الصلاحية']);
    const qtyCol = findCol(['quantite', 'quantity', 'qty', 'الكمية', 'العدد', 'الكميه', 'sold_qty', 'count']);
    const priceCol = findCol(['sales price', 'sale_price', 'price', 'سعر البيع', 'سعر']);
    const unitPriceCol = findCol(['unitprice', 'cost', 'unit cost', 'purchase price', 'سعر الوحدة', 'التكلفة']);
    const g = (row, col, def = '') => (col !== null && Object.prototype.hasOwnProperty.call(row, col)) ? row[col] : def;

    const resolved = [];
    let skipped = 0;
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i], idx = idxOffset + i;
        let qrRaw = qrCol ? String(g(row, qrCol, '')).trim() : '';
        if (!qrRaw) {
            for (const c of columns) {
                const vs = String(row[c] ?? '').trim();
                if ((vs.includes('(01)') && vs.includes('(10)')) || (vs.startsWith('01') && vs.length > 25)) { qrRaw = vs; break; }
            }
        }
        let gtin = '', batch = '', serial = '', expiry = '';
        if (qrRaw) {
            const p = parseQrCode(qrRaw);
            if (p.success) { const d = p.data; gtin = d.gtin || ''; batch = String(d.batch || '').trim().toUpperCase(); serial = String(d.serial || '').trim().toUpperCase(); expiry = d.expiry || ''; }
        }
        if (!gtin && gtinCol) gtin = cleanBarcodePreserveZeros(String(g(row, gtinCol, '')));
        if (!batch && batchCol) batch = String(g(row, batchCol, '')).trim().toUpperCase();
        if (!serial && serialCol) serial = String(g(row, serialCol, '')).trim().toUpperCase();
        if (!expiry && expiryCol) expiry = normalizeDateStr(String(g(row, expiryCol, '')));
        batch = (!batch || batch.toLowerCase() === 'nan') ? 'BATCH-01' : batch.toUpperCase();
        if (serial.toLowerCase() === 'nan') serial = '';
        if (!expiry || expiry.toLowerCase() === 'nan') expiry = '2028-12-31';
        const codeVal = codeCol ? cleanNumericCode(String(g(row, codeCol, '')).trim()) : '';
        const nameVal = nameCol ? String(g(row, nameCol, '')).trim() : '';
        let qty = 1;
        if (qtyCol) { const q = pyFloat(g(row, qtyCol, 1)); qty = Number.isFinite(q) ? Math.max(1, Math.trunc(q)) : 1; }
        let sp = 0;
        if (priceCol) { const v = pyFloat(String(g(row, priceCol, 0)).replaceAll(',', '')); sp = Number.isFinite(v) ? v : 0; }
        let up = 0;
        if (unitPriceCol) { const v = pyFloat(String(g(row, unitPriceCol, 0)).replaceAll(',', '')); up = Number.isFinite(v) ? v : 0; }
        let product = null;
        if (gtin) product = await findProductByGtinOrBarcode(db, gtin);
        if (!product && codeVal) product = await getProductByCode(db, codeVal);
        if (!product && nameVal) product = await first(db, 'SELECT * FROM products WHERE name_en = ? OR name_ar = ? LIMIT 1', [nameVal, nameVal]);
        if (!product) {
            if (!nameVal && !codeVal && !gtin) { skipped++; continue; }
            const pn = nameVal || `صنف مستورد ${codeVal || gtin}`;
            const r = await saveOrUpdateProduct(db, { code: codeVal || null, name_en: pn, name_ar: pn, selling_price: sp, unit_price: up, gtin_list: gtin ? [gtin] : [], barcode_list: [] });
            product = await getProductByCode(db, r.code);
        }
        resolved.push({ idx, product, batch, serial, expiry, qty, sales_price: sp || product.selling_price || 0, unit_price: up || product.unit_price || 0, gtin });
    }

    let imported = 0;
    for (const it of resolved) {
        const p = it.product, pc = p.code, nAr = p.name_ar ?? '', nEn = p.name_en ?? '';
        const pName = nEn || nAr || p.name || `صنف ${pc}`;
        const tax = Number(p.tax_rate || 0), unit = String(p.unit || 'علبة').trim();
        const ex = await first(db, 'SELECT id, quantity FROM invoice_lines WHERE invoice_id = ? AND product_code = ? AND batch_number = ? AND expiry_date = ? LIMIT 1', [id, pc, it.batch, it.expiry]);
        let lineId;
        if (ex) lineId = ex.id;
        else lineId = (await run(db, `INSERT INTO invoice_lines (invoice_id, invoice_number, product_code, product_name, name_ar, name_en, batch_number, expiry_date, quantity,
            sales_price, unit_price, tax_rate, unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`, [id, invNo, pc, pName, nAr, nEn, it.batch, it.expiry, it.sales_price, it.unit_price, tax, unit])).last_row_id;
        const serials = it.serial ? [it.serial] : Array.from({ length: it.qty }, (_, i) => `${pc}-${it.batch}-N${String(it.idx + 1).padStart(3, '0')}_${String(i + 1).padStart(2, '0')}`);
        const stmts = [];
        for (const sn of serials) {
            if (await first(db, 'SELECT id FROM scanned_serials WHERE invoice_id = ? AND serial_number = ?', [id, sn])) continue;
            stmts.push(db.prepare(`INSERT INTO scanned_serials (invoice_id, invoice_number, line_id, product_code, raw_code, raw_gtin_or_barcode, batch_number, serial_number,
                expiry_date, unit, quantity, user_name, is_confirmed, is_returned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, 0)`)
                .bind(id, invNo, lineId, pc, pc, it.gtin || pc, it.batch, sn, it.expiry, unit, userName));
            imported++;
        }
        stmts.push(db.prepare('UPDATE invoice_lines SET quantity = (SELECT COUNT(*) FROM scanned_serials WHERE line_id = ?1 AND is_returned = 0) WHERE id = ?1').bind(lineId));
        await db.batch(stmts);
    }
    return { success: true, invoice_id: id, imported_count: imported, skipped_count: skipped };
}

export async function finishInvoiceImport(db, invoiceId, imported, skipped) {
    const id = parseInt(invoiceId, 10);
    await run(db, `UPDATE invoices SET total_items = (SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?1),
        total_packages = (SELECT COALESCE(SUM(quantity), 0) FROM invoice_lines WHERE invoice_id = ?1),
        total_amount = (SELECT COALESCE(SUM(quantity * sales_price), 0.0) FROM invoice_lines WHERE invoice_id = ?1) WHERE id = ?1 AND profile_id = ?2`, [id, pid(db)]);
    return { success: true, message: `تم استيراد الفاتورة وتفريغ ${imported} عبوة بنجاح مع ربط GTIN.`, imported_count: imported, skipped_count: skipped, invoice: await getInvoiceDetails(db, id) };
}
