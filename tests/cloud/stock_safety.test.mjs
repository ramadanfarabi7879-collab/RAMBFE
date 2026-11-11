// اختبار تكامل لحماية بيانات الجرد في كود السحابة (cloud/router.js + cloud/stock.js) على نسخة D1 محلية.
// التشغيل:  node tests/cloud/stock_safety.test.mjs   (يحتاج wrangler: npm install)
// يتأكد من:
//  - رفع المخزون لا يمس الكميات المجرودة ولا مخزون الاستورات الأخرى
//  - رفع ملف بدون صفوف صالحة أو انقطاع الرفع في المنتصف لا يُصفّر المخزون الحالي
//  - مسح مخزون استور فارغ لا يمسح مخزون كل الاستورات
//  - التصفير/الحذف يتطلب كلمة تأكيد، ويحفظ نسخة في سلة المحذوفات، والاسترجاع يرجّع الكميات
//  - صيدلية محذوفة لا تقع على "صيدلية شبح" فارغة
//  - البحث بدون JOIN على جدول الباركود يقرأ صفوفاً قليلة
import { getPlatformProxy } from 'wrangler';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const R = await import(pathToFileURL(join(APP, 'cloud', 'router.js')).href);

const dir = mkdtempSync(join(tmpdir(), 'rambfe-d1-'));
writeFileSync(join(dir, 'wrangler.toml'), `name = "t"\nmain = "w.js"\ncompatibility_date = "2024-09-23"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "t"\ndatabase_id = "00000000-0000-0000-0000-000000000001"\n`);
writeFileSync(join(dir, 'w.js'), 'export default { fetch() { return new Response("x") } }');
const { env, dispose } = await getPlatformProxy({ configPath: join(dir, 'wrangler.toml'), persist: { path: join(dir, 'state') } });
const DB = env.DB;

async function execFile(name) {
    const sql = readFileSync(join(APP, 'cloud', name), 'utf-8').replace(/--[^\n]*/g, '');
    for (const st of sql.split(/;\s*(?:\n|$)/).map(s => s.trim()).filter(Boolean)) await DB.prepare(st).run();
}
for (const f of ['schema.sql', 'schema_invoices.sql', 'schema_profiles.sql']) await execFile(f);
// مشغّلات فهرس البحث (كل CREATE TRIGGER ... END; جملة واحدة)
for (const st of readFileSync(join(APP, 'cloud', 'triggers.sql'), 'utf-8').replace(/--[^\n]*/g, '').match(/(DROP TRIGGER[^;]+;|CREATE TRIGGER[\s\S]+?END;)/g)) await DB.prepare(st).run();
await DB.prepare("INSERT INTO meta (k, v) VALUES ('products_count', '3')").run();
for (const [code, name, bc] of [['10001', 'PANADOL EXTRA', '6221025000011'], ['10002', 'BRUFEN 400', '6221025000028'], ['10003', 'CONGESTAL', '6221025000035']]) {
    await DB.prepare("INSERT INTO products (code, name, name_en, barcode, category) VALUES (?, ?, ?, ?, 'MEDICINE')").bind(code, name, name, bc).run();
    await DB.prepare("INSERT INTO product_barcodes (product_code, barcode, barcode_type) VALUES (?, ?, 'barcode')").bind(code, bc).run();
}
await DB.prepare("INSERT INTO profiles (id, name) VALUES (2, 'صيدلية 2')").run();

let pid = 1;
async function api(method, path, body) {
    const url = new URL('https://rambfe.test' + path);
    const req = new Request(url, { method, headers: { 'Content-Type': 'application/json', 'X-Profile-Id': String(pid) }, body: method === 'GET' ? undefined : JSON.stringify(body || {}) });
    const raw = method === 'GET' ? null : new TextEncoder().encode(JSON.stringify(body || {})).buffer;
    const res = await R.handleCloudApi(req, env, { waitUntil() { } }, url, raw);
    return { status: res.status, data: await res.json() };
}
const one = async (sql, ...p) => (await DB.prepare(sql).bind(...p).first());
const COL = { code: 0, name: 1, batch: 2, qty: 3, expiry: -1, cost: -1, sale: -1, barcode: -1, batch_val: -1 };

let passed = 0;
async function test(name, fn) {
    try { await fn(); passed++; console.log('  ✓', name); }
    catch (e) { console.error('  ✗', name, '\n   ', e.message); process.exitCode = 1; }
}

// إعداد: استوران لنفس الصيدلية، مخزون لكل منهما، وكميات مجرودة في الأول
const A = (await api('POST', '/api/stock/stores/create', { store_name: 'A' })).data.store_no;
const B = (await api('POST', '/api/stock/stores/create', { store_name: 'B' })).data.store_no;
async function upload(store, rows, { stopBeforeFinish = false } = {}) {
    const id = 'up' + Math.random().toString(36).slice(2, 10);
    let r = await api('POST', '/api/stock/upload/rows', { store_no: store, rows, col_idx: COL, replace_existing: true, is_first: true, upload_id: id });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (stopBeforeFinish) return r;
    return api('POST', '/api/stock/upload/finish', { store_no: store, total_added: r.data.added_count, upload_id: id, replace_existing: true });
}
await upload(A, [['10001', 'PANADOL', 'B1', 10], ['10002', 'BRUFEN', 'B2', 5]]);
await upload(B, [['10003', 'CONGESTAL', 'C1', 7]]);
await api('POST', '/api/stock/save-batch-qty', { store_no: A, product_code: '10001', batch_number: 'B1', counted_qty: 8 });
await api('POST', '/api/stock/save-batch-qty', { store_no: A, product_code: '10002', batch_number: 'B2', counted_qty: 4 });
const countedA = async () => (await one('SELECT COALESCE(SUM(counted_qty),0) AS s FROM stocktake_entries WHERE store_no = ?', A)).s;
const invRows = async (s) => (await one('SELECT COUNT(*) AS c FROM inventory_records WHERE store_no = ?', s)).c;

console.log('cloud stock safety:');
await test('رفع مخزون جديد لا يمس الكميات المجرودة ويحدّث الرصيد الدفتري', async () => {
    assert.equal(await countedA(), 12);
    const r = await upload(A, [['10001', 'PANADOL', 'B1', 30], ['10002', 'BRUFEN', 'B2', 1]]);
    assert.equal(r.data.success, true, JSON.stringify(r.data));
    assert.equal(await countedA(), 12);
    assert.equal((await one("SELECT system_qty FROM stocktake_entries WHERE store_no = ? AND product_code = '10001'", A)).system_qty, 30);
    assert.equal(await invRows(A), 2);
});
await test('رفع مخزون استور لا يمس مخزون الاستورات الأخرى', async () => {
    assert.equal(await invRows(B), 1);
});
await test('ملف بدون صفوف صالحة لا يُصفّر المخزون الحالي', async () => {
    const r = await upload(A, [['', 'no code', '', 3]]);
    assert.equal(r.data.success, false);
    assert.equal(await invRows(A), 2);
});
await test('انقطاع الرفع قبل الإنهاء يترك المخزون القديم كما هو', async () => {
    await upload(A, [['10003', 'CONGESTAL', 'X', 1]], { stopBeforeFinish: true });
    assert.equal(await invRows(A), 2);
});
await test('مسح مخزون استور فارغ لا يمسح مخزون كل الاستورات', async () => {
    const C = (await api('POST', '/api/stock/stores/create', { store_name: 'C' })).data.store_no;
    const r = await api('POST', '/api/stock/clear-inventory', { store_no: C });
    assert.equal(r.data.success, true);
    assert.equal(await invRows(A), 2);
    assert.equal(await invRows(B), 1);
});
await test('مسح مخزون كل الاستورات مرفوض بدون كلمة التأكيد', async () => {
    const r = await api('POST', '/api/stock/clear-inventory', { store_no: 'ALL', clear_all: true });
    assert.equal(r.status, 400);
    assert.equal(r.data.needs_confirm, true);
    assert.equal(await invRows(A), 2);
});
await test('تصفير الجرد مرفوض بدون كلمة التأكيد', async () => {
    const r = await api('POST', '/api/stock/clear', { store_no: A });
    assert.equal(r.status, 400);
    assert.equal(await countedA(), 12);
    const r2 = await api('POST', '/api/stock/reset-all', {});
    assert.equal(r2.status, 400);
    assert.equal(await countedA(), 12);
});
await test('التصفير بالتأكيد يحفظ نسخة، والاسترجاع يرجّع الكميات', async () => {
    const r = await api('POST', '/api/stock/clear', { store_no: A, confirm_text: R.CONFIRM_WORD });
    assert.equal(r.data.success, true);
    assert.equal(await countedA(), 0);
    const t = await api('GET', `/api/stock/trash?store_no=${A}`);
    assert.equal(t.data.batches.length, 1);
    const rr = await api('POST', '/api/stock/trash/restore', { store_no: A });
    assert.equal(rr.data.success, true, JSON.stringify(rr.data));
    assert.equal(await countedA(), 12);
});
await test('حذف بند واحد يمكن استرجاعه', async () => {
    const e = await one("SELECT id FROM stocktake_entries WHERE store_no = ? AND product_code = '10002'", A);
    await api('POST', '/api/stock/delete-item', { store_no: A, entry_id: e.id });
    assert.equal(await countedA(), 8);
    await api('POST', '/api/stock/trash/restore', { store_no: A });
    assert.equal(await countedA(), 12);
});
await test('صيدلية محذوفة تتحول لصيدلية موجودة بدل صيدلية شبح فارغة', async () => {
    pid = 2;
    await api('POST', '/api/stock/stores/create', { store_name: 'P2' });
    pid = 1;
    await DB.prepare('DELETE FROM profiles WHERE id = 1').run();
    const r = await api('GET', '/api/profiles');
    assert.equal(r.data.current_profile_id, 2);
    const s = await api('GET', '/api/stock/stores');
    assert.ok(s.data.created_stores.every(x => x.profile_id === 2));
});
await test('البحث يجد الصنف بالاسم وبالباركود الإضافي', async () => {
    pid = 2;
    assert.equal((await api('GET', '/api/catalog/products?query=PANADOL')).data.items[0].code, '10001');
    assert.equal((await api('GET', '/api/catalog/products?query=6221025000028')).data.items[0].code, '10002');
    assert.equal((await api('GET', '/api/catalog/products?query=br&mode=contains')).data.items[0].code, '10002');
});

await test('رفع مخزون بوضع الإضافة: الموجود لا يتغير والجديد بس يتضاف', async () => {
    pid = 1;
    const prof = (await api('GET', '/api/profiles')).data.current_profile_id;
    pid = prof;
    const S2 = (await api('POST', '/api/stock/stores/create', { store_name: 'merge' })).data.store_no;
    const up2 = async (rows) => {
        const id = 'm' + Math.random().toString(36).slice(2, 8);
        const r = await api('POST', '/api/stock/upload/rows', { store_no: S2, rows, col_idx: COL, replace_existing: false, is_first: true, upload_id: id });
        return api('POST', '/api/stock/upload/finish', { store_no: S2, upload_id: id, replace_existing: false, total_added: r.data.added_count });
    };
    let r = await up2([['10001', 'P', 'B1', 10], ['10002', 'B', 'B2', 5]]);
    assert.equal(r.data.added_count, 2);
    r = await up2([['10001', 'P', 'B1', 99], ['10001', 'P', 'NEWB', 3], ['10003', 'C', 'C1', 7], ['10003', 'C', 'C1', 7]]);
    assert.equal(r.data.added_count, 2, JSON.stringify(r.data));
    assert.equal(r.data.skipped_existing_count, 2);
    assert.equal((await one("SELECT system_qty FROM inventory_records WHERE store_no = ? AND product_code = '10001' AND batch_number = 'B1'", S2)).system_qty, 10);
    assert.equal(await invRows(S2), 4);
});
await test('استيراد كتالوج بوضع الجديد فقط: الموجود لا يتغير والمكرر بالاسم لا يتضاف', async () => {
    const before = (await one('SELECT COUNT(*) AS c FROM products')).c;
    const item = (o) => ({ name_ar: '', name_en: '', scientific_name: '', company: '', category: 'MEDICINE', selling_price: 1, wholesale_price: 0, unit_price: 0,
        tax_rate: 0, unit: 'علبة', unit_divisions: '', barcode_list: [], gtin_list: [], mapped_fields: ['code', 'name_en', 'selling_price'], ...o });
    const r = await api('POST', '/api/catalog/import/commit', { only_new: true, items: [
        item({ code: '10001', name: 'CHANGED', name_en: 'CHANGED', selling_price: 999 }),
        item({ code: '', name: 'BRUFEN 400', name_en: 'BRUFEN 400' }),
        item({ code: '', name: 'NEW PRODUCT X', name_en: 'NEW PRODUCT X' }),
    ] });
    assert.equal(r.data.new_count, 1, JSON.stringify(r.data));
    assert.equal(r.data.skipped_existing_count, 2);
    assert.equal(r.data.updated_count, 0);
    assert.equal((await one("SELECT name FROM products WHERE code = '10001'")).name, 'PANADOL EXTRA');
    assert.equal((await one('SELECT COUNT(*) AS c FROM products')).c, before + 1);
});
await test('نسخة الكتالوج للأجهزة وحزمة مخزون الاستور تعمل', async () => {
    const r = await R.handleCloudApi(new Request('https://rambfe.test/api/catalog/snapshot'), env, { waitUntil() { } }, new URL('https://rambfe.test/api/catalog/snapshot'), null);
    const snap = await r.json();
    assert.equal(snap.count, (await one('SELECT COUNT(*) AS c FROM products')).c);
    assert.ok(snap.cols.includes('code') && snap.barcodes.length === (await one('SELECT COUNT(*) AS c FROM product_barcodes')).c);
    pid = 1;
    const prof = await api('GET', '/api/profiles');
    pid = prof.data.current_profile_id;
    const st = (await api('GET', '/api/stock/stores')).data.created_stores[0].store_no;
    const pack = await api('GET', `/api/stock/offline-pack?store_no=${st}`);
    assert.equal(pack.data.success, true);
    assert.ok(Array.isArray(pack.data.inventory));
});
await test('عدّاد القراءات اليومي يزيد مع الاستعلامات', async () => {
    const u1 = (await api('GET', '/api/cloud/usage')).data;
    await api('GET', '/api/catalog/products?query=PANADOL');
    const O = await import(pathToFileURL(join(APP, 'cloud', 'offline_support.js')).href);
    await O.flushReadCounter(DB, true);
    const u2 = (await api('GET', '/api/cloud/usage')).data;
    assert.ok(u2.reads_today > u1.reads_today, `${u1.reads_today} -> ${u2.reads_today}`);
    assert.equal(u2.daily_limit, 5000000);
});

await dispose();
try { rmSync(dir, { recursive: true, force: true }); } catch (_) { }
console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
