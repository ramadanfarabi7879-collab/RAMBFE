# -*- coding: utf-8 -*-
import re

def update_app_js():
    with open('frontend/app.js', 'r', encoding='utf-8') as f:
        c = f.read()

    # 1. إضافة متغير حالة البحث المعمم ودالة تحديث شكل النقطة
    search_state_code = '''let isGeneralizedSearch = localStorage.getItem('catalog_search_mode') === 'contains';

function updateSearchModeUI() {
    const btn = document.getElementById('btn-toggle-search-mode');
    const dot = document.getElementById('search-mode-dot');
    const input = document.getElementById('catalog-search-input');
    if (!dot) return;
    if (isGeneralizedSearch) {
        dot.className = 'w-3 h-3 rounded-full bg-emerald-500 border border-emerald-600 ring-4 ring-emerald-100 shadow-sm animate-pulse';
        if (btn) btn.title = 'وضع البحث المعمم مفعّل: يبحث في أي موضع بالاسم أو الكود (انقر للعودة للوضع الافتراضي)';
        if (input) input.placeholder = 'اكتب أي جزء من اسم الصنف أو الكود (البحث المعمم مفعّل)...';
    } else {
        dot.className = 'w-2.5 h-2.5 rounded-full bg-slate-300 border border-slate-400 hover:bg-slate-400';
        if (btn) btn.title = 'وضع البحث الافتراضي: يبحث عن بداية الاسم أو الكود فقط (انقر لتفعيل البحث المعمم في أي موضع)';
        if (input) input.placeholder = 'اكتب بداية اسم الصنف أو الكود (البحث الافتراضي)...';
    }
}
'''

    if 'let isGeneralizedSearch' not in c:
        # نضيفها قبل دالة initCatalogAutocomplete
        target_init_ac = 'function initCatalogAutocomplete() {'
        assert target_init_ac in c, 'initCatalogAutocomplete not found'
        c = c.replace(target_init_ac, search_state_code + '\n' + target_init_ac, 1)
        print("isGeneralizedSearch added: 1")

    # 2. تفعيل زر مفتاح النقطة في initCatalogAutocomplete
    dot_listener_code = '''    updateSearchModeUI();

    // مفتاح النقطة الصغيرة للتبديل بين البحث في البداية والبحث المعمم
    document.getElementById('btn-toggle-search-mode')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isGeneralizedSearch = !isGeneralizedSearch;
        localStorage.setItem('catalog_search_mode', isGeneralizedSearch ? 'contains' : 'start');
        updateSearchModeUI();
        showCatalogToast(isGeneralizedSearch ? '✓ تم تفعيل البحث المعمم (البحث في أي مكان بالاسم أو الكود)' : '✓ تم تفعيل البحث الافتراضي (البحث في بداية الاسم أو الكود فقط)');
        const q = searchInput.value.trim();
        if (q) {
            clearTimeout(catalogAutocompleteTimer);
            fetchAndRenderAutocomplete(q);
        }
        searchInput.focus();
    });
'''

    if 'btn-toggle-search-mode' not in c:
        target_after_dropdown = "if (!searchInput || !dropdown) return;"
        assert target_after_dropdown in c, 'target_after_dropdown not found'
        c = c.replace(target_after_dropdown, target_after_dropdown + '\n' + dot_listener_code, 1)
        print("btn-toggle-search-mode listener added: 1")

    # 3. تمرير mode في fetchAndRenderAutocomplete
    c = c.replace(
        '`/api/catalog/products?query=${encodeURIComponent(query)}&limit=25&offset=0`',
        '`/api/catalog/products?query=${encodeURIComponent(query)}&mode=${isGeneralizedSearch ? "contains" : "start"}&limit=25&offset=0`'
    )
    print("fetchAndRenderAutocomplete url updated")

    # 4. تمرير mode في appendSearchQueryToResults
    c = c.replace(
        '`/api/catalog/products?query=${encodeURIComponent(query)}&limit=50&offset=0`',
        '`/api/catalog/products?query=${encodeURIComponent(query)}&mode=${isGeneralizedSearch ? "contains" : "start"}&limit=50&offset=0`'
    )
    print("appendSearchQueryToResults url updated")

    # 5. تمرير mode في loadCatalogProducts
    c = c.replace(
        '`/api/catalog/products?query=${encodeURIComponent(query)}&limit=${catalogLimit}&offset=${catalogOffset}`',
        '`/api/catalog/products?query=${encodeURIComponent(query)}&mode=${isGeneralizedSearch ? "contains" : "start"}&limit=${catalogLimit}&offset=${catalogOffset}`'
    )
    print("loadCatalogProducts url updated")

    # 6. عرض الضريبة في جدول الأصناف كشارة (VAT 15% أو غير خاضع)
    tax_render_target = 'const taxRate = parseFloat(it.tax_rate || 0).toFixed(0);'
    tax_render_replacement = '''const taxRate = parseFloat(it.tax_rate || 0);
        const taxBadge = taxRate > 0 
            ? `<span class="px-1.5 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded text-[10px] font-bold inline-flex items-center gap-0.5" title="خاضع لضريبة القيمة المضافة ${taxRate}%"><span>VAT</span> <span>${taxRate.toFixed(0)}%</span></span>`
            : `<span class="px-1 py-0.5 bg-slate-100 text-slate-400 rounded text-[9.5px]" title="غير خاضع للضريبة (FALSE)">غير خاضع</span>`;'''
    if tax_render_target in c:
        c = c.replace(tax_render_target, tax_render_replacement, 1)
        c = c.replace('${taxRate}%', '${taxBadge}')
        print("table tax badge rendering updated")

    # 7. ربط خانة الضريبة في مودال الصنف مع المربع التفاعلي prod-is-taxable
    modal_sync_code = '''
    const chkTax = document.getElementById('prod-is-taxable');
    const inpTax = document.getElementById('prod-tax-rate');
    if (chkTax && inpTax && !chkTax.dataset.listenerAttached) {
        chkTax.dataset.listenerAttached = 'true';
        chkTax.addEventListener('change', () => {
            if (chkTax.checked) {
                const cur = parseFloat(inpTax.value || 0);
                inpTax.value = cur > 0 ? cur : '15';
            } else {
                inpTax.value = '0';
            }
        });
        inpTax.addEventListener('input', () => {
            chkTax.checked = (parseFloat(inpTax.value || 0) > 0);
        });
    }
'''
    # نربط المربع في resetProductModalForm و openCreateProductModal و openEditProductModal
    c = c.replace("document.getElementById('prod-tax-rate').value = '0';", "document.getElementById('prod-tax-rate').value = '0'; if (document.getElementById('prod-is-taxable')) document.getElementById('prod-is-taxable').checked = false;")
    c = c.replace(
        "document.getElementById('prod-tax-rate').value = initialData.tax_rate != null ? initialData.tax_rate : '0';",
        "const initTax = initialData.tax_rate != null ? initialData.tax_rate : '0'; document.getElementById('prod-tax-rate').value = initTax; if (document.getElementById('prod-is-taxable')) document.getElementById('prod-is-taxable').checked = (parseFloat(initTax || 0) > 0);"
    )
    c = c.replace(
        "document.getElementById('prod-tax-rate').value = p.tax_rate != null ? p.tax_rate : 0;",
        "const pTax = p.tax_rate != null ? p.tax_rate : 0; document.getElementById('prod-tax-rate').value = pTax; if (document.getElementById('prod-is-taxable')) document.getElementById('prod-is-taxable').checked = (parseFloat(pTax || 0) > 0);"
    )
    if 'chkTax.dataset.listenerAttached' not in c:
        target_card_init = "document.getElementById('btn-open-create-product-modal')?.addEventListener('click', () => openCreateProductModal());"
        assert target_card_init in c, 'target_card_init not found'
        c = c.replace(target_card_init, target_card_init + '\n' + modal_sync_code, 1)
        print("modal tax sync listeners added")

    # 8. ربط عمود CUSTOMER TAX في autoSuggestMapping
    auto_tax_target = "const taxCol = findBestHeader(['tax', 'vat', 'ضريبة', 'الضريبة']);"
    auto_tax_replacement = "const taxCol = findBestHeader(['customer tax', 'customer_tax', 'customer taxes', 'customer_taxes', 'customertax', 'customertaxes', 'tax rate', 'vat', 'tax', 'taxes', 'ضريبة', 'الضريبة']);"
    if auto_tax_target in c:
        c = c.replace(auto_tax_target, auto_tax_replacement, 1)
    
    # استبدال سطر مسح map-tax-rate بسطر تعيينه
    clear_tax_target = "// خانة الضريبة تكون البديهي 0% وعند الإضافة تكون منول يدوياً\n    if (document.getElementById('map-tax-rate')) document.getElementById('map-tax-rate').value = '';"
    set_tax_replacement = "// ربط عمود الضريبة تلقائياً إذا كان موجوداً بالملف (مثل CUSTOMER TAX)\n    if (taxCol && document.getElementById('map-tax-rate')) document.getElementById('map-tax-rate').value = taxCol;"
    if clear_tax_target in c:
        c = c.replace(clear_tax_target, set_tax_replacement, 1)
        print("autoSuggestMapping tax mapping updated")

    # 9. في showImportMappingStep(data)
    mapping_step_target = "document.getElementById('import-step-mapping')?.classList.remove('hidden');"
    mapping_step_replacement = """document.getElementById('import-step-mapping')?.classList.remove('hidden');
    if (data.suggested_mapping && data.suggested_mapping.tax_rate_col && document.getElementById('map-tax-rate')) {
        setTimeout(() => {
            const sel = document.getElementById('map-tax-rate');
            if (sel) sel.value = data.suggested_mapping.tax_rate_col;
        }, 50);
    }"""
    if mapping_step_target in c:
        c = c.replace(mapping_step_target, mapping_step_replacement, 1)
        print("showImportMappingStep suggested mapping applied")

    with open('frontend/app.js', 'w', encoding='utf-8') as f:
        f.write(c)
    print("frontend/app.js saved successfully")

if __name__ == '__main__':
    update_app_js()
