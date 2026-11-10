// بيانات ملفات الإكسيل (منقول من backend/excel_exporter.py و دوال التصدير في stock_manager.py).
// السحابة تجهّز القيم بنفس قواعد بايثون، والمتصفح يبني الملف بنفس التنسيق (frontend/excel-export.js).
import { all, first, allIn, attachBarcodesBulk } from './products.js';
import { decodeArabicKeyboardLayout } from './qr.js';
import { getStoreStocktakeDetails } from './stock.js';
import { getInvoiceDetails, getOrCreateDraftInvoice, getUncountedStoreItems } from './extra.js';

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const trDigits = (s) => String(s).replace(/[٠-٩]/g, d => String(AR_DIGITS.indexOf(d)));
const HAS_AR = /[؀-ۿ]/;
const AR2LAT = { 'ا': 'A', 'أ': 'A', 'إ': 'E', 'آ': 'AA', 'ء': '', 'ؤ': 'O', 'ئ': 'Y', 'ب': 'B', 'ت': 'T', 'ث': 'TH', 'ج': 'J', 'ح': 'H', 'خ': 'KH',
    'د': 'D', 'ذ': 'DH', 'ر': 'R', 'ز': 'Z', 'س': 'S', 'ش': 'SH', 'ص': 'S', 'ض': 'D', 'ط': 'T', 'ظ': 'Z', 'ع': 'A', 'غ': 'GH',
    'ف': 'F', 'ق': 'Q', 'ك': 'K', 'ل': 'L', 'م': 'M', 'ن': 'N', 'ه': 'H', 'و': 'W', 'ي': 'Y', 'ى': 'A', 'ة': 'H', 'ـ': '' };
const PHARMA = { 'اقراص': 'TABLETS', 'أقراص': 'TABLETS', 'قرص': 'TABLET', 'كبسولات': 'CAPSULES', 'كبسول': 'CAPSULE', 'شراب': 'SYRUP', 'معلق': 'SUSPENSION',
    'مرهم': 'OINTMENT', 'كريم': 'CREAM', 'جل': 'GEL', 'قطرة': 'DROPS', 'بخاخ': 'SPRAY', 'محلول': 'SOLUTION', 'حقن': 'INJECTION', 'امبول': 'AMPOULE',
    'أمبول': 'AMPOULE', 'فوار': 'EFFERVESCENT', 'مل': 'ML', 'مجم': 'MG', 'جم': 'GM', 'علبة': 'PACK', 'شريط': 'STRIP', 'اطفال': 'KIDS', 'أطفال': 'KIDS',
    'كبار': 'ADULTS', 'سريع': 'RAPID', 'اكسترا': 'EXTRA', 'ادفانس': 'ADVANCE' };
// نفس مفاتيح ARABIC_KEYBOARD_MAP في qr_parser.py (تشمل بعض الرموز اللاتينية مثل / و ] و ~)
const KB = {
    'َ': 'Q', 'ً': 'W', 'ُ': 'E', 'ٌ': 'R', 'ﻷ': 'T', 'إ': 'Y', '‘': 'U', '÷': 'I', '×': 'O', '؛': 'P',
    'ِ': 'A', 'ٍ': 'S', ']': 'D', '[': 'F', 'ﻵ': 'G', 'أ': 'H', 'ـ': 'J', '،': 'K', '/': 'L', '~': 'Z', 'ْ': 'X',
    '}': 'C', '{': 'V', 'ﻹ': 'B', 'آ': 'N', '’': 'M', '؟': '?', 'ض': 'q', 'ص': 'w', 'ث': 'e', 'ق': 'r',
    'ف': 't', 'غ': 'y', 'ع': 'u', 'ه': 'i', 'خ': 'o', 'ح': 'p', 'ج': '[', 'د': ']', 'ش': 'a', 'س': 's',
    'ي': 'd', 'ب': 'f', 'ل': 'g', 'ا': 'h', 'ت': 'j', 'ن': 'k', 'م': 'l', 'ك': ';', 'ط': "'", 'ئ': 'z',
    'ء': 'x', 'ؤ': 'c', 'ر': 'v', 'ﻻ': 'b', 'ى': 'n', 'ة': 'm', 'و': ',', 'ز': '.', 'ظ': '/', 'ذ': '`',
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
};
const s0 = (v) => (v === null || v === undefined || v === false || v === 0 || v === '') ? '' : String(v);  // str(x or "")

export function toEnglishText(text) {
    if (!text) return '';
    const t = trDigits(String(text)).trim();
    if (!HAS_AR.test(t)) return t.trim().toUpperCase();
    const res = t.split(/\s+/).filter(Boolean).map(w => {
        const cw = w.replace(/[ً-ٰٟ]/g, '');
        if (cw in PHARMA) return PHARMA[cw];
        return [...cw].map(ch => (ch in AR2LAT ? AR2LAT[ch] : ch)).join('').toUpperCase();
    });
    return res.join(' ').replace(/[؀-ۿ]/g, '').trim().toUpperCase();
}

async function resolveEnglishName(db, item) {
    const nameEn = s0(item.matched_name_en || item.name_en || item.product_name_en).trim();
    if (nameEn && !HAS_AR.test(nameEn)) return nameEn.toUpperCase();
    const code = s0(item.product_code || item.code || item.matched_code).trim();
    const gtin = s0(item.gtin || item.raw_gtin_or_barcode || item.barcode).trim();
    if (code || gtin) {
        let row = null;
        if (code) row = await first(db, 'SELECT name_en FROM products WHERE code = ? LIMIT 1', [code]);
        if ((!row || !row.name_en) && gtin) row = await first(db, 'SELECT name_en FROM products WHERE gtin = ? OR barcode = ? LIMIT 1', [gtin, gtin]);
        if (row && row.name_en && String(row.name_en).trim()) {
            const dn = String(row.name_en).trim();
            if (!HAS_AR.test(dn)) return dn.toUpperCase();
        }
    }
    const fb = s0(item.name_en || item.product_name || item.name || item.name_ar).trim();
    if (fb) return toEnglishText(fb);
    return code ? `PRODUCT ${code}` : 'ITEM';
}
const resolveCode = (it) => trDigits(s0(it.product_code || it.code || it.matched_code).trim());
function resolveBatch(it) {
    let raw = trDigits(s0(it.batch_number || it.batch).trim());
    raw = decodeArabicKeyboardLayout(raw);
    if ([...raw].some(ch => ch in KB)) raw = [...raw].map(ch => (ch in KB ? KB[ch] : ch)).join('');
    return raw.toUpperCase();
}
const resolveExpiry = (it) => trDigits(s0(it.expiry_date || it.expiry).trim());
function resolveFloat(v) {
    if (v === null || v === undefined || v === '') return 0;
    const s = trDigits(String(v)).replaceAll(',', '').trim();
    const n = s === '' ? NaN : Number(s);
    return Number.isFinite(n) ? n : 0;
}
function resolveInt(v) { const f = resolveFloat(v); return Math.trunc(f); }
const firstTruthy = (...vs) => { for (const v of vs) if (v) return v; return vs[vs.length - 1]; };

function riyadhStamp() {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
        .formatToParts(new Date()).map(x => [x.type, x.value]));
    return `${p.year}${p.month}${p.day}_${p.hour === '24' ? '00' : p.hour}${p.minute}`;
}
const safeFile = (s) => String(s).replace(/[\\/*?:"<>|]/g, '_').trim();

async function invoiceRows(db, inv) {
    const out = [];
    for (const it of inv.lines || []) {
        out.push({
            product_code: resolveCode(it), name_en: await resolveEnglishName(db, it),
            sales_price: resolveFloat(firstTruthy(it.sales_price, it.selling_price)), batch_number: resolveBatch(it),
            quantity: resolveInt(firstTruthy(it.quantity, it.quantite)), unit_price: resolveFloat(firstTruthy(it.unit_price, it.cost_price)),
            expiry_date: resolveExpiry(it), location: s0(it.location)
        });
    }
    return out;
}

// p: معاملات الطلب كما في server.py
export async function exportData(db, kind, p) {
    if (kind === 'invoice' || kind === 'invoice_stock' || kind === 'invoice_custom') {
        let id = parseInt(p.id || p.invoice_id || '0', 10) || 0;
        if (!id) id = (await getOrCreateDraftInvoice(db)).id;
        const inv = await getInvoiceDetails(db, id);
        if (!inv || !Object.keys(inv).length) return { success: false, detail: 'الفاتورة غير موجودة' };
        const title = String(p.sheet_name || p.title || '').trim();
        const safe = title ? safeFile(title) : '';
        const base = kind === 'invoice_stock' ? 'StockCount' : (kind === 'invoice_custom' ? 'Invoice_Custom' : 'Invoice');
        return {
            success: true, kind, sheet_title: title, location_val: String(p.location_val || '').trim(), columns: p.columns || [],
            file_name: safe ? `${safe}.xlsx` : `${base}_${inv.invoice_number || 'INV'}_${inv.invoice_date || '2026-10-29'}.xlsx`,
            rows: await invoiceRows(db, inv)
        };
    }
    if (kind === 'stocktake') {
        const storeNo = String(p.store_no || '').trim() || 'ST-001';
        const title = String(p.sheet_name || p.title || '').trim();
        const det = await getStoreStocktakeDetails(db, storeNo);
        return { success: true, kind, sheet_title: title, location_val: String(p.location_val || '').trim(), store_no: storeNo,
            file_name: `Stocktake_${safeFile(title || storeNo)}_${riyadhStamp()}.xlsx`, details: det };
    }
    if (kind === 'uncounted') {
        const storeNo = String(p.store_no || '').trim() || 'ST-001';
        const title = String(p.sheet_name || p.title || '').trim();
        const data = await getUncountedStoreItems(db, storeNo);
        return { success: true, kind, sheet_title: title, store_no: storeNo,
            file_name: `EstimatedNotFound_${safeFile(title || `NOT_FOUND_${storeNo}`)}_${riyadhStamp()}.xlsx`, data };
    }
    if (kind === 'catalog') {
        const scope = String(p.scope || 'all').trim().toLowerCase();
        let codes = Array.isArray(p.codes) ? p.codes : String(p.codes || '').split(',');
        codes = codes.map(c => String(c).trim()).filter(Boolean);
        let invId = parseInt(p.invoice_id || p.id || '0', 10) || 0;
        if (scope === 'invoice' && !invId) invId = (await getOrCreateDraftInvoice(db)).id;
        const offset = parseInt(p.offset || '0', 10) || 0, limit = Math.min(parseInt(p.limit || '3000', 10) || 3000, 3000);
        let rows, total;
        const ORDER = 'ORDER BY CAST(code AS INTEGER) ASC, code ASC';
        if (codes.length) {
            const all1 = await allIn(db, 'SELECT * FROM products WHERE code IN ({ph})', [], codes);
            all1.sort((a, b) => (Number.parseInt(a.code, 10) || 0) - (Number.parseInt(b.code, 10) || 0) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
            total = all1.length; rows = all1.slice(offset, offset + limit);
        } else if (scope === 'invoice' && invId > 0) {
            rows = await all(db, `SELECT DISTINCT p.* FROM products p INNER JOIN invoice_lines il ON p.code = il.product_code WHERE il.invoice_id = ?
                AND il.invoice_id IN (SELECT id FROM invoices WHERE profile_id = ?) ORDER BY CAST(p.code AS INTEGER) ASC, p.code ASC`, [invId, Number(db.pid || 1)]);
            total = rows.length; rows = rows.slice(offset, offset + limit);
        } else {
            total = Number((await first(db, "SELECT v FROM meta WHERE k = 'products_count'"))?.v || 0);
            rows = await all(db, `SELECT * FROM products ${ORDER} LIMIT ? OFFSET ?`, [limit, offset]);
        }
        await attachBarcodesBulk(db, rows);
        const stamp = riyadhStamp();
        const fileName = (scope === 'selected' && codes.length) ? `Products_Selected_${codes.length}_${stamp}.xlsx`
            : (scope === 'invoice' && invId) ? `Products_Invoice_${invId}_${stamp}.xlsx` : `Products_Catalog_${stamp}.xlsx`;
        const fields = Array.isArray(p.fields) ? p.fields : String(p.fields || '').split(',').map(f => f.trim()).filter(Boolean);
        return { success: true, kind, file_name: fileName, fields, rows, total, offset, limit };
    }
    return { success: false, detail: 'نوع تصدير غير معروف' };
}
