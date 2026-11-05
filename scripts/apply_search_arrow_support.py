import sys
import re

sys.stdout.reconfigure(encoding='utf-8')

def main():
    print("Reading frontend/app.js...")
    with open('frontend/app.js', 'r', encoding='utf-8') as f:
        app_js = f.read()

    # 1. Update scanInput listeners in initStocktakeTab
    old_scan_block = """    // 3. مسح الباركود والداتا ماتريكس بالاسكانر
    scanInput?.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            let raw = scanInput.value.trim();
            if (!raw) return;

            if (typeof decodeArabicKeyboard === 'function') {
                raw = decodeArabicKeyboard(raw);
            }

            scanInput.value = '';
            await processStoreScan(raw);
            scanInput.focus();
        }
    });"""

    new_scan_block = """    // 3. مسح أو بحث الصنف برقم الكود أو الباركود (يدعم مفتاح السهم / Enter في الموبايل والكمبيوتر)
    const handleScanExecute = async () => {
        let raw = scanInput?.value?.trim() || '';
        if (!raw) return;

        if (typeof decodeArabicKeyboard === 'function') {
            raw = decodeArabicKeyboard(raw);
        }

        scanInput.value = '';
        await processStoreScan(raw);
        scanInput.focus();
    };

    scanInput?.addEventListener('keydown', async (e) => {
        const isEnterOrArrow = (e.key === 'Enter' || e.keyCode === 13 || e.which === 13 ||
                                e.key === 'Go' || e.key === 'Search' || e.key === 'Next' ||
                                e.code === 'Enter' || e.code === 'NumpadEnter');
        if (isEnterOrArrow) {
            e.preventDefault();
            e.stopPropagation();
            await handleScanExecute();
        }
    });

    scanInput?.addEventListener('beforeinput', async (e) => {
        if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
            e.preventDefault();
            e.stopPropagation();
            await handleScanExecute();
        }
    });

    document.getElementById('stk-scan-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await handleScanExecute();
        return false;
    });"""

    if old_scan_block in app_js:
        app_js = app_js.replace(old_scan_block, new_scan_block, 1)
        print("Replaced scanInput keydown handler successfully!")
    else:
        print("Warning: old_scan_block exact match not found, looking for partial...")
        p = app_js.find("// 3. مسح الباركود والداتا ماتريكس بالاسكانر")
        p_end = app_js.find("document.getElementById('btn-close-batch-entry-card')", p)
        if p != -1 and p_end != -1:
            app_js = app_js[:p] + new_scan_block + "\n\n    " + app_js[p_end:]
            print("Replaced scanInput keydown handler via slice!")
        else:
            print("ERROR: Could not locate scanInput section")
            sys.exit(1)

    # 2. Update itemsSearch in initStocktakeTab
    old_items_search_block = """    // 4. البحث في الأصناف المجرودة داخل الاستور المختار
    itemsSearch?.addEventListener('input', () => {
        clearTimeout(stockItemsSearchTimer);
        stockItemsSearchTimer = setTimeout(() => {
            loadCurrentStoreItems(itemsSearch.value.trim());
        }, 200);
    });"""

    new_items_search_block = """    // 4. البحث في الأصناف المجرودة داخل الاستور المختار (يدعم مفتاح السهم / Enter في الموبايل والكمبيوتر)
    const handleItemsSearchExecute = () => {
        clearTimeout(stockItemsSearchTimer);
        const q = itemsSearch?.value?.trim() || '';
        loadCurrentStoreItems(q);
    };

    itemsSearch?.addEventListener('input', () => {
        clearTimeout(stockItemsSearchTimer);
        stockItemsSearchTimer = setTimeout(() => {
            loadCurrentStoreItems(itemsSearch.value.trim());
        }, 200);
    });

    itemsSearch?.addEventListener('keydown', (e) => {
        const isEnterOrArrow = (e.key === 'Enter' || e.keyCode === 13 || e.which === 13 ||
                                e.key === 'Go' || e.key === 'Search' || e.key === 'Next' ||
                                e.code === 'Enter' || e.code === 'NumpadEnter');
        if (isEnterOrArrow) {
            e.preventDefault();
            e.stopPropagation();
            handleItemsSearchExecute();
            itemsSearch.blur();
        }
    });

    itemsSearch?.addEventListener('beforeinput', (e) => {
        if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
            e.preventDefault();
            e.stopPropagation();
            handleItemsSearchExecute();
            itemsSearch.blur();
        }
    });"""

    if old_items_search_block in app_js:
        app_js = app_js.replace(old_items_search_block, new_items_search_block, 1)
        print("Replaced itemsSearch handlers successfully!")
    else:
        print("Warning: old_items_search_block exact match not found, looking for slice...")
        p = app_js.find("// 4. البحث في الأصناف المجرودة داخل الاستور المختار")
        p_end = app_js.find("// 5. رفع رصيد المخزون للاستور النشط", p)
        if p != -1 and p_end != -1:
            app_js = app_js[:p] + new_items_search_block + "\n\n    " + app_js[p_end:]
            print("Replaced itemsSearch handlers via slice!")

    # 3. Update catalog-search-input keydown handler
    old_cat_enter = """        } else if (e.key === 'Enter') {
            e.preventDefault();"""
    new_cat_enter = """        } else if (e.key === 'Enter' || e.keyCode === 13 || e.which === 13 || e.key === 'Go' || e.key === 'Search' || e.key === 'Next') {
            e.preventDefault();"""
    if old_cat_enter in app_js:
        app_js = app_js.replace(old_cat_enter, new_cat_enter, 1)
        print("Updated catalog search Enter/Arrow handler!")

    with open('frontend/app.js', 'w', encoding='utf-8') as f:
        f.write(app_js)

    print("Updated frontend/app.js successfully!")

    # 4. Update frontend/index.html
    print("Reading frontend/index.html...")
    with open('frontend/index.html', 'r', encoding='utf-8') as f:
        html = f.read()

    # Wrap stk-scan-input in form and add enterkeyhint="search"
    old_div_scan = """                            <div class="relative flex-1">
                                <input type="text" id="stk-scan-input" dir="ltr"
                                       placeholder="امسح كود QR / GS1 DataMatrix أو الباركود هنا (السحب يزيد الكمية +1 تلقائياً مع احتساب التكلفة)..."
                                       class="w-full pl-10 pr-4 py-2.5 bg-slate-50 border-2 border-indigo-500 rounded-xl text-sm font-mono focus:bg-white focus:border-indigo-700 focus:outline-none transition shadow-inner">
                                <span class="absolute left-3.5 top-3 text-slate-400">🔍</span>
                            </div>"""

    new_form_scan = """                            <form id="stk-scan-form" onsubmit="return false;" autocomplete="off" class="relative flex-1">
                                <input type="text" id="stk-scan-input" dir="ltr"
                                       enterkeyhint="search"
                                       placeholder="امسح كود QR / GS1 DataMatrix أو الباركود هنا (السحب يزيد الكمية +1 تلقائياً مع احتساب التكلفة)..."
                                       class="w-full pl-10 pr-4 py-2.5 bg-slate-50 border-2 border-indigo-500 rounded-xl text-sm font-mono focus:bg-white focus:border-indigo-700 focus:outline-none transition shadow-inner">
                                <span class="absolute left-3.5 top-3 text-slate-400 pointer-events-none">🔍</span>
                            </form>"""

    if old_div_scan in html:
        html = html.replace(old_div_scan, new_form_scan, 1)
        print("Updated stk-scan-input with form and enterkeyhint in index.html")
    else:
        # Fallback regex replace for stk-scan-input
        html = re.sub(
            r'<div class="relative flex-1">\s*<input type="text" id="stk-scan-input"[^>]+>\s*<span[^>]+>🔍</span>\s*</div>',
            new_form_scan,
            html,
            count=1
        )
        print("Applied regex replace for stk-scan-input")

    # Add enterkeyhint="search" to stk-items-search-filter
    if 'id="stk-items-search-filter"' in html and 'enterkeyhint' not in html[html.find('id="stk-items-search-filter"'):html.find('id="stk-items-search-filter"')+150]:
        html = html.replace('id="stk-items-search-filter"', 'id="stk-items-search-filter" enterkeyhint="search"', 1)
        print("Added enterkeyhint='search' to stk-items-search-filter")

    # Add enterkeyhint="search" to catalog-search-input
    if 'id="catalog-search-input"' in html and 'enterkeyhint' not in html[html.find('id="catalog-search-input"'):html.find('id="catalog-search-input"')+150]:
        html = html.replace('id="catalog-search-input"', 'id="catalog-search-input" enterkeyhint="search"', 1)
        print("Added enterkeyhint='search' to catalog-search-input")

    # Bump cache buster
    html = re.sub(r'app\.js\?v=[^\"]+', 'app.js?v=20261105_search_arrow_v10', html)
    html = re.sub(r'style\.css\?v=[^\"]+', 'style.css?v=20261105_search_arrow_v10', html)

    with open('frontend/index.html', 'w', encoding='utf-8') as f:
        f.write(html)

    print("Updated frontend/index.html successfully with cache buster v10!")

if __name__ == '__main__':
    main()
