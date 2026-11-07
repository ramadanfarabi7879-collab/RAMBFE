# -*- coding: utf-8 -*-
import re

def update_index_html():
    with open('frontend/index.html', 'r', encoding='utf-8') as f:
        c = f.read()

    # 1. تحديث شريط البحث مع مفتاح النقطة الصغيرة
    search_target = re.compile(
        r'<div class="relative flex-1">\s*<input type="text" id="catalog-search-input"[^>]*>\s*<span[^>]*>🔍</span>\s*<!-- قائمة الاقتراحات التلقائية المنسدلة والتحديد المتعدد \(Multi-Select Autocomplete\) -->',
        re.DOTALL
    )

    search_replacement = '''<div class="relative flex-1 flex items-center">
                        <input type="text" id="catalog-search-input" enterkeyhint="search" autocomplete="off"
                               placeholder="اكتب بداية اسم الصنف أو الكود (البحث الافتراضي)..."
                               class="w-full px-4 py-2.5 pr-10 pl-9 text-xs bg-slate-50 border border-slate-300 rounded-xl focus:bg-white focus:border-indigo-600 focus:outline-none focus:ring-2 focus:ring-indigo-100">
                        <span class="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400">🔍</span>
                        
                        <!-- مفتاح النقطة الصغيرة للتبديل بين البحث في البداية والبحث المعمم -->
                        <button type="button" id="btn-toggle-search-mode"
                                class="absolute left-2.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full flex items-center justify-center transition-all duration-200 focus:outline-none cursor-pointer hover:bg-slate-200/70"
                                title="وضع البحث: البداية فقط (انقر لتفعيل البحث المعمم في أي موضع)">
                            <span id="search-mode-dot" class="w-2.5 h-2.5 rounded-full bg-slate-300 border border-slate-400 transition-all duration-200"></span>
                        </button>

                        <!-- قائمة الاقتراحات التلقائية المنسدلة والتحديد المتعدد (Multi-Select Autocomplete) -->'''

    c, count1 = search_target.subn(search_replacement, c, count=1)
    print("search_input replaced:", count1)

    # 2. خانة الضريبة في مودال الصنف
    tax_target = re.compile(
        r'<div class="space-y-1">\s*<label class="block text-xs font-bold text-slate-700">نسبة الضريبة \(%\) <span class="text-slate-400 font-normal">\(البديهي 0 - إدخال يدوي\)</span></label>\s*<input type="number" step="0\.01" id="prod-tax-rate"[^>]*>\s*</div>',
        re.DOTALL
    )

    tax_replacement = '''<div class="space-y-1.5">
                    <div class="flex items-center justify-between">
                        <label class="block text-xs font-bold text-slate-700">الضريبة (%)</label>
                        <label class="inline-flex items-center gap-1.5 cursor-pointer select-none">
                            <input type="checkbox" id="prod-is-taxable" class="rounded text-indigo-600 focus:ring-indigo-500 w-3.5 h-3.5">
                            <span class="text-[11px] font-bold text-indigo-700">خاضع للضريبة (VAT)</span>
                        </label>
                    </div>
                    <div class="relative">
                        <input type="number" step="0.01" id="prod-tax-rate" value="0" placeholder="0"
                               class="w-full text-xs p-2.5 pr-8 bg-slate-50 border border-slate-300 rounded-xl focus:bg-white focus:border-indigo-600 font-mono">
                        <span class="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400 font-bold text-xs">%</span>
                    </div>
                </div>'''

    c, count2 = tax_target.subn(tax_replacement, c, count=1)
    print("tax_field replaced:", count2)

    # 3. ترويسة جدول الأصناف
    table_head_target = '<th class="w-14 text-center font-mono">TAX<br><span class="text-[9px] text-slate-500 font-normal">الضريبة</span></th>'
    table_head_replacement = '<th class="w-16 text-center font-mono">TAX (VAT)<br><span class="text-[9px] text-slate-500 font-normal">الضريبة</span></th>'
    if table_head_target in c:
        c = c.replace(table_head_target, table_head_replacement, 1)
        print("table_head replaced: 1")

    # 4. تحديث رقم الإصدار
    c = re.sub(r'app\.js\?v=[a-zA-Z0-9_-]+', 'app.js?v=20261107_v28_tax_search', c)

    with open('frontend/index.html', 'w', encoding='utf-8') as f:
        f.write(c)
    print("index.html saved successfully")

if __name__ == '__main__':
    update_index_html()
