#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
إصلاح مشكلة الاسكان على أجهزة آيفون (iOS / Safari) وشاشات الكمبيوتر والموبايل بشكل جذري.
Fixes camera barcode and DataMatrix scanning on iPhone (iOS / Safari) and mobile.
"""

import os
import re

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_PATH = os.path.join(BASE_DIR, "frontend", "index.html")
MOBILE_PATH = os.path.join(BASE_DIR, "frontend", "mobile.html")
APP_PATH = os.path.join(BASE_DIR, "frontend", "app.js")

POLYFILL_TAG = '<script src="https://cdn.jsdelivr.net/npm/barcode-detector@3.2.3/dist/iife/polyfill.min.js"></script>'

def fix_index_html():
    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        content = f.read()

    if "barcode-detector@3.2.3" not in content:
        content = content.replace(
            '<script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>',
            f'{POLYFILL_TAG}\n    <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>'
        )
        with open(INDEX_PATH, "w", encoding="utf-8") as f:
            f.write(content)
        print("[✓] Added BarcodeDetector polyfill to frontend/index.html")
    else:
        print("[*] BarcodeDetector polyfill already in frontend/index.html")

def fix_mobile_html():
    with open(MOBILE_PATH, "r", encoding="utf-8") as f:
        content = f.read()

    # 1. Add polyfill if missing
    if "barcode-detector@3.2.3" not in content:
        content = content.replace(
            '<script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>',
            f'{POLYFILL_TAG}\n    <script src="https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js"></script>'
        )

    # 2. Fix applyMobileFocusAndNativeLoop so it doesn't return on iOS
    old_ios_check = "const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);\n            if (isIOS) return;"
    if old_ios_check in content:
        new_ios_logic = """const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
            // على آيفون وباقي الأجهزة: نعتمد على BarcodeDetector (المدعوم بـ WASM polyfill أو العتاد)
            if (!('BarcodeDetector' in window)) return;"""
        content = content.replace(old_ios_check, new_ios_logic)

    # Also check if CRLF variant exists
    old_ios_check_crlf = "const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);\r\n            if (isIOS) return;"
    if old_ios_check_crlf in content:
        new_ios_logic_crlf = """const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);\r\n            // على آيفون وباقي الأجهزة: نعتمد على BarcodeDetector (المدعوم بـ WASM polyfill أو العتاد)\r\n            if (!('BarcodeDetector' in window)) return;"""
        content = content.replace(old_ios_check_crlf, new_ios_logic_crlf)

    # 3. Add throttling to mobile loop to keep iOS super fast without lag
    old_mobile_loop_body = """if (!isMobileNativeScanning || !videoElem || videoElem.paused || videoElem.ended) return;
                            try {
                                if (videoElem.readyState >= 2) {
                                    const codes = await detector.detect(videoElem);"""
    new_mobile_loop_body = """if (!isMobileNativeScanning || !videoElem || videoElem.paused || videoElem.ended) return;
                            const nowTs = performance.now();
                            if ((nowTs - (videoElem._lastMobileScanAt || 0)) < (isIOS ? 80 : 0)) {
                                if ('requestVideoFrameCallback' in videoElem) {
                                    videoElem.requestVideoFrameCallback(loop);
                                } else {
                                    mobileNativeAnimFrame = requestAnimationFrame(loop);
                                }
                                return;
                            }
                            videoElem._lastMobileScanAt = nowTs;
                            try {
                                if (videoElem.readyState >= 2) {
                                    const codes = await detector.detect(videoElem);"""
    if old_mobile_loop_body in content:
        content = content.replace(old_mobile_loop_body, new_mobile_loop_body)

    # 4. Fix cameraConstraints in mobile.html
    # In html5-qrcode, cameraIdOrConfig MUST have exactly 1 key ('facingMode' or 'deviceId')
    content = re.sub(
        r'const cameraConstraints = \{\s*facingMode: \{ ideal: \(currentFacingMode === \'user\' \? \'user\' : \'environment\'\) \},\s*width: \{ ideal: 1280 \},\s*height: \{ ideal: 720 \}\s*\};',
        """const cameraConstraints = { facingMode: (currentFacingMode === 'user' ? 'user' : 'environment') };
            const videoConstraints = {
                facingMode: (currentFacingMode === 'user' ? 'user' : 'environment'),
                width: { ideal: 1280 },
                height: { ideal: 720 }
            };""",
        content
    )

    # 5. Fix experimentalFeatures in mobile.html: use BarcodeDetector everywhere if available
    content = re.sub(
        r'useBarCodeDetectorIfSupported:\s*!isIOS',
        'useBarCodeDetectorIfSupported: true',
        content
    )

    with open(MOBILE_PATH, "w", encoding="utf-8") as f:
        f.write(content)
    print("[✓] Updated frontend/mobile.html for iOS iPhone scanning support")

def fix_app_js():
    with open(APP_PATH, "r", encoding="utf-8") as f:
        content = f.read()

    # 1. Fix isIOS return in applyContinuousFocusAndNativeLoop
    content = re.sub(
        r'// على أجهزة iOS Safari: نعتمد حصراً على محرك Html5Qrcode WASM/JS المستقر لتفادي مشاكل WebKit BarcodeDetector مع DataMatrix\s*if\s*\(isIOS\)\s*\{\s*return;\s*\}',
        """// تفعيل BarcodeDetector لجميع الأجهزة بما فيها آيفون عبر polyfill WASM المتطور
    if (!('BarcodeDetector' in window)) {
        return;
    }""",
        content
    )

    # 2. Add throttling for iOS in app.js
    content = re.sub(
        r'if\s*\(!isProcessingFrame && videoElem\.readyState >= 2\)\s*\{\s*isProcessingFrame = true;',
        """const nowTs = performance.now();
                    const minGap = isIOS ? 80 : 0;
                    if (!isProcessingFrame && videoElem.readyState >= 2 && (nowTs - (videoElem._lastAppScanAt || 0)) >= minGap) {
                        videoElem._lastAppScanAt = nowTs;
                        isProcessingFrame = true;""",
        content
    )

    # 3. Fix cameraConstraints in initHtml5ScannerInstance
    content = re.sub(
        r'const cameraConstraints = \{\s*facingMode: \{ ideal: \(cameraFacingMode === \'user\' \? \'user\' : \'environment\'\) \},\s*width: \{ min: 720, ideal: 1280, max: 1920 \},\s*height: \{ min: 720, ideal: 1080, max: 1920 \}\s*\};',
        """const cameraConstraints = { facingMode: (cameraFacingMode === 'user' ? 'user' : 'environment') };
    const videoConstraints = {
        facingMode: (cameraFacingMode === 'user' ? 'user' : 'environment'),
        width: { min: 720, ideal: 1280, max: 1920 },
        height: { min: 720, ideal: 1080, max: 1920 }
    };""",
        content
    )

    # 4. Enable BarcodeDetector on iOS in app.js
    content = re.sub(
        r'useBarCodeDetectorIfSupported:\s*!isIOS',
        'useBarCodeDetectorIfSupported: true',
        content
    )

    with open(APP_PATH, "w", encoding="utf-8") as f:
        f.write(content)
    print("[✓] Updated frontend/app.js for iOS iPhone scanning support")

if __name__ == '__main__':
    fix_index_html()
    fix_mobile_html()
    fix_app_js()
