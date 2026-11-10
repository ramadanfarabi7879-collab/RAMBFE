// قراءة فواتير PDF والصور بالذكاء الاصطناعي (Cloudflare Workers AI) ثم مطابقتها مع كروت الأصناف.
// لا يُضاف أي شيء للفاتورة تلقائياً: الشاشة تعرض النتيجة للمراجعة أولاً.
import { first, all, findProductByGtinOrBarcode, getProductByCode, buildProductSearchWhere, runProductQuery, PRODUCT_ORDER_SQL, attachBarcodesBulk } from './products.js';
import { cleanNumericCode, cleanBarcodePreserveZeros, extractCleanGtin, parseExpiryDate, normalizeEnglish } from './qr.js';

export const AI_MODELS = {
    scout: '@cf/meta/llama-4-scout-17b-16e-instruct',
    mistral: '@cf/mistralai/mistral-small-3.1-24b-instruct',
};

const PROMPT = `You are reading a scanned pharmacy SUPPLIER INVOICE (Arabic and/or English). Extract EVERY product line item from the items table.
Return ONLY a JSON object: {"rotated":false,"items":[{"code":"","gtin":"","name":"","batch":"","expiry":"","qty":0,"bonus":0,"unit_price":0,"sales_price":0}]}
Field rules (read each row carefully, values of one row may wrap onto 2 printed lines inside the same table row):
- name: product description in English as printed (keep strength/form, e.g. "PANTOLOC 40MG 15TAB"). Do not include the Arabic translation.
- code: the supplier ITEM CODE / Item ID / Code / رقم الصنف column (usually 5-8 digits). NOT the batch.
- gtin: ONLY if there is a Barcode/GTIN column with 8-14 digits; otherwise "".
- batch: the Batch / Lot / Batch No. / التشغيلة value of that row (letters+digits, e.g. "TMPV8", "R426", "9338"). In tables with a combined "Exp.Lot" column the batch is the non-date part.
- expiry: the expiry date of that row as printed.
- qty: the ORIGINAL invoiced quantity of packs (if there are Original/Bonus/Total quantity columns, qty = Original and bonus = Bonus). Never use a column total.
- unit_price: unit price per pack before discount/tax. sales_price: public/retail price only if a separate column exists, else 0.
- Ignore header rows, totals, tax rows and empty rows. Never invent or duplicate rows. If the page is upside down set "rotated": true and still read it.
Numbers must be plain numbers (no currency, no thousands separators).`;

function parseJsonLoose(txt) {
    if (txt && typeof txt === 'object') return txt;
    const s = String(txt || '');
    try { return JSON.parse(s); } catch (_) { }
    const m = s.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (_) { } }
    const a = s.match(/\[[\s\S]*\]/);
    if (a) { try { return { items: JSON.parse(a[0]) }; } catch (_) { } }
    return { items: [] };
}
const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };

export async function aiExtract(env, { image, text, model }) {
    if (!env.AI) return { success: false, message: 'خدمة الذكاء الاصطناعي غير مفعلة على السحابة' };
    const mdl = AI_MODELS[model] || AI_MODELS.scout;
    const content = [{ type: 'text', text: PROMPT + (text ? `\n\nINVOICE TEXT:\n${String(text).slice(0, 24000)}` : '') }];
    if (image) content.push({ type: 'image_url', image_url: { url: image } });
    const t0 = Date.now();
    const out = await env.AI.run(mdl, { messages: [{ role: 'user', content }], max_tokens: 4096, temperature: 0 });
    const raw = out && (out.response ?? out.result?.response ?? out);
    const parsed = parseJsonLoose(raw);
    const items = (Array.isArray(parsed.items) ? parsed.items : []).map(it => {
        // باركود غير صالح (ليس 8-14 رقم) غالباً هو رقم التشغيلة: ننقله بدلاً من حذف حروفه
        let gtin = String(it.gtin ?? '').trim(), batch = String(it.batch ?? '').trim().toUpperCase();
        if (gtin && !/^\d{8,14}$/.test(gtin.replace(/\s/g, ''))) { if (!batch) batch = gtin.toUpperCase(); gtin = ''; }
        return { code: String(it.code ?? '').trim(), gtin: gtin.replace(/\D/g, ''), name: String(it.name ?? '').trim(),
        batch, expiry: String(it.expiry ?? '').trim(),
        qty: num(it.qty), bonus: num(it.bonus), unit_price: num(it.unit_price), sales_price: num(it.sales_price) };
    }).filter(it => it.name || it.code || it.gtin);
    return { success: true, model: mdl, ms: Date.now() - t0, items, rotated: Boolean(parsed.rotated), raw: typeof raw === 'string' ? raw.slice(0, 4000) : undefined };
}

// ---------------- المطابقة مع كروت الأصناف ----------------
// تقييم التشابه: اسم الماركة (أول كلمة) + التركيز (500MG، 30ML...) + باقي الكلمات
const UNITS = 'mg|mcg|g|gm|ml|l|iu|%';
const FORM_WORDS = new Set(['tab', 'tabs', 'tablet', 'tablets', 'cap', 'caps', 'capsule', 'capsules', 'syrup', 'susp', 'suspension', 'cream', 'gel', 'oint', 'ointment',
    'drops', 'drop', 'spray', 'sol', 'solution', 'lotion', 'inj', 'injection', 'amp', 'ampoule', 'sachet', 'sachets', 'vial', 'film', 'coated', 'oral', 's']);
const FORM_CANON = { tab: 'tab', tabs: 'tab', tablet: 'tab', tablets: 'tab', cap: 'cap', caps: 'cap', capsule: 'cap', capsules: 'cap', syrup: 'syrup', susp: 'susp',
    suspension: 'susp', cream: 'cream', gel: 'gel', oint: 'oint', ointment: 'oint', drops: 'drops', drop: 'drops', spray: 'spray', sol: 'sol', solution: 'sol',
    lotion: 'lotion', inj: 'inj', injection: 'inj', amp: 'inj', ampoule: 'inj', vial: 'inj', sachet: 'sachet', sachets: 'sachet', supp: 'supp', suppository: 'supp', ovule: 'supp' };
function formsOf(words) { const s = new Set(); for (const w of words) if (FORM_CANON[w]) s.add(FORM_CANON[w]); return s; }
function tokens(name) {
    const n = normalizeEnglish(String(name || '').replace(/(\d)\s+(mg|mcg|g|gm|ml|iu)\b/gi, '$1$2').replace(/\s*\/\s*/g, '/'));
    const raw = String(name || '').toLowerCase().replace(/\s*\/\s*/g, '/');
    const words = n.split(' ').filter(Boolean);
    const strengths = new Set();
    // تركيزات مركبة مثل 10mg/160mg/12.5mg أو 5/160/12.5mg
    for (const m of raw.matchAll(new RegExp(`((?:\\d+(?:\\.\\d+)?\\s*(?:${UNITS})?\\s*/\\s*)*\\d+(?:\\.\\d+)?)\\s*(${UNITS})(?![a-z])`, 'g'))) {
        let u = m[2] === 'gm' ? 'g' : m[2];
        for (const part of m[1].split('/')) {
            const v = parseFloat(part); if (!Number.isFinite(v)) continue;
            strengths.add(`${v}${u}`);
            if (u === 'g') strengths.add(`${v * 1000}mg`);
        }
    }
    let pack = null;
    const pm = raw.match(/(\d+)\s*(?:tab|tabs|tablet|tablets|cap|caps|capsule|capsules|sachet|sachets|amp|s)\b/);
    if (pm) pack = parseInt(pm[1], 10);
    return { words, brand: words.find(w => /[a-z]/.test(w)) || '', strengths, pack };
}
export function similarity(a, b) {
    const A = tokens(a), B = tokens(b);
    if (!A.brand || !B.brand) return 0;
    let score = 0;
    const brandEq = A.brand === B.brand, brandPrefix = !brandEq && (B.brand.startsWith(A.brand) || A.brand.startsWith(B.brand));
    if (brandEq) score += 50; else if (brandPrefix && Math.min(A.brand.length, B.brand.length) >= 4) score += 25; else return 0;
    if (A.strengths.size) {
        const common = [...A.strengths].filter(x => B.strengths.has(x)).length;
        if (common === A.strengths.size) score += 30; else if (common) score += 15; else if (B.strengths.size) score -= 40;
    }
    if (A.pack && B.pack) score += A.pack === B.pack ? 10 : -10;
    // الشكل الدوائي (شراب/أقراص/كبسول/لوشن/كريم...) يجب أن يتطابق
    const fA = formsOf(A.words), fB = formsOf(B.words);
    if (fA.size) { if ([...fA].some(f => fB.has(f))) score += 8; else if (fB.size) score -= 15; }
    const restA = A.words.filter(w => w !== A.brand && !/^\d/.test(w) && !FORM_WORDS.has(w)), setB = new Set(B.words);
    if (restA.length) score += Math.round(20 * restA.filter(w => setB.has(w) || [...setB].some(x => x.length > 2 && (x.startsWith(w) || w.startsWith(x)))).length / restA.length);
    else score += 10;
    const setA = new Set(A.words);
    const extra = B.words.filter(w => w !== B.brand && !/\d/.test(w) && !FORM_WORDS.has(w) && w.length > 1 && !setA.has(w) && ![...setA].some(x => x.startsWith(w) || w.startsWith(x))).length;
    score -= Math.min(12, extra * 4);
    return score;
}
const confidence = (sc) => sc >= 80 ? 'high' : sc >= 55 ? 'medium' : 'low';

async function nameCandidates(db, name) {
    const t = tokens(name);
    const queries = [t.brand, t.words.slice(0, 2).join(' ')].filter((q, i, a) => q && q.length >= 2 && a.indexOf(q) === i);
    const seen = new Map();
    for (const q of queries) {
        const { whereSql, params, orderParams, ftsVariants } = buildProductSearchWhere(q, 'contains');
        const rows = await runProductQuery(db, 'SELECT DISTINCT p.* FROM products p LEFT JOIN product_barcodes pb ON p.code = pb.product_code',
            whereSql, params, `${PRODUCT_ORDER_SQL} LIMIT 40`, orderParams, ftsVariants);
        for (const r of rows) if (!seen.has(r.code)) seen.set(r.code, r);
    }
    return [...seen.values()].map(p => ({ p, score: Math.max(similarity(name, p.name_en || ''), similarity(name, p.name || '')) }))
        .filter(x => x.score > 0).sort((x, y) => y.score - x.score).slice(0, 5);
}

// مطابقة كل سطر: GTIN أولاً (مؤكد)، ثم كود المورد فقط إذا اتفق الاسم، ثم الاسم مع درجة ثقة
export async function matchLines(db, items) {
    const out = [];
    for (const it of items) {
        let product = null, how = '', conf = '';
        const g = extractCleanGtin(it.gtin) || cleanBarcodePreserveZeros(it.gtin);
        if (g && g.length >= 8) { product = await findProductByGtinOrBarcode(db, g); if (product) { how = 'gtin'; conf = 'high'; } }
        if (!product && it.code) {
            const byCode = await getProductByCode(db, cleanNumericCode(it.code));
            if (byCode && similarity(it.name, byCode.name_en || byCode.name || '') >= 55) { product = byCode; how = 'code'; conf = 'high'; }
        }
        let cands = [];
        if (!product && it.name) {
            cands = await nameCandidates(db, it.name);
            if (cands.length && confidence(cands[0].score) !== 'low') { product = cands[0].p; how = 'name'; conf = confidence(cands[0].score); }
        }
        if (product) await attachBarcodesBulk(db, [product]);
        out.push({
            ...it, expiry_norm: parseExpiryDate(it.expiry) || '',
            match: product ? { code: product.code, name_en: product.name_en, name_ar: product.name_ar, selling_price: product.selling_price,
                gtin: (product.gtin_list || [])[0] || product.gtin || '', how, confidence: conf } : null,
            candidates: cands.map(c => ({ code: c.p.code, name_en: c.p.name_en, name_ar: c.p.name_ar, score: c.score, confidence: confidence(c.score) }))
        });
    }
    return out;
}
