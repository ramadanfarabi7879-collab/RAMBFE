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
            let body = {};
            if (method === 'POST') {
                try {
                    body = await request.json();
                } catch (e) {
                    body = {};
                }
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

            if (path === '/api/stock/scan' || (path === '/api/mobile/scan' && body.target === 'stocktake')) {
                const rawCode = String(body.code || body.qr_text || '').trim();
                const storeNo = String(body.store_no || 'ST-001').trim();

                let prod = memoryProducts.find(p => p.barcode === rawCode || p.gtin === rawCode || p.code === rawCode);
                if (!prod) {
                    prod = { code: 'NEW-' + Math.floor(Math.random() * 9000 + 1000), name: 'صنف ممسوح (' + rawCode + ')', barcode: rawCode, price: 0, cost: 0 };
                    memoryProducts.push(prod);
                }

                let item = memoryStocktakeItems.find(it => it.store_no === storeNo && (it.product_code === prod.code || it.barcode === rawCode));
                if (item) {
                    item.actual_qty = (item.actual_qty || 0) + 1;
                } else {
                    item = {
                        entry_id: memoryStocktakeItems.length + 1,
                        store_no: storeNo,
                        product_code: prod.code,
                        item_name: prod.name,
                        barcode: prod.barcode || rawCode,
                        batch_number: body.batch || '',
                        expiry_date: '',
                        actual_qty: 1,
                        system_qty: 0,
                        cost_price: prod.cost || 0,
                        selling_price: prod.price || 0
                    };
                    memoryStocktakeItems.push(item);
                }

                const scanEvent = { code: rawCode, store_no: storeNo, target: 'stocktake', product_name: prod.name, product_code: prod.code, success: true };
                broadcastEvent('mobile_scan', scanEvent);
                return jsonResponse({ success: true, product_name: prod.name, product_code: prod.code, actual_qty: item.actual_qty, message: 'تم الجرد بنجاح' });
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
                const idx = memoryStocktakeItems.findIndex(it => it.entry_id === entryId);
                if (idx >= 0) {
                    const removed = memoryStocktakeItems.splice(idx, 1)[0];
                    broadcastEvent('stock_item_deleted', { entry_id: entryId, store_no: removed.store_no });
                    return jsonResponse({ success: true });
                }
                return jsonResponse({ success: false }, 404);
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
                const code = String(body.code || '').trim();
                let prod = memoryProducts.find(p => p.barcode === code || p.gtin === code || p.code === code);
                if (!prod) {
                    prod = { code: 'PROD-' + Date.now().toString().slice(-4), name: 'صنف ' + code, price: 10, cost: 8 };
                    memoryProducts.push(prod);
                }

                let line = memoryDraftInvoice.lines.find(l => l.product_code === prod.code);
                if (line) {
                    line.quantity = (line.quantity || 1) + 1;
                } else {
                    line = {
                        id: memoryDraftInvoice.lines.length + 1,
                        product_code: prod.code,
                        name: prod.name,
                        price: prod.price || 0,
                        cost: prod.cost || 0,
                        quantity: 1,
                        batch: body.batch || 'B1',
                        expiry: '2027-12'
                    };
                    memoryDraftInvoice.lines.push(line);
                }

                broadcastEvent('invoice_updated', memoryDraftInvoice);
                return jsonResponse({ success: true, invoice: memoryDraftInvoice });
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
