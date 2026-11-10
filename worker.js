/**
 * Cloudflare Worker for RAMBFE (Invoice Matcher & Real-time Stocktake)
 * Serves frontend static assets via env.ASSETS and proxies /api/* routes with 24/7 Auto-Healing Tunnel Discovery.
 */

// لا توجد أي بيانات وهمية إطلاقاً لمنع ظهور أصناف غير حقيقية أو مسح الشاشة عند تجديد النفق
let memoryProducts = [];
let memoryStores = [];
let memoryStocktakeItems = [];

let memoryDraftInvoice = {
    id: 1,
    invoice_number: 'INV-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-0001',
    status: 'draft',
    date: new Date().toISOString().slice(0, 10),
    user_name: 'المسؤول',
    lines: []
};

let memoryEvents = [];
let activeTunnelUrl = "https://zoo-waiting-baskets-popular.trycloudflare.com";
const TUNNEL_CACHE_KEY = "https://rambfe.internal/active-tunnel-url";

async function saveTunnelToCache(tunnelUrl) {
    if (!tunnelUrl) return;
    try {
        const cache = caches.default;
        const resp = new Response(tunnelUrl, {
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'public, max-age=604800'
            }
        });
        await cache.put(TUNNEL_CACHE_KEY, resp);
    } catch (_) {}
}

async function getTunnelFromCache() {
    try {
        const cache = caches.default;
        const resp = await cache.match(TUNNEL_CACHE_KEY);
        if (resp && resp.ok) {
            const txt = (await resp.text()).trim();
            if (txt.startsWith('http')) return txt.replace(/\/+$/, '');
        }
    } catch (_) {}
    return '';
}

async function discoverTunnelFromGitHub() {
    try {
        const ghUrl = `https://raw.githubusercontent.com/ramadanfarabi7879-collab/RAMBFE/main/worker.js?t=${Math.floor(Date.now() / 15000)}`;
        const resp = await fetch(ghUrl, {
            headers: { 'User-Agent': 'RAMBFE-Worker-Discovery/3.0' }
        });
        if (resp.ok) {
            const text = await resp.text();
            const m = text.match(/let\s+activeTunnelUrl\s*=\s*"(https:\/\/[^"]+)"/);
            if (m && m[1]) {
                return m[1].trim().replace(/\/+$/, '');
            }
        }
    } catch (_) {}
    return '';
}

async function proxyToTunnelCandidate(candidateUrl, request, url, path, method, rawProxyBody) {
    if (!candidateUrl || !candidateUrl.startsWith('http')) return null;
    try {
        const targetUrl = new URL(path + url.search, candidateUrl);
        const proxyHeaders = new Headers(request.headers);
        proxyHeaders.set('Host', new URL(candidateUrl).host);
        proxyHeaders.set('X-Forwarded-Host', url.host);

        const reqInit = {
            method: method,
            headers: proxyHeaders
        };
        if (!['GET', 'HEAD'].includes(method) && rawProxyBody) {
            reqInit.body = rawProxyBody;
            reqInit.duplex = 'half';
        }
        const proxyReq = new Request(targetUrl.toString(), reqInit);
        const resp = await fetch(proxyReq);
        // أكواد 530 / 502 / 504 من Cloudflare تعني أن النفق المؤقت قد انتهت صلاحيته ويتم تجديده
        if (resp.status >= 200 && resp.status < 500) {
            const respHeaders = new Headers(resp.headers);
            respHeaders.set('Access-Control-Allow-Origin', '*');
            respHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
            respHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            respHeaders.set('Cache-Control', 'no-cache, no-store, must-revalidate, max-age=0');
            return new Response(resp.body, {
                status: resp.status,
                statusText: resp.statusText,
                headers: respHeaders
            });
        }
    } catch (_) {}
    return null;
}

function broadcastEvent(type, payload) {
    const evt = {
        id: Math.random().toString(36).substring(2, 10),
        type,
        payload: payload || {},
        timestamp: Date.now() / 1000
    };
    memoryEvents.push(evt);
    if (memoryEvents.length > 200) memoryEvents.splice(0, 100);
    return evt;
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
    });
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        if (method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
                }
            });
        }

        // مسارات تسجيل وفحص النفق المباشرة في الـ Worker
        if (path === '/api/tunnel/register') {
            let body = {};
            try {
                body = await request.json();
            } catch (_) {}
            const newTunnel = String(body.tunnel_url || '').trim().replace(/\/+$/, '');
            if (newTunnel && newTunnel.startsWith('http')) {
                activeTunnelUrl = newTunnel;
                await saveTunnelToCache(newTunnel);
            }
            return jsonResponse({
                success: true,
                message: 'تم تسجيل نفق Cloudflare بنجاح والمزامنة الحية مفعلة 24/7',
                active_tunnel: activeTunnelUrl
            });
        }

        if (path === '/api/tunnel/status') {
            const cachedTunnel = await getTunnelFromCache();
            if (cachedTunnel && cachedTunnel !== activeTunnelUrl) {
                activeTunnelUrl = cachedTunnel;
            }
            return jsonResponse({
                is_connected: Boolean(activeTunnelUrl),
                tunnel_url: activeTunnelUrl,
                worker_version: "20261108_v15_autoheal"
            });
        }

        // قراءة جسم الطلب مرة واحدة لإعادة استخدامه في حال تجربة أكثر من رابط نفق
        let rawProxyBody = null;
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
            try {
                rawProxyBody = await request.arrayBuffer();
            } catch (_) {}
        }

        // 1. محاولة تمرير الطلب لنفق الكمبيوتر النشط، ثم الكاش السحابي، ثم الاكتشاف التلقائي من GitHub
        if (!path.startsWith('/api/tunnel/')) {
            const tried = new Set();

            if (activeTunnelUrl) {
                tried.add(activeTunnelUrl);
                const proxied = await proxyToTunnelCandidate(activeTunnelUrl, request, url, path, method, rawProxyBody);
                if (proxied) return proxied;
            }

            const cachedTunnel = await getTunnelFromCache();
            if (cachedTunnel && !tried.has(cachedTunnel)) {
                tried.add(cachedTunnel);
                const proxied = await proxyToTunnelCandidate(cachedTunnel, request, url, path, method, rawProxyBody);
                if (proxied) {
                    activeTunnelUrl = cachedTunnel;
                    return proxied;
                }
            }

            const ghTunnel = await discoverTunnelFromGitHub();
            if (ghTunnel && !tried.has(ghTunnel)) {
                tried.add(ghTunnel);
                const proxied = await proxyToTunnelCandidate(ghTunnel, request, url, path, method, rawProxyBody);
                if (proxied) {
                    activeTunnelUrl = ghTunnel;
                    await saveTunnelToCache(ghTunnel);
                    return proxied;
                }
            }
        }

        // 2. إذا كان الطلب مسار API والنفق في لحظة تجديد (ثوانٍ معدودة):
        // نُرجع كود 503 بدون أي بيانات وهمية حتى لا يقوم المتصفح بمسح بيانات المستخدم الحقيقية من الشاشة!
        if (path.startsWith('/api/')) {
            if (path === '/api/network-info') {
                const origin = url.origin;
                return jsonResponse({
                    ip: 'Cloudflare Edge CDN',
                    port: 443,
                    mobile_url: `${origin}/`,
                    local_mobile_url: `${origin}/`,
                    cloudflare_url: origin,
                    is_cloudflare_active: true
                });
            }

            if (path === '/api/sync/events' || path === '/api/mobile/poll') {
                const since = parseFloat(url.searchParams.get('since') || '0');
                const evts = memoryEvents.filter(e => e.timestamp > since);
                const scans = evts.filter(e => e.type === 'mobile_scan').map(e => e.payload);
                return jsonResponse({
                    events: evts,
                    scans: scans,
                    timestamp: Date.now() / 1000
                });
            }

            return jsonResponse({
                success: false,
                offline_reconnecting: true,
                message: 'جاري تجديد الاتصال التلقائي بالسيرفر المحلي خلال ثوانٍ...'
            }, 503);
        }

        // توجيه المسار /mobile لصفحة mobile.html
        if (path === '/mobile' || path === '/mobile.html') {
            const mobileReq = new Request(new URL('/mobile.html', request.url), request);
            if (env.ASSETS) {
                return env.ASSETS.fetch(mobileReq);
            }
        }

        // خدمة ملفات الواجهة من مجلد frontend
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response("RAMBFE Cloudflare Worker Active (24/7 Auto-Heal)", { status: 200 });
    }
};
