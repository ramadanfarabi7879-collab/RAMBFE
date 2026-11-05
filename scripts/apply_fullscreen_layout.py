import re
import sys

def apply_fullscreen():
    # 1. Update frontend/index.html
    html_path = 'frontend/index.html'
    with open(html_path, 'r', encoding='utf-8') as f:
        html = f.read()

    # Replace header max-w-7xl
    html = html.replace(
        '<div class="max-w-7xl mx-auto px-3 sm:px-4 py-2 flex justify-between items-center gap-2">',
        '<div class="w-full px-2 sm:px-4 lg:px-6 xl:px-8 py-2 flex justify-between items-center gap-2">'
    )

    # Insert fullscreen toggle button before header-sync-pill if not already present
    if 'id="btn-toggle-fullscreen"' not in html:
        old_pill = '<div id="header-sync-pill"'
        new_btn = '''<!-- زر ملء الشاشة للكمبيوتر واللابتوب -->
                <button type="button" id="btn-toggle-fullscreen" class="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-bold transition shadow-sm" title="تبديل وضع ملء الشاشة (F11)">
                    <span class="text-sm">⛶</span>
                    <span class="hidden md:inline">ملء الشاشة</span>
                </button>
                <div id="header-sync-pill"'''
        html = html.replace(old_pill, new_btn)

    # Replace main max-w-7xl
    html = html.replace(
        '<main class="w-full max-w-7xl mx-auto px-2 sm:px-4 py-2 flex-1 pb-24 lg:pb-6">',
        '<main class="w-full px-2 sm:px-4 lg:px-6 xl:px-8 py-2 flex-1 pb-24 lg:pb-6">'
    )

    # Update stocktake table container height from max-h-96
    html = html.replace(
        '<div class="overflow-x-auto max-h-96 overflow-y-auto border border-slate-300 rounded-lg">',
        '<div class="overflow-x-auto max-h-[500px] lg:max-h-[68vh] xl:max-h-[75vh] overflow-y-auto border border-slate-300 rounded-lg">'
    )

    # Bump cache buster
    html = re.sub(r'style\.css\?v=[^"\'\s]+', 'style.css?v=20261105_fullscreen_desktop_v19', html)
    html = re.sub(r'app\.js\?v=[^"\'\s]+', 'app.js?v=20261105_fullscreen_desktop_v19', html)

    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print("Updated frontend/index.html successfully.")

    # 2. Update frontend/app.js
    app_path = 'frontend/app.js'
    with open(app_path, 'r', encoding='utf-8') as f:
        app_js = f.read()

    if 'btn-toggle-fullscreen' not in app_js:
        target_nav = "    // زر المسح السريع بكاميرا الهاتف"
        fullscreen_code = '''    // زر ملء الشاشة للكمبيوتر واللابتوب (Toggle Fullscreen)
    const btnFullscreen = document.getElementById('btn-toggle-fullscreen');
    if (btnFullscreen) {
        btnFullscreen.addEventListener('click', () => {
            if (!document.fullscreenElement && !document.webkitFullscreenElement) {
                if (document.documentElement.requestFullscreen) {
                    document.documentElement.requestFullscreen().catch(() => {});
                } else if (document.documentElement.webkitRequestFullscreen) {
                    document.documentElement.webkitRequestFullscreen();
                }
            } else {
                if (document.exitFullscreen) {
                    document.exitFullscreen().catch(() => {});
                } else if (document.webkitExitFullscreen) {
                    document.webkitExitFullscreen();
                }
            }
        });

        const updateFullscreenBtn = () => {
            const isFull = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
            btnFullscreen.innerHTML = isFull
                ? '<span class="text-sm">🗗</span><span class="hidden md:inline">تصغير الشاشة</span>'
                : '<span class="text-sm">⛶</span><span class="hidden md:inline">ملء الشاشة</span>';
            btnFullscreen.setAttribute('title', isFull ? 'الخروج من وضع ملء الشاشة (Esc)' : 'تبديل وضع ملء الشاشة (F11)');
        };

        document.addEventListener('fullscreenchange', updateFullscreenBtn);
        document.addEventListener('webkitfullscreenchange', updateFullscreenBtn);
    }

    // زر المسح السريع بكاميرا الهاتف'''
        app_js = app_js.replace(target_nav, fullscreen_code)

        with open(app_path, 'w', encoding='utf-8') as f:
            f.write(app_js)
        print("Updated frontend/app.js successfully.")
    else:
        print("btn-toggle-fullscreen already in app.js.")

if __name__ == '__main__':
    apply_fullscreen()
