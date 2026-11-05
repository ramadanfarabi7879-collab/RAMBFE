import sys
import re

sys.stdout.reconfigure(encoding='utf-8')

def main():
    # 1. Update frontend/style.css
    print("Reading frontend/style.css...")
    with open('frontend/style.css', 'r', encoding='utf-8') as f:
        css = f.read()

    old_reticle_css = """.tameni-reticle {
    position: relative;
    width: 350px;
    height: 350px;
    max-width: 92vw;
    max-height: 92vw;
    border-radius: 28px;
    box-shadow: 0 0 0 9999px rgba(2, 6, 23, 0.28);
    transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
.tameni-reticle.active-hit {
    box-shadow: 0 0 0 9999px rgba(16, 185, 129, 0.35), 0 0 45px #10b981;
    transform: scale(1.03);
}
.tameni-corner {
    position: absolute;
    width: 44px;
    height: 44px;
    border-color: #10b981;
    filter: drop-shadow(0 0 14px #10b981);
    transition: all 0.2s ease;
}
.tameni-corner.tr {
    top: -2px;
    right: -2px;
    border-top: 4px solid #34d399;
    border-right: 4px solid #34d399;
    border-top-right-radius: 18px;
}
.tameni-corner.tl {
    top: -2px;
    left: -2px;
    border-top: 4px solid #34d399;
    border-left: 4px solid #34d399;
    border-top-left-radius: 18px;
}
.tameni-corner.br {
    bottom: -2px;
    right: -2px;
    border-bottom: 4px solid #34d399;
    border-right: 4px solid #34d399;
    border-bottom-right-radius: 18px;
}
.tameni-corner.bl {
    bottom: -2px;
    left: -2px;
    border-bottom: 4px solid #34d399;
    border-left: 4px solid #34d399;
    border-bottom-left-radius: 18px;
}"""

    new_reticle_css = """.tameni-reticle {
    position: relative;
    width: min(88vw, 390px);
    height: min(88vw, 390px);
    border-radius: 26px;
    box-shadow: 0 0 0 9999px rgba(2, 6, 23, 0.42);
    transition: all 0.22s cubic-bezier(0.4, 0, 0.2, 1);
    display: flex;
    align-items: center;
    justify-content: center;
}
.tameni-reticle.active-hit {
    box-shadow: 0 0 0 9999px rgba(16, 185, 129, 0.5), 0 0 50px #10b981;
    transform: scale(1.025);
}
.tameni-corner {
    position: absolute;
    width: 48px;
    height: 48px;
    border-color: #10b981;
    filter: drop-shadow(0 0 12px rgba(16, 185, 129, 0.9));
    transition: all 0.2s ease;
}
.tameni-corner.tr {
    top: -2px;
    right: -2px;
    border-top: 5px solid #34d399;
    border-right: 5px solid #34d399;
    border-top-right-radius: 20px;
}
.tameni-corner.tl {
    top: -2px;
    left: -2px;
    border-top: 5px solid #34d399;
    border-left: 5px solid #34d399;
    border-top-left-radius: 20px;
}
.tameni-corner.br {
    bottom: -2px;
    right: -2px;
    border-bottom: 5px solid #34d399;
    border-right: 5px solid #34d399;
    border-bottom-right-radius: 20px;
}
.tameni-corner.bl {
    bottom: -2px;
    left: -2px;
    border-bottom: 5px solid #34d399;
    border-left: 5px solid #34d399;
    border-bottom-left-radius: 20px;
}

/* علامة بؤرة التركيز المركزية الشفافة الخفيفة */
.tameni-crosshair {
    position: absolute;
    width: 22px;
    height: 22px;
    pointer-events: none;
    opacity: 0.45;
}
.tameni-crosshair::before, .tameni-crosshair::after {
    content: '';
    position: absolute;
    background-color: #34d399;
    box-shadow: 0 0 6px #10b981;
    border-radius: 9999px;
}
.tameni-crosshair::before {
    top: 10px;
    left: 0;
    width: 22px;
    height: 2px;
}
.tameni-crosshair::after {
    top: 0;
    left: 10px;
    width: 2px;
    height: 22px;
}

#camera-reader-viewport video {
    width: 100% !important;
    height: 100% !important;
    object-fit: cover !important;
    border-radius: 1rem;
}"""

    if old_reticle_css in css:
        css = css.replace(old_reticle_css, new_reticle_css, 1)
        print("Updated .tameni-reticle styles in frontend/style.css")
    else:
        print("Warning: old_reticle_css exact match not found, looking for slice...")
        p = css.find('.tameni-reticle {')
        p_end = css.find('.tameni-badge {', p)
        if p != -1 and p_end != -1:
            css = css[:p] + new_reticle_css + "\n" + css[p_end:]
            print("Updated .tameni-reticle styles via slice!")

    with open('frontend/style.css', 'w', encoding='utf-8') as f:
        f.write(css)

    # 2. Update frontend/index.html
    print("Reading frontend/index.html...")
    with open('frontend/index.html', 'r', encoding='utf-8') as f:
        html = f.read()

    old_viewport_div = """            <!-- حاوية الكاميرا مع مربع المسح الثابت المضيء -->
            <div class="relative w-full aspect-video sm:aspect-square max-h-[52vh] bg-black rounded-2xl overflow-hidden shadow-2xl flex items-center justify-center cursor-pointer border border-slate-700" id="camera-viewport-touch-area" title="المس الشاشة لضبط التركيز التلقائي (Autofocus)">
                <div id="camera-reader-viewport" class="w-full h-full object-cover"></div>
                
                <!-- طبقة التعتيم والمربع التهديفي الثابت بأركان مضيئة بدون خط متحرك -->
                <div class="tameni-overlay-mask">
                    <div id="tameni-reticle-modal" class="tameni-reticle">
                        <!-- الأركان الأربعة المضيئة -->
                        <div class="tameni-corner tr"></div>
                        <div class="tameni-corner tl"></div>
                        <div class="tameni-corner br"></div>
                        <div class="tameni-corner bl"></div>
                        
                        <!-- إرشاد بسيط داخل المربع -->
                        <div class="absolute inset-0 flex items-center justify-center pointer-events-none p-4">
                            <span class="px-3 py-1.5 rounded-xl bg-slate-950/75 backdrop-blur-sm border border-emerald-400/30 text-emerald-300 font-bold text-xs shadow-lg text-center select-none">
                                « وجّه QR داخل الإطار للمسح »
                            </span>
                        </div>
                    </div>
                </div>"""

    new_viewport_div = """            <!-- حاوية الكاميرا مع مربع المسح الثابت المضيء الواسع والاحترافي -->
            <div class="relative w-full h-[62vh] max-h-[560px] aspect-[4/5] sm:aspect-square bg-black rounded-2xl overflow-hidden shadow-2xl flex items-center justify-center cursor-pointer border border-slate-700" id="camera-viewport-touch-area" title="المس الشاشة لضبط التركيز التلقائي (Autofocus)">
                <div id="camera-reader-viewport" class="w-full h-full object-cover"></div>
                
                <!-- طبقة التعتيم والمربع التهديفي الثابت بأركان مضيئة واسعة وبدون حجب للرؤية -->
                <div class="tameni-overlay-mask">
                    <div id="tameni-reticle-modal" class="tameni-reticle">
                        <!-- الأركان الأربعة المضيئة بتقنية النيون -->
                        <div class="tameni-corner tr"></div>
                        <div class="tameni-corner tl"></div>
                        <div class="tameni-corner br"></div>
                        <div class="tameni-corner bl"></div>

                        <!-- علامة التركيز المركزية الدقيقة -->
                        <div class="tameni-crosshair"></div>
                        
                        <!-- إرشاد واضح ومثبت في أسفل المربع دون حجب منتصف الكود -->
                        <div class="absolute bottom-3 inset-x-0 flex items-center justify-center pointer-events-none px-2">
                            <span class="px-3.5 py-1 rounded-full bg-slate-950/80 backdrop-blur-md border border-emerald-400/40 text-emerald-300 font-bold text-[11px] shadow-lg text-center select-none">
                                ⚡ وجّه الكود داخل الإطار للمسح الفوري
                            </span>
                        </div>
                    </div>
                </div>"""

    if old_viewport_div in html:
        html = html.replace(old_viewport_div, new_viewport_div, 1)
        print("Updated camera viewport container and reticle in index.html")
    else:
        print("Warning: old_viewport_div exact match not found, looking for slice...")
        p = html.find('id="camera-viewport-touch-area"')
        p_start = html.rfind('<!-- حاوية الكاميرا', 0, p)
        p_end = html.find('<!-- وميض السحب الناجح الأخضر', p)
        if p_start != -1 and p_end != -1:
            html = html[:p_start] + new_viewport_div + "\n\n" + html[p_end:]
            print("Updated camera viewport container via slice!")

    # Bump cache buster
    html = re.sub(r'app\.js\?v=[^\"]+', 'app.js?v=20261105_pro_scanner_v11', html)
    html = re.sub(r'style\.css\?v=[^\"]+', 'style.css?v=20261105_pro_scanner_v11', html)

    with open('frontend/index.html', 'w', encoding='utf-8') as f:
        f.write(html)

    # 3. Update frontend/app.js camera speed parameters
    print("Reading frontend/app.js...")
    with open('frontend/app.js', 'r', encoding='utf-8') as f:
        app_js = f.read()

    old_constraints = """    // قيود الكاميرا القياسية المتوافقة مع آيفون وأندرويد
    const cameraConstraints = {
        facingMode: { ideal: (cameraFacingMode === 'user' ? 'user' : 'environment') },
        width: { ideal: 1280 },
        height: { ideal: 720 }
    };

    // مسح فائق السرعة وبمساحة عريضة جداً تغطي كامل حساس الكاميرا (Full Frame بدون تقييد أو قص)
    const scanConfig = {
        fps: 25,
        aspectRatio: undefined,
        disableFlip: false
    };"""

    new_constraints = """    // قيود الكاميرا عالية الدقة وفائقة السرعة
    const cameraConstraints = {
        facingMode: { ideal: (cameraFacingMode === 'user' ? 'user' : 'environment') },
        width: { min: 720, ideal: 1280, max: 1920 },
        height: { min: 720, ideal: 1080, max: 1920 }
    };

    // مسح احترافي فائق السرعة (30 إطار/ثانية) بكامل مساحة الحساس (Full Sensor Frame)
    const scanConfig = {
        fps: 30,
        aspectRatio: undefined,
        disableFlip: false
    };"""

    if old_constraints in app_js:
        app_js = app_js.replace(old_constraints, new_constraints, 1)
        print("Updated scan constraints and FPS to 30 in app.js")

    # Add tap-to-focus on camera-viewport-touch-area if not present
    if 'camera-viewport-touch-area' not in app_js:
        tap_focus_code = """
    // النقر على شاشة الكاميرا لتفعيل الفوكس التلقائي الفوري (Tap to Focus)
    document.getElementById('camera-viewport-touch-area')?.addEventListener('click', async () => {
        const video = document.querySelector('#camera-reader-viewport video');
        if (video && video.srcObject) {
            const [track] = video.srcObject.getVideoTracks();
            if (track && track.applyConstraints) {
                try {
                    await track.applyConstraints({
                        advanced: [{ focusMode: 'continuous', exposureMode: 'continuous' }]
                    });
                } catch(e) {}
            }
        }
    });
"""
        p = app_js.find("function initCameraScannerModal()")
        if p != -1:
            p_brace = app_js.find("{", p)
            app_js = app_js[:p_brace+1] + tap_focus_code + app_js[p_brace+1:]
            print("Added tap-to-focus event listener to initCameraScannerModal in app.js")

    with open('frontend/app.js', 'w', encoding='utf-8') as f:
        f.write(app_js)

    print("Pro scanner enhancements successfully applied!")

if __name__ == '__main__':
    main()
