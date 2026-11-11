// أقسام الموبايل: قائمة جانبية + شريط سفلي + صفحات مصممة للموبايل (الفاتورة، سجل الفواتير، استيراد الملفات)
// الأقسام القديمة (ماسح الجرد، كشف الجرد، دليل الأصناف، تحكم وترحيل) تفضل زي ما هي.
(function () {
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
    const $ = (id) => document.getElementById(id);

    const SECTIONS = [
        { id: 'invoice', icon: '🧾', label: 'الفاتورة', desc: 'مسح العبوات وإضافتها للفاتورة الحالية' },
        { id: 'scanner', icon: '📷', label: 'ماسح الجرد', desc: 'جرد سريع بكاميرا الموبايل' },
        { id: 'items', icon: '📋', label: 'كشف الجرد', desc: 'أصناف الاستور والكميات المجرودة' },
        { id: 'catalog', icon: '🔍', label: 'دليل الأصناف', desc: 'البحث في كروت الأصناف' },
        { id: 'history', icon: '📑', label: 'سجل الفواتير', desc: 'كل الفواتير وتفاصيلها وتصديرها' },
        { id: 'import', icon: '📥', label: 'استيراد ملفات', desc: 'ملف فاتورة، PDF/صورة، أو مخزون' },
        { id: 'actions', icon: '⚙️', label: 'تحكم وترحيل', desc: 'إعدادات الجرد والترحيل' },
    ];
    const BOTTOM = ['invoice', 'scanner', 'items', 'catalog'];
    const OLD = ['scanner', 'items', 'catalog', 'actions'];
    const STOCK_VIEWS = ['scanner', 'items', 'actions'];
    let current = 'scanner';

    async function api(path, body) {
        const res = await fetch(path, body === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await res.json().catch(() => ({}));
        if (!res.ok && d.success !== false) d.success = false;
        if (d.offline_reconnecting || d.db_error) throw new Error(d.message || 'الخدمة غير متاحة مؤقتاً');
        return d;
    }

    function toast(msg, kind = 'ok') {
        let t = $('ms-toast');
        if (!t) { t = document.createElement('div'); t.id = 'ms-toast'; document.body.appendChild(t); }
        t.className = 'ms-toast ' + kind; t.textContent = msg; t.style.opacity = '1';
        clearTimeout(t._h); t._h = setTimeout(() => { t.style.opacity = '0'; }, 2600);
        if (navigator.vibrate) try { navigator.vibrate(kind === 'err' ? [120, 60, 120] : [40]); } catch (_) { }
    }

    const CSS = `
    .ms-toast{position:fixed;left:50%;bottom:86px;transform:translateX(-50%);z-index:9998;max-width:92vw;padding:10px 16px;border-radius:14px;font-weight:800;font-size:13px;
      box-shadow:0 10px 30px rgba(0,0,0,.5);transition:opacity .3s;text-align:center;pointer-events:none}
    .ms-toast.ok{background:#065f46;color:#d1fae5;border:1px solid #34d399}.ms-toast.err{background:#7f1d1d;color:#fee2e2;border:1px solid #f87171}
    .ms-toast.info{background:#1e293b;color:#e2e8f0;border:1px solid #475569}
    #ms-drawer{position:fixed;inset:0;z-index:80;pointer-events:none}
    #ms-drawer .bg{position:absolute;inset:0;background:rgba(2,6,23,.65);opacity:0;transition:opacity .25s}
    #ms-drawer .panel{position:absolute;top:0;bottom:0;right:0;width:min(84vw,330px);background:#0f172a;border-left:1px solid #1e293b;transform:translateX(100%);
      transition:transform .25s ease;display:flex;flex-direction:column;box-shadow:-10px 0 40px rgba(0,0,0,.5)}
    #ms-drawer.open{pointer-events:auto}#ms-drawer.open .bg{opacity:1}#ms-drawer.open .panel{transform:none}
    .ms-item{display:flex;align-items:center;gap:12px;width:100%;padding:11px 12px;border-radius:14px;text-align:right;color:#cbd5e1;transition:background .15s}
    .ms-item:active{transform:scale(.98)}.ms-item.on{background:rgba(99,102,241,.18);color:#fff;border:1px solid rgba(129,140,248,.4)}
    .ms-item .ic{width:38px;height:38px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:19px;background:#1e293b;flex-shrink:0}
    .ms-item.on .ic{background:linear-gradient(135deg,#6366f1,#8b5cf6)}
    .ms-sheet{position:fixed;inset:0;z-index:85;display:none;align-items:flex-end;background:rgba(2,6,23,.7)}
    .ms-sheet.open{display:flex}
    .ms-sheet .sh{width:100%;max-height:88vh;background:#0f172a;border-top:1px solid #334155;border-radius:22px 22px 0 0;display:flex;flex-direction:column;
      padding-bottom:env(safe-area-inset-bottom,0)}
    .ms-card{background:rgba(15,23,42,.9);border:1px solid #1e293b;border-radius:18px}
    .ms-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border-radius:14px;font-weight:800;font-size:13px;padding:11px 12px;transition:transform .1s}
    .ms-btn:active{transform:scale(.97)}.ms-btn:disabled{opacity:.5}
    .ms-in{width:100%;background:#020617;border:1px solid #334155;border-radius:12px;padding:10px 12px;color:#f1f5f9;font-size:14px;outline:none}
    .ms-in:focus{border-color:#818cf8}
    #ms-inv-cam video{object-fit:cover;border-radius:18px}
    #btn-ai-invoice{display:none}
    @media (max-width:640px){#ai-inv .box{width:100%!important;max-width:100%!important;max-height:94vh!important;margin:0!important;border-radius:16px 16px 0 0!important}
      #ai-inv{padding:0!important;align-items:flex-end!important}#ai-table{overflow-x:auto}#ai-inv table{font-size:11px}#ai-inv .ft{flex-direction:column;gap:8px}}`;

    // ==================== الهيكل: قائمة جانبية + شريط سفلي ====================
    function buildShell() {
        const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

        const drawer = document.createElement('div'); drawer.id = 'ms-drawer';
        drawer.innerHTML = `<div class="bg" data-close></div><aside class="panel">
          <div class="p-4 border-b border-slate-800 flex items-center gap-3">
            <div class="w-11 h-11 rounded-2xl bg-gradient-to-tr from-indigo-600 to-violet-500 flex items-center justify-center text-xl shadow-lg">💊</div>
            <div class="flex-1"><div class="font-black text-white text-sm">RAMBFE</div><div class="text-[11px] text-slate-400" id="ms-dr-ph">الصيدلية الحالية</div></div>
            <button data-close class="w-9 h-9 rounded-xl bg-slate-800 text-slate-300 text-lg">✕</button></div>
          <nav class="flex-1 overflow-y-auto p-3 space-y-1.5">${SECTIONS.map(s => `<button class="ms-item" data-go="${s.id}">
            <span class="ic">${s.icon}</span><span class="flex-1"><span class="block font-black text-sm">${s.label}</span><span class="block text-[11px] text-slate-400">${s.desc}</span></span></button>`).join('')}</nav>
          <div class="p-3 border-t border-slate-800 space-y-2">
            <button id="ms-dr-profile" class="ms-btn w-full bg-emerald-700/30 text-emerald-200 border border-emerald-600/40">🏥 تبديل الصيدلية / رفع مخزون</button>
            <a href="/?desktop=1" class="ms-btn w-full bg-slate-800 text-slate-300 border border-slate-700">🖥️ نسخة الكمبيوتر الكاملة</a></div></aside>`;
        document.body.appendChild(drawer);
        drawer.querySelectorAll('[data-close]').forEach(b => b.onclick = closeDrawer);
        drawer.querySelectorAll('[data-go]').forEach(b => b.onclick = () => { closeDrawer(); go(b.dataset.go); });
        $('ms-dr-profile').onclick = () => { closeDrawer(); window.RambfeProfiles && window.RambfeProfiles.open(); };

        // استبدال الشريط السفلي القديم
        const oldNav = document.querySelector('body > nav.fixed.bottom-0');
        const nav = document.createElement('nav');
        nav.id = 'ms-bottom';
        nav.className = 'fixed bottom-0 left-0 right-0 bg-slate-900/95 backdrop-blur border-t border-slate-800 px-1.5 pt-1.5 z-40 shadow-2xl';
        nav.style.paddingBottom = 'calc(6px + env(safe-area-inset-bottom, 0px))';
        nav.innerHTML = `<div class="max-w-md mx-auto grid grid-cols-5 gap-1">${BOTTOM.map(id => { const s = SECTIONS.find(x => x.id === id);
            return `<button type="button" data-go="${id}" class="flex flex-col items-center justify-center py-1.5 rounded-xl font-bold transition text-slate-400">
              <span class="text-lg leading-none">${s.icon}</span><span class="text-[10px] mt-1">${s.label}</span></button>`; }).join('')}
            <button type="button" id="ms-more" class="flex flex-col items-center justify-center py-1.5 rounded-xl font-bold transition text-slate-400">
              <span class="text-lg leading-none">☰</span><span class="text-[10px] mt-1">كل الأقسام</span></button></div>`;
        if (oldNav) oldNav.replaceWith(nav); else document.body.appendChild(nav);
        nav.querySelectorAll('[data-go]').forEach(b => b.onclick = () => go(b.dataset.go));
        $('ms-more').onclick = openDrawer;

        // زر القائمة في الرأس + عنوان القسم
        const header = document.querySelector('body > header');
        const logoRow = header && header.firstElementChild;
        if (logoRow) {
            const menuBtn = document.createElement('button');
            menuBtn.type = 'button'; menuBtn.className = 'w-9 h-9 rounded-xl bg-slate-800 border border-slate-700 text-slate-200 text-lg flex items-center justify-center flex-shrink-0';
            menuBtn.textContent = '☰'; menuBtn.title = 'الأقسام'; menuBtn.onclick = openDrawer;
            logoRow.insertBefore(menuBtn, logoRow.firstChild);
        }
    }
    function openDrawer() {
        const ph = document.querySelector('#rp-bar .rp-name'); if (ph) $('ms-dr-ph').textContent = ph.textContent;
        $('ms-drawer').classList.add('open');
    }
    function closeDrawer() { $('ms-drawer').classList.remove('open'); }

    // ==================== التنقل بين الأقسام ====================
    function go(id) {
        const prev = current; current = id;
        const header = document.querySelector('body > header');
        const storeBar = $('mobile-sel-store') && $('mobile-sel-store').closest('div');
        const stats = $('stat-total-items') && $('stat-total-items').closest('section');
        const stockOnly = [$('btn-toggle-torch'), $('btn-open-new-store')];
        const isStock = STOCK_VIEWS.includes(id) || id === 'catalog';
        if (storeBar) storeBar.style.display = STOCK_VIEWS.includes(id) ? '' : 'none';
        if (stats) stats.style.display = STOCK_VIEWS.includes(id) ? '' : 'none';
        stockOnly.forEach(b => { if (b) b.style.display = isStock ? '' : 'none'; });
        const title = header && header.querySelector('span.text-xs.font-black, span.font-black.text-white');
        const sec = SECTIONS.find(s => s.id === id);
        if (title) title.textContent = sec ? sec.label : 'RAMBFE';

        if (OLD.includes(id)) {
            if (typeof window.switchView === 'function') window.switchView(id);
        } else {
            OLD.forEach(v => { const el = $('view-' + v); if (el) el.classList.add('hidden'); });
        }
        document.querySelectorAll('.ms-view').forEach(v => v.classList.toggle('hidden', v.id !== 'ms-view-' + id));

        // كاميرا الجرد شغالة بس في صفحة ماسح الجرد، وكاميرا الفاتورة بس في صفحة الفاتورة
        if (prev === 'scanner' && id !== 'scanner' && typeof window.stopMobileCamera === 'function') try { window.stopMobileCamera(); } catch (_) { }
        if (id === 'scanner' && prev !== 'scanner' && typeof window.startMobileCamera === 'function') setTimeout(() => { try { window.startMobileCamera(); } catch (_) { } }, 250);
        if (prev === 'invoice' && id !== 'invoice') stopInvCam();

        document.querySelectorAll('#ms-bottom [data-go]').forEach(b => {
            const on = b.dataset.go === id;
            b.classList.toggle('text-indigo-400', on); b.classList.toggle('bg-indigo-500/10', on); b.classList.toggle('text-slate-400', !on);
        });
        const more = $('ms-more'); if (more) { const on = !BOTTOM.includes(id); more.classList.toggle('text-indigo-400', on); more.classList.toggle('text-slate-400', !on); }
        document.querySelectorAll('#ms-drawer [data-go]').forEach(b => b.classList.toggle('on', b.dataset.go === id));

        if (id === 'invoice') loadInvoice();
        if (id === 'history') loadHistory(true);
        window.scrollTo(0, 0);
        try { sessionStorage.setItem('ms_section', id); } catch (_) { }
    }

    // ==================== صفحة الفاتورة ====================
    let inv = null;
    function viewInvoice() {
        return `<div id="ms-view-invoice" class="ms-view hidden space-y-3 max-w-md mx-auto">
          <div class="ms-card p-3">
            <div class="flex items-center justify-between gap-2">
              <div><div class="text-[11px] text-slate-400 font-bold">الفاتورة الحالية</div>
                <div id="ms-inv-no" class="font-mono font-black text-indigo-300 text-sm">—</div></div>
              <span id="ms-inv-status" class="px-2.5 py-1 rounded-full text-[11px] font-black bg-amber-500/15 text-amber-300 border border-amber-500/30">مسودة</span></div>
            <div class="grid grid-cols-3 gap-2 mt-3 text-center">
              <div class="bg-slate-950 rounded-xl p-2"><div class="text-[10px] text-slate-400 font-bold">الأصناف</div><div id="ms-inv-items" class="font-mono font-black text-sky-300">0</div></div>
              <div class="bg-slate-950 rounded-xl p-2"><div class="text-[10px] text-slate-400 font-bold">العبوات</div><div id="ms-inv-packs" class="font-mono font-black text-emerald-300">0</div></div>
              <div class="bg-slate-950 rounded-xl p-2"><div class="text-[10px] text-slate-400 font-bold">المبلغ</div><div id="ms-inv-amount" class="font-mono font-black text-amber-300">0</div></div></div></div>

          <div class="ms-card p-3 space-y-2.5">
            <div id="ms-inv-cam-wrap" class="hidden relative">
              <div id="ms-inv-cam" class="w-full aspect-square max-h-[42vh] bg-black rounded-2xl overflow-hidden"></div>
              <div id="ms-inv-last" class="absolute bottom-2 left-2 right-2 text-center text-[11px] font-bold bg-slate-950/85 text-slate-200 rounded-lg py-1 px-2">وجّه الكاميرا على كود الداتا ماتريكس</div></div>
            <button id="ms-inv-cam-btn" class="ms-btn w-full bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-[15px] py-3.5">📷 مسح العبوات بالكاميرا</button>
            <div class="flex gap-2"><input id="ms-inv-code" class="ms-in font-mono" placeholder="أو الصق / امسح الكود هنا" inputmode="text" autocomplete="off">
              <button id="ms-inv-code-go" class="ms-btn bg-indigo-600 text-white px-4">إضافة</button></div>
            <div class="grid grid-cols-2 gap-2">
              <button id="ms-inv-manual-btn" class="ms-btn bg-slate-800 text-slate-200 border border-slate-700">✍️ إضافة يدوية</button>
              <button id="btn-trigger-inv-upload" class="ms-btn bg-violet-600/20 text-violet-200 border border-violet-500/40">📄 فاتورة PDF/صورة</button></div></div>

          <div class="flex items-center justify-between px-1"><div class="text-sm font-black text-white">بنود الفاتورة</div>
            <button id="ms-inv-refresh" class="text-xs text-slate-400 font-bold">🔄 تحديث</button></div>
          <div id="ms-inv-lines" class="space-y-2"></div>

          <div class="grid grid-cols-2 gap-2 pb-2">
            <button id="ms-inv-confirm" class="ms-btn bg-emerald-600 text-white">✅ اعتماد الفاتورة</button>
            <button id="ms-inv-export" class="ms-btn bg-slate-800 text-emerald-300 border border-slate-700">📊 تصدير Excel</button>
            <button id="ms-inv-new" class="ms-btn bg-slate-800 text-slate-200 border border-slate-700">➕ فاتورة جديدة</button>
            <button id="ms-inv-clear" class="ms-btn bg-rose-950/60 text-rose-300 border border-rose-800/60">🗑️ مسح البنود</button></div>
        </div>`;
    }
    function renderInvoice(d) {
        if (!d || !d.id) return;
        inv = d; window.activeInvoice = d;
        $('ms-inv-no').textContent = d.invoice_number || ('#' + d.id);
        const draft = d.status === 'draft';
        const stEl = $('ms-inv-status');
        stEl.textContent = draft ? 'مسودة' : 'معتمدة';
        stEl.className = 'px-2.5 py-1 rounded-full text-[11px] font-black border ' + (draft ? 'bg-amber-500/15 text-amber-300 border-amber-500/30' : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30');
        const lines = d.lines || [];
        $('ms-inv-items').textContent = fmt(lines.length);
        $('ms-inv-packs').textContent = fmt(lines.reduce((a, l) => a + Number(l.quantity || 0), 0));
        $('ms-inv-amount').textContent = fmt(lines.reduce((a, l) => a + Number(l.quantity || 0) * Number(l.sales_price || 0), 0));
        ['ms-inv-confirm', 'ms-inv-clear', 'ms-inv-cam-btn', 'ms-inv-code-go', 'ms-inv-manual-btn'].forEach(i => { const b = $(i); if (b) b.disabled = !draft; });
        $('ms-inv-lines').innerHTML = lines.length ? lines.slice().reverse().map(l => `
          <div class="ms-card p-3">
            <div class="flex items-start gap-2">
              <div class="flex-1 min-w-0">
                <div class="font-black text-white text-[13px] leading-snug">${esc(l.name_ar || l.name_en || l.product_name || l.product_code)}</div>
                ${l.name_en && l.name_ar ? `<div class="text-[11px] text-slate-400 truncate" dir="ltr">${esc(l.name_en)}</div>` : ''}
                <div class="flex flex-wrap gap-1.5 mt-1.5 text-[10px] font-bold">
                  <span class="px-1.5 py-0.5 rounded-md bg-slate-800 text-slate-300 font-mono">${esc(l.product_code)}</span>
                  ${l.batch_number ? `<span class="px-1.5 py-0.5 rounded-md bg-sky-500/10 text-sky-300 font-mono">باتش ${esc(l.batch_number)}</span>` : ''}
                  ${l.expiry_date ? `<span class="px-1.5 py-0.5 rounded-md bg-amber-500/10 text-amber-300 font-mono">${esc(l.expiry_date)}</span>` : ''}
                  ${l.sales_price ? `<span class="px-1.5 py-0.5 rounded-md bg-emerald-500/10 text-emerald-300 font-mono">${fmt(l.sales_price)}</span>` : ''}</div></div>
              ${draft ? `<button data-del="${l.id}" class="w-8 h-8 rounded-lg bg-rose-950/60 text-rose-300 text-sm flex-shrink-0">✕</button>` : ''}</div>
            <div class="flex items-center justify-between mt-2.5">
              <span class="text-[11px] text-slate-400 font-bold">الكمية</span>
              ${draft ? `<div class="flex items-center gap-1.5">
                <button data-step="${l.id}" data-d="-1" class="w-9 h-9 rounded-xl bg-slate-800 text-white font-black text-lg">−</button>
                <input data-qty="${l.id}" value="${Number(l.quantity || 0)}" inputmode="decimal" class="w-16 h-9 text-center rounded-xl bg-slate-950 border border-slate-700 font-mono font-black text-white">
                <button data-step="${l.id}" data-d="1" class="w-9 h-9 rounded-xl bg-slate-800 text-white font-black text-lg">+</button></div>`
                : `<span class="font-mono font-black text-white">${fmt(l.quantity)}</span>`}</div></div>`).join('')
            : `<div class="ms-card p-6 text-center text-slate-400 text-sm"><div class="text-3xl mb-2">🧾</div>الفاتورة فاضية — امسح أول عبوة</div>`;
    }
    window.renderInvoice = renderInvoice;

    async function loadInvoice() {
        try { const d = await api('/api/invoice/active'); if (d.invoice) renderInvoice(d.invoice); }
        catch (e) { toast(e.message, 'err'); }
    }
    async function invAction(path, body, okMsg) {
        try {
            const d = await api(path, Object.assign({ invoice_id: inv ? inv.id : 0, user_name: 'المسؤول' }, body || {}));
            if (d.invoice && d.invoice.id) renderInvoice(d.invoice);
            if (d.success === false) { toast(d.message || 'تعذر التنفيذ', 'err'); return d; }
            if (okMsg !== null) toast(okMsg || d.message || 'تم', 'ok');
            return d;
        } catch (e) { toast(e.message, 'err'); return { success: false }; }
    }

    let lastCode = '', lastAt = 0, busy = false;
    async function scanCode(raw) {
        const code = String(raw || '').trim();
        if (!code || busy) return;
        const now = Date.now();
        if (code === lastCode && now - lastAt < 2500) return;
        lastCode = code; lastAt = now; busy = true;
        const last = $('ms-inv-last');
        try {
            const d = await invAction('/api/invoice/scan', { qr_text: code, code, quantity: 1 }, null);
            const name = d.name || (d.product && (d.product.name_ar || d.product.name_en)) || d.gtin || '';
            if (d.success) { toast('✅ ' + (name ? name + ' — ' : '') + (d.message || 'تمت الإضافة'), 'ok'); if (last) last.textContent = '✅ ' + (name || 'تمت الإضافة'); }
            else if (last) last.textContent = '⚠️ ' + (d.message || 'تعذرت الإضافة');
        } finally { busy = false; }
    }

    let cam = null;
    async function startInvCam() {
        if (typeof Html5Qrcode === 'undefined') { toast('الكاميرا غير متاحة على هذا الجهاز', 'err'); return; }
        $('ms-inv-cam-wrap').classList.remove('hidden');
        $('ms-inv-cam-btn').textContent = '⏹️ إيقاف الكاميرا';
        try {
            const F = window.Html5QrcodeSupportedFormats || {};
            cam = new Html5Qrcode('ms-inv-cam', { verbose: false, formatsToSupport: [F.DATA_MATRIX, F.QR_CODE, F.EAN_13, F.CODE_128].filter(x => x !== undefined),
                experimentalFeatures: { useBarCodeDetectorIfSupported: true } });
            await cam.start({ facingMode: 'environment' }, { fps: 12, qrbox: (w, h) => { const s = Math.floor(Math.min(w, h) * 0.7); return { width: s, height: s }; } },
                (txt) => scanCode(txt), () => { });
        } catch (e) { toast('تعذر تشغيل الكاميرا: ' + (e.message || e), 'err'); stopInvCam(); }
    }
    function stopInvCam() {
        const c = cam; cam = null;
        if (c) c.stop().then(() => c.clear()).catch(() => { try { c.clear(); } catch (_) { } });
        const w = $('ms-inv-cam-wrap'); if (w) w.classList.add('hidden');
        const b = $('ms-inv-cam-btn'); if (b) b.textContent = '📷 مسح العبوات بالكاميرا';
    }

    function manualSheet() {
        const s = sheet('ms-manual', `<div class="p-4 space-y-2.5">
            <div class="flex items-center justify-between"><b class="text-white">✍️ إضافة صنف يدوياً</b><button data-x class="w-8 h-8 rounded-lg bg-slate-800 text-slate-300">✕</button></div>
            <input id="ms-m-gtin" class="ms-in font-mono" placeholder="GTIN أو كود الصنف أو الباركود" inputmode="numeric">
            <input id="ms-m-batch" class="ms-in font-mono" placeholder="رقم التشغيلة (Batch)">
            <input id="ms-m-exp" class="ms-in font-mono" placeholder="تاريخ الانتهاء (مثال 2027-04-16)">
            <input id="ms-m-qty" class="ms-in font-mono" placeholder="الكمية" value="1" inputmode="decimal">
            <button id="ms-m-go" class="ms-btn w-full bg-indigo-600 text-white py-3">➕ إضافة للفاتورة</button></div>`);
        s.querySelector('#ms-m-go').onclick = async () => {
            const gtin = $('ms-m-gtin').value.trim();
            if (!gtin) { toast('اكتب GTIN أو كود الصنف', 'err'); return; }
            const d = await invAction('/api/invoice/manual-item', { gtin, batch: $('ms-m-batch').value.trim(), expiry: $('ms-m-exp').value.trim(), quantity: $('ms-m-qty').value.trim() || 1 });
            if (d.success !== false) { s.classList.remove('open'); ['ms-m-gtin', 'ms-m-batch', 'ms-m-exp'].forEach(i => $(i).value = ''); $('ms-m-qty').value = '1'; }
        };
        s.classList.add('open'); setTimeout(() => $('ms-m-gtin').focus(), 100);
    }
    function sheet(id, html) {
        let s = $(id);
        if (!s) {
            s = document.createElement('div'); s.id = id; s.className = 'ms-sheet';
            s.innerHTML = `<div class="sh">${html}</div>`;
            s.addEventListener('click', (e) => { if (e.target === s || e.target.closest('[data-x]')) s.classList.remove('open'); });
            document.body.appendChild(s);
        }
        return s;
    }

    function bindInvoice() {
        $('ms-inv-cam-btn').onclick = () => cam ? stopInvCam() : startInvCam();
        const codeIn = $('ms-inv-code');
        const submit = () => { const v = codeIn.value; codeIn.value = ''; lastCode = ''; scanCode(v); };
        $('ms-inv-code-go').onclick = submit;
        codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        $('ms-inv-manual-btn').onclick = manualSheet;
        // زر PDF/صورة يفتح نفس قارئ الذكاء الاصطناعي (الزر الأصلي بيتضاف جنبه مخفي)
        $('btn-trigger-inv-upload').onclick = () => { const b = $('btn-ai-invoice'); if (b) b.click(); else toast('جاري تحميل قارئ الفواتير… حاول تاني بعد ثانية', 'info'); };
        $('ms-inv-refresh').onclick = loadInvoice;
        $('ms-inv-confirm').onclick = async () => {
            if (!inv || !(inv.lines || []).length) { toast('الفاتورة فاضية', 'err'); return; }
            if (!confirm(`اعتماد الفاتورة ${inv.invoice_number}؟ بعد الاعتماد مش هينفع تضيف عليها.`)) return;
            await invAction('/api/invoice/confirm', {}, '✅ تم اعتماد الفاتورة');
        };
        $('ms-inv-new').onclick = async () => {
            if (!confirm('فتح فاتورة جديدة؟ الفاتورة الحالية هتفضل محفوظة في السجل.')) return;
            try { const d = await api('/api/invoice/new', { user_name: 'المسؤول' }); if (d.invoice) { renderInvoice(d.invoice); toast('تم فتح فاتورة جديدة ' + d.invoice.invoice_number); } }
            catch (e) { toast(e.message, 'err'); }
        };
        $('ms-inv-clear').onclick = async () => { if (confirm('مسح كل بنود الفاتورة الحالية؟')) await invAction('/api/invoice/clear-lines', {}, 'تم مسح البنود'); };
        $('ms-inv-export').onclick = () => exportInvoice(inv);
        const box = $('ms-inv-lines');
        box.addEventListener('click', async (e) => {
            const del = e.target.closest('[data-del]');
            if (del) { if (confirm('حذف الصنف ده من الفاتورة؟')) await invAction('/api/invoice/delete-line', { line_id: +del.dataset.del }, 'تم الحذف'); return; }
            const stp = e.target.closest('[data-step]');
            if (stp) {
                const input = box.querySelector(`[data-qty="${stp.dataset.step}"]`);
                const q = Math.max(1, Number(input.value || 0) + Number(stp.dataset.d));
                input.value = q;
                await invAction('/api/invoice/update-line-qty', { line_id: +stp.dataset.step, quantity: q }, null);
            }
        });
        box.addEventListener('change', async (e) => {
            const q = e.target.closest('[data-qty]');
            if (q) await invAction('/api/invoice/update-line-qty', { line_id: +q.dataset.qty, quantity: Number(q.value) || 1 }, 'تم تعديل الكمية');
        });
        if (window.RambfeRealtime) window.RambfeRealtime.onEvent((evt) => {
            if (current === 'invoice' && evt && evt.type === 'invoice_updated' && inv && Number(evt.invoice_id || (evt.data && evt.data.invoice_id)) === inv.id && !busy) loadInvoice();
        });
    }

    async function exportInvoice(d) {
        if (!d || !d.id) return;
        if (!window.RambfeExcel || !window.RambfeExcel.exportFromUrl) { toast('تصدير الإكسيل غير متاح', 'err'); return; }
        toast('⏳ جاري تجهيز ملف الإكسيل…', 'info');
        try { await window.RambfeExcel.exportFromUrl(`/api/invoice/export-excel?id=${d.id}`, `Invoice_${d.invoice_number || d.id}.xlsx`); toast('✅ تم حفظ الملف في التنزيلات'); }
        catch (e) { toast('تعذر التصدير: ' + e.message, 'err'); }
    }

    // ==================== سجل الفواتير ====================
    let hOffset = 0, hFilter = 'all', hRows = [];
    function viewHistory() {
        return `<div id="ms-view-history" class="ms-view hidden space-y-3 max-w-md mx-auto">
          <div class="flex gap-1.5 bg-slate-900 p-1 rounded-2xl border border-slate-800">
            ${[['all', 'الكل'], ['draft', 'مسودات'], ['confirmed', 'معتمدة']].map(([k, t]) => `<button data-hf="${k}" class="flex-1 py-2 rounded-xl text-xs font-black text-slate-400">${t}</button>`).join('')}</div>
          <input id="ms-h-q" class="ms-in" placeholder="🔍 ابحث برقم الفاتورة">
          <div id="ms-h-list" class="space-y-2"></div>
          <button id="ms-h-more" class="ms-btn w-full bg-slate-800 text-slate-300 border border-slate-700 hidden">تحميل المزيد</button></div>`;
    }
    async function loadHistory(reset) {
        if (reset) { hOffset = 0; hRows = []; }
        const more = $('ms-h-more'); more.disabled = true;
        try {
            const d = await api(`/api/invoices/list?limit=30&offset=${hOffset}`);
            const rows = d.invoices || [];
            hRows = hRows.concat(rows); hOffset += rows.length;
            more.classList.toggle('hidden', rows.length < 30);
            renderHistory();
        } catch (e) { toast(e.message, 'err'); }
        more.disabled = false;
    }
    function renderHistory() {
        document.querySelectorAll('[data-hf]').forEach(b => { const on = b.dataset.hf === hFilter; b.classList.toggle('bg-indigo-600', on); b.classList.toggle('text-white', on); b.classList.toggle('text-slate-400', !on); });
        const q = ($('ms-h-q').value || '').trim().toLowerCase();
        const rows = hRows.filter(r => (hFilter === 'all' || r.status === hFilter) && (!q || String(r.invoice_number || '').toLowerCase().includes(q)));
        $('ms-h-list').innerHTML = rows.length ? rows.map(r => {
            const draft = r.status === 'draft';
            return `<button data-open="${r.id}" class="ms-card w-full p-3 text-right">
              <div class="flex items-center justify-between gap-2">
                <span class="font-mono font-black text-indigo-300 text-[13px]">${esc(r.invoice_number)}</span>
                <span class="px-2 py-0.5 rounded-full text-[10px] font-black ${draft ? 'bg-amber-500/15 text-amber-300' : 'bg-emerald-500/15 text-emerald-300'}">${draft ? 'مسودة' : 'معتمدة'}</span></div>
              <div class="flex items-center gap-3 mt-2 text-[11px] text-slate-400 font-bold">
                <span>📅 ${esc(r.invoice_date || '')}</span>${draft && !Number(r.total_items) ? '<span>اضغط لعرض البنود</span>' : `<span>📦 ${fmt(r.total_items)} صنف</span><span>🧮 ${fmt(r.total_packages)} عبوة</span>`}</div>
              ${r.notes ? `<div class="text-[11px] text-slate-500 mt-1 truncate">${esc(r.notes)}</div>` : ''}</button>`;
        }).join('') : `<div class="ms-card p-6 text-center text-slate-400 text-sm">مافيش فواتير</div>`;
    }
    async function openInvoiceDetails(id) {
        const s = sheet('ms-hd', `<div class="p-4 border-b border-slate-800 flex items-center justify-between"><b id="ms-hd-t" class="text-white font-mono"></b>
            <button data-x class="w-8 h-8 rounded-lg bg-slate-800 text-slate-300">✕</button></div>
          <div id="ms-hd-body" class="flex-1 overflow-y-auto p-3 space-y-2"></div>
          <div class="p-3 border-t border-slate-800 grid grid-cols-2 gap-2"><button id="ms-hd-export" class="ms-btn bg-emerald-700 text-white">📊 تصدير Excel</button>
            <button id="ms-hd-open" class="ms-btn bg-slate-800 text-slate-200 border border-slate-700">🧾 فتحها في الفاتورة</button></div>`);
        $('ms-hd-t').textContent = '…'; $('ms-hd-body').innerHTML = '<div class="text-center text-slate-400 p-6">⏳ جاري التحميل…</div>';
        s.classList.add('open');
        try {
            const d = (await api(`/api/invoices/get?id=${id}`)).invoice;
            if (!d) throw new Error('الفاتورة غير موجودة');
            $('ms-hd-t').textContent = d.invoice_number;
            const lines = d.lines || [];
            $('ms-hd-body').innerHTML = `<div class="grid grid-cols-3 gap-2 text-center mb-1">
                <div class="bg-slate-950 rounded-xl p-2"><div class="text-[10px] text-slate-400">التاريخ</div><div class="text-[11px] font-mono text-white">${esc(d.invoice_date)}</div></div>
                <div class="bg-slate-950 rounded-xl p-2"><div class="text-[10px] text-slate-400">الأصناف</div><div class="font-mono font-black text-sky-300">${fmt(lines.length)}</div></div>
                <div class="bg-slate-950 rounded-xl p-2"><div class="text-[10px] text-slate-400">العبوات</div><div class="font-mono font-black text-emerald-300">${fmt(lines.reduce((a, l) => a + Number(l.quantity || 0), 0))}</div></div></div>` +
                (lines.length ? lines.map(l => `<div class="bg-slate-900 border border-slate-800 rounded-xl p-2.5">
                  <div class="flex justify-between gap-2"><span class="text-[12px] font-bold text-white">${esc(l.name_ar || l.name_en || l.product_code)}</span><span class="font-mono font-black text-emerald-300">×${fmt(l.quantity)}</span></div>
                  <div class="text-[10px] text-slate-400 font-mono mt-1">${esc(l.product_code)}${l.batch_number ? ' · ' + esc(l.batch_number) : ''}${l.expiry_date ? ' · ' + esc(l.expiry_date) : ''}</div></div>`).join('')
                    : '<div class="text-center text-slate-400 p-4">الفاتورة فاضية</div>');
            $('ms-hd-export').onclick = () => exportInvoice(d);
            const openBtn = $('ms-hd-open');
            openBtn.style.display = d.status === 'draft' ? '' : 'none';
            openBtn.onclick = () => { s.classList.remove('open'); renderInvoice(d); current = 'history'; go('invoice'); renderInvoice(d); };
        } catch (e) { $('ms-hd-body').innerHTML = `<div class="text-center text-rose-300 p-6">${esc(e.message)}</div>`; }
    }
    function bindHistory() {
        document.querySelectorAll('[data-hf]').forEach(b => b.onclick = () => { hFilter = b.dataset.hf; renderHistory(); });
        $('ms-h-q').addEventListener('input', renderHistory);
        $('ms-h-more').onclick = () => loadHistory(false);
        $('ms-h-list').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) openInvoiceDetails(+b.dataset.open); });
    }

    // ==================== استيراد الملفات ====================
    function viewImport() {
        const card = (id, icon, title, desc, color) => `<button id="${id}" class="ms-card w-full p-4 text-right flex items-center gap-3 active:scale-[.98] transition">
            <span class="w-12 h-12 rounded-2xl flex items-center justify-center text-2xl flex-shrink-0 ${color}">${icon}</span>
            <span class="flex-1"><span class="block font-black text-white text-sm">${title}</span><span class="block text-[11px] text-slate-400 mt-0.5 leading-relaxed">${desc}</span></span>
            <span class="text-slate-500 text-lg">‹</span></button>`;
        return `<div id="ms-view-import" class="ms-view hidden space-y-2.5 max-w-md mx-auto">
          ${card('ms-imp-inv', '📄', 'ملف فاتورة (Excel / CSV / TXT)', 'تفريغ بنود الملف في الفاتورة الحالية بالـ GTIN أو الكود', 'bg-emerald-500/15')}
          ${card('ms-imp-ai', '🤖', 'فاتورة مورد PDF أو صورة', 'صوّر الفاتورة والبرنامج يطلع الأصناف والكميات والباتش، وتراجعها قبل الإضافة', 'bg-violet-500/15')}
          ${card('ms-imp-stock', '📤', 'رفع مخزون الصيدلية', 'ملف المخزون (Excel) للاستور الحالي في الجرد', 'bg-sky-500/15')}
          ${card('ms-imp-cat', '🗂️', 'استيراد كتالوج الأصناف', 'تحديث كروت الأصناف من ملف إكسيل (شاشة المطابقة الكاملة)', 'bg-amber-500/15')}
          <div id="ms-imp-status" class="hidden ms-card p-3 text-[12px] font-bold text-slate-200"></div>
          <input id="ms-imp-inv-file" type="file" accept=".xlsx,.xls,.csv,.txt" class="hidden"></div>`;
    }
    function bindImport() {
        const status = (t, kind) => { const s = $('ms-imp-status'); s.classList.remove('hidden'); s.textContent = t; s.style.borderColor = kind === 'err' ? '#f87171' : kind === 'ok' ? '#34d399' : ''; };
        $('ms-imp-inv').onclick = () => $('ms-imp-inv-file').click();
        $('ms-imp-inv-file').onchange = async (e) => {
            const f = e.target.files && e.target.files[0]; e.target.value = '';
            if (!f) return;
            status(`⏳ جاري قراءة ${f.name} وتفريغه في الفاتورة…`);
            try {
                if (!inv) { const d = await api('/api/invoice/active'); if (d.invoice) renderInvoice(d.invoice); }
                const fd = new FormData(); fd.append('file', f); if (inv) fd.append('invoice_id', inv.id); fd.append('user_name', 'المسؤول');
                const res = await fetch('/api/invoice/upload-file', { method: 'POST', body: fd });
                const d = await res.json();
                if (d.success === false) throw new Error(d.message || 'فشل الاستيراد');
                if (d.invoice) renderInvoice(d.invoice);
                status('✅ ' + (d.message || `تم تفريغ ${d.imported_count || 0} عبوة`), 'ok');
                toast('✅ تم تفريغ الملف في الفاتورة');
            } catch (err) { status('❌ ' + err.message, 'err'); }
        };
        $('ms-imp-ai').onclick = () => { go('invoice'); setTimeout(() => $('btn-trigger-inv-upload').click(), 150); };
        $('ms-imp-stock').onclick = () => { if (window.RambfeProfiles) window.RambfeProfiles.open(); };
        $('ms-imp-cat').onclick = () => { if (confirm('استيراد الكتالوج بيحتاج شاشة المطابقة الكاملة (أعمدة كتير). أفتحها في نسخة الكمبيوتر؟')) location.href = '/?desktop=1#import'; };
    }

    // ==================== التشغيل ====================
    function init() {
        const main = document.querySelector('body > main');
        if (!main || $('ms-view-invoice')) return;
        main.insertAdjacentHTML('beforeend', viewInvoice() + viewHistory() + viewImport());
        buildShell(); bindInvoice(); bindHistory(); bindImport();
        let start = 'scanner';
        try { const s = new URLSearchParams(location.search).get('section') || sessionStorage.getItem('ms_section'); if (SECTIONS.some(x => x.id === s)) start = s; } catch (_) { }
        current = 'scanner';
        // كاميرا الجرد بتشتغل بس وصفحة ماسح الجرد مفتوحة
        const origStart = window.startMobileCamera;
        if (typeof origStart === 'function') window.startMobileCamera = function () { if (current !== 'scanner') return; return origStart.apply(this, arguments); };
        go(start);

    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
