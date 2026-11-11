// مسارات API التي تعمل مباشرة على Cloudflare (D1) بدون الحاجة لتشغيل الكمبيوتر.
// نفس أسماء المسارات وشكل الاستجابات في backend/server.py حتى تعمل الواجهات الحالية بدون تعديل.
import * as S from './stock.js';
import * as X from './extra.js';
import { exportData } from './exporter.js';
import * as CI from './catalog_import.js';
import * as II from './invoice_import.js';
import * as AIX from './invoice_ai.js';
import { getProductByCode } from './products.js';
import { extractCleanGtin } from './qr.js';
import { searchProducts, all, first, run, allIn } from './products.js';
import * as OFF from './offline_support.js';

// بصمة الصنف: نفس التعبير بالضبط في backend/cloud_sync.py (CATALOG_SIG_SQL) — لا تغيّره في مكان واحد فقط
export const CATALOG_SIG_SQL = `p.id||'|'||ifnull(p.gtin,'')||'|'||ifnull(p.barcode,'')||'|'||ifnull(p.name_ar,'')||'|'||ifnull(p.name_en,'')||'|'||ifnull(p.name,'')||'|'||ifnull(p.category,'')||'|'||ifnull(p.selling_price,'')||'|'||ifnull(p.unit_price,'')||'|'||ifnull(p.cost_price,'')||'|'||ifnull(p.tax_rate,'')||'|'||ifnull(p.unit,'')||'|'||ifnull(p.unit_divisions,'')||'|'||ifnull(p.normalized_name,'')||'|'||ifnull(p.normalized_name_ar,'')||'|'||ifnull(p.normalized_name_en,'')||'|'||ifnull(p.scientific_name,'')||'|'||ifnull(p.company,'')||'|'||ifnull(p.wholesale_price,'')||'|'||ifnull((SELECT group_concat(x, ',') FROM (SELECT barcode||':'||ifnull(barcode_type,'') AS x FROM product_barcodes WHERE product_code = p.code ORDER BY barcode, barcode_type)),'')`;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
    status,
    headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token, X-Profile-Id'
    }
});

// قاعدة بيانات مقيدة بالصيدلية الحالية: كل الدوال تقرأ db.pid
class ScopedDB {
    constructor(d, pid) { this.d = d; this.pid = pid; }
    prepare(sql) { return this.d.prepare(sql); }
    batch(stmts) { return this.d.batch(stmts); }
}

// كلمة التأكيد المطلوبة لعمليات المسح الكبيرة (لا تُنفّذ بضغطة "موافق" بالخطأ)
export const CONFIRM_WORD = 'تأكيد';
const needConfirm = () => ({ success: false, needs_confirm: true, message: `لحماية بياناتك: اكتب كلمة "${CONFIRM_WORD}" لتأكيد هذه العملية.` });
const uid = () => crypto.randomUUID().replaceAll('-', '').slice(0, 8);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const intOr0 = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; };

export async function pushRealtime(env, evt) {
    if (!env.SYNC_HUB) return;
    try {
        const stub = env.SYNC_HUB.get(env.SYNC_HUB.idFromName('main'));
        await stub.fetch('https://hub/broadcast', { method: 'POST', body: JSON.stringify(evt) });
    } catch (_) { }
}

async function broadcast(env, ctx, type, payload, pid = 1) {
    const evt = { id: uid(), type, payload: payload || {}, timestamp: Date.now() / 1000, profile_id: pid };
    const p = (async () => {
        // إرسال فوري لكل الشاشات المفتوحة عبر WebSocket
        await pushRealtime(env, evt);
        await run(env.DB, 'INSERT INTO sync_events (id, type, payload, ts) VALUES (?, ?, ?, ?)', [evt.id, type, JSON.stringify({ ...evt.payload, __profile_id: pid }), evt.timestamp]);
        // الاحتفاظ بآخر ساعتين فقط من الأحداث
        if (Math.random() < 0.05) await run(env.DB, 'DELETE FROM sync_events WHERE ts < ?', [evt.timestamp - 7200]);
    })().catch(() => { });
    if (ctx && ctx.waitUntil) ctx.waitUntil(p); else await p;
    return evt;
}

// المسارات المنقولة للسحابة (GET و POST)
export const CLOUD_GET = new Set(['/api/catalog/products', '/api/stock/stores', '/api/stock/store/details', '/api/stock/store/search', '/api/sync/events', '/api/mobile/poll', '/api/cloud/health', '/api/realtime',
    '/api/health', '/api/stats', '/api/network-info', '/api/catalog/product', '/api/catalog/next-code', '/api/stock/uncounted',
    '/api/stock/preinventory-search', '/api/invoice/active', '/api/invoices/list', '/api/invoices/get', '/api/profiles', '/api/stock/trash',
    '/api/catalog/snapshot', '/api/stock/offline-pack', '/api/cloud/usage']);
export const CLOUD_POST = new Set(['/api/mobile/scan', '/api/stock/scan', '/api/stock/save-batch-qty', '/api/stock/update-qty', '/api/stock/delete-item',
    '/api/stock/bulk-delete', '/api/stock/edit-item', '/api/stock/clear', '/api/stock/clear-inventory', '/api/stock/settle', '/api/stock/commit-bulk',
    '/api/stock/stores/commit-all', '/api/stock/trash/restore', '/api/stock/stores/create', '/api/stock/stores/update', '/api/stock/stores/delete', '/api/stock/reset-all', '/api/stock/populate-all',
    '/api/catalog/save', '/api/catalog/delete', '/api/catalog/parse-gs1', '/api/catalog/parse-gtin', '/api/invoice/new', '/api/invoice/scan', '/api/invoice/delete-serial',
    '/api/invoice/delete-line', '/api/invoice/clear-lines', '/api/invoice/clear', '/api/invoice/update-line-qty', '/api/invoice/manual-item', '/api/invoice/confirm', '/api/returns/process',
    '/api/profiles/create', '/api/profiles/rename', '/api/profiles/delete', '/api/stock/upload/detect', '/api/stock/upload/rows', '/api/stock/upload/finish', '/api/export/data',
    '/api/catalog/import/lookup', '/api/catalog/import/commit', '/api/catalog/import/finish',
    '/api/invoice/import/rows', '/api/invoice/import/finish',
    '/api/invoice/ai/extract', '/api/invoice/ai/match', '/api/invoice/ai/commit']);

export function isCloudRoute(method, path) {
    if (path.startsWith('/api/_admin/')) return true;
    return method === 'GET' ? CLOUD_GET.has(path) : CLOUD_POST.has(path);
}

// غلاف يحسب قراءات D1 لكل طلب ويضيف علامة وضع التوفير للاستجابة (الواجهة تتحول للبحث المحلي عندها)
export async function handleCloudApi(request, env, ctx, url, rawBody) {
    if (url.pathname === '/api/realtime' || !env.DB) return handleCloudApiInner(request, env, ctx, url, rawBody);
    const rawDB = env.DB;
    const scoped = { ...env, DB: OFF.countingDB(rawDB) };
    try { if (OFF.usageInfo(env).reads_today === 0) await OFF.flushReadCounter(rawDB, true); } catch (_) { }
    const res = await handleCloudApiInner(request, scoped, ctx, url, rawBody);
    const flush = OFF.flushReadCounter(rawDB).catch(() => { });
    if (ctx && ctx.waitUntil) ctx.waitUntil(flush); else await flush;
    if (res && OFF.isEconomy(env)) { try { res.headers.set('X-Rambfe-Economy', '1'); } catch (_) { } }
    return res;
}

async function handleCloudApiInner(request, env, ctx, url, rawBody) {
    // الصيدلية الحالية من رأس الطلب (افتراضياً 1)، مع التحقق من وجودها
    let pid = parseInt(request.headers.get('X-Profile-Id') || url.searchParams.get('profile_id') || '1', 10);
    if (!Number.isFinite(pid) || pid < 1) pid = 1;
    // مسارات لا تخص صيدلية معينة لا تحتاج قراءة من قاعدة البيانات: تعمل حتى لو حصة القراءة اليومية خلصت
    // (نسخة الكتالوج تُقدّم من KV)
    const NO_PROFILE = ['/api/realtime', '/api/catalog/snapshot', '/api/cloud/usage', '/api/health'];
    if (!url.pathname.startsWith('/api/_admin/') && !NO_PROFILE.includes(url.pathname)) {
        try {
            // صيدلية غير موجودة (اتحذفت) تتحول لأول صيدلية موجودة فعلاً — ولا نرجع لصيدلية 1 لو كانت محذوفة
            // (كان المستخدم يقع على "صيدلية شبح" فارغة غير ظاهرة في القائمة ويظن أن بياناته اتمسحت)
            if (!(await first(env.DB, 'SELECT id FROM profiles WHERE id = ?', [pid]))) {
                const f = await first(env.DB, 'SELECT MIN(id) AS id FROM profiles');
                if (f && f.id) pid = f.id;
                else { await run(env.DB, "INSERT OR IGNORE INTO profiles (id, name) VALUES (1, 'صيدلية 1')"); pid = 1; }
            }
        } catch (e) {
            // لا نرجع لصيدلية 1 بصمت عند عطل القاعدة (كانت الشاشة تعرض صيدلية أخرى فارغة)
            return json({ success: false, offline_reconnecting: true, db_unavailable: true,
                message: 'قاعدة البيانات السحابية غير متاحة حالياً: بياناتك محفوظة ولم تُمسح.', error: String(e && e.message || e) }, 503);
        }
    }
    const db = new ScopedDB(env.DB, pid);
    const bcast = (type, payload) => broadcast(env, ctx, type, payload, pid);
    const path = url.pathname;
    const method = request.method;
    const p = url.searchParams;
    let data = {};
    if (method !== 'GET' && rawBody && rawBody.byteLength) {
        try { data = JSON.parse(new TextDecoder().decode(rawBody)); } catch (_) { data = {}; }
    }
    try {
        if (path.startsWith('/api/_admin/')) return await handleAdmin(request, env, path, data);
        if (path === '/api/realtime') {
            if (!env.SYNC_HUB) return json({ success: false, message: 'realtime unavailable' }, 503);
            return env.SYNC_HUB.get(env.SYNC_HUB.idFromName('main')).fetch(request);
        }

        if (method === 'GET') {
            if (path === '/api/cloud/health') {
                const c = await all(db, "SELECT (SELECT COUNT(*) FROM stock_stores) AS stores, (SELECT v FROM meta WHERE k='products_count') AS products, (SELECT v FROM meta WHERE k='seed_source') AS seed_source");
                return json({ ok: true, mode: 'cloud', ...c[0] });
            }
            if (path === '/api/sync/events' || path === '/api/mobile/poll') {
                const since = num(p.get('since') || 0);
                const rows = await all(db, 'SELECT id, type, payload, ts FROM sync_events WHERE ts > ? ORDER BY seq ASC LIMIT 300', [since]);
                const events = rows.map(r => { const pl = JSON.parse(r.payload || '{}'); const ep = pl.__profile_id || 1; delete pl.__profile_id;
                    return { id: r.id, type: r.type, payload: pl, timestamp: r.ts, profile_id: ep }; }).filter(e => e.profile_id === pid || e.type === 'profiles_changed');
                return json({ events, scans: events.filter(e => e.type === 'mobile_scan').map(e => e.payload), timestamp: Date.now() / 1000 });
            }
            if (path === '/api/cloud/usage') return json({ success: true, ...OFF.usageInfo(env) });
            if (path === '/api/catalog/snapshot') return await OFF.catalogSnapshot(env, db, ctx, p.get('force') === '1');
            if (path === '/api/stock/offline-pack') return json(await OFF.offlinePack(db, (p.get('store_no') || '').trim(), S.resolveValidStoreNo));
            if (path === '/api/catalog/products' && OFF.economyBlocksQuery(env, p.get('query') || p.get('q') || '')) {
                return json({ items: [], total: 0, limit: 50, offset: 0, economy: true, message: 'وضع التوفير: اكتب 3 حروف على الأقل للبحث (حصة القراءة اليومية قاربت على الانتهاء).' });
            }
            if (path === '/api/catalog/products') {
                const q = (p.get('query') || p.get('q') || '').replace(/^\s+/, '');
                const lim = /^\d+$/.test(p.get('limit') || '') ? intOr0(p.get('limit')) : 50;
                const off = /^\d+$/.test(p.get('offset') || '') ? intOr0(p.get('offset')) : 0;
                return json(await searchProducts(db, q, lim, off, (p.get('mode') || 'start').trim().toLowerCase()));
            }
            if (path === '/api/health') return json({ healthy: true, success: true, write_blocked: false, mode: 'cloud', db_path: 'cloudflare-d1', cloudflare_url: url.origin });
            if (path === '/api/stats') return json(await X.getStats(db));
            if (path === '/api/network-info') return json({ ip: url.host, port: 443, mobile_url: `${url.origin}/mobile`, companion_url: `${url.origin}/mobile`,
                local_mobile_url: `${url.origin}/mobile`, cloudflare_url: url.origin, is_cloudflare_active: true });
            if (path === '/api/catalog/next-code') return json({ code: await X.getNextProductCode(db) });
            if (path === '/api/catalog/product') {
                const prod = await getProductByCode(db, (p.get('code') || '').trim());
                return prod ? json({ success: true, product: prod }) : json({ success: false, message: 'الصنف غير موجود' }, 404);
            }
            if (path === '/api/stock/uncounted') {
                try { return json(await X.getUncountedStoreItems(db, (p.get('store_no') || '').trim() || 'ST-001', (p.get('category') || '').trim())); }
                catch (e) { return json({ detail: `خطأ في جلب الأصناف غير المجرودة: ${e.message}` }, 500); }
            }
            if (path === '/api/stock/preinventory-search') {
                const lim = /^\d+$/.test(p.get('limit') || '') ? intOr0(p.get('limit')) : 100;
                const off = /^\d+$/.test(p.get('offset') || '') ? intOr0(p.get('offset')) : 0;
                return json(await X.searchPreinventoryProducts(db, (p.get('query') || p.get('q') || '').replace(/^\s+/, ''), lim, off,
                    (p.get('mode') || 'start').trim().toLowerCase(), ['1', 'true', 'yes'].includes((p.get('stock_only') || '0').trim().toLowerCase())));
            }
            if (path === '/api/invoice/active') return json({ success: true, invoice: await X.getOrCreateDraftInvoice(db) });
            if (path === '/api/invoices/list') {
                const lim = /^\d+$/.test(p.get('limit') || '') ? intOr0(p.get('limit')) : 50;
                const off = /^\d+$/.test(p.get('offset') || '') ? intOr0(p.get('offset')) : 0;
                return json({ success: true, invoices: await X.getAllInvoices(db, lim, off) });
            }
            if (path === '/api/invoices/get') {
                const idS = (p.get('id') || '0').trim();
                const inv = await X.getInvoiceDetails(db, /^\d+$/.test(idS) ? intOr0(idS) : 0);
                return Object.keys(inv).length ? json({ success: true, invoice: inv }) : json({ success: false, message: 'الفاتورة غير موجودة' }, 404);
            }
            if (path === '/api/profiles') {
                const rows = await all(env.DB, `SELECT pr.id, pr.name, pr.created_at,
                    (SELECT COUNT(*) FROM stock_stores s WHERE s.profile_id = pr.id) AS stores_count,
                    (SELECT COUNT(*) FROM inventory_records ir WHERE ir.store_no IN (SELECT store_no FROM stock_stores WHERE profile_id = pr.id)) AS stock_rows,
                    (SELECT COUNT(*) FROM invoices i WHERE i.profile_id = pr.id) AS invoices_count
                    FROM profiles pr ORDER BY pr.id ASC`);
                return json({ success: true, profiles: rows, current_profile_id: pid });
            }
            if (path === '/api/stock/trash') return json(await S.listTrash(db, (p.get('store_no') || '').trim()));
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
                await bcast('mobile_scan', event);
                res.event = event;
                return json(res);
            }
            case '/api/stock/scan': {
                const code = String(data.code || data.qr_text || '').trim();
                const res = await S.scanItemToStore(db, code, storeNo, Boolean(data.force_direct), String(data.product_code || '').trim());
                if (res.success) await bcast('stock_scan', { store_no: storeNo, code, product_name: res.product_name || '', product_code: res.product_code || '' });
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
                if (res.success) await bcast('stock_qty_updated', { store_no: storeNo, product_code: pc, counted_qty: counted });
                return json(res);
            }
            case '/api/stock/update-qty': {
                const id = intOr0(data.entry_id || data.id), qty = num(data.quantity || data.qty);
                const res = await S.updateEntryQuantity(db, id, qty, storeNo);
                if (res.success) await bcast('stock_qty_updated', { store_no: storeNo, entry_id: id, quantity: qty });
                return json(res);
            }
            case '/api/stock/delete-item': {
                const id = intOr0(data.entry_id || data.id);
                const res = await S.deleteEntryItem(db, id, storeNo);
                if (res.success) await bcast('stock_item_deleted', { store_no: storeNo, entry_id: id });
                return json(res);
            }
            case '/api/stock/bulk-delete': {
                const ids = (data.entry_ids || []).filter(i => /^\d+$/.test(String(i))).map(i => intOr0(i));
                const res = await S.bulkDeleteEntries(db, ids, storeNo);
                if (res.success) await bcast('stock_item_deleted', { store_no: storeNo, entry_ids: ids });
                return json(res);
            }
            case '/api/stock/edit-item':
                return json(await S.editStocktakeEntry(db, intOr0(data.entry_id || data.id), data.updates || {}, storeNo));
            case '/api/stock/clear-inventory': {
                const clearAll = Boolean(data.clear_all || storeNo.toUpperCase() === 'ALL');
                // حذف مخزون كل الاستورات لا يتم إلا بتأكيد مكتوب من الواجهة الجديدة
                if (clearAll && data.confirm_text !== CONFIRM_WORD) return json(needConfirm(), 400);
                const res = await S.clearInventoryRecords(db, storeNo, clearAll);
                if (res.success) await bcast('inventory_cleared', { store_no: storeNo, clear_all: clearAll });
                return json(res);
            }
            case '/api/stock/clear': {
                if (data.confirm_text !== CONFIRM_WORD) return json(needConfirm(), 400);
                const res = await S.clearStoreStocktake(db, storeNo);
                if (res.success) await bcast('stock_cleared', { store_no: storeNo });
                return json(res);
            }
            case '/api/stock/settle': case '/api/stock/commit-bulk': case '/api/stock/stores/commit-all': {
                const commitAll = Boolean(data.commit_all);
                const nos = Array.isArray(data.store_nos) ? data.store_nos : [];
                const res = await S.commitStoresStocktake(db, commitAll ? ['ALL'] : (nos.length ? nos : [storeNo]));
                if (res.success) await bcast('stock_settled', { store_nos: nos.length ? nos : [commitAll ? 'ALL' : storeNo] });
                return json(res);
            }
            case '/api/stock/stores/create': {
                const name = String(data.store_name || '').trim();
                const res = await S.createNewStore(db, name, String(data.branch_name || 'الفرع الرئيسي').trim(), String(data.user_name || 'المسؤول').trim());
                if (res.success) await bcast('store_created', { store_no: res.store_no, store_name: name });
                return json(res);
            }
            case '/api/stock/stores/update': {
                const res = await S.updateStore(db, storeNo, String(data.store_name || ''), String(data.branch_name || ''));
                if (res.success) await bcast('store_updated', { store_no: storeNo });
                return json(res);
            }
            case '/api/stock/stores/delete': {
                const res = await S.deleteStore(db, storeNo);
                if (res.success) await bcast('store_deleted', { store_no: storeNo });
                return json(res);
            }
            case '/api/stock/reset-all': {
                if (data.confirm_text !== CONFIRM_WORD) return json(needConfirm(), 400);
                const res = await S.resetAllStocktake(db);
                if (res.success) await bcast('stock_reset', {});
                return json(res);
            }
            case '/api/profiles/create': {
                const name = String(data.name || '').trim();
                if (!name) return json({ success: false, message: 'يُرجى كتابة اسم الصيدلية' }, 400);
                if (await first(env.DB, 'SELECT id FROM profiles WHERE name = ?', [name])) return json({ success: false, message: 'يوجد صيدلية بنفس الاسم' }, 400);
                const m = await run(env.DB, 'INSERT INTO profiles (name) VALUES (?)', [name]);
                const newDb = new ScopedDB(env.DB, m.last_row_id);
                const storeNo = await S.resolveValidStoreNo(newDb, '');
                await broadcast(env, ctx, 'profiles_changed', { id: m.last_row_id }, m.last_row_id);
                return json({ success: true, id: m.last_row_id, name, store_no: storeNo, message: `تم إنشاء ${name} بنجاح` });
            }
            case '/api/profiles/rename': {
                const id = intOr0(data.id), name = String(data.name || '').trim();
                if (!id || !name) return json({ success: false, message: 'بيانات غير صالحة' }, 400);
                if (await first(env.DB, 'SELECT id FROM profiles WHERE name = ? AND id != ?', [name, id])) return json({ success: false, message: 'يوجد صيدلية بنفس الاسم' }, 400);
                await run(env.DB, 'UPDATE profiles SET name = ? WHERE id = ?', [name, id]);
                await broadcast(env, ctx, 'profiles_changed', { id }, id);
                return json({ success: true, message: 'تم تغيير الاسم بنجاح' });
            }
            case '/api/profiles/delete': {
                const id = intOr0(data.id);
                const prof = await first(env.DB, 'SELECT id, name FROM profiles WHERE id = ?', [id]);
                if (!prof) return json({ success: false, message: 'الصيدلية غير موجودة' }, 404);
                if ((await first(env.DB, 'SELECT COUNT(*) AS c FROM profiles')).c <= 1) return json({ success: false, message: 'لا يمكن حذف الصيدلية الوحيدة' }, 400);
                if (String(data.confirm_name || '').trim() !== prof.name) return json({ success: false, message: 'اكتب اسم الصيدلية بالضبط لتأكيد الحذف' }, 400);
                const sub = 'SELECT store_no FROM stock_stores WHERE profile_id = ?', isub = 'SELECT id FROM invoices WHERE profile_id = ?';
                await env.DB.batch([
                    env.DB.prepare(`DELETE FROM inventory_records WHERE store_no IN (${sub})`).bind(id),
                    env.DB.prepare(`DELETE FROM stocktake_entries WHERE store_no IN (${sub})`).bind(id),
                    env.DB.prepare(`DELETE FROM stocktake_scanned_serials WHERE store_no IN (${sub})`).bind(id),
                    env.DB.prepare('DELETE FROM stock_stores WHERE profile_id = ?').bind(id),
                    env.DB.prepare(`DELETE FROM scanned_serials WHERE invoice_id IN (${isub})`).bind(id),
                    env.DB.prepare(`DELETE FROM invoice_lines WHERE invoice_id IN (${isub})`).bind(id),
                    env.DB.prepare('DELETE FROM invoices WHERE profile_id = ?').bind(id),
                    env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(id),
                ]);
                await broadcast(env, ctx, 'profiles_changed', { id, deleted: true }, id);
                return json({ success: true, message: `تم حذف ${prof.name} وكل بياناتها` });
            }
            case '/api/invoice/ai/extract': {
                const r = await AIX.aiExtract(env, { image: data.image, text: data.text, model: data.model });
                if (r.success && data.match !== false) r.items = await AIX.matchLines(db, r.items);
                return json(r);
            }
            case '/api/invoice/ai/commit': {
                let invId = intOr0(data.invoice_id);
                if (!invId) invId = (await X.getOrCreateDraftInvoice(db)).id;
                let added = 0; const errors = [];
                for (const ln of Array.isArray(data.lines) ? data.lines : []) {
                    const code = String(ln.product_code || '').trim();
                    if (!code) continue;
                    const r = await X.addManualItemToInvoice(db, invId, code, String(ln.batch || '').trim().toUpperCase(), String(ln.expiry || '').trim(),
                        Math.max(1, intOr0(ln.quantity) || 1), 'المسؤول', code);
                    if (r.success) added += r.added_qty; else errors.push(`${code}: ${r.message}`);
                }
                await bcast('invoice_updated', { invoice_id: invId });
                return json({ success: errors.length === 0 || added > 0, added_packages: added, errors, invoice: await X.getInvoiceDetails(db, invId),
                    message: `تمت إضافة ${added} عبوة من الفاتورة المقروءة` + (errors.length ? ` (تعذر ${errors.length} سطر)` : '') });
            }
            case '/api/invoice/ai/match':
                return json({ success: true, items: await AIX.matchLines(db, Array.isArray(data.items) ? data.items : []) });
            case '/api/invoice/import/rows':
                return json(await II.importInvoiceRows(db, data.invoice_id, Array.isArray(data.columns) ? data.columns : [], Array.isArray(data.rows) ? data.rows : [],
                    intOr0(data.idx_offset), String(data.user_name || 'المسؤول')));
            case '/api/invoice/import/finish': {
                const r = await II.finishInvoiceImport(db, data.invoice_id, intOr0(data.imported_count), intOr0(data.skipped_count));
                await bcast('invoice_updated', { invoice_id: intOr0(data.invoice_id) });
                return json(r);
            }
            case '/api/catalog/import/lookup':
                return json(await CI.importLookup(db, data.codes || [], data.barcodes || []));
            case '/api/catalog/import/commit':
                return json(await CI.commitImportChunk(db, Array.isArray(data.items) ? data.items : [], Boolean(data.replace_barcodes)));
            case '/api/catalog/import/finish': {
                const r = await CI.finishImport(db, String(data.file_name || ''), intOr0(data.updated_count), intOr0(data.new_count), Boolean(data.replace_barcodes));
                await bcast('catalog_updated', { imported: intOr0(data.updated_count) + intOr0(data.new_count) });
                return json(r);
            }
            case '/api/export/data': {
                const r = await exportData(db, String(data.kind || ''), data.params || {});
                return json(r, r.success === false ? 404 : 200);
            }
            case '/api/stock/upload/detect':
                return json({ success: true, ...S.detectStockColumns(Array.isArray(data.rows) ? data.rows : []) });
            case '/api/stock/upload/rows': {
                const res = await S.uploadStockRows(db, storeNo, Array.isArray(data.rows) ? data.rows : [], data.col_idx || {}, data.replace_existing !== false, Boolean(data.is_first), data.upload_id || '');
                return json(res);
            }
            case '/api/stock/upload/finish': {
                const res = await S.finishStockUpload(db, storeNo, intOr0(data.total_added), data.upload_id || '', data.replace_existing !== false);
                if (res.success) await bcast('inventory_uploaded', { store_no: res.store_details?.store?.store_no || storeNo });
                return json(res, res.success ? 200 : 400);
            }
            case '/api/stock/trash/restore': {
                const res = await S.restoreTrash(db, storeNo, String(data.batch_id || ''));
                if (res.success) await bcast('stock_qty_updated', { store_no: storeNo, restored: res.restored_count });
                return json(res);
            }
            case '/api/catalog/save': {
                const res = await X.saveOrUpdateProduct(db, data);
                await bcast('catalog_updated', { code: res.code });
                return json(res);
            }
            case '/api/catalog/delete': {
                if (data.clear_all) { await X.clearCatalog(db); await bcast('catalog_cleared', {}); return json({ success: true, message: 'تم تفريغ دليل الأصناف بالكامل بنجاح' }); }
                if (Array.isArray(data.codes) && data.codes.length) {
                    const cnt = await X.bulkDeleteProducts(db, data.codes);
                    await bcast('catalog_bulk_deleted', { codes: data.codes, count: cnt });
                    return json({ success: true, deleted_count: cnt, message: `تم حذف ${cnt} صنف بنجاح` });
                }
                const ok = await X.deleteProduct(db, data.code);
                if (ok) await bcast('catalog_deleted', { code: data.code });
                return json({ success: ok, message: ok ? 'تم حذف بطاقة الصنف بنجاح' : 'فشل الحذف' });
            }
            case '/api/catalog/parse-gs1': return json(X.parseGs1(data.raw));
            case '/api/catalog/parse-gtin': { const raw = String(data.raw || '').trim(); return json({ success: true, gtin: extractCleanGtin(raw), raw }); }
            case '/api/invoice/new': return json({ success: true, invoice: await X.createNewInvoice(db, data.notes || '', data.user_name || 'المسؤول') });
            case '/api/invoice/scan': {
                let invId = intOr0(data.invoice_id);
                const qr = String(data.qr_text || '').trim(), user = String(data.user_name || 'المسؤول').trim();
                if (!invId) invId = (await X.getOrCreateDraftInvoice(db, user)).id;
                const parsed = X.parseQrCode(qr);
                const res = await X.scanQrToInvoice(db, invId, qr, user);
                res.invoice = await X.getInvoiceDetails(db, invId);
                const qd = parsed.success ? (parsed.data || {}) : {};
                res.parsed_qr = qd;
                for (const k of ['gtin', 'batch', 'serial', 'expiry']) if (qd[k] && !(k in res)) res[k] = qd[k];
                await bcast('invoice_updated', { invoice_id: invId });
                return json(res);
            }
            case '/api/invoice/delete-serial': case '/api/invoice/delete-line': case '/api/invoice/clear-lines': case '/api/invoice/clear':
            case '/api/invoice/update-line-qty': case '/api/invoice/manual-item': case '/api/invoice/confirm': {
                let invId = intOr0(data.invoice_id);
                const needsDraft = ['/api/invoice/clear-lines', '/api/invoice/clear', '/api/invoice/update-line-qty', '/api/invoice/manual-item'].includes(path);
                if (!invId && needsDraft) invId = (await X.getOrCreateDraftInvoice(db)).id;
                let res;
                if (path === '/api/invoice/delete-serial') res = await X.deleteScannedSerial(db, invId, intOr0(data.serial_id));
                else if (path === '/api/invoice/delete-line') res = await X.deleteInvoiceLine(db, invId, intOr0(data.line_id));
                else if (path === '/api/invoice/update-line-qty') res = await X.updateInvoiceLineQuantity(db, invId, intOr0(data.line_id), data.quantity ?? 1);
                else if (path === '/api/invoice/manual-item') res = await X.addManualItemToInvoice(db, invId, String(data.gtin || '').trim(), String(data.batch || '').trim().toUpperCase(),
                    String(data.expiry || '').trim(), data.quantity ?? 1, String(data.user_name || 'المسؤول').trim());
                else if (path === '/api/invoice/confirm') res = await X.confirmInvoice(db, invId);
                else res = await X.clearInvoiceLines(db, invId);
                res.invoice = await X.getInvoiceDetails(db, invId);
                await bcast('invoice_updated', { invoice_id: invId });
                return json(res);
            }
            case '/api/returns/process':
                return json(await X.processSerialReturn(db, data.serial_number || '', data.invoice_number || '', data.reason || 'إرجاع عبوة', data.user_name || 'المسؤول'));
            case '/api/stock/populate-all':
                return json(await S.populateStoreFromInventory(db, storeNo));
        }
        return null;
    } catch (e) {
        const msg = String(e && e.message || e);
        // تجاوز حصة D1 اليومية أو عطل مؤقت في قاعدة البيانات: البيانات نفسها سليمة. نرجع 503 برسالة واضحة
        // حتى لا تعرض الشاشات أصفاراً أو تمسح ما هو معروض (كان المستخدم يظن أن الجرد اتمسح)
        if (isDbUnavailable(msg)) {
            return json({ success: false, offline_reconnecting: true, db_unavailable: true,
                message: /limit|exceed|quota/i.test(msg)
                    ? 'قاعدة البيانات السحابية وصلت للحد اليومي للقراءة: بياناتك محفوظة ولم تُمسح، وستعود للعمل تلقائياً بعد الساعة 3 فجراً (منتصف الليل UTC).'
                    : 'قاعدة البيانات السحابية غير متاحة لحظياً: بياناتك محفوظة ولم تُمسح، أعد المحاولة بعد ثوانٍ.',
                error: msg }, 503);
        }
        return json({ success: false, message: msg }, 400);
    }
}

export function isDbUnavailable(msg) {
    return /exceeded|row read limit|rows read|daily limit|quota|overloaded|Network connection lost|internal error|storage operation|D1 DB is|reset because|too many requests|timed? ?out/i.test(String(msg || ''))
        && !/constraint|syntax|no such (table|column)|datatype mismatch/i.test(String(msg || ''));
}

// ---------- مسارات إدارية محمية لمزامنة الكمبيوتر مع السحابة ----------
const STOCK_TABLES = ['stock_stores', 'inventory_records', 'stocktake_entries', 'stocktake_scanned_serials', 'invoices', 'invoice_lines', 'scanned_serials', 'returns_log', 'product_aliases', 'audit_logs'];
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
        // استبدال الجداول بالكامل يمسح أي جرد/فواتير تمت بعد أخذ النسخة: لا يُنفّذ إلا بتأكيد صريح
        if (data.allow_overwrite !== 'OVERWRITE_CLOUD_DATA') return json({ success: false, message: 'full table replace is disabled to protect stocktake data' }, 403);
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
        let adminEvt = null;
        if (data.event) {
            adminEvt = { id: uid(), type: String(data.event), payload: {}, timestamp: Date.now() / 1000 };
            stmts.push(db.prepare('INSERT INTO sync_events (id, type, payload, ts) VALUES (?, ?, ?, ?)').bind(adminEvt.id, adminEvt.type, '{}', adminEvt.timestamp));
        }
        if (stmts.length) await db.batch(stmts);
        if (adminEvt) await pushRealtime(env, adminEvt);
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
        // عدد الأصناف بالزيادة/النقصان (إعادة عدّ الجدول كله كانت تقرأ 30 ألف صف مع كل دفعة من الكمبيوتر)
        let existing = 0;
        for (let i = 0; i < del.length; i += 90) {
            const part = del.slice(i, i + 90);
            existing += (await first(db, `SELECT COUNT(*) AS c FROM products WHERE code IN (${part.map(() => '?').join(',')})`, part)).c;
        }
        const delta = (data.delete_only ? 0 : new Set((data.products || []).map(p => p.code)).size) - existing;
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
        if (delta) stmts.push(db.prepare("UPDATE meta SET v = MAX(0, CAST(v AS INTEGER) + (?)) WHERE k = 'products_count'").bind(delta));
        if (stmts.length) await db.batch(stmts);
        return json({ success: true, statements: stmts.length });
    }
    // بصمة كل صنف (نفس التعبير يُحسب محلياً على الكمبيوتر) لمعرفة ما تغيّر فقط
    if (path === '/api/_admin/catalog_rows') {
        const rows = await all(db, `SELECT code, ${CATALOG_SIG_SQL} AS s FROM products p ORDER BY code LIMIT ? OFFSET ?`, [intOr0(data.limit) || 5000, intOr0(data.offset)]);
        return json({ success: true, rows });
    }
    // تغييرات الكتالوج التي تمت من السحابة (من الموبايل أو رابط الكمبيوتر) ليجلبها برنامج الكمبيوتر
    if (path === '/api/_admin/catalog_changes') {
        const since = intOr0(data.since);
        const ch = await all(db, 'SELECT seq, code FROM catalog_changes WHERE seq > ? ORDER BY seq ASC LIMIT 2000', [since]);
        const codes = [...new Set(ch.map(r => r.code).filter(c => c !== '*'))];
        const prods = codes.length ? await allIn(db, 'SELECT * FROM products WHERE code IN ({ph})', [], codes) : [];
        const bcs = codes.length ? await allIn(db, 'SELECT product_code, barcode, barcode_type, created_at FROM product_barcodes WHERE product_code IN ({ph})', [], codes) : [];
        const mx = await first(db, 'SELECT COALESCE(MAX(seq), 0) AS m FROM catalog_changes');
        return json({ success: true, changes: ch, products: prods, barcodes: bcs, last_seq: ch.length ? ch[ch.length - 1].seq : since, max_seq: mx.m });
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
