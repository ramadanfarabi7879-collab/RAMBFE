// وضع عدم الاتصال (Offline mode) ووضع التوفير.
//
// يعمل كطبقة بين الصفحة والسحابة (يغلّف fetch): لما السحابة ترد "قاعدة البيانات غير متاحة" (الحد اليومي خلص)
// أو الإنترنت يقطع، البرنامج يكمل على نسخة محفوظة على الجهاز:
//   - دليل الأصناف كامل (الكتالوج المدمج مع الموقع + التغييرات بعده فقط من /api/catalog/changes)
//   - تفاصيل كل استور اتفتح ورصيد مخزونه (لاختيار التشغيلة)
//   - المسح والكميات بتتحفظ على الجهاز في "طابور" وتتبعت للسحابة بالترتيب أول ما الاتصال يرجع
// ووضع التوفير: لما السحابة تقول إن حصة اليوم قاربت تخلص، البحث في الأصناف يتم من النسخة المحفوظة على الجهاز.
//
// يُحمّل قبل profile.js حتى يكون أقرب طبقة للشبكة (يرى رقم الصيدلية في رأس الطلب).
(function () {
    'use strict';
    if (window.__rambfeOffline) return;
    window.__rambfeOffline = true;
    const origFetch = window.fetch.bind(window);

    // ---------------- التخزين على الجهاز (IndexedDB) ----------------
    let dbp = null;
    const mem = { kv: new Map(), outbox: [], seq: 1 }; // بديل في الذاكرة لو IndexedDB غير متاح (تصفح خاص)
    function idb() {
        if (!('indexedDB' in window)) return Promise.resolve(null);
        return dbp || (dbp = new Promise((res) => {
            try {
                const r = indexedDB.open('rambfe-offline', 1);
                r.onupgradeneeded = () => {
                    const d = r.result;
                    if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
                    if (!d.objectStoreNames.contains('outbox')) d.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
                };
                r.onsuccess = () => res(r.result);
                r.onerror = () => res(null);
                r.onblocked = () => res(null);
            } catch (_) { res(null); }
        }));
    }
    function reqP(req) { return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); }); }
    async function store(name, mode) { const d = await idb(); return d ? d.transaction(name, mode).objectStore(name) : null; }
    async function kvGet(k) {
        try { const s = await store('kv', 'readonly'); if (s) return await reqP(s.get(k)); } catch (_) { }
        return mem.kv.get(k);
    }
    async function kvSet(k, v) {
        try { const s = await store('kv', 'readwrite'); if (s) { await reqP(s.put(v, k)); return; } } catch (_) { }
        mem.kv.set(k, v);
    }
    async function kvDel(k) {
        try { const s = await store('kv', 'readwrite'); if (s) { await reqP(s.delete(k)); return; } } catch (_) { }
        mem.kv.delete(k);
    }
    async function outboxAll() {
        try { const s = await store('outbox', 'readonly'); if (s) return await reqP(s.getAll()); } catch (_) { }
        return mem.outbox.slice();
    }
    async function outboxAdd(op) {
        try { const s = await store('outbox', 'readwrite'); if (s) { await reqP(s.add(op)); return; } } catch (_) { }
        mem.outbox.push({ ...op, seq: mem.seq++ });
    }
    async function outboxDel(seq) {
        try { const s = await store('outbox', 'readwrite'); if (s) { await reqP(s.delete(seq)); return; } } catch (_) { }
        mem.outbox = mem.outbox.filter(o => o.seq !== seq);
    }

    // ---------------- أدوات ----------------
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
    const r2 = (v) => Math.round(num(v) * 100) / 100;
    const up = (v) => String(v ?? '').trim().toUpperCase();
    const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
    let tempSeq = 0;
    const tempId = () => -(Date.now() * 10 + (tempSeq++ % 10));
    const pidNow = () => { try { return localStorage.getItem('rambfe_profile_id') || '1'; } catch (_) { return '1'; } };
    function jsonRes(data, status = 200) {
        return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Rambfe-Offline': '1' } });
    }
    const NEEDS_ONLINE = 'العملية دي محتاجة اتصال بالسحابة. الجرد (المسح وإدخال الكميات) شغال بدون اتصال وبيتزامن تلقائياً.';
    let qrP = null;
    // قارئ أكواد GS1 (نفس كود السحابة). يُحمّل أول ما الصفحة تفتح وهي متصلة ويفضل في الذاكرة لو النت قطع
    const qr = () => qrP || (qrP = import('/cloud-qr.js').catch((e) => { qrP = null; throw e; }));

    // ---------------- الحالة والشريط ----------------
    const state = { offline: false, economyUntil: 0, pending: 0, syncing: false, lastError: '' };
    const economy = () => Date.now() < state.economyUntil;
    function banner() {
        let el = document.getElementById('rambfe-offline-pill');
        if (!el) {
            if (!document.body) return;
            el = document.createElement('div');
            el.id = 'rambfe-offline-pill';
            el.style.cssText = 'position:fixed;bottom:calc(76px + env(safe-area-inset-bottom));left:12px;z-index:99999;max-width:calc(100vw - 24px);' +
                'padding:7px 12px;border-radius:999px;font:700 12px/1.5 Cairo,system-ui,Tahoma,sans-serif;direction:rtl;box-shadow:0 4px 14px rgba(0,0,0,.25);display:none;cursor:pointer';
            el.onclick = () => { flush(true); };
            document.body.appendChild(el);
        }
        let txt = '', bg = '';
        if (state.syncing) { txt = `🔄 جاري مزامنة ${state.pending} عملية جرد مع السحابة…`; bg = '#1d4ed8'; }
        else if (state.offline) { txt = `📴 وضع عدم الاتصال: الجرد بيتحفظ على الجهاز${state.pending ? ` (${state.pending} عملية في الانتظار)` : ''} وهيتزامن تلقائياً`; bg = '#b45309'; }
        else if (state.pending) { txt = `⏳ ${state.pending} عملية جرد في انتظار المزامنة — اضغط للمزامنة الآن`; bg = '#b45309'; }
        else if (economy()) { txt = '🔋 وضع التوفير: البحث من النسخة المحفوظة على الجهاز (حصة اليوم قاربت تخلص)'; bg = '#047857'; }
        el.style.display = txt ? 'block' : 'none';
        el.style.background = bg; el.style.color = '#fff';
        el.textContent = txt;
    }
    async function refreshPending() { state.pending = (await outboxAll()).length; banner(); }
    function setOffline(v) { if (state.offline !== v) { state.offline = v; banner(); } }
    function notify(msg) {
        try { if (typeof window.showCatalogToast === 'function') { window.showCatalogToast(msg); return; } } catch (_) { }
        try { alert(msg); } catch (_) { }
    }

    // ---------------- دليل الأصناف المحفوظ ----------------
    const norm = (s) => String(s ?? '').toLowerCase().replace(/[ً-ْـ]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+/g, ' ').trim();
    let catalog = null, catalogP = null;
    function buildCatalog(snap) {
        const ci = Object.fromEntries(snap.cols.map((c, i) => [c, i]));
        const list = snap.products.map(r => {
            const p = {}; for (const c of snap.cols) p[c] = r[ci[c]];
            p.code = String(p.code ?? ''); p.gtin_list = []; p.barcode_list = [];
            return p;
        });
        const byCode = new Map(list.map(p => [p.code, p]));
        for (const [code, bc, isG] of snap.barcodes || []) {
            const p = byCode.get(String(code)); if (!p) continue;
            const arr = isG ? p.gtin_list : p.barcode_list; if (!arr.includes(bc)) arr.push(bc);
        }
        const byBarcode = new Map();
        const addBc = (b, p) => {
            b = String(b || '').trim(); if (!b) return;
            if (!byBarcode.has(b)) byBarcode.set(b, p);
            if (b.length === 14 && b.startsWith('0') && !byBarcode.has(b.slice(1))) byBarcode.set(b.slice(1), p);
            if (b.length === 13 && /^\d+$/.test(b) && !byBarcode.has('0' + b)) byBarcode.set('0' + b, p);
        };
        for (const p of list) {
            for (const g of String(p.gtin || '').split(/[,;\s]+/)) if (g && !p.gtin_list.includes(g)) p.gtin_list.push(g);
            for (const b of String(p.barcode || '').split(/[,;\s]+/)) if (b && !p.barcode_list.includes(b) && !p.gtin_list.includes(b)) p.barcode_list.push(b);
            for (const b of [...p.gtin_list, ...p.barcode_list]) addBc(b, p);
            Object.defineProperty(p, '_f', { value: [p.name_en, p.name_ar, p.name, p.scientific_name, p.company, p.category].map(norm), enumerable: false });
            Object.defineProperty(p, '_b', { value: [...p.gtin_list, ...p.barcode_list], enumerable: false });
        }
        return {
            generated_at: snap.generated_at, list, byCode, byBarcode,
            code: (c) => { c = String(c || '').trim(); return byCode.get(c) || byCode.get(c.replace(/^0+/, '')) || (/^\d+$/.test(c) ? byCode.get(c.padStart(10, '0')) : null) || null; },
            barcode: (b) => byBarcode.get(String(b || '').trim()) || null,
        };
    }
    // الكتالوج الأساسي المدمج في البرنامج (من product.template.xlsx): ملف ثابت مع الموقع، يشتغل حتى لو السحابة واقفة
    async function loadBaseCatalog() {
        try {
            const res = await origFetch('/base-catalog.json');
            if (!res.ok) return null;
            const snap = await res.json();
            if (!snap || !Array.isArray(snap.products) || !snap.products.length) return null;
            await kvSet('catalog', snap);
            // التغييرات بعد وقت بناء الكتالوج المدمج بتتجاب من /api/catalog/changes
            await kvSet('catalog_meta', { base: true, base_generated_at: snap.generated_at, generated_at: snap.generated_at, count: snap.count, changes_ts: snap.generated_at / 1000 });
            return snap;
        } catch (_) { return null; }
    }
    async function getCatalog() {
        if (catalog) return catalog;
        if (!catalogP) catalogP = (async () => {
            let snap = await kvGet('catalog');
            if (!snap || !snap.products) snap = await loadBaseCatalog();
            if (snap && snap.products) catalog = buildCatalog(snap);
            return catalog;
        })().finally(() => { catalogP = null; });
        return catalogP;
    }
    // تحديث الكتالوج المحفوظ: الكتالوج المدمج مع الموقع + التغييرات اللي حصلت بعده بس (بضع صفوف بدل 92 ألف)
    function applyChanges(snap, ch) {
        const codeIdx = snap.cols.indexOf('code');
        const changed = new Set((ch.changed_codes || []).map(String));
        snap.products = snap.products.filter(r => !changed.has(String(r[codeIdx])));
        const cci = Object.fromEntries((ch.cols || []).map((c, i) => [c, i]));
        for (const r of ch.products || []) snap.products.unshift(snap.cols.map(c => cci[c] !== undefined ? r[cci[c]] : null));
        snap.barcodes = (snap.barcodes || []).filter(x => !changed.has(String(x[0]))).concat(ch.barcodes || []);
        snap.count = snap.products.length;
    }
    async function downloadCatalog(force = false) {
        try {
            let meta = (await kvGet('catalog_meta')) || {};
            if (!force && meta.checked_at && Date.now() - meta.checked_at < 10 * 60 * 1000) return;
            // تحديث للموقع نزّل كتالوج مدمج أحدث؟
            const vr = await origFetch('/base-catalog.version.json', { cache: 'no-store' }).catch(() => null);
            const ver = vr && vr.ok ? await vr.json().catch(() => null) : null;
            if (ver && ver.generated_at && ver.generated_at !== meta.base_generated_at) {
                const base = await loadBaseCatalog();
                if (base) { catalog = buildCatalog(base); meta = (await kvGet('catalog_meta')) || {}; }
            }
            let snap = await kvGet('catalog');
            if (!snap || !snap.products) { await getCatalog(); snap = await kvGet('catalog'); meta = (await kvGet('catalog_meta')) || {}; }
            if (!snap || !snap.products) return;
            let since = meta.changes_ts || ((meta.base_generated_at || meta.generated_at || 0) / 1000);
            let applied = 0;
            for (let i = 0; i < 5; i++) {
                const res = await origFetch(`/api/catalog/changes?since_ts=${encodeURIComponent(since)}`, { cache: 'no-store' });
                noteEconomy(res);
                if (!res.ok) break;
                const ch = await res.json();
                if (!ch || !ch.success) break;
                if (!ch.full_reset) { applyChanges(snap, ch); applied += (ch.changed_codes || []).length; }
                since = ch.max_ts;
                if (!ch.more) break;
            }
            if (applied) { await kvSet('catalog', snap); catalog = buildCatalog(snap); }
            await kvSet('catalog_meta', { ...meta, changes_ts: since, checked_at: Date.now(), count: snap.count });
        } catch (_) { if (!(await kvGet('catalog'))) await getCatalog(); }
    }
    function publicProduct(p) { const o = {}; for (const k of Object.keys(p)) o[k] = p[k]; return o; }
    function localSearch(cat, rawQ, mode, limit, offset) {
        const q = String(rawQ || '').trim();
        const contains = ['contains', 'generalized', 'all', 'true', '1'].includes(String(mode || '').toLowerCase());
        if (!q) return { items: cat.list.slice(offset, offset + limit).map(publicProduct), total: cat.list.length, limit, offset, offline_search: true };
        const nq = norm(q), words = nq.split(' ').filter(Boolean), digits = q.replace(/\s+/g, '');
        const isDig = /^\d+$/.test(digits), stripped = digits.replace(/^0+/, '');
        const hits = [];
        for (const p of cat.list) {
            let rank = 0;
            if (p.code === q) rank = 1;
            else if (p.code.startsWith(q) || (isDig && stripped && p.code.replace(/^0+/, '') === stripped)) rank = 2;
            else if (isDig && p._b.includes(digits)) rank = 5;
            else {
                const f = p._f;
                const ok = words.length && words.every((w, i) => f.some(x => x && ((contains || i > 0) ? x.includes(w) : (x.startsWith(w) || x.includes(' ' + w)))));
                if (ok) rank = f[0] && f[0].startsWith(words[0]) ? 3 : (f[1] && f[1].startsWith(words[0]) ? 4 : 7);
                else if (isDig && digits.length >= 4 && p._b.some(b => contains ? b.includes(digits) : b.startsWith(digits))) rank = 6;
            }
            if (rank) hits.push([rank, p]);
        }
        hits.sort((a, b) => a[0] - b[0] || num(b[1].id) - num(a[1].id));
        return { items: hits.slice(offset, offset + limit).map(h => publicProduct(h[1])), total: hits.length, limit, offset, offline_search: true };
    }

    // ---------------- بيانات الاستورات المحفوظة ----------------
    const dKey = (pid, sn) => `details:${pid}:${sn}`;
    async function lastStore(pid) { return (await kvGet(`laststore:${pid}`)) || ''; }
    async function getDetails(pid, sn) {
        sn = String(sn || '').trim() || await lastStore(pid);
        return sn ? await kvGet(dKey(pid, sn)) : null;
    }
    async function saveDetails(pid, requested, d) {
        if (!d || !Array.isArray(d.items)) return;
        const sn = (d.store && d.store.store_no) || (d.stats && d.stats.store_no) || requested;
        if (!sn) return;
        await kvSet(dKey(pid, sn), d);
        if (requested && requested !== sn) await kvSet(dKey(pid, requested), d);
        await kvSet(`laststore:${pid}`, sn);
        maybeFetchPack(pid, sn);
    }
    function recompute(d) {
        const items = d.items || [], st = d.stats || (d.stats = {});
        const cq = items.reduce((s, i) => s + num(i.counted_qty), 0);
        const cc = items.reduce((s, i) => s + num(i.counted_qty) * num(i.cost_price), 0);
        const cs = items.reduce((s, i) => s + num(i.counted_qty) * num(i.selling_price), 0);
        Object.assign(st, {
            counted_products: new Set(items.map(i => i.product_code)).size, counted_lines: items.length,
            counted_qty: r2(cq), counted_cost: r2(cc), counted_sale: r2(cs),
            diff_cost: r2(cc - num(st.system_cost)), diff_sale: r2(cs - num(st.system_sale)),
            new_batches_count: items.filter(i => num(i.is_new_batch) === 1).length,
        });
        return d;
    }
    const packFetching = new Set();
    async function maybeFetchPack(pid, sn) {
        const k = `pack:${pid}:${sn}`;
        if (economy() || state.offline || packFetching.has(k)) return;
        const pack = await kvGet(k);
        if (pack && Date.now() - pack.fetched_at < 24 * 3600 * 1000) return;
        packFetching.add(k);
        try {
            const res = await origFetch(`/api/stock/offline-pack?store_no=${encodeURIComponent(sn)}`, { headers: { 'X-Profile-Id': String(pid) }, cache: 'no-store' });
            noteEconomy(res);
            if (res.ok) { const d = await res.json(); if (d && d.success) await kvSet(k, { fetched_at: Date.now(), inventory: d.inventory || [] }); }
        } catch (_) { } finally { packFetching.delete(k); }
    }
    async function packRows(pid, sn, code) {
        const pack = await kvGet(`pack:${pid}:${sn}`);
        const c = String(code);
        return pack ? pack.inventory.filter(r => String(r.product_code) === c) : [];
    }

    // ---------------- عمليات الجرد بدون اتصال ----------------
    function newEntry(d, sn, p, f) {
        const e = {
            id: tempId(), product_code: p.code, product_name: p.name_en || p.name || '', barcode: p.barcode_list[0] || '', gtin: p.gtin_list[0] || '',
            batch_number: up(f.batch), expiry_date: f.expiry || '', system_qty: num(f.system_qty), counted_qty: num(f.counted_qty),
            cost_price: num(f.cost_price || p.cost_price), selling_price: num(f.selling_price || p.selling_price || p.unit_price),
            is_new_batch: f.is_new_batch ? 1 : 0, item_type: 'medicine', store_no: sn, created_at: now(), updated_at: now(), offline_pending: true,
        };
        d.items.unshift(e);
        return e;
    }
    async function offlineScan(pid, body, path) {
        if (path === '/api/mobile/scan' && String(body.target || 'stocktake') !== 'stocktake') return jsonRes({ success: false, offline_mode: true, message: 'مسح الفواتير محتاج اتصال بالسحابة. مسح الجرد شغال بدون اتصال.' }, 503);
        const [Q, cat] = await Promise.all([qr(), getCatalog()]);
        if (!cat) return jsonRes({ success: false, offline_mode: true, message: 'دليل الأصناف لسه متحملش على الجهاز: افتح البرنامج مرة وانت متصل بالإنترنت.' }, 503);
        const d = await getDetails(pid, body.store_no);
        if (!d) return jsonRes({ success: false, offline_mode: true, message: 'الاستور ده لسه متحفظش على الجهاز: افتحه مرة وانت متصل بالإنترنت.' }, 503);
        const sn = d.store.store_no;
        const raw = String(body.code || body.qr_text || '').trim();
        if (!raw) return jsonRes({ success: false, message: 'لم يتم إدخال أو مسح أي كود' });
        let prod = null, gtin = '', serial = '', batch = '', expiry = '', parsed = {};
        if (body.product_code) prod = cat.code(body.product_code);
        else {
            parsed = Q.parseQrCode(raw);
            const pd = parsed.success ? (parsed.data || {}) : {};
            gtin = pd.gtin || ''; serial = up(pd.serial); batch = up(pd.batch); expiry = pd.expiry || '';
            if (!gtin) gtin = Q.extractCleanGtin(raw) || Q.cleanBarcodePreserveZeros(raw);
            const cn = Q.cleanNumericCode(raw);
            if (cn && cn.length <= 8 && Q.isDigitStr(raw)) prod = cat.code(cn);
            if (!prod && gtin) prod = cat.barcode(gtin);
            if (!prod) prod = cat.code(Q.cleanNumericCode(raw));
            if (!prod) prod = cat.barcode(Q.cleanBarcodePreserveZeros(raw));
        }
        if (!prod) return jsonRes({ success: false, is_unregistered: true, raw, message: `الصنف غير مسجل في بطاقات الأصناف (الكود: ${gtin || raw})` });
        const pName = prod.name_en || prod.name || '';
        if (serial) {
            const sk = `serials:${pid}:${sn}`;
            const seen = (await kvGet(sk)) || [];
            if (seen.includes(`${prod.code}|${serial}`)) return jsonRes({ success: false, is_duplicate_serial: true, serial, product_code: prod.code, product_name: pName, message: `⚠️ تنبيه: العبوة ذات السيريال (${serial}) تم مسحها مسبقاً! تم منع تكرار الحساب.` });
            seen.push(`${prod.code}|${serial}`); await kvSet(sk, seen.slice(-5000));
        }
        const inv = await packRows(pid, sn, prod.code);
        const mine = d.items.filter(i => String(i.product_code) === prod.code);
        const is2d = Boolean(parsed.success && (batch || serial));
        if (!is2d && !body.force_direct) {
            // نفس شاشة اختيار التشغيلة: من رصيد المخزون المحفوظ + بنود الجرد الحالية
            const bm = new Map();
            for (const r of inv) {
                const key = `${up(r.batch_number)}\u0000${String(r.expiry_date || '').trim()}`;
                if (!bm.has(key)) bm.set(key, { batch_number: up(r.batch_number) || '-', expiry_date: r.expiry_date || '-', system_qty: num(r.system_qty), counted_qty: 0, cost_price: num(r.cost_price || prod.cost_price), selling_price: num(r.selling_price || prod.selling_price), entry_id: null, is_new_batch: 0 });
                else bm.get(key).system_qty += num(r.system_qty);
            }
            for (const s of mine) {
                const key = `${up(s.batch_number)}\u0000${String(s.expiry_date || '').trim()}`;
                if (bm.has(key)) Object.assign(bm.get(key), { counted_qty: num(s.counted_qty), entry_id: s.id });
                else bm.set(key, { batch_number: up(s.batch_number) || '-', expiry_date: s.expiry_date || '-', system_qty: num(s.system_qty), counted_qty: num(s.counted_qty), cost_price: num(s.cost_price), selling_price: num(s.selling_price), entry_id: s.id, is_new_batch: s.is_new_batch || 1 });
            }
            const dt = new Date(), autoBatch = `B${String(dt.getFullYear()).slice(2)}${String(dt.getMonth() + 1).padStart(2, '0')}-01`;
            if (!bm.size) bm.set('-', { batch_number: autoBatch, expiry_date: '', system_qty: 0, counted_qty: 0, cost_price: num(prod.cost_price), selling_price: num(prod.selling_price), entry_id: null, is_new_batch: 1, is_manual_batch: 1, requires_manual_entry: true });
            return jsonRes({ success: true, requires_batch_entry: true, offline_mode: true, store_no: sn, batches: [...bm.values()],
                product: { code: prod.code, name: pName, barcode: prod.barcode_list[0] || '', gtin: gtin || prod.gtin_list[0] || '', item_type: 'medicine', cost_price: num(prod.cost_price), selling_price: num(prod.selling_price) } });
        }
        let e;
        if (batch) {
            e = mine.find(i => up(i.batch_number) === batch);
            const ir = inv.find(r => up(r.batch_number) === batch);
            if (e) e.counted_qty = num(e.counted_qty) + 1;
            else e = newEntry(d, sn, prod, { batch, expiry: expiry || (ir ? ir.expiry_date : ''), system_qty: ir ? ir.system_qty : 0, counted_qty: 1, cost_price: ir && ir.cost_price, selling_price: ir && ir.selling_price, is_new_batch: !ir });
        } else {
            e = mine.find(i => num(i.counted_qty) < num(i.system_qty)) || mine[0];
            if (e) e.counted_qty = num(e.counted_qty) + 1;
            else { const ir = inv[0]; e = newEntry(d, sn, prod, { batch: ir ? ir.batch_number : '', expiry: ir ? ir.expiry_date : '', system_qty: ir ? ir.system_qty : 0, counted_qty: 1 }); }
        }
        e.updated_at = now(); e.offline_pending = true;
        if (d.store) d.store.status = 'in_progress';
        recompute(d);
        await saveDetails(pid, sn, d);
        await queue(pid, path, body, sn);
        return jsonRes({
            success: true, requires_batch_entry: false, direct_scan: true, offline_mode: true, entry_id: e.id, product_code: prod.code, product_name: pName,
            batch_number: e.batch_number, expiry_date: e.expiry_date, serial, system_qty: num(e.system_qty), counted_qty: num(e.counted_qty),
            cost_price: num(e.cost_price), selling_price: num(e.selling_price), is_new_batch: Boolean(e.is_new_batch),
            message: `📴 تم الجرد على الجهاز: ${pName} | باتش: ${e.batch_number || '-'} | الفعلي: ${num(e.counted_qty)} (هيتزامن تلقائياً)`, store_details: d,
        });
    }
    async function offlineSave(pid, body, path) {
        const [cat, d] = await Promise.all([getCatalog(), getDetails(pid, body.store_no)]);
        if (!d) return jsonRes({ success: false, offline_mode: true, message: 'الاستور ده لسه متحفظش على الجهاز: افتحه مرة وانت متصل بالإنترنت.' }, 503);
        const sn = d.store.store_no;
        let b = up(body.batch_number); if (b === '-') b = '';
        let exp = String(body.expiry_date || '').trim(); if (exp === '-') exp = '';
        const counted = num(body.counted_qty);
        let e = body.entry_id ? d.items.find(i => i.id === Number(body.entry_id)) : null;
        if (!e) e = d.items.find(i => String(i.product_code) === String(body.product_code) && up(i.batch_number) === b);
        if (e) {
            e.counted_qty = counted;
            if (b) e.batch_number = b;
            if (exp) e.expiry_date = exp;
        } else {
            const p = (cat && cat.code(body.product_code)) || { code: String(body.product_code), name_en: '', name: '', barcode_list: [], gtin_list: [] };
            const ir = (await packRows(pid, sn, p.code)).find(r => up(r.batch_number) === b);
            e = newEntry(d, sn, p, { batch: b, expiry: exp || (ir ? ir.expiry_date : ''), system_qty: ir ? ir.system_qty : body.system_qty, counted_qty: counted,
                cost_price: (ir && ir.cost_price) || body.cost_price, selling_price: (ir && ir.selling_price) || body.selling_price, is_new_batch: !ir && b });
        }
        e.updated_at = now(); e.offline_pending = true;
        recompute(d);
        await saveDetails(pid, sn, d);
        const qb = { ...body, store_no: sn };
        if (Number(qb.entry_id) < 0) delete qb.entry_id; // بند اتعمل بدون اتصال: السحابة تلاقيه بالصنف والتشغيلة
        await queue(pid, '/api/stock/save-batch-qty', qb, sn);
        return jsonRes({ success: true, requires_batch_entry: false, direct_scan: true, offline_mode: true, entry_id: e.id,
            message: `📴 تم الحفظ على الجهاز: ${e.product_name || e.product_code} | تشغيلة: ${e.batch_number || '-'} | الفعلي: ${counted} (هيتزامن تلقائياً)`, store_details: d });
    }
    async function offlineUpdateQty(pid, body) {
        const d = await getDetails(pid, body.store_no);
        if (!d) return jsonRes({ success: false, offline_mode: true, message: 'الاستور ده لسه متحفظش على الجهاز.' }, 503);
        const id = Number(body.entry_id || body.id), qty = num(body.quantity ?? body.qty);
        const e = d.items.find(i => i.id === id);
        if (!e) return jsonRes({ success: false, offline_mode: true, message: 'البند غير موجود في النسخة المحفوظة على الجهاز.' });
        e.counted_qty = qty; e.updated_at = now(); e.offline_pending = true;
        recompute(d);
        await saveDetails(pid, d.store.store_no, d);
        if (id < 0) await queue(pid, '/api/stock/save-batch-qty', { store_no: d.store.store_no, product_code: e.product_code, batch_number: e.batch_number, expiry_date: e.expiry_date, counted_qty: qty }, d.store.store_no);
        else await queue(pid, '/api/stock/update-qty', { ...body, store_no: d.store.store_no }, d.store.store_no);
        return jsonRes({ success: true, offline_mode: true, store_details: d });
    }
    async function offlineStoreSearch(pid, u) {
        const d = await getDetails(pid, u.searchParams.get('store_no'));
        if (!d) return null;
        const q = norm(u.searchParams.get('query') || u.searchParams.get('q') || '');
        const items = q ? d.items.filter(i => [i.product_code, i.product_name, i.barcode, i.gtin, i.batch_number].some(x => norm(x).includes(q))) : d.items;
        return jsonRes({ success: true, offline_mode: true, query: q, store_no: d.store.store_no, store: d.store, items, product_summaries: [],
            store_details: { store: d.store, items, stats: d.stats } });
    }

    // ملف (مخزون أو كتالوج) اترفع والسحابة مش متاحة: يتحفظ على الجهاز كما هو ويترفع لما الاتصال يرجع
    async function queueFile(file, storeNo) {
        await outboxAdd({ kind: 'file-upload', pid: String(pidNow()), file, file_name: file.name || 'file.xlsx', store_no: storeNo || '', ts: Date.now() });
        setOffline(true);
        await refreshPending();
        scheduleFlush(60000);
    }
    async function queue(pid, path, body, sn) {
        await outboxAdd({ pid: String(pid), path, body, store_no: sn, ts: Date.now() });
        await refreshPending();
        scheduleFlush(15000);
    }

    // ---------------- المزامنة ----------------
    let flushing = null, flushTimer = null;
    function scheduleFlush(ms) { clearTimeout(flushTimer); flushTimer = setTimeout(() => flush(), ms); }
    const isDbDown = (status, data) => status === 503 || (data && (data.db_unavailable || data.offline_reconnecting));
    function flush(manual = false) {
        if (flushing) return flushing;
        flushing = (async () => {
            const ops = await outboxAll();
            if (!ops.length) { await refreshPending(); return true; }
            state.syncing = true; state.pending = ops.length; banner();
            const touched = new Set();
            let stopped = false;
            for (const op of ops) {
                if (op.kind === 'file-upload') {
                    // يترفع بنفس صيدلية وقت الاختيار: لو المستخدم على صيدلية تانية دلوقتي يستنى لحد ما يرجع لها
                    if (op.pid !== String(pidNow()) || !window.RambfeProfiles || !window.RambfeProfiles.uploadStockFile) continue;
                    try {
                        const r = await window.RambfeProfiles.uploadStockFile(op.file, op.store_no, null, { fromQueue: true });
                        state.lastError = '';
                        notify(`✅ تم رفع الملف المؤجل (${op.file_name}): ${r && r.message ? r.message : ''}`);
                    } catch (e) {
                        if (e && e.offline) { stopped = true; break; }
                        state.lastError = e && e.message || '';
                        notify(`⚠️ تعذر رفع الملف المؤجل (${op.file_name}): ${state.lastError}`);
                    }
                    await outboxDel(op.seq);
                    touched.add(`${op.pid}|${op.store_no}`);
                    state.pending = Math.max(0, state.pending - 1); banner();
                    continue;
                }
                let res, data = null;
                try {
                    res = await origFetch(op.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Profile-Id': op.pid }, body: JSON.stringify(op.body) });
                    data = await res.clone().json().catch(() => null);
                } catch (_) { stopped = true; break; }
                noteEconomy(res);
                if (isDbDown(res.status, data)) { stopped = true; break; }
                // نجحت، أو رفضتها السحابة نهائياً (مثلاً سيريال اتمسح قبل كده من جهاز تاني): تخرج من الطابور في الحالتين
                if (data && data.success === false) state.lastError = data.message || '';
                await outboxDel(op.seq);
                touched.add(`${op.pid}|${op.store_no}`);
                state.pending = Math.max(0, state.pending - 1); banner();
            }
            state.syncing = false;
            setOffline(stopped);
            await refreshPending();
            if (touched.size) await afterSync(touched);
            if (stopped) scheduleFlush(manual ? 30000 : 60000);
            return !stopped;
        })().finally(() => { flushing = null; });
        return flushing;
    }
    async function afterSync(touched) {
        // تحديث النسخة المحفوظة من السحابة (فيها الأرقام النهائية بعد دمج شغل كل الأجهزة)
        for (const t of touched) {
            const [pid, sn] = t.split('|');
            if (!sn) continue;
            try {
                const res = await origFetch(`/api/stock/store/details?store_no=${encodeURIComponent(sn)}`, { headers: { 'X-Profile-Id': pid }, cache: 'no-store' });
                if (res.ok) await saveDetails(pid, sn, await res.json());
            } catch (_) { }
        }
        try { if (typeof window.loadCurrentStoreItems === 'function') window.loadCurrentStoreItems(); } catch (_) { }
        try { if (typeof window.loadStocktakeStores === 'function') window.loadStocktakeStores(); } catch (_) { }
        try { if (typeof window.loadStoreItems === 'function') window.loadStoreItems(false); } catch (_) { }
        window.dispatchEvent(new CustomEvent('rambfe-offline-synced'));
    }

    // ---------------- التعامل مع الاستجابات ----------------
    function noteEconomy(res) {
        try {
            if (res && res.headers && res.headers.get('X-Rambfe-Economy') === '1') {
                const was = economy(); state.economyUntil = Date.now() + 10 * 60 * 1000; if (!was) banner();
            }
        } catch (_) { }
    }
    const GENERIC_GET = new Set(['/api/stats', '/api/profiles', '/api/invoice/active', '/api/invoices/list', '/api/stock/uncounted', '/api/stock/trash', '/api/network-info']);
    async function learn(pid, u, method, body, res) {
        try {
            const path = u.pathname;
            if (method === 'GET' && path === '/api/stock/store/details' && !u.searchParams.get('query') && !u.searchParams.get('q')) {
                await saveDetails(pid, u.searchParams.get('store_no') || '', await res.json());
            } else if (method === 'GET' && path === '/api/stock/stores' && !u.searchParams.get('q') && !u.searchParams.get('query')) {
                await kvSet(`stores:${pid}`, await res.json());
            } else if (method === 'GET' && GENERIC_GET.has(path)) {
                await kvSet(`get:${pid}:${path}${u.search}`, await res.json());
            } else if (method === 'POST') {
                const d = await res.json();
                if (d && d.store_details && Array.isArray(d.store_details.items) && !(body && body.query)) await saveDetails(pid, (body && body.store_no) || '', d.store_details);
                if (path === '/api/stock/upload/finish' && d && d.success) await kvDel(`pack:${pid}:${(d.store_details && d.store_details.store && d.store_details.store.store_no) || body.store_no}`);
            }
        } catch (_) { }
    }
    async function handleOffline(pid, u, method, body) {
        const path = u.pathname;
        if (method === 'GET') {
            if (path === '/api/health') return jsonRes({ healthy: true, success: true, offline_mode: true });
            if (path === '/api/sync/events' || path === '/api/mobile/poll') return jsonRes({ events: [], scans: [], timestamp: Date.now() / 1000, offline_mode: true });
            if (path === '/api/catalog/products' || path === '/api/stock/preinventory-search') {
                const cat = await getCatalog(); if (!cat) return null;
                const lim = parseInt(u.searchParams.get('limit') || '50', 10) || 50, off = parseInt(u.searchParams.get('offset') || '0', 10) || 0;
                return jsonRes(localSearch(cat, u.searchParams.get('query') || u.searchParams.get('q') || '', u.searchParams.get('mode') || 'start', lim, off));
            }
            if (path === '/api/catalog/product') {
                const cat = await getCatalog(); const p = cat && cat.code(u.searchParams.get('code'));
                return p ? jsonRes({ success: true, product: publicProduct(p), offline_mode: true }) : jsonRes({ success: false, message: 'الصنف غير موجود في النسخة المحفوظة على الجهاز' }, 404);
            }
            if (path === '/api/stock/store/details') {
                if (u.searchParams.get('query') || u.searchParams.get('q')) return offlineStoreSearch(pid, u);
                const d = await getDetails(pid, u.searchParams.get('store_no')); return d ? jsonRes({ ...d, offline_mode: true }) : null;
            }
            if (path === '/api/stock/store/search') return offlineStoreSearch(pid, u);
            if (path === '/api/stock/stores') { const s = await kvGet(`stores:${pid}`); return s ? jsonRes({ ...s, offline_mode: true }) : null; }
            if (GENERIC_GET.has(path)) { const g = await kvGet(`get:${pid}:${path}${u.search}`); return g ? jsonRes(g) : null; }
            return null;
        }
        if (path === '/api/stock/scan' || path === '/api/mobile/scan') return offlineScan(pid, body || {}, path);
        if (path === '/api/stock/save-batch-qty') return offlineSave(pid, body || {}, path);
        if (path === '/api/stock/update-qty') return offlineUpdateQty(pid, body || {});
        return jsonRes({ success: false, offline_mode: true, message: NEEDS_ONLINE }, 503);
    }
    const QUEUEABLE = new Set(['/api/stock/scan', '/api/mobile/scan', '/api/stock/save-batch-qty', '/api/stock/update-qty']);
    const LOCAL_FIRST = new Set(['/api/catalog/products', '/api/stock/preinventory-search', '/api/catalog/product']);

    function readPid(input, init) {
        try {
            const h = (init && init.headers) || (input && typeof input !== 'string' && input.headers);
            if (h) {
                const v = typeof h.get === 'function' ? h.get('X-Profile-Id') : (h['X-Profile-Id'] || h['x-profile-id']);
                if (v) return String(v);
            }
        } catch (_) { }
        return pidNow();
    }
    function readBody(init) {
        try { if (init && typeof init.body === 'string') return JSON.parse(init.body); } catch (_) { }
        return null;
    }

    window.fetch = async function (input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input || '');
        let u;
        try { u = new URL(url, location.href); } catch (_) { return origFetch(input, init); }
        if (u.origin !== location.origin || !u.pathname.startsWith('/api/') || u.pathname.startsWith('/api/realtime')) return origFetch(input, init);
        const method = String((init && init.method) || (input && typeof input !== 'string' && input.method) || 'GET').toUpperCase();
        const pid = readPid(input, init), body = readBody(init), path = u.pathname;

        // وضع التوفير أو بدون إنترنت: البحث في الأصناف من النسخة المحفوظة (صفر قراءات من قاعدة البيانات)
        if (method === 'GET' && LOCAL_FIRST.has(path) && (economy() || navigator.onLine === false) && !(path === '/api/stock/preinventory-search' && u.searchParams.get('stock_only') === '1')) {
            const local = await handleOffline(pid, u, method, body);
            if (local) return local;
        }
        // عمليات الجرد تتبعت بالترتيب: لو فيه عمليات قديمة في الطابور نزامنها الأول
        if (method === 'POST' && QUEUEABLE.has(path) && state.pending) {
            await flush();
            if (state.pending) return handleOffline(pid, u, method, body);
        }
        let res;
        try {
            res = await origFetch(input, init);
        } catch (err) {
            setOffline(true);
            const local = await handleOffline(pid, u, method, body);
            if (local) return local;
            throw err;
        }
        noteEconomy(res);
        if (res.status === 503) {
            const data = await res.clone().json().catch(() => null);
            if (data && (data.db_unavailable || data.offline_reconnecting)) {
                setOffline(true);
                const local = await handleOffline(pid, u, method, body);
                if (local) return local;
                return res;
            }
        }
        if (res.ok) {
            if (state.offline) { setOffline(false); if (state.pending) scheduleFlush(500); }
            learn(pid, u, method, body, res.clone());
        }
        return res;
    };

    // ---------------- التشغيل ----------------
    window.addEventListener('online', () => { setOffline(false); flush(); });
    window.addEventListener('offline', () => setOffline(true));
    document.addEventListener('visibilitychange', () => { if (!document.hidden && state.pending) flush(); });
    setInterval(() => { if (state.pending && !state.syncing) flush(); }, 60000);
    function boot() {
        qr().catch(() => { });
        refreshPending().then(() => { if (state.pending) flush(); });
        // تحميل/تحديث نسخة الأصناف في الخلفية بعد ما الصفحة تفتح
        setTimeout(() => downloadCatalog(), 4000);
        if ('serviceWorker' in navigator && location.protocol !== 'file:') {
            navigator.serviceWorker.register('/sw.js').then(reg => {
                const send = () => {
                    const urls = performance.getEntriesByType('resource').map(e => e.name).filter(n => !/\/api\//.test(n));
                    const sw = navigator.serviceWorker.controller || reg.active;
                    if (sw) sw.postMessage({ type: 'cache-urls', urls: [location.href.split('#')[0], location.origin + '/cloud-qr.js', location.origin + '/mobile', location.origin + '/', ...urls] });
                };
                if (document.readyState === 'complete') setTimeout(send, 3000); else window.addEventListener('load', () => setTimeout(send, 3000));
            }).catch(() => { });
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

    window.RambfeOffline = {
        flush, state, queueFile, pending: () => state.pending, downloadCatalog: () => downloadCatalog(true),
        // للاختبارات فقط
        _test: { localSearch, buildCatalog, getCatalog, kvGet, kvSet, outboxAll, handleOffline },
    };
})();
