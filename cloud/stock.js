// منقول من backend/stock_manager.py (عمليات الجرد) ليعمل على Cloudflare D1 بدون الكمبيوتر.
import { all, first, run, allIn, getProductByCode, findProductByGtinOrBarcode, attachBarcodesBulk, buildProductSearchWhere, runProductQuery, PRODUCT_ORDER_SQL } from './products.js';
import { parseQrCode, extractCleanGtin, cleanBarcodePreserveZeros, cleanNumericCode, decodeArabicKeyboardLayout, parseExpiryDate, isDigitStr, pyRound } from './qr.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => pyRound(num(v), 2);
const r4 = (v) => pyRound(num(v), 4);
// تنسيق الأرقام كما تطبعها بايثون في الرسائل (2.0 بدلاً من 2)
const pyf = (v) => { const n = num(v); return Number.isInteger(n) ? n.toFixed(1) : String(n); };
const up = (v) => String(v ?? '').trim().toUpperCase();
const MAIN_STORE_SQL = "INSERT INTO stock_stores (store_no, store_name, branch_name, status, created_by) VALUES ('ST-001', 'الاستور الرئيسي', 'الفرع الرئيسي', 'new', 'المسؤول')";

export async function resolveValidStoreNo(db, storeNo = '') {
    const clean = String(storeNo || '').trim();
    if (clean && clean !== 'ALL') {
        const row = await first(db, 'SELECT store_no FROM stock_stores WHERE store_no = ?', [clean]);
        if (row) return row.store_no;
    }
    const row = await first(db, 'SELECT store_no FROM stock_stores ORDER BY id DESC LIMIT 1');
    if (row) return row.store_no;
    await run(db, MAIN_STORE_SQL);
    return 'ST-001';
}

export async function getAllStores(db, searchQ = '') {
    let sql = `SELECT s.*,
        COALESCE((SELECT COUNT(DISTINCT product_code) FROM stocktake_entries WHERE store_no = s.store_no), 0) as counted_items,
        COALESCE((SELECT SUM(counted_qty) FROM stocktake_entries WHERE store_no = s.store_no), 0) as counted_qty,
        COALESCE((SELECT SUM(counted_qty * cost_price) FROM stocktake_entries WHERE store_no = s.store_no), 0) as counted_cost,
        COALESCE((SELECT SUM(counted_qty * selling_price) FROM stocktake_entries WHERE store_no = s.store_no), 0) as counted_sale,
        COALESCE((SELECT SUM(system_qty * cost_price) FROM inventory_records WHERE store_no = s.store_no), 0) as system_cost,
        COALESCE((SELECT SUM(system_qty * selling_price) FROM inventory_records WHERE store_no = s.store_no), 0) as system_sale,
        COALESCE((SELECT COUNT(*) FROM stocktake_entries WHERE store_no = s.store_no AND is_new_batch = 1), 0) as new_batches_count
        FROM stock_stores s`;
    let params = [];
    if (searchQ) { sql += ' WHERE (s.store_no LIKE ? OR s.store_name LIKE ? OR s.branch_name LIKE ?)'; const l = `%${searchQ.trim()}%`; params = [l, l, l]; }
    sql += ' ORDER BY s.id DESC';
    const rows = await all(db, sql, params);
    const created = [], counted = [];
    let tsc = 0, tss = 0, tcc = 0, tcs = 0, tcq = 0, tci = 0;
    for (const r of rows) {
        const cq = num(r.counted_qty);
        tss += num(r.system_sale); tsc += num(r.system_cost); tcc += num(r.counted_cost); tcs += num(r.counted_sale); tcq += cq; tci += Math.trunc(num(r.counted_items));
        if (cq > 0 || ['in_progress', 'completed'].includes(r.status)) counted.push(r);
        created.push(r);
    }
    return {
        created_stores: created, counted_stores: counted,
        summary: {
            total_stores: rows.length, total_active_counted: counted.length, total_counted_items: tci,
            total_counted_qty: r2(tcq), total_system_cost: r2(tsc), total_system_sale: r2(tss),
            total_counted_cost: r2(tcc), total_counted_sale: r2(tcs), diff_cost: r2(tcc - tsc), diff_sale: r2(tcs - tss)
        }
    };
}

export async function createNewStore(db, storeName, branchName = 'الفرع الرئيسي', userName = 'المسؤول') {
    const name = String(storeName || '').trim();
    if (!name) return { success: false, message: 'يُرجى إدخال اسم الاستور' };
    const last = await first(db, 'SELECT id FROM stock_stores ORDER BY id DESC LIMIT 1');
    const storeNo = `ST-${String(last ? last.id + 1 : 1).padStart(3, '0')}`;
    const m = await run(db, "INSERT INTO stock_stores (store_no, store_name, branch_name, status, created_by) VALUES (?, ?, ?, 'new', ?)",
        [storeNo, name, branchName || 'الفرع الرئيسي', userName]);
    return { success: true, store_id: m.last_row_id, store_no: storeNo, store_name: name, message: 'تم إنشاء الاستور بنجاح' };
}

export async function updateStore(db, storeNo, storeName, branchName) {
    await run(db, 'UPDATE stock_stores SET store_name = ?, branch_name = ? WHERE store_no = ?', [String(storeName).trim(), String(branchName).trim(), String(storeNo).trim()]);
    return { success: true, message: 'تم تحديث بيانات الاستور بنجاح' };
}

export async function deleteStore(db, storeNo) {
    storeNo = String(storeNo || '').trim();
    if (!storeNo) return { success: false, message: 'رقم الاستور غير صالح' };
    await db.batch([
        db.prepare('DELETE FROM stocktake_entries WHERE store_no = ?').bind(storeNo),
        db.prepare('DELETE FROM stocktake_scanned_serials WHERE store_no = ?').bind(storeNo),
        db.prepare('DELETE FROM inventory_records WHERE store_no = ?').bind(storeNo),
        db.prepare('DELETE FROM stock_stores WHERE store_no = ?').bind(storeNo),
    ]);
    let nextNo, nextName;
    if ((await first(db, 'SELECT COUNT(*) AS cnt FROM stock_stores')).cnt === 0) {
        await run(db, MAIN_STORE_SQL); nextNo = 'ST-001'; nextName = 'الاستور الرئيسي';
    } else {
        const n = await first(db, 'SELECT store_no, store_name FROM stock_stores ORDER BY id ASC LIMIT 1');
        nextNo = n.store_no; nextName = n.store_name;
    }
    return { success: true, message: `تم حذف الاستور (${storeNo}) بالكامل وجميع بياناته بنجاح`, next_store_no: nextNo, next_store_name: nextName, stores_data: await getAllStores(db) };
}

export async function resetAllStocktake(db) {
    await db.batch(['DELETE FROM inventory_records', 'DELETE FROM stocktake_entries', 'DELETE FROM stocktake_scanned_serials', 'DELETE FROM stock_stores', MAIN_STORE_SQL].map(s => db.prepare(s)));
    return {
        success: true, message: 'تم تصفير ومسح جميع بيانات وتجارب الجرد بالكامل، النظام نظيف تماماً للبدء برفع المخزون الحقيقي.',
        store_no: 'ST-001', store_name: 'الاستور الرئيسي', stores_data: await getAllStores(db)
    };
}

async function storeStats(db, storeNo) {
    const [act, sys, ser] = await Promise.all([
        first(db, `SELECT COUNT(DISTINCT product_code) AS total_products, COUNT(*) AS total_lines, COALESCE(SUM(counted_qty), 0) AS total_qty,
            COALESCE(SUM(counted_qty * cost_price), 0) AS total_counted_cost, COALESCE(SUM(counted_qty * selling_price), 0) AS total_counted_sale,
            COALESCE(SUM(CASE WHEN is_new_batch = 1 THEN 1 ELSE 0 END), 0) AS new_batches_count FROM stocktake_entries WHERE store_no = ?`, [storeNo]),
        first(db, `SELECT COALESCE(SUM(system_qty), 0) AS total_sys_qty, COALESCE(SUM(system_qty * cost_price), 0) AS total_sys_cost,
            COALESCE(SUM(system_qty * selling_price), 0) AS total_sys_sale FROM inventory_records WHERE store_no = ?`, [storeNo]),
        first(db, 'SELECT COUNT(*) AS cnt FROM stocktake_scanned_serials WHERE store_no = ?', [storeNo]),
    ]);
    return { act, sys, ser };
}

// إثراء بنود الجرد بأسماء وأسعار كرت الصنف (استعلام واحد بدل استعلام لكل بند)
async function enrichEntries(db, items) {
    const codes = [...new Set(items.map(i => String(i.product_code || '').trim()).filter(Boolean))];
    const prods = codes.length ? await allIn(db, 'SELECT code, name_en, name, cost_price, selling_price, unit_price FROM products WHERE code IN ({ph})', [], codes) : [];
    const pm = Object.fromEntries(prods.map(p => [p.code, p]));
    for (const it of items) {
        const pr = pm[String(it.product_code || '').trim()];
        if (pr) {
            if (pr.name_en) it.product_name = pr.name_en;
            else if (!it.product_name && pr.name) it.product_name = pr.name;
            if ((!it.cost_price || num(it.cost_price) === 0) && pr.cost_price) it.cost_price = num(pr.cost_price);
            if (!it.selling_price || num(it.selling_price) === 0) { const sp = pr.selling_price || pr.unit_price; if (sp) it.selling_price = num(sp); }
        }
        if (it.batch_number) it.batch_number = up(it.batch_number);
    }
    return items;
}

export async function getStoreStocktakeDetails(db, storeNo = 'ST-001', searchQuery = '') {
    storeNo = await resolveValidStoreNo(db, storeNo);
    const storeInfo = await first(db, 'SELECT * FROM stock_stores WHERE store_no = ?', [storeNo]);
    let sql = 'SELECT * FROM stocktake_entries WHERE store_no = ?';
    const params = [storeNo];
    if (searchQuery) {
        const l = `%${searchQuery.trim()}%`;
        sql += ' AND (product_code LIKE ? OR product_name LIKE ? OR barcode LIKE ? OR gtin LIKE ? OR batch_number LIKE ?)';
        params.push(l, l, l, l, l);
    }
    const items = await all(db, sql + ' ORDER BY id DESC', params);
    await enrichEntries(db, items);

    // استكمال التكلفة/البيع/الباتش/الصلاحية/الرصيد الناقصة من سجلات المخزون (كما في بايثون)
    const needInv = items.filter(it => !it.cost_price || num(it.cost_price) === 0 || !it.selling_price || num(it.selling_price) === 0
        || !it.batch_number || !it.expiry_date || !it.system_qty || num(it.system_qty) === 0);
    if (needInv.length) {
        const codes = [...new Set(needInv.map(i => i.product_code))];
        const inv = await allIn(db, 'SELECT * FROM inventory_records WHERE product_code IN ({ph}) ORDER BY id DESC', [], codes);
        const byCode = {};
        for (const r of inv) (byCode[r.product_code] ||= []).push(r);
        // ملاحظة: في بايثون هذا الاستكمال للعرض فقط (لا يُحفظ لأن الدالة تغلق الاتصال بدون commit)
        for (const it of needInv) {
            const recs = byCode[it.product_code] || [];
            if (!it.cost_price || num(it.cost_price) === 0) { const r = recs.find(x => num(x.cost_price) > 0); if (r) it.cost_price = num(r.cost_price); }
            if (!it.selling_price || num(it.selling_price) === 0) { const r = recs.find(x => num(x.selling_price) > 0); if (r) it.selling_price = num(r.selling_price); }
            if (!it.batch_number || !it.expiry_date || !it.system_qty || num(it.system_qty) === 0) {
                const withBatch = recs.filter(x => x.batch_number !== '' && x.batch_number !== null);
                const invRow = withBatch.find(x => x.store_no === storeNo) || withBatch[0];
                if (invRow) {
                    const b = up(it.batch_number || invRow.batch_number || '');
                    const exp = it.expiry_date || invRow.expiry_date || '';
                    const sq = (it.system_qty && num(it.system_qty) > 0) ? it.system_qty : num(invRow.system_qty);
                    it.batch_number = b; it.expiry_date = exp; it.system_qty = sq;
                }
            }
            if (it.batch_number) it.batch_number = up(it.batch_number);
        }
    }

    const { act, sys, ser } = await storeStats(db, storeNo);
    const sysCost = r2(sys?.total_sys_cost), sysSale = r2(sys?.total_sys_sale);
    const actCost = r2(items.reduce((s, it) => s + num(it.counted_qty) * num(it.cost_price), 0));
    const actSale = r2(items.reduce((s, it) => s + num(it.counted_qty) * num(it.selling_price), 0));
    return {
        store: storeInfo || { store_no: storeNo, store_name: 'الاستور الرئيسي' },
        items,
        stats: {
            store_no: storeNo, counted_products: act?.total_products || 0, counted_lines: act?.total_lines || 0,
            counted_qty: r2(act?.total_qty), system_qty: r2(sys?.total_sys_qty), system_cost: sysCost, system_sale: sysSale,
            counted_cost: actCost, counted_sale: actSale, diff_cost: r2(actCost - sysCost), diff_sale: r2(actSale - sysSale),
            new_batches_count: act?.new_batches_count || 0, scanned_serials_count: ser?.cnt || 0
        }
    };
}

export async function searchStoreStocktakeItems(db, storeNo = 'ST-001', query = '', matchMode = 'start') {
    const rawQ = String(query || '').replace(/^\s+/, '');
    const qTrim = rawQ.trim();
    const isContains = ['contains', 'generalized', 'all', 'true', '1'].includes(String(matchMode || '').toLowerCase());
    const resolved = await resolveValidStoreNo(db, storeNo);
    const storeRow = await first(db, 'SELECT * FROM stock_stores WHERE store_no = ?', [resolved]);
    const storeDict = storeRow || { store_no: resolved, store_name: 'الاستور الرئيسي', status: 'new' };
    const storeStatus = String(storeDict.status || 'new').trim().toLowerCase();
    const { act, sys, ser } = await storeStats(db, resolved);
    const stats = {
        store_no: resolved, counted_products: act?.total_products || 0, counted_lines: act?.total_lines || 0,
        counted_qty: r2(act?.total_qty), system_qty: r2(sys?.total_sys_qty), system_cost: r2(sys?.total_sys_cost), system_sale: r2(sys?.total_sys_sale),
        counted_cost: r2(act?.total_counted_cost), counted_sale: r2(act?.total_counted_sale),
        diff_cost: r2(num(act?.total_counted_cost) - num(sys?.total_sys_cost)), diff_sale: r2(num(act?.total_counted_sale) - num(sys?.total_sys_sale)),
        new_batches_count: act?.new_batches_count || 0, scanned_serials_count: ser?.cnt || 0
    };
    if (!qTrim) {
        const rows = await enrichEntries(db, await all(db, 'SELECT * FROM stocktake_entries WHERE store_no = ? ORDER BY id DESC', [resolved]));
        const sd = { store: storeDict, items: rows, stats };
        return { success: true, query: '', store_no: resolved, store: storeDict, items: rows, product_summaries: [], store_details: sd };
    }
    let qrGtin = '', qrBatch = '';
    const parsed = parseQrCode(qTrim);
    const qd = parsed.data || {};
    if (parsed.success && (qd.gtin || qd.batch || parsed.gtin)) {
        const rawG = qd.gtin || parsed.gtin || '';
        qrGtin = cleanBarcodePreserveZeros(extractCleanGtin(rawG) || rawG);
        qrBatch = up(qd.batch || parsed.batch_number || '');
    }
    const effRaw = qrGtin || rawQ;
    const matched = {}, ordered = [];
    if (effRaw.trim()) {
        const { whereSql, params, orderParams, ftsVariants } = buildProductSearchWhere(effRaw, matchMode);
        const prods = await runProductQuery(db, 'SELECT DISTINCT p.* FROM products p LEFT JOIN product_barcodes pb ON p.code = pb.product_code',
            whereSql, params, `${PRODUCT_ORDER_SQL} LIMIT 80`, orderParams, ftsVariants);
        await attachBarcodesBulk(db, prods);
        for (const p of prods) if (!matched[p.code]) { matched[p.code] = p; ordered.push(p.code); }
    }
    const stPat = isContains ? `%${qTrim}%` : `${qTrim}%`;
    const stBatchPat = (isContains || qrBatch) ? `%${qrBatch || qTrim.toUpperCase()}%` : `${qTrim.toUpperCase()}%`;
    const directRows = await all(db, `SELECT * FROM stocktake_entries WHERE store_no = ? AND (UPPER(TRIM(COALESCE(batch_number, ''))) LIKE ? OR product_code LIKE ? OR product_name LIKE ? OR barcode LIKE ? OR gtin LIKE ?) ORDER BY id DESC`,
        [resolved, stBatchPat, stPat, stPat, stPat, stPat]);
    const targets = [...ordered];
    for (const sr of directRows) { const c = String(sr.product_code || '').trim(); if (c && !matched[c] && !targets.includes(c)) targets.push(c); }
    const missing = targets.filter(c => !matched[c]);
    if (missing.length) {
        const extra = await allIn(db, 'SELECT * FROM products WHERE code IN ({ph})', [], missing);
        await attachBarcodesBulk(db, extra);
        for (const p of extra) matched[p.code] = p;
    }
    const byId = {};
    for (const sr of directRows) { if (qrBatch && up(sr.batch_number) !== qrBatch) continue; byId[sr.id] = sr; }
    if (targets.length) {
        for (const sd of await allIn(db, 'SELECT * FROM stocktake_entries WHERE store_no = ? AND product_code IN ({ph}) ORDER BY id DESC', [resolved], targets)) {
            if (qrBatch && up(sd.batch_number) !== qrBatch) continue;
            byId[sd.id] = sd;
        }
    }
    const matchingItems = Object.values(byId).sort((a, b) => b.id - a.id);
    const byCode = {};
    for (const sd of matchingItems) {
        const pc = String(sd.product_code || '').trim();
        const pr = matched[pc];
        if (pr) { if (pr.name_en) sd.product_name = pr.name_en; else if (!sd.product_name && pr.name) sd.product_name = pr.name; }
        if (sd.batch_number) sd.batch_number = up(sd.batch_number);
        (byCode[pc] ||= []).push(sd);
    }
    const invByCode = {};
    if (targets.length) {
        for (const ir of await allIn(db, 'SELECT product_code, COALESCE(SUM(system_qty), 0) AS sys_q FROM inventory_records WHERE store_no = ? AND product_code IN ({ph}) GROUP BY product_code', [resolved], targets))
            invByCode[ir.product_code] = r4(ir.sys_q);
    }
    const countedS = [], uncountedS = [];
    for (const pc of targets) {
        const pr = matched[pc] || {};
        const rows = byCode[pc] || [];
        const r0 = rows[0] || {};
        const s = {
            product_code: pc,
            name_en: pr.name_en || pr.name || r0.product_name || '',
            name_ar: pr.name_ar || '', scientific_name: pr.scientific_name || '', company: pr.company || '',
            barcode: ((pr.barcode_list && pr.barcode_list.length ? pr.barcode_list : [pr.barcode || ''])[0]) || r0.barcode || '',
            gtin: ((pr.gtin_list && pr.gtin_list.length ? pr.gtin_list : [pr.gtin || ''])[0]) || r0.gtin || '',
            selling_price: num(pr.selling_price || pr.unit_price || r0.selling_price || 0),
            store_no: resolved, store_name: storeDict.store_name || resolved, store_status: storeStatus,
            is_counted_in_store: rows.length > 0,
            total_counted_qty: r4(rows.reduce((a, r) => a + num(r.counted_qty), 0)),
            entry_count: rows.length, store_system_qty: invByCode[pc] || 0,
            batch_rows: rows.map(r => ({
                entry_id: r.id, batch_number: up(r.batch_number) || '-', expiry_date: r.expiry_date || '-',
                counted_qty: r4(r.counted_qty), system_qty: r4(r.system_qty), is_new_batch: Math.trunc(num(r.is_new_batch)), updated_at: r.updated_at || ''
            }))
        };
        (rows.length ? countedS : uncountedS).push(s);
    }
    return {
        success: true, query: qTrim, store_no: resolved, store: storeDict, items: matchingItems,
        product_summaries: [...countedS, ...uncountedS].slice(0, 30),
        counted_matches_count: countedS.length, uncounted_matches_count: uncountedS.length,
        qr_gtin: qrGtin, qr_batch: qrBatch, store_details: { store: storeDict, items: matchingItems, stats }
    };
}

const INSERT_ENTRY = `INSERT INTO stocktake_entries (product_code, product_name, barcode, gtin, batch_number, expiry_date,
    system_qty, counted_qty, cost_price, selling_price, is_new_batch, item_type, store_no, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`;

export async function scanItemToStore(db, rawCode, storeNo = 'ST-001', forceDirect = false, productCode = '') {
    const raw = String(rawCode || '').trim();
    if (!raw) return { success: false, message: 'لم يتم إدخال أو مسح أي كود' };
    storeNo = await resolveValidStoreNo(db, storeNo);
    const explicit = String(productCode || '').trim();
    let prod = null, parsed = {}, gtin = '', serial = '', batch = '', expiry = '';
    if (explicit) {
        prod = await getProductByCode(db, cleanNumericCode(explicit)) || await getProductByCode(db, explicit);
        if (prod) gtin = prod.gtin || prod.barcode || '';
    } else {
        parsed = parseQrCode(raw);
        const pd = parsed.success ? (parsed.data || {}) : {};
        gtin = pd.gtin || '';
        serial = up(pd.serial || '');
        batch = up(pd.batch || '');
        expiry = pd.expiry || '';
        if (!gtin) gtin = extractCleanGtin(raw) || cleanBarcodePreserveZeros(raw);
        const cn = cleanNumericCode(raw);
        if (cn && cn.length <= 8 && isDigitStr(raw)) prod = await getProductByCode(db, cn);
        if (!prod && gtin) prod = await findProductByGtinOrBarcode(db, gtin);
        if (!prod) prod = await getProductByCode(db, cleanNumericCode(raw));
        if (!prod) prod = await findProductByGtinOrBarcode(db, cleanBarcodePreserveZeros(raw));
    }
    if (!prod) return { success: false, message: `الصنف غير مسجل في بطاقات الأصناف (الكود: ${gtin || raw})`, is_unregistered: true, raw };

    const pCode = prod.code;
    const pName = prod.name_en || prod.name || '';
    let sellingPrice = num(prod.selling_price || prod.unit_price || prod.price || 0);
    let costPrice = num(prod.cost_price || 0);
    const itemType = prod.item_type || 'medicine';
    const pBarcode = prod.barcode || '';

    if (serial) {
        const dup = await first(db, 'SELECT id FROM stocktake_scanned_serials WHERE serial_number = ? AND product_code = ? AND store_no = ?', [serial, pCode, storeNo]);
        if (dup) return { success: false, is_duplicate_serial: true, message: `⚠️ تنبيه: العبوة ذات السيريال (${serial}) تم مسحها مسبقاً! تم منع تكرار الحساب.`, serial, product_code: pCode, product_name: pName };
    }
    const cPcode = cleanNumericCode(pCode);
    const gCode = gtin || '';
    let inv = await all(db, `SELECT * FROM inventory_records WHERE (product_code = ? OR product_code = ? OR barcode = ? OR barcode = ?) AND store_no = ? ORDER BY expiry_date ASC, id ASC`,
        [pCode, cPcode, pBarcode, gCode, storeNo]);
    if (!inv.length) inv = await all(db, 'SELECT * FROM inventory_records WHERE (product_code = ? OR product_code = ? OR barcode = ? OR barcode = ?) ORDER BY expiry_date ASC, id ASC',
        [pCode, cPcode, pBarcode, gCode]);
    for (const ir of inv) {
        if (costPrice === 0 && ir.cost_price && num(ir.cost_price) > 0) costPrice = num(ir.cost_price);
        if (sellingPrice === 0 && ir.selling_price && num(ir.selling_price) > 0) sellingPrice = num(ir.selling_price);
    }
    const is2d = Boolean(parsed.success && (batch || serial));

    if (!is2d && !forceDirect) {
        const bm = new Map();
        for (const ir of inv) {
            const b = up(ir.batch_number), exp = String(ir.expiry_date || '').trim(), key = `${b}\u0000${exp}`;
            if (!bm.has(key)) bm.set(key, { batch_number: b || '-', expiry_date: exp || '-', system_qty: num(ir.system_qty), counted_qty: 0, cost_price: num(ir.cost_price || costPrice), selling_price: num(ir.selling_price || sellingPrice), entry_id: null, is_new_batch: 0 });
            else bm.get(key).system_qty += num(ir.system_qty);
        }
        const st = await all(db, 'SELECT * FROM stocktake_entries WHERE (product_code = ? OR product_code = ?) AND store_no = ? ORDER BY id ASC', [pCode, cPcode, storeNo]);
        for (const s of st) {
            const b = up(s.batch_number), exp = String(s.expiry_date || '').trim(), key = `${b}\u0000${exp}`;
            if (bm.has(key)) {
                const e = bm.get(key);
                e.counted_qty = num(s.counted_qty); e.entry_id = s.id;
                if (s.cost_price) e.cost_price = num(s.cost_price);
                if (s.selling_price) e.selling_price = num(s.selling_price);
            } else bm.set(key, { batch_number: b || '-', expiry_date: exp || '-', system_qty: num(s.system_qty), counted_qty: num(s.counted_qty), cost_price: num(s.cost_price || costPrice), selling_price: num(s.selling_price || sellingPrice), entry_id: s.id, is_new_batch: s.is_new_batch || 1 });
        }
        const d = new Date();
        const autoBatch = `B${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}-01`;
        if (!bm.size) {
            bm.set('-\u0000-', { batch_number: autoBatch, expiry_date: '', system_qty: 0, counted_qty: 0, cost_price: costPrice, selling_price: sellingPrice, entry_id: null, is_new_batch: 1, is_manual_batch: 1, requires_manual_entry: true });
        } else {
            for (const b of bm.values()) {
                const bn = String(b.batch_number || '').trim(), ex = String(b.expiry_date || '').trim();
                const emptyB = ['-', '', 'None'].includes(bn), emptyE = ['-', '', 'None'].includes(ex);
                if ((emptyB && emptyE) || b.is_new_batch) {
                    if (emptyB) b.batch_number = autoBatch;
                    if (emptyE) b.expiry_date = '';
                    b.is_manual_batch = 1; b.requires_manual_entry = true;
                }
            }
        }
        return {
            success: true, requires_batch_entry: true,
            product: { code: pCode, name: pName, barcode: pBarcode, gtin: gtin || pBarcode, item_type: itemType, cost_price: costPrice, selling_price: sellingPrice },
            batches: [...bm.values()], store_no: storeNo
        };
    }

    let targetId = null, tBatch = batch, tExpiry = expiry, tSys = 0, newQty = 1, isNew = 0;
    if (batch) {
        const mInv = inv.find(r => up(r.batch_number) === batch.trim().toUpperCase()) || null;
        const er = await first(db, 'SELECT * FROM stocktake_entries WHERE product_code = ? AND store_no = ? AND UPPER(TRIM(batch_number)) = ? ORDER BY id DESC LIMIT 1', [pCode, storeNo, batch]);
        if (er) {
            targetId = er.id; newQty = num(er.counted_qty) + 1;
            tSys = num(er.system_qty || (mInv ? mInv.system_qty : 0));
            tExpiry = er.expiry_date || expiry || (mInv ? mInv.expiry_date : '');
            isNew = er.is_new_batch;
            await run(db, `UPDATE stocktake_entries SET counted_qty = ?, system_qty = CASE WHEN system_qty = 0 THEN ? ELSE system_qty END,
                expiry_date = CASE WHEN expiry_date = '' THEN ? ELSE expiry_date END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [newQty, tSys, tExpiry, targetId]);
        } else {
            newQty = 1; tSys = mInv ? num(mInv.system_qty) : 0; isNew = mInv ? 0 : 1;
            tExpiry = expiry || (mInv ? mInv.expiry_date : '');
            const rc = (mInv && mInv.cost_price) ? num(mInv.cost_price) : costPrice;
            const rs = (mInv && mInv.selling_price) ? num(mInv.selling_price) : sellingPrice;
            targetId = (await run(db, INSERT_ENTRY, [pCode, pName, pBarcode, gtin, batch, tExpiry, tSys, newQty, rc, rs, isNew, itemType, storeNo])).last_row_id;
        }
        for (const ir of inv) {
            const bk = up(ir.batch_number);
            if (bk && bk !== batch.trim().toUpperCase()) {
                const ex = await first(db, 'SELECT id FROM stocktake_entries WHERE product_code = ? AND store_no = ? AND UPPER(TRIM(batch_number)) = ?', [pCode, storeNo, bk]);
                if (!ex) await run(db, INSERT_ENTRY, [pCode, pName, pBarcode, gtin, bk, ir.expiry_date || '', num(ir.system_qty), 0, num(ir.cost_price || costPrice), num(ir.selling_price || sellingPrice), 0, itemType, storeNo]);
            }
        }
    } else if (inv.length) {
        const list = [];
        for (const ir of inv) {
            const b = up(ir.batch_number);
            const row = await first(db, `SELECT id, counted_qty, system_qty, batch_number, expiry_date, cost_price, selling_price FROM stocktake_entries
                WHERE product_code = ? AND store_no = ? AND (batch_number = ? OR (batch_number = '' AND ? = '')) ORDER BY id ASC LIMIT 1`, [pCode, storeNo, b, b]);
            if (!row) {
                const id = (await run(db, INSERT_ENTRY, [pCode, pName, pBarcode, gtin, b, ir.expiry_date || '', num(ir.system_qty), 0, num(ir.cost_price || costPrice), num(ir.selling_price || sellingPrice), 0, itemType, storeNo])).last_row_id;
                list.push({ id, counted_qty: 0, system_qty: num(ir.system_qty), batch_number: b, expiry_date: ir.expiry_date || '', cost_price: num(ir.cost_price || costPrice), selling_price: num(ir.selling_price || sellingPrice) });
            } else list.push(row);
        }
        const cand = list.find(r => num(r.counted_qty) < num(r.system_qty)) || list[list.length - 1];
        targetId = cand.id; newQty = num(cand.counted_qty) + 1;
        tBatch = cand.batch_number || ''; tExpiry = cand.expiry_date || ''; tSys = num(cand.system_qty);
        costPrice = num(cand.cost_price || costPrice); sellingPrice = num(cand.selling_price || sellingPrice);
        await run(db, 'UPDATE stocktake_entries SET counted_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newQty, targetId]);
    } else {
        const er = await first(db, "SELECT * FROM stocktake_entries WHERE product_code = ? AND store_no = ? AND (batch_number = '' OR batch_number IS NULL) ORDER BY id DESC LIMIT 1", [pCode, storeNo]);
        if (er) {
            targetId = er.id; newQty = num(er.counted_qty) + 1;
            await run(db, 'UPDATE stocktake_entries SET counted_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [newQty, targetId]);
        } else {
            newQty = 1;
            targetId = (await run(db, INSERT_ENTRY, [pCode, pName, pBarcode, gtin, '', '', 0, newQty, costPrice, sellingPrice, 0, itemType, storeNo])).last_row_id;
        }
    }
    await run(db, "UPDATE stock_stores SET status = 'in_progress', counted_at = CURRENT_TIMESTAMP WHERE store_no = ?", [storeNo]);
    if (serial) await run(db, 'INSERT OR IGNORE INTO stocktake_scanned_serials (serial_number, product_code, batch_number, store_no, scanned_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)', [serial, pCode, batch, storeNo]);
    const storeData = await getStoreStocktakeDetails(db, storeNo);
    const msg = `تم جرد: ${pName} | باتش: ${tBatch || '-'} | صلاحية: ${tExpiry || '-'} | رصيد المخزون: ${pyf(tSys)} | الفعلي: ${Math.trunc(newQty)} | بيع: ${pyf(sellingPrice)} | تكلفة: ${pyf(costPrice)}` + (isNew ? ' (⚠️ باتش جديد)' : '');
    return {
        success: true, requires_batch_entry: false, direct_scan: true, entry_id: targetId, product_code: pCode, product_name: pName,
        batch_number: tBatch, expiry_date: tExpiry, serial, system_qty: tSys, counted_qty: newQty, cost_price: costPrice, selling_price: sellingPrice,
        is_new_batch: Boolean(isNew), message: msg, store_details: storeData
    };
}

export async function saveStockBatchCount(db, { store_no, product_code, batch_number, expiry_date, counted_qty, system_qty = 0, cost_price = 0, selling_price = 0, entry_id = null }) {
    const storeNo = await resolveValidStoreNo(db, store_no);
    const prod = await getProductByCode(db, cleanNumericCode(product_code));
    const pName = prod ? (prod.name_en || prod.name || '') : '';
    const itemType = prod ? (prod.item_type || 'medicine') : 'medicine';
    let b = decodeArabicKeyboardLayout(String(batch_number || '').trim()).toUpperCase();
    if (b === '-') b = '';
    let exp = String(expiry_date || '').trim();
    if (exp === '-') exp = '';
    else if (exp) { const n = parseExpiryDate(exp); if (n) exp = n; }
    const counted = num(counted_qty);
    const inv = await first(db, "SELECT * FROM inventory_records WHERE product_code = ? AND store_no = ? AND (batch_number = ? OR (batch_number = '' AND ? = '')) LIMIT 1", [product_code, storeNo, b, b]);
    const isNew = inv ? 0 : (b ? 1 : 0);
    const sysVal = inv ? num(inv.system_qty) : num(system_qty);
    if (!exp && inv && inv.expiry_date) exp = inv.expiry_date;
    const costVal = (inv && inv.cost_price) ? num(inv.cost_price) : num(cost_price || (prod ? prod.cost_price : 0) || 0);
    const saleVal = (inv && inv.selling_price) ? num(inv.selling_price) : num(selling_price || (prod ? prod.selling_price : 0) || 0);
    let row = null;
    if (entry_id) row = await first(db, 'SELECT id FROM stocktake_entries WHERE id = ? AND store_no = ?', [entry_id, storeNo]);
    if (!row) row = await first(db, "SELECT id FROM stocktake_entries WHERE product_code = ? AND store_no = ? AND (batch_number = ? OR (batch_number = '' AND ? = '')) ORDER BY id DESC LIMIT 1", [product_code, storeNo, b, b]);
    let eid;
    if (row) {
        eid = row.id;
        await run(db, `UPDATE stocktake_entries SET counted_qty = ?, batch_number = CASE WHEN ? != '' THEN ? ELSE batch_number END,
            expiry_date = CASE WHEN ? != '' THEN ? ELSE expiry_date END, system_qty = CASE WHEN system_qty = 0 THEN ? ELSE system_qty END,
            cost_price = CASE WHEN cost_price = 0 THEN ? ELSE cost_price END, selling_price = CASE WHEN selling_price = 0 THEN ? ELSE selling_price END,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [counted, b, b, exp, exp, sysVal, costVal, saleVal, eid]);
    } else {
        const bc = prod ? (prod.barcode || '') : '';
        eid = (await run(db, INSERT_ENTRY, [product_code, pName, bc, bc, b, exp, sysVal, counted, costVal, saleVal, isNew, itemType, storeNo])).last_row_id;
    }
    await run(db, "UPDATE stock_stores SET status = 'in_progress', counted_at = CURRENT_TIMESTAMP WHERE store_no = ?", [storeNo]);
    return { success: true, requires_batch_entry: false, direct_scan: true, entry_id: eid, message: `تم حفظ: ${pName} | تشغيلة: ${b || '-'} | الفعلي: ${pyf(counted)}`, store_details: await getStoreStocktakeDetails(db, storeNo) };
}

export async function updateEntryQuantity(db, entryId, newQty, storeNo) {
    storeNo = await resolveValidStoreNo(db, storeNo);
    await run(db, 'UPDATE stocktake_entries SET counted_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND store_no = ?', [num(newQty), entryId, storeNo]);
    return { success: true, store_details: await getStoreStocktakeDetails(db, storeNo) };
}

export async function deleteEntryItem(db, entryId, storeNo) {
    storeNo = await resolveValidStoreNo(db, storeNo);
    const r = await first(db, 'SELECT product_code, batch_number FROM stocktake_entries WHERE id = ? AND store_no = ?', [entryId, storeNo]);
    const stmts = [];
    if (r) stmts.push(db.prepare('DELETE FROM stocktake_scanned_serials WHERE product_code = ? AND batch_number = ? AND store_no = ?').bind(r.product_code, r.batch_number, storeNo));
    stmts.push(db.prepare('DELETE FROM stocktake_entries WHERE id = ? AND store_no = ?').bind(entryId, storeNo));
    await db.batch(stmts);
    return { success: true, store_details: await getStoreStocktakeDetails(db, storeNo) };
}

export async function bulkDeleteEntries(db, ids, storeNo = 'ST-001') {
    if (!ids || !ids.length) return { success: false, message: 'لم يتم تحديد أي أصناف للحذف' };
    storeNo = await resolveValidStoreNo(db, storeNo);
    const rows = await allIn(db, 'SELECT product_code, batch_number FROM stocktake_entries WHERE id IN ({ph}) AND store_no = ?', [], ids, [storeNo]);
    const stmts = rows.map(r => db.prepare('DELETE FROM stocktake_scanned_serials WHERE product_code = ? AND batch_number = ? AND store_no = ?').bind(r.product_code, r.batch_number, storeNo));
    for (let i = 0; i < ids.length; i += 90) {
        const part = ids.slice(i, i + 90);
        stmts.push(db.prepare(`DELETE FROM stocktake_entries WHERE id IN (${part.map(() => '?').join(',')}) AND store_no = ?`).bind(...part, storeNo));
    }
    await db.batch(stmts);
    return { success: true, message: `تم حذف ${ids.length} صنف بنجاح`, store_details: await getStoreStocktakeDetails(db, storeNo) };
}

export async function editStocktakeEntry(db, entryId, updates, storeNo = 'ST-001') {
    storeNo = await resolveValidStoreNo(db, storeNo);
    const row = await first(db, 'SELECT * FROM stocktake_entries WHERE id = ? AND store_no = ?', [entryId, storeNo]);
    if (!row) return { success: false, message: 'الصنف غير موجود بالجرد' };
    const u = updates || {};
    const get = (k, d) => (k in u ? u[k] : d);
    const counted = num(get('counted_qty', row.counted_qty));
    const batch = decodeArabicKeyboardLayout(String(get('batch_number', row.batch_number || '')).trim()).toUpperCase();
    const expiry = String(get('expiry_date', row.expiry_date || '')).trim();
    const cost = num(get('cost_price', row.cost_price || 0));
    const sale = num(get('selling_price', row.selling_price || 0));
    const inv = await first(db, 'SELECT * FROM inventory_records WHERE product_code = ? AND store_no = ? AND batch_number = ? LIMIT 1', [row.product_code, storeNo, batch]);
    const isNew = inv ? 0 : (batch ? 1 : 0);
    await run(db, 'UPDATE stocktake_entries SET counted_qty = ?, batch_number = ?, expiry_date = ?, cost_price = ?, selling_price = ?, is_new_batch = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND store_no = ?',
        [counted, batch, expiry, cost, sale, isNew, entryId, storeNo]);
    return { success: true, message: 'تم تعديل بيانات الصنف بنجاح', store_details: await getStoreStocktakeDetails(db, storeNo) };
}

export async function clearInventoryRecords(db, storeNo = 'ST-001', clearAll = false) {
    const clean = String(storeNo || '').trim();
    const wipeAll = ['DELETE FROM inventory_records', 'UPDATE stocktake_entries SET system_qty = 0', 'DELETE FROM stocktake_entries WHERE counted_qty = 0 OR counted_qty IS NULL'];
    let msg, target;
    if (clearAll || clean.toUpperCase() === 'ALL') {
        await db.batch(wipeAll.map(s => db.prepare(s)));
        msg = 'تم حذف وتصفير رصيد المخزون السابق بالكامل لجميع الاستورات بنجاح.'; target = 'ST-001';
    } else {
        target = await resolveValidStoreNo(db, clean);
        const cnt = (await first(db, 'SELECT COUNT(*) AS c FROM inventory_records WHERE store_no = ?', [target])).c;
        if (cnt === 0) {
            const total = (await first(db, 'SELECT COUNT(*) AS c FROM inventory_records')).c;
            if (total > 0) { await db.batch(wipeAll.map(s => db.prepare(s))); msg = `تم تصفير وحذف رصيد المخزون العام السابق (${total} صنف) بنجاح.`; }
            else msg = `رصيد المخزون السابق فارغ بالفعل للاستور (${target}).`;
        } else {
            await db.batch([
                db.prepare('DELETE FROM inventory_records WHERE store_no = ?').bind(target),
                db.prepare('UPDATE stocktake_entries SET system_qty = 0 WHERE store_no = ?').bind(target),
                db.prepare('DELETE FROM stocktake_entries WHERE store_no = ? AND (counted_qty = 0 OR counted_qty IS NULL)').bind(target),
            ]);
            msg = `تم حذف رصيد المخزون السابق (${cnt} صنف) للاستور (${target}) بنجاح.`;
        }
    }
    return { success: true, message: msg, store_details: await getStoreStocktakeDetails(db, target) };
}

export async function clearStoreStocktake(db, storeNo) {
    await db.batch([
        db.prepare('DELETE FROM stocktake_entries WHERE store_no = ?').bind(storeNo),
        db.prepare('DELETE FROM stocktake_scanned_serials WHERE store_no = ?').bind(storeNo),
        db.prepare("UPDATE stock_stores SET status = 'new' WHERE store_no = ?").bind(storeNo),
    ]);
    return { success: true, store_details: await getStoreStocktakeDetails(db, storeNo) };
}

export async function commitStoresStocktake(db, storeNos = null) {
    if (!storeNos || !storeNos.length || storeNos.includes('ALL')) storeNos = (await all(db, 'SELECT store_no FROM stock_stores')).map(r => r.store_no);
    if (!storeNos.length) return { success: false, message: 'لم يتم تحديد أي استور للترحيل والتعميد.' };
    const settled = []; let adopted = 0;
    for (const sn of storeNos) {
        const entries = await all(db, 'SELECT * FROM stocktake_entries WHERE store_no = ? AND counted_qty > 0', [sn]);
        // دفعة واحدة (معاملة ذرية في D1): لا يُمسح المخزون القديم إلا مع اعتماد الجديد
        const stmts = [db.prepare('DELETE FROM inventory_records WHERE store_no = ?').bind(sn)];
        for (const e of entries) {
            stmts.push(db.prepare(`INSERT INTO inventory_records (product_code, product_name, barcode, batch_number, expiry_date, system_qty, cost_price, selling_price, item_type, store_no, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).bind(e.product_code, e.product_name || '', e.barcode || e.gtin || '', up(e.batch_number), e.expiry_date || '',
                num(e.counted_qty), num(e.cost_price), num(e.selling_price), e.item_type || 'medicine', sn));
            adopted++;
        }
        stmts.push(db.prepare('UPDATE stocktake_entries SET system_qty = counted_qty, updated_at = CURRENT_TIMESTAMP WHERE store_no = ?').bind(sn));
        stmts.push(db.prepare("UPDATE stock_stores SET status = 'completed', counted_at = CURRENT_TIMESTAMP WHERE store_no = ?").bind(sn));
        await db.batch(stmts);
        settled.push(sn);
    }
    return {
        success: true, message: `تم تعميد وترحيل الجرد بنجاح لعدد ${settled.length} استور، ومسح الاستوك القديم واعتماد ${adopted} تشغيلة وبند كأرصدة جديدة للمخزون.`,
        settled_stores: settled, total_adopted_records: adopted
    };
}

export async function populateStoreFromInventory(db, storeNo = 'ST-001') {
    storeNo = await resolveValidStoreNo(db, storeNo);
    const records = await all(db, 'SELECT * FROM inventory_records WHERE store_no = ? ORDER BY id ASC', [storeNo]);
    const existing = await all(db, 'SELECT product_code, batch_number FROM stocktake_entries WHERE store_no = ?', [storeNo]);
    const have = new Set(existing.map(e => `${e.product_code}\u0000${e.batch_number ?? ''}`));
    const stmts = [];
    for (const r of records) {
        const b = up(r.batch_number);
        const key = `${r.product_code}\u0000${b}`;
        if (have.has(key)) continue;
        have.add(key);
        stmts.push(db.prepare(INSERT_ENTRY).bind(r.product_code, r.product_name || '', r.barcode || '', r.barcode || '', b, r.expiry_date || '', num(r.system_qty), 0, num(r.cost_price), num(r.selling_price), 0, r.item_type || 'medicine', storeNo));
    }
    for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
    return { success: true, message: `تم إدراج ${stmts.length} باتش/بند من رصيد المخزون في جدول الجرد بنجاح (المجموع: ${records.length} بند)`, store_details: await getStoreStocktakeDetails(db, storeNo) };
}
