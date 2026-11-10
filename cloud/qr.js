// منقول حرفياً من backend/qr_parser.py و backend/normalizer.py و دوال التنظيف في backend/db.py
// أي تعديل في منطق بايثون يجب أن ينعكس هنا للحفاظ على نفس نتائج المسح والبحث.

const ARABIC_KEYBOARD_MAP = {
    'َ': 'Q', 'ً': 'W', 'ُ': 'E', 'ٌ': 'R', 'ﻷ': 'T', 'إ': 'Y',
    '‘': 'U', '÷': 'I', '×': 'O', '؛': 'P', 'ِ': 'A', 'ٍ': 'S',
    ']': 'D', '[': 'F', 'ﻵ': 'G', 'أ': 'H', 'ـ': 'J', '،': 'K', '/': 'L',
    '~': 'Z', 'ْ': 'X', '}': 'C', '{': 'V', 'ﻹ': 'B', 'آ': 'N', '’': 'M',
    '؟': '?',
    'ض': 'q', 'ص': 'w', 'ث': 'e', 'ق': 'r', 'ف': 't', 'غ': 'y',
    'ع': 'u', 'ه': 'i', 'خ': 'o', 'ح': 'p', 'ج': '[', 'د': ']',
    'ش': 'a', 'س': 's', 'ي': 'd', 'ب': 'f', 'ل': 'g', 'ا': 'h',
    'ت': 'j', 'ن': 'k', 'م': 'l', 'ك': ';', 'ط': "'", 'ئ': 'z',
    'ء': 'x', 'ؤ': 'c', 'ر': 'v', 'ﻻ': 'b', 'ى': 'n', 'ة': 'm',
    'و': ',', 'ز': '.', 'ظ': '/', 'ذ': '`',
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
};

const isAscii = (ch) => ch.charCodeAt(0) < 128;
export const isDigitStr = (s) => s.length > 0 && /^[0-9]+$/.test(s);

export function decodeArabicKeyboardLayout(text) {
    if (!text) return '';
    const hasArabic = /[؀-ۿݐ-ݿﭐ-ﰿﹰ-ﻼ]/.test(text);
    const hasArtifacts = /(?:^01|\(01\)|^\d{14})/.test(text) && /[}\]\[{~/]/.test(text);
    let hasMapped = text.includes('}') || text.includes('~') || text.includes('{');
    if (!hasMapped) for (const ch of text) { if (ch in ARABIC_KEYBOARD_MAP && !isAscii(ch)) { hasMapped = true; break; } }
    if (!(hasArabic || hasArtifacts || hasMapped)) return text;
    let s = text.split('لإ').join('T').split('لأ').join('G')
        .split('لآ').join('B').split('لا').join('B');
    let out = '';
    for (const ch of s) out += (ARABIC_KEYBOARD_MAP[ch] ?? ch);
    return out;
}

export function cleanAlphanumeric(val) {
    if (val === null || val === undefined) return '';
    return String(val).replace(/[\x00-\x1f\x7f]/g, '').trim();
}

export function cleanNumericCode(val) {
    if (val === null || val === undefined) return '';
    let s = String(val).trim();
    if (typeof val === 'number' && Number.isInteger(val)) s = String(val);
    if (!s || ['nan', 'null', 'none'].includes(s.toLowerCase())) return '';
    if (/^[0-9]+(\.[0-9]+)?[eE]\+[0-9]+$/.test(s)) {
        const n = Number(s); if (Number.isFinite(n)) return String(Math.trunc(n));
    }
    if (s.endsWith('.0') && isDigitStr(s.slice(0, -2))) s = s.slice(0, -2);
    return s.replace(/[\r\n\t]+/g, '').trim();
}

export function cleanBarcodePreserveZeros(val) {
    if (val === null || val === undefined) return '';
    let s = String(val).trim();
    if (s.endsWith('.0') && isDigitStr(s.slice(0, -2))) s = s.slice(0, -2);
    return s.replace(/[^0-9a-zA-Z]/g, '');
}

export function splitBarcodes(val) {
    if (val === null || val === undefined) return [];
    const raws = Array.isArray(val) ? val.filter(x => x !== null && x !== undefined) : [val];
    const tokens = [];
    for (const raw of raws) {
        let s = String(raw).trim();
        if (!s || ['none', 'nan', 'null', '-', 'false', 'true'].includes(s.toLowerCase())) continue;
        if (s.endsWith('.0') && isDigitStr(s.slice(0, -2))) s = s.slice(0, -2);
        for (const part of s.split(/[,;\/\n|\s\x1c-\x1f]+/)) if (part) tokens.push(part);
    }
    const res = []; const seen = new Set();
    for (const it of tokens) {
        const c = cleanBarcodePreserveZeros(it);
        if (c && !['none', 'nan', 'null', 'false', 'true'].includes(c.toLowerCase()) && !seen.has(c)) { seen.add(c); res.push(c); }
    }
    return res;
}

export function normalizeArabic(text) {
    if (!text) return '';
    let t = String(text).trim().toLowerCase();
    t = t.replace(/[ً-ٰٟۖ-ۭ]/g, '').replace(/ـ/g, '');
    t = t.replace(/[إأآاٱ]/g, 'ا').replace(/[ىي]/g, 'ي');
    t = t.replace(/ة(?![\p{L}\p{N}_])/gu, 'ه');
    t = t.replace(/[ؤئ]/g, 'ء');
    t = t.replace(/[^\p{L}\p{N}_\s]/gu, ' ');
    return t.replace(/\s+/g, ' ').trim();
}

export function normalizeEnglish(text) {
    if (!text) return '';
    let t = String(text).trim();
    t = t.replace(/([a-zA-Z]+)io\s*%/gi, '$1 10%');
    t = t.replace(/\bio\s*%/gi, '10%');
    t = t.replace(/(\d+)\s*mu(\d+)/gi, '$1ml/$2');
    t = t.replace(/(\d+)\s*mu\b/gi, '$1ml');
    t = t.replace(/solutlon/gi, 'solution');
    t = t.replace(/sachi\b/gi, 'sachets');
    t = t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    return t.replace(/\s+/g, ' ').trim();
}

const pad2 = (n) => String(n).padStart(2, '0');
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();

export function parseExpiryDate(val) {
    if (!val) return null;
    let s = String(val).trim().replace(/[\s\x1c-\x1f./\\]+/g, '-').replace(/^-+|-+$/g, '');
    if (!s || s === '-') return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s) || /^\d{4}-\d{2}$/.test(s)) return s;
    let m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (m) { let d = +m[1], mo = +m[2]; if (mo > 12 && d <= 12) [d, mo] = [mo, d]; return `${m[3]}-${pad2(mo)}-${pad2(d)}`; }
    m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/);
    if (m) { let d = +m[1], mo = +m[2]; if (mo > 12 && d <= 12) [d, mo] = [mo, d]; return `20${m[3]}-${pad2(mo)}-${pad2(d)}`; }
    m = s.match(/^(\d{1,2})-(\d{4})$/);
    if (m) return `${m[2]}-${pad2(+m[1])}`;
    m = s.match(/^(\d{1,2})-(\d{2})$/);
    if (m) return `20${m[2]}-${pad2(+m[1])}`;
    const digits = s.replace(/\D/g, '');
    if (digits.length === 8) {
        if (digits.startsWith('20') && +digits.slice(4, 6) <= 12 && +digits.slice(6, 8) <= 31)
            return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
        return `${digits.slice(4, 8)}-${digits.slice(2, 4)}-${digits.slice(0, 2)}`;
    }
    if (digits.length === 7) {
        const mo = digits.slice(1, 3);
        if (+mo <= 12) return `${digits.slice(3, 7)}-${mo}-0${digits.slice(0, 1)}`;
    }
    if (digits.length === 6) {
        if (digits.startsWith('20')) { const mo = digits.slice(4, 6); if (+mo >= 1 && +mo <= 12) return `${digits.slice(0, 4)}-${mo}`; }
        if (['2026', '2027', '2028', '2029', '2030'].some(e => digits.endsWith(e))) return `${digits.slice(2, 6)}-${digits.slice(0, 2)}`;
        const yy = +digits.slice(0, 2), mm = +digits.slice(2, 4); let dd = +digits.slice(4, 6);
        const year = yy < 70 ? 2000 + yy : 1900 + yy;
        if (mm >= 1 && mm <= 12) {
            const maxD = daysInMonth(year, mm);
            if (dd === 0 || dd > maxD) dd = maxD;
            return `${String(year).padStart(4, '0')}-${pad2(mm)}-${pad2(dd)}`;
        }
    }
    if (digits.length === 4) {
        const p1 = +digits.slice(0, 2), p2 = +digits.slice(2, 4);
        if (p1 >= 1 && p1 <= 12 && p2 >= 24 && p2 <= 40) return `20${digits.slice(2, 4)}-${digits.slice(0, 2)}`;
        if (p1 >= 24 && p1 <= 40 && p2 >= 1 && p2 <= 12) return `20${digits.slice(0, 2)}-${digits.slice(2, 4)}`;
    }
    return s;
}

function finalize(data) {
    if (data.gtin) data.gtin = cleanAlphanumeric(data.gtin);
    if (data.batch) data.batch = cleanAlphanumeric(data.batch).toUpperCase();
    if (data.serial) data.serial = cleanAlphanumeric(data.serial).toUpperCase();
    if (data.raw_expiry) data.expiry = parseExpiryDate(data.raw_expiry);
    if (data.raw_prod_date) data.prod_date = parseExpiryDate(data.raw_prod_date);
    if (!data.batch && !data.serial)
        return { success: false, code: 'MISSING_BATCH_OR_SERIAL', message: 'كود QR لا يحتوي على رقم الباتش أو السيريال المطلوب.', data };
    if (!data.gtin)
        return { success: false, code: 'MISSING_GTIN', message: 'كود QR لا يحتوي على كود الصنف أو GTIN للتعرف عليه.', data };
    return { success: true, code: 'OK', message: 'تمت قراءة كود QR بنجاح.', data };
}

const B = '([a-zA-Z0-9_\\-\\.]{1,20}?)', R = '([a-zA-Z0-9_\\-\\.]+)', D6 = '(\\d{6})', G = '^01(\\d{14})';
const CONCAT_PATTERNS = [
    [`${G}10${B}11${D6}17${D6}21${R}$`, 'gtin', 'batch', 'raw_prod_date', 'raw_expiry', 'serial'],
    [`${G}10${B}17${D6}11${D6}21${R}$`, 'gtin', 'batch', 'raw_expiry', 'raw_prod_date', 'serial'],
    [`${G}11${D6}17${D6}10${B}21${R}$`, 'gtin', 'raw_prod_date', 'raw_expiry', 'batch', 'serial'],
    [`${G}17${D6}11${D6}10${B}21${R}$`, 'gtin', 'raw_expiry', 'raw_prod_date', 'batch', 'serial'],
    [`${G}21${B}11${D6}17${D6}10${R}$`, 'gtin', 'serial', 'raw_prod_date', 'raw_expiry', 'batch'],
    [`${G}21${B}17${D6}11${D6}10${R}$`, 'gtin', 'serial', 'raw_expiry', 'raw_prod_date', 'batch'],
    [`${G}21${B}10${B}11${D6}17${D6}$`, 'gtin', 'serial', 'batch', 'raw_prod_date', 'raw_expiry'],
    [`${G}21${B}10${B}17${D6}11${D6}$`, 'gtin', 'serial', 'batch', 'raw_expiry', 'raw_prod_date'],
    [`${G}17${D6}11${D6}21${B}10${R}$`, 'gtin', 'raw_expiry', 'raw_prod_date', 'serial', 'batch'],
    [`${G}11${D6}17${D6}21${B}10${R}$`, 'gtin', 'raw_prod_date', 'raw_expiry', 'serial', 'batch'],
    [`${G}10${B}11${D6}17${D6}$`, 'gtin', 'batch', 'raw_prod_date', 'raw_expiry'],
    [`${G}10${B}17${D6}11${D6}$`, 'gtin', 'batch', 'raw_expiry', 'raw_prod_date'],
    [`${G}11${D6}17${D6}10${R}$`, 'gtin', 'raw_prod_date', 'raw_expiry', 'batch'],
    [`${G}17${D6}11${D6}10${R}$`, 'gtin', 'raw_expiry', 'raw_prod_date', 'batch'],
    [`${G}10${B}11${D6}21${R}$`, 'gtin', 'batch', 'raw_prod_date', 'serial'],
    [`${G}11${D6}10${B}21${R}$`, 'gtin', 'raw_prod_date', 'batch', 'serial'],
    [`${G}21${B}11${D6}10${R}$`, 'gtin', 'serial', 'raw_prod_date', 'batch'],
    [`${G}10${B}11${D6}$`, 'gtin', 'batch', 'raw_prod_date'],
    [`${G}11${D6}10${R}$`, 'gtin', 'raw_prod_date', 'batch'],
    [`${G}21${B}17${D6}10${R}$`, 'gtin', 'serial', 'raw_expiry', 'batch'],
    [`${G}17${D6}10${B}21${R}$`, 'gtin', 'raw_expiry', 'batch', 'serial'],
    [`${G}17${D6}21${B}10${R}$`, 'gtin', 'raw_expiry', 'serial', 'batch'],
    [`${G}10${B}17${D6}21${R}$`, 'gtin', 'batch', 'raw_expiry', 'serial'],
    [`${G}21${B}10${B}17${D6}$`, 'gtin', 'serial', 'batch', 'raw_expiry'],
    [`${G}17${D6}10${R}$`, 'gtin', 'raw_expiry', 'batch'],
    [`${G}10${B}17${D6}$`, 'gtin', 'batch', 'raw_expiry'],
].map(([p, ...f]) => [new RegExp(p), f]);

const AI_FIELD = { '01': 'gtin', '10': 'batch', '21': 'serial', '17': 'raw_expiry', '11': 'raw_prod_date' };

export function parseQrCode(rawInput) {
    if (!rawInput || !String(rawInput).trim())
        return { success: false, error: 'كود QR فارغ', message: 'كود QR فارغ ولا يحتوي على أي بيانات.' };
    const raw = decodeArabicKeyboardLayout(String(rawInput).trim());
    let n = raw.replace(/<\s*GS\s*>/gi, '\x1d').replace(/\[\s*GS\s*\]/gi, '\x1d').replace(/\{\s*GS\s*\}/gi, '\x1d');
    n = n.split('^]').join('\x1d').replace(/^\][dqcQDC][0-9]/, '');
    const data = { gtin: null, batch: null, serial: null, raw_expiry: null, expiry: null, raw_prod_date: null, prod_date: null, raw };

    if (n.startsWith('{') && n.endsWith('}')) {
        try {
            const j = JSON.parse(n);
            for (const [k, v] of Object.entries(j)) {
                const kl = String(k).toLowerCase().trim(), val = String(v).trim();
                if (['gtin', '01', 'barcode', 'item'].includes(kl)) data.gtin = val;
                else if (['batch', '10', 'lot', 'lot_number', 'batch_number'].includes(kl)) data.batch = val;
                else if (['serial', '21', 'sn', 'serial_number'].includes(kl)) data.serial = val;
                else if (['expiry', '17', 'exp', 'expiry_date', 'exp_date'].includes(kl)) data.raw_expiry = val;
                else if (['prod', 'mfg', '11', 'prod_date', 'mfg_date', 'production_date'].includes(kl)) data.raw_prod_date = val;
            }
            if (data.gtin || data.batch || data.serial) return finalize(data);
        } catch (_) { }
    }

    if (n.includes('(') && n.includes(')')) {
        const matches = [...n.matchAll(/\(([0-9]{2,4})\)([^()]+)/g)];
        if (matches.length) {
            for (const [, ai, val] of matches) { const f = AI_FIELD[ai]; if (f) data[f] = cleanAlphanumeric(val); }
            if (data.gtin || data.batch || data.serial) return finalize(data);
        }
    }

    if (n.startsWith('http://') || n.startsWith('https://')) {
        try {
            const u = new URL(n);
            const parts = u.pathname.split('/').filter(Boolean);
            for (let i = 0; i < parts.length - 1; i += 2) { const f = AI_FIELD[parts[i].trim()]; if (f) data[f] = parts[i + 1].trim(); }
            for (const [k, v] of u.searchParams) { const f = AI_FIELD[k.trim()]; if (f) data[f] = v; }
        } catch (_) { }
        if (data.gtin || data.batch || data.serial) return finalize(data);
    }

    const kv = [
        [/(?:gtin|barcode|الباركود|كود الصنف|01)[\s:=]+([^\s,;\r\n]+)/i, 'gtin'],
        [/(?:batch|lot|التشغيلة|الدفعة|الباتش|10)[\s:=]+([^\s,;\r\n]+)/i, 'batch'],
        [/(?:serial|sn|السيريال|الرقم التسلسلي|21)[\s:=]+([^\s,;\r\n]+)/i, 'serial'],
        [/(?:exp|expiry|صلاحية|تاريخ الانتهاء|الانتهاء|17)[\s:=]+([^\s,;\r\n]+)/i, 'raw_expiry'],
        [/(?:mfg|prod|production|انتاج|تاريخ الانتاج|11)[\s:=]+([^\s,;\r\n]+)/i, 'raw_prod_date'],
    ];
    let matchedKv = false;
    for (const [re, f] of kv) { const m = n.match(re); if (m) { data[f] = cleanAlphanumeric(m[1]); matchedKv = true; } }
    if (matchedKv && (data.gtin || data.batch || data.serial)) return finalize(data);

    for (const [re, fields] of CONCAT_PATTERNS) {
        const m = n.match(re);
        if (m) { fields.forEach((f, i) => { if (f && i < m.length - 1) data[f] = m[i + 1]; }); return finalize(data); }
    }

    for (const token of n.split('\x1d')) {
        let idx = 0; const L = token.length;
        while (idx < L) {
            const ai = token.slice(idx, idx + 2);
            if (ai === '01' && L >= idx + 16 && isDigitStr(token.slice(idx + 2, idx + 16))) { data.gtin = token.slice(idx + 2, idx + 16); idx += 16; continue; }
            if (ai === '17' && L >= idx + 8 && isDigitStr(token.slice(idx + 2, idx + 8))) { data.raw_expiry = token.slice(idx + 2, idx + 8); idx += 8; continue; }
            if (ai === '11' && L >= idx + 8 && isDigitStr(token.slice(idx + 2, idx + 8))) { data.raw_prod_date = token.slice(idx + 2, idx + 8); idx += 8; continue; }
            if (ai === '10' || ai === '21') {
                const val = token.slice(idx + 2).split(' ')[0];
                if (ai === '10') data.batch = cleanAlphanumeric(val); else data.serial = cleanAlphanumeric(val);
                break;
            }
            idx += 1;
        }
    }
    return finalize(data);
}

const zfill14 = (v) => ([8, 12, 13].includes(v.length) ? v.padStart(14, '0') : v);

export function extractCleanGtin(rawInput) {
    if (!rawInput) return '';
    let s = String(rawInput).trim().replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
    s = decodeArabicKeyboardLayout(s).replace(/^\][dqcQDC][0-9]/, '');
    s = s.replace(/<\s*GS\s*>/gi, '\x1d').replace(/\[\s*GS\s*\]/gi, '\x1d').replace(/\{\s*GS\s*\}/gi, '\x1d').split('^]').join('\x1d');
    let m = s.match(/\(01\)(\d{8,14})/); if (m) return zfill14(m[1]);
    m = s.match(/\/01\/(\d{8,14})/); if (m) return zfill14(m[1]);
    m = s.match(/(?:^|[^\d])01(\d{14})/); if (m) return m[1];
    m = s.match(/(?:gtin|barcode|01)[\s:=]+(\d{8,14})/i); if (m) return zfill14(m[1]);
    const digits = s.replace(/\D/g, '');
    if (digits.length === 14) return digits;
    if ([8, 12, 13].includes(digits.length)) return digits.padStart(14, '0');
    if (digits.length > 14 && digits.startsWith('01')) return digits.slice(2, 16);
    return '';
}

// تقريب مطابق لدالة round في بايثون: يعتمد على القيمة الثنائية الفعلية للرقم، والتعادل التام يُقرّب للزوجي
export function pyRound(x, n = 0) {
    x = Number(x);
    if (!Number.isFinite(x)) return x;
    const neg = x < 0, a = Math.abs(x);
    const s = a.toFixed(Math.min(100, n + 25));
    const dot = s.indexOf('.');
    const tail = s.slice(dot + 1 + n);
    let r;
    if (/^50*$/.test(tail)) {
        const base = Number(s.slice(0, dot + 1 + n).replace(/\.$/, ''));
        const unit = 10 ** -n;
        const lastDigit = Number(s.slice(0, dot + 1 + n).replace('.', '').slice(-1));
        r = lastDigit % 2 === 0 ? base : Number((base + unit).toFixed(n));
    } else {
        r = Number(a.toFixed(n));
    }
    return neg ? -r : r;
}
