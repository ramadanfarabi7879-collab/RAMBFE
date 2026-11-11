// الصيدليات (البروفايلات): كل صيدلية لها استوراتها ومخزونها وجردها وفواتيرها المستقلة.
// شريط ثابت أعلى كل الشاشات يوضح الصيدلية الحالية ويسمح بالتبديل والإضافة ورفع المخزون.
(function () {
    const KEY = 'rambfe_profile_id';
    const NAME_KEY = 'rambfe_profile_name';
    const get = (k, d) => { try { return localStorage.getItem(k) || d; } catch (_) { return d; } };
    const set = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { } };
    const currentId = () => parseInt(get(KEY, '1'), 10) || 1;

    // كل طلبات /api/ تحمل رقم الصيدلية الحالية
    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
        try {
            const url = typeof input === 'string' ? input : (input && input.url) || '';
            if (url.includes('/api/')) {
                init = Object.assign({}, init || {});
                const h = new Headers(init.headers || (typeof input !== 'string' && input.headers) || {});
                if (!h.has('X-Profile-Id')) h.set('X-Profile-Id', String(currentId()));
                init.headers = h;
            }
        } catch (_) { }
        return origFetch(input, init);
    };

    // تأكيد مكتوب لعمليات المسح الكبيرة (السحابة ترفضها بدون هذه الكلمة)
    const CONFIRM_WORD = 'تأكيد';
    function confirmTyped(message) {
        const typed = prompt(`${message}

للتأكيد اكتب كلمة: ${CONFIRM_WORD}`);
        if (typed === null) return null;
        if (typed.trim() !== CONFIRM_WORD) { alert('لم يتم التنفيذ: كلمة التأكيد غير صحيحة.'); return null; }
        return CONFIRM_WORD;
    }
    // الاستور المفتوح حالياً في الشاشة (متغير عام في app.js أو mobile.html). كان يُقرأ من window فيرجع فارغاً
    // فترفع السحابة المخزون في آخر استور تم إنشاؤه بدل الاستور المفتوح.
    function activeStoreNo() {
        if (typeof window.RambfeActiveStore === 'function') { try { const v = window.RambfeActiveStore(); if (v) return String(v); } catch (_) { } }
        try { if (typeof currentActiveStoreNo === 'string' && currentActiveStoreNo) return currentActiveStoreNo; } catch (_) { }
        return '';
    }
    async function restoreLastDeleted(storeNo) {
        const d = await postJson('/api/stock/trash/restore', { store_no: storeNo || activeStoreNo() });
        return d;
    }
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = (n) => Number(n || 0).toLocaleString('en-US');

    // ---------------- قراءة ملف الإكسيل في المتصفح ثم إرساله على دفعات ----------------
    let xlsxLoading = null;
    function loadXlsx() {
        if (window.XLSX) return Promise.resolve(window.XLSX);
        if (!xlsxLoading) xlsxLoading = new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
            s.onload = () => res(window.XLSX); s.onerror = () => rej(new Error('تعذر تحميل قارئ ملفات الإكسيل'));
            document.head.appendChild(s);
        });
        return xlsxLoading;
    }
    const p2 = (n) => String(n).padStart(2, '0');
    // نفس القيم التي يقرؤها openpyxl (التواريخ بصيغة 'YYYY-MM-DD HH:MM:SS')
    async function readSheetRows(file) {
        const XLSX = await loadXlsx();
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellNF: true, cellDates: false });
        const active = (wb.Workbook && wb.Workbook.Views && wb.Workbook.Views[0] && wb.Workbook.Views[0].activeTab) || 0;
        const ws = wb.Sheets[wb.SheetNames[active] || wb.SheetNames[0]];
        if (!ws || !ws['!ref']) return [];
        const rng = XLSX.utils.decode_range(ws['!ref']);
        const rows = [];
        for (let r = rng.s.r; r <= rng.e.r; r++) {
            const row = [];
            for (let c = rng.s.c; c <= rng.e.c; c++) {
                const cell = ws[XLSX.utils.encode_cell({ r, c })];
                if (!cell || cell.v === undefined || cell.v === null || cell.t === 'z') { row.push(null); continue; }
                if (cell.t === 'n' && cell.z && XLSX.SSF.is_date(cell.z)) {
                    const d = XLSX.SSF.parse_date_code(cell.v);
                    row.push(`${d.y}-${p2(d.m)}-${p2(d.d)} ${p2(d.H)}:${p2(d.M)}:${p2(Math.floor(d.S))}`);
                } else if (cell.t === 'd') {
                    const d = cell.v;
                    row.push(`${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`);
                } else if (cell.t === 'b') {
                    row.push(cell.v ? 'True' : 'False');
                } else {
                    row.push(cell.v);
                }
            }
            rows.push(row);
        }
        return rows;
    }
    async function postJson(url, body) {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.success === false) throw new Error(data.message || `HTTP ${res.status}`);
        return data;
    }
    async function uploadStockFile(file, storeNo, onProgress) {
        const rows = await readSheetRows(file);
        if (!rows.length) throw new Error('ملف الإكسيل فارغ');
        const det = await postJson('/api/stock/upload/detect', { rows: rows.slice(0, 25) });
        const dataRows = rows.slice(det.header_row_idx + 1);
        let total = 0, target = storeNo || '';
        // رقم رفع واحد لكل الدفعات: السحابة تجمع الصفوف جانباً ولا تستبدل مخزون الاستور إلا بعد وصول الملف كاملاً
        // (لو انقطع الإنترنت في المنتصف يبقى المخزون القديم كما هو، والكميات المجرودة لا تُمس أبداً)
        const uploadId = 'up' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const CH = 700;
        for (let i = 0; i < dataRows.length || i === 0; i += CH) {
            const part = dataRows.slice(i, i + CH);
            const r = await postJson('/api/stock/upload/rows', { store_no: target, rows: part, col_idx: det.col_idx, replace_existing: true, is_first: i === 0, upload_id: uploadId });
            target = r.store_no; total += r.added_count || 0;
            if (onProgress) onProgress(Math.min(dataRows.length, i + CH), dataRows.length);
            if (!dataRows.length) break;
        }
        return postJson('/api/stock/upload/finish', { store_no: target, total_added: total, upload_id: uploadId, replace_existing: true });
    }

    // ---------------- الشريط والنافذة ----------------
    const css = `
    header.sticky{top:34px!important}
    #rp-bar{position:sticky;top:0;z-index:70;height:34px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;gap:8px;padding:5px 10px;
      background:linear-gradient(90deg,#065f46,#047857);color:#fff;font:700 13px/1.4 system-ui,Segoe UI,Tahoma,sans-serif;direction:rtl;
      box-shadow:0 1px 4px rgba(0,0,0,.25)}
    #rp-bar button{all:unset;cursor:pointer;display:inline-flex;align-items:center;gap:6px;padding:3px 12px;border-radius:999px;
      background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.35)}
    #rp-bar button:hover{background:rgba(255,255,255,.28)}
    #rp-bar .rp-name{font-size:14px;font-weight:900}
    #rp-bar button,#rp-bar>span{white-space:nowrap}
    @media (max-width:640px){
      #rp-bar{gap:6px;padding:4px 6px;font-size:12px}
      #rp-bar button{padding:2px 9px;gap:4px}
      #rp-bar .rp-name{font-size:13px;max-width:120px;overflow:hidden;text-overflow:ellipsis}
      #rp-bar .rp-long{display:none}
    }
    #rp-modal{position:fixed;inset:0;z-index:9999;display:none;align-items:flex-start;justify-content:center;background:rgba(2,6,23,.6);
      padding:40px 12px;direction:rtl;font:14px/1.5 system-ui,Segoe UI,Tahoma,sans-serif}
    #rp-modal.open{display:flex}
    #rp-modal .rp-box{background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:16px;width:100%;max-width:520px;max-height:85vh;overflow:auto;
      box-shadow:0 20px 50px rgba(0,0,0,.5)}
    #rp-modal h3{margin:0;padding:14px 16px;font-size:16px;font-weight:900;border-bottom:1px solid #1e293b;display:flex;justify-content:space-between;align-items:center}
    #rp-modal .rp-sec{padding:12px 16px;border-bottom:1px solid #1e293b}
    #rp-modal .rp-item{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;margin:6px 0;border-radius:12px;
      background:#1e293b;border:1px solid #334155;cursor:pointer}
    #rp-modal .rp-item.cur{border-color:#10b981;background:#064e3b}
    #rp-modal .rp-item small{color:#94a3b8;font-size:11px}
    #rp-modal input{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:10px;border:1px solid #475569;background:#020617;color:#fff;font:inherit}
    #rp-modal .rp-btn{all:unset;cursor:pointer;display:inline-block;padding:8px 14px;border-radius:10px;font-weight:800;font-size:13px;text-align:center}
    #rp-modal .g{background:#059669;color:#fff} #rp-modal .b{background:#2563eb;color:#fff} #rp-modal .r{background:#7f1d1d;color:#fecaca} #rp-modal .s{background:#334155;color:#e2e8f0}
    #rp-modal .row{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
    #rp-modal .msg{margin-top:8px;font-size:12px;color:#a7f3d0;min-height:16px}`;

    let profiles = [];
    function currentName() {
        const p = profiles.find(x => x.id === currentId());
        return p ? p.name : get(NAME_KEY, 'صيدلية 1');
    }
    function renderBar() {
        const bar = document.getElementById('rp-bar');
        if (!bar) return;
        bar.innerHTML = `<span>🏥<span class="rp-long"> الصيدلية الحالية:</span></span>
          <button id="rp-open" title="تبديل الصيدلية أو إضافة صيدلية جديدة"><span class="rp-name">${esc(currentName())}</span> <span>▾<span class="rp-long"> تبديل / إضافة</span></span></button>
          <button id="rp-upload" title="رفع ملف مخزون جديد لهذه الصيدلية">📤 رفع مخزون</button>`;
        bar.querySelector('#rp-open').onclick = openModal;
        bar.querySelector('#rp-upload').onclick = () => pickAndUpload();
    }
    async function loadProfiles() {
        try {
            const r = await fetch('/api/profiles', { cache: 'no-store' });
            const d = await r.json();
            if (d && d.profiles && d.profiles.length) {
                profiles = d.profiles;
                // الصيدلية المحفوظة على الجهاز اتحذفت: ننتقل لصيدلية موجودة فعلاً (السيرفر حددها في current_profile_id)
                // ونعيد تحميل الشاشة حتى لا تُعرض بيانات صيدلية غير موجودة
                if (!profiles.some(p => p.id === currentId())) {
                    const next = profiles.some(p => p.id === d.current_profile_id) ? d.current_profile_id : profiles[0].id;
                    set(KEY, String(next));
                    set(NAME_KEY, currentName());
                    location.reload();
                    return;
                }
                set(NAME_KEY, currentName());
            }
        } catch (_) { }
        renderBar();
        renderModal();
    }
    function switchTo(id) {
        if (id === currentId()) { closeModal(); return; }
        set(KEY, String(id));
        const p = profiles.find(x => x.id === id); if (p) set(NAME_KEY, p.name);
        location.reload();
    }
    function msg(t, bad) { const m = document.getElementById('rp-msg'); if (m) { m.textContent = t || ''; m.style.color = bad ? '#fca5a5' : '#a7f3d0'; } }
    function renderModal() {
        const box = document.querySelector('#rp-modal .rp-list');
        if (!box) return;
        box.innerHTML = profiles.map(p => `<div class="rp-item ${p.id === currentId() ? 'cur' : ''}" data-id="${p.id}">
            <div><div style="font-weight:900">${p.id === currentId() ? '✅ ' : '🏥 '}${esc(p.name)}</div>
            <small>${fmt(p.stock_rows)} سطر مخزون · ${fmt(p.stores_count)} استور · ${fmt(p.invoices_count)} فاتورة</small></div>
            <span style="font-size:12px;color:#6ee7b7">${p.id === currentId() ? 'الحالية' : 'تبديل ←'}</span></div>`).join('');
        box.querySelectorAll('.rp-item').forEach(el => el.onclick = () => switchTo(parseInt(el.dataset.id, 10)));
        const cur = document.getElementById('rp-cur-name'); if (cur) cur.textContent = currentName();
    }
    function buildModal() {
        const m = document.createElement('div');
        m.id = 'rp-modal';
        m.innerHTML = `<div class="rp-box">
          <h3><span>🏥 الصيدليات</span><button class="rp-btn s" id="rp-close">✕</button></h3>
          <div class="rp-sec"><div style="font-size:12px;color:#94a3b8">اختر صيدلية للتبديل إليها (كل صيدلية لها مخزونها وجردها وفواتيرها المستقلة، ودليل الأصناف مشترك):</div>
            <div class="rp-list"></div></div>
          <div class="rp-sec"><div style="font-weight:800">➕ إضافة صيدلية جديدة</div>
            <div class="row"><input id="rp-new" placeholder="مثال: صيدلية 2"><button class="rp-btn g" id="rp-create">إنشاء ورفع مخزونها</button></div></div>
          <div class="rp-sec"><div style="font-weight:800">📤 رفع مخزون جديد للصيدلية الحالية: <span id="rp-cur-name"></span></div>
            <div style="font-size:12px;color:#94a3b8;margin-top:4px">يستبدل رصيد المخزون الحالي للاستور المختار بهذا الملف (Excel).</div>
            <div class="row"><button class="rp-btn b" id="rp-up">اختيار ملف المخزون…</button></div>
            <div style="font-size:11px;color:#6ee7b7;margin-top:4px">✅ الكميات المجرودة لا تُمسح عند رفع المخزون، ولا يتأثر أي استور آخر.</div></div>
          <div class="rp-sec"><div style="font-weight:800">♻️ سلة محذوفات الجرد</div>
            <div style="font-size:12px;color:#94a3b8;margin-top:4px">أي بنود جرد اتمسحت أو اتصفرت بتتحفظ هنا تلقائياً. استرجع آخر عملية مسح للاستور الحالي:</div>
            <div class="row"><button class="rp-btn s" id="rp-restore">استرجاع آخر جرد محذوف</button></div></div>
          <div class="rp-sec"><div style="font-weight:800">⚙️ الصيدلية الحالية</div>
            <div class="row"><input id="rp-rename" placeholder="اسم جديد"><button class="rp-btn s" id="rp-do-rename">تغيير الاسم</button></div>
            <div class="row"><button class="rp-btn r" id="rp-delete">حذف هذه الصيدلية وكل بياناتها</button></div>
            <div class="msg" id="rp-msg"></div></div></div>`;
        document.body.appendChild(m);
        m.addEventListener('click', (e) => { if (e.target === m) closeModal(); });
        m.querySelector('#rp-close').onclick = closeModal;
        m.querySelector('#rp-up').onclick = () => pickAndUpload();
        m.querySelector('#rp-restore').onclick = async () => {
            try { const d = await restoreLastDeleted(); msg(d.message || 'تم الاسترجاع'); setTimeout(() => location.reload(), 1200); }
            catch (e) { msg(e.message, true); }
        };
        m.querySelector('#rp-create').onclick = async () => {
            const name = m.querySelector('#rp-new').value.trim();
            if (!name) { msg('اكتب اسم الصيدلية الجديدة', true); return; }
            try {
                const d = await postJson('/api/profiles/create', { name });
                set(KEY, String(d.id)); set(NAME_KEY, name);
                msg(`تم إنشاء ${name}. اختر ملف المخزون الخاص بها…`);
                pickAndUpload(true);
            } catch (e) { msg(e.message, true); }
        };
        m.querySelector('#rp-do-rename').onclick = async () => {
            const name = m.querySelector('#rp-rename').value.trim();
            if (!name) { msg('اكتب الاسم الجديد', true); return; }
            try { await postJson('/api/profiles/rename', { id: currentId(), name }); set(NAME_KEY, name); msg('تم تغيير الاسم'); await loadProfiles(); }
            catch (e) { msg(e.message, true); }
        };
        m.querySelector('#rp-delete').onclick = async () => {
            const name = currentName();
            const typed = prompt(`سيتم حذف "${name}" وكل استوراتها ومخزونها وجردها وفواتيرها نهائياً.\nللتأكيد اكتب اسم الصيدلية بالضبط:`);
            if (typed === null) return;
            try {
                await postJson('/api/profiles/delete', { id: currentId(), confirm_name: typed.trim() });
                const rest = profiles.filter(p => p.id !== currentId());
                set(KEY, String(rest.length ? rest[0].id : 1));
                location.reload();
            }
            catch (e) { msg(e.message, true); }
        };
    }
    function openModal() { document.getElementById('rp-modal').classList.add('open'); loadProfiles(); }
    function closeModal() { document.getElementById('rp-modal').classList.remove('open'); }

    function pickAndUpload(reloadAfter) {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.xlsx,.xls,.xlsm,.csv';
        inp.onchange = async () => {
            const f = inp.files && inp.files[0];
            if (!f) { if (reloadAfter) location.reload(); return; }
            document.getElementById('rp-modal').classList.add('open');
            msg(`جاري قراءة ${f.name}…`);
            try {
                const storeNo = reloadAfter ? '' : activeStoreNo();
                const d = await uploadStockFile(f, storeNo, (done, all) => msg(`جاري رفع المخزون… ${fmt(done)} / ${fmt(all)} سطر`));
                msg(d.message || 'تم رفع المخزون بنجاح');
                setTimeout(() => location.reload(), 900);
            } catch (e) { msg('فشل الرفع: ' + e.message, true); }
        };
        inp.click();
    }

    function mount() {
        const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
        const bar = document.createElement('div'); bar.id = 'rp-bar';
        document.body.insertBefore(bar, document.body.firstChild);
        buildModal();
        renderBar();
        loadProfiles();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();

    window.RambfeProfiles = { currentId, uploadStockFile, open: openModal, reload: loadProfiles, confirmTyped, restoreLastDeleted, CONFIRM_WORD, activeStoreNo };
})();
