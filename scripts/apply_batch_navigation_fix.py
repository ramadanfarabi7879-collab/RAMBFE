import re
import sys

def apply_fix():
    # ==================== 1. Update frontend/app.js ====================
    app_path = 'frontend/app.js'
    with open(app_path, 'r', encoding='utf-8') as f:
        app_js = f.read()

    # Add let lastBatchStepTime = 0; if not present
    if 'let lastBatchStepTime = 0;' not in app_js:
        app_js = app_js.replace(
            "// دالة التنقل بين الباتشات بالسهم/Enter أو اعتماد الترحيل عند آخر باتش\nfunction moveToNextBatchOrCommit(currentIdx) {",
            "let lastBatchStepTime = 0;\n\n// دالة التنقل بين الباتشات بالسهم/Enter أو اعتماد الترحيل عند آخر باتش\nfunction moveToNextBatchOrCommit(currentIdx) {"
        )

    # Replace moveToNextBatchOrCommit implementation
    old_move_fn = """// دالة التنقل بين الباتشات بالسهم/Enter أو اعتماد الترحيل عند آخر باتش
function moveToNextBatchOrCommit(currentIdx) {
    const tbody = document.getElementById('stk-bec-batches-tbody');
    const allQtyInputs = Array.from(tbody?.querySelectorAll('.stk-bec-qty-input') || []);
    if (!allQtyInputs.length) return;

    // فحص إدخال الصلاحية للسطر الحالي إن وُجدت كمية > 0
    const currentRow = document.getElementById(`stk-bec-row-${currentIdx}`);
    const currentQtyInput = currentRow?.querySelector('.stk-bec-qty-input');
    const currentExpiryInput = currentRow?.querySelector('.stk-bec-expiry-input');
    const countedVal = parseQtyInput(currentQtyInput?.value || '0');

    if (countedVal > 0 && currentExpiryInput) {
        const expVal = normalizeExpiryDate(currentExpiryInput.value);
        currentExpiryInput.value = expVal;
        if (!expVal) {
            playStockAudioAlert(false);
            showCatalogToast('⚠️ يرجى إدخال تاريخ الصلاحية (الاكسبير) للصنف أولاً');
            currentExpiryInput.classList.add('border-rose-500', 'ring-2', 'ring-rose-500', 'bg-rose-50');
            currentExpiryInput.focus();
            currentExpiryInput.select();
            return;
        }
    }

    const isMobile = isMobileDeviceEnvironment();
    // على الموبايل: اعتماد وترحيل مباشر فور إدخال الكمية وضغط السهم دون القفز أو الرجوع لتاريخ الصلاحية
    if (isMobile || currentIdx >= allQtyInputs.length - 1) {
        commitAllCardBatches(allQtyInputs);
        return;
    }

    if (currentIdx < allQtyInputs.length - 1) {
        // انتقال مباشر للسطر التالي
        const nextIdx = currentIdx + 1;
        const nextRow = document.getElementById(`stk-bec-row-${nextIdx}`);
        const nextExpiryInput = nextRow?.querySelector('.stk-bec-expiry-input');
        const nextQtyInput = nextRow?.querySelector('.stk-bec-qty-input');

        // إذا كان السطر التالي يتطلب إدخال صلاحية وهو فارغ، نوجه الفوكس إليها أولاً
        const targetFocus = (nextExpiryInput && !nextExpiryInput.value.trim()) ? nextExpiryInput : nextQtyInput;

        if (targetFocus) {
            targetFocus.focus();
            targetFocus.select();
            targetFocus.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        // تمييز سطر الباتش النشط بصرياً باللون الأصفر
        allQtyInputs.forEach((inp, j) => {
            const r = document.getElementById(`stk-bec-row-${j}`);
            if (r) {
                if (j === nextIdx) {
                    r.classList.add('ring-2', 'ring-amber-500', 'bg-amber-100/70');
                } else {
                    r.classList.remove('ring-2', 'ring-amber-500', 'bg-amber-100/70');
                }
            }
        });
    } else {
        // عند آخر باتش (أو الصنف له باتش واحد فقط): الاعتماد والترحيل المباشر
        commitAllCardBatches(allQtyInputs);
    }
}"""

    new_move_fn = """// دالة التنقل بين الباتشات بالسهم/Enter أو اعتماد الترحيل عند آخر باتش
function moveToNextBatchOrCommit(currentIdx) {
    const now = Date.now();
    if (now - lastBatchStepTime < 300) return;
    lastBatchStepTime = now;

    const tbody = document.getElementById('stk-bec-batches-tbody');
    const allQtyInputs = Array.from(tbody?.querySelectorAll('.stk-bec-qty-input') || []);
    if (!allQtyInputs.length) return;

    // فحص إدخال الصلاحية للسطر الحالي إن وُجدت كمية > 0
    const currentRow = document.getElementById(`stk-bec-row-${currentIdx}`);
    const currentQtyInput = currentRow?.querySelector('.stk-bec-qty-input');
    const currentExpiryInput = currentRow?.querySelector('.stk-bec-expiry-input');
    const countedVal = parseQtyInput(currentQtyInput?.value || '0');

    if (countedVal > 0 && currentExpiryInput) {
        const expVal = normalizeExpiryDate(currentExpiryInput.value);
        currentExpiryInput.value = expVal;
        if (!expVal) {
            playStockAudioAlert(false);
            showCatalogToast('⚠️ يرجى إدخال تاريخ الصلاحية (الاكسبير) للصنف أولاً');
            currentExpiryInput.classList.add('border-rose-500', 'ring-2', 'ring-rose-500', 'bg-rose-50');
            currentExpiryInput.focus();
            currentExpiryInput.select();
            return;
        }
    }

    if (currentIdx < allQtyInputs.length - 1) {
        // انتقال مباشر للسطر التالي في خانة الكمية (أو الصلاحية إذا كانت مطلوبة وفارغة)
        const nextIdx = currentIdx + 1;
        const nextRow = document.getElementById(`stk-bec-row-${nextIdx}`);
        const nextExpiryInput = nextRow?.querySelector('.stk-bec-expiry-input');
        const nextQtyInput = nextRow?.querySelector('.stk-bec-qty-input');

        // إذا كان السطر التالي يتطلب إدخال صلاحية وهو فارغ، نوجه الفوكس إليها أولاً، وإلا إلى خانة الكمية مباشرة
        const targetFocus = (nextExpiryInput && (!nextExpiryInput.value.trim() || nextExpiryInput.value === '-')) ? nextExpiryInput : nextQtyInput;

        if (targetFocus) {
            targetFocus.focus();
            targetFocus.select();
            targetFocus.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        // تمييز سطر الباتش النشط بصرياً باللون الأصفر
        allQtyInputs.forEach((inp, j) => {
            const r = document.getElementById(`stk-bec-row-${j}`);
            if (r) {
                if (j === nextIdx) {
                    r.classList.add('ring-2', 'ring-amber-500', 'bg-amber-100/70');
                } else {
                    r.classList.remove('ring-2', 'ring-amber-500', 'bg-amber-100/70');
                }
            }
        });
    } else {
        // عند آخر باتش (أو الصنف له باتش واحد فقط): الاعتماد والترحيل المباشر
        commitAllCardBatches(allQtyInputs);
    }
}"""

    # Normalize line breaks for matching
    app_js_norm = app_js.replace('\r\n', '\n')
    old_move_fn_norm = old_move_fn.replace('\r\n', '\n')

    if old_move_fn_norm in app_js_norm:
        app_js_norm = app_js_norm.replace(old_move_fn_norm, new_move_fn)
        print("Updated moveToNextBatchOrCommit in app.js.")
    else:
        print("Warning: old_move_fn not matched exactly in app.js, checking regex...")
        # fallback regex
        app_js_norm = re.sub(
            r'// دالة التنقل بين الباتشات بالسهم/Enter أو اعتماد الترحيل عند آخر باتش\s+function moveToNextBatchOrCommit\(currentIdx\)\s*\{[\s\S]*?\n\}',
            new_move_fn,
            app_js_norm,
            count=1
        )
        print("Updated moveToNextBatchOrCommit via regex.")

    # Update enterkeyhint in stk-bec-qty-input
    app_js_norm = app_js_norm.replace(
        'enterkeyhint="done"\n                            oninput="updateBecRowCalc(this)">',
        'enterkeyhint="${idx < batches.length - 1 ? \'next\' : \'done\'}"\n                            oninput="updateBecRowCalc(this)">'
    )

    with open(app_path, 'w', encoding='utf-8') as f:
        f.write(app_js_norm)
    print("Saved frontend/app.js.")


    # ==================== 2. Update frontend/mobile.html ====================
    mob_path = 'frontend/mobile.html'
    with open(mob_path, 'r', encoding='utf-8') as f:
        mob_html = f.read()

    mob_html_norm = mob_html.replace('\r\n', '\n')

    # Update quantity row display to show helpful badge and dynamic enterkeyhint
    old_qty_block = """                        <div class="flex items-center justify-between gap-2 pt-2 border-t border-slate-900">
                            <span class="text-xs font-bold text-emerald-400">الكمية الفعلية (الجرد):</span>
                            <div class="flex items-center gap-1.5">
                                <button type="button" onclick="stepMbBatchRow(${idx}, -1)" class="w-9 h-9 rounded-lg bg-slate-800 hover:bg-slate-700 active:scale-95 text-rose-300 font-bold text-lg flex items-center justify-center border border-slate-700 transition">-</button>
                                <input type="text"
                                       inputmode="decimal"
                                       class="mb-batch-row-qty w-24 py-1.5 px-1 rounded-lg bg-slate-900 border-2 border-emerald-500 text-white text-center font-mono font-black text-base focus:border-amber-400 focus:bg-slate-800 outline-none"
                                       data-index="${idx}"
                                       data-batch="${(b.batch_number || '').replace(/"/g, '&quot;')}"
                                       data-expiry="${(b.expiry_date || '').replace(/"/g, '&quot;')}"
                                       data-sys="${sysQty}"
                                       data-cost="${cost}"
                                       data-sale="${sale}"
                                       value="${b.counted_qty > 0 ? b.counted_qty : ''}"
                                       placeholder="أدخل..."
                                       enterkeyhint="done">
                                <button type="button" onclick="stepMbBatchRow(${idx}, 1)" class="w-9 h-9 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white font-bold text-lg flex items-center justify-center transition">+</button>
                            </div>
                        </div>"""

    new_qty_block = """                        <div class="flex items-center justify-between gap-2 pt-2 border-t border-slate-900">
                            <div class="flex items-center gap-1.5">
                                <span class="text-xs font-bold text-emerald-400">الكمية الفعلية:</span>
                                ${idx < batches.length - 1 ? '<span class="text-[10px] text-amber-400 font-mono font-bold bg-amber-950/60 px-1.5 py-0.5 rounded border border-amber-500/30">سهم ➔ التالي</span>' : '<span class="text-[10px] text-emerald-400 font-mono font-bold bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-500/30">سهم ↵ ترحيل</span>'}
                            </div>
                            <div class="flex items-center gap-1.5">
                                <button type="button" onclick="stepMbBatchRow(${idx}, -1)" class="w-9 h-9 rounded-lg bg-slate-800 hover:bg-slate-700 active:scale-95 text-rose-300 font-bold text-lg flex items-center justify-center border border-slate-700 transition">-</button>
                                <input type="text"
                                       inputmode="decimal"
                                       class="mb-batch-row-qty w-24 py-1.5 px-1 rounded-lg bg-slate-900 border-2 border-emerald-500 text-white text-center font-mono font-black text-base focus:border-amber-400 focus:bg-slate-800 outline-none"
                                       data-index="${idx}"
                                       data-batch="${(b.batch_number || '').replace(/"/g, '&quot;')}"
                                       data-expiry="${(b.expiry_date || '').replace(/"/g, '&quot;')}"
                                       data-sys="${sysQty}"
                                       data-cost="${cost}"
                                       data-sale="${sale}"
                                       value="${b.counted_qty > 0 ? b.counted_qty : ''}"
                                       placeholder="أدخل..."
                                       enterkeyhint="${idx < batches.length - 1 ? 'next' : 'done'}">
                                <button type="button" onclick="stepMbBatchRow(${idx}, 1)" class="w-9 h-9 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:scale-95 text-white font-bold text-lg flex items-center justify-center transition">+</button>
                            </div>
                        </div>"""

    if old_qty_block.replace('\r\n', '\n') in mob_html_norm:
        mob_html_norm = mob_html_norm.replace(old_qty_block.replace('\r\n', '\n'), new_qty_block)
        print("Updated quantity row markup in mobile.html.")
    else:
        print("Warning: old_qty_block not matched in mobile.html")

    # Update events in attachMobileBatchRowEvents
    old_events_block = """            // ربط نموذج الموبايل: التوجيه الذكي لمفاتيح الكيبورد الافتراضية
            const mbBatchForm = document.getElementById('mb-batch-form');
            if (mbBatchForm) {
                mbBatchForm.onsubmit = async (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    const active = document.activeElement;
                    // إذا كان المؤشر في خانة رقم التشغيلة -> توجه لخانة الصلاحية
                    if (active && active.classList.contains('mb-batch-row-batch')) {
                        const idx = parseInt(active.dataset.index, 10);
                        const row = document.getElementById(`mb-batch-row-${idx}`);
                        const exp = row?.querySelector('.mb-batch-row-expiry');
                        if (exp) { exp.focus(); exp.select(); }
                        return false;
                    }

                    // إذا كان المؤشر في خانة الصلاحية -> نسق التاريخ وانتقل فوراً لخانة الكمية (ممنوع الإغلاق أو الاعتماد هنا)
                    if (active && active.classList.contains('mb-batch-row-expiry')) {
                        active.value = normalizeExpiryDate(active.value);
                        if (active.value) {
                            active.classList.remove('border-rose-500', 'ring-2', 'ring-rose-500', 'bg-rose-950/60');
                        }
                        const idx = parseInt(active.dataset.index, 10);
                        const row = document.getElementById(`mb-batch-row-${idx}`);
                        const qty = row?.querySelector('.mb-batch-row-qty');
                        if (qty) { qty.focus(); qty.select(); }
                        return false;
                    }

                    // فقط إذا كان المؤشر في خانة الكمية -> يتم الاعتماد والترحيل
                    await commitMobileAllBatches();
                    return false;
                };
            }

            // 3. حقول الكمية الفعلية والتنقل والاعتماد
            const allQtyInputs = Array.from(listContainer.querySelectorAll('.mb-batch-row-qty'));
            allQtyInputs.forEach((inp, idx) => {
                inp.addEventListener('focus', () => {
                    allQtyInputs.forEach((otherInp, j) => {
                        const r = document.getElementById(`mb-batch-row-${j}`);
                        if (r) {
                            if (idx === j) {
                                r.classList.add('border-amber-400', 'bg-slate-900/90');
                            } else {
                                r.classList.remove('border-amber-400', 'bg-slate-900/90');
                            }
                        }
                    });
                });

                const handleQtyStep = async (e) => {
                    const isEnter = (e.key === 'Enter' || e.keyCode === 13 || e.which === 13 || e.code === 'Enter' || e.code === 'NumpadEnter');
                    const isTab = (e.key === 'Tab' || e.keyCode === 9 || e.which === 9) && !e.shiftKey;
                    const isDown = (e.key === 'ArrowDown' || e.keyCode === 40 || e.key === 'ArrowRight' || e.keyCode === 39);
                    const isAction = (e.key === 'Done' || e.key === 'Go' || e.key === 'Next' || e.key === 'Submit');

                    if (isEnter || isTab || isDown || isAction) {
                        if (e.preventDefault) e.preventDefault();
                        if (e.stopPropagation) e.stopPropagation();

                        const row = document.getElementById(`mb-batch-row-${idx}`);
                        const expInp = row?.querySelector('.mb-batch-row-expiry');
                        const countedVal = parseQtyInput(inp.value || '0');

                        if (countedVal > 0 && expInp) {
                            const normalized = normalizeExpiryDate(expInp.value);
                            expInp.value = normalized;
                            if (!normalized) {
                                playBeep(false);
                                expInp.classList.add('border-rose-500', 'ring-2', 'ring-rose-500', 'bg-rose-950/60');
                                expInp.focus();
                                expInp.select();
                                alert('⚠️ يرجى إدخال تاريخ الصلاحية (الاكسبير) للصنف أولاً');
                                return;
                            }
                        }

                        // في الموبايل: عند وضع الكمية وضغط السهم يتم اعتماد الصنف مباشرة والترحيل للجرد
                        // بدون الرجوع إلى خانة الصلاحية أو القفز العشوائي
                        await commitMobileAllBatches();
                    } else if (e.key === 'Escape') {
                        if (e.preventDefault) e.preventDefault();
                        closeMobileBatchModal(true);
                    }
                };

                inp.addEventListener('keydown', handleQtyStep);
                inp.addEventListener('keyup', (e) => {
                    // التقاط مفاتيح كيبورد الموبايل عند الإفلات
                    if (e.key === 'Enter' || e.keyCode === 13 || e.which === 13) {
                        handleQtyStep(e);
                    }
                });
                inp.addEventListener('beforeinput', (e) => {
                    if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
                        e.preventDefault();
                        commitMobileAllBatches();
                    }
                });
            });"""

    new_events_block = """            // 3. حقول الكمية الفعلية والتنقل والاعتماد
            const allQtyInputs = Array.from(listContainer.querySelectorAll('.mb-batch-row-qty'));
            let lastMobileQtyStepTime = 0;

            // دالة التنقل بين الباتشات بالسهم أو اعتماد الترحيل عند آخر باتش في الموبايل
            async function moveToNextMobileBatchOrCommit(currentIdx) {
                const now = Date.now();
                if (now - lastMobileQtyStepTime < 300) return;
                lastMobileQtyStepTime = now;

                if (!allQtyInputs.length) return;

                const row = document.getElementById(`mb-batch-row-${currentIdx}`);
                const expInp = row?.querySelector('.mb-batch-row-expiry');
                const currentQtyInp = row?.querySelector('.mb-batch-row-qty');
                const countedVal = parseQtyInput(currentQtyInp?.value || '0');

                if (countedVal > 0 && expInp) {
                    const normalized = normalizeExpiryDate(expInp.value);
                    expInp.value = normalized;
                    if (!normalized) {
                        playBeep(false);
                        expInp.classList.add('border-rose-500', 'ring-2', 'ring-rose-500', 'bg-rose-950/60');
                        expInp.focus();
                        expInp.select();
                        alert('⚠️ يرجى إدخال تاريخ الصلاحية (الاكسبير) للصنف أولاً');
                        return;
                    }
                }

                // إذا كان هناك باتش تالي: ننتقل مباشرة إلى خانة العدد في الباتش التالي
                if (currentIdx < allQtyInputs.length - 1) {
                    const nextIdx = currentIdx + 1;
                    const nextRow = document.getElementById(`mb-batch-row-${nextIdx}`);
                    const nextExp = nextRow?.querySelector('.mb-batch-row-expiry');
                    const nextQty = nextRow?.querySelector('.mb-batch-row-qty');

                    // إذا كان الباتش التالي يحتاج إدخال تاريخ الصلاحية يدوياً وهو فارغ، نوجه الفوكس إليها أولاً، وإلا إلى خانة العدد
                    const target = (nextExp && (!nextExp.value.trim() || nextExp.value === '-')) ? nextExp : nextQty;

                    if (target) {
                        target.focus();
                        target.select();
                        target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }

                    // تمييز السطر النشط
                    allQtyInputs.forEach((_, j) => {
                        const r = document.getElementById(`mb-batch-row-${j}`);
                        if (r) {
                            if (j === nextIdx) {
                                r.classList.add('border-amber-400', 'bg-slate-900/90');
                            } else {
                                r.classList.remove('border-amber-400', 'bg-slate-900/90');
                            }
                        }
                    });
                } else {
                    // عند آخر باتش (أو الصنف له باتش واحد فقط): يتم الاعتماد والترحيل المباشر
                    await commitMobileAllBatches();
                }
            }

            // ربط نموذج الموبايل: التوجيه الذكي لمفاتيح الكيبورد الافتراضية
            const mbBatchForm = document.getElementById('mb-batch-form');
            if (mbBatchForm) {
                mbBatchForm.onsubmit = async (e) => {
                    e.preventDefault();
                    e.stopPropagation();

                    const active = document.activeElement;
                    // إذا كان المؤشر في خانة رقم التشغيلة -> توجه لخانة الصلاحية
                    if (active && active.classList.contains('mb-batch-row-batch')) {
                        const idx = parseInt(active.dataset.index, 10);
                        const row = document.getElementById(`mb-batch-row-${idx}`);
                        const exp = row?.querySelector('.mb-batch-row-expiry');
                        if (exp) { exp.focus(); exp.select(); }
                        return false;
                    }

                    // إذا كان المؤشر في خانة الصلاحية -> نسق التاريخ وانتقل فوراً لخانة الكمية (ممنوع الإغلاق أو الاعتماد هنا)
                    if (active && active.classList.contains('mb-batch-row-expiry')) {
                        active.value = normalizeExpiryDate(active.value);
                        if (active.value) {
                            active.classList.remove('border-rose-500', 'ring-2', 'ring-rose-500', 'bg-rose-950/60');
                        }
                        const idx = parseInt(active.dataset.index, 10);
                        const row = document.getElementById(`mb-batch-row-${idx}`);
                        const qty = row?.querySelector('.mb-batch-row-qty');
                        if (qty) { qty.focus(); qty.select(); }
                        return false;
                    }

                    // إذا كان المؤشر في خانة الكمية -> الانتقال للباتش التالي أو الاعتماد والترحيل عند آخر باتش
                    let activeIdx = allQtyInputs.indexOf(active);
                    if (activeIdx === -1) {
                        activeIdx = allQtyInputs.length - 1;
                    }
                    await moveToNextMobileBatchOrCommit(activeIdx);
                    return false;
                };
            }

            allQtyInputs.forEach((inp, idx) => {
                inp.addEventListener('focus', () => {
                    allQtyInputs.forEach((otherInp, j) => {
                        const r = document.getElementById(`mb-batch-row-${j}`);
                        if (r) {
                            if (idx === j) {
                                r.classList.add('border-amber-400', 'bg-slate-900/90');
                            } else {
                                r.classList.remove('border-amber-400', 'bg-slate-900/90');
                            }
                        }
                    });
                });

                const handleQtyStep = async (e) => {
                    const isEnter = (e.key === 'Enter' || e.keyCode === 13 || e.which === 13 || e.code === 'Enter' || e.code === 'NumpadEnter');
                    const isTab = (e.key === 'Tab' || e.keyCode === 9 || e.which === 9) && !e.shiftKey;
                    const isDown = (e.key === 'ArrowDown' || e.keyCode === 40 || e.key === 'ArrowRight' || e.keyCode === 39);
                    const isAction = (e.key === 'Done' || e.key === 'Go' || e.key === 'Next' || e.key === 'Submit');

                    if (isEnter || isTab || isDown || isAction) {
                        if (e.preventDefault) e.preventDefault();
                        if (e.stopPropagation) e.stopPropagation();
                        await moveToNextMobileBatchOrCommit(idx);
                    } else if (e.key === 'Escape') {
                        if (e.preventDefault) e.preventDefault();
                        closeMobileBatchModal(true);
                    }
                };

                inp.addEventListener('keydown', handleQtyStep);
                inp.addEventListener('keyup', (e) => {
                    // التقاط مفاتيح كيبورد الموبايل عند الإفلات
                    if (e.key === 'Enter' || e.keyCode === 13 || e.which === 13) {
                        handleQtyStep(e);
                    }
                });
                inp.addEventListener('beforeinput', async (e) => {
                    if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
                        e.preventDefault();
                        e.stopPropagation();
                        await moveToNextMobileBatchOrCommit(idx);
                    }
                });
            });"""

    if old_events_block.replace('\r\n', '\n') in mob_html_norm:
        mob_html_norm = mob_html_norm.replace(old_events_block.replace('\r\n', '\n'), new_events_block)
        print("Updated event handlers in mobile.html.")
    else:
        print("Warning: old_events_block not matched in mobile.html")

    with open(mob_path, 'w', encoding='utf-8') as f:
        f.write(mob_html_norm)
    print("Saved frontend/mobile.html.")

    # ==================== 3. Bump cache busters in index.html ====================
    idx_path = 'frontend/index.html'
    with open(idx_path, 'r', encoding='utf-8') as f:
        idx_html = f.read()

    idx_html = re.sub(r'app\.js\?v=[^"\'\s]+', 'app.js?v=20261105_multibatch_flow_v20', idx_html)
    with open(idx_path, 'w', encoding='utf-8') as f:
        f.write(idx_html)
    print("Bumped cache-buster in frontend/index.html.")

if __name__ == '__main__':
    apply_fix()
