import sys
import re

def main():
    print("Reading frontend/app.js...")
    with open('frontend/app.js', 'r', encoding='utf-8') as f:
        app_js = f.read()

    start_marker = 'let wasCameraActiveBeforeBatch = false;'
    end_marker = '// مسح صنف للاستور المختار'

    start_idx = app_js.find(start_marker)
    end_idx = app_js.find(end_marker)

    if start_idx == -1 or end_idx == -1:
        print("ERROR: Markers not found in app.js")
        sys.exit(1)

    new_block = '''let wasCameraActiveBeforeBatch = false;

// دالة التنقل بين الباتشات بالسهم أو اعتماد الترحيل عند آخر باتش
function moveToNextBatchOrCommit(currentIdx) {
    const tbody = document.getElementById('stk-bec-batches-tbody');
    const allInputs = Array.from(tbody?.querySelectorAll('.stk-bec-qty-input') || []);
    if (!allInputs.length) return;

    if (currentIdx < allInputs.length - 1) {
        // إذا كان هناك باتشات أخرى للصنف: انتقال مباشر لخانة الرصيد الفعلي للباتش التالي
        const nextInput = allInputs[currentIdx + 1];
        if (nextInput) {
            nextInput.focus();
            nextInput.select();
            nextInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

            // تمييز سطر الباتش النشط بصرياً باللون الأصفر
            allInputs.forEach((inp, j) => {
                const r = document.getElementById(`stk-bec-row-${j}`);
                if (r) {
                    if (j === currentIdx + 1) {
                        r.classList.add('ring-2', 'ring-amber-500', 'bg-amber-100/70');
                    } else {
                        r.classList.remove('ring-2', 'ring-amber-500', 'bg-amber-100/70');
                    }
                }
            });
        }
    } else {
        // عند آخر باتش (أو الصنف له باتش واحد فقط): الاعتماد المباشر والترحيل لفاتورة الجرد والتوجيه للكاميرا
        commitAllCardBatches(allInputs);
    }
}

function openBatchEntryCard(data) {
    wasCameraActiveBeforeBatch = true;
    currentActiveBatchCardData = data;
    const card = document.getElementById('stk-batch-entry-card');
    if (!card) return;

    const prod = data.product || {};
    const batches = data.batches || [];

    const elCode = document.getElementById('stk-bec-product-code');
    const elName = document.getElementById('stk-bec-product-name');
    const elBarcode = document.getElementById('stk-bec-barcode');
    const elCount = document.getElementById('stk-bec-batches-count');
    const tbody = document.getElementById('stk-bec-batches-tbody');

    if (elCode) elCode.textContent = prod.code || '-';
    if (elName) elName.textContent = prod.name || '-';
    if (elBarcode) elBarcode.textContent = prod.barcode || prod.gtin || '-';
    if (elCount) elCount.textContent = `${batches.length} تشغيلة`;

    if (tbody) {
        let html = '';
        batches.forEach((b, idx) => {
            const hasCounted = Number(b.counted_qty || 0) > 0;
            const countedVal = hasCounted ? Number(b.counted_qty) : 0;
            const sysQty = Number(b.system_qty || 0);
            const diff = Number(countedVal - sysQty).toFixed(2);
            const cost = Number(b.cost_price || 0);
            const sale = Number(b.selling_price || 0);
            const totCost = formatMoney(countedVal * cost);
            const totSale = formatMoney(countedVal * sale);

            const batchBadge = b.is_new_batch || sysQty === 0
                ? `<span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold border border-amber-300 text-[10px] whitespace-nowrap">⚠️ جديد</span>`
                : `<span class="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-bold border border-emerald-200 text-[10px] whitespace-nowrap">مطابق ✅</span>`;

            // زر السطر: إن كان هناك باتشات تالية يظهر 'التالي ➔'، وإن كان الأخير يظهر 'ترحيل ↵'
            const isLastBatch = (idx === batches.length - 1);
            const actionBtn = isLastBatch
                ? `<button type="button" class="stk-bec-btn-action px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-black text-[11px] shadow-sm flex items-center justify-center gap-1 mx-auto transition" data-action="commit" data-index="${idx}"><span>ترحيل</span> <span>↵</span></button>`
                : `<button type="button" class="stk-bec-btn-action px-2 py-1 rounded bg-amber-500 hover:bg-amber-600 active:scale-95 text-white font-black text-[11px] shadow-sm flex items-center justify-center gap-1 mx-auto transition" data-action="next" data-index="${idx}"><span>التالي</span> <span>➔</span></button>`;

            const statusCellContent = hasCounted
                ? `<div class="flex flex-col items-center gap-1"><span class="px-1.5 py-0.5 rounded bg-emerald-600 text-white font-bold text-[10px]">✅ تم (${countedVal})</span>${actionBtn}</div>`
                : actionBtn;

            html += `
                <tr class="hover:bg-amber-50/50 transition border-b border-slate-300 text-slate-700 text-xs ${hasCounted ? 'bg-emerald-50/40' : (idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/60')}" id="stk-bec-row-${idx}">
                    <td class="border border-slate-300 p-1 text-center text-slate-500 font-mono text-[11px] select-none bg-slate-50/50">${idx + 1}</td>
                    <td class="border border-slate-300 p-1 font-mono font-bold text-slate-900 text-center">${escapeHtml(prod.code || '')}</td>
                    <td class="border border-slate-300 p-1 text-left font-bold text-slate-900 select-text min-w-[260px] whitespace-normal leading-snug" dir="ltr">
                        ${escapeHtml(prod.name || '')}
                    </td>
                    <td class="border border-slate-300 p-1 font-mono text-[11px] text-slate-600 text-center" dir="ltr">${escapeHtml(prod.barcode || prod.gtin || '-')}</td>
                    <td class="border border-slate-300 p-1 text-center">
                        <span class="px-2 py-0.5 rounded bg-indigo-100 border border-indigo-300 text-indigo-950 font-black font-mono text-xs shadow-sm" dir="ltr">${escapeHtml(b.batch_number || '-')}</span>
                    </td>
                    <td class="border border-slate-300 p-1 text-center font-mono font-bold text-slate-900 text-xs" dir="ltr">${escapeHtml(b.expiry_date || '-')}</td>
                    <td class="border border-slate-300 p-1 text-center bg-sky-50/40">
                        <span class="font-mono font-black text-slate-900 text-xs px-2 py-0.5 rounded bg-slate-200/80 border border-slate-300 shadow-sm">${sysQty}</span>
                    </td>
                    <td class="border border-slate-300 p-1 text-center bg-emerald-50/50">
                        <input type="number" step="any" min="0"
                               class="stk-bec-qty-input font-mono font-black text-center text-xs w-20 py-0.5 px-1 border-2 border-emerald-500 focus:border-amber-500 focus:bg-amber-50 rounded bg-white text-emerald-950 shadow-inner outline-none transition"
                               data-index="${idx}"
                               data-product-code="${escapeHtml(prod.code || '')}"
                               data-batch="${escapeHtml(b.batch_number || '')}"
                               data-expiry="${escapeHtml(b.expiry_date || '')}"
                               data-system-qty="${sysQty}"
                               data-cost="${cost}"
                               data-sale="${sale}"
                               value="${b.counted_qty > 0 ? b.counted_qty : ''}"
                               placeholder="أدخل..."
                               tabindex="${idx + 1}"
                               enterkeyhint="${idx < batches.length - 1 ? 'next' : 'done'}"
                               inputmode="decimal"
                               oninput="updateBecRowCalc(this)">
                    </td>
                    <td class="border border-slate-300 p-1 text-center font-mono font-bold text-xs">
                        <span class="bec-diff-cell font-mono font-bold text-xs ${diff < 0 ? 'text-rose-600' : (diff > 0 ? 'text-emerald-700' : 'text-slate-400')}">${diff > 0 ? '+' : ''}${diff}</span>
                    </td>
                    <td class="border border-slate-300 p-1 text-center font-mono font-bold text-slate-800">${formatMoney(cost)}</td>
                    <td class="border border-slate-300 p-1 text-center font-mono font-bold text-indigo-700">${formatMoney(sale)}</td>
                    <td class="border border-slate-300 p-1 text-center font-mono font-bold text-slate-900"><span class="bec-totcost-cell">${totCost}</span></td>
                    <td class="border border-slate-300 p-1 text-center font-mono font-bold text-indigo-950"><span class="bec-totsale-cell">${totSale}</span></td>
                    <td class="border border-slate-300 p-1 text-center">${batchBadge}</td>
                    <td class="border border-slate-300 p-1 text-center" id="stk-bec-cell-status-${idx}">
                        ${statusCellContent}
                    </td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
    }

    card.classList.remove('hidden');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // حماية مؤقتة تمنع القفز لحقل البحث أثناء فتح كارت الباتشات
    const searchFilter = document.getElementById('stk-items-search-filter');
    if (searchFilter) {
        searchFilter.setAttribute('tabindex', '-1');
    }

    const inputs = Array.from(tbody?.querySelectorAll('.stk-bec-qty-input') || []);

    // تأمين النموذج من إرسال المتصفح التلقائي أو قفز مؤشر الهاتف لخارج الجدول
    const batchForm = document.getElementById('stk-bec-batches-form');
    if (batchForm) {
        batchForm.onsubmit = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const activeEl = document.activeElement;
            let activeIdx = inputs.indexOf(activeEl);
            if (activeIdx === -1) {
                activeIdx = inputs.length - 1;
            }
            moveToNextBatchOrCommit(activeIdx);
            return false;
        };
    }

    // التركيز التلقائي المباشر على أول خانة للرصيد الفعلي (Auto-focus & select)
    setTimeout(() => {
        const firstInput = tbody?.querySelector('.stk-bec-qty-input');
        if (firstInput) {
            firstInput.focus();
            firstInput.select();
            const firstRow = document.getElementById('stk-bec-row-0');
            if (firstRow) {
                firstRow.classList.add('ring-2', 'ring-amber-500', 'bg-amber-100/70');
            }
        }
    }, 60);

    // ربط التنقل بالسهم / Enter بين الباتشات لعدد N من الباتشات والاعتماد عند آخر باتش
    inputs.forEach((inp, idx) => {
        inp.addEventListener('focus', () => {
            inputs.forEach((otherInp, j) => {
                const r = document.getElementById(`stk-bec-row-${j}`);
                if (r) {
                    if (idx === j) {
                        r.classList.add('ring-2', 'ring-amber-500', 'bg-amber-100/70');
                    } else {
                        r.classList.remove('ring-2', 'ring-amber-500', 'bg-amber-100/70');
                    }
                }
            });
        });

        const handleKeyStep = (e) => {
            const isEnter = (e.key === 'Enter' || e.keyCode === 13 || e.which === 13 || e.code === 'Enter' || e.code === 'NumpadEnter');
            const isTab = (e.key === 'Tab' || e.keyCode === 9 || e.which === 9) && !e.shiftKey;

            if (isEnter || isTab) {
                e.preventDefault();
                e.stopPropagation();
                moveToNextBatchOrCommit(idx);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeBatchEntryCard(false);
            }
        };

        inp.addEventListener('keydown', handleKeyStep);

        // التعامل مع مفاتيح الهواتف المحمولة التي ترسل قبل الإدخال (beforeinput)
        inp.addEventListener('beforeinput', (e) => {
            if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
                e.preventDefault();
                e.stopPropagation();
                moveToNextBatchOrCommit(idx);
            }
        });
    });

    // ربط أزرار الإجراء (التالي / ترحيل) الموضعية بكل سطر
    tbody?.querySelectorAll('.stk-bec-btn-action').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const btnIdx = parseInt(btn.dataset.index);
            moveToNextBatchOrCommit(btnIdx);
        });
    });
}

let isBatchCommittingLock = false;
async function commitAllCardBatches(allInputs) {
    if (isBatchCommittingLock) return;
    isBatchCommittingLock = true;

    try {
        let savedCount = 0;
        let lastStoreDetails = null;

        for (const inputEl of allInputs) {
            const idx = parseInt(inputEl.dataset.index);
            const prodCode = inputEl.dataset.productCode;
            const batch = inputEl.dataset.batch;
            const expiry = inputEl.dataset.expiry;
            const sysQty = parseFloat(inputEl.dataset.systemQty) || 0;
            const cost = parseFloat(inputEl.dataset.cost) || 0;
            const sale = parseFloat(inputEl.dataset.sale) || 0;

            const val = inputEl.value.trim();
            const countedVal = parseFloat(val);

            // قاعدة هامة جداً: إذا كانت الكمية صفر أو فارغة، لا يتم تسجيل سطر في فاتورة الجرد إطلاقاً
            if (isNaN(countedVal) || countedVal <= 0) {
                continue;
            }

            try {
                const res = await fetch('/api/stock/save-batch-qty', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        store_no: currentActiveStoreNo,
                        product_code: prodCode,
                        batch_number: batch,
                        expiry_date: expiry,
                        counted_qty: countedVal,
                        system_qty: sysQty,
                        cost_price: cost,
                        selling_price: sale
                    })
                });
                const resData = await res.json();
                if (resData.success) {
                    savedCount++;
                    if (resData.store_details) {
                        lastStoreDetails = resData.store_details;
                    }
                }
            } catch (err) {
                console.error('Error saving batch row', err);
            }
        }

        if (savedCount > 0) {
            playStockAudioAlert(true);
            playAppScannerBeep(true);
            showCatalogToast(`⚡ تم ترحيل ${savedCount} تشغيلة إلى فاتورة الجرد بنجاح`);
            if (lastStoreDetails) {
                renderCurrentStoreDetails(lastStoreDetails);
            }
        }

        // إغلاق الكارت والتوجيه التلقائي والفوري للكاميرا اسكان مباشرة
        closeBatchEntryCard(true);
        await loadStocktakeStores();
        await loadCurrentStoreItems();
    } finally {
        isBatchCommittingLock = false;
    }
}

async function handleBatchInputCommit(inputEl, allInputs, skipAdvance = false) {
    await commitAllCardBatches(allInputs || [inputEl]);
}

function closeBatchEntryCard(reopenCamera = true) {
    const card = document.getElementById('stk-batch-entry-card');
    if (card) card.classList.add('hidden');
    currentActiveBatchCardData = null;

    // استرجاع مؤشر البحث
    const searchFilter = document.getElementById('stk-items-search-filter');
    if (searchFilter) {
        searchFilter.removeAttribute('tabindex');
    }

    const scanInput = document.getElementById('stk-scan-input');
    if (scanInput) {
        scanInput.focus();
        scanInput.select();
    }

    // التوجيه الفوري والتلقائي إلى الكاميرا اسكان بعد ترحيل الصنف
    if (reopenCamera) {
        wasCameraActiveBeforeBatch = false;
        setTimeout(() => {
            openCameraModal('stocktake');
        }, 120);
    }
}

'''

    updated_app_js = app_js[:start_idx] + new_block + app_js[end_idx:]

    with open('frontend/app.js', 'w', encoding='utf-8') as f:
        f.write(updated_app_js)

    print("Successfully updated frontend/app.js")

    # Update index.html
    print("Reading frontend/index.html...")
    with open('frontend/index.html', 'r', encoding='utf-8') as f:
        html = f.read()

    # Bump cache-busting version
    html = re.sub(r'app\.js\?v=[^\"]+', 'app.js?v=20261105_arrow_camera_v8', html)
    html = re.sub(r'style\.css\?v=[^\"]+', 'style.css?v=20261105_arrow_camera_v8', html)

    # Ensure stk-bec-batches-form exists
    if '<form id="stk-bec-batches-form"' not in html:
        old_div = '<div class="overflow-x-auto rounded-lg border border-slate-300 bg-white shadow-sm">'
        new_form = '<form id="stk-bec-batches-form" onsubmit="return false;" autocomplete="off" class="overflow-x-auto rounded-lg border border-slate-300 bg-white shadow-sm">'
        html = html.replace(old_div, new_form, 1)
        # and replace the matching closing div
        # Find closing tag after stk-bec-batches-tbody
        tbody_pos = html.find('stk-bec-batches-tbody')
        if tbody_pos != -1:
            table_close = html.find('</table>', tbody_pos)
            if table_close != -1:
                after_table = html.find('</div>', table_close)
                if after_table != -1 and after_table < table_close + 100:
                    html = html[:after_table] + '</form>' + html[after_table+6:]

    with open('frontend/index.html', 'w', encoding='utf-8') as f:
        f.write(html)

    print("Successfully updated frontend/index.html")

if __name__ == '__main__':
    main()
