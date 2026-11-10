/**
 * Cloudflare Worker for RAMBFE (Invoice Matcher & Real-time Stocktake)
 * Serves frontend static assets via env.ASSETS and proxies /api/* routes with 24/7 Auto-Healing Tunnel Discovery.
 */
import { isCloudRoute, handleCloudApi } from './cloud/router.js';

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
let activeTunnelUrl = "";
const TUNNEL_CACHE_KEY = "https://rambfe.internal/active-tunnel-url";
const KV_KEY = "active_tunnel_url";

// التخزين الأساسي: Workers KV (عالمي ودائم ولا يضيع عند إعادة تشغيل الـ Worker). الكاش احتياطي فقط.
async function saveTunnel(env, tunnelUrl) {
    if (!tunnelUrl) return;
    try { if (env && env.TUNNEL_KV) await env.TUNNEL_KV.put(KV_KEY, tunnelUrl); } catch (_) {}
    try {
        await caches.default.put(TUNNEL_CACHE_KEY, new Response(tunnelUrl, {
            headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=604800' }
        }));
    } catch (_) {}
}

async function loadTunnel(env) {
    try {
        if (env && env.TUNNEL_KV) {
            const v = ((await env.TUNNEL_KV.get(KV_KEY)) || '').trim();
            if (v.startsWith('http')) return v.replace(/\/+$/, '');
        }
    } catch (_) {}
    try {
        const resp = await caches.default.match(TUNNEL_CACHE_KEY);
        if (resp && resp.ok) {
            const txt = (await resp.text()).trim();
            if (txt.startsWith('http')) return txt.replace(/\/+$/, '');
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
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token'
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
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token'
                }
            });
        }

        // مسارات تسجيل وفحص النفق المباشرة في الـ Worker
        if (path === '/api/tunnel/register') {
            let body = {};
            try {
                body = await request.json();
            } catch (_) {}
            if (env.REGISTER_SECRET && request.headers.get('X-Register-Secret') !== env.REGISTER_SECRET) {
                return jsonResponse({ success: false, message: 'unauthorized' }, 401);
            }
            const newTunnel = String(body.tunnel_url || '').trim().replace(/\/+$/, '');
            if (/^https:\/\/[a-z0-9.-]+$/i.test(newTunnel) && newTunnel !== activeTunnelUrl) {
                activeTunnelUrl = newTunnel;
                await saveTunnel(env, newTunnel);
            }
            return jsonResponse({
                success: true,
                message: 'تم تسجيل نفق Cloudflare بنجاح والمزامنة الحية مفعلة 24/7',
                active_tunnel: activeTunnelUrl
            });
        }

        if (path === '/api/tunnel/status') {
            const storedTunnel = await loadTunnel(env);
            if (storedTunnel) activeTunnelUrl = storedTunnel;
            return jsonResponse({
                is_connected: Boolean(activeTunnelUrl),
                tunnel_url: activeTunnelUrl,
                kv_enabled: Boolean(env.TUNNEL_KV),
                worker_version: "20261110_v16_kv"
            });
        }

        // قراءة جسم الطلب مرة واحدة لإعادة استخدامه في حال تجربة أكثر من رابط نفق
        let rawProxyBody = null;
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
            try {
                rawProxyBody = await request.arrayBuffer();
            } catch (_) {}
        }

        // 0. عمليات الجرد والأصناف تعمل مباشرة على قاعدة بيانات Cloudflare D1 (بدون الحاجة لتشغيل الكمبيوتر)
        if (env.DB && isCloudRoute(method, path)) {
            const cloudRes = await handleCloudApi(request, env, ctx, url, rawProxyBody);
            if (cloudRes) return cloudRes;
        }

        // 1. محاولة تمرير الطلب لنفق الكمبيوتر النشط، ثم الكاش السحابي، ثم الاكتشاف التلقائي من GitHub
        if (!path.startsWith('/api/tunnel/')) {
            const tried = new Set();

            if (activeTunnelUrl) {
                tried.add(activeTunnelUrl);
                const proxied = await proxyToTunnelCandidate(activeTunnelUrl, request, url, path, method, rawProxyBody);
                if (proxied) return proxied;
            }

            const storedTunnel = await loadTunnel(env);
            if (storedTunnel && !tried.has(storedTunnel)) {
                tried.add(storedTunnel);
                const proxied = await proxyToTunnelCandidate(storedTunnel, request, url, path, method, rawProxyBody);
                if (proxied) {
                    activeTunnelUrl = storedTunnel;
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
                message: activeTunnelUrl ? 'جاري تجديد الاتصال التلقائي بالسيرفر المحلي خلال ثوانٍ...' : 'البرنامج غير متصل حالياً: تأكد أن البرنامج يعمل على كمبيوتر الصيدلية وأنه متصل بالإنترنت.'
            }, 503);
        }

        // توجيه المسار /mobile لصفحة mobile.html
        if (path === '/mobile' || path === '/mobile.html') {
            // Pages يحوّل mobile.html إلى /mobile و Workers العكس: نجرب الاثنين ونرجع المحتوى مباشرة بدون أي تحويل (منع حلقة التحويل)
            if (env.ASSETS) {
                for (const p of ['/mobile.html', '/mobile']) {
                    const r = await env.ASSETS.fetch(new Request(new URL(p, request.url), { method: 'GET', headers: request.headers }));
                    if (r.status === 200) return r;
                }
            }
        }

        // خدمة ملفات الواجهة من مجلد frontend
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response("RAMBFE Cloudflare Worker Active (24/7 Auto-Heal)", { status: 200 });
    }
};
