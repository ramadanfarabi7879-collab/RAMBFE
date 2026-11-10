// مسارات API التي تعمل مباشرة على Cloudflare (D1) بدون الحاجة لتشغيل الكمبيوتر.
// نفس أسماء المسارات وشكل الاستجابات في backend/server.py حتى تعمل الواجهات الحالية بدون تعديل.
import * as S from './stock.js';
import { searchProducts, all, first, run } from './products.js';

// بصمة الصنف: نفس التعبير بالضبط في backend/cloud_sync.py (CATALOG_SIG_SQL) — لا تغيّره في مكان واحد فقط
export const CATALOG_SIG_SQL = `p.id||'|'||ifnull(p.gtin,'')||'|'||ifnull(p.barcode,'')||'|'||ifnull(p.name_ar,'')||'|'||ifnull(p.name_en,'')||'|'||ifnull(p.name,'')||'|'||ifnull(p.category,'')||'|'||ifnull(p.selling_price,'')||'|'||ifnull(p.unit_price,'')||'|'||ifnull(p.cost_price,'')||'|'||ifnull(p.tax_rate,'')||'|'||ifnull(p.unit,'')||'|'||ifnull(p.unit_divisions,'')||'|'||ifnull(p.normalized_name,'')||'|'||ifnull(p.normalized_name_ar,'')||'|'||ifnull(p.normalized_name_en,'')||'|'||ifnull(p.scientific_name,'')||'|'||ifnull(p.company,'')||'|'||ifnull(p.wholesale_price,'')||'|'||ifnull((SELECT group_concat(x, ',') FROM (SELECT barcode||':'||ifnull(barcode_type,'') AS x FROM product_barcodes WHERE product_code = p.code ORDER BY barcode, barcode_type)),'')`;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token'
    }
});

const uid = () => crypto.randomUUID().replaceAll('-', '').slice(0, 8);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const intOr0 = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

async function broadcast(env, ctx, type, payload) {
    const evt = { id: uid(), type, payload: payload || {}, timestamp: Date.now() / 1000 };
    const p = (async () => {
        await run(env.DB, 'INSERT INTO sync_events (id, type, payload, ts) VALUES (?, ?, ?, ?)', [evt.id, type, JSON.stringify(evt.payload), evt.timestamp]);
        // الاحتفاظ بآخر ساعتين فقط من الأحداث
        if (Math.random() < 0.05) await run(env.DB, 'DELETE FROM sync_events WHERE ts < ?', [evt.timestamp - 7200]);
    })().catch(() => { });
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
    return evt;
}

// المسارات المنقولة للسحابة (GET و POST)
export const CLOUD_GET = new Set(['/api/catalog/products', '/api/stock/stores', '/api/stock/store/details', '/api/stock/store/search', '/api/sync/events', '/api/mobile/poll', '/api/cloud/health']);
export const CLOUD_POST = new Set(['/api/mobile/scan', '/api/stock/scan', '/api/stock/save-batch-qty', '/api/stock/update-qty', '/api/stock/delete-item',
    '/api/stock/bulk-delete', '/api/stock/edit-item', '/api/stock/clear', '/api/stock/clear-inventory', '/api/stock/settle', '/api/stock/commit-bulk',
    '/api/stock/stores/commit-all', '/api/stock/stores/create', '/api/stock/stores/update', '/api/stock/stores/delete', '/api/stock/reset-all', '/api/stock/populate-all']);

export function isCloudRoute(method, path) {
    if (path.startsWith('/api/_admin/')) return true;
    return method === 'GET' ? CLOUD_GET.has(path) : CLOUD_POST.has(path);
}

export async function handleCloudApi(request, env, ctx, url, rawBody) {
    const db = env.DB;
    const path = url.pathname;
    const method = request.method;
    const p = url.searchParams;
    let data = {};
    if (method !== 'GET' && rawBody && rawBody.byteLength) {
        try { data = JSON.parse(new TextDecoder().decode(rawBody)); } catch (_) { data = {}; }
    }
    try {
        if (path.startsWith('/api/_admin/')) return await handleAdmin(request, env, path, data);

        if (method === 'GET') {
            if (path === '/api/cloud/health') {
                const c = await all(db, "SELECT (SELECT COUNT(*) FROM stock_stores) AS stores, (SELECT v FROM meta WHERE k='products_count') AS products, (SELECT v FROM meta WHERE k='seed_source') AS seed_source");
                return json({ ok: true, mode: 'cloud', ...c[0] });
            }
            if (path === '/api/sync/events' || path === '/api/mobile/poll') {
                const since = num(p.get('since') || 0);
                const rows = await all(db, 'SELECT id, type, payload, ts FROM sync_events WHERE ts > ? ORDER BY seq ASC LIMIT 300', [since]);
                const events = rows.map(r => ({ id: r.id, type: r.type, payload: JSON.parse(r.payload || '{}'), timestamp: r.ts }));
                return json({ events, scans: events.filter(e => e.type === 'mobile_scan').map(e => e.payload), timestamp: Date.now() / 1000 });
            }
            if (path === '/api/catalog/products') {
                const q = (p.get('query') || p.get('q') || '').replace(/^\s+/, '');
                const lim = /^\d+$/.test(p.get('limit') || '') ? intOr0(p.get('limit')) : 50;
                const off = /^\d+$/.test(p.get('offset') || '') ? intOr0(p.get('offset')) : 0;
                return json(await searchProducts(db, q, lim, off, (p.get('mode') || 'start').trim().toLowerCase()));
            }
            if (path === '/api/stock/stores') return json(await S.getAllStores(db, (p.get('q') || '').trim() || (p.get('query') || '').trim()));
            if (path === '/api/stock/store/details') {
                return json(await S.getStoreStocktakeDetails(db, (p.get('store_no') || '').trim() || 'ST-001', (p.get('query') || p.get('q') || '').replace(/^\s+/, '')));
            }
            if (path === '/api/stock/store/search') {
                return json(await S.searchStoreStocktakeItems(db, (p.get('store_no') || '').trim() || 'ST-001', p.get('query') || p.get('q') || '', p.get('mode') || 'start'));
            }
        }

        const storeNo = String(data.store_no || 'ST-001').trim();
        switch (path) {
            case '/api/mobile/scan': {
                const code = String(data.code || data.raw_code || '').trim();
                const target = String(data.target || 'stocktake').trim();
                if (!code) return json({ success: false, message: 'لم يتم إرسال أي كود' }, 400);
                if (target !== 'stocktake') return null; // مسح الفواتير ما زال على الكمبيوتر
                const res = await S.scanItemToStore(db, code, storeNo, Boolean(data.force_direct));
                const pr = (res.product && typeof res.product === 'object') ? res.product : {};
                const event = {
                    id: uid(), code, target, store_no: storeNo, invoice_id: data.invoice_id ?? null, success: Boolean(res.success),
                    product_name: res.product_name || pr.name || '', product_code: res.product_code || pr.code || '',
                    batch: String(res.batch || res.batch_number || '').trim().toUpperCase(), message: res.message || '', timestamp: Date.now() / 1000
                };
                await broadcast(env, ctx, 'mobile_scan', event);
                res.event = event;
                return json(res);
            }
            case '/api/stock/scan': {
                const code = String(data.code || data.qr_text || '').trim();
                const res = await S.scanItemToStore(db, code, storeNo, Boolean(data.force_direct), String(data.product_code || '').trim());
                if (res.success) await broadcast(env, ctx, 'stock_scan', { store_no: storeNo, code, product_name: res.product_name || '', product_code: res.product_code || '' });
                return json(res);
            }
            case '/api/stock/save-batch-qty': {
                const pc = String(data.product_code || '').trim();
                const counted = num(data.counted_qty);
                const res = await S.saveStockBatchCount(db, {
                    store_no: storeNo, product_code: pc, batch_number: String(data.batch_number || '').trim().toUpperCase(),
                    expiry_date: String(data.expiry_date || '').trim(), counted_qty: counted, system_qty: num(data.system_qty),
                    cost_price: num(data.cost_price), selling_price: num(data.selling_price), entry_id: data.entry_id ? intOr0(data.entry_id) : null
                });
                if (res.success) await broadcast(env, ctx, 'stock_qty_updated', { store_no: storeNo, product_code: pc, counted_qty: counted });
                return json(res);
            }
            case '/api/stock/update-qty': {
                const id = intOr0(data.entry_id || data.id), qty = num(data.quantity || data.qty);
                const res = await S.updateEntryQuantity(db, id, qty, storeNo);
                if (res.success) await broadcast(env, ctx, 'stock_qty_updated', { store_no: storeNo, entry_id: id, quantity: qty });
                return json(res);
            }
            case '/api/stock/delete-item': {
                const id = intOr0(data.entry_id || data.id);
                const res = await S.deleteEntryItem(db, id, storeNo);
                if (res.success) await broadcast(env, ctx, 'stock_item_deleted', { store_no: storeNo, entry_id: id });
                return json(res);
            }
            case '/api/stock/bulk-delete': {
                const ids = (data.entry_ids || []).filter(i => /^\d+$/.test(String(i))).map(i => intOr0(i));
                const res = await S.bulkDeleteEntries(db, ids, storeNo);
                if (res.success) await broadcast(env, ctx, 'stock_item_deleted', { store_no: storeNo, entry_ids: ids });
                return json(res);
            }
            case '/api/stock/edit-item':
                return json(await S.editStocktakeEntry(db, intOr0(data.entry_id || data.id), data.updates || {}, storeNo));
            case '/api/stock/clear-inventory': {
                const clearAll = Boolean(data.clear_all || storeNo.toUpperCase() === 'ALL');
                const res = await S.clearInventoryRecords(db, storeNo, clearAll);
                if (res.success) await broadcast(env, ctx, 'inventory_cleared', { store_no: storeNo, clear_all: clearAll });
                return json(res);
            }
            case '/api/stock/clear': {
                const res = await S.clearStoreStocktake(db, storeNo);
                if (res.success) await broadcast(env, ctx, 'stock_cleared', { store_no: storeNo });
                return json(res);
            }
            case '/api/stock/settle': case '/api/stock/commit-bulk': case '/api/stock/stores/commit-all': {
                const commitAll = Boolean(data.commit_all);
                const nos = Array.isArray(data.store_nos) ? data.store_nos : [];
                const res = await S.commitStoresStocktake(db, commitAll ? ['ALL'] : (nos.length ? nos : [storeNo]));
                if (res.success) await broadcast(env, ctx, 'stock_settled', { store_nos: nos.length ? nos : [commitAll ? 'ALL' : storeNo] });
                return json(res);
            }
            case '/api/stock/stores/create': {
                const name = String(data.store_name || '').trim();
                const res = await S.createNewStore(db, name, String(data.branch_name || 'الفرع الرئيسي').trim(), String(data.user_name || 'المسؤول').trim());
                if (res.success) await broadcast(env, ctx, 'store_created', { store_no: res.store_no, store_name: name });
                return json(res);
            }
            case '/api/stock/stores/update': {
                const res = await S.updateStore(db, storeNo, String(data.store_name || ''), String(data.branch_name || ''));
                if (res.success) await broadcast(env, ctx, 'store_updated', { store_no: storeNo });
                return json(res);
            }
            case '/api/stock/stores/delete': {
                const res = await S.deleteStore(db, storeNo);
                if (res.success) await broadcast(env, ctx, 'store_deleted', { store_no: storeNo });
                return json(res);
            }
            case '/api/stock/reset-all': {
                const res = await S.resetAllStocktake(db);
                if (res.success) await broadcast(env, ctx, 'stock_reset', {});
                return json(res);
            }
            case '/api/stock/populate-all':
                return json(await S.populateStoreFromInventory(db, storeNo));
        }
        return null;
    } catch (e) {
        return json({ success: false, message: String(e && e.message || e) }, 400);
    }
}

// ---------- مسارات إدارية محمية لمزامنة الكمبيوتر مع السحابة ----------
const STOCK_TABLES = ['stock_stores', 'inventory_records', 'stocktake_entries', 'stocktake_scanned_serials'];
const SYNC_TABLES = new Set([...STOCK_TABLES, 'products', 'product_barcodes', 'meta']);

async function handleAdmin(request, env, path, data) {
    const tok = request.headers.get('X-Admin-Token') || '';
    if (!env.ADMIN_TOKEN || tok !== env.ADMIN_TOKEN) return json({ success: false, message: 'unauthorized' }, 401);
    const db = env.DB;

    // سحب نسخة من جداول الجرد (لعمليات الكمبيوتر مثل تصدير الإكسيل)
    if (path === '/api/_admin/pull') {
        const tables = (data.tables || STOCK_TABLES).filter(t => STOCK_TABLES.includes(t));
        const out = {};
        for (const t of tables) out[t] = await all(db, `SELECT * FROM ${t} ORDER BY id ASC`);
        return json({ success: true, tables: out });
    }
    // استبدال جداول الجرد بالكامل (بعد رفع ملف مخزون من الكمبيوتر) — دفعة ذرية واحدة
    if (path === '/api/_admin/replace') {
        const tables = data.tables || {};
        const stmts = [];
        for (const [t, rows] of Object.entries(tables)) {
            if (!STOCK_TABLES.includes(t)) continue;
            stmts.push(db.prepare(`DELETE FROM ${t}`));
            for (const r of rows) {
                const cols = Object.keys(r);
                stmts.push(db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map(c => r[c])));
            }
        }
        if (data.event) stmts.push(db.prepare('INSERT INTO sync_events (id, type, payload, ts) VALUES (?, ?, ?, ?)').bind(uid(), String(data.event), '{}', Date.now() / 1000));
        if (stmts.length) await db.batch(stmts);
        return json({ success: true, statements: stmts.length });
    }
    // إدراج/تحديث صفوف (مزامنة الأصناف من ملف الكتالوج على الكمبيوتر)
    if (path === '/api/_admin/upsert') {
        const t = data.table;
        if (!SYNC_TABLES.has(t)) return json({ success: false, message: 'bad table' }, 400);
        const rows = data.rows || [];
        const key = data.key || 'id';
        const stmts = rows.map(r => {
            const cols = Object.keys(r);
            const upd = cols.filter(c => c !== key).map(c => `${c}=excluded.${c}`).join(',');
            return db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT(${key}) DO ${upd ? 'UPDATE SET ' + upd : 'NOTHING'}`).bind(...cols.map(c => r[c]));
        });
        if (data.delete_keys && data.delete_keys.length) {
            for (const k of data.delete_keys) stmts.push(db.prepare(`DELETE FROM ${t} WHERE ${key} = ?`).bind(k));
        }
        for (let i = 0; i < stmts.length; i += 200) await db.batch(stmts.slice(i, i + 200));
        return json({ success: true, written: stmts.length });
    }
    // تطبيق تغييرات كتالوج الأصناف القادمة من الكمبيوتر: حذف ثم إدراج (يحافظ على نفس id وترتيب البحث)
    if (path === '/api/_admin/catalog_apply') {
        const del = [...new Set([...(data.delete_codes || []), ...(data.products || []).map(p => p.code)])];
        const stmts = [];
        for (let i = 0; i < del.length; i += 90) {
            const part = del.slice(i, i + 90);
            stmts.push(db.prepare(`DELETE FROM products WHERE code IN (${part.map(() => '?').join(',')})`).bind(...part));
        }
        if (!data.delete_only) {
            for (const r of data.products || []) {
                const cols = Object.keys(r);
                stmts.push(db.prepare(`INSERT INTO products (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).bind(...cols.map(c => r[c])));
            }
            for (const r of data.barcodes || []) {
                stmts.push(db.prepare('INSERT OR IGNORE INTO product_barcodes (product_code, barcode, barcode_type, created_at) VALUES (?, ?, ?, ?)')
                    .bind(r.product_code, r.barcode, r.barcode_type || 'barcode', r.created_at || null));
            }
        }
        stmts.push(db.prepare("INSERT INTO meta (k, v) VALUES ('products_count', (SELECT COUNT(*) FROM products)) ON CONFLICT(k) DO UPDATE SET v = excluded.v"));
        await db.batch(stmts);
        return json({ success: true, statements: stmts.length });
    }
    // بصمة كل صنف (نفس التعبير يُحسب محلياً على الكمبيوتر) لمعرفة ما تغيّر فقط
    if (path === '/api/_admin/catalog_rows') {
        const rows = await all(db, `SELECT code, ${CATALOG_SIG_SQL} AS s FROM products p ORDER BY code LIMIT ? OFFSET ?`, [intOr0(data.limit) || 5000, intOr0(data.offset)]);
        return json({ success: true, rows });
    }
    if (path === '/api/_admin/meta') {
        if (data.set) for (const [k, v] of Object.entries(data.set)) await run(db, 'INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', [k, String(v)]);
        const rows = await all(db, 'SELECT k, v FROM meta');
        const act = await first(db, "SELECT COUNT(*) AS c FROM sync_events");
        return json({ success: true, meta: Object.fromEntries(rows.map(r => [r.k, r.v])), events: act ? act.c : 0 });
    }
    if (path === '/api/_admin/exec') {
        // تنفيذ جمل صيانة محددة فقط (عدّ الأصناف وتحديث meta)
        if (data.op === 'refresh_counts') {
            await run(db, "INSERT INTO meta (k, v) VALUES ('products_count', (SELECT COUNT(*) FROM products)) ON CONFLICT(k) DO UPDATE SET v = excluded.v");
            return json({ success: true });
        }
        if (data.op === 'product_keys') {
            // بصمات الأصناف لمعرفة ما تغيّر فقط
            const rows = await all(db, "SELECT code, updated_at, name, selling_price, cost_price FROM products");
            return json({ success: true, rows });
        }
        return json({ success: false, message: 'unknown op' }, 400);
    }
    return json({ success: false, message: 'not found' }, 404);
}
