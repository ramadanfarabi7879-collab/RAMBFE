// منقول من backend/db.py و backend/stock_manager.py: كرت الصنف، الفواتير، البحث قبل الجرد، الأصناف غير المجرودة.
import { all, first, run, allIn, getProductByCode, findProductByGtinOrBarcode, attachBarcodesBulk, buildProductSearchWhere, PRODUCT_ORDER_SQL } from './products.js';
import { resolveValidStoreNo } from './stock.js';
import {
    parseQrCode, extractCleanGtin, cleanBarcodePreserveZeros, cleanNumericCode, splitBarcodes, normalizeArabic, normalizeEnglish,
    decodeArabicKeyboardLayout, parseExpiryDate, isDigitStr, pyRound
} from './qr.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => pyRound(num(v), 2);
const r4 = (v) => pyRound(num(v), 4);
const up = (v) => String(v ?? '').trim().toUpperCase();
const pidOf = (db) => Number(db.pid || 1);
const PSTORES = 'SELECT store_no FROM stock_stores WHERE profile_id = ?';
const pyInt = (v) => { const n = parseInt(String(v ?? '').trim(), 10); if (!Number.isFinite(n)) throw new Error(`invalid literal for int() with base 10: '${v}'`); return n; };

// وقت المملكة (نفس توقيت جهاز الصيدلية) لأرقام وتواريخ الفواتير
function riyadhNow() {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date()).map(p => [p.type, p.value]));
    return { ymd: `${parts.year}${parts.month}${parts.day}`, date: `${parts.year}-${parts.month}-${parts.day}` };
}

// ---------------- سجل المراجعة ----------------
export async function logAuditEvent(db, entityType, entityId, action, oldValues = null, newValues = null, details = '', userName = 'المسؤول') {
    const s = (v) => (v && typeof v === 'object') ? JSON.stringify(v) : String(v || '');
    const m = await run(db, 'INSERT INTO audit_logs (entity_type, entity_id, action, old_values, new_values, details, user_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [entityType, String(entityId), action, s(oldValues), s(newValues), details, userName]);
    return m.last_row_id;
}

// ---------------- كرت الصنف ----------------
export async function logCatalogChange(db, codes) {
    const ts = Date.now() / 1000;
    const stmts = codes.map(c => db.prepare('INSERT INTO catalog_changes (code, ts) VALUES (?, ?)').bind(String(c), ts));
    for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
}

export async function getNextProductCode(db) {
    const row = await first(db, "SELECT MAX(CAST(code AS INTEGER)) AS m FROM products WHERE code GLOB '[0-9]*' AND length(code) <= 10");
    let next = (row && row.m !== null && row.m >= 10000) ? row.m + 1 : 10001;
    while (await first(db, 'SELECT 1 AS x FROM products WHERE code = ?', [String(next)])) next++;
    return String(next);
}

export async function saveOrUpdateProduct(db, p, userName = 'المسؤول') {
    let code = cleanNumericCode(p.code);
    let isNew = false, old = null;
    if (!code) { code = await getNextProductCode(db); isNew = true; }
    else { old = await getProductByCode(db, code); if (!old) isNew = true; }
    const nameAr = String(p.name_ar || '').trim(), nameEn = String(p.name_en || '').trim();
    let name = nameEn || nameAr || String(p.name || '').trim();
    if (!name) name = `صنف ${code}`;
    const sci = String(p.scientific_name || '').trim(), company = String(p.company || '').trim(), category = String(p.category || '').trim();
    const selling = num(p.selling_price), wholesale = num(p.wholesale_price), unitPrice = num(p.unit_price || p.cost_price), cost = unitPrice;
    const tax = num(p.tax_rate), unit = String(p.unit || 'علبة').trim(), divisions = String(p.unit_divisions || '').trim();

    const bsrc = [];
    if (p.primary_barcode) bsrc.push(String(p.primary_barcode).trim());
    if (p.extra_barcodes) bsrc.push(...splitBarcodes(p.extra_barcodes));
    if (p.barcode_list) bsrc.push(...(Array.isArray(p.barcode_list) ? p.barcode_list : splitBarcodes(p.barcode_list)));
    if (p.barcode && !bsrc.length) bsrc.push(...splitBarcodes(p.barcode));
    const barcodes = [];
    for (const b of bsrc) { const c = cleanBarcodePreserveZeros(b); if (c && !barcodes.includes(c)) barcodes.push(c); }
    const gsrc = [];
    if (p.primary_gtin) gsrc.push(String(p.primary_gtin).trim());
    if (p.extra_gtins) gsrc.push(...splitBarcodes(p.extra_gtins));
    if (p.gtin_list) gsrc.push(...(Array.isArray(p.gtin_list) ? p.gtin_list : splitBarcodes(p.gtin_list)));
    if (p.gtin && !gsrc.length) gsrc.push(...splitBarcodes(p.gtin));
    const gtins = [];
    for (const g of gsrc) { const c = extractCleanGtin(g) || cleanBarcodePreserveZeros(g); if (c && !gtins.includes(c)) gtins.push(c); }
    for (const b of barcodes) {
        if (b.length > 14 || b.includes('(01)') || b.includes('\x1d') || b.includes('http') || (b.startsWith('01') && b.length > 14)) {
            const c = extractCleanGtin(b); if (c && !gtins.includes(c)) gtins.push(c);
        }
    }
    const normAr = normalizeArabic(nameAr || name), normEn = normalizeEnglish(nameEn || name), normName = normAr || normEn || name;
    if (isNew && await first(db, 'SELECT 1 AS x FROM products WHERE code = ?', [code])) code = await getNextProductCode(db);

    const stmts = [db.prepare(`INSERT INTO products (code, gtin, barcode, name_ar, name_en, name, scientific_name, company, category,
        selling_price, wholesale_price, unit_price, cost_price, tax_rate, unit, unit_divisions, normalized_name, normalized_name_ar, normalized_name_en, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(code) DO UPDATE SET gtin = excluded.gtin, barcode = excluded.barcode, name_ar = excluded.name_ar, name_en = excluded.name_en,
        name = excluded.name, scientific_name = excluded.scientific_name, company = excluded.company, category = excluded.category,
        selling_price = excluded.selling_price, wholesale_price = excluded.wholesale_price, unit_price = excluded.unit_price, cost_price = excluded.cost_price,
        tax_rate = excluded.tax_rate, unit = excluded.unit, unit_divisions = excluded.unit_divisions, normalized_name = excluded.normalized_name,
        normalized_name_ar = excluded.normalized_name_ar, normalized_name_en = excluded.normalized_name_en, updated_at = CURRENT_TIMESTAMP`)
        .bind(code, gtins.join(', '), barcodes.join(', '), nameAr, nameEn, name, sci, company, category, selling, wholesale, unitPrice, cost, tax, unit, divisions, normName, normAr, normEn),
    db.prepare('DELETE FROM product_barcodes WHERE product_code = ?').bind(code)];
    for (const g of gtins) stmts.push(db.prepare("INSERT OR IGNORE INTO product_barcodes (product_code, barcode, barcode_type) VALUES (?, ?, 'gtin')").bind(code, g));
    for (const b of barcodes) stmts.push(db.prepare("INSERT OR IGNORE INTO product_barcodes (product_code, barcode, barcode_type) VALUES (?, ?, 'barcode')").bind(code, b));
    stmts.push(db.prepare("INSERT INTO meta (k, v) VALUES ('products_count', (SELECT COUNT(*) FROM products)) ON CONFLICT(k) DO UPDATE SET v = excluded.v"));
    await db.batch(stmts);
    const newData = { code, name_ar: nameAr, name_en: nameEn, scientific_name: sci, company, category, selling_price: selling, wholesale_price: wholesale, unit_price: unitPrice, tax_rate: tax, unit, barcode_list: barcodes, gtin_list: gtins };
    await logCatalogChange(db, [code]);
    if (isNew) await logAuditEvent(db, 'product', code, 'create', null, newData, 'إنشاء بطاقة صنف جديدة', userName);
    else await logAuditEvent(db, 'product', code, 'update', old, newData, 'تعديل بطاقة الصنف', userName);
    return { success: true, code, message: 'تم حفظ بطاقة الصنف بنجاح' };
}

export async function deleteProduct(db, code) {
    const clean = cleanNumericCode(code);
    if (!clean) return false;
    const old = await getProductByCode(db, clean);
    await db.batch([
        db.prepare('DELETE FROM products WHERE code = ?').bind(clean),
        db.prepare('DELETE FROM product_barcodes WHERE product_code = ?').bind(clean),
        db.prepare('DELETE FROM product_aliases WHERE product_code = ?').bind(clean),
        db.prepare("INSERT INTO meta (k, v) VALUES ('products_count', (SELECT COUNT(*) FROM products)) ON CONFLICT(k) DO UPDATE SET v = excluded.v"),
    ]);
    await logCatalogChange(db, [clean]);
    if (old) await logAuditEvent(db, 'product', clean, 'delete', old, null, 'حذف بطاقة الصنف');
    return true;
}

export async function bulkDeleteProducts(db, codes) {
    const clean = (codes || []).map(c => cleanNumericCode(c)).filter(Boolean);
    if (!clean.length) return 0;
    let deleted = 0;
    for (let i = 0; i < clean.length; i += 90) {
        const part = clean.slice(i, i + 90), ph = part.map(() => '?').join(',');
        // العدد الحقيقي للأصناف المحذوفة (عدّاد D1 يشمل صفوف الباركود والفهرس المحذوفة تلقائياً)
        deleted += (await first(db, `SELECT COUNT(*) AS c FROM products WHERE code IN (${ph})`, part)).c;
        await db.batch([
            db.prepare(`DELETE FROM products WHERE code IN (${ph})`).bind(...part),
            db.prepare(`DELETE FROM product_barcodes WHERE product_code IN (${ph})`).bind(...part),
            db.prepare(`DELETE FROM product_aliases WHERE product_code IN (${ph})`).bind(...part),
        ]);
    }
    await run(db, "INSERT INTO meta (k, v) VALUES ('products_count', (SELECT COUNT(*) FROM products)) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
    await logCatalogChange(db, clean);
    await logAuditEvent(db, 'product', 'bulk', 'bulk_delete', null, { count: deleted }, `حذف مجمع لـ ${deleted} صنف`);
    return deleted;
}

export async function clearCatalog(db) {
    await db.batch(['DELETE FROM products', 'DELETE FROM product_barcodes', 'DELETE FROM product_aliases',
        "INSERT INTO meta (k, v) VALUES ('products_count', '0') ON CONFLICT(k) DO UPDATE SET v = excluded.v"].map(s => db.prepare(s)));
    await logCatalogChange(db, ['*']);
}

export function parseGs1(raw) {
    raw = String(raw || '').trim();
    const parsed = parseQrCode(raw);
    let gtin = '', serial = '', batch = '', expiry = '', prodDate = '';
    if (parsed && parsed.success) {
        const d = parsed.data || {};
        gtin = d.gtin || ''; serial = d.serial || ''; batch = up(d.batch || ''); expiry = d.expiry || ''; prodDate = d.prod_date || '';
    }
    if (!gtin) gtin = extractCleanGtin(raw);
    const isGs1 = Boolean(serial || batch || expiry || prodDate || (gtin && (raw.startsWith('01') || raw.includes('(01)') || raw.includes('/01/') || raw.length > 14)));
    return { success: true, is_gs1: isGs1, gtin, serial, batch, expiry, prod_date: prodDate, raw };
}

export async function getStats(db) {
    const r = await first(db, `SELECT (SELECT v FROM meta WHERE k='products_count') AS products_count,
        (SELECT COUNT(*) FROM product_barcodes) AS barcodes_count,
        (SELECT COUNT(*) FROM invoices WHERE status = 'confirmed' AND profile_id = ?1) AS invoices_count,
        (SELECT COUNT(*) FROM scanned_serials WHERE is_confirmed = 1 AND is_returned = 0 AND invoice_id IN (SELECT id FROM invoices WHERE profile_id = ?1)) AS active_serials`, [pidOf(db)]);
    return { products_count: Number(r.products_count || 0), barcodes_count: r.barcodes_count, invoices_count: r.invoices_count, active_serials: r.active_serials };
}

// ---------------- البحث قبل الجرد ----------------
async function resolveCanonicalCodeMap(db, pairs) {
    const cand = new Set();
    for (const [pc] of pairs) {
        const c = cleanNumericCode(pc); if (!c) continue;
        cand.add(c);
        if (isDigitStr(c)) { cand.add(c.padStart(10, '0')); cand.add(c.replace(/^0+/, '') || '0'); }
    }
    const found = new Set((await allIn(db, 'SELECT code FROM products WHERE code IN ({ph})', [], [...cand])).map(r => r.code));
    const map = new Map();
    for (const [pc, bc] of pairs) {
        const key = `${pc}\u0000${bc}`;
        if (found.has(pc)) { map.set(key, pc); continue; }
        const c = cleanNumericCode(pc);
        let m = '';
        if (c) {
            if (found.has(c)) m = c;
            else if (isDigitStr(c)) { const z = c.padStart(10, '0'), s = c.replace(/^0+/, '') || '0'; if (found.has(z)) m = z; else if (found.has(s)) m = s; }
        }
        if (!m && bc) {
            const b = cleanBarcodePreserveZeros(bc);
            if (b) {
                let row = await first(db, 'SELECT code FROM products WHERE barcode = ? OR gtin = ? LIMIT 1', [b, b]);
                if (!row) row = await first(db, 'SELECT product_code AS code FROM product_barcodes WHERE barcode = ? LIMIT 1', [b]);
                if (row) m = row.code;
            }
        }
        if (m) map.set(key, m);
    }
    return map;
}

async function allStoresPreinventoryMap(db) {
    const names = Object.fromEntries((await all(db, 'SELECT store_no, store_name FROM stock_stores WHERE profile_id = ?', [pidOf(db)])).map(r => [r.store_no, r.store_name]));
    const inv = await all(db, `SELECT product_code, COALESCE(barcode, '') AS barcode, COALESCE(store_no, 'ST-001') AS store_no, COALESCE(batch_number, '') AS batch_number,
        COALESCE(expiry_date, '') AS expiry_date, COALESCE(system_qty, 0) AS system_qty FROM inventory_records WHERE store_no IN (${PSTORES}) ORDER BY expiry_date ASC, id ASC`, [pidOf(db)]);
    if (!inv.length) return {};
    const pairs = [...new Map(inv.map(r => [`${String(r.product_code || '').trim()}\u0000${String(r.barcode || '').trim()}`, [String(r.product_code || '').trim(), String(r.barcode || '').trim()]])).values()];
    const cmap = await resolveCanonicalCodeMap(db, pairs);
    const per = {};
    for (const r of inv) {
        const canon = cmap.get(`${String(r.product_code || '').trim()}\u0000${String(r.barcode || '').trim()}`);
        if (!canon) continue;
        const st = String(r.store_no || 'ST-001').trim() || 'ST-001';
        const qty = num(r.system_qty), b = up(r.batch_number), exp = String(r.expiry_date || '').trim();
        const sm = (per[canon] ||= {});
        const e = (sm[st] ||= { store_no: st, store_name: names[st] ?? st, sum_qty: 0, max_qty: -Infinity, batch_count: 0, batches: [] });
        e.sum_qty += qty; if (qty > e.max_qty) e.max_qty = qty; e.batch_count += 1;
        if (qty !== 0 || b || exp) e.batches.push({ batch_number: b, expiry_date: exp, system_qty: r4(qty) });
    }
    const out = {};
    for (const [canon, sm] of Object.entries(per)) {
        const pos = []; let tq = 0, tb = 0;
        for (const st of Object.keys(sm).sort()) {
            const e = sm[st];
            if (e.max_qty > 0 && e.sum_qty > 0) {
                const s = r4(e.sum_qty); tq += s; tb += e.batch_count;
                pos.push({ store_no: st, store_name: e.store_name, system_qty: s, batch_count: e.batch_count, batches: e.batches });
            }
        }
        if (pos.length) out[canon] = { pre_inventory_stores: pos, pre_inventory_total_qty: r4(tq), pre_inventory_batch_count: tb };
    }
    return out;
}

async function isExactCodeOrBarcodeQuery(db, rawQuery) {
    const q = String(rawQuery || '').trim();
    if (!q) return false;
    const cands = new Set([q, q.toLowerCase(), q.toUpperCase()]);
    const dec = decodeArabicKeyboardLayout(q).trim();
    if (dec) { cands.add(dec); cands.add(dec.toLowerCase()); cands.add(dec.toUpperCase()); }
    for (const cand of [...cands]) {
        if (isDigitStr(cand)) return true;
        const c = cleanNumericCode(cand), b = cleanBarcodePreserveZeros(cand);
        if (c) { cands.add(c); if (isDigitStr(c)) { cands.add(c.padStart(10, '0')); cands.add(c.replace(/^0+/, '') || '0'); } }
        if (b) cands.add(b);
    }
    const list = [...cands].filter(Boolean);
    if (!list.length) return false;
    const ph = list.map(() => '?').join(',');
    if (await first(db, `SELECT 1 AS x FROM products WHERE code IN (${ph}) OR barcode IN (${ph}) OR gtin IN (${ph}) LIMIT 1`, [...list, ...list, ...list])) return true;
    return Boolean(await first(db, `SELECT 1 AS x FROM product_barcodes WHERE barcode IN (${ph}) LIMIT 1`, list));
}

const lit = (v) => (v === null || v === undefined) ? 'NULL' : (typeof v === 'number' ? String(v) : "'" + String(v).replaceAll("'", "''") + "'");
const inline = (sql, params) => { let i = 0; return sql.replace(/\?/g, () => lit(params[i++])); };
const ftsPhrase = (v) => '"' + String(v).replaceAll('"', '""') + '"';

export async function searchPreinventoryProducts(db, query = '', limit = 100, offset = 0, matchMode = 'start', stockOnly = false) {
    const preinv = await allStoresPreinventoryMap(db);
    const rawQ = String(query || '').replace(/^\s+/, ''), q = rawQ.trim();
    const isContains = ['contains', 'generalized', 'all', 'true', '1'].includes(String(matchMode || '').toLowerCase());
    let qrGtin = '', qrBatch = '';
    if (q) {
        const pq = parseQrCode(q), d = pq.data || {};
        if (pq.success && (d.gtin || d.batch || pq.gtin)) {
            const rg = d.gtin || pq.gtin || '';
            qrGtin = cleanBarcodePreserveZeros(extractCleanGtin(rg) || rg);
            qrBatch = up(d.batch || pq.batch_number || '');
        }
    }
    const effRaw = qrGtin || rawQ, effQ = effRaw.trim();
    const isCodeOrQr = Boolean(qrGtin || (effQ && await isExactCodeOrBarcodeQuery(db, effQ)));
    const bypassed = Boolean(stockOnly && isCodeOrQr), applyFilter = Boolean(stockOnly && !bypassed);
    if (applyFilter && !Object.keys(preinv).length) return { items: [], total: 0, limit, offset, bypassed_stock_filter: false };
    const eligible = applyFilter ? `p.code IN (${Object.keys(preinv).map(lit).join(',') || "''"})` : '';
    let rows, total, batchMap = {};
    if (!effQ) {
        const w = eligible ? `WHERE ${eligible}` : '';
        total = (await first(db, `SELECT COUNT(*) AS c FROM products p ${w}`)).c;
        rows = await all(db, `SELECT p.* FROM products p ${w} ORDER BY p.id DESC LIMIT ? OFFSET ?`, [limit, offset]);
    } else {
        const { whereSql, params, orderParams, ftsVariants } = buildProductSearchWhere(effRaw, matchMode);
        if (!qrGtin) {
            const pat = isContains ? `%${effQ.toUpperCase()}%` : `${effQ.toUpperCase()}%`;
            const br = await all(db, `SELECT DISTINCT product_code, COALESCE(barcode, '') AS barcode, UPPER(TRIM(batch_number)) AS batch_number FROM inventory_records
                WHERE batch_number IS NOT NULL AND TRIM(batch_number) != '' AND UPPER(TRIM(batch_number)) LIKE ? AND store_no IN (${PSTORES}) LIMIT 200`, [pat, pidOf(db)]);
            if (br.length) {
                const pairs = br.map(r => [String(r.product_code || '').trim(), String(r.barcode || '').trim()]);
                const cmap = await resolveCanonicalCodeMap(db, pairs);
                for (const r of br) { const c = cmap.get(`${String(r.product_code || '').trim()}\u0000${String(r.barcode || '').trim()}`); if (c) (batchMap[c] ||= []).push(r.batch_number); }
            }
        }
        const vs = [...new Set(ftsVariants.map(String))];
        const fts = (vs.length && !vs.some(v => [...v].length < 3)) ? `p.id IN (SELECT rowid FROM product_search WHERE product_search MATCH ${lit(vs.map(ftsPhrase).join(' OR '))})` : '';
        const bCodes = Object.keys(batchMap);
        let core = inline(`(${whereSql})`, params);
        if (fts) core = `(${core} AND ${fts})`;
        let combined = bCodes.length ? `(${core} OR p.code IN (${bCodes.map(lit).join(',')}))` : core;
        if (eligible) combined = `${combined} AND ${eligible}`;
        const from = 'FROM products p LEFT JOIN product_barcodes pb ON p.code = pb.product_code';
        total = (await first(db, `SELECT COUNT(DISTINCT p.id) AS c ${from} WHERE ${combined}`)).c;
        rows = await all(db, inline(`SELECT DISTINCT p.* ${from} WHERE ${combined} ${PRODUCT_ORDER_SQL} LIMIT ? OFFSET ?`, [...orderParams, limit, offset]));
    }
    await attachBarcodesBulk(db, rows);
    for (const it of rows) {
        const pre = preinv[it.code];
        it.pre_inventory_stores = pre ? pre.pre_inventory_stores : [];
        it.pre_inventory_total_qty = pre ? pre.pre_inventory_total_qty : 0;
        it.pre_inventory_batch_count = pre ? pre.pre_inventory_batch_count : 0;
        if (batchMap[it.code]) it.matched_batch_numbers = [...new Set(batchMap[it.code])].sort();
        if (qrBatch) it.matched_qr_batch = qrBatch;
    }
    return { items: rows, total, limit, offset, bypassed_stock_filter: bypassed, qr_gtin: qrGtin, qr_batch: qrBatch };
}

// ---------------- الأصناف غير المجرودة ----------------
export async function getUncountedStoreItems(db, storeNo = 'ST-001', category = '') {
    storeNo = await resolveValidStoreNo(db, storeNo);
    const storeInfo = await first(db, 'SELECT * FROM stock_stores WHERE store_no = ?', [storeNo]);
    const hasInv = (await first(db, 'SELECT COUNT(*) AS c FROM inventory_records WHERE store_no = ?', [storeNo])).c > 0;
    const notCounted = `NOT EXISTS (SELECT 1 FROM stocktake_entries se WHERE se.store_no = ${hasInv ? 'ir.store_no' : '?'}
        AND (se.product_code = ir.product_code OR (ir.barcode IS NOT NULL AND ir.barcode != '' AND (se.gtin = ir.barcode OR se.barcode = ir.barcode)))
        AND ((ir.batch_number IS NOT NULL AND ir.batch_number != '' AND se.batch_number = ir.batch_number)
          OR ((ir.batch_number IS NULL OR ir.batch_number = '') AND (se.batch_number IS NULL OR se.batch_number = '')))
        AND se.counted_qty > 0)`;
    let sql = hasInv ? `SELECT ir.* FROM inventory_records ir WHERE ir.store_no = ? AND ${notCounted}` : `SELECT ir.* FROM inventory_records ir WHERE ${notCounted} AND ir.store_no IN (${PSTORES})`;
    const params = hasInv ? [storeNo] : [storeNo, pidOf(db)];
    if (category) { sql += ' AND ir.item_type = ?'; params.push(category); }
    const raw = await all(db, sql + ' ORDER BY ir.id ASC', params);
    const codes = new Set();
    for (const r of raw) { codes.add(r.product_code); const c = cleanNumericCode(r.product_code); if (c) codes.add(c); }
    const pm = Object.fromEntries((codes.size ? await allIn(db, 'SELECT code, name_en, name, category, cost_price, selling_price, unit_price FROM products WHERE code IN ({ph})', [], [...codes]) : []).map(p => [p.code, p]));
    const items = []; let tq = 0, tc = 0, ts = 0;
    for (const r of raw) {
        let pr = pm[r.product_code];
        if (!pr) { const c = cleanNumericCode(r.product_code); if (c && c !== r.product_code) pr = pm[c]; }
        let name = r.product_name || '', cat = r.item_type || 'medicine', cost = num(r.cost_price), sale = num(r.selling_price);
        const sq = num(r.system_qty);
        if (pr) {
            name = pr.name_en || name || pr.name || '';
            if (pr.category) cat = pr.category;
            if (cost === 0 && pr.cost_price) cost = num(pr.cost_price);
            if (sale === 0) { const sp = pr.selling_price || pr.unit_price; if (sp) sale = num(sp); }
        }
        const lc = r2(sq * cost), ls = r2(sq * sale);
        tq += sq; tc += lc; ts += ls;
        items.push({ id: r.id, product_code: r.product_code, product_name: name, barcode: r.barcode || '', batch_number: up(r.batch_number), expiry_date: r.expiry_date || '',
            system_qty: sq, cost_price: cost, selling_price: sale, total_cost: lc, total_sale: ls, category: cat, store_no: storeNo });
    }
    const cs = {};
    for (const it of items) {
        const k = it.category || 'عام';
        const e = (cs[k] ||= { count: 0, qty: 0, cost: 0, sale: 0 });
        e.count += 1; e.qty = r2(e.qty + it.system_qty); e.cost = r2(e.cost + it.total_cost); e.sale = r2(e.sale + it.total_sale);
    }
    return {
        store: storeInfo || { store_no: storeNo, store_name: 'الاستور الرئيسي' }, items, categories_summary: cs,
        stats: { total_uncounted_items: items.length, total_uncounted_qty: r2(tq), total_uncounted_cost: r2(tc), total_uncounted_sale: r2(ts) }
    };
}

// ---------------- الفواتير ----------------
async function generateInvoiceNumber(db) {
    const prefix = `INV-${riyadhNow().ymd}-`;
    const row = await first(db, 'SELECT invoice_number FROM invoices WHERE invoice_number LIKE ? ORDER BY id DESC LIMIT 1', [`${prefix}%`]);
    let seq = 1;
    if (row) { const parts = row.invoice_number.split('-'); const last = parts[parts.length - 1]; if (parts.length >= 3 && isDigitStr(last)) seq = parseInt(last, 10) + 1; }
    return `${prefix}${String(seq).padStart(4, '0')}`;
}

export async function getInvoiceDetails(db, invoiceId) {
    const inv = await first(db, 'SELECT * FROM invoices WHERE id = ? AND profile_id = ?', [invoiceId, pidOf(db)]);
    if (!inv) return {};
    const lines = await all(db, `SELECT l.*, COALESCE(p.gtin, '') as gtin, COALESCE(p.barcode, '') as barcode,
        COALESCE(p.name_en, l.name_en, '') as product_name_en, COALESCE(p.name_ar, l.name_ar, '') as product_name_ar
        FROM invoice_lines l LEFT JOIN products p ON l.product_code = p.code WHERE l.invoice_id = ? ORDER BY l.id ASC`, [invoiceId]);
    const serials = lines.length ? await allIn(db, 'SELECT id, line_id, serial_number, scanned_at, user_name, is_confirmed, is_returned, return_reason FROM scanned_serials WHERE line_id IN ({ph}) ORDER BY id ASC', [], lines.map(l => l.id)) : [];
    const byLine = {};
    for (const s of serials) { const { line_id, ...rest } = s; (byLine[line_id] ||= []).push(rest); }
    for (const l of lines) {
        if (l.product_name_en) l.name_en = l.product_name_en;
        if (l.product_name_ar) l.name_ar = l.product_name_ar;
        if (!l.name_en && l.product_name) l.name_en = l.product_name;
        if (l.batch_number) l.batch_number = up(l.batch_number);
        l.serials = byLine[l.id] || [];
    }
    inv.lines = lines;
    return inv;
}

export async function getOrCreateDraftInvoice(db, userName = 'المسؤول') {
    const row = await first(db, "SELECT id FROM invoices WHERE status = 'draft' AND profile_id = ? ORDER BY id DESC LIMIT 1", [pidOf(db)]);
    if (row) return getInvoiceDetails(db, row.id);
    const m = await run(db, "INSERT INTO invoices (invoice_number, invoice_date, status, user_name, profile_id) VALUES (?, ?, 'draft', ?, ?)", [await generateInvoiceNumber(db), riyadhNow().date, userName, pidOf(db)]);
    return getInvoiceDetails(db, m.last_row_id);
}

export async function createNewInvoice(db, notes = '', userName = 'المسؤول') {
    const m = await run(db, "INSERT INTO invoices (invoice_number, invoice_date, status, notes, user_name, profile_id) VALUES (?, ?, 'draft', ?, ?, ?)", [await generateInvoiceNumber(db), riyadhNow().date, notes, userName, pidOf(db)]);
    return getInvoiceDetails(db, m.last_row_id);
}

const TOTALS_SQL = `UPDATE invoices SET total_items = (SELECT COUNT(*) FROM invoice_lines WHERE invoice_id = ?1),
    total_packages = (SELECT COALESCE(SUM(quantity), 0) FROM invoice_lines WHERE invoice_id = ?1),
    total_amount = (SELECT COALESCE(SUM(quantity * sales_price), 0) FROM invoice_lines WHERE invoice_id = ?1) WHERE id = ?1`;
const LINE_INSERT = `INSERT INTO invoice_lines (invoice_id, invoice_number, product_code, product_name, name_ar, name_en, batch_number, expiry_date, quantity,
    sales_price, unit_price, tax_rate, unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const SERIAL_INSERT = `INSERT INTO scanned_serials (invoice_id, invoice_number, line_id, product_code, raw_code, raw_gtin_or_barcode, batch_number, serial_number,
    expiry_date, unit, quantity, user_name, is_confirmed, is_returned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`;

export async function scanQrToInvoice(db, invoiceId, rawQr, userName = 'المسؤول') {
    const addQty = 1;
    const parsed = parseQrCode(rawQr);
    if (!parsed.success) return { success: false, code: parsed.code || 'INVALID_QR', message: parsed.message || 'صيغة كود QR غير صالحة أو غير معروفة.' };
    const d = parsed.data;
    const gtin = d.gtin, batch = up(d.batch || ''), serial = String(d.serial || '').trim(), expiry = d.expiry || '';
    if (!batch || !serial) return { success: false, code: 'MISSING_BATCH_OR_SERIAL', message: 'كود QR لا يحتوي على رقم الباتش أو السيريال المطلوب.' };
    const product = await findProductByGtinOrBarcode(db, gtin);
    if (!product) return { success: false, code: 'ITEM_NOT_FOUND', message: `لم يتم العثور على الصنف المرتبط بهذا GTIN أو الباركود (${gtin}).`, gtin, batch, serial, expiry };
    const pc = product.code, nAr = product.name_ar || '', nEn = product.name_en || '';
    const pName = product.name || nAr || nEn || `صنف ${pc}`;
    const sp = num(product.selling_price), unitPrice = num(product.unit_price || product.cost_price), tax = num(product.tax_rate), unit = String(product.unit || 'علبة').trim();
    const inv = await first(db, 'SELECT invoice_number, status FROM invoices WHERE id = ? AND profile_id = ?', [invoiceId, pidOf(db)]);
    if (!inv) return { success: false, code: 'NO_INVOICE', message: 'الفاتورة غير موجودة' };
    if (inv.status !== 'draft') return { success: false, code: 'INVOICE_LOCKED', message: 'هذه الفاتورة معتمدة ولا يمكن إضافة عبوات جديدة إليها' };
    if (await first(db, 'SELECT id FROM scanned_serials WHERE invoice_id = ? AND serial_number = ? AND is_returned = 0 LIMIT 1', [invoiceId, serial]))
        return { success: false, code: 'DUPLICATE_IN_CURRENT', message: 'هذا السيريال مسجل بالفعل، ولم تتم إضافة العبوة مرة أخرى.', serial, gtin, batch, expiry, product_code: pc, name: pName };
    const prev = await first(db, 'SELECT invoice_number FROM scanned_serials WHERE serial_number = ? AND product_code = ? AND is_confirmed = 1 AND is_returned = 0 AND invoice_id IN (SELECT id FROM invoices WHERE profile_id = ?) LIMIT 1', [serial, pc, pidOf(db)]);
    if (prev) return { success: false, code: 'ALREADY_CONFIRMED', message: `هذا السيريال مسجل بالفعل في فاتورة معتمدة سابقة (رقم: ${prev.invoice_number})، ولم تتم إضافة العبوة.`, serial, prev_invoice: prev.invoice_number, gtin, batch, expiry, product_code: pc, name: pName };
    const lr = await first(db, 'SELECT id, quantity FROM invoice_lines WHERE invoice_id = ? AND product_code = ? AND batch_number = ? AND expiry_date = ? LIMIT 1', [invoiceId, pc, batch, expiry]);
    let lineId, newQty;
    if (lr) { lineId = lr.id; newQty = lr.quantity + addQty; await run(db, 'UPDATE invoice_lines SET quantity = ? WHERE id = ?', [newQty, lineId]); }
    else { lineId = (await run(db, LINE_INSERT, [invoiceId, inv.invoice_number, pc, pName, nAr, nEn, batch, expiry, addQty, sp, unitPrice, tax, unit])).last_row_id; newQty = addQty; }
    await db.batch([
        db.prepare(SERIAL_INSERT).bind(invoiceId, inv.invoice_number, lineId, pc, rawQr, gtin, batch, serial, expiry, unit, addQty, userName),
        db.prepare(TOTALS_SQL).bind(invoiceId),
    ]);
    return { success: true, code: 'ADDED', message: `تمت إضافة عبوة واحدة (حبة)، والكمية الحالية: ${newQty}.`, line_qty: newQty, added_qty: addQty,
        product_code: pc, name: pName, name_en: nEn, name_ar: nAr, gtin, batch, serial, expiry };
}

export async function updateInvoiceLineQuantity(db, invoiceId, lineId, newQuantity) {
    const q = pyInt(newQuantity);
    if (q <= 0) return { success: false, message: 'يجب أن تكون الكمية أكبر من الصفر (1 على الأقل).' };
    const inv = await first(db, 'SELECT status FROM invoices WHERE id = ? AND profile_id = ?', [invoiceId, pidOf(db)]);
    if (!inv) return { success: false, message: 'الفاتورة غير موجودة' };
    if (inv.status !== 'draft') return { success: false, message: 'الفاتورة معتمدة ولا يمكن تعديل كمياتها' };
    if (!await first(db, 'SELECT id FROM invoice_lines WHERE id = ? AND invoice_id = ?', [lineId, invoiceId])) return { success: false, message: 'سطر البند غير موجود في هذه الفاتورة' };
    await db.batch([db.prepare('UPDATE invoice_lines SET quantity = ? WHERE id = ?').bind(q, lineId), db.prepare(TOTALS_SQL).bind(invoiceId)]);
    return { success: true, message: `تم تعديل الكمية بنجاح إلى ${q}`, new_quantity: q };
}

export async function addManualItemToInvoice(db, invoiceId, gtinOrCode, batch, expiry, quantity = 1, userName = 'المسؤول', forcedProductCode = null) {
    const val = String(gtinOrCode || '').trim();
    if (!val) return { success: false, message: 'يرجى كتابة كود الصنف أو الباركود أو GTIN.' };
    // عند المراجعة اليدوية لفاتورة مقروءة بالذكاء الاصطناعي: الصنف محدد بالكود صراحة
    const product = forcedProductCode ? await getProductByCode(db, forcedProductCode) : (await findProductByGtinOrBarcode(db, val) || await getProductByCode(db, val));
    if (!product) return { success: false, code: 'ITEM_NOT_FOUND', message: `لم يتم العثور على الصنف (${val}).` };
    const cb = decodeArabicKeyboardLayout(String(batch || '').trim()).toUpperCase() || 'BATCH1';
    const ce = parseExpiryDate(expiry) || expiry || '2027-12-31';
    const cq = Math.max(1, pyInt(quantity || 1));
    const dummy = `MANUAL-${crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase()}`;
    const rawStr = `MANUAL|${val}|${cb}|${ce}|${dummy}|QTY:${cq}`;
    const inv = await first(db, 'SELECT invoice_number, status FROM invoices WHERE id = ? AND profile_id = ?', [invoiceId, pidOf(db)]);
    if (!inv || inv.status !== 'draft') return { success: false, message: 'الفاتورة غير موجودة أو معتمدة.' };
    const pc = product.code, nAr = product.name_ar || '', nEn = product.name_en || '';
    const pName = nEn || product.name || nAr || `صنف ${pc}`;
    const sp = num(product.selling_price), unitPrice = num(product.unit_price || product.cost_price), tax = num(product.tax_rate), unit = String(product.unit || 'علبة').trim();
    const lr = await first(db, 'SELECT id, quantity FROM invoice_lines WHERE invoice_id = ? AND product_code = ? AND batch_number = ? AND expiry_date = ? LIMIT 1', [invoiceId, pc, cb, ce]);
    let lineId, newQty;
    if (lr) { lineId = lr.id; newQty = lr.quantity + cq; await run(db, 'UPDATE invoice_lines SET quantity = ? WHERE id = ?', [newQty, lineId]); }
    else { lineId = (await run(db, LINE_INSERT, [invoiceId, inv.invoice_number, pc, pName, nAr, nEn, cb, ce, cq, sp, unitPrice, tax, unit])).last_row_id; newQty = cq; }
    await db.batch([db.prepare(SERIAL_INSERT).bind(invoiceId, inv.invoice_number, lineId, pc, rawStr, val, cb, dummy, ce, unit, cq, userName), db.prepare(TOTALS_SQL).bind(invoiceId)]);
    return { success: true, code: 'ADDED', message: `تمت إضافة ${cq} عبوة من الصنف (${nEn || pName}) بنجاح.`, product_code: pc, name: pName, name_en: nEn,
        batch: cb, expiry: ce, serial: dummy, line_qty: newQty, added_qty: cq };
}

export async function deleteScannedSerial(db, invoiceId, serialId) {
    const inv = await first(db, 'SELECT status FROM invoices WHERE id = ? AND profile_id = ?', [invoiceId, pidOf(db)]);
    if (!inv || inv.status !== 'draft') return { success: false, message: 'لا يمكن حذف عبوات من فاتورة معتمدة.' };
    const s = await first(db, 'SELECT line_id FROM scanned_serials WHERE id = ? AND invoice_id = ?', [serialId, invoiceId]);
    if (!s) return { success: false, message: 'لم يتم العثور على السيريال المحدد.' };
    await run(db, 'DELETE FROM scanned_serials WHERE id = ?', [serialId]);
    const rem = (await first(db, 'SELECT COUNT(*) AS c FROM scanned_serials WHERE line_id = ? AND is_returned = 0', [s.line_id])).c;
    await db.batch([
        rem <= 0 ? db.prepare('DELETE FROM invoice_lines WHERE id = ?').bind(s.line_id) : db.prepare('UPDATE invoice_lines SET quantity = ? WHERE id = ?').bind(rem, s.line_id),
        db.prepare(TOTALS_SQL).bind(invoiceId),
    ]);
    return { success: true, message: 'تم حذف العبوة بنجاح وتحديث الكمية.' };
}

export async function deleteInvoiceLine(db, invoiceId, lineId) {
    const inv = await first(db, 'SELECT status FROM invoices WHERE id = ? AND profile_id = ?', [invoiceId, pidOf(db)]);
    if (!inv || inv.status !== 'draft') return { success: false, message: 'لا يمكن حذف سطور من فاتورة معتمدة.' };
    await db.batch([
        db.prepare('DELETE FROM scanned_serials WHERE line_id = ? AND invoice_id = ?').bind(lineId, invoiceId),
        db.prepare('DELETE FROM invoice_lines WHERE id = ? AND invoice_id = ?').bind(lineId, invoiceId),
        db.prepare(TOTALS_SQL).bind(invoiceId),
    ]);
    return { success: true, message: 'تم حذف السطر وسيريالاته بنجاح.' };
}

export async function clearInvoiceLines(db, invoiceId) {
    const inv = await first(db, 'SELECT status FROM invoices WHERE id = ? AND profile_id = ?', [invoiceId, pidOf(db)]);
    if (!inv) return { success: false, message: 'الفاتورة غير موجودة.' };
    if (inv.status !== 'draft') return { success: false, message: 'لا يمكن تفريغ فاتورة معتمدة.' };
    await db.batch([
        db.prepare('DELETE FROM scanned_serials WHERE invoice_id = ?').bind(invoiceId),
        db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').bind(invoiceId),
        db.prepare('UPDATE invoices SET total_items = 0, total_packages = 0, total_amount = 0.0 WHERE id = ?').bind(invoiceId),
    ]);
    return { success: true, message: 'تم مسح وتفريغ جميع أصناف الفاتورة بالكامل بنجاح.' };
}

export async function confirmInvoice(db, invoiceId) {
    const row = await first(db, 'SELECT status, total_packages FROM invoices WHERE id = ? AND profile_id = ?', [invoiceId, pidOf(db)]);
    if (!row) return { success: false, message: 'الفاتورة غير موجودة.' };
    if (row.status === 'confirmed') return { success: true, message: 'تم اعتماد الفاتورة ويمكن تصديرها إلى Excel.' };
    if (row.total_packages <= 0) return { success: false, message: 'لا يمكن اعتماد فاتورة فارغة بدون عبوات ممسوحة.' };
    await db.batch([
        db.prepare("UPDATE invoices SET status = 'confirmed', confirmed_at = CURRENT_TIMESTAMP WHERE id = ?").bind(invoiceId),
        db.prepare('UPDATE scanned_serials SET is_confirmed = 1 WHERE invoice_id = ?').bind(invoiceId),
    ]);
    return { success: true, message: 'تم اعتماد الفاتورة ويمكن تصديرها إلى Excel.' };
}

export async function processSerialReturn(db, serialNumber, invoiceNumber = '', reason = 'إرجاع عبوة', userName = 'المسؤول') {
    const sn = String(serialNumber).trim();
    if (!sn) return { success: false, message: 'رقم السيريال غير صالح' };
    let sql = 'SELECT id, invoice_number, product_code, is_returned FROM scanned_serials WHERE serial_number = ? AND is_confirmed = 1 AND invoice_id IN (SELECT id FROM invoices WHERE profile_id = ?)';
    const params = [sn, pidOf(db)];
    if (invoiceNumber) { sql += ' AND invoice_number = ?'; params.push(String(invoiceNumber).trim()); }
    const row = await first(db, sql, params);
    if (!row) return { success: false, message: 'لم يتم العثور على سيريال معتمد مطابق للبيانات المدخلة.' };
    if (row.is_returned) return { success: false, message: 'هذا السيريال مسجل كمرتجع بالفعل مسبقاً.' };
    await db.batch([
        db.prepare('UPDATE scanned_serials SET is_returned = 1, return_reason = ?, returned_at = CURRENT_TIMESTAMP, returned_by = ? WHERE id = ?').bind(reason, userName, row.id),
        db.prepare('INSERT INTO returns_log (serial_id, serial_number, product_code, invoice_number, return_reason, returned_by) VALUES (?, ?, ?, ?, ?, ?)').bind(row.id, sn, row.product_code, row.invoice_number, reason, userName),
    ]);
    return { success: true, message: `تم توثيق إرجاع العبوة (السيريال: ${sn}) بنجاح وحفظ سجل العملية كاملاً.` };
}

export async function getAllInvoices(db, limit = 50, offset = 0) {
    return all(db, 'SELECT * FROM invoices WHERE profile_id = ? ORDER BY id DESC LIMIT ? OFFSET ?', [pidOf(db), limit, offset]);
}

export { parseQrCode };
