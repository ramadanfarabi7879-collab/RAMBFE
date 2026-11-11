// Service Worker: يخلي صفحات البرنامج تفتح حتى من غير إنترنت (تطبيق ويب PWA).
// - الصفحات (HTML): من الشبكة أولاً (عشان أي تحديث ينزل فوراً)، ولو مفيش نت من النسخة المحفوظة.
// - ملفات الواجهة والمكتبات (JS/CSS/خطوط): من النسخة المحفوظة فوراً مع تحديثها في الخلفية.
// - طلبات /api لا يلمسها هنا: وضع عدم الاتصال للبيانات في offline.js.
const CACHE = 'rambfe-shell-v2';
const CORE = ['/', '/mobile', '/offline.js?v=2', '/profile.js?v=4', '/cloud-qr.js', '/manifest.webmanifest', '/icon-192.png'];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => { })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
    e.waitUntil((async () => {
        for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
        await self.clients.claim();
    })());
});
// الصفحة تبعت قائمة الملفات اللي حمّلتها فعلاً (بنفس أرقام الإصدارات) عشان تتحفظ كلها
self.addEventListener('message', (e) => {
    const d = e.data || {};
    if (d.type !== 'cache-urls' || !Array.isArray(d.urls)) return;
    e.waitUntil(caches.open(CACHE).then(async (c) => {
        for (const u of d.urls.slice(0, 80)) {
            try {
                if (await c.match(u)) continue;
                const cross = new URL(u).origin !== self.location.origin;
                const res = await fetch(u, cross ? { mode: 'no-cors' } : {});
                if (res.ok || res.type === 'opaque') await c.put(u, res);
            } catch (_) { }
        }
    }));
});

const isApi = (url) => url.origin === self.location.origin && url.pathname.startsWith('/api/');
const isAsset = (url) => /\.(js|css|png|svg|ico|woff2?|ttf|webmanifest|json)$/i.test(url.pathname) || url.origin !== self.location.origin;

self.addEventListener('fetch', (e) => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (isApi(url) || url.protocol.startsWith('chrome-extension')) return;
    // الكتالوج الأساسي (7 ميجا) بيتحفظ في IndexedDB من offline.js: مش محتاج نسخة تانية هنا
    if (url.pathname === '/sw.js' || url.pathname === '/base-catalog.json') return;

    if (req.mode === 'navigate') {
        e.respondWith((async () => {
            const c = await caches.open(CACHE);
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 6000);
                const res = await fetch(req, { signal: ctrl.signal });
                clearTimeout(t);
                if (res.ok) c.put(req, res.clone());
                return res;
            } catch (_) {
                return (await c.match(req, { ignoreSearch: true })) || (await c.match(url.pathname.startsWith('/mobile') ? '/mobile' : '/'))
                    || new Response('<meta charset="utf-8"><h3 dir="rtl">مفيش اتصال بالإنترنت، وافتح البرنامج مرة واحدة وانت متصل عشان يشتغل بعد كده من غير نت.</h3>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
            }
        })());
        return;
    }
    if (isAsset(url)) {
        e.respondWith((async () => {
            const c = await caches.open(CACHE);
            const hit = await c.match(req);
            const net = fetch(req).then(res => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()); return res; }).catch(() => null);
            if (hit) { e.waitUntil(net); return hit; }
            return (await net) || new Response('', { status: 504 });
        })());
    }
});
