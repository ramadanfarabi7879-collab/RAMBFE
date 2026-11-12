/**
 * شريط الحد اليومي للسحابة (Cloudflare D1): قراءات وكتابات اليوم من الحد المجاني
 * - بيتحدث لحظياً من رأس X-Rambfe-Usage اللي راجع مع كل عملية (offline.js بيبعته كحدث rambfe:usage)
 * - ومن الاتصال اللحظي (مركز المزامنة) أول ما الصفحة تفتح ومع أي استهلاك من أي جهاز
 * الشريط نفسه مبيعملش أي طلب للسحابة خالص: صفر استهلاك
 */
(function () {
    'use strict';
    if (window.__rambfeUsageBar) return;
    window.__rambfeUsageBar = true;

    const LS_KEY = 'rambfe_usage_v1';
    const READS_PER_SCAN = 35; // متوسط قراءات عملية المسح الواحدة بعد التحسينات
    let data = null, lastTs = 0, open = false, offline = false, shown = { r: 0, w: 0 };
    let els = null;

    const fmt = (n) => Math.round(n).toLocaleString('en-US');
    const short = (n) => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M'
        : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k' : String(Math.round(n));
    const pct = (u, l) => (l ? Math.min(100, (u * 100) / l) : 0);
    const pctText = (p) => (p > 0 && p < 0.1 ? '<0.1' : p < 10 && p % 1 ? p.toFixed(1).replace(/\.0$/, '') : Math.round(p)) + '%';
    const level = (p) => (p >= 80 ? 'danger' : p >= 50 ? 'warn' : 'ok');
    const nextUtcMidnight = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };

    function resetText(at) {
        const ms = Math.max(0, (at || nextUtcMidnight()) - Date.now());
        const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
        if (h <= 0 && m <= 0) return 'بيتجدد دلوقتي';
        return 'يتجدد بعد ' + (h > 0 ? `${h} س ` : '') + `${m} د`;
    }
    function resetClock(at) {
        try { return new Date(at || nextUtcMidnight()).toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; }
    }
    function agoText() {
        if (!lastTs) return '—';
        const s = Math.round((Date.now() - lastTs) / 1000);
        if (s < 5) return 'دلوقتي';
        if (s < 60) return `من ${s} ث`;
        const m = Math.round(s / 60);
        return m < 60 ? `من ${m} د` : `من ${Math.round(m / 60)} س`;
    }

    // ---------------- الشكل ----------------
    const CSS = `
.rbu{--rbu-ok1:#10b981;--rbu-ok2:#34d399;--rbu-warn1:#f59e0b;--rbu-warn2:#fbbf24;--rbu-bad1:#ef4444;--rbu-bad2:#fb7185;
  font-family:'Cairo',system-ui,sans-serif;color:#e2e8f0;border-top:1px solid rgba(148,163,184,.14);background:linear-gradient(180deg,rgba(15,23,42,.35),rgba(15,23,42,.6))}
.rbu-row{display:flex;align-items:center;gap:10px;padding:5px 12px;cursor:pointer;user-select:none;min-height:28px}
.rbu-row:hover{background:rgba(148,163,184,.06)}
.rbu-live{display:flex;align-items:center;gap:5px;font-size:10px;font-weight:800;color:#94a3b8;flex-shrink:0}
.rbu-dot{position:relative;width:7px;height:7px;border-radius:50%;background:#64748b}
.rbu-live.on .rbu-dot{background:#34d399}
.rbu-live.on .rbu-dot::after{content:'';position:absolute;inset:-3px;border-radius:50%;border:2px solid #34d399;opacity:0;animation:rbu-ping 2s ease-out infinite}
.rbu-live.on{color:#6ee7b7}
@keyframes rbu-ping{0%{transform:scale(.6);opacity:.8}100%{transform:scale(1.8);opacity:0}}
.rbu-title{font-size:11px;font-weight:800;color:#cbd5e1;white-space:nowrap;flex-shrink:0}
.rbu-track{position:relative;flex:1;min-width:60px;height:7px;border-radius:99px;background:rgba(148,163,184,.18);overflow:hidden}
.rbu-fill{position:absolute;inset-block:0;inset-inline-start:0;width:0;border-radius:99px;transition:width .7s cubic-bezier(.22,1,.36,1),background .4s;
  background:linear-gradient(90deg,var(--rbu-ok1),var(--rbu-ok2));min-width:3px}
.rbu-fill.warn{background:linear-gradient(90deg,var(--rbu-warn1),var(--rbu-warn2))}
.rbu-fill.danger{background:linear-gradient(90deg,var(--rbu-bad1),var(--rbu-bad2))}
.rbu-fill::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.55),transparent);transform:translateX(-100%);opacity:0}
.rbu-fill.pulse::after{animation:rbu-shine .9s ease-out}
@keyframes rbu-shine{0%{transform:translateX(100%);opacity:1}100%{transform:translateX(-100%);opacity:0}}
.rbu-pct{font:800 12px 'JetBrains Mono',ui-monospace,monospace;color:#f8fafc;min-width:44px;text-align:center;flex-shrink:0;direction:ltr}
.rbu-meta{font-size:10.5px;color:#94a3b8;white-space:nowrap;flex-shrink:0}
.rbu-chev{font-size:10px;color:#94a3b8;transition:transform .25s;flex-shrink:0}
.rbu.open .rbu-chev{transform:rotate(180deg)}
.rbu-badge{font-size:10px;font-weight:800;padding:1px 7px;border-radius:99px;flex-shrink:0;display:none}
.rbu-badge.show{display:inline-block}
.rbu-badge.warn{background:rgba(245,158,11,.18);color:#fcd34d;border:1px solid rgba(245,158,11,.35)}
.rbu-badge.danger{background:rgba(239,68,68,.18);color:#fca5a5;border:1px solid rgba(239,68,68,.4)}
.rbu-panel{display:grid;grid-template-rows:0fr;transition:grid-template-rows .3s ease}
.rbu.open .rbu-panel{grid-template-rows:1fr}
.rbu-inner{overflow:hidden}
.rbu-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;padding:4px 12px 10px}
.rbu-card{background:rgba(30,41,59,.75);border:1px solid rgba(148,163,184,.16);border-radius:14px;padding:11px 13px}
.rbu-card-h{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px}
.rbu-card-t{font-size:12.5px;font-weight:800;color:#f1f5f9}
.rbu-card-s{font-size:10.5px;color:#94a3b8;margin-top:1px}
.rbu-big{font:800 20px 'JetBrains Mono',ui-monospace,monospace;color:#fff;direction:ltr}
.rbu-card .rbu-track{height:9px}
.rbu-nums{display:flex;justify-content:space-between;gap:8px;margin-top:7px;font-size:11px;color:#cbd5e1}
.rbu-nums b{font-family:'JetBrains Mono',ui-monospace,monospace;color:#fff;font-weight:700}
.rbu-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:6px 14px;padding:0 12px 10px;font-size:10.5px;color:#94a3b8}
.rbu-foot b{color:#e2e8f0;font-weight:700}
@media (max-width:640px){.rbu-title .rbu-long{display:none}.rbu-row{gap:8px;padding:5px 10px}.rbu-meta.rbu-reset{display:none}}
@media (prefers-reduced-motion:reduce){.rbu-fill,.rbu-panel,.rbu-chev{transition:none}.rbu-live.on .rbu-dot::after,.rbu-fill.pulse::after{animation:none}}
`;

    function card(id, title, sub) {
        return `<div class="rbu-card">
  <div class="rbu-card-h"><div><div class="rbu-card-t">${title}</div><div class="rbu-card-s">${sub}</div></div><div class="rbu-big" id="rbu-${id}-pct">—</div></div>
  <div class="rbu-track"><div class="rbu-fill" id="rbu-${id}-fill"></div></div>
  <div class="rbu-nums"><span>المستخدم: <b id="rbu-${id}-used">—</b></span><span>من <b id="rbu-${id}-lim">—</b></span></div>
  <div class="rbu-nums"><span>المتبقي: <b id="rbu-${id}-left">—</b></span><span id="rbu-${id}-hint"></span></div>
</div>`;
    }

    function mount() {
        const header = document.querySelector('header');
        if (!header || document.getElementById('rbu')) return false;
        const st = document.createElement('style');
        st.textContent = CSS;
        document.head.appendChild(st);
        const box = document.createElement('div');
        box.id = 'rbu';
        box.className = 'rbu';
        box.setAttribute('dir', 'rtl');
        box.innerHTML = `
<div class="rbu-row" role="button" tabindex="0" aria-expanded="false" aria-controls="rbu-panel" title="الحد اليومي المجاني لقاعدة بيانات السحابة — اضغط للتفاصيل">
  <span class="rbu-live" id="rbu-live"><span class="rbu-dot"></span><span id="rbu-live-t">مباشر</span></span>
  <span class="rbu-title">☁️ <span class="rbu-long">الحد اليومي للسحابة</span><span id="rbu-kind"></span></span>
  <div class="rbu-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" id="rbu-bar"><div class="rbu-fill" id="rbu-fill"></div></div>
  <span class="rbu-pct" id="rbu-pct">—</span>
  <span class="rbu-badge" id="rbu-badge"></span>
  <span class="rbu-meta rbu-reset" id="rbu-reset"></span>
  <span class="rbu-chev">▼</span>
</div>
<div class="rbu-panel" id="rbu-panel"><div class="rbu-inner">
  <div class="rbu-cards">
    ${card('r', 'القراءة من قاعدة البيانات', 'بحث، فتح استور، مسح أصناف')}
    ${card('w', 'الكتابة في قاعدة البيانات', 'حفظ الجرد، رفع ملفات، تعديل أصناف')}
  </div>
  <div class="rbu-foot">
    <span>🔄 الحد بيتجدد كل يوم الساعة <b id="rbu-clock">—</b> بتوقيتك (<span id="rbu-reset2">—</span>)</span>
    <span>آخر تحديث: <b id="rbu-ago">—</b></span>
    <span style="flex-basis:100%">الأرقام دي استهلاك البرنامج نفسه، ولوحة Cloudflare ممكن تفرق عنها شوية. ولما الاستهلاك يعدّي 80% البرنامج بيدخل وضع التوفير لوحده.</span>
  </div>
</div></div>`;
        header.appendChild(box);
        const row = box.querySelector('.rbu-row');
        const setOpen = (v) => {
            open = v;
            box.classList.toggle('open', open);
            row.setAttribute('aria-expanded', String(open));
        };
        const toggle = () => setOpen(!open);
        row.addEventListener('click', toggle);
        // التفاصيل بتتقفل لما تدوس برّه (الرأس ثابت فوق الشاشة، فمتفضلش مغطية الماسح)
        document.addEventListener('pointerdown', (e) => { if (open && !box.contains(e.target)) setOpen(false); });
        document.addEventListener('keydown', (e) => { if (open && e.key === 'Escape') setOpen(false); });
        row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
        els = {
            box, live: box.querySelector('#rbu-live'), liveT: box.querySelector('#rbu-live-t'), kind: box.querySelector('#rbu-kind'),
            bar: box.querySelector('#rbu-bar'), fill: box.querySelector('#rbu-fill'), pct: box.querySelector('#rbu-pct'),
            badge: box.querySelector('#rbu-badge'), reset: box.querySelector('#rbu-reset'), reset2: box.querySelector('#rbu-reset2'),
            clock: box.querySelector('#rbu-clock'), ago: box.querySelector('#rbu-ago'),
        };
        return true;
    }

    // عدّ الأرقام بشكل ناعم من القيمة القديمة للجديدة
    function tween(key, to, apply) {
        const from = shown[key] || 0;
        if (from === to) { apply(to); return; }
        const t0 = performance.now(), dur = 600;
        const run = (tween.runs = tween.runs || {})[key] = {};
        const finish = () => { if (run.done || tween.runs[key] !== run) return; run.done = true; apply(to); shown[key] = to; };
        const step = (t) => {
            if (run.done || tween.runs[key] !== run) return;
            const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
            apply(from + (to - from) * e);
            if (k < 1) requestAnimationFrame(step); else finish();
        };
        // الصفحة في الخلفية أو شاشة الموبايل مقفولة: الحركة مبتشتغلش، فالرقم النهائي يتكتب على طول
        if (document.hidden) { finish(); return; }
        requestAnimationFrame(step);
        setTimeout(finish, dur + 250);
    }

    function setFill(el, p) {
        el.style.width = Math.max(p, 0.4) + '%';
        el.classList.remove('ok', 'warn', 'danger');
        el.classList.add(level(p));
    }

    function renderCard(id, used, lim, hint) {
        const p = pct(used, lim);
        setFill(document.getElementById(`rbu-${id}-fill`), p);
        tween(id, used, (v) => {
            const u = document.getElementById(`rbu-${id}-used`); if (u) u.textContent = fmt(v);
            const pp = document.getElementById(`rbu-${id}-pct`); if (pp) pp.textContent = pctText(pct(v, lim));
            const l = document.getElementById(`rbu-${id}-left`); if (l) l.textContent = fmt(Math.max(0, lim - v));
        });
        document.getElementById(`rbu-${id}-lim`).textContent = fmt(lim);
        document.getElementById(`rbu-${id}-hint`).textContent = hint || '';
    }

    function render(pulse) {
        if (!els) return;
        const rt = window.RambfeRealtime;
        const fresh = !offline && (rt ? rt.connected : (lastTs && Date.now() - lastTs < 3 * 60 * 1000));
        els.live.classList.toggle('on', !!fresh);
        els.liveT.textContent = offline ? 'غير متصل' : fresh ? 'مباشر' : 'آخر قراءة';
        els.ago.textContent = agoText();
        const at = data && data.resetsAt > Date.now() ? data.resetsAt : nextUtcMidnight();
        els.reset.textContent = resetText(at);
        els.reset2.textContent = resetText(at);
        els.clock.textContent = resetClock(at);
        if (!data) return;
        const rp = pct(data.reads, data.readLimit), wp = pct(data.writes, data.writeLimit);
        // الشريط الرئيسي بيعرض الأعلى استهلاكاً من الاتنين (زي ما الحد اللي هيخلص الأول هو اللي يهم)
        const useW = wp > rp && wp >= 1;
        const p = useW ? wp : rp;
        els.kind.textContent = useW ? ' · كتابة' : '';
        setFill(els.fill, p);
        if (pulse) { els.fill.classList.remove('pulse'); void els.fill.offsetWidth; els.fill.classList.add('pulse'); }
        tween('main', p, (v) => { els.pct.textContent = pctText(v); });
        els.bar.setAttribute('aria-valuenow', String(Math.round(p)));
        els.bar.setAttribute('aria-label', `مستخدم ${pctText(p)} من الحد اليومي`);
        const lv = level(p);
        els.badge.className = 'rbu-badge' + (lv !== 'ok' ? ' show ' + lv : '');
        els.badge.textContent = p >= 100 ? 'الحد خلص — شغال من الجهاز' : lv === 'danger' ? 'وضع التوفير' : lv === 'warn' ? 'استهلاك عالي' : '';
        const leftScans = Math.floor(Math.max(0, data.readLimit - data.reads) / READS_PER_SCAN);
        renderCard('r', data.reads, data.readLimit, `≈ ${short(leftScans)} عملية مسح متبقية`);
        renderCard('w', data.writes, data.writeLimit, '');
    }

    function accept(d, pulse) {
        if (!d || !Number.isFinite(d.reads) || !d.readLimit) return;
        const changed = !data || d.reads !== data.reads || d.writes !== data.writes;
        // يوم جديد: الأرقام بتبدأ من الصفر
        if (data && d.resetsAt && data.resetsAt && d.resetsAt !== data.resetsAt) shown = { r: 0, w: 0 };
        data = { reads: d.reads, readLimit: d.readLimit, writes: d.writes || 0, writeLimit: d.writeLimit || 100000, resetsAt: d.resetsAt || nextUtcMidnight() };
        lastTs = d.ts || Date.now();
        offline = false;
        try { localStorage.setItem(LS_KEY, JSON.stringify({ ...data, ts: lastTs })); } catch (_) { }
        render(pulse && changed);
    }

    function start() {
        if (!mount()) return;
        try {
            const c = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
            if (c && c.resetsAt > Date.now()) { data = c; lastTs = c.ts || 0; shown = { r: c.reads, w: c.writes, main: pct(Math.max(c.reads / c.readLimit, c.writes / c.writeLimit), 1) }; }
        } catch (_) { }
        render(false);
        // تحديث العدّ التنازلي وحالة الاتصال بس (على الجهاز، من غير أي طلب)
        setInterval(() => render(false), 5000);
        window.addEventListener('online', () => { offline = false; render(false); });
        window.addEventListener('offline', () => { offline = true; render(false); });
    }

    window.addEventListener('rambfe:usage', (e) => accept(e.detail, true));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
