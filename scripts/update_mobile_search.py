# -*- coding: utf-8 -*-
with open('frontend/mobile.html', 'r', encoding='utf-8') as f:
    c = f.read()

# 1. إضافة مفتاح النقطة في mobile.html
old_input = '''            <div class="relative">
                <input type="text" id="catalog-search-input" placeholder="🔍 ابحث في دليل أصناف المحل بالاسم أو الكود..."
                       class="w-full py-2 pr-9 pl-3 rounded-xl bg-slate-900 border border-slate-700 text-white text-xs placeholder-slate-500 focus:outline-none focus:border-indigo-500">
                <span class="absolute right-3 top-2.5 text-xs text-slate-400">🔍</span>
            </div>'''

new_input = '''            <div class="relative flex items-center">
                <input type="text" id="catalog-search-input" placeholder="🔍 ابحث بالبداية (انقر النقطة للتعميم)..."
                       class="w-full py-2 pr-9 pl-9 rounded-xl bg-slate-900 border border-slate-700 text-white text-xs placeholder-slate-500 focus:outline-none focus:border-indigo-500">
                <span class="absolute right-3 top-2.5 text-xs text-slate-400">🔍</span>
                <button type="button" id="btn-mobile-toggle-search-mode" class="absolute left-2.5 top-1/2 -translate-y-1/2 w-6 h-6 rounded-full flex items-center justify-center focus:outline-none cursor-pointer" title="وضع البحث: البداية فقط (انقر للتعميم)">
                    <span id="search-mode-dot-mobile" class="w-2.5 h-2.5 rounded-full bg-slate-500 border border-slate-600 transition-all duration-200"></span>
                </button>
            </div>'''

assert old_input in c, 'old_input not found in mobile.html'
c = c.replace(old_input, new_input, 1)

# 2. إضافة منطق النقطة وتمرير mode
old_script = 'let catalogSearchTimer = null;'
new_script = '''let isMobileGeneralizedSearch = localStorage.getItem('catalog_search_mode') === 'contains';

        function updateMobileSearchModeUI() {
            const dot = document.getElementById('search-mode-dot-mobile');
            const inp = document.getElementById('catalog-search-input');
            const btn = document.getElementById('btn-mobile-toggle-search-mode');
            if (!dot) return;
            if (isMobileGeneralizedSearch) {
                dot.className = 'w-3 h-3 rounded-full bg-emerald-500 border border-emerald-400 ring-2 ring-emerald-500/40 animate-pulse';
                if (btn) btn.title = 'البحث المعمم مفعّل (في أي مكان بالاسم أو الكود)';
                if (inp) inp.placeholder = '🔍 ابحث في أي موضع (البحث المعمم مفعّل)...';
            } else {
                dot.className = 'w-2.5 h-2.5 rounded-full bg-slate-500 border border-slate-600';
                if (btn) btn.title = 'البحث الافتراضي: يبدأ بـ (انقر للتعميم)';
                if (inp) inp.placeholder = '🔍 ابحث بالبداية (انقر النقطة للتعميم)...';
            }
        }

        updateMobileSearchModeUI();
        document.getElementById('btn-mobile-toggle-search-mode')?.addEventListener('click', () => {
            isMobileGeneralizedSearch = !isMobileGeneralizedSearch;
            localStorage.setItem('catalog_search_mode', isMobileGeneralizedSearch ? 'contains' : 'start');
            updateMobileSearchModeUI();
            const q = document.getElementById('catalog-search-input')?.value.trim();
            if (q && q.length >= 2) {
                document.getElementById('catalog-search-input').dispatchEvent(new Event('input'));
            }
        });

        let catalogSearchTimer = null;'''

assert old_script in c, 'old_script not found in mobile.html'
c = c.replace(old_script, new_script, 1)

# 3. تمرير mode في الطلب
c = c.replace(
    '`/api/catalog/products?q=${encodeURIComponent(query)}&limit=30`',
    '`/api/catalog/products?q=${encodeURIComponent(query)}&mode=${isMobileGeneralizedSearch ? "contains" : "start"}&limit=30`'
)

with open('frontend/mobile.html', 'w', encoding='utf-8') as f:
    f.write(c)

print('frontend/mobile.html updated successfully!')
