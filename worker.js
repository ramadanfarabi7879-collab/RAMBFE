/**
 * Cloudflare Worker for RAMBFE (Invoice Matcher & Real-time Stocktake)
 * Serves frontend static assets via env.ASSETS and handles /api/* routes with Real-Time Sync.
 */

let memoryProducts = [
    { id: 1, code: 'MED-001', name: 'PANADOL EXTRA 500MG (بنادول إكسترا)', barcode: '6221111111111', gtin: '06221111111111', price: 15.50, cost: 12.00, tax: 0, category: 'MEDICINE' },
    { id: 2, code: 'MED-002', name: 'AUGMENTIN 1G 14 TAB (أوجمنتين 1 جم)', barcode: '6222222222222', gtin: '06222222222222', price: 54.00, cost: 45.00, tax: 0, category: 'MEDICINE' },
    { id: 3, code: 'MED-003', name: 'CONCOR 5MG 30 TAB (كونكور 5 ملغ)', barcode: '6223333333333', gtin: '06223333333333', price: 32.50, cost: 26.00, tax: 0, category: 'MEDICINE' },
    { id: 4, code: 'COS-001', name: 'CETAPHIL GENTLE SKIN CLEANSER (غسول سيتافيل)', barcode: '6224444444444', gtin: '06224444444444', price: 85.00, cost: 68.00, tax: 0, category: 'COSMETICS' },
    { id: 5, code: 'COS-002', name: 'BEESLINE LIP BALM (مرطب بيزلين)', barcode: '6225555555555', gtin: '06225555555555', price: 20.00, cost: 15.00, tax: 0, category: 'COSMETICS' }
];

let memoryStores = [
    { id: 1, store_no: 'ST-001', store_name: 'المستودع الرئيسي', branch_name: 'الفرع الرئيسي', status: 'active', count_items: 3, actual_qty: 25, system_qty: 20 }
];

let memoryStocktakeItems = [
    { entry_id: 1, store_no: 'ST-001', product_code: 'MED-001', item_name: 'PANADOL EXTRA 500MG (بنادول إكسترا)', barcode: '6221111111111', batch_number: 'B2401', expiry_date: '2027-10', actual_qty: 15, system_qty: 10, cost_price: 12.0, selling_price: 15.5 },
    { entry_id: 2, store_no: 'ST-001', product_code: 'MED-002', item_name: 'AUGMENTIN 1G 14 TAB (أوجمنتين 1 جم)', barcode: '6222222222222', batch_number: 'A8902', expiry_date: '2026-12', actual_qty: 5, system_qty: 5, cost_price: 45.0, selling_price: 54.0 },
    { entry_id: 3, store_no: 'ST-001', product_code: 'MED-003', item_name: 'CONCOR 5MG 30 TAB (كونكور 5 ملغ)', barcode: '6223333333333', batch_number: 'C1044', expiry_date: '2028-05', actual_qty: 5, system_qty: 5, cost_price: 26.0, selling_price: 32.5 }
];

let memoryDraftInvoice = {
    id: 1,
    invoice_number: 'INV-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-0001',
    status: 'draft',
    date: new Date().toISOString().slice(0, 10),
    user_name: 'المسؤول',
    lines: []
};

let memoryEvents = [];
let activeTunnelUrl = "https://curriculum-fabrics-meet-also.trycloudflare.com";

function getStoreDetails(storeNo) {
    const items = memoryStocktakeItems.filter(it => it.store_no === storeNo);
    let totActual = 0, totSystem = 0, totCost = 0, totSale = 0;
    items.forEach(it => {
        const act = Number(it.actual_qty || 0);
        const sys = Number(it.system_qty || 0);
        totActual += act;
        totSystem += sys;
        totCost += act * (it.cost_price || 0);
        totSale += act * (it.selling_price || 0);
    });
    return {
        items: items,
        totals: {
            total_items: items.length,
            total_actual_qty: totActual,
            total_system_qty: totSystem,
            total_diff_qty: totActual - totSystem,
            total_actual_cost: totCost,
            total_actual_sale: totSale
        },
        active_store: memoryStores.find(s => s.store_no === storeNo) || { store_no: storeNo, store_name: 'المستودع' }
    };
}

function parseGs1Code(rawInput) {
    if (!rawInput) return { isGs1: false, gtin: '', batch: '', serial: '', expiry: '', raw: '' };
    let s = String(rawInput).trim();
    // إزالة بادئات الماسح الضوئي (AIM Identifiers)
    s = s.replace(/^\][dqcQDC][0-9]/, '');
    s = s.replace(/<\s*GS\s*>/gi, '\x1d').replace(/\[\s*GS\s*\]/gi, '\x1d').replace(/\^\]/g, '\x1d');

    let gtin = '', batch = '', serial = '', expiry = '', isGs1 = false;

    // صيغة الأقواس القياسية: (01)...(17)...(10)...(21)...
    if (s.includes('(') && s.includes(')')) {
        const matches = s.matchAll(/\(([0-9]{2,4})\)([^()]+)/g);
        for (const m of matches) {
            const ai = m[1];
            const val = m[2].trim();
            if (ai === '01') { gtin = val; isGs1 = true; }
            else if (ai === '10') { batch = val; isGs1 = true; }
            else if (ai === '21') { serial = val; isGs1 = true; }
            else if (ai === '17') { expiry = val; isGs1 = true; }
        }
    }

    // صيغة GS1 المتسلسلة المباشرة بدون أقواس
    if (!isGs1 && s.startsWith('01') && s.length >= 16) {
        gtin = s.substring(2, 16);
        isGs1 = true;
        let rest = s.substring(16);
        if (rest.startsWith('17') && rest.length >= 8) {
            expiry = rest.substring(2, 8);
            rest = rest.substring(8);
        }
        if (rest.startsWith('10')) {
            const gsIdx = rest.indexOf('\x1d');
            if (gsIdx >= 0) {
                batch = rest.substring(2, gsIdx);
                const afterGs = rest.substring(gsIdx + 1);
                if (afterGs.startsWith('21')) serial = afterGs.substring(2);
            } else {
                batch = rest.substring(2);
            }
        } else if (rest.startsWith('21')) {
            const gsIdx = rest.indexOf('\x1d');
            if (gsIdx >= 0) {
                serial = rest.substring(2, gsIdx);
                const afterGs = rest.substring(gsIdx + 1);
                if (afterGs.startsWith('10')) batch = afterGs.substring(2);
            } else {
                serial = rest.substring(2);
            }
        }
    }

    return { isGs1, gtin: gtin || s, batch, serial, expiry, raw: s };
}

function normalizeExpiryDate(str_val) {
    if (!str_val) return '';
    let val = String(str_val).trim();
    val = val.replace(/[\s./\\]+/g, '-').replace(/^-+|-+$/g, '');
    if (!val || val === '-') return '';

    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
    if (/^\d{4}-\d{2}$/.test(val)) return val;

    let m = val.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (m) {
        let d = parseInt(m[1], 10);
        let mo = parseInt(m[2], 10);
        let y = m[3];
        if (mo > 12 && d <= 12) {
            let tmp = d; d = mo; mo = tmp;
        }
        return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    m = val.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/);
    if (m) {
        let d = parseInt(m[1], 10);
        let mo = parseInt(m[2], 10);
        let y = '20' + m[3];
        if (mo > 12 && d <= 12) {
            let tmp = d; d = mo; mo = tmp;
        }
        return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    if (/^\d{8}$/.test(val)) {
        if (val.startsWith('20') && parseInt(val.slice(4, 6), 10) <= 12 && parseInt(val.slice(6, 8), 10) <= 31) {
            return `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}`;
        } else {
            let d = val.slice(0, 2);
            let mo = val.slice(2, 4);
            let y = val.slice(4, 8);
            return `${y}-${mo}-${d}`;
        }
    }

    if (/^\d{7}$/.test(val)) {
        let d = '0' + val.slice(0, 1);
        let mo = val.slice(1, 3);
        let y = val.slice(3, 7);
        if (parseInt(mo, 10) <= 12) {
            return `${y}-${mo}-${d}`;
        }
    }

    m = val.match(/^(\d{1,2})-(\d{4})$/);
    if (m) {
        return `${m[2]}-${m[1].padStart(2, '0')}`;
    }

    m = val.match(/^(\d{1,2})-(\d{2})$/);
    if (m) {
        return `20${m[2]}-${m[1].padStart(2, '0')}`;
    }

    if (/^\d{6}$/.test(val)) {
        if (val.startsWith('20')) {
            let y = val.slice(0, 4);
            let mo = val.slice(4, 6);
            if (parseInt(mo, 10) <= 12) return `${y}-${mo}`;
        }
        if (val.endsWith('2026') || val.endsWith('2027') || val.endsWith('2028') || val.endsWith('2029') || val.endsWith('2030')) {
            let mo = val.slice(0, 2);
            let y = val.slice(2, 6);
            return `${y}-${mo}`;
        }
        let d = val.slice(0, 2);
        let mo = val.slice(2, 4);
        let y = '20' + val.slice(4, 6);
        if (parseInt(d, 10) <= 31 && parseInt(mo, 10) <= 12) {
            return `${y}-${mo}-${d}`;
        }
    }

    if (/^\d{4}$/.test(val)) {
        let p1 = parseInt(val.slice(0, 2), 10);
        let p2 = parseInt(val.slice(2, 4), 10);
        if (p1 >= 1 && p1 <= 12 && p2 >= 24 && p2 <= 40) {
            return `20${val.slice(2, 4)}-${val.slice(0, 2)}`;
        } else if (p1 >= 24 && p1 <= 40 && p2 >= 1 && p2 <= 12) {
            return `20${val.slice(0, 2)}-${val.slice(2, 4)}`;
        }
    }

    return val;
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

        // إذا كان الطلب مسار API
        if (path.startsWith('/api/')) {
            const pcTunnel = activeTunnelUrl || "https://lines-musician-pretty-toner.trycloudflare.com";

            let rawBodyText = '';
            let body = {};
            if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
                try {
                    rawBodyText = await request.text();
                    if (rawBodyText) body = JSON.parse(rawBodyText);
                } catch (e) {
                    body = {};
                }
            }

            // 1. إذا كان نفق الكمبيوتر متوفراً، مرر كافة طلبات الـ API مباشرة لقاعدة بيانات الكمبيوتر!
            if (pcTunnel && !path.startsWith('/api/tunnel/')) {
                try {
                    const targetUrl = new URL(path + url.search, pcTunnel);
                    const proxyHeaders = new Headers(request.headers);
                    proxyHeaders.set('Host', new URL(pcTunnel).host);
                    proxyHeaders.set('X-Forwarded-Host', url.host);

                    const proxyReq = new Request(targetUrl.toString(), {
                        method: request.method,
                        headers: proxyHeaders,
                        body: ['GET', 'HEAD'].includes(request.method) ? undefined : rawBodyText,
                        duplex: 'half'
                    });

                    const resp = await fetch(proxyReq);
                    if (resp.status >= 500 && resp.status <= 599) {
                        console.warn('Proxy to tunnel returned status', resp.status, 'falling back to edge handler');
                    } else {
                        const respHeaders = new Headers(resp.headers);
                        respHeaders.set('Access-Control-Allow-Origin', '*');
                        respHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
                        respHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

                        return new Response(resp.body, {
                            status: resp.status,
                            statusText: resp.statusText,
                            headers: respHeaders
                        });
                    }
                } catch (err) {
                    console.error('Proxy to PC tunnel error, falling back to edge memory:', err);
                }
            }

            // 2. تسجيل نفق الكمبيوتر للربط السحابي اللحظي
            if (path === '/api/tunnel/register') {
                const newTunnel = String(body.tunnel_url || '').trim().replace(/\/+$/, '');
                if (newTunnel && newTunnel.startsWith('http')) {
                    activeTunnelUrl = newTunnel;
                }
                return jsonResponse({
                    success: true,
                    message: 'تم تسجيل نفق Cloudflare بنجاح والمزامنة الحية مفعلة',
                    active_tunnel: activeTunnelUrl
                });
            }

            if (path === '/api/tunnel/status') {
                return jsonResponse({
                    is_connected: Boolean(activeTunnelUrl),
                    tunnel_url: activeTunnelUrl,
                    worker_version: "20261105_v14"
                });
            }

            if (path === '/api/stats') {
                return jsonResponse({
                    products_count: memoryProducts.length,
                    barcodes_count: memoryProducts.filter(p => p.barcode || p.gtin).length,
                    stores_count: memoryStores.length,
                    draft_invoices_count: 1,
                    platform: 'Cloudflare Workers Edge'
                });
            }

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

            if (path === '/api/catalog/products') {
                const q = (url.searchParams.get('q') || '').trim().toLowerCase();
                let prods = memoryProducts;
                if (q) {
                    prods = prods.filter(p =>
                        (p.name && p.name.toLowerCase().includes(q)) ||
                        (p.code && p.code.toLowerCase().includes(q)) ||
                        (p.barcode && p.barcode.includes(q)) ||
                        (p.gtin && p.gtin.includes(q))
                    );
                }
                return jsonResponse({ products: prods });
            }

            if (path === '/api/catalog/next-code') {
                const num = memoryProducts.length + 1;
                return jsonResponse({ code: 'MED-' + String(num).padStart(3, '0') });
            }

            if (path === '/api/catalog/save') {
                const code = (body.code || body.product_code || 'MED-' + Date.now().toString().slice(-4)).trim();
                const name = (body.name || body.name_ar || body.name_en || '').trim();
                const existingIdx = memoryProducts.findIndex(p => p.code === code);
                const prodData = {
                    id: existingIdx >= 0 ? memoryProducts[existingIdx].id : memoryProducts.length + 1,
                    code: code,
                    name: name,
                    barcode: body.barcode || '',
                    gtin: body.gtin || '',
                    price: parseFloat(body.price || 0),
                    cost: parseFloat(body.cost || 0),
                    tax: parseFloat(body.tax || 0),
                    category: body.category || 'MEDICINE'
                };
                if (existingIdx >= 0) memoryProducts[existingIdx] = prodData;
                else memoryProducts.push(prodData);

                broadcastEvent('catalog_updated', prodData);
                return jsonResponse({ success: true, message: 'تم حفظ الصنف بنجاح', product: prodData });
            }

            if (path === '/api/stock/stores') {
                return jsonResponse({ created_stores: memoryStores });
            }

            if (path === '/api/stock/stores/create') {
                const name = (body.store_name || 'مستودع جديد').trim();
                const nextNo = 'ST-' + String(memoryStores.length + 1).padStart(3, '0');
                const newStore = {
                    id: memoryStores.length + 1,
                    store_no: nextNo,
                    store_name: name,
                    branch_name: body.branch_name || 'الفرع الرئيسي',
                    status: 'active',
                    count_items: 0,
                    actual_qty: 0,
                    system_qty: 0
                };
                memoryStores.push(newStore);
                broadcastEvent('store_created', newStore);
                return jsonResponse({ success: true, store_no: nextNo, store: newStore });
            }

            if (path === '/api/stock/store/details') {
                const storeNo = url.searchParams.get('store_no') || 'ST-001';
                const items = memoryStocktakeItems.filter(it => it.store_no === storeNo);
                let totActual = 0, totSystem = 0, totCost = 0, totSale = 0;
                items.forEach(it => {
                    const act = Number(it.actual_qty || 0);
                    const sys = Number(it.system_qty || 0);
                    totActual += act;
                    totSystem += sys;
                    totCost += act * (it.cost_price || 0);
                    totSale += act * (it.selling_price || 0);
                });
                return jsonResponse({
                    items: items,
                    totals: {
                        total_items: items.length,
                        total_actual_qty: totActual,
                        total_system_qty: totSystem,
                        total_diff_qty: totActual - totSystem,
                        total_actual_cost: totCost,
                        total_actual_sale: totSale
                    },
                    active_store: memoryStores.find(s => s.store_no === storeNo) || { store_no: storeNo, store_name: 'المستودع' }
                });
            }

            if (path === '/api/catalog/parse-gs1') {
                const raw = String(body.raw || body.qr_text || '').trim();
                const gs1 = parseGs1Code(raw);
                return jsonResponse({
                    success: true,
                    is_gs1: gs1.isGs1,
                    gtin: gs1.gtin,
                    batch: gs1.batch,
                    serial: gs1.serial,
                    expiry: gs1.expiry,
                    raw: raw
                });
            }

            if (path === '/api/stock/scan' || (path === '/api/mobile/scan' && body.target === 'stocktake')) {
                const rawCode = String(body.code || body.qr_text || body.raw || '').trim();
                const storeNo = String(body.store_no || 'ST-001').trim();
                const gs1 = parseGs1Code(rawCode);
                const searchGtin = gs1.gtin || rawCode;
                const is2d = Boolean(gs1.isGs1 && (gs1.batch || gs1.serial));
                const forceDirect = Boolean(body.force_direct);

                let prod = memoryProducts.find(p =>
                    (p.gtin && (p.gtin === searchGtin || p.gtin === rawCode)) ||
                    (p.barcode && (p.barcode === searchGtin || p.barcode === rawCode)) ||
                    (p.code && (p.code === searchGtin || p.code === rawCode))
                );
                if (!prod) {
                    prod = {
                        id: memoryProducts.length + 1,
                        code: 'MED-' + String(memoryProducts.length + 1).padStart(3, '0'),
                        name: 'صنف دوائي (' + searchGtin + ')',
                        barcode: searchGtin,
                        gtin: searchGtin,
                        price: 25.0,
                        cost: 20.0,
                        category: 'MEDICINE'
                    };
                    memoryProducts.push(prod);
                }

                if (!is2d && !forceDirect) {
                    const now = new Date();
                    const yy = String(now.getFullYear()).slice(-2);
                    const mm = String(now.getMonth() + 1).padStart(2, '0');
                    const autoBatch = `B${yy}${mm}-01`;
                    return jsonResponse({
                        success: true,
                        requires_batch_entry: true,
                        product: {
                            code: prod.code,
                            name: prod.name,
                            barcode: prod.barcode || searchGtin,
                            gtin: searchGtin,
                            cost_price: prod.cost || 0,
                            selling_price: prod.price || 0
                        },
                        batches: [
                            {
                                batch_number: autoBatch,
                                expiry_date: '',
                                system_qty: 0,
                                counted_qty: 0,
                                cost_price: prod.cost || 0,
                                selling_price: prod.price || 0,
                                is_new_batch: 1,
                                is_manual_batch: 1,
                                requires_manual_entry: true
                            }
                        ],
                        store_no: storeNo
                    });
                }

                let item = memoryStocktakeItems.find(it => it.store_no === storeNo && (it.product_code === prod.code || it.barcode === searchGtin));
                if (item) {
                    item.actual_qty = (item.actual_qty || 0) + 1;
                    if (gs1.batch) item.batch_number = gs1.batch;
                    if (gs1.expiry) item.expiry_date = gs1.expiry;
                } else {
                    item = {
                        entry_id: memoryStocktakeItems.length + 1,
                        store_no: storeNo,
                        product_code: prod.code,
                        item_name: prod.name,
                        barcode: prod.barcode || searchGtin,
                        batch_number: gs1.batch || body.batch || 'B1',
                        expiry_date: gs1.expiry || '2027-12',
                        actual_qty: 1,
                        system_qty: 0,
                        cost_price: prod.cost || 0,
                        selling_price: prod.price || 0
                    };
                    memoryStocktakeItems.push(item);
                }

                const scanEvent = {
                    code: rawCode,
                    gtin: gs1.gtin,
                    batch: gs1.batch,
                    store_no: storeNo,
                    target: 'stocktake',
                    product_name: prod.name,
                    product_code: prod.code,
                    success: true
                };
                broadcastEvent('mobile_scan', scanEvent);
                broadcastEvent('stock_qty_updated', { store_no: storeNo, entry_id: item.entry_id, quantity: item.actual_qty });
                return jsonResponse({
                    success: true,
                    product_name: prod.name,
                    product_code: prod.code,
                    actual_qty: item.actual_qty,
                    gtin: gs1.gtin,
                    batch: gs1.batch,
                    message: `تم سحب العبوة للجرد (+1): ${prod.name}`
                });
            }

            if (path === '/api/stock/save-batch-qty') {
                const storeNo = String(body.store_no || 'ST-001').trim();
                const prodCode = String(body.product_code || '').trim();
                const batchNumber = String(body.batch_number || '').trim();
                const expiryDate = normalizeExpiryDate(String(body.expiry_date || '').trim());
                const countedQty = parseFloat(body.counted_qty || 0);

                let item = memoryStocktakeItems.find(it => it.store_no === storeNo && it.product_code === prodCode && (it.batch_number === batchNumber || !it.batch_number));
                if (item) {
                    item.actual_qty = countedQty;
                    item.batch_number = batchNumber;
                    if (expiryDate) item.expiry_date = expiryDate;
                } else {
                    const prod = memoryProducts.find(p => p.code === prodCode) || { name: 'صنف دوائي', price: 0, cost: 0, barcode: '' };
                    item = {
                        entry_id: memoryStocktakeItems.length + 1,
                        store_no: storeNo,
                        product_code: prodCode,
                        item_name: prod.name,
                        barcode: prod.barcode || '',
                        batch_number: batchNumber,
                        expiry_date: expiryDate,
                        actual_qty: countedQty,
                        system_qty: parseFloat(body.system_qty || 0),
                        cost_price: parseFloat(body.cost_price || prod.cost || 0),
                        selling_price: parseFloat(body.selling_price || prod.price || 0)
                    };
                    memoryStocktakeItems.push(item);
                }
                broadcastEvent('stock_qty_updated', { store_no: storeNo, entry_id: item.entry_id, quantity: item.actual_qty });
                return jsonResponse({
                    success: true,
                    entry_id: item.entry_id,
                    message: `تم حفظ: ${item.item_name} | تشغيلة: ${batchNumber || '-'} | الفعلي: ${countedQty}`,
                    store_details: getStoreDetails(storeNo)
                });
            }

            if (path === '/api/stock/update-qty') {
                const entryId = Number(body.entry_id || body.id);
                const newQty = parseFloat(body.quantity || body.qty || 0);
                const item = memoryStocktakeItems.find(it => it.entry_id === entryId);
                if (item) {
                    item.actual_qty = newQty;
                    broadcastEvent('stock_qty_updated', { entry_id: entryId, quantity: newQty, store_no: item.store_no });
                    return jsonResponse({ success: true, actual_qty: newQty });
                }
                return jsonResponse({ success: false, message: 'الصنف غير موجود' }, 404);
            }

            if (path === '/api/stock/delete-item') {
                const entryId = Number(body.entry_id || body.id);
                const storeNo = String(body.store_no || 'ST-001').trim();
                const idx = memoryStocktakeItems.findIndex(it => it.entry_id === entryId);
                if (idx >= 0) {
                    memoryStocktakeItems.splice(idx, 1);
                    broadcastEvent('stock_item_deleted', { entry_id: entryId, store_no: storeNo });
                    return jsonResponse({
                        success: true,
                        message: 'تم حذف الصنف بنجاح',
                        store_details: getStoreDetails(storeNo)
                    });
                }
                return jsonResponse({ success: false, message: 'الصنف غير موجود' }, 404);
            }

            if (path === '/api/stock/bulk-delete') {
                const entryIds = (body.entry_ids || []).map(Number);
                const storeNo = String(body.store_no || 'ST-001').trim();
                memoryStocktakeItems = memoryStocktakeItems.filter(it => !entryIds.includes(it.entry_id));
                broadcastEvent('stock_item_deleted', { store_no: storeNo, entry_ids: entryIds });
                return jsonResponse({
                    success: true,
                    message: `تم حذف ${entryIds.length} صنف بنجاح`,
                    store_details: getStoreDetails(storeNo)
                });
            }

            if (path === '/api/stock/delete-store') {
                const storeNo = String(body.store_no || '').trim();
                const idx = memoryStores.findIndex(s => s.store_no === storeNo);
                if (idx >= 0) {
                    memoryStores.splice(idx, 1);
                    memoryStocktakeItems = memoryStocktakeItems.filter(it => it.store_no !== storeNo);
                    broadcastEvent('store_deleted', { store_no: storeNo });
                    return jsonResponse({ success: true, message: 'تم مسح المستودع بالكامل' });
                }
                return jsonResponse({ success: false, message: 'المستودع غير موجود' });
            }

            if (path === '/api/stock/reset-all') {
                memoryStocktakeItems = [];
                broadcastEvent('stock_reset', {});
                return jsonResponse({ success: true, message: 'تم تصفير بيانات الجرد بالكامل' });
            }

            if (path === '/api/stock/settle') {
                const storeNo = body.store_no || 'ST-001';
                const store = memoryStores.find(s => s.store_no === storeNo);
                if (store) store.status = 'settled';
                broadcastEvent('stock_settled', { store_no: storeNo });
                return jsonResponse({ success: true, message: 'تم ترحيل واعتماد الجرد بنجاح!' });
            }

            if (path === '/api/invoice/active') {
                return jsonResponse(memoryDraftInvoice);
            }

            if (path === '/api/invoice/new') {
                memoryDraftInvoice = {
                    id: Date.now(),
                    invoice_number: 'INV-' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Math.floor(Math.random() * 900 + 100),
                    status: 'draft',
                    date: new Date().toISOString().slice(0, 10),
                    user_name: 'المسؤول',
                    lines: []
                };
                broadcastEvent('invoice_created', memoryDraftInvoice);
                return jsonResponse({ success: true, invoice: memoryDraftInvoice });
            }

            if (path === '/api/invoice/scan') {
                const raw = String(body.qr_text || body.code || body.raw || '').trim();
                const gs1 = parseGs1Code(raw);
                const searchGtin = gs1.gtin || raw;

                let prod = memoryProducts.find(p =>
                    (p.gtin && (p.gtin === searchGtin || p.gtin === raw)) ||
                    (p.barcode && (p.barcode === searchGtin || p.barcode === raw)) ||
                    (p.code && (p.code === searchGtin || p.code === raw))
                );

                if (!prod) {
                    prod = {
                        id: memoryProducts.length + 1,
                        code: 'MED-' + String(memoryProducts.length + 1).padStart(3, '0'),
                        name: 'صنف دوائي ممسوح (' + searchGtin + ')',
                        barcode: searchGtin,
                        gtin: searchGtin,
                        price: 25.0,
                        cost: 20.0,
                        tax: 0,
                        category: 'MEDICINE'
                    };
                    memoryProducts.push(prod);
                }

                let line = memoryDraftInvoice.lines.find(l => l.product_code === prod.code);
                if (line) {
                    line.quantity = (line.quantity || 1) + 1;
                    if (gs1.batch) line.batch = gs1.batch;
                    if (gs1.expiry) line.expiry = gs1.expiry;
                    if (gs1.serial) line.serial = gs1.serial;
                } else {
                    line = {
                        id: memoryDraftInvoice.lines.length + 1,
                        product_code: prod.code,
                        name: prod.name,
                        name_en: prod.name,
                        price: prod.price || 0,
                        cost: prod.cost || 0,
                        quantity: 1,
                        batch: gs1.batch || body.batch || 'B1',
                        expiry: gs1.expiry || '2027-12',
                        serial: gs1.serial || '',
                        gtin: gs1.gtin || prod.gtin || prod.barcode
                    };
                    memoryDraftInvoice.lines.push(line);
                }

                const scanEvt = {
                    code: raw,
                    gtin: gs1.gtin,
                    batch: gs1.batch,
                    serial: gs1.serial,
                    product_code: prod.code,
                    name: prod.name,
                    target: 'invoice',
                    success: true
                };
                broadcastEvent('mobile_scan', scanEvt);
                broadcastEvent('invoice_updated', memoryDraftInvoice);

                return jsonResponse({
                    success: true,
                    message: `تم سحب العبوة بنجاح: ${prod.name}`,
                    invoice: memoryDraftInvoice,
                    product_code: prod.code,
                    name: prod.name,
                    name_en: prod.name,
                    gtin: gs1.gtin || prod.gtin || prod.barcode,
                    batch: gs1.batch || line.batch,
                    serial: gs1.serial || line.serial,
                    expiry: gs1.expiry || line.expiry,
                    line_qty: line.quantity
                });
            }

            if (path === '/api/invoice/delete-line') {
                const lineId = Number(body.line_id);
                const idx = memoryDraftInvoice.lines.findIndex(l => l.id === lineId);
                if (idx >= 0) {
                    memoryDraftInvoice.lines.splice(idx, 1);
                    broadcastEvent('invoice_updated', memoryDraftInvoice);
                    return jsonResponse({
                        success: true,
                        message: 'تم مسح الصنف من الفاتورة بنجاح',
                        invoice: memoryDraftInvoice
                    });
                }
                return jsonResponse({ success: false, message: 'السطر غير موجود' });
            }

            if (path === '/api/invoice/clear') {
                memoryDraftInvoice.lines = [];
                broadcastEvent('invoice_updated', memoryDraftInvoice);
                return jsonResponse({ success: true, message: 'تم مسح كافة سطور الفاتورة', invoice: memoryDraftInvoice });
            }

            return jsonResponse({ status: 'ok', endpoint: path });
        }

        // توجيه المسار /mobile لصفحة index.html
        if (path === '/mobile' || path === '/mobile.html') {
            const indexReq = new Request(new URL('/', request.url), request);
            if (env.ASSETS) {
                return env.ASSETS.fetch(indexReq);
            }
        }

        // خدمة ملفات الواجهة من مجلد frontend
        if (env.ASSETS) {
            return env.ASSETS.fetch(request);
        }

        return new Response("RAMBFE Cloudflare Worker Active", { status: 200 });
    }
};
