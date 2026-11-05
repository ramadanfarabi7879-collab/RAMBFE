import sys
import re

sys.stdout.reconfigure(encoding='utf-8')

def main():
    print("Reading frontend/app.js...")
    with open('frontend/app.js', 'r', encoding='utf-8') as f:
        app_js = f.read()

    # 1. Add isCameraScanSuspended declaration if not present
    if 'let isCameraScanSuspended = false;' not in app_js:
        app_js = app_js.replace("let isProcessingFrame = false;", "let isProcessingFrame = false;\nlet isCameraScanSuspended = false;", 1)
        print("Added isCameraScanSuspended declaration")

    # 2. Update scanFrame in applyContinuousFocusAndNativeLoop
    old_scan_frame_check = """                const scanFrame = async () => {
                    if (!isNativeScanning || !videoElem || videoElem.paused || videoElem.ended) return;
                    if (!isProcessingFrame && videoElem.readyState >= 2) {"""

    new_scan_frame_check = """                const scanFrame = async () => {
                    if (!isNativeScanning || !videoElem || videoElem.paused || videoElem.ended) return;
                    if (isCameraScanSuspended) {
                        if ('requestVideoFrameCallback' in videoElem) {
                            videoElem.requestVideoFrameCallback(scanFrame);
                        } else {
                            nativeDetectorAnimFrame = requestAnimationFrame(scanFrame);
                        }
                        return;
                    }
                    if (!isProcessingFrame && videoElem.readyState >= 2) {"""

    if old_scan_frame_check in app_js:
        app_js = app_js.replace(old_scan_frame_check, new_scan_frame_check, 1)
        print("Updated scanFrame with isCameraScanSuspended guard")

    # 3. Update handleCameraDecodedText to check isCameraScanSuspended and avoid stopCamera() on requires_batch_entry
    old_handle_start = """async function handleCameraDecodedText(decodedText) {
    const raw = String(decodedText || '').trim();
    if (!raw) return;"""

    new_handle_start = """async function handleCameraDecodedText(decodedText) {
    if (isCameraScanSuspended) return;
    const raw = String(decodedText || '').trim();
    if (!raw) return;"""

    if old_handle_start in app_js:
        app_js = app_js.replace(old_handle_start, new_handle_start, 1)
        print("Added isCameraScanSuspended check to handleCameraDecodedText")

    # Replace stopCamera on requires_batch_entry
    old_req_batch = """                if (data.requires_batch_entry) {
                    // للأصناف ذات الباركود الدولي 1D: إيقاف الكاميرا مؤقتاً وفتح شاشة إدخال الكمية يدوياً كما بالكمبيوتر
                    wasCameraActiveBeforeBatch = true;
                    stopCamera();
                    document.getElementById('modal-camera-scanner')?.classList.add('hidden');
                    openBatchEntryCard(data, 'camera');
                }"""

    new_req_batch = """                if (data.requires_batch_entry) {
                    // للأصناف ذات الباركود الدولي 1D: تعليق المعالجة وإخفاء النافذة مع إبقاء الكاميرا نشطة ودافئة بالخلفية لاستئناف فوري
                    isCameraScanSuspended = true;
                    wasCameraActiveBeforeBatch = true;
                    document.getElementById('modal-camera-scanner')?.classList.add('hidden');
                    openBatchEntryCard(data, 'camera');
                    return;
                }"""

    if old_req_batch in app_js:
        app_js = app_js.replace(old_req_batch, new_req_batch, 1)
        print("Replaced stopCamera with warm suspend in handleCameraDecodedText")
    else:
        # Check partial
        p = app_js.find("requires_batch_entry")
        if p != -1 and "stopCamera();" in app_js[p:p+300]:
            chunk = app_js[p:p+300]
            chunk_new = chunk.replace("stopCamera();\n", "isCameraScanSuspended = true;\n")
            app_js = app_js[:p] + chunk_new + app_js[p+300:]
            print("Replaced stopCamera in requires_batch_entry slice")

    # 4. Update closeBatchEntryCard for instant warm resume
    old_close_batch = """    if (shouldOpenMobileCamera) {
        // خاص بالموبايل فقط
        setTimeout(() => {
            openCameraModal('stocktake');
        }, 120);
    } else {
        // خاص بالكمبيوتر: إرجاع التركيز فوراً لخانة مسح الباركود لاستقبال الصنف التالي بالسكانر
        if (scanInput) {
            scanInput.focus();
            scanInput.select();
        }
    }"""

    new_close_batch = """    if (shouldOpenMobileCamera) {
        // خاص بالموبايل فقط: استئناف فوري لحظي للكاميرا بدون أي ثواني انتظار (Instant Resume)
        const modal = document.getElementById('modal-camera-scanner');
        modal?.classList.remove('hidden');

        // تصفير آخر كود لضمان المسح اللحظي للعبوة التالية فوراً
        cameraLastScanCode = '';
        cameraLastScanTime = 0;

        if (html5QrScannerInstance) {
            isCameraScanSuspended = false;
            const video = document.querySelector('#camera-reader-viewport video');
            if (video && video.paused) {
                video.play().catch(() => {});
            }
        } else {
            isCameraScanSuspended = false;
            openCameraModal('stocktake');
        }
    } else {
        // على الكمبيوتر (أو عند إلغاء كارت الباتشات): إيقاف الكاميرا إن كانت معلقة وإرجاع الفوكس لخانة الباركود
        if (!shouldOpenMobileCamera && html5QrScannerInstance && isCameraScanSuspended) {
            stopCamera();
        }
        isCameraScanSuspended = false;
        if (scanInput) {
            scanInput.focus();
            scanInput.select();
        }
    }"""

    if old_close_batch in app_js:
        app_js = app_js.replace(old_close_batch, new_close_batch, 1)
        print("Updated closeBatchEntryCard with instant warm camera resume!")
    else:
        print("Warning: old_close_batch exact match not found, looking for slice...")
        p = app_js.find("if (shouldOpenMobileCamera)")
        p_end = app_js.find("}\n}\n\n// مسح صنف للاستور المختار", p)
        if p != -1 and p_end != -1:
            app_js = app_js[:p] + new_close_batch + app_js[p_end+1:]
            print("Updated closeBatchEntryCard via slice!")

    with open('frontend/app.js', 'w', encoding='utf-8') as f:
        f.write(app_js)

    print("Updated frontend/app.js successfully!")

    # 5. Bump cache buster in frontend/index.html
    print("Reading frontend/index.html...")
    with open('frontend/index.html', 'r', encoding='utf-8') as f:
        html = f.read()

    html = re.sub(r'app\.js\?v=[^\"]+', 'app.js?v=20261105_warm_camera_v12', html)
    html = re.sub(r'style\.css\?v=[^\"]+', 'style.css?v=20261105_warm_camera_v12', html)

    with open('frontend/index.html', 'w', encoding='utf-8') as f:
        f.write(html)

    print("Updated frontend/index.html with version v12!")

if __name__ == '__main__':
    main()
