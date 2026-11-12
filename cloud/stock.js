// منقول من backend/stock_manager.py (عمليات الجرد) ليعمل على Cloudflare D1 بدون الكمبيوتر.
import { all, first, run, allIn, getProductByCode, findProductByGtinOrBarcode, attachBarcodesBulk, buildProductSearchWhere, runProductQuery, PRODUCT_ORDER_SQL } from './products.js';
import { parseQrCode, extractCleanGtin, cleanBarcodePreserveZeros, cleanNumericCode, decodeArabicKeyboardLayout, parseExpiryDate, isDigitStr, pyRound } from './qr.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => pyRound(num(v), 2);
const r4 = (v) => pyRound(num(v), 4);
// تنسيق الأرقام كما تطبعها بايثون في الرسائل (2.0 بدلاً من 2)
const pyf = (v) => { const n = num(v); return Number.isInteger(n) ? n.toFixed(1) : String(n); };
const up = (v) => String(v ?? '').trim().toUpperCase();
const pidOf = (db) => Number(db.pid || 1);

// ================= حماية بيانات الجرد من الضياع =================
// سلة محذوفات الجرد: أي مسح/تصفير/حذف لبنود مجرودة ينسخها هنا أولاً (في نفس الدفعة الذرية) لاسترجاعها في أي وقت.
// جدول مرحلي لرفع المخزون: الملف يُرفع على دفعات هنا، ثم يُستبدل المخزون مرة واحدة ذرياً في النهاية،
// فلو انقطع الاتصال في منتصف الرفع يبقى المخزون القديم كما هو بدل أن يتصفر.
const ENTRY_COLS = ['id', 'product_code', 'product_name', 'barcode', 'gtin', 'batch_number', 'expiry_date', 'system_qty', 'counted_qty',
    'cost_price', 'selling_price', 'is_new_batch', 'item_type', 'store_no', 'created_at', 'updated_at'];
const INV_COLS = ['product_code', 'product_name', 'barcode', 'batch_number', 'expiry_date', 'system_qty', 'cost_price', 'selling_price', 'item_type'];
let safetyTablesReady = false;
export async function ensureSafetyTables(db) {
    if (safetyTablesReady) return;
    await db.batch([
        `CREATE TABLE IF NOT EXISTS stocktake_trash (trash_id INTEGER PRIMARY KEY AUTOINCREMENT, batch_id TEXT NOT NULL, reason TEXT, profile_id INTEGER,
            trashed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, restored INTEGER DEFAULT 0, ${ENTRY_COLS.map(c => `${c === 'id' ? 'entry_id' : c}`).join(', ')})`,
        'CREATE INDEX IF NOT EXISTS idx_trash_batch ON stocktake_trash(batch_id)',
        'CREATE INDEX IF NOT EXISTS idx_trash_store ON stocktake_trash(store_no, trashed_at)',
        `CREATE TABLE IF NOT EXISTS inventory_upload_staging (id INTEGER PRIMARY KEY AUTOINCREMENT, upload_id TEXT NOT NULL, store_no TEXT NOT NULL,
            ${INV_COLS.join(', ')}, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
        'CREATE INDEX IF NOT EXISTS idx_upload_staging ON inventory_upload_staging(upload_id)',
    ].map(s => db.prepare(s)));
    safetyTablesReady = true;
}
// فهارس مركّبة (استور + صنف): بدونها البحث عن صنف في استور كان بيقرا مخزون الاستور كله مع كل مسح
let lookupIndexesReady = false;
async function ensureLookupIndexes(db) {
    if (lookupIndexesReady) return;
    await db.batch(['CREATE INDEX IF NOT EXISTS idx_inv_store_code ON inventory_records(store_no, product_code)',
        'CREATE INDEX IF NOT EXISTS idx_inv_store_barcode ON inventory_records(store_no, barcode)'].map(s => db.prepare(s)));
    lookupIndexesReady = true;
}
// جملة تنسخ بنود الجرد المطابقة للشرط إلى السلة (تُضاف لنفس الدفعة قبل جملة الحذف)
function trashStmt(db, batchId, reason, whereSql, params) {
    const cols = ENTRY_COLS.map(c => c === 'id' ? 'entry_id' : c).join(', ');
    return db.prepare(`INSERT INTO stocktake_trash (batch_id, reason, profile_id, ${cols}) SELECT ?, ?, ?, ${ENTRY_COLS.join(', ')}
        FROM stocktake_entries WHERE (${whereSql}) AND counted_qty > 0`).bind(batchId, reason, pidOf(db), ...params);
}
const newBatchId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// استرجاع بنود جرد محذوفة من السلة (آخر عملية حذف للاستور، أو دفعة محددة)
export async function restoreTrash(db, storeNo, batchId = '') {
    await ensureSafetyTables(db);
    storeNo = await resolveValidStoreNo(db, storeNo);
    if (!batchId) {
        const last = await first(db, 'SELECT batch_id FROM stocktake_trash WHERE store_no = ? AND restored = 0 ORDER BY trash_id DESC LIMIT 1', [storeNo]);
        if (!last) return { success: false, message: 'لا توجد بنود جرد محذوفة لهذا الاستور في سلة المحذوفات.' };
        batchId = last.batch_id;
    }
    const rows = await all(db, 'SELECT * FROM stocktake_trash WHERE batch_id = ? AND store_no = ? AND restored = 0', [batchId, storeNo]);
    if (!rows.length) return { success: false, message: 'لا توجد بنود لاسترجاعها.' };
    const stmts = [];
    for (const r of rows) {
        // لو البند موجود حالياً (نفس الصنف والتشغيلة) لا نكرره: نرجّع الكمية المجرودة فقط إن كانت صفراً
        stmts.push(db.prepare(`UPDATE stocktake_entries SET counted_qty = ?, updated_at = CURRENT_TIMESTAMP
            WHERE store_no = ? AND product_code = ? AND COALESCE(batch_number, '') = ? AND COALESCE(counted_qty, 0) = 0`)
            .bind(num(r.counted_qty), storeNo, r.product_code, r.batch_number || ''));
        stmts.push(db.prepare(`INSERT INTO stocktake_entries (product_code, product_name, barcode, gtin, batch_number, expiry_date, system_qty, counted_qty,
            cost_price, selling_price, is_new_batch, item_type, store_no, created_at, updated_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
            WHERE NOT EXISTS (SELECT 1 FROM stocktake_entries WHERE store_no = ? AND product_code = ? AND COALESCE(batch_number, '') = ?)`)
            .bind(r.product_code, r.product_name || '', r.barcode || '', r.gtin || '', r.batch_number || '', r.expiry_date || '', num(r.system_qty), num(r.counted_qty),
                num(r.cost_price), num(r.selling_price), r.is_new_batch || 0, r.item_type || 'medicine', storeNo, r.created_at || null,
                storeNo, r.product_code, r.batch_number || ''));
    }
    stmts.push(db.prepare('UPDATE stocktake_trash SET restored = 1 WHERE batch_id = ? AND store_no = ?').bind(batchId, storeNo));
    stmts.push(db.prepare("UPDATE stock_stores SET status = 'in_progress' WHERE store_no = ? AND status = 'new'").bind(storeNo));
    for (let i = 0; i < stmts.length; i += 90) await db.batch(stmts.slice(i, i + 90));
    return { success: true, restored_count: rows.length, message: `تم استرجاع ${rows.length} بند جرد محذوف بنجاح.`, store_details: await getStoreStocktakeDetails(db, storeNo) };
}

export async function listTrash(db, storeNo) {
    await ensureSafetyTables(db);
    storeNo = await resolveValidStoreNo(db, storeNo);
    const batches = await all(db, `SELECT batch_id, reason, MIN(trashed_at) AS trashed_at, COUNT(*) AS items, SUM(counted_qty) AS counted_qty
        FROM stocktake_trash WHERE store_no = ? AND restored = 0 GROUP BY batch_id ORDER BY MAX(trash_id) DESC LIMIT 20`, [storeNo]);
    return { success: true, store_no: storeNo, batches };
}
// الاستور الرئيسي لكل صيدلية: الصيدلية 1 تحتفظ بالرقم ST-001 كما في النظام الأصلي، والباقي يأخذ الرقم التالي
async function createMainStore(db) {
    const pid = pidOf(db);
    let no = 'ST-001';
    if (pid !== 1 || await first(db, "SELECT 1 AS x FROM stock_stores WHERE store_no = 'ST-001'")) {
        const last = await first(db, 'SELECT MAX(id) AS m FROM stock_stores');
        const seq = await first(db, "SELECT seq FROM sqlite_sequence WHERE name = 'stock_stores'");
        no = `ST-${String(Math.max(last?.m || 0, seq?.seq || 0) + 1).padStart(3, '0')}`;
    }
    await run(db, "INSERT INTO stock_stores (store_no, store_name, branch_name, status, created_by, profile_id) VALUES (?, 'الاستور الرئيسي', 'الفرع الرئيسي', 'new', 'المسؤول', ?)", [no, pid]);
    return no;
}
export async function profileStoreNos(db) {
    return (await all(db, 'SELECT store_no FROM stock_stores WHERE profile_id = ?', [pidOf(db)])).map(r => r.store_no);
}
async function ownsStore(db, storeNo) {
    return Boolean(await first(db, 'SELECT 1 AS x FROM stock_stores WHERE store_no = ? AND profile_id = ?', [String(storeNo || '').trim(), pidOf(db)]));
}

export async function resolveValidStoreNo(db, storeNo = '') {
    const clean = String(storeNo || '').trim();
    if (clean && clean !== 'ALL') {
        const row = await first(db, 'SELECT store_no FROM stock_stores WHERE store_no = ? AND profile_id = ?', [clean, pidOf(db)]);
        if (row) return row.store_no;
    }
    const row = await first(db, 'SELECT store_no FROM stock_stores WHERE profile_id = ? ORDER BY id DESC LIMIT 1', [pidOf(db)]);
    if (row) return row.store_no;
    return createMainStore(db);
}

export async function getAllStores(db, searchQ = '') {
    // الإجماليات بتمريرة واحدة على بنود الجرد وواحدة على المخزون (بدل استعلامات فرعية لكل استور)
    let sql = `SELECT s.*,
        COALESCE(e.counted_items, 0) AS counted_items, COALESCE(e.counted_qty, 0) AS counted_qty,
        COALESCE(e.counted_cost, 0) AS counted_cost, COALESCE(e.counted_sale, 0) AS counted_sale,
        COALESCE(i.system_cost, 0) AS system_cost, COALESCE(i.system_sale, 0) AS system_sale,
        COALESCE(e.new_batches_count, 0) AS new_batches_count
        FROM stock_stores s
        LEFT JOIN (SELECT store_no, COUNT(DISTINCT product_code) AS counted_items, SUM(counted_qty) AS counted_qty, SUM(counted_qty * cost_price) AS counted_cost,
            SUM(counted_qty * selling_price) AS counted_sale, SUM(CASE WHEN is_new_batch = 1 THEN 1 ELSE 0 END) AS new_batches_count
            FROM stocktake_entries WHERE store_no IN (SELECT store_no FROM stock_stores WHERE profile_id = ?1) GROUP BY store_no) e ON e.store_no = s.store_no
        LEFT JOIN (SELECT store_no, SUM(system_qty * cost_price) AS system_cost, SUM(system_qty * selling_price) AS system_sale
            FROM inventory_records WHERE store_no IN (SELECT store_no FROM stock_stores WHERE profile_id = ?1) GROUP BY store_no) i ON i.store_no = s.store_no
        WHERE s.profile_id = ?1`;
    let params = [pidOf(db)];
    if (searchQ) { sql += ' AND (s.store_no LIKE ?2 OR s.store_name LIKE ?2 OR s.branch_name LIKE ?2)'; params.push(`%${searchQ.trim()}%`); }
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
    let n = last ? last.id + 1 : 1;
    while (await first(db, 'SELECT 1 AS x FROM stock_stores WHERE store_no = ?', [`ST-${String(n).padStart(3, '0')}`])) n++;
    const storeNo = `ST-${String(n).padStart(3, '0')}`;
    const m = await run(db, "INSERT INTO stock_stores (store_no, store_name, branch_name, status, created_by, profile_id) VALUES (?, ?, ?, 'new', ?, ?)",
        [storeNo, name, branchName || 'الفرع الرئيسي', userName, pidOf(db)]);
    return { success: true, store_id: m.last_row_id, store_no: storeNo, store_name: name, message: 'تم إنشاء الاستور بنجاح' };
}

export async function updateStore(db, storeNo, storeName, branchName) {
    await run(db, 'UPDATE stock_stores SET store_name = ?, branch_name = ? WHERE store_no = ? AND profile_id = ?', [String(storeName).trim(), String(branchName).trim(), String(storeNo).trim(), pidOf(db)]);
    return { success: true, message: 'تم تحديث بيانات الاستور بنجاح' };
}

export async function deleteStore(db, storeNo) {
    storeNo = String(storeNo || '').trim();
    if (!storeNo) return { success: false, message: 'رقم الاستور غير صالح' };
    if (!await ownsStore(db, storeNo)) return { success: false, message: 'هذا الاستور غير موجود في الصيدلية الحالية' };
    await ensureSafetyTables(db);
    await db.batch([
        trashStmt(db, newBatchId(), 'حذف الاستور', 'store_no = ?', [storeNo]),
        db.prepare('DELETE FROM stocktake_entries WHERE store_no = ?').bind(storeNo),
        db.prepare('DELETE FROM stocktake_scanned_serials WHERE store_no = ?').bind(storeNo),
        db.prepare('DELETE FROM inventory_records WHERE store_no = ?').bind(storeNo),
        db.prepare('DELETE FROM stock_stores WHERE store_no = ?').bind(storeNo),
    ]);
    let nextNo, nextName;
    if ((await first(db, 'SELECT COUNT(*) AS cnt FROM stock_stores WHERE profile_id = ?', [pidOf(db)])).cnt === 0) {
        nextNo = await createMainStore(db); nextName = 'الاستور الرئيسي';
    } else {
        const n = await first(db, 'SELECT store_no, store_name FROM stock_stores WHERE profile_id = ? ORDER BY id ASC LIMIT 1', [pidOf(db)]);
        nextNo = n.store_no; nextName = n.store_name;
    }
    return { success: true, message: `تم حذف الاستور (${storeNo}) بالكامل وجميع بياناته بنجاح`, next_store_no: nextNo, next_store_name: nextName, stores_data: await getAllStores(db) };
}

export async function resetAllStocktake(db) {
    // تصفير جرد الصيدلية الحالية فقط (لا يمس أي صيدلية أخرى)
    const pid = pidOf(db), sub = 'SELECT store_no FROM stock_stores WHERE profile_id = ?';
    await ensureSafetyTables(db);
    await db.batch([
        trashStmt(db, newBatchId(), 'تصفير كل الجرد', `store_no IN (${sub})`, [pid]),
        db.prepare(`DELETE FROM inventory_records WHERE store_no IN (${sub})`).bind(pid),
        db.prepare(`DELETE FROM stocktake_entries WHERE store_no IN (${sub})`).bind(pid),
        db.prepare(`DELETE FROM stocktake_scanned_serials WHERE store_no IN (${sub})`).bind(pid),
        db.prepare('DELETE FROM stock_stores WHERE profile_id = ?').bind(pid),
    ]);
    const mainNo = await createMainStore(db);
    return {
        success: true, message: 'تم تصفير ومسح جميع بيانات وتجارب الجرد بالكامل، النظام نظيف تماماً للبدء برفع المخزون الحقيقي.',
        store_no: mainNo, store_name: 'الاستور الرئيسي', stores_data: await getAllStores(db)
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
        const inv = await allIn(db, 'SELECT * FROM inventory_records WHERE product_code IN ({ph}) AND store_no IN (SELECT store_no FROM stock_stores WHERE profile_id = ?) ORDER BY id DESC', [], codes, [pidOf(db)]);
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
        const prods = await runProductQuery(db, 'SELECT p.* FROM products p',
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

// light: يرجّع البند اللي اتغير بس بدل تفاصيل الاستور كاملة (الجهاز بيحدّث نسخته بنفسه) — توفير كبير في القراءات
export async function scanItemToStore(db, rawCode, storeNo = 'ST-001', forceDirect = false, productCode = '', light = false) {
    const raw = String(rawCode || '').trim();
    if (!raw) return { success: false, message: 'لم يتم إدخال أو مسح أي كود' };
    storeNo = await resolveValidStoreNo(db, storeNo);
    await ensureLookupIndexes(db);
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
    // المطابقة بالباركود فقط لو له قيمة: باركود فاضي كان يطابق كل سطور المخزون اللي من غير باركود
    // فتظهر تشغيلات أصناف تانية في شاشة اختيار التشغيلة
    const keys = [...new Set([pCode, cPcode].filter(Boolean))], bcs = [...new Set([pBarcode, gCode].map(v => String(v || '').trim()).filter(Boolean))];
    // بحث بالفهارس: بالكود الأول ثم بالباركود (الـ OR بين الاتنين في جملة واحدة كان بيقرا مخزون الاستور كله مع كل مسح)
    const ph = (a) => a.map(() => '?').join(',');
    const invBy = async (storeCond, storeParams) => {
        let rows = await all(db, `SELECT * FROM inventory_records WHERE product_code IN (${ph(keys)}) AND ${storeCond} ORDER BY expiry_date ASC, id ASC`, [...keys, ...storeParams]);
        if (!rows.length && bcs.length) rows = await all(db, `SELECT * FROM inventory_records WHERE barcode IN (${ph(bcs)}) AND ${storeCond} ORDER BY expiry_date ASC, id ASC`, [...bcs, ...storeParams]);
        return rows;
    };
    let inv = await invBy('store_no = ?', [storeNo]);
    if (!inv.length) inv = await invBy('store_no IN (SELECT store_no FROM stock_stores WHERE profile_id = ?)', [pidOf(db)]);
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
    const storeData = light ? null : await getStoreStocktakeDetails(db, storeNo);
    const entry = light ? await first(db, 'SELECT * FROM stocktake_entries WHERE id = ?', [targetId]) : undefined;
    const msg = `تم جرد: ${pName} | باتش: ${tBatch || '-'} | صلاحية: ${tExpiry || '-'} | رصيد المخزون: ${pyf(tSys)} | الفعلي: ${Math.trunc(newQty)} | بيع: ${pyf(sellingPrice)} | تكلفة: ${pyf(costPrice)}` + (isNew ? ' (⚠️ باتش جديد)' : '');
    return {
        success: true, requires_batch_entry: false, direct_scan: true, entry_id: targetId, product_code: pCode, product_name: pName,
        batch_number: tBatch, expiry_date: tExpiry, serial, system_qty: tSys, counted_qty: newQty, cost_price: costPrice, selling_price: sellingPrice,
        is_new_batch: Boolean(isNew), message: msg, store_details: storeData, ...(light ? { light: true, entry, store_no: storeNo } : {})
    };
}

export async function saveStockBatchCount(db, { store_no, product_code, batch_number, expiry_date, counted_qty, system_qty = 0, cost_price = 0, selling_price = 0, entry_id = null }, light = false) {
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
    const msg = `تم حفظ: ${pName} | تشغيلة: ${b || '-'} | الفعلي: ${pyf(counted)}`;
    if (light) return { success: true, requires_batch_entry: false, direct_scan: true, entry_id: eid, message: msg, light: true, store_no: storeNo, entry: await first(db, 'SELECT * FROM stocktake_entries WHERE id = ?', [eid]) };
    return { success: true, requires_batch_entry: false, direct_scan: true, entry_id: eid, message: msg, store_details: await getStoreStocktakeDetails(db, storeNo) };
}

export async function updateEntryQuantity(db, entryId, newQty, storeNo, light = false) {
    storeNo = await resolveValidStoreNo(db, storeNo);
    await run(db, 'UPDATE stocktake_entries SET counted_qty = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND store_no = ?', [num(newQty), entryId, storeNo]);
    if (light) return { success: true, light: true, store_no: storeNo, entry: await first(db, 'SELECT * FROM stocktake_entries WHERE id = ? AND store_no = ?', [entryId, storeNo]) };
    return { success: true, store_details: await getStoreStocktakeDetails(db, storeNo) };
}

export async function deleteEntryItem(db, entryId, storeNo) {
    storeNo = await resolveValidStoreNo(db, storeNo);
    const r = await first(db, 'SELECT product_code, batch_number FROM stocktake_entries WHERE id = ? AND store_no = ?', [entryId, storeNo]);
    await ensureSafetyTables(db);
    const stmts = [trashStmt(db, newBatchId(), 'حذف بند', 'id = ? AND store_no = ?', [entryId, storeNo])];
    if (r) stmts.push(db.prepare('DELETE FROM stocktake_scanned_serials WHERE product_code = ? AND batch_number = ? AND store_no = ?').bind(r.product_code, r.batch_number, storeNo));
    stmts.push(db.prepare('DELETE FROM stocktake_entries WHERE id = ? AND store_no = ?').bind(entryId, storeNo));
    await db.batch(stmts);
    return { success: true, store_details: await getStoreStocktakeDetails(db, storeNo) };
}

export async function bulkDeleteEntries(db, ids, storeNo = 'ST-001') {
    if (!ids || !ids.length) return { success: false, message: 'لم يتم تحديد أي أصناف للحذف' };
    storeNo = await resolveValidStoreNo(db, storeNo);
    const rows = await allIn(db, 'SELECT product_code, batch_number FROM stocktake_entries WHERE id IN ({ph}) AND store_no = ?', [], ids, [storeNo]);
    await ensureSafetyTables(db);
    const bid = newBatchId();
    const stmts = rows.map(r => db.prepare('DELETE FROM stocktake_scanned_serials WHERE product_code = ? AND batch_number = ? AND store_no = ?').bind(r.product_code, r.batch_number, storeNo));
    for (let i = 0; i < ids.length; i += 90) {
        const part = ids.slice(i, i + 90);
        stmts.push(trashStmt(db, bid, 'حذف مجموعة بنود', `id IN (${part.map(() => '?').join(',')}) AND store_no = ?`, [...part, storeNo]));
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
    // حذف رصيد المخزون الدفتري فقط (الكميات المجرودة لا تُمس). "كل الاستورات" لا يحدث إلا بطلب صريح،
    // وكان سابقاً يحدث تلقائياً لو كان الاستور المختار فارغاً فيُصفّر مخزون كل الاستورات بالخطأ.
    const clean = String(storeNo || '').trim();
    const sub = 'SELECT store_no FROM stock_stores WHERE profile_id = ' + pidOf(db);
    let msg, target;
    if (clearAll) {
        await db.batch([`DELETE FROM inventory_records WHERE store_no IN (${sub})`, `UPDATE stocktake_entries SET system_qty = 0 WHERE store_no IN (${sub})`,
            `DELETE FROM stocktake_entries WHERE store_no IN (${sub}) AND (counted_qty = 0 OR counted_qty IS NULL)`].map(q => db.prepare(q)));
        msg = 'تم حذف رصيد المخزون الدفتري لجميع الاستورات (الكميات المجرودة محفوظة كما هي).'; target = await resolveValidStoreNo(db, '');
    } else {
        target = await resolveValidStoreNo(db, clean);
        const cnt = (await first(db, 'SELECT COUNT(*) AS c FROM inventory_records WHERE store_no = ?', [target])).c;
        if (cnt === 0) msg = `رصيد المخزون الدفتري فارغ بالفعل للاستور (${target}). لم يتم حذف أي شيء.`;
        else {
            await db.batch([
                db.prepare('DELETE FROM inventory_records WHERE store_no = ?').bind(target),
                db.prepare('UPDATE stocktake_entries SET system_qty = 0 WHERE store_no = ?').bind(target),
                db.prepare('DELETE FROM stocktake_entries WHERE store_no = ? AND (counted_qty = 0 OR counted_qty IS NULL)').bind(target),
            ]);
            msg = `تم حذف رصيد المخزون الدفتري (${cnt} صنف) للاستور (${target}) فقط. الكميات المجرودة محفوظة كما هي.`;
        }
    }
    return { success: true, message: msg, store_details: await getStoreStocktakeDetails(db, target) };
}

export async function clearStoreStocktake(db, storeNo) {
    if (!await ownsStore(db, storeNo)) storeNo = await resolveValidStoreNo(db, storeNo);
    await ensureSafetyTables(db);
    await db.batch([
        trashStmt(db, newBatchId(), 'تصفير جرد الاستور', 'store_no = ?', [storeNo]),
        db.prepare('DELETE FROM stocktake_entries WHERE store_no = ?').bind(storeNo),
        db.prepare('DELETE FROM stocktake_scanned_serials WHERE store_no = ?').bind(storeNo),
        db.prepare("UPDATE stock_stores SET status = 'new' WHERE store_no = ?").bind(storeNo),
    ]);
    return { success: true, store_details: await getStoreStocktakeDetails(db, storeNo) };
}

export async function commitStoresStocktake(db, storeNos = null) {
    const own = await profileStoreNos(db);
    if (!storeNos || !storeNos.length || storeNos.includes('ALL')) storeNos = own;
    else storeNos = storeNos.filter(n => own.includes(n));
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

// ================= رفع رصيد المخزون (منقول من upload_inventory_excel) =================
// المتصفح يقرأ ملف الإكسيل ويرسل الصفوف على دفعات حتى لا يتجاوز حدود Cloudflare المجانية.
const pyStr = (v) => (v === null || v === undefined) ? '' : String(v);
const pyFloat = (v) => { if (v === null || v === undefined || typeof v === 'boolean') return NaN; const t = String(v).trim(); if (!t) return NaN; return Number(t); };

export function detectStockColumns(rows) {
    let headerIdx = 0;
    const keys = ['batch', 'product', 'ref', 'gtin', 'expiry', 'quantity', 'price', 'كود', 'صنف', 'تشغيلة', 'كمية', 'باركود', 'مخزن'];
    for (let i = 0; i < Math.min(25, rows.length); i++) {
        const rowStr = (rows[i] || []).map(c => pyStr(c || '').toLowerCase()).join(' ');
        if (keys.filter(k => rowStr.includes(k)).length >= 2) { headerIdx = i; break; }
    }
    const header = (rows[headerIdx] || []).map(c => pyStr(c || '').trim().toLowerCase());
    const col = { code: -1, name: -1, cost: -1, sale: -1, expiry: -1, qty: -1, batch: -1, barcode: -1, batch_val: -1 };
    const has = (h, list) => list.some(k => h.includes(k));
    header.forEach((h, i) => {
        if (has(h, ['product ref', 'product_ref', 'item code', 'product code', 'كود', 'code', 'ref', 'رقم الصنف', 'رمز الصنف', 'item_id', 'pcode', 'sku']) && col.code === -1) col.code = i;
        if (has(h, ['product name', 'item name', 'اسم', 'name', 'description', 'الصنف', 'المادة']) && col.name === -1) col.name = i;
        if (has(h, ['batch sales price', 'product sales price', 'sales price', 'سعر البيع', 'بيع', 'sale', 'retail', 'unit price', 'سعر']) && col.sale === -1) col.sale = i;
        if (has(h, ['cost price', 'unit cost', 'تكلفة', 'cost', 'سعر التكلفة', 'شراء']) && col.cost === -1) col.cost = i;
        if (has(h, ['value w/o tax', 'batch value', 'قيمة التشغيلة', 'إجمالي التكلفة', 'قيمة']) && col.batch_val === -1) col.batch_val = i;
        if (has(h, ['expiry date', 'صلاحية', 'expiry', 'exp', 'تاريخ الصلاحية', 'انتهاء']) && col.expiry === -1) col.expiry = i;
        if (has(h, ['quantity', 'كمية', 'qty', 'الرصيد', 'الكمية', 'stock', 'balance']) && col.qty === -1) col.qty = i;
        if (has(h, ['batch number', 'تشغيلة', 'batch', 'lot', 'الباتش', 'الدفعة']) && col.batch === -1) col.batch = i;
        if (has(h, ['gtin', 'باركود', 'barcode', 'ean']) && col.barcode === -1) col.barcode = i;
    });
    return { header_row_idx: headerIdx, col_idx: col };
}

export async function uploadStockRows(db, storeNo, rows, col, replaceExisting, isFirst, uploadId = '') {
    storeNo = await resolveValidStoreNo(db, storeNo);
    const stmts = [];
    uploadId = String(uploadId || '').replace(/[^\w-]/g, '').slice(0, 64);
    if (uploadId) {
        // رفع آمن: الصفوف تُجمع في الجدول المرحلي ولا يُمس المخزون الحالي إلا في خطوة الإنهاء (دفعة ذرية واحدة)
        await ensureSafetyTables(db);
        if (isFirst) stmts.push(db.prepare("DELETE FROM inventory_upload_staging WHERE upload_id = ? OR created_at < datetime('now', '-1 day')").bind(uploadId));
    } else if (replaceExisting && isFirst) stmts.push(db.prepare('DELETE FROM inventory_records WHERE store_no = ?').bind(storeNo));
    const cell = (r, k) => (col[k] >= 0 && r[col[k]] !== null && r[col[k]] !== undefined) ? r[col[k]] : null;
    // تحميل الأصناف المطلوبة دفعة واحدة بدلاً من استعلام لكل سطر
    const codes = [...new Set(rows.map(r => cleanNumericCode(cell(r || [], 'code'))).filter(Boolean))];
    const prods = codes.length ? await allIn(db, 'SELECT * FROM products WHERE code IN ({ph})', [], codes) : [];
    const pm = Object.fromEntries(prods.map(p => [p.code, p]));
    let added = 0;
    for (const r of rows) {
        if (!r || !r.length || r.every(v => v === null || v === undefined)) continue;
        let code = cleanNumericCode(cell(r, 'code'));
        let barcode = pyStr(cell(r, 'barcode') ?? '').trim();
        let prod = code ? (pm[code] || null) : null;
        if (!prod && barcode) { prod = await findProductByGtinOrBarcode(db, barcode); if (prod) code = prod.code; }
        if (!code) continue;
        let name = pyStr(cell(r, 'name') ?? '').trim();
        const batch = pyStr(cell(r, 'batch') ?? '').trim().toUpperCase();
        const expiry = pyStr(cell(r, 'expiry') ?? '').trim();
        let qty = pyFloat(cell(r, 'qty') ?? 0); if (!Number.isFinite(qty)) qty = 0;
        let cost = pyFloat(cell(r, 'cost') ?? 0); if (!Number.isFinite(cost)) cost = 0;
        if (!cost && col.batch_val >= 0 && r[col.batch_val] !== null && r[col.batch_val] !== undefined) {
            const bv = pyFloat(r[col.batch_val]);
            if (Number.isFinite(bv)) cost = qty > 0 ? pyRound(bv / qty, 2) : bv;
        }
        let sale = pyFloat(cell(r, 'sale') ?? 0); if (!Number.isFinite(sale)) sale = 0;
        let itemType = 'medicine';
        if (prod) {
            name = prod.name_en || name || prod.name || '';
            itemType = prod.item_type || 'medicine';
            if (!cost && prod.cost_price) cost = num(prod.cost_price);
            if (!sale) sale = num(prod.selling_price || prod.price || prod.unit_price || 0);
            if (!barcode && prod.barcode) barcode = prod.barcode;
        }
        if (uploadId) stmts.push(db.prepare(`INSERT INTO inventory_upload_staging (upload_id, store_no, ${INV_COLS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .bind(uploadId, storeNo, code, name, barcode, batch, expiry, qty, cost, sale, itemType));
        else stmts.push(db.prepare(`INSERT INTO inventory_records (product_code, product_name, barcode, batch_number, expiry_date, system_qty, cost_price, selling_price, item_type, store_no, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).bind(code, name, barcode, batch, expiry, qty, cost, sale, itemType, storeNo));
        added++;
    }
    for (let i = 0; i < stmts.length; i += 400) await db.batch(stmts.slice(i, i + 400));
    return { success: true, added_count: added, store_no: storeNo, upload_id: uploadId || undefined };
}

// الخطوة الأخيرة بعد كل الدفعات: استبدال مخزون الاستور مرة واحدة ذرياً، ثم تحديث الرصيد الدفتري لبنود الجرد.
// الكميات المجرودة (counted_qty) لا تُمس أبداً، ولا يتأثر أي استور آخر.
const REFRESH_P = 'AND inventory_records.store_no IN (SELECT store_no FROM stock_stores WHERE profile_id = ?2)';
const REFRESH_ENTRIES_SQL = `UPDATE stocktake_entries SET
        product_name = COALESCE((SELECT COALESCE(NULLIF(name_en, ''), name) FROM products WHERE products.code = stocktake_entries.product_code), product_name),
        batch_number = CASE WHEN batch_number = '' OR batch_number IS NULL THEN COALESCE((SELECT batch_number FROM inventory_records WHERE inventory_records.product_code = stocktake_entries.product_code
            AND inventory_records.store_no = stocktake_entries.store_no AND inventory_records.batch_number != '' ORDER BY id DESC LIMIT 1), batch_number) ELSE batch_number END,
        expiry_date = CASE WHEN expiry_date = '' OR expiry_date IS NULL THEN COALESCE((SELECT expiry_date FROM inventory_records WHERE inventory_records.product_code = stocktake_entries.product_code
            AND inventory_records.store_no = stocktake_entries.store_no AND inventory_records.expiry_date != '' ORDER BY id DESC LIMIT 1), expiry_date) ELSE expiry_date END,
        cost_price = CASE WHEN cost_price = 0 OR cost_price IS NULL THEN COALESCE((SELECT cost_price FROM inventory_records WHERE inventory_records.product_code = stocktake_entries.product_code
            AND inventory_records.cost_price > 0 ${REFRESH_P} LIMIT 1), cost_price) ELSE cost_price END,
        selling_price = CASE WHEN selling_price = 0 OR selling_price IS NULL THEN COALESCE((SELECT selling_price FROM inventory_records WHERE inventory_records.product_code = stocktake_entries.product_code
            AND inventory_records.selling_price > 0 ${REFRESH_P} LIMIT 1), selling_price) ELSE selling_price END,
        system_qty = COALESCE((SELECT system_qty FROM inventory_records WHERE inventory_records.product_code = stocktake_entries.product_code
            AND inventory_records.store_no = stocktake_entries.store_no AND (inventory_records.batch_number = stocktake_entries.batch_number OR (stocktake_entries.batch_number = '' AND (inventory_records.batch_number IS NULL OR inventory_records.batch_number = ''))) LIMIT 1),
            (SELECT system_qty FROM inventory_records WHERE inventory_records.product_code = stocktake_entries.product_code AND inventory_records.store_no = stocktake_entries.store_no ORDER BY id DESC LIMIT 1), 0),
        is_new_batch = CASE WHEN EXISTS (SELECT 1 FROM inventory_records WHERE inventory_records.product_code = stocktake_entries.product_code AND inventory_records.store_no = stocktake_entries.store_no
            AND inventory_records.batch_number = stocktake_entries.batch_number) THEN 0 ELSE (CASE WHEN stocktake_entries.batch_number != '' THEN 1 ELSE 0 END) END
        WHERE store_no = ?1`;
export async function finishStockUpload(db, storeNo, totalAdded, uploadId = '', replaceExisting = true) {
    storeNo = await resolveValidStoreNo(db, storeNo);
    uploadId = String(uploadId || '').replace(/[^\w-]/g, '').slice(0, 64);
    if (uploadId) {
        await ensureSafetyTables(db);
        const staged = (await first(db, 'SELECT COUNT(*) AS c FROM inventory_upload_staging WHERE upload_id = ? AND store_no = ?', [uploadId, storeNo])).c;
        if (!staged) {
            await run(db, 'DELETE FROM inventory_upload_staging WHERE upload_id = ?', [uploadId]);
            // ملف بدون صفوف صالحة: لا نمسح المخزون الحالي (كان يتصفر بالكامل)
            return { success: false, message: 'لم يتم العثور على أي صنف صالح في الملف (تأكد من عمود الكود/الباركود). لم يتم تغيير المخزون الحالي.' };
        }
        if (!replaceExisting) {
            // وضع الإضافة (الافتراضي): يضيف بس التشغيلات (صنف + تشغيلة) اللي مش موجودة في مخزون الاستور،
            // والموجود يفضل زي ما هو. صف مكرر داخل نفس الملف يتحسب مرة واحدة.
            const NEW_ROWS = `FROM inventory_upload_staging s WHERE s.upload_id = ?1 AND s.store_no = ?2
                AND s.id = (SELECT MIN(s2.id) FROM inventory_upload_staging s2 WHERE s2.upload_id = s.upload_id AND s2.product_code = s.product_code
                    AND UPPER(TRIM(COALESCE(s2.batch_number, ''))) = UPPER(TRIM(COALESCE(s.batch_number, ''))))
                AND NOT EXISTS (SELECT 1 FROM inventory_records ir WHERE ir.store_no = s.store_no AND ir.product_code = s.product_code
                    AND UPPER(TRIM(COALESCE(ir.batch_number, ''))) = UPPER(TRIM(COALESCE(s.batch_number, ''))))`;
            const added = (await first(db, `SELECT COUNT(*) AS c ${NEW_ROWS}`, [uploadId, storeNo])).c;
            await db.batch([
                db.prepare(`INSERT INTO inventory_records (${INV_COLS.join(', ')}, store_no, created_at)
                    SELECT ${INV_COLS.map(c => 's.' + c).join(', ')}, s.store_no, CURRENT_TIMESTAMP ${NEW_ROWS} ORDER BY s.id ASC`).bind(uploadId, storeNo),
                db.prepare('DELETE FROM inventory_upload_staging WHERE upload_id = ?').bind(uploadId),
                db.prepare(REFRESH_ENTRIES_SQL).bind(storeNo, pidOf(db)),
            ]);
            return { success: true, added_count: added, skipped_existing_count: staged - added,
                message: `تمت إضافة ${added} سطر مخزون جديد للاستور (${storeNo}). السطور الموجودة بالفعل (${staged - added}) لم تتغير، والكميات المجرودة محفوظة كما هي.`,
                store_details: await getStoreStocktakeDetails(db, storeNo) };
        }
        await db.batch([
            db.prepare('DELETE FROM inventory_records WHERE store_no = ?').bind(storeNo),
            db.prepare(`INSERT INTO inventory_records (${INV_COLS.join(', ')}, store_no, created_at)
                SELECT ${INV_COLS.join(', ')}, store_no, CURRENT_TIMESTAMP FROM inventory_upload_staging WHERE upload_id = ? AND store_no = ? ORDER BY id ASC`).bind(uploadId, storeNo),
            db.prepare('DELETE FROM inventory_upload_staging WHERE upload_id = ?').bind(uploadId),
            db.prepare(REFRESH_ENTRIES_SQL).bind(storeNo, pidOf(db)),
        ]);
        totalAdded = staged;
    } else {
        await run(db, REFRESH_ENTRIES_SQL, [storeNo, pidOf(db)]);
    }
    return { success: true, added_count: totalAdded, message: `تم رفع واحتساب رصيد المخزون بنجاح (${totalAdded} سجل) للاستور (${storeNo}). الكميات المجرودة محفوظة كما هي.`, store_details: await getStoreStocktakeDetails(db, storeNo) };
}
