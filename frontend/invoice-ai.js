// قراءة فواتير الموردين من PDF أو صور بالذكاء الاصطناعي ثم مراجعتها قبل الإضافة للفاتورة.
// يعمل من الرابط بدون الكمبيوتر: المتصفح يجهز الصفحات (نص أو صورة) والسحابة تقرأها وتطابقها مع كروت الأصناف.
(function () {
    const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    let pdfP = null;
    const loadPdf = () => pdfP || (pdfP = new Promise((res, rej) => {
        if (window.pdfjsLib) return res(window.pdfjsLib);
        const s = document.createElement('script'); s.src = PDFJS;
        s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER; res(window.pdfjsLib); };
        s.onerror = () => rej(new Error('تعذر تحميل قارئ PDF')); document.head.appendChild(s);
    }));

    // تجهيز صفحة كصورة JPEG (بحد أقصى 1600 بكسل) مع إمكانية التدوير
    function canvasToJpeg(src, w, h, rotate) {
        const scale = Math.min(1, 1600 / Math.max(w, h));
        const cw = Math.round(w * scale), ch = Math.round(h * scale);
        const c = document.createElement('canvas');
        const quarter = rotate === 90 || rotate === 270;
        c.width = quarter ? ch : cw; c.height = quarter ? cw : ch;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.translate(c.width / 2, c.height / 2); ctx.rotate(rotate * Math.PI / 180);
        ctx.drawImage(src, -cw / 2, -ch / 2, cw, ch);
        return c.toDataURL('image/jpeg', 0.82);
    }
    async function filePages(file) {
        const name = (file.name || '').toLowerCase();
        if (name.endsWith('.pdf') || file.type === 'application/pdf') {
            const pdfjs = await loadPdf();
            const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
            const pages = [];
            for (let i = 1; i <= doc.numPages; i++) {
                const page = await doc.getPage(i);
                const tc = await page.getTextContent();
                const text = tc.items.map(t => t.str).join(' ').replace(/\s+/g, ' ').trim();
                const vp = page.getViewport({ scale: 2 });
                const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
                await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
                pages.push({ label: `صفحة ${i}`, text: text.length > 200 ? text : '', canvas: c });
            }
            return pages;
        }
        const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
        const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        return [{ label: file.name || 'صورة', text: '', canvas: c }];
    }
    async function api(path, body) {
        const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.success === false) throw new Error(d.message || `HTTP ${r.status}`);
        return d;
    }
    async function readPage(pg, rotate = 0) {
        // PDF فيه نص حقيقي: نرسل النص (أدق وأرخص)، وإلا نرسل صورة الصفحة
        const body = { model: 'mistral' };
        if (pg.text && !rotate) body.text = pg.text;
        else body.image = canvasToJpeg(pg.canvas, pg.canvas.width, pg.canvas.height, rotate);
        const d = await api('/api/invoice/ai/extract', body);
        return d.items || [];
    }

    // ---------------- نافذة المراجعة ----------------
    const css = `
    #ai-inv{position:fixed;inset:0;z-index:9998;display:none;background:rgba(2,6,23,.65);direction:rtl;font:13px/1.45 system-ui,Segoe UI,Tahoma,sans-serif;padding:16px}
    #ai-inv.open{display:flex;align-items:flex-start;justify-content:center}
    #ai-inv .box{background:#fff;color:#0f172a;border-radius:14px;width:100%;max-width:1200px;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.4)}
    #ai-inv .hd{padding:12px 16px;border-bottom:1px solid #e2e8f0;display:flex;justify-content:space-between;align-items:center;gap:8px}
    #ai-inv .bd{padding:10px 16px;overflow:auto}
    #ai-inv .ft{padding:10px 16px;border-top:1px solid #e2e8f0;display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}
    #ai-inv table{width:100%;border-collapse:collapse;font-size:12px}
    #ai-inv th{background:#0f172a;color:#fff;padding:6px;position:sticky;top:0;font-weight:700}
    #ai-inv td{border-bottom:1px solid #e2e8f0;padding:4px 6px;vertical-align:middle}
    #ai-inv tr.low td{background:#fef3c7} #ai-inv tr.none td{background:#fee2e2} #ai-inv tr.off td{opacity:.45}
    #ai-inv input[type=text],#ai-inv input[type=number],#ai-inv select{width:100%;box-sizing:border-box;border:1px solid #cbd5e1;border-radius:6px;padding:3px 5px;font:inherit}
    #ai-inv .b{all:unset;cursor:pointer;padding:7px 14px;border-radius:9px;font-weight:800;font-size:13px}
    #ai-inv .g{background:#059669;color:#fff} #ai-inv .s{background:#e2e8f0;color:#0f172a} #ai-inv .o{background:#f59e0b;color:#fff}
    #ai-inv .tag{font-size:10px;padding:1px 6px;border-radius:99px;font-weight:800}
    #ai-inv .t-high{background:#d1fae5;color:#065f46} #ai-inv .t-medium{background:#fef3c7;color:#92400e} #ai-inv .t-none{background:#fee2e2;color:#991b1b}
    #ai-inv .st{color:#475569;font-size:12px}`;
    let state = { pages: [], lines: [] };
    function modal() {
        let m = document.getElementById('ai-inv');
        if (m) return m;
        const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
        m = document.createElement('div'); m.id = 'ai-inv';
        m.innerHTML = `<div class="box"><div class="hd"><b>📄 قراءة فاتورة مورد (PDF / صورة) — راجع قبل الإضافة</b><button class="b s" data-x>✕ إغلاق</button></div>
          <div class="bd"><div class="st" id="ai-status"></div><div id="ai-table"></div></div>
          <div class="ft"><div class="st">🟩 مطابقة مؤكدة · 🟨 راجعها · 🟥 لم يتم العثور على الصنف (اختره يدوياً أو اتركه)</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap"><span id="ai-rot"></span><button class="b g" id="ai-add">➕ إضافة الأسطر المحددة للفاتورة</button></div></div></div>`;
        document.body.appendChild(m);
        m.querySelector('[data-x]').onclick = () => m.classList.remove('open');
        m.querySelector('#ai-add').onclick = commit;
        return m;
    }
    const status = (t) => { const s = document.getElementById('ai-status'); if (s) s.textContent = t; };
    function render() {
        const rows = state.lines.map((ln, i) => {
            const conf = ln.match ? ln.match.confidence : 'none';
            const opts = [];
            const seen = new Set();
            if (ln.match) { opts.push([ln.match.code, ln.match.name_en]); seen.add(ln.match.code); }
            for (const c of ln.candidates || []) if (!seen.has(c.code)) { opts.push([c.code, c.name_en]); seen.add(c.code); }
            const sel = `<select data-i="${i}" data-f="product_code"><option value="">— بدون مطابقة —</option>${opts.map(([c, n]) => `<option value="${esc(c)}" ${c === ln.product_code ? 'selected' : ''}>${esc(n)} [${esc(c)}]</option>`).join('')}</select>
              <input type="text" data-i="${i}" data-f="manual_code" placeholder="أو اكتب كود الصنف" value="" style="margin-top:3px">`;
            const tag = conf === 'high' ? '<span class="tag t-high">مؤكد</span>' : conf === 'medium' ? '<span class="tag t-medium">راجع</span>' : '<span class="tag t-none">غير موجود</span>';
            return `<tr class="${conf === 'medium' ? 'low' : conf === 'none' ? 'none' : ''} ${ln.include ? '' : 'off'}">
              <td><input type="checkbox" data-i="${i}" data-f="include" ${ln.include ? 'checked' : ''}></td>
              <td>${esc(ln.page)}</td>
              <td><b>${esc(ln.name)}</b><div class="st">${esc([ln.code && 'كود: ' + ln.code, ln.gtin && 'GTIN: ' + ln.gtin].filter(Boolean).join(' · '))}</div></td>
              <td style="min-width:240px">${tag} ${sel}</td>
              <td style="width:70px"><input type="number" min="1" data-i="${i}" data-f="quantity" value="${esc(ln.quantity)}"><div class="st">${ln.bonus ? 'منها بونص ' + esc(ln.bonus) : ''}</div></td>
              <td style="width:100px"><input type="text" data-i="${i}" data-f="batch" value="${esc(ln.batch)}"></td>
              <td style="width:105px"><input type="text" data-i="${i}" data-f="expiry" value="${esc(ln.expiry)}"></td>
              <td style="width:70px">${esc(ln.unit_price || '')}</td></tr>`;
        }).join('');
        document.getElementById('ai-table').innerHTML = state.lines.length ? `<table><tr><th>✓</th><th>الصفحة</th><th>الصنف في الفاتورة</th><th>كرت الصنف المطابق</th><th>الكمية</th><th>التشغيلة</th><th>الصلاحية</th><th>سعر الوحدة</th></tr>${rows}</table>` : '<div class="st">لم يتم العثور على أسطر أصناف.</div>';
        document.querySelectorAll('#ai-table [data-i]').forEach(el => {
            el.onchange = () => {
                const ln = state.lines[+el.dataset.i], f = el.dataset.f;
                if (f === 'include') ln.include = el.checked;
                else if (f === 'manual_code') { if (el.value.trim()) { ln.product_code = el.value.trim(); ln.include = true; } }
                else { ln[f] = el.value; if (f === 'product_code') ln.include = Boolean(el.value); }
                render();
            };
        });
        document.getElementById('ai-rot').innerHTML = state.pages.map((p, i) => `<button class="b o" data-rot="${i}" title="إذا كانت الصفحة مقلوبة">🔄 تدوير ${esc(p.label)} وإعادة القراءة</button>`).join(' ');
        document.querySelectorAll('[data-rot]').forEach(b => b.onclick = () => rereadRotated(+b.dataset.rot));
    }
    function toLines(items, page) {
        return items.map(it => ({
            ...it, page, product_code: it.match ? it.match.code : '', include: Boolean(it.match),
            quantity: Math.max(1, Math.round((it.qty || 0) + (it.bonus || 0)) || 1), expiry: it.expiry_norm || it.expiry || ''
        }));
    }
    async function rereadRotated(i) {
        const pg = state.pages[i];
        pg.rot = ((pg.rot || 0) + 180) % 360;
        status(`⏳ جاري إعادة قراءة ${pg.label} بعد التدوير…`);
        try {
            const items = await readPage(pg, pg.rot || 180);
            state.lines = state.lines.filter(l => l.page !== pg.label).concat(toLines(items, pg.label));
            status(`✅ تمت إعادة القراءة: ${items.length} سطر في ${pg.label}`);
        } catch (e) { status('❌ ' + e.message); }
        render();
    }
    async function start(files) {
        const m = modal(); m.classList.add('open');
        state = { pages: [], lines: [] }; render();
        try {
            for (const f of files) { status(`⏳ جاري تجهيز ${f.name}…`); state.pages.push(...await filePages(f)); }
            for (let i = 0; i < state.pages.length; i++) {
                const pg = state.pages[i];
                status(`⏳ جاري قراءة ${pg.label} (${i + 1} من ${state.pages.length}) بالذكاء الاصطناعي… قد يستغرق 10-40 ثانية`);
                state.lines.push(...toLines(await readPage(pg), pg.label));
                render();
            }
            const ok = state.lines.filter(l => l.include).length;
            status(`✅ تمت القراءة: ${state.lines.length} سطر، منها ${ok} مطابقة مع كروت الأصناف. راجع الأسطر ثم اضغط "إضافة".`);
        } catch (e) { status('❌ تعذرت القراءة: ' + e.message); }
        render();
    }
    async function commit() {
        const lines = state.lines.filter(l => l.include && l.product_code).map(l => ({ product_code: l.product_code, batch: l.batch, expiry: l.expiry, quantity: +l.quantity || 1 }));
        if (!lines.length) { status('لا توجد أسطر محددة للإضافة'); return; }
        status('⏳ جاري الإضافة للفاتورة…');
        try {
            const inv = (typeof activeInvoice !== 'undefined' && activeInvoice) ? activeInvoice.id : 0;
            const d = await api('/api/invoice/ai/commit', { invoice_id: inv, lines });
            if (typeof renderInvoice === 'function' && d.invoice) renderInvoice(d.invoice);
            status('✅ ' + d.message + (d.errors && d.errors.length ? ' — ' + d.errors.join(' | ') : ''));
            setTimeout(() => document.getElementById('ai-inv').classList.remove('open'), 1500);
        } catch (e) { status('❌ ' + e.message); }
    }

    // زر جديد بجوار زر استيراد ملف الفاتورة
    function mountButton() {
        const anchor = document.getElementById('btn-trigger-inv-upload');
        if (!anchor || document.getElementById('btn-ai-invoice')) return Boolean(anchor);
        const b = document.createElement('button');
        b.id = 'btn-ai-invoice'; b.type = 'button';
        b.className = 'h-[31px] px-2 bg-violet-50 hover:bg-violet-100 text-violet-700 border border-violet-200 rounded-lg text-xs font-bold transition';
        b.title = 'قراءة فاتورة مورد من PDF أو صورة بالذكاء الاصطناعي';
        b.textContent = '📄 PDF/صورة';
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.pdf,image/*'; inp.multiple = true; inp.className = 'hidden';
        b.onclick = () => inp.click();
        inp.onchange = () => { const fs = [...(inp.files || [])]; inp.value = ''; if (fs.length) start(fs); };
        anchor.insertAdjacentElement('afterend', b); b.insertAdjacentElement('afterend', inp);
        return true;
    }
    if (!mountButton()) { const t = setInterval(() => { if (mountButton()) clearInterval(t); }, 500); setTimeout(() => clearInterval(t), 20000); }
    window.RambfeInvoiceAI = { start };
})();
