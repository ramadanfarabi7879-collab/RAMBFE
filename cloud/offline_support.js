// دعم وضع عدم الاتصال ووضع التوفير.
//
// 1) نسخة يومية من كتالوج الأصناف (/api/catalog/snapshot): تُبنى من D1 مرة واحدة كل 24 ساعة وتُحفظ في KV،
//    فتحميلها على أي عدد من الأجهزة لا يقرأ من قاعدة البيانات ولا يستهلك الحد اليومي.
// 2) حزمة مخزون الاستور (/api/stock/offline-pack): أرصدة الاستور وتشغيلاته ليختار المستخدم التشغيلة بدون اتصال.
// 3) عدّاد القراءات اليومي: يجمع rows_read لكل الاستعلامات ويحفظه في meta، وعند تجاوز 80% من الحد اليومي
//    يدخل البرنامج "وضع التوفير" (البحث من الكتالوج المحفوظ على الجهاز، وبحث الحرف والحرفين متوقف).
import { all, first, allIn } from './products.js';

const SNAP_COLS = ['id', 'code', 'name_en', 'name_ar', 'name', 'gtin', 'barcode', 'selling_price', 'cost_price', 'unit_price',
    'scientific_name', 'company', 'category', 'tax_rate', 'unit'];

// نسخة الكتالوج للأجهزة = الكتالوج المدمج مع الموقع (base-catalog.json) بدون أي قراءة من قاعدة البيانات.
// (كان بيتبني من D1 كامل: 92 ألف صف في كل مرة، واتبنى 4 مرات في نفس اللحظة بعد النشر)
export async function catalogSnapshot(env) {
    if (env.ASSETS) {
        const base = await env.ASSETS.fetch(new Request('https://assets.local/base-catalog.json'));
        if (base.ok) return new Response(base.body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Snapshot-Source': 'base' } });
    }
    return new Response(JSON.stringify({ success: false, message: 'base catalog not available' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
}

// التغييرات على الكتالوج بعد وقت معيّن (الأجهزة تضيفها فوق الكتالوج المدمج): بتقرا الأصناف اللي اتغيرت بس
let changesIndexReady = false;
export async function catalogChanges(db, sinceTs) {
    if (!changesIndexReady) {
        await db.prepare('CREATE INDEX IF NOT EXISTS idx_catalog_changes_ts ON catalog_changes(ts)').run();
        changesIndexReady = true;
    }
    const LIMIT = 2000;
    const ch = await all(db, 'SELECT code, ts FROM catalog_changes WHERE ts > ? ORDER BY ts ASC LIMIT ?', [Number(sinceTs) || 0, LIMIT]);
    const maxTs = ch.length ? ch[ch.length - 1].ts : Number(sinceTs) || 0;
    if (ch.some(c => c.code === '*')) return { success: true, full_reset: true, max_ts: maxTs };
    const codes = [...new Set(ch.map(c => String(c.code)))];
    const prods = codes.length ? await allIn(db, `SELECT ${SNAP_COLS.join(', ')} FROM products WHERE code IN ({ph})`, [], codes) : [];
    const bcs = codes.length ? await allIn(db, 'SELECT product_code, barcode, barcode_type FROM product_barcodes WHERE product_code IN ({ph})', [], codes) : [];
    const found = new Set(prods.map(p => String(p.code)));
    return {
        success: true, max_ts: maxTs, more: ch.length === LIMIT, cols: SNAP_COLS, changed_codes: codes,
        products: prods.map(p => SNAP_COLS.map(c => p[c] ?? null)),
        barcodes: bcs.map(b => [b.product_code, b.barcode, b.barcode_type === 'gtin' ? 1 : 0]),
        deleted: codes.filter(c => !found.has(c)),
    };
}

export async function offlinePack(db, storeNo, resolveValidStoreNo) {
    const sn = await resolveValidStoreNo(db, storeNo);
    const inventory = await all(db, `SELECT product_code, barcode, batch_number, expiry_date, system_qty, cost_price, selling_price
        FROM inventory_records WHERE store_no = ? ORDER BY expiry_date ASC, id ASC`, [sn]);
    return { success: true, store_no: sn, generated_at: Date.now(), inventory };
}

// ---------------- عدّاد القراءات اليومي ووضع التوفير ----------------
const DEFAULT_DAILY_LIMIT = 5000000;
const DEFAULT_DAILY_WRITE_LIMIT = 100000; // حد الكتابة اليومي في الخطة المجانية
const state = { pending: 0, pendingW: 0, day: '', today: null, todayW: 0, lastFlush: 0 };
const utcDay = () => new Date().toISOString().slice(0, 10);

export function dailyLimit(env) {
    const v = parseInt(env.D1_DAILY_READ_LIMIT || '', 10);
    return Number.isFinite(v) ? v : DEFAULT_DAILY_LIMIT; // 0 = بدون حد (الخطة المدفوعة)
}
export function dailyWriteLimit(env) {
    const v = parseInt(env.D1_DAILY_WRITE_LIMIT || '', 10);
    return Number.isFinite(v) ? v : DEFAULT_DAILY_WRITE_LIMIT;
}
// أول طلب في النسخة دي من الـ Worker، أو يوم جديد بدأ (الحد بيتجدد 12 بالليل بتوقيت UTC)
export function counterStale() { return state.today === null || state.day !== utcDay(); }

// قاعدة بيانات تحسب rows_read لكل استعلام (نفس واجهة D1)
export function countingDB(raw) {
    const add = (r) => {
        const m = r && r.meta;
        if (m && m.rows_read) state.pending += m.rows_read;
        if (m && m.rows_written) state.pendingW += m.rows_written;
        return r;
    };
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
    if (state.day !== day) { state.day = day; state.today = null; state.todayW = 0; }
    if (!force && Date.now() - state.lastFlush < 30000 && state.today !== null) return state.today;
    state.lastFlush = Date.now();
    const add = state.pending, addW = state.pendingW; state.pending = 0; state.pendingW = 0;
    const UPSERT = `INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + CAST(excluded.v AS INTEGER)`;
    try {
        // بنكتب العدّاد اللي زاد بس (مفيش استهلاك جديد = صفر كتابة)، وبعدين نقرا إجمالي اليوم من كل الأجهزة
        const stmts = [];
        if (add) stmts.push(raw.prepare(UPSERT).bind(`reads_${day}`, String(add)));
        if (addW) stmts.push(raw.prepare(UPSERT).bind(`writes_${day}`, String(addW)));
        stmts.push(raw.prepare(`SELECT k, v FROM meta WHERE k IN (?, ?)`).bind(`reads_${day}`, `writes_${day}`));
        const rs = await raw.batch(stmts);
        const rows = (rs[rs.length - 1] && rs[rs.length - 1].results) || [];
        const get = (k) => Number((rows.find(x => x.k === k) || {}).v) || 0;
        state.today = get(`reads_${day}`); state.todayW = get(`writes_${day}`);
    } catch (_) { state.pending += add; state.pendingW += addW; }
    return state.today;
}

export function isEconomy(env) {
    const lim = dailyLimit(env);
    if (!lim || state.today === null) return false;
    return (state.today + state.pending) >= lim * 0.8;
}

export function usageInfo(env) {
    const lim = dailyLimit(env), wlim = dailyWriteLimit(env);
    const used = (state.today || 0) + state.pending, usedW = (state.todayW || 0) + state.pendingW;
    return { day: state.day || utcDay(), reads_today: used, daily_limit: lim, percent: lim ? Math.round(used * 100 / lim) : 0,
        writes_today: usedW, daily_write_limit: wlim, write_percent: wlim ? Math.round(usedW * 100 / wlim) : 0,
        resets_at: Date.UTC(...(state.day || utcDay()).split('-').map((x, i) => i === 1 ? Number(x) - 1 : Number(x))) + 86400000,
        economy: isEconomy(env) };
}
// الاستهلاك مختصر في رأس كل استجابة (قراءات/حد/كتابات/حد): الشريط في الموقع بيتحدث مع كل عملية من غير أي طلب زيادة
export function usageHeader(env) {
    const u = usageInfo(env);
    return `${u.reads_today}/${u.daily_limit}/${u.writes_today}/${u.daily_write_limit}/${u.resets_at}`;
}

// في وضع التوفير: البحث بحرف أو حرفين (مش رقم كود/باركود) يقرأ آلاف الصفوف، فنوقفه ونطلب 3 حروف
export function economyBlocksQuery(env, q) {
    if (!isEconomy(env)) return false;
    const t = String(q || '').trim();
    return t.length > 0 && t.length < 3 && !/^\d+$/.test(t);
}

export { first };
