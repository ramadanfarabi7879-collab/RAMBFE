// دعم وضع عدم الاتصال ووضع التوفير.
//
// 1) نسخة يومية من كتالوج الأصناف (/api/catalog/snapshot): تُبنى من D1 مرة واحدة كل 24 ساعة وتُحفظ في KV،
//    فتحميلها على أي عدد من الأجهزة لا يقرأ من قاعدة البيانات ولا يستهلك الحد اليومي.
// 2) حزمة مخزون الاستور (/api/stock/offline-pack): أرصدة الاستور وتشغيلاته ليختار المستخدم التشغيلة بدون اتصال.
// 3) عدّاد القراءات اليومي: يجمع rows_read لكل الاستعلامات ويحفظه في meta، وعند تجاوز 80% من الحد اليومي
//    يدخل البرنامج "وضع التوفير" (البحث من الكتالوج المحفوظ على الجهاز، وبحث الحرف والحرفين متوقف).
import { all, first } from './products.js';

const SNAP_KEY = 'catalog_snapshot_v1';
const SNAP_LOCK = 'catalog_snapshot_lock';
const SNAP_MAX_AGE_MS = 24 * 3600 * 1000;

async function buildSnapshot(db) {
    const products = await all(db, `SELECT id, code, name_en, name_ar, name, gtin, barcode, selling_price, cost_price, unit_price,
        scientific_name, company, category, tax_rate, unit FROM products ORDER BY id DESC`);
    const barcodes = await all(db, 'SELECT product_code, barcode, barcode_type FROM product_barcodes');
    const cols = ['id', 'code', 'name_en', 'name_ar', 'name', 'gtin', 'barcode', 'selling_price', 'cost_price', 'unit_price',
        'scientific_name', 'company', 'category', 'tax_rate', 'unit'];
    return JSON.stringify({
        version: 1, generated_at: Date.now(), count: products.length, cols,
        products: products.map(p => cols.map(c => p[c] ?? null)),
        barcodes: barcodes.map(b => [b.product_code, b.barcode, b.barcode_type === 'gtin' ? 1 : 0]),
    });
}

export async function catalogSnapshot(env, db, ctx, force = false) {
    const kv = env.TUNNEL_KV;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
    if (!kv) return new Response(await buildSnapshot(db), { headers });
    const cached = await kv.getWithMetadata(SNAP_KEY, { type: 'text' });
    const age = cached && cached.metadata ? Date.now() - Number(cached.metadata.ts || 0) : Infinity;
    if (cached && cached.value && age < SNAP_MAX_AGE_MS && !force) return new Response(cached.value, { headers: { ...headers, 'X-Snapshot-Age': String(Math.round(age / 1000)) } });
    // نسخة قديمة موجودة: نرجعها فوراً ونحدّثها في الخلفية (جهاز واحد فقط يحدّثها في نفس الوقت)
    const refresh = async () => {
        if (await kv.get(SNAP_LOCK)) return null;
        await kv.put(SNAP_LOCK, '1', { expirationTtl: 120 });
        const body = await buildSnapshot(db);
        await kv.put(SNAP_KEY, body, { metadata: { ts: Date.now() } });
        return body;
    };
    if (cached && cached.value) {
        ctx && ctx.waitUntil ? ctx.waitUntil(refresh().catch(() => { })) : await refresh().catch(() => { });
        return new Response(cached.value, { headers: { ...headers, 'X-Snapshot-Age': String(Math.round(age / 1000)) } });
    }
    try {
        const body = (await refresh()) || await buildSnapshot(db);
        return new Response(body, { headers });
    } catch (e) {
        // قاعدة البيانات واقفة ومفيش نسخة في KV: نرجع الكتالوج الأساسي المدمج مع الموقع
        if (env.ASSETS) {
            const base = await env.ASSETS.fetch(new Request('https://assets.local/base-catalog.json'));
            if (base.ok) return new Response(base.body, { headers: { ...headers, 'X-Snapshot-Source': 'base' } });
        }
        throw e;
    }
}

export async function offlinePack(db, storeNo, resolveValidStoreNo) {
    const sn = await resolveValidStoreNo(db, storeNo);
    const inventory = await all(db, `SELECT product_code, barcode, batch_number, expiry_date, system_qty, cost_price, selling_price
        FROM inventory_records WHERE store_no = ? ORDER BY expiry_date ASC, id ASC`, [sn]);
    return { success: true, store_no: sn, generated_at: Date.now(), inventory };
}

// ---------------- عدّاد القراءات اليومي ووضع التوفير ----------------
const DEFAULT_DAILY_LIMIT = 5000000;
const state = { pending: 0, day: '', today: null, lastFlush: 0 };
const utcDay = () => new Date().toISOString().slice(0, 10);

export function dailyLimit(env) {
    const v = parseInt(env.D1_DAILY_READ_LIMIT || '', 10);
    return Number.isFinite(v) ? v : DEFAULT_DAILY_LIMIT; // 0 = بدون حد (الخطة المدفوعة)
}

// قاعدة بيانات تحسب rows_read لكل استعلام (نفس واجهة D1)
export function countingDB(raw) {
    const add = (r) => { const n = r && r.meta && r.meta.rows_read; if (n) state.pending += n; return r; };
    const wrap = (st) => ({
        __raw: st,
        bind: (...a) => wrap(st.bind(...a)),
        all: async () => add(await st.all()),
        run: async () => add(await st.run()),
        raw: (...a) => st.raw(...a),
        first: async (col) => {
            const r = add(await st.all());
            const row = (r.results || [])[0];
            if (row === undefined) return null;
            return col ? row[col] ?? null : row;
        },
    });
    return {
        prepare: (sql) => wrap(raw.prepare(sql)),
        batch: async (stmts) => { const rs = await raw.batch(stmts.map(s => s.__raw || s)); for (const r of rs) add(r); return rs; },
        exec: (sql) => raw.exec(sql),
        dump: () => raw.dump(),
    };
}

// حفظ ما تم قراءته في meta (مرة كل 30 ثانية كحد أقصى لكل نسخة من الـ Worker) وقراءة إجمالي اليوم
export async function flushReadCounter(raw, force = false) {
    const day = utcDay();
    if (state.day !== day) { state.day = day; state.today = null; }
    if (!force && Date.now() - state.lastFlush < 30000 && state.today !== null) return state.today;
    state.lastFlush = Date.now();
    const add = state.pending; state.pending = 0;
    try {
        const r = await raw.prepare(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + CAST(excluded.v AS INTEGER) RETURNING v`)
            .bind(`reads_${day}`, String(add)).first();
        state.today = Number(r && r.v) || add;
    } catch (_) { state.pending += add; }
    return state.today;
}

export function isEconomy(env) {
    const lim = dailyLimit(env);
    if (!lim || state.today === null) return false;
    return (state.today + state.pending) >= lim * 0.8;
}

export function usageInfo(env) {
    const lim = dailyLimit(env);
    const used = (state.today || 0) + state.pending;
    return { day: state.day || utcDay(), reads_today: used, daily_limit: lim, percent: lim ? Math.round(used * 100 / lim) : 0, economy: isEconomy(env) };
}

// في وضع التوفير: البحث بحرف أو حرفين (مش رقم كود/باركود) يقرأ آلاف الصفوف، فنوقفه ونطلب 3 حروف
export function economyBlocksQuery(env, q) {
    if (!isEconomy(env)) return false;
    const t = String(q || '').trim();
    return t.length > 0 && t.length < 3 && !/^\d+$/.test(t);
}

export { first };
