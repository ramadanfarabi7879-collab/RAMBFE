#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
إضافة أيقونات وأزرار مسح وحذف كرت الصنف (كامل أو بعض كرت الصنف) في الواجهة:
1. داخل نافذة كرت الصنف:
   - أيقونة وقائمة منسدلة لمسح الخانات (مسح كرت الصنف كاملاً، مسح الباركودات و GTIN فقط، مسح الأسعار فقط، مسح الأسماء).
   - أيقونة وزر حذف كرت الصنف نهائياً من قاعدة البيانات مع تأكيد فوري.
2. في شريط دليل الأصناف:
   - زر حذف الأصناف المحددة في الجدول دفعة واحدة.
   - زر مسح دليل الأصناف بالكامل.
"""

import os
import re

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_PATH = os.path.join(BASE_DIR, "frontend", "index.html")
APP_PATH = os.path.join(BASE_DIR, "frontend", "app.js")

def update_index_html():
    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        html = f.read()

    # 1. إضافة زر مسح الدليل بالكامل في أزرار دليل الأصناف العلوية
    old_top_btns = '<button id="btn-goto-import-tab" class="px-3.5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold border border-slate-300 transition flex items-center gap-1.5" title="استيراد وتحديث كروت الأصناف من ملف إكسيل">\n                        <span>📥</span>\n                        <span>استيراد وتحديث من Excel</span>\n                    </button>'
    new_top_btns = """<button id="btn-goto-import-tab" class="px-3.5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl text-xs font-bold border border-slate-300 transition flex items-center gap-1.5" title="استيراد وتحديث كروت الأصناف من ملف إكسيل">
                        <span>📥</span>
                        <span>استيراد وتحديث من Excel</span>
                    </button>
                    <button id="btn-clear-all-catalog" class="px-3 py-2.5 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-xl text-xs font-bold border border-rose-200 transition flex items-center gap-1.5" title="مسح وتفريغ كروت الأصناف بالكامل من النظام">
                        <span>🗑️</span>
                        <span>مسح الدليل بالكامل</span>
                    </button>"""
    if old_top_btns in html:
        html = html.replace(old_top_btns, new_top_btns)
    else:
        # Fallback regex
        html = re.sub(
            r'(<button id="btn-goto-import-tab"[^>]*>[\s\S]*?<\/button>)',
            r'\1\n                    <button id="btn-clear-all-catalog" class="px-3 py-2.5 bg-rose-50 hover:bg-rose-100 text-rose-700 rounded-xl text-xs font-bold border border-rose-200 transition flex items-center gap-1.5" title="مسح وتفريغ كروت الأصناف بالكامل من النظام">\n                        <span>🗑️</span>\n                        <span>مسح الدليل بالكامل</span>\n                    </button>',
            html
        )

    # 2. إضافة زر حذف الأصناف المحددة في شريط العمليات catalog-selection-bar
    old_sel_bar = '<button id="btn-clear-catalog-selection" class="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded-xl text-xs font-semibold">\n                        إلغاء التحديد ✕\n                    </button>'
    new_sel_bar = """<button id="btn-delete-selected-catalog" class="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow" title="حذف جميع كروت الأصناف المحددة نهائياً من النظام">
                        <span>🗑️</span>
                        <span id="btn-delete-selected-text">حذف الأصناف المحددة</span>
                    </button>
                    <button id="btn-clear-catalog-selection" class="px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded-xl text-xs font-semibold">
                        إلغاء التحديد ✕
                    </button>"""
    if old_sel_bar in html:
        html = html.replace(old_sel_bar, new_sel_bar)
    else:
        html = re.sub(
            r'(<button id="btn-clear-catalog-selection"[^>]*>[\s\S]*?<\/button>)',
            r'<button id="btn-delete-selected-catalog" class="px-3.5 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow" title="حذف جميع كروت الأصناف المحددة نهائياً من النظام">\n                        <span>🗑️</span>\n                        <span id="btn-delete-selected-text">حذف الأصناف المحددة</span>\n                    </button>\n                    \1',
            html
        )

    # 3. تحديث هيدر نافذة بطاقة الصنف modal-product-card لإضافة أيقونة مسح الخانات وأيقونة حذف الصنف
    old_modal_header = """<div class="flex items-center justify-between border-b border-slate-100 pb-3">
                <div>
                    <h3 class="text-base font-bold text-slate-800" id="modal-product-title">بطاقة الصنف</h3>
                    <p class="text-xs text-slate-500">إدخال وتعديل بيانات بطاقة الصنف وربط الباركودات و GTINs</p>
                </div>
                <button id="btn-close-product-modal" class="text-slate-400 hover:text-slate-700 text-lg">✕</button>
            </div>"""

    new_modal_header = """<div class="flex items-center justify-between border-b border-slate-100 pb-3">
                <div>
                    <h3 class="text-base font-bold text-slate-800 flex items-center gap-2">
                        <span>🗂️</span>
                        <span id="modal-product-title">بطاقة الصنف</span>
                    </h3>
                    <p class="text-xs text-slate-500">إدخال وتعديل بيانات بطاقة الصنف وربط الباركودات و GTINs</p>
                </div>
                <div class="flex items-center gap-2">
                    <!-- قائمة وأيقونة مسح وتفريغ كرت الصنف (كامل أو جزئي) -->
                    <div class="relative inline-block text-right">
                        <button type="button" id="btn-card-clear-menu" class="px-2.5 py-1.5 bg-amber-50 hover:bg-amber-100 text-amber-800 border border-amber-300 rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-sm" title="مسح وتفريغ كرت الصنف كاملاً أو بعض الخانات">
                            <span>🧹</span>
                            <span>مسح الخانات</span>
                            <span class="text-[9px]">▼</span>
                        </button>
                        <div id="card-clear-dropdown" class="hidden absolute left-0 mt-1.5 w-64 bg-white rounded-xl shadow-2xl border border-slate-200 p-1.5 z-50 space-y-1 text-xs animate-fadeIn">
                            <button type="button" id="btn-clear-entire-card" class="w-full text-right px-3 py-2 text-rose-700 hover:bg-rose-50 rounded-lg font-bold flex items-center gap-2 transition">
                                <span>🧹</span>
                                <div class="leading-tight">
                                    <div>مسح كرت الصنف كاملاً</div>
                                    <span class="text-[10px] text-slate-400 font-normal">تفريغ كافة الحقول والباركودات للبدء من جديد</span>
                                </div>
                            </button>
                            <button type="button" id="btn-clear-barcodes-only" class="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-100 rounded-lg font-semibold flex items-center gap-2 transition">
                                <span>🏷️</span>
                                <div class="leading-tight">
                                    <div>مسح الباركودات و GTIN فقط</div>
                                    <span class="text-[10px] text-slate-400 font-normal">تفريغ خانات الباركود مع إبقاء الاسم والأسعار</span>
                                </div>
                            </button>
                            <button type="button" id="btn-clear-prices-only" class="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-100 rounded-lg font-semibold flex items-center gap-2 transition">
                                <span>💰</span>
                                <div class="leading-tight">
                                    <div>مسح الأسعار والضريبة فقط</div>
                                    <span class="text-[10px] text-slate-400 font-normal">تصفير سعر البيع والتكلفة والجملة</span>
                                </div>
                            </button>
                            <button type="button" id="btn-clear-names-only" class="w-full text-right px-3 py-2 text-slate-700 hover:bg-slate-100 rounded-lg font-semibold flex items-center gap-2 transition">
                                <span>📝</span>
                                <div class="leading-tight">
                                    <div>مسح الأسماء والتصنيف فقط</div>
                                    <span class="text-[10px] text-slate-400 font-normal">تفريغ الاسم العربي والإنجليزي والمصنع</span>
                                </div>
                            </button>
                        </div>
                    </div>

                    <!-- زر وأيقونة حذف كرت الصنف نهائياً من قاعدة البيانات -->
                    <button type="button" id="btn-modal-delete-product" class="hidden px-2.5 py-1.5 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-300 rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-sm" title="حذف كرت هذا الصنف نهائياً من قاعدة البيانات">
                        <span>🗑️</span>
                        <span>حذف الصنف</span>
                    </button>

                    <button id="btn-close-product-modal" class="text-slate-400 hover:text-slate-700 text-lg px-1.5 py-0.5 rounded-lg hover:bg-slate-100 transition">✕</button>
                </div>
            </div>"""

    if old_modal_header in html:
        html = html.replace(old_modal_header, new_modal_header)
    else:
        html = re.sub(
            r'<div class="flex items-center justify-between border-b border-slate-100 pb-3">[\s\S]*?<button id="btn-close-product-modal"[^>]*>✕<\/button>\s*<\/div>',
            new_modal_header,
            html
        )

    # 4. تحديث فوتر نافذة بطاقة الصنف
    old_modal_footer = """<!-- أزرار الحفظ -->
            <div class="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
                <button id="btn-cancel-product-modal" class="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl text-xs font-bold hover:bg-slate-200">إلغاء</button>
                <button id="btn-save-product-card" class="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition flex items-center gap-2 shadow">
                    <span>💾</span>
                    <span>حفظ بطاقة الصنف</span>
                </button>
            </div>"""

    new_modal_footer = """<!-- أزرار الحفظ والحذف -->
            <div class="flex items-center justify-between pt-4 border-t border-slate-100">
                <button type="button" id="btn-footer-delete-product" class="hidden px-4 py-2 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-300 rounded-xl text-xs font-bold transition flex items-center gap-1.5 shadow-sm">
                    <span>🗑️</span>
                    <span>حذف كرت الصنف نهائياً</span>
                </button>
                <div class="flex items-center gap-3 mr-auto">
                    <button id="btn-cancel-product-modal" class="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl text-xs font-bold hover:bg-slate-200">إلغاء</button>
                    <button id="btn-save-product-card" class="px-6 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold transition flex items-center gap-2 shadow">
                        <span>💾</span>
                        <span>حفظ بطاقة الصنف</span>
                    </button>
                </div>
            </div>"""

    if old_modal_footer in html:
        html = html.replace(old_modal_footer, new_modal_footer)
    else:
        html = re.sub(
            r'<!-- أزرار الحفظ -->\s*<div class="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">[\s\S]*?<\/div>',
            new_modal_footer,
            html
        )

    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        f.write(html)
    print("[OK] frontend/index.html updated successfully")

def update_app_js():
    with open(APP_PATH, "r", encoding="utf-8") as f:
        js = f.read()

    # نتحقق من دمج وظائف مسح كرت الصنف وحذف الصنف
    setup_code = """
    // =========================================================================
    // وظائف مسح وحذف كرت الصنف (كامل أو بعض كرت الصنف)
    // =========================================================================
    let activeEditingProductCode = null;

    // فتح وإغلاق القائمة المنسدلة لمسح خانات كرت الصنف
    const btnClearMenu = document.getElementById('btn-card-clear-menu');
    const clearDropdown = document.getElementById('card-clear-dropdown');

    btnClearMenu?.addEventListener('click', (e) => {
        e.stopPropagation();
        clearDropdown?.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
        if (!clearDropdown?.contains(e.target) && e.target !== btnClearMenu) {
            clearDropdown?.classList.add('hidden');
        }
    });

    // 1. مسح كرت الصنف كاملاً (تفريغ جميع الحقول والباركودات)
    document.getElementById('btn-clear-entire-card')?.addEventListener('click', () => {
        clearDropdown?.classList.add('hidden');
        if (confirm('هل تريد مسح وتفريغ كامل خانات كرت الصنف؟')) {
            clearProductCardInputs(true);
            showCatalogToast('تم مسح كامل خانات كرت الصنف');
        }
    });

    // 2. مسح الباركودات و GTIN فقط
    document.getElementById('btn-clear-barcodes-only')?.addEventListener('click', () => {
        clearDropdown?.classList.add('hidden');
        const pBar = document.getElementById('prod-primary-barcode');
        const pGtin = document.getElementById('prod-primary-gtin');
        const eb = document.getElementById('extra-barcodes-container');
        const eg = document.getElementById('extra-gtins-container');
        if (pBar) pBar.value = '';
        if (pGtin) pGtin.value = '';
        if (eb) eb.innerHTML = '';
        if (eg) eg.innerHTML = '';
        cancelGs1Inspector();
        showCatalogToast('تم مسح جميع الباركودات و GTIN من كرت الصنف');
    });

    // 3. مسح وتصفير الأسعار فقط
    document.getElementById('btn-clear-prices-only')?.addEventListener('click', () => {
        clearDropdown?.classList.add('hidden');
        const sp = document.getElementById('prod-selling-price');
        const up = document.getElementById('prod-unit-price');
        const wp = document.getElementById('prod-wholesale-price');
        const tx = document.getElementById('prod-tax-rate');
        if (sp) sp.value = '';
        if (up) up.value = '';
        if (wp) wp.value = '';
        if (tx) tx.value = '0';
        showCatalogToast('تم تصفير خانات الأسعار والضريبة');
    });

    // 4. مسح بيانات الأسماء والتصنيف فقط
    document.getElementById('btn-clear-names-only')?.addEventListener('click', () => {
        clearDropdown?.classList.add('hidden');
        const na = document.getElementById('prod-name-ar');
        const ne = document.getElementById('prod-name-en');
        const sc = document.getElementById('prod-scientific-name');
        const co = document.getElementById('prod-company');
        const ca = document.getElementById('prod-category');
        if (na) na.value = '';
        if (ne) ne.value = '';
        if (sc) sc.value = '';
        if (co) co.value = '';
        if (ca) ca.value = '';
        showCatalogToast('تم مسح الأسماء والتصنيف');
    });

    // حذف كرت الصنف المفتوح حالياً نهائياً من قاعدة البيانات
    const executeDeleteCurrentProductCard = async () => {
        const code = activeEditingProductCode || document.getElementById('prod-code-input')?.value.trim();
        if (!code) {
            alert('لا يوجد كود صنف محدد للحذف.');
            return;
        }
        const name = document.getElementById('prod-name-en')?.value || document.getElementById('prod-name-ar')?.value || code;
        if (!confirm(`هل أنت متأكد من حذف كرت الصنف [${code}] (${name}) نهائياً من قاعدة البيانات؟\\nلن يمكن التراجع عن هذا الإجراء.`)) {
            return;
        }

        try {
            const res = await fetch('/api/catalog/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code })
            });
            const data = await res.json();
            if (data.success) {
                closeProductModal();
                selectedCatalogCodes.delete(code);
                if (isAccumulatedSearchMode) {
                    accumulatedSearchResults.delete(code);
                    renderCatalogItemsTable(Array.from(accumulatedSearchResults.values()), accumulatedSearchResults.size, true);
                } else {
                    loadCatalogProducts();
                }
                refreshSystemStats();
                showCatalogToast(`تم حذف كرت الصنف [${code}] بنجاح 🗑️`);
            } else {
                alert(data.message || 'فشل حذف الصنف.');
            }
        } catch (e) {
            alert('حدث خطأ أثناء الحذف: ' + e.message);
        }
    };

    document.getElementById('btn-modal-delete-product')?.addEventListener('click', executeDeleteCurrentProductCard);
    document.getElementById('btn-footer-delete-product')?.addEventListener('click', executeDeleteCurrentProductCard);

    // حذف مجموعة الأصناف المحددة من شريط التحديد catalog-selection-bar
    document.getElementById('btn-delete-selected-catalog')?.addEventListener('click', async () => {
        const count = selectedCatalogCodes.size;
        if (count === 0) {
            alert('لم يتم تحديد أي أصناف لحذفها.');
            return;
        }
        if (!confirm(`تحذير: هل أنت متأكد من حذف (${count}) كرت صنف محدد نهائياً من قاعدة البيانات؟`)) {
            return;
        }

        try {
            const codes = Array.from(selectedCatalogCodes);
            const res = await fetch('/api/catalog/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ codes })
            });
            const data = await res.json();
            if (data.success) {
                selectedCatalogCodes.clear();
                if (isAccumulatedSearchMode) {
                    codes.forEach(c => accumulatedSearchResults.delete(c));
                    renderCatalogItemsTable(Array.from(accumulatedSearchResults.values()), accumulatedSearchResults.size, true);
                } else {
                    loadCatalogProducts();
                }
                refreshSystemStats();
                updateCatalogSelectionUI();
                showCatalogToast(`تم حذف (${data.deleted_count || count}) صنف بنجاح 🗑️`);
            } else {
                alert(data.message || 'فشل حذف الأصناف المحددة.');
            }
        } catch (e) {
            alert('حدث خطأ أثناء حذف الأصناف: ' + e.message);
        }
    });

    // مسح دليل الأصناف بالكامل
    document.getElementById('btn-clear-all-catalog')?.addEventListener('click', async () => {
        const confirmWord = prompt('⚠️ تحذير شديد: أنت على وشك مسح جميع كروت الأصناف في الدليل بالكامل!\\n\\nللتأكيد، اكتب كلمة "حذف" في المربع أدناه:');
        if (confirmWord !== 'حذف') {
            if (confirmWord !== null) alert('تم إلغاء العملية، الكلمة المدخلة غير صحيحة.');
            return;
        }

        try {
            const res = await fetch('/api/catalog/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clear_all: true })
            });
            const data = await res.json();
            if (data.success) {
                selectedCatalogCodes.clear();
                accumulatedSearchResults.clear();
                loadCatalogProducts();
                refreshSystemStats();
                updateCatalogSelectionUI();
                alert('تم تفريغ دليل الأصناف بالكامل بنجاح.');
            } else {
                alert(data.message || 'فشل مسح دليل الأصناف.');
            }
        } catch (e) {
            alert('حدث خطأ أثناء مسح الدليل: ' + e.message);
        }
    });
    """

    if "btn-card-clear-menu" not in js:
        # إدراج الكود قبل نهاية ملف app.js أو في setupCatalogEvents
        js += setup_code

    # تحديث دالة clearProductCardInputs لدعم تفريغ الحقول
    clear_func = """function clearProductCardInputs(clearCode = false) {
    if (clearCode) {
        activeEditingProductCode = null;
        document.getElementById('prod-code-input').value = '';
        document.getElementById('btn-modal-delete-product')?.classList.add('hidden');
        document.getElementById('btn-footer-delete-product')?.classList.add('hidden');
    }
    document.getElementById('prod-name-ar').value = '';
    document.getElementById('prod-name-en').value = '';
    if (document.getElementById('prod-scientific-name')) document.getElementById('prod-scientific-name').value = '';
    if (document.getElementById('prod-company')) document.getElementById('prod-company').value = '';
    document.getElementById('prod-category').value = '';
    document.getElementById('prod-tax-rate').value = '0';
    document.getElementById('prod-selling-price').value = '';
    if (document.getElementById('prod-wholesale-price')) document.getElementById('prod-wholesale-price').value = '';
    document.getElementById('prod-unit-price').value = '';
    document.getElementById('prod-unit').value = 'علبة';
    document.getElementById('prod-unit-divisions').value = '';
    
    const pBar = document.getElementById('prod-primary-barcode');
    const pGtin = document.getElementById('prod-primary-gtin');
    if (pBar) pBar.value = '';
    if (pGtin) pGtin.value = '';

    const eb = document.getElementById('extra-barcodes-container');
    const eg = document.getElementById('extra-gtins-container');
    if (eb) eb.innerHTML = '';
    if (eg) eg.innerHTML = '';
    cancelGs1Inspector();
}"""

    if "function clearProductCardInputs" not in js:
        js = js.replace("function openCreateProductModal", clear_func + "\n\nfunction openCreateProductModal")

    # تحديث openEditProductModal لتعيين activeEditingProductCode وإظهار أزرار الحذف
    js = js.replace(
        "function openEditProductModal(p) {",
        """function openEditProductModal(p) {
    activeEditingProductCode = p.code;
    document.getElementById('btn-modal-delete-product')?.classList.remove('hidden');
    document.getElementById('btn-footer-delete-product')?.classList.remove('hidden');"""
    )

    # تحديث openCreateProductModal لإخفاء أزرار الحذف
    js = js.replace(
        "async function openCreateProductModal(prefillGtin = null, initialData = {}) {",
        """async function openCreateProductModal(prefillGtin = null, initialData = {}) {
    activeEditingProductCode = initialData.code || null;
    if (activeEditingProductCode) {
        document.getElementById('btn-modal-delete-product')?.classList.remove('hidden');
        document.getElementById('btn-footer-delete-product')?.classList.remove('hidden');
    } else {
        document.getElementById('btn-modal-delete-product')?.classList.add('hidden');
        document.getElementById('btn-footer-delete-product')?.classList.add('hidden');
    }"""
    )

    with open(APP_PATH, "w", encoding="utf-8") as f:
        f.write(js)
    print("[OK] frontend/app.js updated successfully")

if __name__ == '__main__':
    update_index_html()
    update_app_js()
