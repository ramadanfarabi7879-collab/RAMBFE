// منقول من backend/db.py: البحث عن الأصناف والتعرف عليها بالباركود/GTIN.
// نفس جمل SQL الأصلية تُنفّذ على D1 (SQLite) مع مرشح فهرس trigram لتقليل عدد الصفوف المقروءة.
import {
    cleanNumericCode, cleanBarcodePreserveZeros, splitBarcodes, extractCleanGtin,
    normalizeArabic, normalizeEnglish, decodeArabicKeyboardLayout, isDigitStr
} from './qr.js';

// ---------- أدوات D1 ----------
export async function all(db, sql, params = []) {
    const r = await db.prepare(sql).bind(...params).all();
    return r.results || [];
}
export async function first(db, sql, params = []) {
    return (await db.prepare(sql).bind(...params).first()) || null;
}
export async function run(db, sql, params = []) {
    const r = await db.prepare(sql).bind(...params).run();
    return r.meta || {};
}
// D1 يسمح بـ 100 متغير كحد أقصى لكل جملة
export async function allIn(db, sqlWithPh, prefix, list, suffix = [], chunk = 90) {
    const out = [];
    for (let i = 0; i < list.length; i += chunk) {
        const part = list.slice(i, i + chunk);
        const ph = part.map(() => '?').join(',');
        out.push(...await all(db, sqlWithPh.replaceAll('{ph}', ph), [...prefix, ...part, ...suffix]));
    }
    return out;
}

// ---------- الأصناف ----------
export async function attachProductBarcodes(db, product, preloaded = null) {
    const code = product.code;
    if (!code) return;
    const rows = preloaded ?? await all(db, 'SELECT barcode, barcode_type FROM product_barcodes WHERE product_code = ?', [code]);
    const gtins = [], barcodes = [];
    for (const r of rows) {
        const b = r.barcode;
        if (r.barcode_type === 'gtin') { if (!gtins.includes(b)) gtins.push(b); }
        else if (!barcodes.includes(b)) barcodes.push(b);
    }
    if (product.gtin) for (const g of splitBarcodes(product.gtin)) if (!gtins.includes(g)) gtins.push(g);
    if (product.barcode) for (const b of splitBarcodes(product.barcode)) if (!barcodes.includes(b) && !gtins.includes(b)) barcodes.push(b);
    product.gtin_list = gtins;
    product.barcode_list = barcodes;
}

// إرفاق الباركودات لقائمة أصناف باستعلام واحد بدلاً من استعلام لكل صنف
export async function attachBarcodesBulk(db, products) {
    const codes = [...new Set(products.map(p => p.code).filter(Boolean))];
    const rows = codes.length ? await allIn(db, 'SELECT product_code, barcode, barcode_type FROM product_barcodes WHERE product_code IN ({ph})', [], codes) : [];
    const byCode = {};
    for (const r of rows) (byCode[r.product_code] ||= []).push(r);
    for (const p of products) await attachProductBarcodes(db, p, byCode[p.code] || []);
}

export async function getProductByCode(db, code) {
    const clean = cleanNumericCode(code);
    if (!clean) return null;
    const p = await first(db, 'SELECT * FROM products WHERE code = ? LIMIT 1', [clean]);
    if (p) await attachProductBarcodes(db, p);
    return p;
}

const ftsPhrase = (v) => '"' + String(v).replaceAll('"', '""') + '"';

// مرشح فهرس البحث: يعيد شرط SQL يحصر الأصناف المرشحة، أو '' إذا تعذر (نص قصير جداً)
function ftsFilter(variants, column = 'p.id') {
    const vs = [...new Set(variants.filter(v => v !== null && v !== undefined).map(String))];
    if (!vs.length || vs.some(v => [...v].length < 3)) return { sql: '', params: [] };
    return { sql: `${column} IN (SELECT rowid FROM product_search WHERE product_search MATCH ?)`, params: [vs.map(ftsPhrase).join(' OR ')] };
}

export async function findProductByGtinOrBarcode(db, val) {
    if (!val) return null;
    const cleanVal = cleanBarcodePreserveZeros(val);
    if (!cleanVal) return null;
    const candidates = [cleanVal];
    const pure = extractCleanGtin(val);
    if (pure && !candidates.includes(pure)) candidates.push(pure);
    if (cleanVal.length === 14 && cleanVal.startsWith('0')) candidates.push(cleanVal.slice(1));
    else if (cleanVal.length === 13 && isDigitStr(cleanVal)) candidates.push('0' + cleanVal);
    if (pure) {
        if (pure.length === 14 && pure.startsWith('0') && !candidates.includes(pure.slice(1))) candidates.push(pure.slice(1));
        else if (pure.length === 13 && isDigitStr(pure) && !candidates.includes('0' + pure)) candidates.push('0' + pure);
    }
    const ph = candidates.map(() => '?').join(',');
    let row = await first(db, `SELECT p.* FROM products p JOIN product_barcodes pb ON p.code = pb.product_code WHERE pb.barcode IN (${ph}) ORDER BY p.id DESC LIMIT 1`, candidates);
    if (row) { await attachProductBarcodes(db, row); return row; }

    if (pure) {
        const f = ftsFilter([pure]);
        row = await first(db, `SELECT p.* FROM products p JOIN product_barcodes pb ON p.code = pb.product_code
            WHERE (pb.barcode LIKE ? OR pb.barcode LIKE ?) ${f.sql ? 'AND ' + f.sql : ''} ORDER BY p.id DESC LIMIT 1`,
            [`%01${pure}%`, `%${pure}%`, ...f.params]);
        if (row) { await attachProductBarcodes(db, row); return row; }
    }
    for (const c of candidates) {
        const f = ftsFilter([c], 'id');
        // code = ? يُفحص بالفهرس مباشرة؛ مطابقات LIKE تُحصر بفهرس trigram
        row = await first(db, 'SELECT * FROM products WHERE code = ? ORDER BY id DESC LIMIT 1', [c]);
        if (!row) row = await first(db, `SELECT * FROM products WHERE (gtin LIKE ? OR barcode LIKE ?) ${f.sql ? 'AND ' + f.sql : ''} ORDER BY id DESC LIMIT 1`,
            [`%${c}%`, `%${c}%`, ...f.params]);
        if (row) { await attachProductBarcodes(db, row); return row; }
    }
    return null;
}

// منقول حرفياً من _build_product_search_where مع إرجاع النصوص اللازمة لمرشح الفهرس
export function buildProductSearchWhere(rawQuery, matchMode = 'start') {
    const rawQ = String(rawQuery || '').replace(/^\s+/, '');
    const hasTrailingSpace = rawQ.endsWith(' ');
    const q = rawQ.trim();
    const isContains = ['contains', 'generalized', 'all', 'true', '1'].includes(String(matchMode || '').toLowerCase());
    const words = q.split(/\s+/).filter(Boolean);
    const qClean = cleanBarcodePreserveZeros(q);
    const normAr = normalizeArabic(q);
    const normEn = normalizeEnglish(q);
    const where = [], params = [];
    let ftsVariants = [];
    const textFields = ['p.name_en', 'p.normalized_name_en', 'p.name_ar', 'p.normalized_name_ar', 'p.name', 'p.normalized_name', 'p.scientific_name', 'p.company', 'p.category'];

    if (hasTrailingSpace || words.length > 1) {
        if (words.length === 1 && hasTrailingSpace) {
            const tok = words[0];
            const tokens = [tok];
            if (normEn && normEn !== tok) tokens.push(normEn);
            if (normAr && normAr !== tok) tokens.push(normAr);
            const conds = [];
            for (const t of new Set(tokens)) {
                for (const f of textFields) {
                    if (isContains) { conds.push(`(${f} = ? OR ${f} LIKE ? OR ${f} LIKE ? OR ${f} LIKE ? OR ${f} LIKE ?)`); params.push(t, `${t} %`, `% ${t} %`, `% ${t}`, `${t}-%`); }
                    else { conds.push(`(${f} = ? OR ${f} LIKE ? OR ${f} LIKE ? OR ${f} LIKE ?)`); params.push(t, `${t} %`, `${t}-%`, `${t}/%`); }
                }
            }
            conds.push('(p.code = ? OR p.code LIKE ?)'); params.push(tok, `${tok} %`);
            ftsVariants.push(...tokens);
            if (qClean) { conds.push('(p.barcode = ? OR p.gtin = ? OR pb.barcode = ?)'); params.push(qClean, qClean, qClean); ftsVariants.push(qClean); }
            where.push(`(${conds.join(' OR ')})`);
            const rawDec = decodeArabicKeyboardLayout(rawQ);
            if (rawDec !== rawQ) {
                const dec = rawDec.trim();
                if (dec) {
                    const dc = [];
                    for (const f of ['p.name_en', 'p.normalized_name_en', 'p.scientific_name']) {
                        if (isContains) { dc.push(`(${f} = ? OR ${f} LIKE ? OR ${f} LIKE ? OR ${f} LIKE ?)`); params.push(dec, `${dec} %`, `% ${dec} %`, `% ${dec}`); }
                        else { dc.push(`(${f} = ? OR ${f} LIKE ? OR ${f} LIKE ?)`); params.push(dec, `${dec} %`, `${dec}-%`); }
                    }
                    where.push(`(${dc.join(' OR ')})`);
                    ftsVariants.push(dec);
                }
            }
        } else {
            const wf = words[0];
            const fc = [];
            for (const f of textFields) {
                if (isContains) { fc.push(`(${f} = ? OR ${f} LIKE ? OR ${f} LIKE ? OR ${f} LIKE ? OR ${f} LIKE ?)`); params.push(wf, `${wf} %`, `% ${wf} %`, `% ${wf}`, `${wf}-%`); }
                else { fc.push(`(${f} = ? OR ${f} LIKE ? OR ${f} LIKE ? OR ${f} LIKE ?)`); params.push(wf, `${wf} %`, `${wf}-%`, `${wf}/%`); }
            }
            fc.push('(p.code = ? OR p.code LIKE ?)'); params.push(wf, `${wf} %`);
            where.push(`(${fc.join(' OR ')})`);
            words.slice(1).forEach((w, i) => {
                const isLast = i === words.length - 2;
                const wc = [];
                for (const f of textFields) {
                    if (isLast && hasTrailingSpace) { wc.push(`(${f} LIKE ? OR ${f} LIKE ? OR ${f} LIKE ? OR ${f} = ?)`); params.push(`% ${w} %`, `% ${w}`, `${w} %`, w); }
                    else { wc.push(`${f} LIKE ?`); params.push(`%${w}%`); }
                }
                where.push(`(${wc.join(' OR ')})`);
            });
            // كل الكلمات شرط AND: يكفي أطول كلمة لحصر المرشحين
            const longest = [...words].sort((a, b) => [...b].length - [...a].length)[0];
            ftsVariants = [longest];
        }
    } else {
        let qp, arP, enP, cleanP;
        if (isContains) { qp = `%${q}%`; arP = normAr ? `%${normAr}%` : qp; enP = normEn ? `%${normEn}%` : qp; cleanP = qClean ? `%${qClean}%` : ''; }
        else { qp = `${q}%`; arP = normAr ? `${normAr}%` : qp; enP = normEn ? `${normEn}%` : qp; cleanP = qClean ? `${qClean}%` : ''; }
        where.push('p.name_ar LIKE ?', 'p.name LIKE ?', 'p.normalized_name_ar LIKE ?', 'p.normalized_name LIKE ?', 'p.name_en LIKE ?', 'p.normalized_name_en LIKE ?', 'p.scientific_name LIKE ?', 'p.company LIKE ?', 'p.category LIKE ?');
        params.push(qp, qp, arP, arP, enP, enP, qp, qp, qp);
        ftsVariants.push(q, normAr || q, normEn || q);
        where.push('p.code = ?', 'p.code LIKE ?'); params.push(q, qp);
        if (qClean && cleanP && qClean !== q) { where.push('p.code = ?', 'p.code LIKE ?'); params.push(qClean, cleanP); }
        if (qClean && cleanP) {
            where.push('p.barcode = ?', 'p.barcode LIKE ?', 'p.gtin = ?', 'p.gtin LIKE ?', 'pb.barcode = ?', 'pb.barcode LIKE ?');
            params.push(qClean, cleanP, qClean, cleanP, qClean, cleanP);
            ftsVariants.push(qClean);
            if (isDigitStr(qClean)) {
                const padded = qClean.padStart(10, '0');
                if (padded !== qClean) { where.push('p.code = ?', 'p.code LIKE ?'); params.push(padded, isContains ? `%${padded}%` : `${padded}%`); ftsVariants.push(padded); }
                if (isContains) {
                    const stripped = qClean.replace(/^0+/, '') || '0';
                    if (stripped !== qClean) { where.push('p.code = ?', 'p.code LIKE ?'); params.push(stripped, `%${stripped}%`); ftsVariants.push(stripped); }
                }
            }
        }
        const decodedQ = decodeArabicKeyboardLayout(q).trim();
        if (decodedQ && decodedQ.toLowerCase() !== q.toLowerCase()) {
            const dp = isContains ? `%${decodedQ}%` : `${decodedQ}%`;
            where.push('p.name_en LIKE ?', 'p.normalized_name_en LIKE ?'); params.push(dp, dp);
            if (isContains) { where.push('p.scientific_name LIKE ?'); params.push(dp); }
            ftsVariants.push(decodedQ);
            const decClean = cleanBarcodePreserveZeros(decodedQ);
            if (decClean) {
                const dcp = isContains ? `%${decClean}%` : `${decClean}%`;
                where.push('p.code = ?', 'p.code LIKE ?', 'p.barcode = ?', 'p.barcode LIKE ?', 'p.gtin = ?', 'p.gtin LIKE ?', 'pb.barcode = ?', 'pb.barcode LIKE ?');
                params.push(decClean, dcp, decClean, dcp, decClean, dcp, decClean, dcp);
                ftsVariants.push(decClean);
            }
        }
    }
    const whereSql = words.length > 1 ? where.join(' AND ') : where.join(' OR ');
    const orderParams = [qClean, `${qClean}%`, `${q}%`, normEn ? `${normEn}%` : `${q}%`, `${q}%`, qClean, qClean, `${qClean}%`, `${qClean}%`];
    // أحرف LIKE الخاصة في نص المستخدم تجعل المطابقة غير نصية حرفياً: نعطّل المرشح لضمان نفس النتائج
    if (/[%_]/.test(q)) ftsVariants = [];
    return { whereSql, params, orderParams, ftsVariants };
}

export const PRODUCT_ORDER_SQL = `
    ORDER BY CASE
        WHEN p.code = ? THEN 1
        WHEN p.code LIKE ? THEN 2
        WHEN p.name_en LIKE ? OR p.normalized_name_en LIKE ? THEN 3
        WHEN p.name_ar LIKE ? THEN 4
        WHEN p.barcode = ? OR p.gtin = ? THEN 5
        WHEN p.barcode LIKE ? OR p.gtin LIKE ? THEN 6
        ELSE 7 END, p.id DESC`;

// تنفيذ البحث على D1 مع تمرير المعاملات مباشرة كقيم حرفية آمنة (الحد 100 متغير لكل جملة في D1)
function inlineParams(sql, params) {
    let i = 0;
    return sql.replace(/\?/g, () => {
        const v = params[i++];
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number') return String(v);
        return "'" + String(v).replaceAll("'", "''") + "'";
    });
}

export async function runProductQuery(db, selectSql, whereSql, params, tailSql = '', tailParams = [], ftsVariants = []) {
    const f = ftsFilter(ftsVariants);
    const full = `${selectSql} WHERE (${whereSql})${f.sql ? ' AND ' + f.sql : ''} ${tailSql}`;
    return all(db, inlineParams(full, [...params, ...f.params, ...tailParams]));
}

export async function searchProducts(db, query = '', limit = 50, offset = 0, matchMode = 'start') {
    const rawQ = String(query || '').replace(/^\s+/, '');
    const q = rawQ.trim();
    let rows, total;
    if (!q) {
        const m = await first(db, "SELECT v FROM meta WHERE k = 'products_count'");
        total = m ? Number(m.v) : (await first(db, 'SELECT COUNT(*) AS c FROM products')).c;
        rows = await all(db, 'SELECT p.* FROM products p ORDER BY p.id DESC LIMIT ? OFFSET ?', [limit, offset]);
    } else {
        const { whereSql, params, orderParams, ftsVariants } = buildProductSearchWhere(rawQ, matchMode);
        const from = 'FROM products p LEFT JOIN product_barcodes pb ON p.code = pb.product_code';
        const cnt = await runProductQuery(db, `SELECT COUNT(DISTINCT p.id) AS c ${from}`, whereSql, params, '', [], ftsVariants);
        total = cnt[0]?.c || 0;
        rows = await runProductQuery(db, `SELECT DISTINCT p.* ${from}`, whereSql, params, `${PRODUCT_ORDER_SQL} LIMIT ? OFFSET ?`, [...orderParams, limit, offset], ftsVariants);
    }
    await attachBarcodesBulk(db, rows);
    return { items: rows, total, limit, offset };
}
