// استيراد كتالوج الأصناف من إكسيل (منقول من backend/catalog_importer.py).
// المتصفح يقرأ الملف ويحلله، والسحابة توفر البحث عن الأكواد/الباركودات الموجودة وتحفظ الأصناف على دفعات.
import { all, first, run, allIn } from './products.js';
import { splitBarcodes, normalizeArabic, normalizeEnglish } from './qr.js';
import { logAuditEvent, logCatalogChange } from './extra.js';

// أصناف وباركودات قاعدة البيانات التي تخص أكواد/باركودات الملف فقط (بدلاً من تحميل الكتالوج كاملاً)
export async function importLookup(db, codes, barcodes) {
    codes = [...new Set((codes || []).map(String).filter(Boolean))];
    barcodes = [...new Set((barcodes || []).map(String).filter(Boolean))];
    const bmap = {};
    if (barcodes.length) {
        // بنفس ترتيب الجدول: آخر صف يفوز (مثل قاموس بايثون)
        for (const r of await allIn(db, 'SELECT id, barcode, product_code FROM product_barcodes WHERE barcode IN ({ph}) ORDER BY id ASC', [], barcodes))
            bmap[r.barcode] = r.product_code;
    }
    const allCodes = [...new Set([...codes, ...Object.values(bmap)])];
    const prods = {};
    if (allCodes.length) {
        for (const p of await allIn(db, 'SELECT * FROM products WHERE code IN ({ph})', [], allCodes)) prods[p.code] = p;
        const bl = {};
        for (const r of await allIn(db, 'SELECT product_code, barcode, barcode_type FROM product_barcodes WHERE product_code IN ({ph}) ORDER BY id ASC', [], Object.keys(prods))) {
            const e = (bl[r.product_code] ||= { barcodes: [], gtins: [] });
            if (r.barcode_type === 'gtin') { if (!e.gtins.includes(r.barcode)) e.gtins.push(r.barcode); }
            else if (!e.barcodes.includes(r.barcode)) e.barcodes.push(r.barcode);
        }
        for (const [code, p] of Object.entries(prods)) {
            const b = bl[code] || { barcodes: [], gtins: [] };
            p.barcode_list = b.barcodes.slice(); p.gtin_list = b.gtins.slice();
            if (p.barcode && !p.barcode_list.length) p.barcode_list = splitBarcodes(p.barcode);
            if (p.gtin && !p.gtin_list.length) p.gtin_list = splitBarcodes(p.gtin);
        }
    }
    const mx = await first(db, "SELECT MAX(CAST(code AS INTEGER)) AS m FROM products WHERE code GLOB '[0-9]*' AND length(code) <= 10");
    return { success: true, products: prods, barcodes: bmap, max_code: mx ? mx.m : null };
}

// حفظ دفعة من الأصناف (نفس منطق commit_import_catalog لكل صنف)
export async function commitImportChunk(db, items, replaceBarcodes) {
    const codes = [...new Set(items.map(it => it.code).filter(Boolean))];
    const look = await importLookup(db, codes, []);
    const dbProds = look.products;
    const existing = new Set(Object.keys(dbProds));
    let currentMax = look.max_code !== null && look.max_code !== undefined ? look.max_code : 10000;
    if (currentMax < 10000) currentMax = 10000;
    const stmts = [], changed = [];
    let updated = 0, added = 0, bcount = 0;
    const insB = (code, b, t) => { stmts.push(db.prepare(`INSERT OR IGNORE INTO product_barcodes (product_code, barcode, barcode_type) VALUES (?, ?, '${t}')`).bind(code, b)); bcount++; };
    for (const it of items) {
        let code = it.code;
        const isUpdate = Boolean(code && existing.has(code));
        const mapped = new Set(it.mapped_fields || []);
        if (isUpdate) {
            const ex = dbProds[code];
            const cl = [], pr = [];
            if (mapped.has('name_ar') && it.name_ar) { cl.push('name_ar = ?', 'normalized_name_ar = ?'); pr.push(it.name_ar, normalizeArabic(it.name_ar)); }
            if (mapped.has('name_en') && it.name_en) { cl.push('name_en = ?', 'normalized_name_en = ?'); pr.push(it.name_en, normalizeEnglish(it.name_en)); }
            if ((mapped.has('name_ar') || mapped.has('name_en')) && it.name) { cl.push('name = ?', 'normalized_name = ?'); pr.push(it.name, normalizeArabic(it.name)); }
            if (mapped.has('scientific_name') && it.scientific_name) { cl.push('scientific_name = ?'); pr.push(it.scientific_name); }
            if (mapped.has('company') && it.company) { cl.push('company = ?'); pr.push(it.company); }
            if (mapped.has('category') && it.category) { cl.push('category = ?'); pr.push(it.category); }
            if (mapped.has('selling_price') && it.selling_price !== null && it.selling_price !== undefined) { cl.push('selling_price = ?'); pr.push(Number(it.selling_price)); }
            if (mapped.has('wholesale_price') && it.wholesale_price !== null && it.wholesale_price !== undefined) { cl.push('wholesale_price = ?'); pr.push(Number(it.wholesale_price)); }
            if (mapped.has('cost_price') || mapped.has('unit_price')) { const cv = Number(it.unit_price || 0); cl.push('cost_price = ?', 'unit_price = ?'); pr.push(cv, cv); }
            if (mapped.has('tax_rate') && it.tax_rate !== null && it.tax_rate !== undefined) { cl.push('tax_rate = ?'); pr.push(Number(it.tax_rate)); }
            if (mapped.has('unit') && it.unit) { cl.push('unit = ?'); pr.push(it.unit); }
            if (mapped.has('unit_divisions') && it.unit_divisions) { cl.push('unit_divisions = ?'); pr.push(it.unit_divisions); }
            if (replaceBarcodes) {
                if (mapped.has('barcode') && (it.barcode_list || []).length) {
                    stmts.push(db.prepare("DELETE FROM product_barcodes WHERE product_code = ? AND barcode_type = 'barcode'").bind(code));
                    cl.push('barcode = ?'); pr.push(it.barcode_list.join(', '));
                    for (const b of it.barcode_list) insB(code, b, 'barcode');
                }
                if (mapped.has('gtin') && (it.gtin_list || []).length) {
                    stmts.push(db.prepare("DELETE FROM product_barcodes WHERE product_code = ? AND barcode_type = 'gtin'").bind(code));
                    cl.push('gtin = ?'); pr.push(it.gtin_list.join(', '));
                    for (const g of it.gtin_list) insB(code, g, 'gtin');
                }
            } else {
                if (mapped.has('barcode') && (it.barcode_list || []).length) {
                    const merged = (ex.barcode_list || []).slice();
                    for (const b of it.barcode_list) { if (!merged.includes(b)) merged.push(b); insB(code, b, 'barcode'); }
                    cl.push('barcode = ?'); pr.push(merged.join(', '));
                }
                if (mapped.has('gtin') && (it.gtin_list || []).length) {
                    const merged = (ex.gtin_list || []).slice();
                    for (const g of it.gtin_list) { if (!merged.includes(g)) merged.push(g); insB(code, g, 'gtin'); }
                    cl.push('gtin = ?'); pr.push(merged.join(', '));
                }
            }
            if (cl.length) {
                cl.push('updated_at = CURRENT_TIMESTAMP');
                stmts.push(db.prepare(`UPDATE products SET ${cl.join(', ')} WHERE code = ?`).bind(...pr, code));
            }
            updated++;
        } else {
            if (!code) {
                currentMax += 1;
                while (existing.has(String(currentMax)) || await first(db, 'SELECT 1 AS x FROM products WHERE code = ?', [String(currentMax)])) currentMax += 1;
                code = String(currentMax);
                existing.add(code);
            }
            const gl = it.gtin_list || [], bl = it.barcode_list || [];
            stmts.push(db.prepare(`INSERT INTO products (code, gtin, barcode, name_ar, name_en, name, scientific_name, company, normalized_name_ar, normalized_name_en, normalized_name,
                selling_price, wholesale_price, cost_price, unit_price, tax_rate, unit, unit_divisions, category, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`).bind(
                code, gl.length ? gl.join(', ') : '', bl.length ? bl.join(', ') : '', it.name_ar, it.name_en, it.name, it.scientific_name, it.company,
                normalizeArabic(it.name_ar), normalizeEnglish(it.name_en), normalizeArabic(it.name),
                it.selling_price, it.wholesale_price, it.unit_price, it.unit_price, it.tax_rate, it.unit, it.unit_divisions, it.category));
            for (const b of bl) insB(code, b, 'barcode');
            for (const g of gl) insB(code, g, 'gtin');
            added++;
        }
        changed.push(code);
    }
    if (added) stmts.push(db.prepare("UPDATE meta SET v = MAX(0, CAST(v AS INTEGER) + (?)) WHERE k = 'products_count'").bind(added));
    // دفعات D1 ذرية: لو فشل أي جزء لا يُحفظ شيء من هذه الدفعة
    for (let i = 0; i < stmts.length; i += 500) await db.batch(stmts.slice(i, i + 500));
    await logCatalogChange(db, changed);
    return { success: true, updated_count: updated, new_count: added, barcodes_registered_count: bcount };
}

export async function finishImport(db, fileName, updated, added, replaceBarcodes) {
    await logAuditEvent(db, 'catalog_import', fileName || 'catalog.xlsx', updated > 0 ? 'excel_update' : 'excel_import', null,
        { updated_count: updated, new_count: added, replace_barcodes: Boolean(replaceBarcodes) },
        `تحديث ${updated} صنف وإضافة ${added} صنف جديد عبر Excel (وضع الباركود: ${replaceBarcodes ? 'استبدال' : 'تراكمي'})`);
    return { success: true };
}
