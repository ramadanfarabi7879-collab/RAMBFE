/**
 * نظام إدارة بطاقات الأصناف والمسح بكود QR وتصدير الفاتورة
 * كود جافاسكريبت تفاعلي متكامل يدعم:
 * 1. مسح QR متعدد المعايير (GS1 DataMatrix, URLs, Plain) والتعرف التلقائي على الصنف
 * 2. تجميع البنود (صنف + باتش + تاريخ انتهاء) وزيادة الكمية بعدد السيريالات
 * 3. منع تكرار السيريال في الفاتورة الحالية والفواتير المعتمدة السابقة
 * 4. إدارة بطاقات الأصناف مع كود داخلي مولد تلقائياً من النظام وحفظ الأصفار في الباركود والـ GTIN
 * 5. استيراد يدوي متقدم من Excel مع اختيار الأعمدة بدون ربط تلقائي
 * 6. تصدير الفاتورة المعتمدة إلى Excel بالترتيب والاتجاه المطلوب (RTL)
 * 7. معالجة الإرجاعات الموثقة دون حذف السجلات
 */

let activeInvoice = null;
let currentTab = 'scanner';
let catalogOffset = 0;
const catalogLimit = 25;
let catalogSearchDebounce = null;
let html5QrScannerInstance = null;
let activeEditingProductCode = null;

// حالة استيراد ملف الإكسيل
let uploadedImportFileId = null;
let uploadedImportHeaders = [];

// دالة تنسيق الأرقام والعملة العامة للنظام بالكامل
function formatMoney(n) {
    return Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
window.formatMoney = formatMoney;

// ==================== التهيئة عند تحميل الصفحة ====================

// ==================== نظام تبديل اللغة ثنائي اللغة (العربية <-> English) ====================
const RAMBFE_I18N_MAP = {
    "(البديهي 0% يدوي)": "(Default 0% Manual)",
    "(البديهي 0)": "(Default 0)",
    "(سيتم مسح الاستوك القديم واعتماد الفعلي الجديد)": "(Old stock will be cleared and new actual count approved)",
    "(فارغ / بدون)": "(Empty / None)",
    ") غير مسجل في بطاقات الأصناف:": ") is not registered in Item Cards:",
    "* الكمية": "* Quantity",
    "* تاريخ الانتهاء": "* Expiry Date",
    "* رقم GTIN": "* GTIN Number",
    "* رقم الدفعة (Batch)": "* Batch Number (LOT)",
    "-- اختر العمود يدويًا --": "-- Select Column Manually --",
    "-- اختياري: اختر عمود الاسم العلمي --": "-- Optional: Select Scientific Name Column --",
    "-- اختياري: اختر عمود الشركة --": "-- Optional: Select Company Column --",
    "-- اختياري: اختر عمود سعر الجملة --": "-- Optional: Select Wholesale Price Column --",
    "-- بدون ضريبة (افتراضي 0% يدوي) أو اختر العمود --": "-- No Tax (Default 0%) or Select Tax Column --",
    "-- لا يوجد تجميع (كل صف صنف مستقل) --": "-- No Grouping (Each Row is a Separate Item) --",
    "-- يولد النظام كوداً رقمياً تلقائياً --": "-- Auto-Generate Numeric System Code --",
    "0 استور": "0 Stores",
    "0 بند": "0 Lines",
    "0 صنف": "0 Items",
    "0 صنف معدل": "0 Modified Items",
    "0 مجمعة": "0 Collected",
    "0.00 (اختياري)": "0.00 (Optional)",
    "0.00 ر.س": "0.00 SAR",
    "1 MEDICINE (الرقم ثم المسمى)": "1 MEDICINE (Number then Name)",
    "1. اختر المسمى الأساسي (أو اكتب أي مسمى وينطبق عليه الترقيم 1 إلى 50):": "1. Select Base Category (or type any custom name with numbering 1 to 50):",
    "1. حدد الخانات المراد تصديرها فقط (Checkboxes):": "1. Select Fields to Export (Checkboxes):",
    "14 رقماً نقي": "14 Pure Digits",
    "2. اختر رقم الورقة (من 1 إلى 50):": "2. Select Sheet Number (1 to 50):",
    "2. اختر نطاق الأصناف لتصديرها فوراً:": "2. Choose Item Scope for Immediate Export:",
    "3. الاسم النهائي للورقة وملف الطباعة (يمكنك التعديل أو الاختيار من الاقتراحات 1-50):": "3. Final Sheet & Print File Name (Edit or pick from suggestions 1-50):",
    "Batch Number (LOT - رقم التشغيلة/الباتش):": "Batch Number (LOT):",
    "Expiry Date (EXP - تاريخ الصلاحية):": "Expiry Date (EXP):",
    "GTIN (رقم تعريف الصنف):": "GTIN (Global Trade Item Number):",
    "GTIN إضافي": "Additional GTIN",
    "GTIN الأساسي": "Primary GTIN",
    "GTIN الأساسي وأرقام GTIN الإضافية": "Primary GTIN & Additional GTINs",
    "GTIN فقط": "GTIN Only",
    "ITEMS / الأصناف": "ITEMS",
    "MEDICINE 1 (المسمى ثم الرقم)": "MEDICINE 1 (Name then Number)",
    "Mfg Date (MFG - تاريخ الإنتاج):": "Mfg Date (MFG - Manufacturing Date):",
    "QTY / العبوات": "QTY / Packages",
    "ST-001 (الاستور الرئيسي)": "ST-001 (Main Store)",
    "STORE NAME / اسم الاستور:": "STORE NAME:",
    "Serial Number (SN - الرقم التسلسلي):": "Serial Number (SN):",
    "آخر مسحة:": "Last Scan:",
    "أدخل رقم السيريال...": "Enter Serial Number...",
    "أرقام الباركود للصنف": "Item Barcodes",
    "أساسي": "Primary",
    "أصناف الاستور المسحوبة:": "Scanned Store Items:",
    "أصناف محددة في الجدول": "Selected Items in Table",
    "أصناف محددة في الجرد": "Selected Items in Stocktake",
    "أو زر الاعتماد للاحتفاظ برقم": "or click Approve to keep",
    "أو يمكنك استخدام كاميرا الهاتف كصورة بديلة فورية": "Or use phone camera snapshot as an instant alternative",
    "إجراءات": "Actions",
    "إجراءات الاستور": "Store Actions",
    "إجراءات وتصدير": "Actions & Export",
    "إجمالي البيع": "Total Sales",
    "إجمالي التكلفة": "Total Cost",
    "إجمالي العبوات": "Total Packages",
    "إجمالي القيمة": "Total Value",
    "إجمالي صفوف الملف": "Total File Rows",
    "إدارة الاستورات والفروع": "Stores & Branches Management",
    "إدخال": "Insert",
    "إدخال وتعديل بيانات بطاقة الصنف وربط الباركودات و GTINs": "Create & Edit Item Card Details, Barcodes, and GTINs",
    "إدخال يدوي": "Manual Entry",
    "إذا تُرك فارغاً يُنشأ كود رقمي تلقائياً من النظام": "If left blank, a numeric code is auto-generated by the system",
    "إضافة أصناف جديدة": "Add New Items",
    "إضافة الباركودات و GTINs الجديدة الواردة في الملف إلى الصنف دون حذف أي باركود قديم مسجل له.": "Append new Barcodes & GTINs from the file without deleting existing ones.",
    "إضافة بطاقة صنف جديدة": "Add New Item Card",
    "إضافة تشغيلة": "Add Batch",
    "إضافة تشغيلة أخرى للصنف": "Add Another Batch for Item",
    "إضافة خانة GTIN إضافي (+)": "Add Extra GTIN Field (+)",
    "إضافة خانة باركود إضافي (+)": "Add Extra Barcode Field (+)",
    "إضافة سريعة لكرت صنف وربطه بالـ GTIN والباركود:": "Quick Add Item Card & Link GTIN/Barcode:",
    "إعادة المحاولة 🔄": "Retry 🔄",
    "إغلاق": "Close",
    "إغلاق (Esc)": "Close (Esc)",
    "إلغاء": "Cancel",
    "إلغاء التحديد ✕": "Deselect All ✕",
    "ابحث باسم الصنف أو الكود (اضغط Enter للإدراج المباشر في الجدول)...": "Search by item name or code (Press Enter to insert directly)...",
    "اختر الرقم من 1 إلى 50 أو بدون رقم": "Select number 1 to 50 or no number",
    "اختر الفرع لتعبئة خانة LOCATION عند تصدير ملف الإكسيل": "Select branch to fill LOCATION column when exporting Excel",
    "اختر مسمى عمود الاسم الإنجليزي عند التصدير": "Select English Name column header for export",
    "اختر مسمى عمود الباتش عند التصدير (المضمون واحد: رقم الباتش)": "Select Batch column header for export",
    "اختر مسمى عمود الكمية عند التصدير (المضمون واحد: الكمية)": "Select Quantity column header for export",
    "اختر مسمى عمود تاريخ الصلاحية عند التصدير": "Select Expiry Date column header for export",
    "اختر مسمى عمود كود الصنف عند التصدير": "Select Product Code column header for export",
    "اختر نوع الورقة والرقم (من 1 إلى 50) أو اكتب أي مسمى تريده ليظهر كعنوان للورقة واسم لملف الطباعة": "Select category & number (1-50) or type custom title for sheet and print file",
    "اختيار الأعمدة يدوي، ويمكنك الضغط على زر الاقتراح التلقائي لتعبئة الحقول المتطابقة ثم تعديلها يدويًا حسب رغبتك.": "Column mapping is manual; click Auto-Suggest to pre-fill matching columns and adjust as needed.",
    "استبدال قائمة الباركودات و GTINs المسجلة للصنف بالقيم الواردة في ملف Excel فقط.": "Replace registered Barcodes & GTINs with values from the Excel file only.",
    "استخدام الجوال كجهاز اسكانر لاسلكي للجرد": "Use Mobile Phone as Wireless Stocktake Scanner",
    "استعراض بطاقات الأصناف 📋": "Browse Item Cards 📋",
    "استعراض وتصدير الفواتير المعتمدة، وتتبع حركات المسح": "View & export approved invoices and track scan history",
    "استورات الجرد والترحيل (Counted)": "Counted & Posted Stores",
    "استورات محددة للترحيل النهائي": "Stores Selected for Final Posting",
    "استيراد Excel اليدوي": "Manual Excel Import",
    "استيراد ملف آخر": "Import Another File",
    "استيراد ملف أصناف للفاتورة": "Import Items File to Invoice",
    "استيراد وتحديث كروت الأصناف من ملف إكسيل": "Import & Update Item Cards from Excel",
    "استيراد وتحديث من Excel": "Import & Update from Excel",
    "اسكان بالجوال": "Mobile Scan",
    "اسم إنجليزي": "English Name",
    "اسم الصنف (Name)": "Item Name",
    "اسم الصنف (إنجليزي / عربي)": "Item Name (EN / AR)",
    "اسم الصنف بالإنجليزي (English) *": "Item Name (English) *",
    "اسم الصنف بالإنجليزي *": "Item Name (English) *",
    "اسم الصنف بالإنجليزية": "Item Name (English)",
    "اسم الصنف بالعربي *": "Item Name (Arabic) *",
    "اسم عربي": "Arabic Name",
    "اضغط هنا أو اسحب وأفلت ملف إكسيل الأصناف (.xlsx, .xls, .csv)": "Click here or drag & drop items Excel file (.xlsx, .xls, .csv)",
    "اعتماد": "Approve",
    "اعتماد GTIN فقط (Enter)": "Keep GTIN Only (Enter)",
    "اعتماد الفاتورة": "Approve Invoice",
    "اعتماد وترحيل الاستور النشط": "Approve & Post Active Store",
    "اقتراح وتعبئة الأعمدة تلقائياً": "Auto-Suggest & Fill Columns",
    "اكتب اسم الاستور هنا...": "Type store name here...",
    "الأسعار": "Prices",
    "الأصناف": "Items",
    "الأصناف:": "Items:",
    "الأقسام + الطباعة + Excel": "Categories + Print + Excel",
    "الاستور النشط:": "Active Store:",
    "الاسم الإنجليزي": "English Name",
    "الاسم العربي": "Arabic Name",
    "الاسم العلمي": "Scientific Name",
    "الاسم العلمي (Scientific Name)": "Scientific Name",
    "الانتهاء:": "Exp:",
    "الباتش:": "Batch:",
    "الباركود": "Barcode",
    "الباركود / GTIN": "Barcode / GTIN",
    "الباركود الأساسي": "Primary Barcode",
    "الباركود الأساسي للصنف...": "Primary item barcode...",
    "الباركود الأساسي والباركودات الإضافية": "Primary & Additional Barcodes",
    "الباركود العادي (اختياري)": "Standard Barcode (Optional)",
    "الباركود و GTIN:": "Barcodes & GTIN:",
    "الباركودات المسجلة": "Registered Barcodes",
    "التاريخ": "Date",
    "التالي": "Next",
    "التشغيلة (Batch)": "Batch / Lot",
    "التصنيف": "Category",
    "التقاط صورة بالكاميرا كبديل": "Take Camera Snapshot Instead",
    "التكلفة": "Cost",
    "التكلفة:": "Cost:",
    "الجرد": "Stocktake",
    "الجرد الفعلي والمطابقة": "Stocktake & Matching",
    "الجرد:": "Counted:",
    "الحالة": "Status",
    "الرصيد الفعلي (الجرد)": "Actual Counted Qty",
    "الرصيد الفعلي (الجرد) ⭐": "Actual Counted Qty ⭐",
    "الرقم التالي": "Next Number",
    "الرقم السابق": "Previous Number",
    "السابق": "Previous",
    "السجل": "History",
    "السيريال:": "Serial:",
    "السيريالات": "Serials",
    "الشركة / المورد": "Company / Supplier",
    "الشركة المصنعة / المورد": "Manufacturer / Supplier",
    "الشركة المصنعة / المورد (Company)": "Manufacturer / Supplier (Company)",
    "الصفوف التي لن تُستورد مع بيان السبب:": "Rows Skipped with Reason:",
    "الصلاحية (Exp)": "Expiry (Exp)",
    "الصلاحية (Expiry)": "Expiry Date",
    "الصنف:": "Item:",
    "الصنف: ... | الباتش: ...": "Item: ... | Batch: ...",
    "الضريبة": "Tax",
    "الضريبة %": "Tax %",
    "الضريبة % (يدوياً 0)": "Tax % (Manual 0)",
    "الضريبة (%)": "Tax (%)",
    "العبوات:": "Packages:",
    "العودة للربط": "Back to Mapping",
    "الفاتورة": "Invoice",
    "الفرع (Location):": "Branch (Location):",
    "الفرع لخانة (Location):": "Branch (Location):",
    "الفرق": "Diff",
    "الفرق:": "Diff:",
    "القسم": "Category",
    "الكمية": "Quantity",
    "الكمية (اختر المسمى)": "Quantity (Select Header)",
    "الكمية الفعلية (Counted Qty) *": "Counted Quantity *",
    "الكمية:": "Qty:",
    "الكود الداخلي": "Internal Code",
    "الكود مطابق لملف الإكسيل أو يُترك فارغاً للتوليد التلقائي": "Matches Excel code or leave blank to auto-generate",
    "الكود: 10001 | PANADOL": "Code: 10001 | PANADOL",
    "الماسح الضوئي المباشر بالكاميرا": "Live Camera Barcode/QR Scanner",
    "المبلغ:": "Amount:",
    "المخزون:": "System Stock:",
    "المزامنة اللحظية السحابية نشطة (Cloudflare & Local Sync):": "Real-time Cloud & Local Sync Active:",
    "المس الشاشة لضبط التركيز التلقائي (Autofocus)": "Tap screen to autofocus camera",
    "المسؤول": "Admin",
    "المستخدم": "User",
    "المستخدم:": "User:",
    "المسح والفاتورة": "Scanner & Invoice",
    "الوحدة": "Unit",
    "امسح الكود بجوالك لتشغيل الاسكانر الفوري مع الكمبيوتر": "Scan this QR code with your phone to pair as a live scanner",
    "امسح كود QR / GS1 DataMatrix أو الباركود هنا (السحب يزيد الكمية +1 تلقائياً مع احتساب التكلفة)...": "Scan QR / GS1 DataMatrix or Barcode here (each scan adds +1 automatically)...",
    "امسح كود داتا ماتريكس أو باركود الصنف للبدء في تجميع الفاتورة فوراً": "Scan DataMatrix or item barcode to start building the invoice immediately",
    "باركود 1D • كود QR • انترناشونال داتاماتريكس (GS1)": "1D Barcode • QR Code • GS1 DataMatrix",
    "باركود إضافي": "Extra Barcode",
    "بالجوال": "Mobile",
    "بانتظار المسح": "Waiting for scan",
    "بحث بالاسم، الكود، الباركود، أو الباتش...": "Search by name, code, barcode, or batch...",
    "بحث فوري في الأصناف غير المجرودة (بالاسم، الكود، الباركود، أو الباتش)...": "Instant search in uncounted items (by name, code, barcode, or batch)...",
    "بداية": "Starts",
    "بدون رقم": "No Number",
    "بطاقات الأصناف": "Item Cards",
    "بطاقة الصنف": "Item Card",
    "بند التجارة العالمي": "Global Trade Item Number (GTIN)",
    "بنود الفاتورة:": "Invoice Lines:",
    "بيانات كود GS1 QR الممسوح (مراجعة قبل الفلترة):": "Scanned GS1 QR Data (Review before filtering):",
    "بيع الاستور": "Store Sales",
    "بيع المخزون": "Stock Sales",
    "تأكيد الاستيراد وحفظ بطاقات الأصناف": "Confirm Import & Save Item Cards",
    "تاريخ الصلاحية": "Expiry Date",
    "تبديل العدسة": "Switch Camera",
    "تبديل وضع ملء الشاشة (F11)": "Toggle Fullscreen (F11)",
    "تحديث أصناف موجودة": "Update Existing Items",
    "تحديث 🔄": "Refresh 🔄",
    "تحديد / إلغاء تحديد الكل": "Select / Deselect All",
    "تحديد الكل ✓": "Select All ✓",
    "تحكم كامل من الموبايل مثل الكمبيوتر: مسح الباركود، زيادة ونقصان الكميات، فحص الفروقات، وترحيل الجرد، وكل عملية تسمع وتحدث شاشة الكمبيوتر فوراً في نفس الثانية!": "Full mobile control like PC: scan barcodes, adjust quantities, check variances, and post stocktake with instant real-time sync!",
    "ترتيب الاسم والرقم": "Name & Number Order",
    "ترحيل (Enter ↵)": "Insert (Enter ↵)",
    "ترحيل فردي": "Single Post",
    "ترحيل واعتماد الاستورات المحددة": "Approve & Post Selected Stores",
    "ترحيل واعتماد الجرد لجميع الاستورات": "Approve & Post All Stores Stocktake",
    "تسمية الورقة والملف قبل الطباعة": "Sheet & File Naming Before Print",
    "تشغيل كشاف الجوال": "Toggle Flashlight",
    "تصدير أصناف الفاتورة الحالية": "Export Current Invoice Items",
    "تصدير الأصناف المحددة / المجمعة من البحث": "Export Selected / Search-Collected Items",
    "تصدير الأصناف المحددة إلى Excel": "Export Selected Items to Excel",
    "تصدير الأصناف المحددة بمربعات الاختيار أو الناتجة من البحث المتعدد": "Export items checked or collected from multi-search",
    "تصدير دليل الأصناف إلى Excel": "Export Item Catalog to Excel",
    "تصدير كافة الأصناف المسجلة في النظام بالحقول المحددة أعلاه فقط": "Export all registered items in the system with the selected fields above",
    "تصدير كامل دليل الأصناف (30,000+ صنف)": "Export Full Item Catalog (30,000+ items)",
    "تصدير كروت الأصناف إلى Excel – تحكم كامل بالحقول والنطاق": "Export Item Cards to Excel – Full Field & Scope Control",
    "تصدير كروت الأصناف الممسوحة في الفاتورة المفتوحة": "Export item cards scanned in the currently open invoice",
    "تصدير كروت الأصناف في ملف إكسيل باختيار الخانات والنطاق": "Export item cards to Excel with custom fields and scope",
    "تصفير الدفتري": "Reset System Stock",
    "تصفير سعر البيع والتكلفة والجملة": "Reset Selling, Cost & Wholesale Prices",
    "تصنيف الصنف": "Item Category",
    "تصنيف الصنف (دواء، مستلزم طبي...)": "Item Category (Medicine, Cosmetics...)",
    "تعبئة باسم الورقة": "Fill with Sheet Name",
    "تعبئة باسم الورقة (Sheet Name)": "Fill with Sheet Name",
    "تعديل بيانات بند الجرد": "Edit Stocktake Entry",
    "تعديل كرت الصنف": "Edit Item Card",
    "تفاصيل سيريالات السطر": "Line Serial Numbers Details",
    "تفريغ": "Clear",
    "تفريغ الاسم العربي والإنجليزي والمصنع": "Clear Arabic/English Names & Manufacturer",
    "تفريغ خانات الباركود مع إبقاء الاسم والأسعار": "Clear Barcodes Only (Keep Name & Prices)",
    "تفريغ كافة الحقول والباركودات للبدء من جديد": "Clear All Fields & Barcodes to Start Fresh",
    "تقرير الحقول التي ستتغير للأصناف الموجودة (القيم القديمة والجديدة):": "Fields to be Updated for Existing Items (Old vs. New Values):",
    "تقرير غير المجرود (Estimated Not Found)": "Uncounted Items Report (Estimated Not Found)",
    "تقسيم الوحدات": "Unit Subdivisions",
    "تقسيم الوحدات ومعامل التحويل بينها": "Unit Subdivisions & Conversion Factors",
    "تقسيم ومعامل تحويل الوحدات": "Unit Subdivisions & Conversion Factors",
    "تكلفة الاستور": "Store Cost",
    "تكلفة المخزون": "System Stock Cost",
    "تم استيراد الأصناف بنجاح!": "Items Imported Successfully!",
    "تنبيه معايير النظام:": "System Standards Notice:",
    "توثيق عملية الإرجاع": "Record Return Transaction",
    "توليد كود": "Generate Code",
    "توليد كود تلقائي جديد": "Generate New Auto Code",
    "تُحفظ مع الحفاظ على الأصفار في البداية": "Saved with leading zeros preserved",
    "تُعالج الإرجاعات أو الإلغاءات بعكس موثق للعملية دون حذف سجل السيريال لحفظ التدقيق والأمان.": "Returns/cancellations are processed as documented reversals without deleting serial logs for audit safety.",
    "جاري تحميل الأصناف...": "Loading items...",
    "جاري تحميل الاستورات...": "Loading stores...",
    "جاري تحميل تقرير الأصناف غير المجرودة...": "Loading uncounted items report...",
    "جاري توليد كود QR...": "Generating QR Code...",
    "جاهز لمسح الباركود والداتا ماتريكس بالاسكانر...": "Ready to scan Barcode & DataMatrix...",
    "جميع GTINs": "All GTINs",
    "جميع الأقسام": "All Categories",
    "جميع الباركودات": "All Barcodes",
    "حالة الباتش": "Batch Status",
    "حدد استورات معينة للترحيل من المربعات، أو اضغط زر الاعتماد الشامل:": "Check specific stores to post, or click Approve All Stores:",
    "حدد فقط الخانات التي تريد تصديرها وتحديثها لاحقاً، باللغة الإنجليزية ومن اليسار إلى اليمين": "Select only the columns you want to export (English LTR format)",
    "حذف": "Delete",
    "حذف الأصناف المحددة": "Delete Selected Items",
    "حذف الصنف": "Delete Item",
    "حذف جميع كروت الأصناف المحددة نهائياً من النظام": "Permanently delete all selected item cards from the system",
    "حذف رصيد المخزون": "Clear System Stock",
    "حذف كرت الصنف نهائياً": "Delete Item Card Permanently",
    "حذف كرت هذا الصنف نهائياً من قاعدة البيانات": "Permanently delete this item card from the database",
    "حذف وتصفير رصيد المخزون السابق بالكامل للتمكن من رفع ملف مخزون جديد": "Clear all previous system stock records to upload a new inventory file",
    "حسب المسميات المختارة في الجدول": "Use Custom Column Headers from Table",
    "حفظ الأصفار": "Keep Leading Zeros",
    "حفظ التعديل": "Save Changes",
    "حفظ الصنف وإضافته للفاتورة فوراً": "Save Item & Add to Invoice Immediately",
    "حفظ بطاقة الصنف": "Save Item Card",
    "حفظ كرت الصنف": "Save Item Card",
    "حفظ هذا التحديد كإعداد مفضل لاستخدامه دائماً": "Save selection as default preference",
    "خاضع للضريبة (VAT)": "VAT Taxable",
    "داتا ماتريكس (GS1 DataMatrix)": "GS1 DataMatrix",
    "داخل كرت الصنف وتجاهل باقي البيانات (SN, LOT, EXP, MFG).": "inside Item Card and ignore remaining fields (SN, LOT, EXP, MFG).",
    "دليل الاستورات المنشأة (Created)": "Created Stores Directory",
    "دواء، مستلزم طبي، تجميل...": "Medicine, Medical Supply, Cosmetics...",
    "ر.س": "SAR",
    "ربط الجوال كاسكانر باركود لاسلكي": "Pair Mobile as Wireless Barcode Scanner",
    "ربط الجوال واستخدامه كاسكانر لاسلكي": "Pair Mobile & Use as Wireless Scanner",
    "رسالة التنبيه": "Alert Message",
    "رصيد المخزون": "System Stock",
    "رصيد لم يُجرد": "Uncounted Stock",
    "رفع رصيد المخزون (Excel)": "Upload System Stock (Excel)",
    "رقم GTIN (14 رقماً) *": "GTIN Number (14 Digits) *",
    "رقم GTIN أو مسح كود GS1 QR...": "GTIN Number or Scan GS1 QR...",
    "رقم الباتش (Batch/LOT)": "Batch / LOT Number",
    "رقم الباتش (اختر المسمى)": "Batch Number (Select Header)",
    "رقم السيريال الخاص بالعبوة المرتجعة *": "Returned Package Serial Number *",
    "رقم الفاتورة": "Invoice Number",
    "رقم الفاتورة (اختياري)": "Invoice Number (Optional)",
    "سبب الإرجاع أو الإلغاء *": "Return or Cancellation Reason *",
    "سجل الفواتير المعتمدة والمسودات": "Approved & Draft Invoices History",
    "سجل الفواتير والإرجاعات": "Invoices & Returns Log",
    "سحب Excel": "Export Excel",
    "سحب Excel (1)": "Export Excel (1)",
    "سحب Excel (2)": "Export Excel (2)",
    "سحب Excel للاستور المختار": "Export Excel for Selected Store",
    "سحب الإكسيل الأول (الفاتورة): PRODUCT | NAME | SALES PRICE | BATCH NUMBER | QUANTITE | UNITPRICE | expiry-date": "Export Excel 1 (Invoice): PRODUCT | NAME | SALES PRICE | BATCH NUMBER | QUANTITE | UNITPRICE | expiry-date",
    "سحب الإكسيل الثاني (الجرد والكميات): Product | NAME ENGLISH | Location | Lot/Serial Number | Expiry Date | Counted quantity": "Export Excel 2 (Stock Count): Product | NAME ENGLISH | Location | Lot/Serial Number | Expiry Date | Counted quantity",
    "سحب بالمسميات المختارة": "Export Custom Columns",
    "سحب مستمر سريع ⚡": "Fast Continuous Scan ⚡",
    "سحب ملف Excel بناءً على المسميات التي اخترتها يدوياً من القوائم المنسدلة في رؤوس الأعمدة": "Export Excel using the custom column headers selected in the table",
    "سحب وجرد أصناف الاستور:": "Scan & Count Store Items:",
    "سعر البيع": "Selling Price",
    "سعر البيع (ر.س)": "Selling Price (SAR)",
    "سعر البيع (ر.س) *": "Selling Price (SAR) *",
    "سعر التكلفة": "Cost Price",
    "سعر التكلفة (ر.س)": "Cost Price (SAR)",
    "سعر التكلفة / الشراء": "Cost / Purchase Price",
    "سعر الجملة": "Wholesale Price",
    "سعر الجملة (Wholesale Price)": "Wholesale Price",
    "سعر الوحدة": "Unit Price",
    "سعر الوحدة / التكلفة": "Unit / Cost Price",
    "صفوف متخطاة (فارغة)": "Skipped Rows (Empty)",
    "صورة": "Photo",
    "ضبط المسميات على وضع الجرد (Lot/Serial Number / Counted quantity)": "Set headers to Stocktake Mode (Lot/Serial Number / Counted quantity)",
    "ضبط المسميات على وضع الفاتورة (BATCH NUMBER / QUANTITE)": "Set headers to Invoice Mode (BATCH NUMBER / QUANTITE)",
    "طباعة الاستور": "Print Store",
    "طباعة التقرير (Ctrl+P)": "Print Report (Ctrl+P)",
    "طباعة الفاتورة": "Print Invoice",
    "طباعة الفاتورة الحالية مع لوجو RAMADAN والعنوان البارز في كل الصفحات": "Print current invoice with RAMADAN logo and prominent title on all pages",
    "عبوة تالفة، إرجاع عميل، خطأ في الفاتورة...": "Damaged package, customer return, invoice error...",
    "عدد الأصناف": "Items Count",
    "عرض 0 من 0 صنف": "Showing 0 of 0 items",
    "علبة، شريط، حبة...": "Box, Strip, Tablet...",
    "عمليات الاستور المحدد:": "Selected Store Operations:",
    "عمود": "Column",
    "عمود التجميع الاختياري للصنف": "Optional Item Grouping Column",
    "فتح بطاقة الصنف بالكامل": "Open Full Item Card",
    "فتح فاتورة جديدة": "Create New Invoice",
    "فتح لوحة اختيار الاسم والرقم من 1 إلى 50": "Open Name & Number Selector (1-50)",
    "فرق التكلفة": "Cost Variance",
    "قيم GTIN المسجلة": "Registered GTINs",
    "قيم متعارضة مكتشفة": "Conflicting Values Detected",
    "كامل الدليل": "Full Catalog",
    "كاميرا": "Camera",
    "كشاف": "Flash",
    "كشف بالأصناف والتشغيلات المسجلة دفترياً بالمخزون ولم يتم جردها أو العثور عليها بالاستور مع إمكانية البحث والفلترة والطباعة المباشرة.": "List of items and batches recorded in system stock that were not counted in the store, with search, filter, and print.",
    "كود الصنف": "Product Code",
    "كود الصنف (مطابق للإكسيل)": "Product Code (Matches Excel)",
    "كود الصنف الداخلي (Product Code / Internal Reference) *": "Internal Product Code (Internal Reference) *",
    "كود الصنف الداخلي (اختياري)": "Internal Product Code (Optional)",
    "كود النظام": "System Code",
    "كود:": "Code:",
    "لا توجد أصناف مجرودة في هذا الاستور حتى الآن. ابدأ المسح بالاسكانر مباشرة!": "No items counted in this store yet. Start scanning right away!",
    "لا توجد استورات مجرودة حتى الآن. اضغط \"📥 بدء الجرد\" على أي استور لبدء مسحه!": "No counted stores yet. Click \"📥 Start Count\" on any store to begin!",
    "لا توجد عبوات ممسوحة في هذه الفاتورة حتى الآن": "No packages scanned in this invoice yet",
    "لتجميع صفوف الملف لنفس الصنف (الكود الداخلي يبقى مولداً من النظام)": "To group file rows for the same item (internal code remains system-generated)",
    "لحذف عبوة أضيفت بالخطأ، اضغط على زر الحذف بجانب السيريال ليتم حذفه من تفاصيل الفاتورة وإعادة احتساب الكمية تلقائياً.": "To remove a package added by mistake, click delete next to its serial number to remove it and recalculate quantity.",
    "لحظي ⚡": "Live ⚡",
    "م": "#",
    "متابعة للطباعة بهذا الاسم": "Proceed to Print with this Name",
    "متزامن عبر نفق Cloudflare": "Synced via Cloudflare Tunnel",
    "مثال: 0000094684": "e.g., 0000094684",
    "مثال: GSK / GlaxoSmithKline": "e.g., GSK / GlaxoSmithKline",
    "مثال: MEDICINE 1 أو 1 COSMETICS أو MILK أو DIAPER 1": "e.g., MEDICINE 1 or 1 COSMETICS or MILK or DIAPER 1",
    "مثال: PANADOL EXTRA 500MG": "e.g., PANADOL EXTRA 500MG",
    "مثال: Paracetamol / Caffeine": "e.g., Paracetamol / Caffeine",
    "مثال: بنادول إكسترا 500 ملغ": "e.g., Panadol Extra 500mg",
    "مثال: علبة = 1، شريط = 10، حبة = 100": "e.g., Box = 1, Strip = 10, Tablet = 100",
    "مزامنة سحابية لحظية ⚡": "Real-time Cloud Sync ⚡",
    "مسح": "Scan",
    "مسح الأسعار والضريبة فقط": "Clear Prices & Tax Only",
    "مسح الأسماء والتصنيف فقط": "Clear Names & Category Only",
    "مسح الأصناف": "Clear Items",
    "مسح الباركودات و GTIN فقط": "Clear Barcodes & GTIN Only",
    "مسح التسمية": "Clear Title",
    "مسح الخانات": "Clear Fields",
    "مسح الدليل بالكامل": "Clear Entire Catalog",
    "مسح بالكاميرا المباشرة": "Live Camera Scan",
    "مسح بكاميرا الجهاز مباشرة (باركود • كيو ار • داتاماتريكس)": "Direct Device Camera Scan (Barcode • QR • DataMatrix)",
    "مسح كرت الصنف كاملاً": "Clear Entire Item Card",
    "مسح كود GS1 QR باستخدام الكاميرا أو الماسح": "Scan GS1 QR via Camera or Scanner",
    "مسح نتائج البحث": "Clear Search Results",
    "مسح نتائج البحث المجمعة والعودة للدليل الكامل": "Clear collected search results and return to full catalog",
    "مسح وتفريغ جميع أصناف الفاتورة بالكامل للبدء من جديد": "Clear all invoice items to start fresh",
    "مسح وتفريغ كرت الصنف كاملاً أو بعض الخانات": "Clear entire item card or specific fields",
    "مسح وتفريغ كروت الأصناف بالكامل من النظام": "Delete and clear all item cards from the system",
    "مسودة نشطة": "Active Draft",
    "مطابق لملف الإكسيل تماماً (مثل: 0000094684) أو اضغط توليد كود": "Matches Excel file (e.g., 0000094684) or click Generate Code",
    "معالج استيراد بطاقات الأصناف من ملف Excel بصيغة XLSX": "Item Cards Excel (XLSX) Import Wizard",
    "معالجة إرجاع عبوة موثق (Returns Management)": "Documented Package Return (Returns Management)",
    "معاينة الأصناف الجاهزة (يُظهر الكود الداخلي المولد رقمياً من النظام وحالة العملية):": "Ready Items Preview (Shows system code & operation type):",
    "معاينة الاستيراد والتحقق من التعارضات": "Preview Import & Check Conflicts",
    "ملء الشاشة": "Fullscreen",
    "ملخص العملية": "Operation Summary",
    "ملف تقرير الأصناف التي لم تُجرد (Estimated Not Found)": "Uncounted Items Report (Estimated Not Found)",
    "نسبة الضريبة (%)": "Tax Rate (%)",
    "نسبة الضريبة (البديهي 0)": "Tax Rate (Default 0)",
    "نسخ 📋": "Copy 📋",
    "نظام إدارة الأصناف والمسح بكود QR": "QR Scanner & Inventory Management System",
    "نظام إدارة بطاقات الأصناف والمسح بكود QR": "QR Scanner & Item Cards Management System",
    "نمط الأعمدة:": "Columns Mode:",
    "نمط البحث": "Search Mode",
    "نوع العملية": "Operation Type",
    "هذا الـ GTIN (": "This GTIN (",
    "وجه كاميرا هاتفك العادية نحو المربع أعلاه لفتحه فوراً": "Point your phone camera at the QR code above to open immediately",
    "وحدة البيع الأساسية": "Primary Selling Unit",
    "وحدة البيع الأساسية (مثل علبة)": "Primary Selling Unit (e.g., Box)",
    "وضع الإضافة التراكمية (الافتراضي)": "Cumulative Append Mode (Default)",
    "وضع الاستبدال الصريح (Replace Mode)": "Explicit Replace Mode",
    "وضع الجرد": "Stock Mode",
    "وضع الجرد (Product / Counted quantity)": "Stock Mode (Product / Counted quantity)",
    "وضع الفاتورة": "Invoice Mode",
    "وضع الفاتورة (7 أعمدة كاملة)": "Invoice Mode (Full 7 Columns)",
    "وضع تحديث الباركود و GTIN عند وجود الصنف مسبقاً في النظام:": "Barcode & GTIN Update Mode when item already exists:",
    "يدعم ملفات الأصناف الضخمة والتقارير بمختلف الصيغ": "Supports large catalog files and reports in multiple formats",
    "يرجى السماح بالوصول للكاميرا من إعدادات المتصفح": "Please allow camera access in browser settings",
    "يقرأ النظام أعمدة الملف ويعرض خانات بطاقة الصنف، ويقوم المستخدم باختيار عمود كل خانة يدويًا بدون ربط تلقائي. يتم توليد الكود الداخلي النهائي تلقائيًا من النظام.": "Reads file columns and displays item card fields for manual column mapping. System codes are auto-generated if needed.",
    "● باركود 1D": "● 1D Barcode",
    "● داتاماتريكس دولي (GS1)": "● GS1 DataMatrix",
    "● كود QR": "● QR Code",
    "⚡ استوكات وتشغيلات الصنف": "⚡ Item Stock & Batches",
    "⚡ وجّه الكود داخل الإطار للمسح الفوري": "⚡ Align code inside frame for instant scan",
    "✅ آخر قراءة ناجحة:": "✅ Last Successful Scan:",
    "✅ اعتماد": "✅ Approve",
    "➕ فاتورة جديدة": "➕ New Invoice",
    "⭐ حفظ كمفضل": "⭐ Save Default",
    "🌐 أعمدة الـ GTIN (يمكن اختيار أكثر من عمود)": "🌐 GTIN Columns (Multiple Allowed)",
    "🏷️ أعمدة الباركود (يمكن اختيار أكثر من عمود)": "🏷️ Barcode Columns (Multiple Allowed)",
    "🏷️ تسمية الورقة (1-50):": "🏷️ Sheet Title (1-50):",
    "💡 اضغط": "💡 Press",
    "💡 سيتم حفظ كرت الصنف فوراً وتوليد كود داخلي وإضافته للفاتورة بالباتش والسيريال الممسوح.": "💡 Item card will be saved immediately and added to the invoice with the scanned batch & serial.",
    "📦 الجرد": "📦 Stocktake",
    "📸 صورة بالكاميرا": "📸 Camera Snapshot",
    "🔢 لوحة (1-50)": "🔢 Grid (1-50)",
    "(يمكن التمرير بالماوس أو الأسهم)": "(Scroll with mouse or arrow keys)",
    "0 محدد": "0 Selected",
    "Grand Totals (الإجماليات العامة للمطابقة):": "Grand Totals:",
    "STORE STOCKTAKE / كشف جرد الاستور": "STORE STOCKTAKE REPORT",
    "Total Quantity (إجمالي الكمية):": "Total Quantity:",
    "| كمية:": "| Qty:",
    "أرقام الباركود المسجلة للصنف": "Registered Item Barcodes",
    "أرقام بند التجارة العالمي (GTIN) للصنف": "Registered Item GTINs",
    "أصناف لم تُجرد": "Uncounted Items",
    "إجمالي الأصناف التي لم تُجرد:": "Total Uncounted Items:",
    "إضافة": "Add",
    "إضافة الأصناف المحددة": "Add Selected Items",
    "إضافة المحدد": "Add Selected",
    "إضافي": "Extra",
    "إظهار السيريالات": "Show Serials",
    "إغلاق ✕": "Close ✕",
    "اختيار سريع:": "Quick Select:",
    "اسم الصنف": "Item Name",
    "اضغط": "Press",
    "اضغط هنا أو اسحب وأفلت ملف إكسيل الأصناف (.xlsx)": "Click here or drag & drop items Excel file (.xlsx)",
    "الأصناف (Items)": "Items",
    "الإجمالي": "Total",
    "الباتش": "Batch",
    "الصلاحية": "Expiry",
    "الكرت": "Card",
    "الكمية (Qty)": "Quantity (Qty)",
    "بانتظار بدء عمليات المسح...": "Waiting for scans to begin...",
    "بيع الجرد": "Counted Sales",
    "تحديث صنف": "Update Item",
    "تحديد الكل": "Select All",
    "ترحيل": "Post",
    "تصغير الشاشة": "Exit Fullscreen",
    "تعديل مسمى الورقة:": "Edit Sheet Title:",
    "تقرير العجز / الأصناف التي لم تُجرد": "Shortage / Uncounted Items Report",
    "تكلفة الجرد": "Counted Cost",
    "تم النسخ": "Copied",
    "تم منع التكرار:": "Duplicate Prevented:",
    "جاري التحميل...": "Loading...",
    "جاري تحميل الفواتير...": "Loading invoices...",
    "جاري قراءة ملف Excel وفحص الأعمدة...": "Reading Excel file and inspecting columns...",
    "جديد": "New",
    "حذف العبوة": "Delete Package",
    "حسب المسميات المختارة": "Custom Selected Headers",
    "صنف جديد": "New Item",
    "عرض الكرت": "View Card",
    "غير خاضع": "Non-Taxable (0%)",
    "غير خاضع للضريبة": "Non-Taxable (0%)",
    "خاضع للضريبة VAT": "VAT Taxable",
    "خاضع للضريبة": "VAT Taxable",
    "قيد الجرد": "Counting in Progress",
    "كمية المخزون المفقودة": "Missing Stock Quantity",
    "لإدراج كافة النتائج في الجدول مباشرة، أو حدد أصنافاً واضغط": "to insert all results directly into the table, or select items and press",
    "لإدراجها فقط": "to insert selected only",
    "لا توجد أرقام مسجلة لهذا الصنف": "No codes registered for this item",
    "لا توجد أصناف مجرودة في هذا الاستور حتى الآن": "No items counted in this store yet",
    "لا توجد أصناف مطابقة للبحث أو تم جرد جميع الأصناف بنجاح! 🎉": "No matching items found, or all items have been counted! 🎉",
    "لا توجد أصناف ممسوحة في هذه الفاتورة": "No items scanned in this invoice",
    "لا توجد استورات جارية حتى الآن.": "No active stores currently.",
    "لا توجد استورات مطابقة. اضغط NEW STORE لإنشاء استور جديد.": "No matching stores. Click NEW STORE to create one.",
    "لا توجد حقول سيتم تعديلها للأصناف القائمة (لا توجد فروقات أو كل الحقول متطابقة أو أصناف جديدة).": "No fields will be modified for existing items (no differences or all items are new).",
    "لا توجد سيريالات مسجلة لهذا السطر": "No serials registered for this line",
    "لا توجد فواتير مسجلة حتى الآن": "No invoices recorded yet",
    "لم يتم العثور على أصناف مطابقة": "No matching items found",
    "لم يتم العثور على أي صنف يطابق \"": "No item found matching \"",
    "مسودة": "Draft",
    "مضاف": "Added",
    "مطابق ✅": "Matched ✅",
    "مطلوب يدوياً ⚠️": "Manual Required ⚠️",
    "معتمدة": "Approved",
    "مكتمل ومرحل": "Completed & Posted",
    "نسخ": "Copy",
    "وضع الجرد (2 - Counted quantity)": "Stock Mode (2 - Counted quantity)",
    "وضع الفاتورة (1)": "Invoice Mode (1)",
    "يدعم ملفات الأصناف الضخمة حتى مئات الآلاف من الصفوف": "Supports large catalog files up to hundreds of thousands of rows",
    "⚠️ باتش جديد": "⚠️ New Batch",
    "⚠️ تشغيلة جديدة": "⚠️ New Batch",
    "✕ إغلاق": "✕ Close",
    "🏷️ العنوان البارز (1-50):": "🏷️ Prominent Title (1-50):",
    "📍 الفرع (Location):": "📍 Branch (Location):",
    "🔍 عرض": "🔍 View",
    "🖨️ شكل الجدول:": "🖨️ Table Layout:",
    "🖨️ طباعة الآن": "🖨️ Print Now",
    "🖨️ طباعة الآن (Ctrl + P)": "🖨️ Print Now (Ctrl + P)",
    "🖨️ طباعة تقرير الأصناف غير المجرودة (Ctrl + P)": "🖨️ Print Uncounted Items Report (Ctrl + P)",
    "🖼️ تغيير اللوجو": "🖼️ Change Logo",
    "معمم": "Contains",
    "بحث معمم": "Contains Search",
    "بحث بالبداية": "Starts-With Search",
    "تعديل": "Edit",
    "طباعة": "Print",
    "تصدير": "Export",
    "بدء الجرد": "Start Count",
    "📥 بدء الجرد": "📥 Start Count",
    "عجز": "Shortage",
    "زيادة": "Surplus",
    "مطابق": "Matched"
};
const RAMBFE_ARABIC_RE = /[\u0600-\u06FF]/;
let currentAppLang = localStorage.getItem('rambfe_app_lang') || 'ar';
let i18nObserver = null;
let isApplyingI18n = false;

function translateArabicStringToEnglish(rawStr) {
    if (!rawStr || !RAMBFE_ARABIC_RE.test(rawStr)) return rawStr;
    const trimmed = rawStr.replace(/\s+/g, ' ').trim();
    if (!trimmed) return rawStr;

    // 1. مطابقة تامة في القاموس
    if (RAMBFE_I18N_MAP[trimmed]) {
        const lead = rawStr.match(/^\s*/)[0];
        const trail = rawStr.match(/\s*$/)[0];
        return lead + RAMBFE_I18N_MAP[trimmed] + trail;
    }

    // 2. أنماط ديناميكية متكررة (الأرقام والعملات والعدادات)
    let out = trimmed;
    out = out.replace(/^عرض\s+(\d+)\s+من\s+(\d+)\s+صنف$/, 'Showing $1 of $2 items');
    out = out.replace(/^([\d,.]+)\s*ر\.س$/, '$1 SAR');
    out = out.replace(/^(\d+)\s*استور$/, '$1 Stores');
    out = out.replace(/^(\d+)\s*بند$/, '$1 Lines');
    out = out.replace(/^(\d+)\s*صنف معدل$/, '$1 Modified Items');
    out = out.replace(/^(\d+)\s*صنف$/, '$1 Items');
    out = out.replace(/^(\d+)\s*مجمعة$/, '$1 Collected');
    out = out.replace(/^(\d+)\s*محدد$/, '$1 Selected');
    out = out.replace(/^كود:\s*(.+)$/, 'Code: $1');
    out = out.replace(/^الاستور النشط:\s*(.+)$/, 'Active Store: $1');
    out = out.replace(/^📊 جاري سحب الإكسيل وحفظ الملف \(الفرع:\s*(.+?)\)\.\.\.$/, '📊 Exporting Excel file (Branch: $1)...');
    out = out.replace(/^📊 جاري سحب الإكسيل(.+)$/, '📊 Exporting Excel file...');

    if (out !== trimmed) {
        const lead = rawStr.match(/^\s*/)[0];
        const trail = rawStr.match(/\s*$/)[0];
        return lead + out + trail;
    }

    return rawStr;
}

function applyI18nToSubtree(rootEl) {
    if (!rootEl || isApplyingI18n) return;
    isApplyingI18n = true;
    try {
        const isEn = (currentAppLang === 'en');

        // 1. ترجمة خصائص placeholder و title
        const els = rootEl.querySelectorAll ? [rootEl, ...rootEl.querySelectorAll('[placeholder], [title]')] : [];
        for (const el of els) {
            if (!el || !el.getAttribute) continue;
            if (el.getAttribute('data-no-i18n') === '1') continue;

            // placeholder
            const ph = el.getAttribute('placeholder');
            if (ph !== null) {
                if (isEn) {
                    if (RAMBFE_ARABIC_RE.test(ph)) {
                        el.setAttribute('data-orig-ar-ph', ph);
                        const tr = translateArabicStringToEnglish(ph);
                        if (tr !== ph) el.setAttribute('placeholder', tr);
                    }
                } else {
                    const origPh = el.getAttribute('data-orig-ar-ph');
                    if (origPh) el.setAttribute('placeholder', origPh);
                }
            }

            // title
            const tt = el.getAttribute('title');
            if (tt !== null) {
                if (isEn) {
                    if (RAMBFE_ARABIC_RE.test(tt)) {
                        el.setAttribute('data-orig-ar-title', tt);
                        const tr = translateArabicStringToEnglish(tt);
                        if (tr !== tt) el.setAttribute('title', tr);
                    }
                } else {
                    const origTt = el.getAttribute('data-orig-ar-title');
                    if (origTt) el.setAttribute('title', origTt);
                }
            }
        }

        // 2. ترجمة عقد النصوص (Text Nodes)
        const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, null);
        let node;
        while ((node = walker.nextNode())) {
            const parent = node.parentElement;
            if (!parent) continue;
            const tag = parent.tagName;
            if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEXTAREA') continue;
            if (parent.getAttribute('data-no-i18n') === '1' || parent.id === 'lang-btn-label') continue;

            const val = node.nodeValue;
            if (isEn) {
                if (val && RAMBFE_ARABIC_RE.test(val)) {
                    const tr = translateArabicStringToEnglish(val);
                    if (tr !== val) {
                        node._origAr = val;
                        node.nodeValue = tr;
                    }
                }
            } else {
                if (node._origAr !== undefined) {
                    node.nodeValue = node._origAr;
                }
            }
        }
    } finally {
        isApplyingI18n = false;
    }
}

function setAppLanguage(lang) {
    currentAppLang = (lang === 'en') ? 'en' : 'ar';
    try {
        localStorage.setItem('rambfe_app_lang', currentAppLang);
    } catch (e) {}

    document.documentElement.lang = currentAppLang;
    document.documentElement.dir = (currentAppLang === 'en') ? 'ltr' : 'rtl';
    document.title = (currentAppLang === 'en')
        ? 'RAMBFE Pro - QR Scanner & Item Cards System'
        : 'نظام إدارة بطاقات الأصناف والمسح بكود QR';

    const lbl = document.getElementById('lang-btn-label');
    if (lbl) {
        lbl.textContent = (currentAppLang === 'en') ? 'العربية' : 'English';
    }

    applyI18nToSubtree(document.body);
}
window.setAppLanguage = setAppLanguage;

function toggleAppLanguage() {
    setAppLanguage(currentAppLang === 'en' ? 'ar' : 'en');
}
window.toggleAppLanguage = toggleAppLanguage;

function initLanguageSystem() {
    let btn = document.getElementById('btn-toggle-lang');
    if (!btn) {
        const fsBtn = document.getElementById('btn-toggle-fullscreen');
        if (fsBtn && fsBtn.parentElement) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.id = 'btn-toggle-lang';
            btn.className = 'inline-flex items-center gap-1.5 px-3 py-1 rounded-xl bg-amber-400 hover:bg-amber-300 text-slate-950 border border-amber-300 text-xs font-black transition shadow-sm cursor-pointer select-none';
            btn.title = 'تغيير لغة البرنامج / Switch Language (AR / EN)';
            btn.innerHTML = '<span>🌐</span><span id="lang-btn-label" data-no-i18n="1">English</span>';
            fsBtn.parentElement.insertBefore(btn, fsBtn);
        }
    }
    if (btn && !btn._boundLangClick) {
        btn._boundLangClick = true;
        btn.addEventListener('click', toggleAppLanguage);
    }

    if (!i18nObserver && document.body) {
        i18nObserver = new MutationObserver((mutations) => {
            if (currentAppLang !== 'en' || isApplyingI18n) return;
            for (const m of mutations) {
                if (m.type === 'childList') {
                    m.addedNodes.forEach(n => {
                        if (n.nodeType === 1) {
                            applyI18nToSubtree(n);
                        } else if (n.nodeType === 3 && n.parentElement) {
                            applyI18nToSubtree(n.parentElement);
                        }
                    });
                } else if (m.type === 'characterData' && m.target && m.target.parentElement) {
                    applyI18nToSubtree(m.target.parentElement);
                } else if (m.type === 'attributes' && m.target) {
                    applyI18nToSubtree(m.target);
                }
            }
        });
        i18nObserver.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['placeholder', 'title']
        });
    }

    setAppLanguage(currentAppLang);
}


// ==================== محرك مراقبة الاتصال وسلامة قاعدة البيانات (24/7 Safe Reconnect) ====================
let _serverConnectionLost = false;
let _reconnectHealthTimer = null;
let _idleHealthCheckTimer = null;

function ensureConnectionBannerEl() {
    let el = document.getElementById('rambfe-conn-banner');
    if (!el) {
        el = document.createElement('div');
        el.id = 'rambfe-conn-banner';
        el.className = 'hidden fixed top-2 left-1/2 -translate-x-1/2 z-[9999] px-4 py-2 rounded-xl shadow-lg border text-xs sm:text-sm font-bold flex items-center gap-2 transition-all duration-300';
        document.body.appendChild(el);
    }
    return el;
}

function updateConnectionBanner(state, message = '') {
    const el = ensureConnectionBannerEl();
    if (state === 'online') {
        if (_serverConnectionLost) {
            _serverConnectionLost = false;
            el.className = 'fixed top-2 left-1/2 -translate-x-1/2 z-[9999] px-4 py-2 rounded-xl shadow-lg border bg-emerald-600 text-white border-emerald-400 text-xs sm:text-sm font-bold flex items-center gap-2';
            el.innerHTML = '<span>✅</span><span>تم استعادة الاتصال بالسيرفر وقاعدة البيانات بنجاح</span>';
            setTimeout(() => { el.classList.add('hidden'); }, 3500);
            // تحديث التبويب النشط بهدوء بعد استعادة الاتصال
            try {
                refreshSystemStats();
                if (typeof currentTab !== 'undefined') {
                    if (currentTab === 'catalog') loadCatalogProducts();
                    else if (currentTab === 'invoices') loadInvoicesList();
                    else if (currentTab === 'stocktake') loadStocktakeStores();
                    else if (currentTab === 'scanner') loadActiveDraftInvoice();
                }
            } catch (_) {}
        } else {
            el.classList.add('hidden');
        }
        return;
    }

    _serverConnectionLost = true;
    if (state === 'db_error') {
        el.className = 'fixed top-2 left-1/2 -translate-x-1/2 z-[9999] px-4 py-2 rounded-xl shadow-lg border bg-rose-700 text-white border-rose-400 text-xs sm:text-sm font-bold flex items-center gap-2';
        el.innerHTML = `<span>🛡️</span><span>${message || 'تم إيقاف الكتابة مؤقتاً لحماية قاعدة البيانات — راجع السجلات'}</span>`;
    } else {
        el.className = 'fixed top-2 left-1/2 -translate-x-1/2 z-[9999] px-4 py-2 rounded-xl shadow-lg border bg-amber-500 text-slate-950 border-amber-300 text-xs sm:text-sm font-bold flex items-center gap-2';
        el.innerHTML = `<span>⏳</span><span>${message || 'جاري تجديد الاتصال بالسيرفر المحلي... بياناتك محفوظة بأمان ولن تُمسح'}</span>`;
    }
    scheduleReconnectProbe();
}

function scheduleReconnectProbe() {
    if (_reconnectHealthTimer) return;
    _reconnectHealthTimer = setInterval(async () => {
        try {
            const res = await fetchHealthWithTimeout();
            const data = await res.json().catch(() => ({}));
            if (res.ok && data && data.healthy) {
                clearInterval(_reconnectHealthTimer);
                _reconnectHealthTimer = null;
                _healthFailStreak = 0;
                updateConnectionBanner('online');
            } else if (data && data.db_error) {
                updateConnectionBanner('db_error', data.message || data.error);
            }
        } catch (_) {}
    }, 3500);
}

// لا نُظهر شريط "جاري تجديد الاتصال" بسبب فشل لحظي واحد (استيقاظ الجهاز من السكون، عملية ثقيلة، تأخر الشبكة):
// يظهر فقط إذا ظل الخادم غير متاح عبر عدة فحوصات متتالية (حوالي 15 ثانية).
const HEALTH_FAILS_BEFORE_BANNER = 3;
const HEALTH_RETRY_MS = 5000;
let _healthFailStreak = 0;
let _healthRetryTimer = null;
let _healthCheckInFlight = null;

function fetchHealthWithTimeout(ms = 15000) {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ctrl ? setTimeout(() => ctrl.abort(), ms) : null;
    return fetch('/api/health', { cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
        .finally(() => { if (t) clearTimeout(t); });
}

function checkServerHealthSilent() {
    if (_healthCheckInFlight) return _healthCheckInFlight;
    _healthCheckInFlight = (async () => {
        let data = {};
        try {
            const res = await fetchHealthWithTimeout();
            data = await res.json().catch(() => ({}));
            if (res.ok && data && data.healthy) {
                _healthFailStreak = 0;
                if (_healthRetryTimer) { clearTimeout(_healthRetryTimer); _healthRetryTimer = null; }
                if (_serverConnectionLost) updateConnectionBanner('online');
                return true;
            }
            if (data && data.db_error) {
                updateConnectionBanner('db_error', data.message || data.error);
                return false;
            }
        } catch (_) {}
        _healthFailStreak++;
        if (_healthFailStreak >= HEALTH_FAILS_BEFORE_BANNER) {
            updateConnectionBanner('offline', data && data.message ? data.message : '');
        } else if (!_healthRetryTimer) {
            _healthRetryTimer = setTimeout(() => { _healthRetryTimer = null; checkServerHealthSilent(); }, HEALTH_RETRY_MS);
        }
        return false;
    })().finally(() => { _healthCheckInFlight = null; });
    return _healthCheckInFlight;
}

function initConnectionHealthMonitor() {
    if (_idleHealthCheckTimer) clearInterval(_idleHealthCheckTimer);
    _idleHealthCheckTimer = setInterval(() => {
        if (!document.hidden) checkServerHealthSilent();
    }, 25000);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) checkServerHealthSilent();
    });
    window.addEventListener('focus', () => checkServerHealthSilent());
    window.addEventListener('online', () => checkServerHealthSilent());
}

function isUnavailableApiResponse(res, data) {
    if (!res || !res.ok) {
        if (data && data.db_error) updateConnectionBanner('db_error', data.message || data.error);
        else if (res && res.status === 503 && data && data.message) updateConnectionBanner('offline', data.message);
        else if (res && res.status === 503) checkServerHealthSilent(); // نتأكد أولاً بدل إظهار الشريط فوراً
        return true;
    }
    if (data && data.offline_reconnecting) {
        updateConnectionBanner('offline', data.message || '');
        return true;
    }
    if (data && data.db_error) {
        updateConnectionBanner('db_error', data.message || '');
        return true;
    }
    if (_serverConnectionLost) {
        updateConnectionBanner('online');
    }
    return false;
}

document.addEventListener('DOMContentLoaded', () => {
    initConnectionHealthMonitor();
    initLanguageSystem();
    initNavigation();
    initScannerTab();
    initCatalogTab();
    initImportTab();
    initInvoicesTab();
    initStocktakeTab();
    refreshSystemStats();
    loadActiveDraftInvoice();
    loadCatalogProducts();
});

// ==================== التبديل بين التبويبات ====================
function initNavigation() {
    const tabs = [
        { id: 'scanner', btn: 'nav-btn-scanner', mobBtn: 'mob-nav-scanner', section: 'tab-scanner' },
        { id: 'catalog', btn: 'nav-btn-catalog', mobBtn: 'mob-nav-catalog', section: 'tab-catalog' },
        { id: 'import', btn: 'nav-btn-import', mobBtn: 'mob-nav-import', section: 'tab-import' },
        { id: 'invoices', btn: 'nav-btn-invoices', mobBtn: 'mob-nav-invoices', section: 'tab-invoices' },
        { id: 'stocktake', btn: 'nav-btn-stocktake', mobBtn: 'mob-nav-stocktake', section: 'tab-stocktake' }
    ];

    tabs.forEach(t => {
        const btnEl = document.getElementById(t.btn);
        if (btnEl) {
            btnEl.addEventListener('click', () => switchTab(t.id));
        }
        const mobEl = document.getElementById(t.mobBtn);
        if (mobEl) {
            mobEl.addEventListener('click', () => {
                switchTab(t.id);
                window.scrollTo({ top: 0, behavior: 'smooth' });
            });
        }
    });

    document.getElementById('btn-goto-import-tab')?.addEventListener('click', () => switchTab('import'));
    document.getElementById('btn-report-view-catalog')?.addEventListener('click', () => switchTab('catalog'));

    // زر ملء الشاشة للكمبيوتر واللابتوب (Toggle Fullscreen)
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

    // زر المسح السريع بكاميرا الهاتف
    document.getElementById('btn-mobile-quick-scan')?.addEventListener('click', () => {
        if (typeof openCameraModal === 'function') {
            const mode = (currentTab === 'stocktake') ? 'stocktake' : 'invoice';
            openCameraModal(mode);
        }
    });
}

function switchTab(tabId) {
    currentTab = tabId;
    const tabMap = {
        'scanner': { btn: 'nav-btn-scanner', mobBtn: 'mob-nav-scanner', sec: 'tab-scanner' },
        'catalog': { btn: 'nav-btn-catalog', mobBtn: 'mob-nav-catalog', sec: 'tab-catalog' },
        'import': { btn: 'nav-btn-import', mobBtn: 'mob-nav-import', sec: 'tab-import' },
        'invoices': { btn: 'nav-btn-invoices', mobBtn: 'mob-nav-invoices', sec: 'tab-invoices' },
        'stocktake': { btn: 'nav-btn-stocktake', mobBtn: 'mob-nav-stocktake', sec: 'tab-stocktake' }
    };

    Object.keys(tabMap).forEach(k => {
        const item = tabMap[k];
        const btn = document.getElementById(item.btn);
        const mobBtn = document.getElementById(item.mobBtn);
        const sec = document.getElementById(item.sec);
        if (k === tabId) {
            btn?.classList.add('bg-indigo-600', 'text-white', 'shadow');
            btn?.classList.remove('text-slate-300');
            sec?.classList.remove('hidden');

            mobBtn?.classList.add('text-indigo-400', 'font-black');
            mobBtn?.classList.remove('text-slate-400');
        } else {
            btn?.classList.remove('bg-indigo-600', 'text-white', 'shadow');
            btn?.classList.add('text-slate-300');
            sec?.classList.add('hidden');

            mobBtn?.classList.remove('text-indigo-400', 'font-black');
            mobBtn?.classList.add('text-slate-400');
        }
    });

    if (tabId === 'catalog') {
        loadCatalogProducts();
    } else if (tabId === 'invoices') {
        loadInvoicesList();
    } else if (tabId === 'scanner') {
        document.getElementById('scan-datamatrix-input')?.focus();
    } else if (tabId === 'stocktake') {
        loadStocktakeStores();
        setTimeout(() => document.getElementById('stk-scan-input')?.focus(), 100);
    }
    refreshSystemStats();
}

async function refreshSystemStats() {
    try {
        const res = await fetch('/api/stats', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (isUnavailableApiResponse(res, data)) return;
        document.getElementById('header-products-count').textContent = (data.products_count || 0).toLocaleString();
        document.getElementById('header-products-badge').textContent = (data.products_count || 0).toLocaleString();
        document.getElementById('header-barcodes-count').textContent = (data.barcodes_count || 0).toLocaleString();
    } catch (e) {
        console.error('Failed to load stats', e);
    }
}

let lastScannedQr = '';
let lastScannedGtin = '';

function formatExpiryDisplay(dateStr) {
    if (!dateStr) return '';
    const parts = dateStr.trim().split('-');
    if (parts.length === 3 && parts[0].length === 4) {
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
    }
    return dateStr;
}

// خريطة تحويل ضغطات قارئ الباركود عند ضبط لغة لوحة المفاتيح في Windows على العربية
const ARABIC_KEYBOARD_MAP = {
    // أحرف وحركات الشفت (Arabic Shifted keys) -> الحروف الإنجليزية الكبيرة
    'َ': 'Q', 'ً': 'W', 'ُ': 'E', 'ٌ': 'R', 'لإ': 'T', 'إ': 'Y', '‘': 'U', '÷': 'I', '×': 'O', '؛': 'P',
    'ِ': 'A', 'ٍ': 'S', ']': 'D', '[': 'F', 'لأ': 'G', 'أ': 'H', 'ـ': 'J', '،': 'K', '/': 'L',
    '~': 'Z', 'ْ': 'X', '}': 'C', '{': 'V', 'لآ': 'B', 'آ': 'N', '’': 'M', '؟': '?',
    // الحروف العربية العادية (Arabic Unshifted keys)
    'ض': 'q', 'ص': 'w', 'ث': 'e', 'ق': 'r', 'ف': 't', 'غ': 'y', 'ع': 'u', 'ه': 'i', 'خ': 'o', 'ح': 'p',
    'ج': '[', 'د': ']', 'ش': 'a', 'س': 's', 'ي': 'd', 'ب': 'f', 'ل': 'g', 'ا': 'h', 'ت': 'j', 'ن': 'k',
    'م': 'l', 'ك': ';', 'ط': '\'', 'ئ': 'z', 'ء': 'x', 'ؤ': 'c', 'ر': 'v', 'لا': 'b', 'ى': 'n', 'ة': 'm',
    'و': ',', 'ز': '.', 'ظ': '/', 'ذ': '`',
    '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4',
    '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
    '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9'
};

function hasArabicKeyboardArtifacts(text) {
    if (!text) return false;
    // إذا كان يحتوي على حروف أو حركات أو أرقام عربية
    if (/[\u0600-\u06ff\u0750-\u077f\ufb50-\ufc3f\ufe70-\ufefc]/.test(text)) {
        return true;
    }
    // أو إذا كان كود باركود/داتا ماتريكس (يبدأ بـ 01 أو (01)) ويحتوي على رموز تحويل لوحة المفاتيح العربية (مثل } أو ] أو [ أو ~ أو /)
    if (/(^01|\(01\)|^\d{14})/.test(text) && /[}\]\[{~/]/.test(text)) {
        return true;
    }
    // أو إذا احتوى على رموز خاصة بالشفت العربي
    if (/[}\]\[{~]/.test(text)) {
        return true;
    }
    return false;
}

function decodeArabicKeyboard(text) {
    if (!text) return '';
    if (!hasArabicKeyboardArtifacts(text)) {
        return text;
    }
    let s = text;
    s = s.replace(/لإ/g, 'T').replace(/لأ/g, 'G').replace(/لآ/g, 'B').replace(/لا/g, 'b');
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        out += (ARABIC_KEYBOARD_MAP[ch] !== undefined) ? ARABIC_KEYBOARD_MAP[ch] : ch;
    }
    return out;
}

// معادلة سحب واستخراج رقم بند التجارة العالمي فقط (GTIN) مطابقة لسحب الفاتورة
function extractCleanGtin(rawInput) {
    if (!rawInput) return '';
    let s = String(rawInput).trim();
    if (typeof decodeArabicKeyboard === 'function') {
        s = decodeArabicKeyboard(s);
    }
    // تحويل الأرقام العربية الشرقية (٠-٩) إلى أرقام إنجليزية
    const arDigits = '٠١٢٣٤٥٦٧٨٩';
    s = s.replace(/[٠-٩]/g, d => arDigits.indexOf(d));

    // إزالة بادئات أجهزة المسح الضوئي (AIM Identifiers)
    s = s.replace(/^\][dqcQDC][0-9]/, '');
    s = s.replace(/<\s*GS\s*>/gi, '\x1d');
    s = s.replace(/\[\s*GS\s*\]/gi, '\x1d');
    s = s.replace(/\{\s*GS\s*\}/gi, '\x1d');
    s = s.replace(/\^\]/g, '\x1d');

    // 1. صيغة الأقواس القياسية: (01)...
    let m = s.match(/\(01\)\s*(\d{8,14})/);
    if (m) {
        const val = m[1];
        return [8, 12, 13].includes(val.length) ? val.padStart(14, '0') : val;
    }

    // 2. صيغة GS1 Digital Link: /01/...
    m = s.match(/\/01\/(\d{8,14})/);
    if (m) {
        const val = m[1];
        return [8, 12, 13].includes(val.length) ? val.padStart(14, '0') : val;
    }

    // 3. كود GS1 المتسلسل المباشر: يبدأ بـ 01 ويليه 14 رقماً
    m = s.match(/(?:^|[^\d])01(\d{14})/);
    if (m) return m[1];

    // 4. صيغ Key-Value: GTIN: ...
    m = s.match(/(?:gtin|01)[\s:=]+(\d{8,14})/i);
    if (m) {
        const val = m[1];
        return [8, 12, 13].includes(val.length) ? val.padStart(14, '0') : val;
    }

    // 5. إذا كانت أرقاماً مباشرة
    const digits = s.replace(/\D/g, '');
    if (digits.length === 14) {
        return digits;
    } else if ([8, 12, 13].includes(digits.length)) {
        return digits.padStart(14, '0');
    } else if (digits.length > 14 && digits.startsWith('01')) {
        return digits.substring(2, 16);
    } else if (digits.length > 0 && digits.length <= 14) {
        return digits.padStart(14, '0');
    }

    return s;
}

// ==================== محرك قراءة وتحليل أكواد GS1 وعرض البيانات قبل الفلترة ====================
let activeGtinTargetInput = null;
let currentInspectedGs1Data = null;
let cameraScanMode = 'invoice'; // 'invoice' | 'gtin'

function parseGs1Client(rawInput) {
    if (!rawInput) return { isGs1: false, gtin: '', serial: '', batch: '', expiry: '', raw: '' };
    let s = String(rawInput).trim();
    if (typeof decodeArabicKeyboard === 'function') {
        s = decodeArabicKeyboard(s);
    }
    const arDigits = '٠١٢٣٤٥٦٧٨٩';
    s = s.replace(/[٠-٩]/g, d => arDigits.indexOf(d));

    // إزالة بادئات الماسح الضوئي (AIM Identifiers)
    s = s.replace(/^\][dqcQDC][0-9]/, '');
    s = s.replace(/<\s*GS\s*>/gi, '\x1d');
    s = s.replace(/\[\s*GS\s*\]/gi, '\x1d');
    s = s.replace(/\{\s*GS\s*\}/gi, '\x1d');
    s = s.replace(/\^\]/g, '\x1d');

    let gtin = '';
    let serial = '';
    let batch = '';
    let rawExpiry = '';
    let rawProdDate = '';
    let isGs1 = false;

    // 1. فحص كائن JSON إن وجد
    if (s.startsWith('{') && s.endsWith('}')) {
        try {
            const j = JSON.parse(s);
            for (const [k, v] of Object.entries(j)) {
                const kl = String(k).toLowerCase().trim();
                const val = String(v).trim();
                if (['gtin', '01', 'barcode'].includes(kl)) { gtin = val; isGs1 = true; }
                else if (['batch', '10', 'lot', 'batch_number'].includes(kl)) { batch = val; isGs1 = true; }
                else if (['serial', '21', 'sn', 'serial_number'].includes(kl)) { serial = val; isGs1 = true; }
                else if (['expiry', '17', 'exp', 'expiry_date'].includes(kl)) { rawExpiry = val; isGs1 = true; }
                else if (['prod', 'mfg', '11', 'prod_date', 'mfg_date'].includes(kl)) { rawProdDate = val; isGs1 = true; }
            }
        } catch {}
    }

    // 2. فحص صيغة الأقواس القياسية: (01)...(17)...(10)...(21)...
    if (!isGs1 && s.includes('(') && s.includes(')')) {
        const matches = s.matchAll(/\(([0-9]{2,4})\)([^()]+)/g);
        for (const m of matches) {
            const ai = m[1];
            const val = m[2].trim();
            if (ai === '01') { gtin = val; isGs1 = true; }
            else if (ai === '10') { batch = val; isGs1 = true; }
            else if (ai === '21') { serial = val; isGs1 = true; }
            else if (ai === '17') { rawExpiry = val; isGs1 = true; }
            else if (ai === '11') { rawProdDate = val; isGs1 = true; }
        }
    }

    // 3. فحص روابط الويب GS1 Digital Link: /01/GTIN/10/LOT?17=EXP&21=SN
    if (!isGs1 && (s.startsWith('http://') || s.startsWith('https://') || s.includes('/01/'))) {
        try {
            const parts = s.split('/');
            for (let i = 0; i < parts.length - 1; i++) {
                const k = parts[i].trim();
                const v = parts[i + 1].trim().split('?')[0];
                if (k === '01') { gtin = v; isGs1 = true; }
                else if (k === '10') { batch = v; isGs1 = true; }
                else if (k === '21') { serial = v; isGs1 = true; }
                else if (k === '17') { rawExpiry = v; isGs1 = true; }
                else if (k === '11') { rawProdDate = v; isGs1 = true; }
            }
            if (s.includes('?')) {
                const qs = s.split('?')[1];
                const params = new URLSearchParams(qs);
                if (params.get('17')) { rawExpiry = params.get('17'); isGs1 = true; }
                if (params.get('10')) { batch = params.get('10'); isGs1 = true; }
                if (params.get('21')) { serial = params.get('21'); isGs1 = true; }
                if (params.get('11')) { rawProdDate = params.get('11'); isGs1 = true; }
            }
        } catch {}
    }

    // 4. فحص سلاسل GS1 المتسلسلة بدون فواصل (Concatenated Raw GS1 DataMatrix)
    if (!isGs1) {
        const concatenatedPatterns = [
            // أنماط تحتوي على تاريخ الإنتاج (11) وتاريخ الانتهاء (17) معاً
            [/^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)11(\d{6})17(\d{6})21([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'batch', 'rawProdDate', 'rawExpiry', 'serial']],
            [/^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})11(\d{6})21([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'batch', 'rawExpiry', 'rawProdDate', 'serial']],
            [/^01(\d{14})11(\d{6})17(\d{6})10([a-zA-Z0-9_\-\.]{1,20}?)21([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'rawProdDate', 'rawExpiry', 'batch', 'serial']],
            [/^01(\d{14})17(\d{6})11(\d{6})10([a-zA-Z0-9_\-\.]{1,20}?)21([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'rawExpiry', 'rawProdDate', 'batch', 'serial']],
            [/^01(\d{14})21([a-zA-Z0-9_\-\.]{1,20}?)11(\d{6})17(\d{6})10([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'serial', 'rawProdDate', 'rawExpiry', 'batch']],
            [/^01(\d{14})21([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})11(\d{6})10([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'serial', 'rawExpiry', 'rawProdDate', 'batch']],
            [/^01(\d{14})21([a-zA-Z0-9_\-\.]{1,20}?)10([a-zA-Z0-9_\-\.]{1,20}?)11(\d{6})17(\d{6})$/, ['gtin', 'serial', 'batch', 'rawProdDate', 'rawExpiry']],
            [/^01(\d{14})21([a-zA-Z0-9_\-\.]{1,20}?)10([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})11(\d{6})$/, ['gtin', 'serial', 'batch', 'rawExpiry', 'rawProdDate']],
            [/^01(\d{14})17(\d{6})11(\d{6})21([a-zA-Z0-9_\-\.]{1,20}?)10([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'rawExpiry', 'rawProdDate', 'serial', 'batch']],
            [/^01(\d{14})11(\d{6})17(\d{6})21([a-zA-Z0-9_\-\.]{1,20}?)10([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'rawProdDate', 'rawExpiry', 'serial', 'batch']],

            // أنماط مع تاريخ الإنتاج (11) وتاريخ الانتهاء (17) بدون سيريال
            [/^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)11(\d{6})17(\d{6})$/, ['gtin', 'batch', 'rawProdDate', 'rawExpiry']],
            [/^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})11(\d{6})$/, ['gtin', 'batch', 'rawExpiry', 'rawProdDate']],
            [/^01(\d{14})11(\d{6})17(\d{6})10([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'rawProdDate', 'rawExpiry', 'batch']],
            [/^01(\d{14})17(\d{6})11(\d{6})10([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'rawExpiry', 'rawProdDate', 'batch']],

            // أنماط مع تاريخ الإنتاج (11) فقط بدون 17
            [/^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)11(\d{6})21([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'batch', 'rawProdDate', 'serial']],
            [/^01(\d{14})11(\d{6})10([a-zA-Z0-9_\-\.]{1,20}?)21([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'rawProdDate', 'batch', 'serial']],
            [/^01(\d{14})21([a-zA-Z0-9_\-\.]{1,20}?)11(\d{6})10([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'serial', 'rawProdDate', 'batch']],
            [/^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)11(\d{6})$/, ['gtin', 'batch', 'rawProdDate']],
            [/^01(\d{14})11(\d{6})10([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'rawProdDate', 'batch']],

            // الأنماط القياسية بدون 11
            [/^01(\d{14})21([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})10([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'serial', 'rawExpiry', 'batch']],
            [/^01(\d{14})17(\d{6})10([a-zA-Z0-9_\-\.]{1,20}?)21([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'rawExpiry', 'batch', 'serial']],
            [/^01(\d{14})17(\d{6})21([a-zA-Z0-9_\-\.]{1,20}?)10([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'rawExpiry', 'serial', 'batch']],
            [/^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})21([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'batch', 'rawExpiry', 'serial']],
            [/^01(\d{14})21([a-zA-Z0-9_\-\.]{1,20}?)10([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})$/, ['gtin', 'serial', 'batch', 'rawExpiry']],
            [/^01(\d{14})17(\d{6})10([a-zA-Z0-9_\-\.]+)$/, ['gtin', 'rawExpiry', 'batch']],
            [/^01(\d{14})10([a-zA-Z0-9_\-\.]{1,20}?)17(\d{6})$/, ['gtin', 'batch', 'rawExpiry']]
        ];

        for (const [regex, fields] of concatenatedPatterns) {
            const m = s.match(regex);
            if (m) {
                const map = { gtin: '', serial: '', batch: '', rawExpiry: '', rawProdDate: '' };
                fields.forEach((fld, idx) => {
                    if (fld && m[idx + 1]) map[fld] = m[idx + 1];
                });
                gtin = map.gtin;
                serial = map.serial;
                batch = map.batch;
                rawExpiry = map.rawExpiry;
                rawProdDate = map.rawProdDate;
                isGs1 = true;
                break;
            }
        }
    }

    // 5. فحص كود DataMatrix مع فواصل ASCII 29 / \x1d أو سلاسل متصلة
    if (!isGs1 && (s.includes('\x1d') || s.startsWith('01'))) {
        const tokens = s.split('\x1d');
        for (const token of tokens) {
            let idx = 0;
            const tLen = token.length;
            while (idx < tLen) {
                if (token.substring(idx, idx + 2) === '01' && tLen >= idx + 16 && /^\d{14}$/.test(token.substring(idx + 2, idx + 16))) {
                    gtin = token.substring(idx + 2, idx + 16);
                    idx += 16;
                    isGs1 = true;
                    continue;
                }
                if (token.substring(idx, idx + 2) === '17' && tLen >= idx + 8 && /^\d{6}$/.test(token.substring(idx + 2, idx + 8))) {
                    rawExpiry = token.substring(idx + 2, idx + 8);
                    idx += 8;
                    isGs1 = true;
                    continue;
                }
                if (token.substring(idx, idx + 2) === '11' && tLen >= idx + 8 && /^\d{6}$/.test(token.substring(idx + 2, idx + 8))) {
                    rawProdDate = token.substring(idx + 2, idx + 8);
                    idx += 8;
                    isGs1 = true;
                    continue;
                }
                if (token.substring(idx, idx + 2) === '10') {
                    batch = token.substring(idx + 2);
                    isGs1 = true;
                    break;
                }
                if (token.substring(idx, idx + 2) === '21') {
                    serial = token.substring(idx + 2);
                    isGs1 = true;
                    break;
                }
                idx++;
            }
        }
    }

    // Fallback: استخراج GTIN النقي إن لم يتم العثور عليه
    if (!gtin) {
        gtin = extractCleanGtin(s);
    }
    if (gtin && [8, 12, 13].includes(gtin.length)) {
        gtin = gtin.padStart(14, '0');
    }

    // تنسيق تاريخ الصلاحية إلى YYYY-MM-DD
    let expiry = '';
    if (rawExpiry) {
        if (/^\d{6}$/.test(rawExpiry)) {
            const yy = parseInt(rawExpiry.substring(0, 2), 10);
            const mm = rawExpiry.substring(2, 4);
            let dd = rawExpiry.substring(4, 6);
            const year = yy < 70 ? 2000 + yy : 1900 + yy;
            if (dd === '00') {
                const lastDay = new Date(year, parseInt(mm, 10), 0).getDate();
                dd = String(lastDay).padStart(2, '0');
            }
            expiry = `${year}-${mm}-${dd}`;
        } else {
            expiry = rawExpiry;
        }
    }

    // تنسيق تاريخ الإنتاج إلى YYYY-MM-DD
    let prodDate = '';
    if (rawProdDate) {
        if (/^\d{6}$/.test(rawProdDate)) {
            const yy = parseInt(rawProdDate.substring(0, 2), 10);
            const mm = rawProdDate.substring(2, 4);
            let dd = rawProdDate.substring(4, 6);
            const year = yy < 70 ? 2000 + yy : 1900 + yy;
            if (dd === '00') {
                const lastDay = new Date(year, parseInt(mm, 10), 0).getDate();
                dd = String(lastDay).padStart(2, '0');
            }
            prodDate = `${year}-${mm}-${dd}`;
        } else {
            prodDate = rawProdDate;
        }
    }

    if (serial || batch || expiry || prodDate || (gtin && (s.includes('(') || s.includes('\x1d') || (s.startsWith('01') && s.length > 14)))) {
        isGs1 = true;
    }

    return {
        isGs1: isGs1,
        gtin: gtin || '',
        serial: serial || '',
        batch: (batch || '').toUpperCase(),
        expiry: expiry || '',
        prodDate: prodDate || '',
        raw: s
    };
}

function showGs1Inspector(targetInput, parsed) {
    if (!targetInput || !parsed) return;
    activeGtinTargetInput = targetInput;
    currentInspectedGs1Data = parsed;

    const gtinEl = document.getElementById('inspect-gtin');
    const serialEl = document.getElementById('inspect-serial');
    const batchEl = document.getElementById('inspect-batch');
    const expiryEl = document.getElementById('inspect-expiry');
    const prodDateEl = document.getElementById('inspect-prod-date');
    const prodDateBox = document.getElementById('inspect-prod-date-box');
    const card = document.getElementById('gs1-inspector-card');

    if (gtinEl) gtinEl.value = parsed.gtin || '-';
    if (serialEl) serialEl.value = parsed.serial || '-';
    if (batchEl) batchEl.value = parsed.batch || '-';
    if (expiryEl) expiryEl.value = parsed.expiry || '-';
    if (prodDateEl) prodDateEl.value = parsed.prodDate || '-';
    if (prodDateBox) {
        if (parsed.prodDate) {
            prodDateBox.classList.remove('hidden');
        } else {
            prodDateBox.classList.add('hidden');
        }
    }

    // نضع الـ GTIN الحقيقي المستخرج من الكود في خانة الإدخال أيضاً
    if (parsed.gtin) {
        targetInput.value = parsed.gtin;
    }

    if (card) {
        card.classList.remove('hidden');
        card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    const confirmBtn = document.getElementById('btn-confirm-gs1-gtin');
    if (confirmBtn) confirmBtn.focus();
}

function confirmGs1GtinOnly() {
    if (!activeGtinTargetInput) return;
    const cleanGtin = (currentInspectedGs1Data && currentInspectedGs1Data.gtin) 
        ? currentInspectedGs1Data.gtin 
        : extractCleanGtin(activeGtinTargetInput.value) || '';

    // النتيجة النهائية: اعتماد رقم GTIN الحقيقي المستخرج من الكود فقط (14 رقماً)
    // وتجاهل Serial Number و Batch Number و Expiry Date
    activeGtinTargetInput.value = cleanGtin;

    const card = document.getElementById('gs1-inspector-card');
    if (card) card.classList.add('hidden');

    activeGtinTargetInput.classList.add('bg-emerald-50', 'border-emerald-500');
    setTimeout(() => {
        activeGtinTargetInput.classList.remove('bg-emerald-50', 'border-emerald-500');
    }, 1200);

    activeGtinTargetInput.focus();
    currentInspectedGs1Data = null;
    activeGtinTargetInput = null;
}

function cancelGs1Inspector() {
    const card = document.getElementById('gs1-inspector-card');
    if (card) card.classList.add('hidden');
    currentInspectedGs1Data = null;
    activeGtinTargetInput = null;
}

function setupGtinInputFilter(elementOrId) {
    const el = (typeof elementOrId === 'string') ? document.getElementById(elementOrId) : elementOrId;
    if (!el) return;

    let scanTimer = null;

    const handleGtinInput = async () => {
        const raw = el.value.trim();
        if (!raw) return;

        let parsed = parseGs1Client(raw);

        // إذا كان هناك مؤشر على كود GS1 أو كود طويل، نستعين بالخادم للتحقق التام
        if ((!parsed.isGs1 || !parsed.gtin) && (raw.length > 14 || raw.includes('(') || raw.includes('\x1d') || raw.startsWith('01') || raw.includes('/01/'))) {
            try {
                const res = await fetch('/api/catalog/parse-gs1', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ raw })
                });
                const data = await res.json();
                if (data.success && data.is_gs1 && data.gtin) {
                    parsed = {
                        isGs1: true,
                        gtin: data.gtin,
                        serial: data.serial || '',
                        batch: data.batch || '',
                        expiry: data.expiry || '',
                        raw: raw
                    };
                }
            } catch {}
        }

        if (parsed.isGs1 && parsed.gtin && (parsed.serial || parsed.batch || parsed.expiry || raw.length > 14)) {
            // عرض البيانات الأربعة المنفصلة أمام المستخدم للمراجعة قبل الفلترة
            showGs1Inspector(el, parsed);
        } else if (parsed.gtin && parsed.gtin !== raw && raw.length >= 14) {
            el.value = parsed.gtin;
        }
    };

    // لا نقطع كتابة أو مسح الماسح الضوئي أثناء التدفق السريع
    el.addEventListener('input', () => {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(handleGtinInput, 250);
    });

    el.addEventListener('paste', () => {
        clearTimeout(scanTimer);
        setTimeout(handleGtinInput, 50);
    });

    el.addEventListener('change', () => {
        clearTimeout(scanTimer);
        handleGtinInput();
    });

    el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const card = document.getElementById('gs1-inspector-card');
            if (card && !card.classList.contains('hidden') && activeGtinTargetInput === el) {
                e.preventDefault();
                confirmGs1GtinOnly();
            } else {
                clearTimeout(scanTimer);
                e.preventDefault();
                handleGtinInput();
            }
        }
    });
}

// ==================== تبويب 1: المسح الضوئي والفاتورة ====================
function initScannerTab() {
    setupGtinInputFilter('field-gtin');
    const dmInput = document.getElementById('scan-datamatrix-input');
    
    // استماع لحدث الكتابة المباشرة وتصحيح لغة الكيبورد فورياً
    dmInput?.addEventListener('input', () => {
        const val = dmInput.value;
        const decoded = decodeArabicKeyboard(val);
        if (decoded !== val) {
            dmInput.value = decoded;
        }
    });

    // استماع لمفتاح Enter من لوحة المفاتيح أو أجهزة مسح الباركود
    dmInput?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const val = dmInput.value.trim();
            if (val) {
                executeScan(val);
            }
        }
    });

    // استماع لحدث اللصق المباشر
    dmInput?.addEventListener('paste', () => {
        setTimeout(() => {
            const val = dmInput.value.trim();
            if (val) executeScan(val);
        }, 50);
    });

    // أزرار تفريغ الخانات (x)
    document.getElementById('btn-clear-dm')?.addEventListener('click', () => {
        if (dmInput) {
            dmInput.value = '';
            dmInput.focus();
        }
    });
    document.getElementById('btn-clear-gtin')?.addEventListener('click', () => {
        const el = document.getElementById('field-gtin');
        if (el) el.value = '';
    });
    document.getElementById('btn-clear-batch')?.addEventListener('click', () => {
        const el = document.getElementById('field-batch');
        if (el) el.value = '';
    });
    ['field-batch', 'modal-edit-batch'].forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', () => {
                const start = el.selectionStart;
                const end = el.selectionEnd;
                const up = decodeArabicKeyboard(el.value).toUpperCase();
                if (el.value !== up) {
                    el.value = up;
                    try { el.setSelectionRange(start, end); } catch (_) {}
                }
            });
        }
    });

    // زر + إدخال اليدوي والسماح بإدخال الكميات يدوياً
    document.getElementById('btn-manual-insert')?.addEventListener('click', async () => {
        const dmVal = dmInput ? dmInput.value.trim() : '';
        const qtyVal = parseInt(document.getElementById('field-qty')?.value) || 1;
        if (dmVal) {
            executeScan(dmVal);
            return;
        }
        const gtinVal = document.getElementById('field-gtin')?.value.trim();
        const batchVal = decodeArabicKeyboard(document.getElementById('field-batch')?.value.trim() || '').toUpperCase();
        const expiryVal = document.getElementById('field-expiry')?.value.trim();
        if (gtinVal) {
            try {
                const invId = activeInvoice ? activeInvoice.id : 0;
                const res = await fetch('/api/invoice/manual-item', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        invoice_id: invId,
                        gtin: gtinVal,
                        batch: batchVal || 'BATCH1',
                        expiry: expiryVal || '2027-12-31',
                        quantity: qtyVal,
                        user_name: 'المسؤول'
                    })
                });
                const data = await res.json();
                if (data.success) {
                    renderInvoice(data.invoice);
                    showScanBanner('success', data.message);
                    addScanToStream('success', `[يدوي] ${data.name_en || data.name} | كمية: ${qtyVal}`);
                    clearScanFields();
                } else {
                    showScanBanner('error', data.message);
                }
            } catch (e) {
                showScanBanner('error', 'فشل الإدخال اليدوي: ' + e.message);
            }
        } else {
            showScanBanner('warning', 'يرجى مسح كود داتا ماتريكس أو ملء رقم بند التجارة/الباركود للإدخال.');
            document.getElementById('field-gtin')?.focus();
        }
    });

    // استماع لمفتاح Enter في خانات الإدخال اليدوي
    ['field-gtin', 'field-batch', 'field-expiry', 'field-qty'].forEach(id => {
        document.getElementById(id)?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('btn-manual-insert')?.click();
            }
        });
    });

    // أزرار العينات السريعة
    document.querySelectorAll('.btn-sample-qr').forEach(btn => {
        btn.addEventListener('click', () => {
            const qr = btn.getAttribute('data-qr');
            if (qr) {
                if (dmInput) dmInput.value = qr;
                executeScan(qr);
            }
        });
    });

    document.getElementById('btn-dismiss-msg')?.addEventListener('click', () => {
        document.getElementById('scan-message-banner')?.classList.add('hidden');
    });

    document.getElementById('btn-new-invoice')?.addEventListener('click', async () => {
        if (confirm('هل ترغب في فتح مسودة فاتورة جديدة؟')) {
            try {
                const res = await fetch('/api/invoice/new', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_name: 'المسؤول' })
                });
                const data = await res.json();
                if (data.success) {
                    renderInvoice(data.invoice);
                    showScanBanner('success', 'تم فتح فاتورة مسودة جديدة بنجاح.');
                    clearScanStream();
                    if (dmInput) {
                        dmInput.value = '';
                        dmInput.focus();
                    }
                }
            } catch (e) {
                alert('فشل إنشاء فاتورة جديدة: ' + e.message);
            }
        }
    });

    document.getElementById('btn-confirm-invoice')?.addEventListener('click', async () => {
        if (!activeInvoice || !activeInvoice.id) return;
        if (!confirm('هل أنت متأكد من اعتماد الفاتورة؟ بعد الاعتماد سيتم قفل السيريالات لمنع تكرارها في أي فاتورة أخرى.')) return;
        
        try {
            const res = await fetch('/api/invoice/confirm', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ invoice_id: activeInvoice.id })
            });
            const data = await res.json();
            if (data.success) {
                renderInvoice(data.invoice);
                showScanBanner('info', data.message);
            } else {
                showScanBanner('error', data.message);
            }
        } catch (e) {
            alert('حدث خطأ أثناء الاعتماد: ' + e.message);
        }
    });

    // دالة موحدة لسحب وحفظ ملفات الإكسيل في التنزيلات وفتح برنامج Excel أوتوماتيكياً
    window.downloadAndTriggerSave = async function(url, fallbackFilename = 'Export.xlsx', postData = null) {
        try {
            const fetchOptions = postData ? {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(postData)
            } : { method: 'GET' };

            const res = await fetch(url, fetchOptions);
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.detail || err.message || 'فشل سحب وتصدير الملف');
            }

            let filename = fallbackFilename || 'Export.xlsx';
            const disposition = res.headers.get('Content-Disposition');
            if (disposition) {
                const matchUtf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i);
                if (matchUtf8 && matchUtf8[1]) {
                    try {
                        filename = decodeURIComponent(matchUtf8[1]);
                    } catch (e) {
                        filename = matchUtf8[1];
                    }
                } else {
                    const match = disposition.match(/filename=["']?([^"';]+)["']?/i);
                    if (match && match[1]) filename = match[1];
                }
            }

            const blob = await res.blob();
            const objUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = objUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => window.URL.revokeObjectURL(objUrl), 5000);
            showCatalogToast('✅ تم حفظ الملف في التنزيلات وفتح برنامج Excel أوتوماتيكياً!');
            return true;
        } catch (e) {
            console.error('Download error:', e);
            if (!postData) {
                window.location.href = url;
            } else {
                alert('فشل تصدير الملف: ' + e.message);
            }
            return false;
        }
    };

    // ==================== نظام تسمية الورقة والملف (MEDICINE / COSMETICS / MILK / DIAPER من 1 إلى 50 وينطبق على كل المسميات) ====================
    const BASE_SHEET_CATEGORIES = ['MEDICINE', 'COSMETICS', 'MILK', 'DIAPER'];
    let currentSheetCat = 'MEDICINE';
    let currentSheetNum = '1';
    let currentSheetOrder = 'name_first'; // 'name_first' -> MEDICINE 1 | 'num_first' -> 1 MEDICINE
    let pendingPrintInvoice = null;

    const formatSheetTitle = (cat, num, order) => {
        const cleanCat = (cat || '').trim().toUpperCase();
        const cleanNum = (num || '').toString().trim();
        if (!cleanCat && !cleanNum) return '';
        if (!cleanNum) return cleanCat;
        if (!cleanCat) return cleanNum;
        return order === 'num_first' ? `${cleanNum} ${cleanCat}` : `${cleanCat} ${cleanNum}`;
    };

    const populateSheetNamingControls = () => {
        // تعبئة قائمة الأرقام 1..50 في الشريط العلوي للجدول
        const selNum = document.getElementById('sel-sheet-num');
        if (selNum && selNum.options.length <= 1) {
            for (let i = 1; i <= 50; i++) {
                const opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = String(i);
                selNum.appendChild(opt);
            }
            selNum.value = '1';
        }

        // تعبئة شبكة الأرقام 1..50 داخل نافذة ما قبل الطباعة
        const numGrid = document.getElementById('modal-numbers-grid');
        if (numGrid && numGrid.children.length === 0) {
            for (let i = 1; i <= 50; i++) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'btn-modal-num py-1 px-1 rounded border border-slate-200 bg-slate-50 hover:bg-indigo-600 hover:text-white font-mono font-bold text-xs text-slate-800 transition';
                btn.textContent = String(i);
                btn.setAttribute('data-num', String(i));
                btn.addEventListener('click', () => {
                    currentSheetNum = String(i);
                    if (selNum) selNum.value = currentSheetNum;
                    applySheetNameFromParts(true);
                });
                numGrid.appendChild(btn);
            }
        }

        // تعبئة datalist بالاقتراحات من 1 إلى 50 لكل المسميات
        rebuildSheetSuggestionsDatalist();
    };

    const rebuildSheetSuggestionsDatalist = (extraCustomCat = '') => {
        const datalist = document.getElementById('sheet-name-suggestions-datalist');
        if (!datalist) return;
        const cats = [...BASE_SHEET_CATEGORIES];
        const cleanExtra = (extraCustomCat || '').replace(/[0-9]/g, '').trim().toUpperCase();
        if (cleanExtra && !cats.includes(cleanExtra)) {
            cats.unshift(cleanExtra);
        }

        const order = document.getElementById('sel-sheet-order')?.value || currentSheetOrder;
        let html = '';
        cats.forEach(c => {
            html += `<option value="${c}"></option>`;
            for (let i = 1; i <= 50; i++) {
                if (order === 'num_first') {
                    html += `<option value="${i} ${c}"></option>`;
                    html += `<option value="${c} ${i}"></option>`;
                } else {
                    html += `<option value="${c} ${i}"></option>`;
                    html += `<option value="${i} ${c}"></option>`;
                }
            }
        });
        datalist.innerHTML = html;
    };

    const renderModalSuggestionChips = (rawInputVal = '') => {
        const chipsContainer = document.getElementById('modal-custom-suggestions-chips');
        if (!chipsContainer) return;
        const baseWord = (rawInputVal || currentSheetCat || 'MEDICINE').replace(/[0-9]/g, '').trim().toUpperCase() || currentSheetCat || 'MEDICINE';
        const order = document.getElementById('modal-sheet-order')?.value || currentSheetOrder;
        let chipsHtml = `<button type="button" class="chip-suggest px-2 py-0.5 bg-indigo-50 hover:bg-indigo-600 hover:text-white text-indigo-900 border border-indigo-200 rounded font-mono font-bold text-[11px] transition" data-val="${baseWord}">${baseWord}</button>`;
        for (let i = 1; i <= 50; i++) {
            const v = formatSheetTitle(baseWord, i, order);
            chipsHtml += `<button type="button" class="chip-suggest px-2 py-0.5 bg-slate-100 hover:bg-indigo-600 hover:text-white text-slate-800 border border-slate-300 rounded font-mono font-bold text-[10px] transition" data-val="${v}">${v}</button>`;
        }
        chipsContainer.innerHTML = chipsHtml;
        chipsContainer.querySelectorAll('.chip-suggest').forEach(btn => {
            btn.addEventListener('click', () => {
                const val = btn.getAttribute('data-val') || '';
                const modalInput = document.getElementById('modal-sheet-name-input');
                const inlineInput = document.getElementById('inline-sheet-name-input');
                if (modalInput) modalInput.value = val;
                if (inlineInput) inlineInput.value = val;
            });
        });
    };

    const highlightModalSelections = () => {
        document.querySelectorAll('.btn-modal-cat').forEach(btn => {
            const isMatch = btn.getAttribute('data-cat') === currentSheetCat;
            btn.classList.toggle('ring-2', isMatch);
            btn.classList.toggle('ring-indigo-600', isMatch);
        });
        document.querySelectorAll('.btn-modal-num').forEach(btn => {
            const isMatch = btn.getAttribute('data-num') === String(currentSheetNum);
            btn.classList.toggle('bg-indigo-600', isMatch);
            btn.classList.toggle('text-white', isMatch);
            btn.classList.toggle('bg-slate-50', !isMatch);
        });
    };

    const applySheetNameFromParts = (updateModalInput = true) => {
        const val = formatSheetTitle(currentSheetCat, currentSheetNum, currentSheetOrder);
        const inlineInput = document.getElementById('inline-sheet-name-input');
        const modalInput = document.getElementById('modal-sheet-name-input');
        if (inlineInput) inlineInput.value = val;
        if (updateModalInput && modalInput) modalInput.value = val;
        highlightModalSelections();
        renderModalSuggestionChips(currentSheetCat);
    };

    populateSheetNamingControls();

    // أحداث أزرار الاختيار السريع في الشريط فوق الجدول
    document.querySelectorAll('.btn-quick-cat').forEach(btn => {
        btn.addEventListener('click', () => {
            currentSheetCat = btn.getAttribute('data-cat') || 'MEDICINE';
            const selNum = document.getElementById('sel-sheet-num');
            currentSheetNum = selNum ? selNum.value : '1';
            currentSheetOrder = document.getElementById('sel-sheet-order')?.value || 'name_first';
            applySheetNameFromParts(true);
        });
    });

    document.getElementById('sel-sheet-num')?.addEventListener('change', (e) => {
        currentSheetNum = e.target.value;
        applySheetNameFromParts(true);
    });

    document.getElementById('btn-sheet-num-minus')?.addEventListener('click', () => {
        const selNum = document.getElementById('sel-sheet-num');
        let n = parseInt(currentSheetNum || (selNum ? selNum.value : '1')) || 1;
        n = n > 1 ? n - 1 : 50;
        currentSheetNum = String(n);
        if (selNum) selNum.value = currentSheetNum;
        applySheetNameFromParts(true);
    });

    document.getElementById('btn-sheet-num-plus')?.addEventListener('click', () => {
        const selNum = document.getElementById('sel-sheet-num');
        let n = parseInt(currentSheetNum || (selNum ? selNum.value : '0')) || 0;
        n = n < 50 ? n + 1 : 1;
        currentSheetNum = String(n);
        if (selNum) selNum.value = currentSheetNum;
        applySheetNameFromParts(true);
    });

    document.getElementById('sel-sheet-order')?.addEventListener('change', (e) => {
        currentSheetOrder = e.target.value;
        const modalOrder = document.getElementById('modal-sheet-order');
        if (modalOrder) modalOrder.value = currentSheetOrder;
        rebuildSheetSuggestionsDatalist(currentSheetCat);
        applySheetNameFromParts(true);
    });

    document.getElementById('btn-clear-sheet-name')?.addEventListener('click', () => {
        const inlineInput = document.getElementById('inline-sheet-name-input');
        if (inlineInput) inlineInput.value = '';
    });

    document.getElementById('inline-sheet-name-input')?.addEventListener('input', (e) => {
        const raw = e.target.value;
        const base = raw.replace(/[0-9]/g, '').trim().toUpperCase();
        if (base) {
            currentSheetCat = base;
            rebuildSheetSuggestionsDatalist(base);
        }
    });

    // أحداث نافذة تسمية الورقة والملف قبل الطباعة
    document.querySelectorAll('.btn-modal-cat').forEach(btn => {
        btn.addEventListener('click', () => {
            currentSheetCat = btn.getAttribute('data-cat') || 'MEDICINE';
            if (!currentSheetNum) currentSheetNum = '1';
            const selNum = document.getElementById('sel-sheet-num');
            if (selNum) selNum.value = currentSheetNum;
            applySheetNameFromParts(true);
        });
    });

    document.getElementById('modal-sheet-order')?.addEventListener('change', (e) => {
        currentSheetOrder = e.target.value;
        const inlineOrder = document.getElementById('sel-sheet-order');
        if (inlineOrder) inlineOrder.value = currentSheetOrder;
        rebuildSheetSuggestionsDatalist(currentSheetCat);
        applySheetNameFromParts(true);
    });

    document.getElementById('btn-modal-no-num')?.addEventListener('click', () => {
        currentSheetNum = '';
        const selNum = document.getElementById('sel-sheet-num');
        if (selNum) selNum.value = '';
        applySheetNameFromParts(true);
    });

    document.getElementById('modal-sheet-name-input')?.addEventListener('input', (e) => {
        const val = e.target.value;
        const inlineInput = document.getElementById('inline-sheet-name-input');
        if (inlineInput) inlineInput.value = val;
        const base = val.replace(/[0-9]/g, '').trim().toUpperCase();
        if (base) {
            currentSheetCat = base;
            rebuildSheetSuggestionsDatalist(base);
            renderModalSuggestionChips(base);
        }
    });

    document.getElementById('modal-sheet-name-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('btn-confirm-pre-print')?.click();
        }
    });

    // مسميات الفروع المعتمدة لخانة LOCATION عند تصدير الإكسيل (WH001/Stock, expir/Stock, PH001..PH009/Stock)
    const PRESET_BRANCH_LOCATIONS = [
        'WH001/Stock',
        'expir/Stock',
        'PH001/Stock',
        'PH002/Stock',
        'PH003/Stock',
        'PH004/Stock',
        'PH005/Stock',
        'PH006/Stock',
        'PH007/Stock',
        'PH008/Stock',
        'PH009/Stock'
    ];

    const getSelectedExportLocation = () => {
        const selEl = document.getElementById('select-export-location');
        if (selEl && selEl.value !== undefined) {
            const v = selEl.value;
            if (v === '__SHEET_NAME__') {
                return (document.getElementById('inline-sheet-name-input')?.value || '').trim();
            }
            return v;
        }
        const saved = localStorage.getItem('preferred_export_location');
        return saved !== null ? saved : 'PH004/Stock';
    };
    window.getSelectedExportLocation = getSelectedExportLocation;

    const syncExportLocation = (val) => {
        try {
            localStorage.setItem('preferred_export_location', val);
        } catch(e) {}
        ['select-export-location', 'modal-select-export-location', 'select-stocktake-export-location'].forEach(id => {
            const el = document.getElementById(id);
            if (el && el.value !== val) el.value = val;
        });
    };

    const initLocationSelectors = () => {
        const saved = localStorage.getItem('preferred_export_location') || 'PH004/Stock';
        syncExportLocation(saved);
        ['select-export-location', 'modal-select-export-location', 'select-stocktake-export-location'].forEach(id => {
            document.getElementById(id)?.addEventListener('change', (e) => {
                syncExportLocation(e.target.value);
            });
        });
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initLocationSelectors);
    } else {
        setTimeout(initLocationSelectors, 0);
    }

    const getActiveSheetNameAndLocation = () => {
        const sheetName = (document.getElementById('inline-sheet-name-input')?.value || '').trim();
        const locationVal = getSelectedExportLocation();
        return {
            sheetName,
            locationVal
        };
    };

    const handleInvoiceExcelExport = async () => {
        if (!activeInvoice || !activeInvoice.id) {
            showCatalogToast('لا توجد فاتورة نشطة حالياً لسحب أصنافها.', true);
            return;
        }
        const { sheetName, locationVal } = getActiveSheetNameAndLocation();
        showCatalogToast('📊 جاري سحب الإكسيل الأول (الفاتورة) وحفظ الملف وفتحه في Excel...');
        const invNum = activeInvoice.invoice_number || 'INV';
        const invDate = activeInvoice.invoice_date || '2026-10-29';
        const defaultName = sheetName ? `${sheetName}.xlsx` : `Invoice_${invNum}_${invDate}.xlsx`;
        const qs = new URLSearchParams({ id: activeInvoice.id });
        if (sheetName) qs.set('sheet_name', sheetName);
        if (locationVal) qs.set('location_val', locationVal);
        await window.downloadAndTriggerSave(`/api/invoice/export-excel?${qs.toString()}`, defaultName);
    };

    const handleInvoiceStockExcelExport = async () => {
        if (!activeInvoice || !activeInvoice.id) {
            showCatalogToast('لا توجد فاتورة نشطة حالياً لسحب أصنافها.', true);
            return;
        }
        const { sheetName, locationVal } = getActiveSheetNameAndLocation();
        showCatalogToast('📊 جاري سحب الإكسيل الثاني (Product / Counted quantity) وحفظ الملف وفتحه في Excel...');
        const invNum = activeInvoice.invoice_number || 'INV';
        const invDate = activeInvoice.invoice_date || '2026-10-29';
        const defaultName = sheetName ? `${sheetName}.xlsx` : `StockCount_${invNum}_${invDate}.xlsx`;
        const qs = new URLSearchParams({ id: activeInvoice.id });
        if (sheetName) qs.set('sheet_name', sheetName);
        if (locationVal) qs.set('location_val', locationVal);
        await window.downloadAndTriggerSave(`/api/invoice/export-stock-excel?${qs.toString()}`, defaultName);
    };

    // دالة قراءة المسميات المختارة يدوياً من رؤوس الجدول وتصدير الإكسيل بها
    const getCustomSelectedColumnSpecs = () => {
        const prodHeader = document.getElementById('col-header-product')?.value || 'PRODUCT';
        const nameHeader = document.getElementById('col-header-name')?.value || 'NAME';
        const batchHeader = document.getElementById('col-header-batch')?.value || 'BATCH NUMBER';
        const qtyHeader = document.getElementById('col-header-qty')?.value || 'QUANTITE';
        const expiryHeader = document.getElementById('col-header-expiry')?.value || 'expiry-date';
        const includePrices = document.getElementById('chk-include-prices') ? document.getElementById('chk-include-prices').checked : true;
        const includeLocation = document.getElementById('chk-include-location') ? document.getElementById('chk-include-location').checked : false;

        const cols = [
            { field: 'product_code', header: prodHeader },
            { field: 'name_en', header: nameHeader }
        ];

        if (includeLocation) {
            cols.push({ field: 'location', header: 'Location' });
        }

        if (includePrices) {
            cols.push({ field: 'sales_price', header: 'SALES PRICE' });
            cols.push({ field: 'batch_number', header: batchHeader });
            cols.push({ field: 'quantity', header: qtyHeader });
            cols.push({ field: 'unit_price', header: 'UNITPRICE' });
            cols.push({ field: 'expiry_date', header: expiryHeader });
        } else {
            // ترتيب الجرد عند عدم تضمين الأسعار: Product | NAME ENGLISH | (Location) | Lot/Serial Number | Expiry Date | Counted quantity
            cols.push({ field: 'batch_number', header: batchHeader });
            cols.push({ field: 'expiry_date', header: expiryHeader });
            cols.push({ field: 'quantity', header: qtyHeader });
        }
        return cols;
    };

    const handleInvoiceCustomExcelExport = async () => {
        if (!activeInvoice || !activeInvoice.id) {
            showCatalogToast('لا توجد فاتورة نشطة حالياً لسحب أصنافها.', true);
            return;
        }
        const { sheetName, locationVal } = getActiveSheetNameAndLocation();
        const columns = getCustomSelectedColumnSpecs();
        const headerNames = columns.map(c => c.header).join(' | ');
        showCatalogToast(`📊 جاري سحب الإكسيل بالمسميات المختارة (${headerNames})...`);
        const invNum = activeInvoice.invoice_number || 'INV';
        const invDate = activeInvoice.invoice_date || '2026-10-29';
        const defaultName = sheetName ? `${sheetName}.xlsx` : `Invoice_Custom_${invNum}_${invDate}.xlsx`;
        await window.downloadAndTriggerSave('/api/invoice/export-custom-excel', defaultName, {
            id: activeInvoice.id,
            columns,
            sheet_name: sheetName,
            location_val: locationVal
        });
    };

    document.getElementById('btn-preset-cols-invoice')?.addEventListener('click', () => {
        if (document.getElementById('col-header-product')) document.getElementById('col-header-product').value = 'PRODUCT';
        if (document.getElementById('col-header-name')) document.getElementById('col-header-name').value = 'NAME';
        if (document.getElementById('col-header-batch')) document.getElementById('col-header-batch').value = 'BATCH NUMBER';
        if (document.getElementById('col-header-qty')) document.getElementById('col-header-qty').value = 'QUANTITE';
        if (document.getElementById('col-header-expiry')) document.getElementById('col-header-expiry').value = 'expiry-date';
        if (document.getElementById('chk-include-prices')) document.getElementById('chk-include-prices').checked = true;
        if (document.getElementById('chk-include-location')) document.getElementById('chk-include-location').checked = false;
        showCatalogToast('✅ تم ضبط مسميات الأعمدة على وضع الفاتورة');
    });

    document.getElementById('btn-preset-cols-stock')?.addEventListener('click', () => {
        if (document.getElementById('col-header-product')) document.getElementById('col-header-product').value = 'Product';
        if (document.getElementById('col-header-name')) document.getElementById('col-header-name').value = 'NAME ENGLISH';
        if (document.getElementById('col-header-batch')) document.getElementById('col-header-batch').value = 'Lot/Serial Number';
        if (document.getElementById('col-header-qty')) document.getElementById('col-header-qty').value = 'Counted quantity';
        if (document.getElementById('col-header-expiry')) document.getElementById('col-header-expiry').value = 'Expiry Date';
        if (document.getElementById('chk-include-prices')) document.getElementById('chk-include-prices').checked = false;
        if (document.getElementById('chk-include-location')) document.getElementById('chk-include-location').checked = true;
        showCatalogToast('✅ تم ضبط مسميات الأعمدة على وضع الجرد (Lot/Serial Number & Counted quantity)');
    });

    document.getElementById('btn-export-excel')?.addEventListener('click', handleInvoiceExcelExport);
    document.getElementById('btn-export-excel-table')?.addEventListener('click', handleInvoiceExcelExport);
    document.getElementById('btn-export-stock-excel')?.addEventListener('click', handleInvoiceStockExcelExport);
    document.getElementById('btn-export-stock-excel-table')?.addEventListener('click', handleInvoiceStockExcelExport);
    document.getElementById('btn-export-custom-excel-table')?.addEventListener('click', handleInvoiceCustomExcelExport);

    // فتح نافذة تسمية الورقة والملف قبل الطباعة
    window.openPrePrintModal = function(inv) {
        if (!inv) {
            showCatalogToast('لا توجد فاتورة للطباعة.', true);
            return;
        }
        pendingPrintInvoice = inv;
        populateSheetNamingControls();

        const inlineVal = (document.getElementById('inline-sheet-name-input')?.value || '').trim();
        const modalInput = document.getElementById('modal-sheet-name-input');
        if (modalInput) {
            modalInput.value = inlineVal || formatSheetTitle(currentSheetCat, currentSheetNum || '1', currentSheetOrder);
        }
        const curLoc = getSelectedExportLocation();
        const modalLocSel = document.getElementById('modal-select-export-location');
        if (modalLocSel) {
            modalLocSel.value = curLoc;
        }
        highlightModalSelections();
        renderModalSuggestionChips(currentSheetCat);

        const modal = document.getElementById('modal-pre-print-name');
        modal?.classList.remove('hidden');
        setTimeout(() => {
            modalInput?.focus();
            modalInput?.select();
        }, 50);
    };

    const closePrePrintModal = () => {
        document.getElementById('modal-pre-print-name')?.classList.add('hidden');
    };

    document.getElementById('btn-close-pre-print-modal')?.addEventListener('click', closePrePrintModal);
    document.getElementById('btn-cancel-pre-print')?.addEventListener('click', closePrePrintModal);

    document.getElementById('btn-confirm-pre-print')?.addEventListener('click', () => {
        const chosenTitle = (document.getElementById('modal-sheet-name-input')?.value || '').trim();
        const chosenLoc = document.getElementById('modal-select-export-location')?.value || '';
        if (chosenLoc) {
            syncExportLocation(chosenLoc);
        }
        const initialMode = document.getElementById('modal-print-mode-select')?.value || 'custom';

        const inlineInput = document.getElementById('inline-sheet-name-input');
        if (inlineInput) inlineInput.value = chosenTitle;

        closePrePrintModal();
        if (pendingPrintInvoice) {
            window.printInvoiceSheet(pendingPrintInvoice, {
                sheetTitle: chosenTitle,
                fillLocation: !!chosenLoc,
                locationVal: chosenLoc === '__SHEET_NAME__' ? chosenTitle : chosenLoc,
                initialMode
            });
        }
    });

    // دالة طباعة الفاتورة بشكل احترافي مع إظهار اللوجو في الأعلى والاسم المختار (مثل MEDICINE 1) كعنوان رئيسي بارز مع جدول الأصناف
    window.printInvoiceSheet = function(inv, options = {}) {
        if (!inv) {
            showCatalogToast('لا توجد فاتورة للطباعة.', true);
            return;
        }
        const sheetTitle = (options.sheetTitle !== undefined ? options.sheetTitle : (document.getElementById('inline-sheet-name-input')?.value || 'MEDICINE 1')).trim() || 'MEDICINE 1';
        const initialLocVal = (options.locationVal !== undefined ? options.locationVal : getSelectedExportLocation());
        const fillLocation = options.fillLocation !== undefined ? options.fillLocation : (!!initialLocVal);
        const startMode = options.initialMode || 'custom';

        const customCols = getCustomSelectedColumnSpecs();
        const invJson = JSON.stringify(inv).replace(/</g, '\\u003c');
        const customColsJson = JSON.stringify(customCols).replace(/</g, '\\u003c');
        const initialTitleJson = JSON.stringify(sheetTitle).replace(/</g, '\\u003c');
        const initialLocJson = JSON.stringify(initialLocVal).replace(/</g, '\\u003c');

        const docTitle = sheetTitle || `Invoice_${inv.invoice_number || 'INV'}`;

        const printHtml = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>${docTitle}</title>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        * {
            box-sizing: border-box;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
        }
        body {
            font-family: 'Cairo', Tahoma, Arial, sans-serif;
            margin: 0;
            padding: 16px;
            color: #0f172a;
            background: #fff;
            font-size: 12px;
        }
        .no-print-bar {
            background: #0f172a;
            color: #fff;
            padding: 10px 16px;
            border-radius: 12px;
            margin-bottom: 16px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            box-shadow: 0 4px 14px rgba(15,23,42,0.18);
        }
        .no-print-row {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
        }
        .no-print-bar button {
            font-family: 'Cairo', sans-serif;
            cursor: pointer;
            border: none;
            border-radius: 6px;
            padding: 5px 12px;
            font-size: 11.5px;
            font-weight: 700;
            transition: 0.15s;
        }
        .btn-print-now { background: #10b981; color: #fff; font-size: 13px !important; padding: 6px 18px !important; }
        .btn-print-now:hover { background: #059669; }
        .btn-mode { background: #334155; color: #e2e8f0; border: 1px solid #475569 !important; }
        .btn-mode.active { background: #4f46e5; color: #fff; border-color: #818cf8 !important; }
        .btn-cat-pill { background: #1e293b; color: #fbbf24; border: 1px solid #f59e0b !important; font-family: monospace !important; }
        .btn-cat-pill:hover { background: #f59e0b; color: #0f172a; }
        .btn-logo-upload { background: #334155; color: #38bdf8; border: 1px solid #0284c7 !important; }
        .btn-close { background: #ef4444; color: #fff; }

        /* الترويسة الاحترافية المتكررة في جميع صفحات الطباعة: لوجو RAMADAN + العنوان البارز (مثل MEDICINE 1) + ملخص الأصناف */
        thead {
            display: table-header-group !important;
        }
        tfoot {
            display: table-footer-group !important;
        }
        tr {
            page-break-inside: avoid;
            break-inside: avoid;
        }
        th.repeating-header-cell {
            background: #ffffff !important;
            color: #0f172a !important;
            border: none !important;
            padding: 0 0 10px 0 !important;
        }
        .pro-print-header {
            border: 2.5px solid #0f172a;
            border-radius: 12px;
            padding: 10px 16px;
            display: grid;
            grid-template-columns: 1fr auto 1fr;
            align-items: center;
            gap: 12px;
            background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%) !important;
            direction: rtl;
        }
        .brand-logo-box {
            display: flex;
            align-items: center;
            gap: 10px;
            direction: ltr;
            justify-self: start;
        }
        .ramadan-logo-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%) !important;
            border: 2px solid #f59e0b;
            border-radius: 10px;
            padding: 5px 8px;
            box-shadow: 0 2px 6px rgba(15,23,42,0.16);
            direction: ltr;
        }
        .ramadan-monogram {
            width: 30px;
            height: 30px;
            border-radius: 7px;
            background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%) !important;
            color: #0f172a !important;
            font-family: Consolas, Monaco, monospace;
            font-size: 18px;
            font-weight: 900;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
        }
        .ramadan-monogram img {
            width: 100%;
            height: 100%;
            object-fit: contain;
            background: #fff;
        }
        .ramadan-mid-col {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 2px;
        }
        .ramadan-mid-letters {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            background: #0f172a !important;
            border: 1px solid rgba(251, 191, 36, 0.45);
            border-radius: 6px;
            padding: 2px 7px;
            font-family: Consolas, Monaco, monospace;
            font-size: 13.5px;
            font-weight: 900;
            color: #ffffff !important;
            line-height: 1.1;
        }
        .ramadan-mid-dot {
            color: #fbbf24 !important;
            font-size: 9px;
        }
        .ramadan-brand-sub {
            font-family: Consolas, Monaco, monospace;
            font-size: 7px;
            font-weight: 700;
            letter-spacing: 0.8px;
            color: #fbbf24 !important;
            line-height: 1;
        }
        .ramadan-end-monogram {
            width: 30px;
            height: 30px;
            border-radius: 7px;
            background: #0f172a !important;
            color: #fbbf24 !important;
            border: 1.5px solid #f59e0b;
            font-family: Consolas, Monaco, monospace;
            font-size: 18px;
            font-weight: 900;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        /* العنوان الرئيسي البارز في المنتصف (مثل MEDICINE 1 / COSMETICS 1) */
        .hero-title-center {
            text-align: center;
            padding: 6px 26px;
            background: #0f172a !important;
            color: #ffffff !important;
            border: 3px solid #f59e0b;
            border-radius: 12px;
            min-width: 240px;
            box-shadow: 0 3px 10px rgba(15,23,42,0.15);
        }
        .hero-title-label {
            display: block;
            font-size: 9px;
            font-weight: 700;
            color: #fbbf24 !important;
            letter-spacing: 0.8px;
            margin-bottom: 1px;
        }
        .hero-title-value {
            font-family: Consolas, Monaco, 'Cairo', monospace;
            font-size: 27px;
            font-weight: 900;
            letter-spacing: 2px;
            color: #ffffff !important;
            direction: ltr;
            line-height: 1.15;
            text-transform: uppercase;
        }

        /* ملخص الفاتورة والتاريخ على اليسار */
        .header-stats-left {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 4px;
            justify-self: end;
        }
        .stats-pills-row {
            display: flex;
            gap: 6px;
            flex-wrap: wrap;
            justify-content: flex-end;
        }
        .stat-pill {
            border: 1.5px solid #94a3b8;
            background: #ffffff !important;
            border-radius: 8px;
            padding: 2px 9px;
            text-align: center;
            min-width: 72px;
        }
        .stat-pill .lbl {
            font-size: 9px;
            font-weight: 700;
            color: #475569;
            display: block;
        }
        .stat-pill .val {
            font-size: 13px;
            font-weight: 900;
            font-family: Consolas, Monaco, monospace;
            color: #0f172a;
        }
        .meta-date-line {
            font-size: 10px;
            color: #334155;
            font-weight: 700;
            font-family: Consolas, Monaco, 'Cairo', monospace;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 0;
            direction: ltr;
        }
        th, td {
            border: 1.2px solid #334155;
            padding: 6px 8px;
            font-size: 11.5px;
            text-align: center;
        }
        th {
            background: #1e293b !important;
            color: #ffffff !important;
            font-weight: 800;
            font-family: Consolas, Monaco, monospace;
            font-size: 11.5px;
            letter-spacing: 0.3px;
        }
        td.name-cell {
            text-align: left;
            font-weight: 700;
            color: #0f172a;
        }
        tr:nth-child(even) td { background: #f8fafc; }
        tfoot td {
            background: #e2e8f0 !important;
            color: #0f172a !important;
            font-weight: 900;
            border-top: 2px solid #0f172a;
        }
        @media print {
            .no-print-bar { display: none !important; }
            body { padding: 0; }
            @page { size: A4 portrait; margin: 8mm; }
        }
    </style>
</head>
<body>
    <div class="no-print-bar">
        <div class="no-print-row">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span style="font-weight:800;font-size:12.5px;">🖨️ شكل الجدول:</span>
                <button type="button" id="mode-custom" class="btn-mode" onclick="setPrintMode('custom')">حسب المسميات المختارة</button>
                <button type="button" id="mode-invoice" class="btn-mode" onclick="setPrintMode('invoice')">وضع الفاتورة (1)</button>
                <button type="button" id="mode-stock" class="btn-mode" onclick="setPrintMode('stock')">وضع الجرد (2 - Counted quantity)</button>
                <label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;margin-right:6px;">
                    <input type="checkbox" id="chk-print-serials" onchange="renderTable()">
                    <span>إظهار السيريالات</span>
                </label>
                <div style="display:inline-flex;align-items:center;gap:4px;font-size:11px;margin-right:6px;background:rgba(255,255,255,0.15);padding:2px 6px;border-radius:6px;">
                    <span style="font-weight:bold;">📍 الفرع (Location):</span>
                    <select id="print-sel-location" onchange="renderTable()" style="padding:2px 6px;border-radius:4px;font-family:monospace;font-weight:bold;font-size:11px;color:#0f172a;background:#fff;border:1px solid #94a3b8;cursor:pointer;">
                        <option value="WH001/Stock">WH001/Stock</option>
                        <option value="expir/Stock">expir/Stock</option>
                        <option value="PH001/Stock">PH001/Stock</option>
                        <option value="PH002/Stock">PH002/Stock</option>
                        <option value="PH003/Stock">PH003/Stock</option>
                        <option value="PH004/Stock">PH004/Stock</option>
                        <option value="PH005/Stock">PH005/Stock</option>
                        <option value="PH006/Stock">PH006/Stock</option>
                        <option value="PH007/Stock">PH007/Stock</option>
                        <option value="PH008/Stock">PH008/Stock</option>
                        <option value="PH009/Stock">PH009/Stock</option>
                        <option value="">(فارغ / بدون)</option>
                        <option value="__SHEET_NAME__">تعبئة باسم الورقة</option>
                    </select>
                </div>
                <input type="checkbox" id="chk-fill-loc" ${fillLocation ? 'checked' : ''} style="display:none;" onchange="renderTable()">
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
                <input type="file" id="custom-logo-input" accept="image/*" style="display:none;" onchange="handleLogoUpload(this)">
                <button type="button" class="btn-logo-upload" onclick="document.getElementById('custom-logo-input').click()" title="رفع شعار/لوجو مخصص من جهازك">🖼️ تغيير اللوجو</button>
                <button type="button" class="btn-print-now" onclick="window.print()">🖨️ طباعة الآن</button>
                <button type="button" class="btn-close" onclick="window.close()">إغلاق ✕</button>
            </div>
        </div>
        <div class="no-print-row" style="border-top:1px solid #334155;padding-top:8px;">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                <span style="font-weight:800;font-size:12px;color:#fbbf24;">🏷️ العنوان البارز (1-50):</span>
                <button type="button" class="btn-cat-pill" onclick="quickSetCat('MEDICINE')">MEDICINE</button>
                <button type="button" class="btn-cat-pill" onclick="quickSetCat('COSMETICS')">COSMETICS</button>
                <button type="button" class="btn-cat-pill" onclick="quickSetCat('MILK')">MILK</button>
                <button type="button" class="btn-cat-pill" onclick="quickSetCat('DIAPER')">DIAPER</button>
                <select id="preview-num-select" dir="ltr" onchange="quickSetNum(this.value)" style="padding:4px 8px;border-radius:6px;font-family:monospace;font-weight:bold;color:#0f172a;">
                    <option value="">بدون رقم</option>
                </select>
                <select id="preview-order-select" onchange="quickSetOrder(this.value)" style="padding:4px 8px;border-radius:6px;font-weight:bold;font-size:11px;color:#0f172a;">
                    <option value="name_first">MEDICINE 1</option>
                    <option value="num_first">1 MEDICINE</option>
                </select>
                <input type="text" id="preview-sheet-title-input" list="preview-datalist" dir="ltr" oninput="onCustomTitleInput(this.value)"
                       placeholder="MEDICINE 1 / COSMETICS 1..."
                       style="padding:4px 10px;border-radius:6px;border:2px solid #f59e0b;font-family:monospace;font-weight:900;font-size:13px;color:#0f172a;width:210px;text-align:center;">
                <datalist id="preview-datalist"></datalist>
            </div>
        </div>
    </div>

    <!-- قالب الترويسة الاحترافية التي تتكرر تلقائياً في أعلى كل صفحة مطبوعة عبر وضعها داخل thead -->
    <template id="repeating-header-template">
        <div class="pro-print-header">
            <!-- اليمين: لوجو R - A M B F - E المتناسق -->
            <div class="brand-logo-box">
                <div class="ramadan-logo-badge">
                    <div class="ramadan-monogram print-logo-container">R</div>
                    <div class="ramadan-mid-col">
                        <div class="ramadan-mid-letters">
                            <span>A</span><span class="ramadan-mid-dot">•</span><span>M</span><span class="ramadan-mid-dot">•</span><span>B</span><span class="ramadan-mid-dot">•</span><span>F</span>
                        </div>
                        <span class="ramadan-brand-sub">PHARMACY & INVENTORY</span>
                    </div>
                    <div class="ramadan-end-monogram">E</div>
                </div>
            </div>

            <!-- المنتصف: العنوان البارز للورقة (مثل MEDICINE 1 أو COSMETICS 1 أو MILK أو DIAPER 1) -->
            <div class="hero-title-center">
                <span class="hero-title-label">SECTION / SHEET TITLE</span>
                <div class="hero-title-value sheet-custom-banner-text">${sheetTitle}</div>
            </div>

            <!-- اليسار: إجمالي الأصناف والعبوات والتاريخ -->
            <div class="header-stats-left">
                <div class="stats-pills-row">
                    <div class="stat-pill">
                        <span class="lbl">الأصناف (Items)</span>
                        <span class="val">${inv.total_items || (inv.lines || []).length}</span>
                    </div>
                    <div class="stat-pill">
                        <span class="lbl">الكمية (Qty)</span>
                        <span class="val header-total-qty-text">${inv.total_packages || 0}</span>
                    </div>
                    <div class="stat-pill sum-box-amount-el">
                        <span class="lbl">الإجمالي</span>
                        <span class="val">${parseFloat(inv.total_amount || 0).toFixed(2)}</span>
                    </div>
                </div>
                <div class="meta-date-line">
                    <span>${inv.invoice_date || new Date().toISOString().slice(0, 10)}</span>
                    <span> | </span>
                    <span>#${inv.invoice_number || ''}</span>
                </div>
            </div>
        </div>
    </template>

    <!-- جدول الأصناف مع الترويسة المتكررة في كل الصفحات داخل thead -->
    <table id="print-table">
        <thead id="print-thead"></thead>
        <tbody id="print-tbody"></tbody>
        <tfoot id="print-tfoot"></tfoot>
    </table>

    <script>
        const invoiceData = ${invJson};
        const initialCustomCols = ${customColsJson};
        let currentMode = '${startMode}';
        let currentTitle = ${initialTitleJson};
        let pCat = 'MEDICINE';
        let pNum = '1';
        let pOrder = 'name_first';

        (function initPreviewControls() {
            const numSel = document.getElementById('preview-num-select');
            for (let i = 1; i <= 50; i++) {
                const opt = document.createElement('option');
                opt.value = String(i);
                opt.textContent = String(i);
                numSel.appendChild(opt);
            }
            numSel.value = '1';

            const dl = document.getElementById('preview-datalist');
            const cats = ['MEDICINE', 'COSMETICS', 'MILK', 'DIAPER'];
            let dlHtml = '';
            cats.forEach(c => {
                dlHtml += '<option value="' + c + '"></option>';
                for (let i = 1; i <= 50; i++) {
                    dlHtml += '<option value="' + c + ' ' + i + '"></option>';
                    dlHtml += '<option value="' + i + ' ' + c + '"></option>';
                }
            });
            dl.innerHTML = dlHtml;

            // استرجاع اللوجو المخصص المحفوظ إن وجد
            const inp = document.getElementById('preview-sheet-title-input');
            inp.value = currentTitle;
            updateBannerAndDocTitle(currentTitle);
        })();

        function applyCustomLogoToAll(dataUrl) {
            document.querySelectorAll('.print-logo-container').forEach(el => {
                if (dataUrl) {
                    el.innerHTML = '<img src="' + dataUrl + '" alt="RAMADAN">';
                } else {
                    el.textContent = 'R';
                }
            });
        }

        function handleLogoUpload(input) {
            if (input.files && input.files[0]) {
                const reader = new FileReader();
                reader.onload = function(e) {
                    const dataUrl = e.target.result;
                    try { localStorage.setItem('custom_print_logo_dataurl', dataUrl); } catch (err) {}
                    applyCustomLogoToAll(dataUrl);
                };
                reader.readAsDataURL(input.files[0]);
            }
        }

        function buildTitle(cat, num, ord) {
            const c = (cat || '').trim().toUpperCase();
            const n = (num || '').toString().trim();
            if (!c && !n) return '';
            if (!n) return c;
            if (!c) return n;
            return ord === 'num_first' ? (n + ' ' + c) : (c + ' ' + n);
        }

        function quickSetCat(cat) {
            pCat = cat;
            pNum = document.getElementById('preview-num-select').value;
            pOrder = document.getElementById('preview-order-select').value;
            const t = buildTitle(pCat, pNum, pOrder);
            document.getElementById('preview-sheet-title-input').value = t;
            updateBannerAndDocTitle(t);
            renderTable();
        }

        function quickSetNum(num) {
            pNum = num;
            const raw = document.getElementById('preview-sheet-title-input').value;
            const base = raw.replace(/[0-9]/g, '').trim().toUpperCase() || pCat || 'MEDICINE';
            pCat = base;
            pOrder = document.getElementById('preview-order-select').value;
            const t = buildTitle(pCat, pNum, pOrder);
            document.getElementById('preview-sheet-title-input').value = t;
            updateBannerAndDocTitle(t);
            renderTable();
        }

        function quickSetOrder(ord) {
            pOrder = ord;
            const raw = document.getElementById('preview-sheet-title-input').value;
            const base = raw.replace(/[0-9]/g, '').trim().toUpperCase() || pCat || 'MEDICINE';
            pCat = base;
            pNum = document.getElementById('preview-num-select').value;
            const t = buildTitle(pCat, pNum, pOrder);
            document.getElementById('preview-sheet-title-input').value = t;
            updateBannerAndDocTitle(t);
            renderTable();
        }

        function onCustomTitleInput(val) {
            updateBannerAndDocTitle(val);
            renderTable();
        }

        function updateBannerAndDocTitle(val) {
            currentTitle = (val || '').trim();
            document.title = currentTitle || ('Invoice_' + (invoiceData.invoice_number || 'INV'));
            document.querySelectorAll('.sheet-custom-banner-text').forEach(el => {
                el.textContent = currentTitle || invoiceData.invoice_number || 'INVOICE';
            });
        }

        function getColumnsForMode(mode) {
            if (mode === 'invoice') {
                return [
                    { field: 'product_code', header: 'PRODUCT' },
                    { field: 'name_en', header: 'NAME' },
                    { field: 'sales_price', header: 'SALES PRICE' },
                    { field: 'batch_number', header: 'BATCH NUMBER' },
                    { field: 'quantity', header: 'QUANTITE' },
                    { field: 'unit_price', header: 'UNITPRICE' },
                    { field: 'expiry_date', header: 'expiry-date' }
                ];
            } else if (mode === 'stock') {
                return [
                    { field: 'product_code', header: 'Product' },
                    { field: 'name_en', header: 'NAME ENGLISH' },
                    { field: 'location', header: 'Location' },
                    { field: 'batch_number', header: 'Lot/Serial Number' },
                    { field: 'expiry_date', header: 'Expiry Date' },
                    { field: 'quantity', header: 'Counted quantity' }
                ];
            }
            return initialCustomCols;
        }

        function setPrintMode(mode) {
            currentMode = mode;
            ['custom', 'invoice', 'stock'].forEach(m => {
                const btn = document.getElementById('mode-' + m);
                if (btn) btn.classList.toggle('active', m === mode);
            });
            renderTable();
        }

        function renderTable() {
            const cols = getColumnsForMode(currentMode);
            const showSerials = document.getElementById('chk-print-serials').checked;
            const fillLoc = document.getElementById('chk-fill-loc')?.checked || false;
            const printLocSel = document.getElementById('print-sel-location');
            const chosenLoc = printLocSel ? printLocSel.value : ${initialLocJson};
            let resolvedLoc = '';
            if (chosenLoc === '__SHEET_NAME__') {
                resolvedLoc = currentTitle;
            } else if (chosenLoc) {
                resolvedLoc = chosenLoc;
            } else if (fillLoc) {
                resolvedLoc = currentTitle;
            }
            const hasPrices = cols.some(c => c.field === 'sales_price' || c.field === 'unit_price');
            const totalColSpan = cols.length + (showSerials ? 2 : 1);

            const thead = document.getElementById('print-thead');
            const tbody = document.getElementById('print-tbody');
            const tfoot = document.getElementById('print-tfoot');
            const tpl = document.getElementById('repeating-header-template');

            // السطر الأول داخل thead يتكرر تلقائياً في أعلى كل صفحة عند الطباعة ويحتوي على لوجو RAMADAN + العنوان البارز
            let headHtml = '<tr><th colspan="' + totalColSpan + '" class="repeating-header-cell">' + (tpl ? tpl.innerHTML : '') + '</th></tr>';
            headHtml += '<tr><th style="width:36px;">#</th>';
            cols.forEach(c => {
                headHtml += '<th>' + c.header + '</th>';
            });
            if (showSerials) {
                headHtml += '<th>Serials</th>';
            }
            headHtml += '</tr>';
            thead.innerHTML = headHtml;

            document.querySelectorAll('.sheet-custom-banner-text').forEach(el => {
                el.textContent = currentTitle || invoiceData.invoice_number || 'INVOICE';
            });
            document.querySelectorAll('.sum-box-amount-el').forEach(el => {
                el.style.display = hasPrices ? '' : 'none';
            });
            try {
                const savedLogo = localStorage.getItem('custom_print_logo_dataurl');
                if (savedLogo) applyCustomLogoToAll(savedLogo);
            } catch (e) {}

            const lines = invoiceData.lines || [];
            if (lines.length === 0) {
                tbody.innerHTML = '<tr><td colspan="' + totalColSpan + '" style="padding:20px;color:#64748b;">لا توجد أصناف ممسوحة في هذه الفاتورة</td></tr>';
                tfoot.innerHTML = '';
                return;
            }

            let bodyHtml = '';
            let totalQty = 0;
            lines.forEach((ln, idx) => {
                totalQty += (parseInt(ln.quantity) || 0);
                bodyHtml += '<tr><td style="font-family:monospace;">' + (idx + 1) + '</td>';
                cols.forEach(c => {
                    let val = '';
                    if (c.field === 'product_code') val = ln.product_code || '';
                    else if (c.field === 'name_en') val = ln.name_en || ln.product_name || ln.name_ar || '';
                    else if (c.field === 'location') val = resolvedLoc;
                    else if (c.field === 'sales_price') val = parseFloat(ln.sales_price || 0).toFixed(2);
                    else if (c.field === 'unit_price') val = parseFloat(ln.unit_price || 0).toFixed(2);
                    else if (c.field === 'batch_number') val = ln.batch_number || '';
                    else if (c.field === 'quantity') val = ln.quantity || 0;
                    else if (c.field === 'expiry_date') val = ln.expiry_date || '';

                    const cls = c.field === 'name_en' ? 'class="name-cell"' : 'style="font-family:monospace;font-weight:700;"';
                    bodyHtml += '<td ' + cls + '>' + val + '</td>';
                });
                if (showSerials) {
                    const sList = (ln.serials || []).map(s => s.serial_number).join(', ');
                    bodyHtml += '<td style="font-family:monospace;font-size:10px;text-align:left;">' + (sList || '-') + '</td>';
                }
                bodyHtml += '</tr>';
            });
            tbody.innerHTML = bodyHtml;

            document.querySelectorAll('.header-total-qty-text').forEach(el => {
                el.textContent = totalQty;
            });

            let footHtml = '<tr><td colspan="' + cols.length + '" style="text-align:right;padding-right:14px;">Total Quantity (إجمالي الكمية):</td>';
            footHtml += '<td style="font-family:monospace;font-size:13.5px;">' + totalQty + '</td>';
            if (showSerials) footHtml += '<td></td>';
            footHtml += '</tr>';
            tfoot.innerHTML = footHtml;
        }

        const initialLocFromParent = ${initialLocJson};
        const printLocEl = document.getElementById('print-sel-location');
        if (printLocEl && initialLocFromParent) {
            printLocEl.value = initialLocFromParent;
        }
        setPrintMode(currentMode);
        window.onload = function() {
            setTimeout(function() { window.print(); }, 250);
        };
    <\/script>
</body>
</html>`;

        const printWin = window.open('', '_blank', 'width=1040,height=840');
        if (printWin) {
            printWin.document.open();
            printWin.document.write(printHtml);
            printWin.document.close();
        } else {
            let iframe = document.getElementById('print-fallback-iframe');
            if (!iframe) {
                iframe = document.createElement('iframe');
                iframe.id = 'print-fallback-iframe';
                iframe.style.position = 'fixed';
                iframe.style.right = '0';
                iframe.style.bottom = '0';
                iframe.style.width = '0';
                iframe.style.height = '0';
                iframe.style.border = '0';
                document.body.appendChild(iframe);
            }
            const doc = iframe.contentWindow.document;
            doc.open();
            doc.write(printHtml);
            doc.close();
            setTimeout(() => {
                iframe.contentWindow.focus();
                iframe.contentWindow.print();
            }, 350);
        }
    };

    const handlePrintActiveInvoice = () => {
        if (!activeInvoice || !activeInvoice.id) {
            showCatalogToast('لا توجد فاتورة نشطة حالياً لطباعتها.', true);
            return;
        }
        const chosenInlineTitle = (document.getElementById('inline-sheet-name-input')?.value || '').trim();
        if (chosenInlineTitle) {
            // إذا اختار المستخدم الاسم من الشريط يذهب مباشرة لطباعة الفاتورة باللوجو والعنوان البارز والأصناف
            window.printInvoiceSheet(activeInvoice, {
                sheetTitle: chosenInlineTitle,
                fillLocation: document.getElementById('chk-sheet-name-as-location')?.checked || false
            });
        } else {
            window.openPrePrintModal(activeInvoice);
        }
    };

    document.getElementById('btn-open-naming-grid')?.addEventListener('click', () => {
        if (activeInvoice) window.openPrePrintModal(activeInvoice);
    });

    document.getElementById('btn-print-invoice')?.addEventListener('click', handlePrintActiveInvoice);
    document.getElementById('btn-print-invoice-table')?.addEventListener('click', handlePrintActiveInvoice);

    // زر مسح وتفريغ جميع أصناف الفاتورة بالكامل بعد العملية
    document.getElementById('btn-clear-invoice-lines')?.addEventListener('click', handleClearInvoiceLines);
    document.getElementById('btn-clear-invoice-lines-table')?.addEventListener('click', handleClearInvoiceLines);

    // زر استيراد وتفريغ فاتورة من ملف Excel أو CSV
    const btnTriggerInv = document.getElementById('btn-trigger-inv-upload');
    const invFileInput = document.getElementById('invoice-file-input');
    btnTriggerInv?.addEventListener('click', () => invFileInput?.click());
    invFileInput?.addEventListener('change', async () => {
        if (invFileInput.files && invFileInput.files[0]) {
            await handleInvoiceFileUpload(invFileInput.files[0]);
            invFileInput.value = '';
        }
    });

    // تسجيل الصنف غير المسجل من صندوق تفريغ الـ QR مع دعم سعر البيع والاسم بالعربي والإنجليزي
    document.getElementById('btn-quick-register-item')?.addEventListener('click', async () => {
        const nameEn = document.getElementById('quick-add-name-en')?.value.trim() || '';
        const nameAr = document.getElementById('quick-add-name-ar')?.value.trim() || '';
        const priceVal = parseFloat(document.getElementById('quick-add-price')?.value) || 0.0;
        const costVal = parseFloat(document.getElementById('quick-add-cost')?.value) || 0.0;
        const taxVal = parseFloat(document.getElementById('quick-add-tax')?.value) || 0.0;
        const gtinVal = lastScannedGtin || document.getElementById('field-gtin')?.value.trim();

        if (!nameEn && !nameAr) {
            alert('يرجى كتابة اسم الصنف (بالإنجليزي أو بالعربي) أولاً لحفظه.');
            (document.getElementById('quick-add-name-en') || document.getElementById('quick-add-name-ar'))?.focus();
            return;
        }
        if (!gtinVal) {
            alert('لا يوجد GTIN صالح ممسوح.');
            return;
        }

        const btn = document.getElementById('btn-quick-register-item');
        btn.disabled = true;
        btn.textContent = 'جاري الحفظ...';

        try {
            const res = await fetch('/api/catalog/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name_en: nameEn || nameAr,
                    name_ar: nameAr || nameEn,
                    gtin_list: [gtinVal],
                    barcode_list: [],
                    selling_price: priceVal,
                    unit_price: costVal,
                    tax_rate: taxVal
                })
            });
            const data = await res.json();
            if (data.success) {
                document.getElementById('unpacked-unregistered-box')?.classList.add('hidden');
                if (document.getElementById('quick-add-name-en')) document.getElementById('quick-add-name-en').value = '';
                if (document.getElementById('quick-add-name-ar')) document.getElementById('quick-add-name-ar').value = '';
                if (document.getElementById('quick-add-price')) document.getElementById('quick-add-price').value = '';
                if (document.getElementById('quick-add-cost')) document.getElementById('quick-add-cost').value = '';
                if (document.getElementById('quick-add-tax')) document.getElementById('quick-add-tax').value = '0';
                refreshSystemStats();
                if (lastScannedQr) {
                    await executeScan(lastScannedQr);
                }
            } else {
                alert(data.message || 'فشل حفظ الصنف.');
            }
        } catch (e) {
            alert('خطأ: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.textContent = '➕ حفظ الصنف وإضافته للفاتورة فوراً';
        }
    });

    // إغلاق صندوق الصنف غير المسجل
    document.getElementById('btn-dismiss-unreg-box')?.addEventListener('click', () => {
        document.getElementById('unpacked-unregistered-box')?.classList.add('hidden');
        document.getElementById('scan-datamatrix-input')?.focus();
    });

    // فتح بطاقة الصنف بالكامل وتعبئة الـ GTIN والبيانات المدخلة
    document.getElementById('btn-unreg-open-full-modal')?.addEventListener('click', async () => {
        const gtinVal = lastScannedGtin || document.getElementById('field-gtin')?.value.trim();
        const nameEn = document.getElementById('quick-add-name-en')?.value.trim() || '';
        const nameAr = document.getElementById('quick-add-name-ar')?.value.trim() || '';
        const priceVal = document.getElementById('quick-add-price')?.value || '';
        const costVal = document.getElementById('quick-add-cost')?.value || '';
        const taxVal = document.getElementById('quick-add-tax')?.value || '0';
        await openCreateProductModal(gtinVal, {
            name_en: nameEn,
            name_ar: nameAr,
            selling_price: priceVal,
            unit_price: costVal,
            tax_rate: taxVal
        });
    });

    // استماع لزر Enter في حقول الإضافة السريعة للصنف غير المسجل
    ['quick-add-name-en', 'quick-add-name-ar', 'quick-add-price', 'quick-add-cost', 'quick-add-tax'].forEach(id => {
        document.getElementById(id)?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('btn-quick-register-item')?.click();
            }
        });
    });

    // ماسح الكاميرا
    initCameraScanner();

    // نافذة استعراض وحذف سيريالات السطر
    document.getElementById('btn-close-serials-modal')?.addEventListener('click', closeSerialsModal);
    document.getElementById('btn-done-serials-modal')?.addEventListener('click', closeSerialsModal);
}

// استيراد وتفريغ فاتورة من ملف Excel أو CSV مباشرة
async function handleInvoiceFileUpload(file) {
    const formData = new FormData();
    formData.append('file', file);
    if (activeInvoice && activeInvoice.id) {
        formData.append('invoice_id', activeInvoice.id);
    }
    formData.append('user_name', 'المسؤول');

    showScanBanner('info', 'جاري قراءة ملف الفاتورة وتفريغ العبوات في الفاتورة...');

    try {
        const res = await fetch('/api/invoice/upload-file', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            renderInvoice(data.invoice);
            showScanBanner('success', data.message || 'تم تفريغ بنود الفاتورة بنجاح!');
            addScanToStream('success', `[استيراد ملف] تم تفريغ ${data.imported_count || 0} عبوة من الملف: ${file.name}`);
        } else {
            showScanBanner('error', data.message || 'فشل استيراد الفاتورة.');
        }
    } catch (e) {
        showScanBanner('error', 'خطأ أثناء رفع ملف الفاتورة: ' + e.message);
    }
}

async function loadActiveDraftInvoice() {
    try {
        const res = await fetch('/api/invoice/active', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (isUnavailableApiResponse(res, data)) return;
        if (data.success && data.invoice) {
            renderInvoice(data.invoice);
        }
    } catch (e) {
        console.error('Error fetching active invoice:', e);
        updateConnectionBanner('offline');
    }
}

// دالة تفريغ حقول المسح وإعادتها للحالة الأولية
function clearScanFields() {
    const dmInput = document.getElementById('scan-datamatrix-input');
    if (dmInput) {
        dmInput.value = '';
        dmInput.focus();
    }
    const fg = document.getElementById('field-gtin');
    if (fg) fg.value = '';
    const fb = document.getElementById('field-batch');
    if (fb) fb.value = '';
    const fe = document.getElementById('field-expiry');
    if (fe) fe.value = '';
    const fq = document.getElementById('field-qty');
    if (fq) fq.value = 1;

    const cEl = document.getElementById('info-prod-code');
    if (cEl) cEl.textContent = '-';
    const nEl = document.getElementById('info-prod-name');
    if (nEl) nEl.textContent = '-';
    const gEl = document.getElementById('info-gtin');
    if (gEl) gEl.textContent = '-';
    const bEl = document.getElementById('info-batch');
    if (bEl) bEl.textContent = '-';
    const sEl = document.getElementById('info-serial');
    if (sEl) sEl.textContent = '-';
    const eEl = document.getElementById('info-expiry');
    if (eEl) eEl.textContent = '-';
    const lqEl = document.getElementById('info-line-qty');
    if (lqEl) lqEl.textContent = '-';

    const badge = document.getElementById('info-status-badge');
    if (badge) {
        badge.textContent = 'بانتظار المسح';
        badge.className = 'px-1.5 py-0.2 rounded text-[10px] font-bold bg-slate-200 text-slate-600 font-sans';
    }
}

// دالة مسح وتفريغ جميع أصناف الفاتورة بالكامل بعد العملية
async function handleClearInvoiceLines() {
    if (!activeInvoice || !activeInvoice.id) return;
    if (!activeInvoice.lines || activeInvoice.lines.length === 0) {
        showScanBanner('info', 'الفاتورة فارغة بالفعل ولا تحتوي على أي أصناف.');
        return;
    }
    if (confirm('هل ترغب بالتأكيد في مسح جميع الأصناف والعبوات من الفاتورة بالكامل وتفريغها بعد العملية؟')) {
        try {
            const res = await fetch('/api/invoice/clear-lines', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ invoice_id: activeInvoice.id })
            });
            const data = await res.json();
            if (data.success) {
                renderInvoice(data.invoice);
                showScanBanner('success', data.message || 'تم مسح وتفريغ جميع أصناف الفاتورة بنجاح.');
                clearScanFields();
            } else {
                showScanBanner('error', data.message);
            }
        } catch (e) {
            alert('حدث خطأ أثناء مسح أصناف الفاتورة: ' + e.message);
        }
    }
}

function renderInvoice(inv) {
    activeInvoice = inv;
    document.getElementById('inv-header-number').textContent = inv.invoice_number || 'INV-...';
    document.getElementById('inv-header-date').textContent = inv.invoice_date || '';
    document.getElementById('inv-header-user').textContent = inv.user_name || 'المسؤول';
    
    const statusBadge = document.getElementById('inv-header-status-badge');
    if (inv.status === 'confirmed') {
        statusBadge.textContent = 'معتمدة ومقفلة';
        statusBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-200';
    } else {
        statusBadge.textContent = 'مسودة نشطة';
        statusBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-800 border border-amber-200';
    }

    document.getElementById('inv-total-items').textContent = (inv.total_items || 0).toLocaleString();
    document.getElementById('inv-total-packages').textContent = (inv.total_packages || 0).toLocaleString();
    document.getElementById('inv-total-amount').textContent = (inv.total_amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' ر.س';

    const tbody = document.getElementById('invoice-lines-tbody');
    tbody.innerHTML = '';

    const lines = inv.lines || [];
    if (lines.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="10" class="py-6 text-center text-slate-400">
                    <p class="text-sm font-semibold mb-0.5">لا توجد عبوات ممسوحة في هذه الفاتورة حتى الآن</p>
                    <p class="text-[11px]">امسح كود داتا ماتريكس أو باركود الصنف للبدء في تجميع الفاتورة فوراً</p>
                </td>
            </tr>
        `;
        return;
    }

    // تمييز الباتشات المختلفة بألوان مميزة وتنبيه بصري فوري عند اختلاف الباتش لنفس الصنف
    const batchPalette = [
        'bg-amber-100 text-amber-900 border border-amber-300',
        'bg-teal-100 text-teal-900 border border-teal-300',
        'bg-purple-100 text-purple-900 border border-purple-300',
        'bg-rose-100 text-rose-900 border border-rose-300',
        'bg-sky-100 text-sky-900 border border-sky-300',
        'bg-emerald-100 text-emerald-900 border border-emerald-300'
    ];
    const uniqueBatches = Array.from(new Set(lines.map(l => l.batch_number)));
    const batchColorMap = {};
    uniqueBatches.forEach((b, i) => {
        batchColorMap[b] = batchPalette[i % batchPalette.length];
    });

    const productBatchCounts = {};
    lines.forEach(l => {
        productBatchCounts[l.product_code] = (productBatchCounts[l.product_code] || 0) + 1;
    });

    lines.forEach((line, idx) => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-sky-50/70 transition text-center font-medium';

        // إظهار الاسم بالإنجليزية كاملاً
        const engName = line.name_en || line.product_name || line.name_ar || '';
        const arName = (line.name_ar && line.name_ar !== engName) ? line.name_ar : '';
        const salesPrice = parseFloat(line.sales_price || 0).toFixed(2);
        const unitPrice = parseFloat(line.unit_price || 0).toFixed(2);
        const batchColor = batchColorMap[line.batch_number] || 'bg-slate-100 text-slate-800 border border-slate-300';
        const hasMultipleBatches = productBatchCounts[line.product_code] > 1;

        // عرض السيريالات الممسوحة بنظام خلايا إكسيل مقتضب ومضغوط
        const serialsList = (line.serials || []).map(s => s.serial_number);
        let serialsHtml = '';
        if (serialsList.length === 0) {
            serialsHtml = `<span class="text-slate-400 font-mono text-[10px]">-</span>`;
        } else if (serialsList.length === 1) {
            serialsHtml = `
                <div class="flex items-center justify-center gap-1 leading-none">
                    <span class="font-mono text-[10px] text-slate-700 bg-white border border-slate-300 px-1 py-0.2 rounded truncate max-w-[80px]" title="${serialsList[0]}">${serialsList[0]}</span>
                    <button class="btn-view-serials text-indigo-600 hover:text-indigo-900 text-[10px] p-0" data-line-id="${line.id}" title="عرض تفاصيل السيريال">🔍</button>
                </div>
            `;
        } else {
            serialsHtml = `
                <div class="flex items-center justify-center gap-1 leading-none">
                    <span class="font-mono text-[10px] font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-1 py-0.2 rounded">${serialsList.length} سيريال</span>
                    <button class="btn-view-serials text-indigo-600 hover:text-indigo-900 text-[10px] font-bold underline" data-line-id="${line.id}" title="عرض وإدارة سيريالات هذا الباتش">🔍 عرض</button>
                </div>
            `;
        }

        tr.innerHTML = `
            <td class="excel-cell text-center font-mono text-slate-400 text-[10px]">${idx + 1}</td>
            <td class="excel-cell text-center font-mono font-bold text-indigo-700 bg-indigo-50/40 text-[11px]">${line.product_code}</td>
            <td class="excel-cell text-left px-2" title="${engName} ${arName ? `(${arName})` : ''}">
                <div class="font-bold text-slate-900 text-[11px] leading-tight select-all">${engName}</div>
                ${arName ? `<div class="text-[9.5px] text-slate-400 font-normal leading-none mt-0.5">${arName}</div>` : ''}
            </td>
            <td class="excel-cell text-center font-mono font-bold text-emerald-700 text-[11px]">${salesPrice}</td>
            <td class="excel-cell text-center font-mono">
                <span class="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded text-[10.5px] font-bold ${batchColor}">
                    <span>${String(line.batch_number || '').toUpperCase()}</span>
                    ${hasMultipleBatches ? '<span class="text-[9px] bg-amber-500 text-white px-0.5 rounded leading-none" title="يوجد باتش آخر لنفس الصنف">⚠️</span>' : ''}
                </span>
            </td>
            <td class="excel-cell text-center p-0.5">
                <div class="inline-flex items-center justify-center gap-0.5">
                    <button class="btn-qty-minus w-4 h-4 bg-slate-100 hover:bg-rose-100 hover:text-rose-700 text-slate-600 rounded flex items-center justify-center text-xs font-bold leading-none transition" data-line-id="${line.id}" title="تقليل الكمية بمقدار 1">-</button>
                    <input type="number" min="1" value="${line.quantity}" 
                           class="input-line-qty w-12 h-4 text-center font-mono font-black text-xs text-indigo-950 bg-indigo-50/80 border border-indigo-200 rounded focus:bg-white focus:border-indigo-600 outline-none" 
                           data-line-id="${line.id}" title="اضغط لتعديل العدد يدويًا">
                    <button class="btn-qty-plus w-4 h-4 bg-slate-100 hover:bg-emerald-100 hover:text-emerald-700 text-slate-600 rounded flex items-center justify-center text-xs font-bold leading-none transition" data-line-id="${line.id}" title="زيادة الكمية بمقدار 1">+</button>
                </div>
            </td>
            <td class="excel-cell text-center font-mono text-slate-600 text-[11px]">${unitPrice}</td>
            <td class="excel-cell text-center font-mono text-slate-700 text-[11px]">${line.expiry_date}</td>
            <td class="excel-cell text-center">${serialsHtml}</td>
            <td class="excel-cell text-center">
                <div class="inline-flex items-center justify-center gap-1.5">
                    <button class="btn-edit-invoice-product text-indigo-600 hover:text-indigo-900 p-0.5 text-xs leading-none" data-product-code="${line.product_code}" title="تعديل كرت الصنف والأسعار يدوياً">✏️</button>
                    ${inv.status === 'draft' ? `
                    <button class="btn-del-line text-rose-500 hover:text-rose-700 p-0.5 text-xs leading-none" data-line-id="${line.id}" title="حذف السطر">
                        🗑️
                    </button>` : ''}
                </div>
            </td>
        `;
        tbody.appendChild(tr);
    });

    // ربط أحداث تعديل كرت الصنف مباشرة من سطر الفاتورة
    document.querySelectorAll('.btn-edit-invoice-product').forEach(btn => {
        btn.addEventListener('click', async () => {
            const code = btn.getAttribute('data-product-code');
            if (code) {
                await openEditProductModalByCode(code);
            }
        });
    });

    // ربط أحداث تعديل الكمية يدوياً
    document.querySelectorAll('.input-line-qty').forEach(inp => {
        inp.addEventListener('change', async () => {
            const lineId = parseInt(inp.getAttribute('data-line-id'));
            const newQty = parseInt(inp.value) || 1;
            await updateLineQuantity(lineId, newQty);
        });
        inp.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                inp.blur();
            }
        });
    });

    document.querySelectorAll('.btn-qty-plus').forEach(btn => {
        btn.addEventListener('click', async () => {
            const lineId = parseInt(btn.getAttribute('data-line-id'));
            const inp = document.querySelector(`.input-line-qty[data-line-id="${lineId}"]`);
            const currentQty = parseInt(inp ? inp.value : 1) || 1;
            await updateLineQuantity(lineId, currentQty + 1);
        });
    });

    document.querySelectorAll('.btn-qty-minus').forEach(btn => {
        btn.addEventListener('click', async () => {
            const lineId = parseInt(btn.getAttribute('data-line-id'));
            const inp = document.querySelector(`.input-line-qty[data-line-id="${lineId}"]`);
            const currentQty = parseInt(inp ? inp.value : 1) || 1;
            if (currentQty > 1) {
                await updateLineQuantity(lineId, currentQty - 1);
            }
        });
    });

    document.querySelectorAll('.btn-view-serials').forEach(btn => {
        btn.addEventListener('click', () => {
            const lineId = parseInt(btn.getAttribute('data-line-id'));
            const line = lines.find(l => l.id === lineId);
            if (line) openSerialsModal(line);
        });
    });

    document.querySelectorAll('.btn-del-line').forEach(btn => {
        btn.addEventListener('click', async () => {
            const lineId = parseInt(btn.getAttribute('data-line-id'));
            if (confirm('هل ترغب في حذف هذا السطر وسيريالاته بالكامل؟')) {
                try {
                    const res = await fetch('/api/invoice/delete-line', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ invoice_id: activeInvoice.id, line_id: lineId })
                    });
                    const data = await res.json();
                    if (data.success) {
                        renderInvoice(data.invoice);
                        showScanBanner('info', data.message);
                    }
                } catch (e) {
                    alert('خطأ: ' + e.message);
                }
            }
        });
    });
}

// تعديل كمية سطر الفاتورة يدوياً
async function updateLineQuantity(lineId, newQty) {
    if (!activeInvoice || !activeInvoice.id) return;
    try {
        const res = await fetch('/api/invoice/update-line-qty', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                invoice_id: activeInvoice.id,
                line_id: lineId,
                quantity: newQty
            })
        });
        const data = await res.json();
        if (data.success) {
            renderInvoice(data.invoice);
            showScanBanner('success', data.message);
        } else {
            showScanBanner('error', data.message);
        }
    } catch (e) {
        showScanBanner('error', 'فشل تعديل الكمية: ' + e.message);
    }
}

// تنفيذ عملية المسح الضوئي
async function executeScan(qrText) {
    if (!qrText || !qrText.trim()) return;
    const invId = activeInvoice ? activeInvoice.id : 0;
    const cleanQr = decodeArabicKeyboard(qrText.trim());
    lastScannedQr = cleanQr;

    const dmInput = document.getElementById('scan-datamatrix-input');
    if (dmInput && dmInput.value !== cleanQr) {
        dmInput.value = cleanQr;
    }

    try {
        const res = await fetch('/api/invoice/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                invoice_id: invId,
                qr_text: cleanQr,
                code: cleanQr,
                quantity: 1,
                user_name: 'المسؤول'
            })
        });

        const data = await res.json();

        // تحديث الحقول الظاهرة فورياً كما في صورة المستخدم
        const gtin = data.gtin || (data.parsed_qr && data.parsed_qr.gtin) || '';
        const batch = String(data.batch || (data.parsed_qr && data.parsed_qr.batch) || '').toUpperCase();
        const serial = data.serial || (data.parsed_qr && data.parsed_qr.serial) || '';
        const expiry = data.expiry || (data.parsed_qr && data.parsed_qr.expiry) || '';
        lastScannedGtin = gtin;

        const fieldGtin = document.getElementById('field-gtin');
        const fieldBatch = document.getElementById('field-batch');
        const fieldExpiry = document.getElementById('field-expiry');
        const fieldQty = document.getElementById('field-qty');

        if (fieldGtin && gtin) fieldGtin.value = gtin;
        if (fieldBatch && batch) fieldBatch.value = batch;
        if (fieldExpiry && expiry) fieldExpiry.value = formatExpiryDisplay(expiry);
        if (fieldQty) fieldQty.value = 1;

        // تحديث شريط تفاصيل العبوة الممسوحة حالياً (GTIN، الباتش، السيريال، تاريخ الانتهاء، كود الصنف)
        const infoCode = document.getElementById('info-prod-code');
        const infoName = document.getElementById('info-prod-name');
        const infoGtin = document.getElementById('info-gtin');
        const infoBatch = document.getElementById('info-batch');
        const infoSerial = document.getElementById('info-serial');
        const infoExpiry = document.getElementById('info-expiry');
        const infoLineQty = document.getElementById('info-line-qty');
        const statusBadge = document.getElementById('info-status-badge');

        if (infoCode) infoCode.textContent = data.product_code || '-';
        if (infoName) infoName.textContent = data.name_en || data.name || '-';
        if (infoGtin) infoGtin.textContent = gtin || '-';
        if (infoBatch) infoBatch.textContent = batch || '-';
        if (infoSerial) infoSerial.textContent = serial || '-';
        if (infoExpiry) infoExpiry.textContent = formatExpiryDisplay(expiry) || '-';
        if (infoLineQty) infoLineQty.textContent = data.line_qty != null ? data.line_qty : '-';
        if (infoSerial) infoSerial.textContent = serial || '-';
        if (infoExpiry) infoExpiry.textContent = formatExpiryDisplay(expiry) || '-';

        const unregBox = document.getElementById('unpacked-unregistered-box');

        if (data.success) {
            if (statusBadge) {
                statusBadge.textContent = 'تمت الإضافة بنجاح ✓';
                statusBadge.className = 'px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300';
            }
            unregBox?.classList.add('hidden');
            renderInvoice(data.invoice);
            showScanBanner('success', data.message);
            addScanToStream('success', `[${data.product_code}] ${data.name_en || data.name} | باتش: ${data.batch} | سيريال: ${data.serial} | الكمية: ${data.line_qty}`);
            
            // تفريغ خانة المسح وإعادة المؤشر إليها فوراً لاستقبال المسحة التالية بدون الضغط على إضافة
            if (dmInput) {
                dmInput.value = '';
                dmInput.focus();
            }
        } else {
            if (data.code === 'DUPLICATE_IN_CURRENT') {
                if (statusBadge) {
                    statusBadge.textContent = 'سيريال مكرر ⚠️';
                    statusBadge.className = 'px-2 py-0.5 rounded text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300';
                }
                showScanBanner('warning', data.message);
                addScanToStream('warning', `[رفض تكرار] سيريال مكرر في الفاتورة الحالية: ${serial}`);
                if (dmInput) {
                    dmInput.value = '';
                    dmInput.focus();
                }
            } else if (data.code === 'ALREADY_CONFIRMED') {
                if (statusBadge) {
                    statusBadge.textContent = 'سيريال معتمد مسبقاً ⚠️';
                    statusBadge.className = 'px-2 py-0.5 rounded text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300';
                }
                showScanBanner('warning', data.message);
                addScanToStream('warning', `[رفض تكرار] سيريال ممسوح في فاتورة معتمدة سابقة: ${serial}`);
                if (dmInput) {
                    dmInput.value = '';
                    dmInput.focus();
                }
            } else if (data.code === 'ITEM_NOT_FOUND') {
                if (statusBadge) {
                    statusBadge.textContent = 'صنف غير مسجل ❌';
                    statusBadge.className = 'px-2 py-0.5 rounded text-[11px] font-bold bg-rose-100 text-rose-800 border border-rose-300';
                }
                showScanBanner('error', data.message);
                addScanToStream('error', `[خطأ صنف] GTIN غير مسجل (${gtin})`);
                if (unregBox) {
                    const displayEl = document.getElementById('unreg-gtin-display');
                    if (displayEl) displayEl.textContent = gtin || 'غير معروف';
                    unregBox.classList.remove('hidden');
                    (document.getElementById('quick-add-name-en') || document.getElementById('quick-add-name-ar'))?.focus();
                }
            } else if (data.code === 'MISSING_BATCH_OR_SERIAL') {
                if (statusBadge) {
                    statusBadge.textContent = 'بيانات ناقصة ⚠️';
                    statusBadge.className = 'px-2 py-0.5 rounded text-[11px] font-bold bg-purple-100 text-purple-800 border border-purple-300';
                }
                showScanBanner('purple', data.message);
                addScanToStream('error', `[بيانات ناقصة] كود QR لا يحتوي على باتش أو سيريال`);
                dmInput?.focus();
            } else {
                showScanBanner('error', data.message || 'فشل المسح');
                addScanToStream('error', data.message || 'فشل المسح');
                dmInput?.focus();
            }
        }
    } catch (e) {
        showScanBanner('error', 'حدث خطأ في الاتصال بالخادم: ' + e.message);
        dmInput?.focus();
    }
}

// عرض رسالة التنبيه المباشرة في شريط ملون وواضح
function showScanBanner(type, message) {
    const banner = document.getElementById('scan-message-banner');
    const textEl = document.getElementById('scan-message-text');
    const iconEl = document.getElementById('scan-message-icon');
    if (!banner || !textEl) return;

    textEl.textContent = message;
    banner.classList.remove('hidden', 'bg-emerald-50', 'text-emerald-800', 'border-emerald-200',
                            'bg-amber-50', 'text-amber-800', 'border-amber-200',
                            'bg-rose-50', 'text-rose-800', 'border-rose-200',
                            'bg-indigo-50', 'text-indigo-800', 'border-indigo-200',
                            'bg-purple-50', 'text-purple-800', 'border-purple-200');

    if (type === 'success') {
        banner.classList.add('bg-emerald-50', 'text-emerald-800', 'border-emerald-200');
        iconEl.textContent = '✅';
    } else if (type === 'warning') {
        banner.classList.add('bg-amber-50', 'text-amber-900', 'border-amber-300');
        iconEl.textContent = '⚠️';
    } else if (type === 'purple') {
        banner.classList.add('bg-purple-50', 'text-purple-900', 'border-purple-300');
        iconEl.textContent = 'ℹ️';
    } else if (type === 'info') {
        banner.classList.add('bg-indigo-50', 'text-indigo-900', 'border-indigo-300');
        iconEl.textContent = '📋';
    } else {
        banner.classList.add('bg-rose-50', 'text-rose-900', 'border-rose-300');
        iconEl.textContent = '❌';
    }
}

function addScanToStream(type, text) {
    const stream = document.getElementById('scan-stream-container');
    const countEl = document.getElementById('scan-stream-count');
    if (!stream) return;

    if (stream.children.length === 1 && stream.children[0].tagName === 'P') {
        stream.innerHTML = '';
    }

    const timeStr = new Date().toLocaleTimeString('ar-SA');
    const div = document.createElement('div');
    div.className = `p-2 rounded-lg border text-xs flex items-center justify-between transition animate-fadeIn ${
        type === 'success' ? 'bg-emerald-50/70 border-emerald-200 text-emerald-900' :
        type === 'warning' ? 'bg-amber-50/80 border-amber-200 text-amber-900' :
        'bg-rose-50/70 border-rose-200 text-rose-900'
    }`;
    div.innerHTML = `
        <div class="flex items-center gap-2">
            <span>${type === 'success' ? '✓' : (type === 'warning' ? '⚠' : '✕')}</span>
            <span>${text}</span>
        </div>
        <span class="text-[10px] opacity-60">${timeStr}</span>
    `;

    stream.insertBefore(div, stream.firstChild);
    if (countEl) {
        countEl.textContent = stream.children.length + ' عملية';
    }
}

function clearScanStream() {
    const stream = document.getElementById('scan-stream-container');
    if (stream) {
        stream.innerHTML = '<p class="text-slate-400 text-center py-3 text-xs font-sans">بانتظار بدء عمليات المسح...</p>';
    }
    const countEl = document.getElementById('scan-stream-count');
    if (countEl) countEl.textContent = '0 عملية';
}

// نافذة تفاصيل السيريالات
function openSerialsModal(line) {
    const modal = document.getElementById('modal-line-serials');
    document.getElementById('modal-serials-title').textContent = `سيريالات الصنف: ${line.name_en || line.name_ar || line.product_code}`;
    document.getElementById('modal-serials-subtitle').textContent = `كود الصنف: ${line.product_code} | الباتش: ${line.batch_number} | الصلاحية: ${line.expiry_date} | الكمية: ${line.quantity}`;

    const listEl = document.getElementById('modal-serials-list');
    listEl.innerHTML = '';

    const serials = line.serials || [];
    if (serials.length === 0) {
        listEl.innerHTML = '<p class="p-4 text-center text-slate-400">لا توجد سيريالات مسجلة لهذا السطر</p>';
    } else {
        serials.forEach((s, idx) => {
            const div = document.createElement('div');
            div.className = 'p-3 flex items-center justify-between hover:bg-slate-50 transition';
            div.innerHTML = `
                <div class="flex items-center gap-3">
                    <span class="w-6 text-slate-400 font-mono text-center">${idx + 1}</span>
                    <div>
                        <p class="font-mono font-bold text-slate-800">${s.serial_number}</p>
                        <p class="text-[10px] text-slate-400">${s.scanned_at || ''}</p>
                    </div>
                </div>
                ${activeInvoice && activeInvoice.status === 'draft' ? `
                <button class="btn-del-single-serial px-2.5 py-1 bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 rounded text-xs font-bold transition flex items-center gap-1" data-serial-id="${s.id}">
                    <span>✕</span>
                    <span>حذف العبوة</span>
                </button>` : '<span class="text-xs text-slate-400 font-semibold">معتمدة</span>'}
            `;
            listEl.appendChild(div);
        });

        // أحداث حذف السيريال الفردي
        document.querySelectorAll('.btn-del-single-serial').forEach(btn => {
            btn.addEventListener('click', async () => {
                const serialId = parseInt(btn.getAttribute('data-serial-id'));
                if (confirm('هل ترغب في حذف هذه العبوة ذات السيريال من الفاتورة؟ سيتم إنقاص الكمية تلقائياً.')) {
                    try {
                        const res = await fetch('/api/invoice/delete-serial', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ invoice_id: activeInvoice.id, serial_id: serialId })
                        });
                        const data = await res.json();
                        if (data.success) {
                            renderInvoice(data.invoice);
                            closeSerialsModal();
                            showScanBanner('info', data.message);
                        }
                    } catch (e) {
                        alert('خطأ أثناء الحذف: ' + e.message);
                    }
                }
            });
        });
    }

    modal?.classList.remove('hidden');
}

function closeSerialsModal() {
    document.getElementById('modal-line-serials')?.classList.add('hidden');
}

// ==================== مسح بالكاميرا المباشرة والجوال (1D Barcode • QR • DataMatrix) ====================
cameraScanMode = 'invoice'; // 'invoice' | 'stocktake' | 'gtin'
let cameraTorchOn = false;
let cameraFacingMode = 'environment';
let cameraLastScanCode = '';
let cameraLastScanTime = 0;
let appAudioCtx = null;

function playAppScannerBeep(isSuccess = true) {
    try {
        if (!appAudioCtx) {
            appAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (appAudioCtx.state === 'suspended') {
            appAudioCtx.resume();
        }
        const osc = appAudioCtx.createOscillator();
        const gain = appAudioCtx.createGain();
        osc.connect(gain);
        gain.connect(appAudioCtx.destination);
        if (isSuccess) {
            osc.type = 'sine';
            osc.frequency.setValueAtTime(1400, appAudioCtx.currentTime);
            gain.gain.setValueAtTime(0.18, appAudioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, appAudioCtx.currentTime + 0.12);
            osc.start();
            osc.stop(appAudioCtx.currentTime + 0.12);
        } else {
            osc.type = 'square';
            osc.frequency.setValueAtTime(320, appAudioCtx.currentTime);
            gain.gain.setValueAtTime(0.2, appAudioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, appAudioCtx.currentTime + 0.22);
            osc.start();
            osc.stop(appAudioCtx.currentTime + 0.22);
        }
    } catch(e) {}
    if (navigator.vibrate) {
        try { navigator.vibrate(isSuccess ? [70] : [120, 60, 120]); } catch(e) {}
    }
}

function initCameraScanner() {
    const btnOpenInv = document.getElementById('btn-open-camera');
    const btnOpenStk = document.getElementById('btn-stk-open-camera');
    const btnClose = document.getElementById('btn-close-camera');
    const modal = document.getElementById('modal-camera-scanner');

    btnOpenInv?.addEventListener('click', () => {
        openCameraModal('invoice');
    });

    btnOpenStk?.addEventListener('click', () => {
        openCameraModal('stocktake');
    });

    document.getElementById('btn-scan-gtin-camera')?.addEventListener('click', () => {
        activeGtinTargetInput = document.getElementById('prod-primary-gtin');
        openCameraModal('gtin');
    });

    // أزرار لوحة فحص كود GS1 قبل الفلترة
    document.getElementById('btn-confirm-gs1-gtin')?.addEventListener('click', confirmGs1GtinOnly);
    document.getElementById('btn-cancel-gs1-inspect')?.addEventListener('click', cancelGs1Inspector);

    btnClose?.addEventListener('click', () => {
        stopCamera();
        modal?.classList.add('hidden');
    });

    // كشاف الكاميرا
    document.getElementById('btn-camera-modal-torch')?.addEventListener('click', async () => {
        if (!html5QrScannerInstance) return;
        try {
            cameraTorchOn = !cameraTorchOn;
            await html5QrScannerInstance.applyVideoConstraints({
                advanced: [{ torch: cameraTorchOn }]
            });
        } catch (e) {
            alert('الكشاف غير مدعوم في هذه الكاميرا أو المتصفح.');
        }
    });

    // تبديل الكاميرا
    document.getElementById('btn-camera-modal-flip')?.addEventListener('click', () => {
        cameraFacingMode = (cameraFacingMode === 'environment') ? 'user' : 'environment';
        startCamera();
    });

    // لمس شاشة الكاميرا لضبط الفوكس والتركيز التلقائي عند الاقتراب من علبة الدواء
    document.getElementById('camera-viewport-touch-area')?.addEventListener('click', async (e) => {
        try {
            const video = document.querySelector('#camera-reader-viewport video');
            if (video && video.srcObject) {
                const [track] = video.srcObject.getVideoTracks();
                if (track && track.applyConstraints) {
                    await track.applyConstraints({
                        advanced: [{ focusMode: 'continuous' }]
                    });
                }
            }
        } catch (err) {}
    });

    // التقاط صورة بديلة بالكاميرا
    const handleSnapFileInput = async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
            if (!html5QrScannerInstance) {
                html5QrScannerInstance = new Html5Qrcode("camera-reader-viewport", { verbose: false });
            }
            const decodedText = await html5QrScannerInstance.scanFile(file, true);
            if (decodedText) {
                handleCameraDecodedText(decodedText);
            }
        } catch (err) {
            alert('لم يتم العثور على باركود أو كود صالح في الصورة. التقط صورة أوضح ومقربة.');
        } finally {
            e.target.value = '';
        }
    };
    document.getElementById('modal-camera-file-input')?.addEventListener('change', handleSnapFileInput);
    document.getElementById('modal-camera-fallback-file')?.addEventListener('change', handleSnapFileInput);

    // تهيئة ربط الجوال كاسكانر لاسلكي
    initMobileCompanionScanner();
}

function openCameraModal(mode = 'invoice') {
    // تفعيل ومزامنة صوت الاسكانر فوراً بلمسة المستخدم
    try {
        if (!appAudioCtx) appAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (appAudioCtx.state === 'suspended') appAudioCtx.resume();
    } catch(e) {}

    cameraScanMode = mode;
    const modal = document.getElementById('modal-camera-scanner');
    const badge = document.getElementById('camera-target-badge');
    if (badge) {
        if (mode === 'stocktake') {
            badge.textContent = `📦 الجرد (${currentActiveStoreNo || 'ST-001'})`;
            badge.className = 'px-2 py-0.5 rounded-md bg-amber-100 border border-amber-300 text-amber-900 font-bold text-[11px] font-mono';
        } else if (mode === 'gtin') {
            badge.textContent = `🏷️ كرت الصنف`;
            badge.className = 'px-2 py-0.5 rounded-md bg-sky-100 border border-sky-300 text-sky-900 font-bold text-[11px] font-mono';
        } else {
            badge.textContent = `🧾 الفاتورة`;
            badge.className = 'px-2 py-0.5 rounded-md bg-indigo-100 border border-indigo-300 text-indigo-900 font-bold text-[11px] font-mono';
        }
    }
    const lastResBox = document.getElementById('camera-modal-last-result');
    if (lastResBox) lastResBox.classList.add('hidden');
    modal?.classList.remove('hidden');
    startCamera();
}

let nativeDetectorAnimFrame = null;
let isNativeScanning = false;

function triggerCameraFlashFeedback() {
    const flashEl = document.getElementById('camera-scan-flash-overlay');
    if (flashEl) {
        flashEl.classList.remove('hidden');
        setTimeout(() => {
            flashEl.classList.add('hidden');
        }, 320);
    }
}

async function handleCameraDecodedText(decodedText) {
    if (isCameraScanSuspended) return;
    const raw = String(decodedText || '').trim();
    if (!raw) return;

    // منع التكرار اللحظي لنفس العبوة خلال 1.2 ثانية لتجنب مضاعفة العدد بالخطأ
    const now = Date.now();
    if (raw === cameraLastScanCode && (now - cameraLastScanTime) < 1200) {
        return;
    }
    cameraLastScanCode = raw;
    cameraLastScanTime = now;

    // إصدار نغمة بيب والاهتزاز اللحظي وميض سحب العبوة
    playAppScannerBeep(true);
    triggerCameraFlashFeedback();

    const modalReticle = document.getElementById('tameni-reticle-modal');
    if (modalReticle) {
        modalReticle.classList.add('active-hit');
        setTimeout(() => modalReticle.classList.remove('active-hit'), 350);
    }

    const isContinuous = document.getElementById('chk-camera-continuous')?.checked ?? true;
    const lastResBox = document.getElementById('camera-modal-last-result');
    const lastResText = document.getElementById('camera-modal-last-text');

    if (lastResBox && lastResText) {
        lastResText.textContent = raw;
        lastResBox.classList.remove('hidden');
    }

    if (cameraScanMode === 'gtin' && activeGtinTargetInput) {
        stopCamera();
        document.getElementById('modal-camera-scanner')?.classList.add('hidden');
        let parsed = parseGs1Client(raw);
        if (parsed.isGs1 && parsed.gtin) {
            showGs1Inspector(activeGtinTargetInput, parsed);
        } else {
            fetch('/api/catalog/parse-gs1', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ raw: raw })
            }).then(r => r.json()).then(data => {
                if (data.success && data.is_gs1 && data.gtin) {
                    showGs1Inspector(activeGtinTargetInput, data);
                } else {
                    const clean = extractCleanGtin(raw);
                    activeGtinTargetInput.value = clean || raw;
                }
            }).catch(() => {
                const clean = extractCleanGtin(raw);
                activeGtinTargetInput.value = clean || raw;
            });
        }
        return;
    }

    if (cameraScanMode === 'stocktake') {
        try {
            const res = await fetch('/api/stock/scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    code: raw,
                    qr_text: raw,
                    store_no: currentActiveStoreNo || 'ST-001',
                    force_direct: false
                })
            });
            const data = await res.json();
            if (data.success) {
                if (data.requires_batch_entry) {
                    // للأصناف ذات الباركود الدولي 1D: تعليق المعالجة وإخفاء النافذة مع إبقاء الكاميرا نشطة ودافئة بالخلفية لاستئناف فوري
                    isCameraScanSuspended = true;
                    wasCameraActiveBeforeBatch = true;
                    document.getElementById('modal-camera-scanner')?.classList.add('hidden');
                    openBatchEntryCard(data, 'camera');
                    return;
                } else {
                    // لأصناف كيو ار الداتاماتريكس (2D DataMatrix): نزول مباشر بالعدد +1 واستمرار الكاميرا
                    if (data.store_details) {
                        renderCurrentStoreDetails(data.store_details);
                    } else {
                        await loadCurrentStoreItems();
                    }
                    await loadStocktakeStores();
                    showCatalogToast(`⚡ تم سحب العبوة للجرد (+1): ${data.product_name || raw}`);
                    if (lastResBox && lastResText) {
                        lastResText.innerHTML = `<span class="text-emerald-700 font-bold">${data.product_name || raw}</span> | كمية: <span class="bg-emerald-600 text-white px-2 py-0.5 rounded font-black">${data.counted_qty || 1}</span>`;
                        lastResBox.classList.remove('hidden');
                    }
                }
            } else {
                playAppScannerBeep(false);
                showCatalogToast(data.message || 'الصنف غير مسجل بالمخزون', true);
            }
        } catch (e) {
            playAppScannerBeep(false);
            showCatalogToast('خطأ أثناء المسح: ' + e.message, true);
        }
    } else {
        // وضع الفاتورة: سحب العبوة فورياً وتحديث الجدول والكمية كجهاز الكمبيوتر
        executeScan(raw);
    }

    if (!isContinuous && cameraScanMode !== 'stocktake') {
        stopCamera();
        document.getElementById('modal-camera-scanner')?.classList.add('hidden');
    }
}

function startCamera() {
    if (typeof Html5Qrcode === 'undefined') {
        alert('مكتبة مسح الكاميرا غير متوفرة حالياً.');
        return;
    }

    if (html5QrScannerInstance) {
        try {
            stopCamera();
            setTimeout(initHtml5ScannerInstance, 200);
            return;
        } catch(e) {}
    }
    initHtml5ScannerInstance();
}

let isProcessingFrame = false;
let isCameraScanSuspended = false;

async function applyContinuousFocusAndNativeLoop(videoElem) {
    if (!videoElem) return;

    // التحقق من بيئة iOS / Safari (آيفون وآيباد)
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    // تفعيل الفوكس التلقائي المستمر عبر كاميرا الموبايل وضبط التعريض إن كان مدعوماً
    try {
        if (videoElem.srcObject) {
            const [track] = videoElem.srcObject.getVideoTracks();
            if (track && track.getCapabilities) {
                const caps = track.getCapabilities();
                const adv = {};
                if (caps.focusMode && caps.focusMode.includes('continuous')) {
                    adv.focusMode = 'continuous';
                }
                if (caps.exposureMode && caps.exposureMode.includes('continuous')) {
                    adv.exposureMode = 'continuous';
                }
                if (caps.whiteBalanceMode && caps.whiteBalanceMode.includes('continuous')) {
                    adv.whiteBalanceMode = 'continuous';
                }
                if (Object.keys(adv).length > 0) {
                    track.applyConstraints({ advanced: [adv] }).catch(() => {});
                }
            }
        }
    } catch(e) {}

    // تفعيل BarcodeDetector لجميع الأجهزة بما فيها آيفون عبر polyfill WASM المتطور
    if (!('BarcodeDetector' in window)) {
        return;
    }

    // محرك الفحص فائق السرعة عبر العتاد المباشر BarcodeDetector لأجهزة أندرويد
    if ('BarcodeDetector' in window) {
        try {
            const supported = await BarcodeDetector.getSupportedFormats();
            const desired = ['data_matrix', 'qr_code', 'ean_13', 'code_128', 'ean_8', 'upc_a', 'upc_e', 'code_39'];
            const validFormats = desired.filter(f => supported.includes(f));
            
            if (validFormats.length > 0) {
                const detector = new BarcodeDetector({ formats: validFormats });
                isNativeScanning = true;

                const scanFrame = async () => {
                    if (!isNativeScanning || !videoElem || videoElem.paused || videoElem.ended) return;
                    if (isCameraScanSuspended) {
                        if ('requestVideoFrameCallback' in videoElem) {
                            videoElem.requestVideoFrameCallback(scanFrame);
                        } else {
                            nativeDetectorAnimFrame = requestAnimationFrame(scanFrame);
                        }
                        return;
                    }
                    const nowTs = performance.now();
                    const minGap = isIOS ? 80 : 0;
                    if (!isProcessingFrame && videoElem.readyState >= 2 && (nowTs - (videoElem._lastAppScanAt || 0)) >= minGap) {
                        videoElem._lastAppScanAt = nowTs;
                        isProcessingFrame = true;
                        try {
                            const barcodes = await detector.detect(videoElem);
                            if (barcodes && barcodes.length > 0) {
                                const match = barcodes[0];
                                if (match && match.rawValue) {
                                    handleCameraDecodedText(match.rawValue);
                                }
                            }
                        } catch(e) {}
                        isProcessingFrame = false;
                    }
                    if (isNativeScanning) {
                        if ('requestVideoFrameCallback' in videoElem) {
                            videoElem.requestVideoFrameCallback(scanFrame);
                        } else {
                            nativeDetectorAnimFrame = requestAnimationFrame(scanFrame);
                        }
                    }
                };

                if ('requestVideoFrameCallback' in videoElem) {
                    videoElem.requestVideoFrameCallback(scanFrame);
                } else {
                    nativeDetectorAnimFrame = requestAnimationFrame(scanFrame);
                }
            }
        } catch(e) {
            console.warn('BarcodeDetector setup warning:', e);
        }
    }
}

function initHtml5ScannerInstance() {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    const formatsToSupport = [
        Html5QrcodeSupportedFormats.DATA_MATRIX,
        Html5QrcodeSupportedFormats.QR_CODE,
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODABAR
    ];

    try {
        html5QrScannerInstance = new Html5Qrcode("camera-reader-viewport", {
            formatsToSupport: formatsToSupport,
            verbose: false,
            experimentalFeatures: {
                // إيقاف BarcodeDetector التجريبي على آيفون لضمان قراءة الداتاماتريكس بمحرك ZXing الأصلي
                useBarCodeDetectorIfSupported: true
            }
        });
    } catch(e) {
        try {
            html5QrScannerInstance = new Html5Qrcode("camera-reader-viewport", { verbose: false });
        } catch(e2) {}
    }

    if (!html5QrScannerInstance) return;

    // قيود الكاميرا عالية الدقة وفائقة السرعة
    const cameraConstraints = { facingMode: (cameraFacingMode === 'user' ? 'user' : 'environment') };
    const videoConstraints = {
        facingMode: (cameraFacingMode === 'user' ? 'user' : 'environment'),
        width: { min: 720, ideal: 1280, max: 1920 },
        height: { min: 720, ideal: 1080, max: 1920 }
    };

    // مسح احترافي فائق السرعة (30 إطار/ثانية) بكامل مساحة الحساس (Full Sensor Frame)
    const scanConfig = {
        fps: 30,
        aspectRatio: undefined,
        disableFlip: false
    };

    const banner = document.getElementById('camera-permission-banner');

    const setupVideoForIOS = () => {
        const video = document.querySelector('#camera-reader-viewport video');
        if (video) {
            video.setAttribute('playsinline', 'true');
            video.setAttribute('webkit-playsinline', 'true');
            video.setAttribute('muted', 'true');
            video.muted = true;
            video.play().catch(() => {});
            applyContinuousFocusAndNativeLoop(video);
        }
    };

    html5QrScannerInstance.start(
        cameraConstraints,
        scanConfig,
        (decodedText) => {
            handleCameraDecodedText(decodedText);
        },
        () => {}
    ).then(() => {
        if (banner) banner.classList.add('hidden');
        setupVideoForIOS();
    }).catch(err => {
        console.warn('Direct facingMode start failed, trying device list enumeration:', err);
        // محاولة استخدام قائمة الكاميرات المتاحة في الجهاز كبديل مباشر
        Html5Qrcode.getCameras().then(devices => {
            if (devices && devices.length > 0) {
                const backCam = devices.find(d => {
                    const l = (d.label || '').toLowerCase();
                    return l.includes('back') || l.includes('rear') || l.includes('environment');
                }) || devices[0];

                try { html5QrScannerInstance.clear(); } catch(e) {}
                html5QrScannerInstance = new Html5Qrcode("camera-reader-viewport", { verbose: false });
                return html5QrScannerInstance.start(
                    backCam.id,
                    scanConfig,
                    (decodedText) => handleCameraDecodedText(decodedText),
                    () => {}
                );
            }
            throw new Error('لا توجد كاميرا متوفرة');
        }).then(() => {
            if (banner) banner.classList.add('hidden');
            setupVideoForIOS();
        }).catch(finalErr => {
            console.error('All camera attempts failed:', finalErr);
            if (banner) {
                banner.classList.remove('hidden');
            } else {
                alert('تعذر فتح الكاميرا: يُرجى التأكد من السماح بصلاحيات الكاميرا في المتصفح.');
            }
        });
    });
}

function stopCamera() {
    isNativeScanning = false;
    if (nativeDetectorAnimFrame) {
        cancelAnimationFrame(nativeDetectorAnimFrame);
        nativeDetectorAnimFrame = null;
    }
    if (html5QrScannerInstance) {
        html5QrScannerInstance.stop().then(() => {
            html5QrScannerInstance.clear();
            html5QrScannerInstance = null;
        }).catch(err => {
            try { html5QrScannerInstance.clear(); } catch(e) {}
            html5QrScannerInstance = null;
        });
    }
}

// =========================================================================
// ربط الجوال كجهاز اسكانر لاسلكي للكمبيوتر (Mobile Wireless Companion)
// =========================================================================
let mobileCompanionPollTimer = null;
let lastMobilePollTimestamp = 0;

function initMobileCompanionScanner() {
    const btnInv = document.getElementById('btn-open-mobile-scanner-inv');
    const btnStk = document.getElementById('btn-stk-open-mobile-link');
    const btnClose = document.getElementById('btn-close-mobile-companion');
    const btnCopy = document.getElementById('btn-copy-mobile-url');

    const openCompanionModal = async () => {
        const modal = document.getElementById('modal-mobile-companion');
        modal?.classList.remove('hidden');

        const loadInfo = async () => {
            try {
                const res = await fetch('/api/network-info');
                const data = await res.json();
                const urlText = document.getElementById('mobile-companion-url-text');
                const targetUrl = data.cloudflare_url || data.mobile_url || `http://${data.ip}:${data.port}/`;
                if (urlText) urlText.textContent = targetUrl;

                // توليد كود QR
                const qrBox = document.getElementById('mobile-companion-qr-box');
                if (qrBox) {
                    if (typeof qrcode !== 'undefined') {
                        const qr = qrcode(0, 'M');
                        qr.addData(targetUrl);
                        qr.make();
                        qrBox.innerHTML = qr.createSvgTag({ scalable: true, cellSize: 4 });
                    } else {
                        qrBox.innerHTML = `<a href="${targetUrl}" target="_blank" class="text-indigo-600 font-bold text-xs underline">${targetUrl}</a>`;
                    }
                }
                return data.is_cloudflare_active;
            } catch (e) {
                console.error('Error fetching network info:', e);
                return false;
            }
        };

        const isReady = await loadInfo();
        if (!isReady) {
            // إعادة الفحص تلقائياً خلال ثوانٍ عند اكتمال إطلاق نفق Cloudflare
            setTimeout(loadInfo, 2500);
            setTimeout(loadInfo, 5000);
        }

        lastMobilePollTimestamp = Date.now() / 1000;
        startMobileCompanionPolling();
    };

    btnInv?.addEventListener('click', openCompanionModal);
    btnStk?.addEventListener('click', openCompanionModal);

    btnClose?.addEventListener('click', () => {
        document.getElementById('modal-mobile-companion')?.classList.add('hidden');
    });

    btnCopy?.addEventListener('click', () => {
        const text = document.getElementById('mobile-companion-url-text')?.textContent?.trim();
        if (text) {
            navigator.clipboard.writeText(text).then(() => {
                showCatalogToast('📋 تم نسخ رابط اسكانر الجوال بنجاح!');
            }).catch(() => {
                prompt('انسخ الرابط:', text);
            });
        }
    });

    startMobileCompanionPolling();
}

function handleDesktopSyncData(data) {
    if (data.events && data.events.length > 0) {
        let shouldReloadStock = false;
        let shouldReloadInvoice = false;
        for (const ev of data.events) {
            const payload = ev.payload || {};
            if (ev.type.startsWith('stock_') || (ev.type === 'mobile_scan' && payload.target === 'stocktake')) {
                shouldReloadStock = true;
            }
            if (ev.type.startsWith('invoice_') || (ev.type === 'mobile_scan' && payload.target === 'invoice')) {
                shouldReloadInvoice = true;
            }
            if (ev.type === 'mobile_scan') {
                playAppScannerBeep(payload.success !== false);
                const prodName = payload.product_name || payload.code || '';
                showCatalogToast(`📱 جرد فوري من الموبايل: ${prodName}`);
            } else if (ev.type === 'stock_qty_updated') {
                showCatalogToast(`⚡ تحديث كمية فوري من الموبايل`);
            } else if (ev.type === 'stock_item_deleted') {
                showCatalogToast(`🗑 تم حذف صنف من الجرد`);
            } else if (ev.type === 'store_created') {
                showCatalogToast(`🏪 تم إنشاء مستودع جديد من الموبايل: ${payload.store_name || ''}`);
            }
        }
        if (shouldReloadStock) {
            loadStocktakeStores();
            loadCurrentStoreItems();
        }
        if (shouldReloadInvoice) {
            loadActiveDraftInvoice();
        }
    } else if (data.scans && data.scans.length > 0) {
        for (const sc of data.scans) {
            playAppScannerBeep(sc.success);
            const prodName = sc.product_name || sc.code;
            showCatalogToast(`📱 مسحة جديدة من الجوال: ${prodName}`);

            if (sc.target === 'stocktake') {
                loadStocktakeStores();
                loadCurrentStoreItems();
            } else {
                loadActiveDraftInvoice();
            }
        }
    }
}

// المزامنة اللحظية: اتصال WebSocket دائم (فوري)، والاستعلام الدوري احتياطي فقط أثناء انقطاعه
let _desktopReloadTimer = null;
function scheduleDesktopStockReload() {
    clearTimeout(_desktopReloadTimer);
    _desktopReloadTimer = setTimeout(() => { loadStocktakeStores(); loadCurrentStoreItems(); }, 120);
}

function startMobileCompanionPolling() {
    if (mobileCompanionPollTimer) return;
    if (window.RambfeRealtime) {
        window.RambfeRealtime.onEvent((evt) => {
            if (evt.type === '__resync') { scheduleDesktopStockReload(); return; }
            if (evt.timestamp && evt.timestamp > lastMobilePollTimestamp) lastMobilePollTimestamp = evt.timestamp;
            handleDesktopSyncData({ events: [evt] });
        });
    }
    mobileCompanionPollTimer = setInterval(async () => {
        if (document.hidden) return;
        if (window.RambfeRealtime && window.RambfeRealtime.connected) return;
        try {
            const res = await fetch(`/api/mobile/poll?since=${lastMobilePollTimestamp}`);
            const data = await res.json();
            if (data.timestamp) lastMobilePollTimestamp = data.timestamp;
            handleDesktopSyncData(data);
        } catch (e) {
            // silent poll
        }
    }, 3000);
}

// ==================== تبويب 2: بطاقات ودليل الأصناف ====================
let currentLoadedCatalogItems = [];
let selectedCatalogCodes = new Set();
let accumulatedSearchResults = new Map();
let isAccumulatedSearchMode = false;
let catalogAutocompleteTimer = null;
let activeAutocompleteIndex = -1;
let currentAutocompleteResults = [];
let selectedAutocompleteCodes = new Set();

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function showCatalogToast(msg, isWarning = false) {
    let toast = document.getElementById('catalog-search-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'catalog-search-toast';
        document.body.appendChild(toast);
    }

    toast.className = `fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl shadow-2xl text-xs font-bold transition-all duration-300 pointer-events-none flex items-center gap-2 border ${
        isWarning 
            ? 'bg-amber-600 text-white border-amber-500 shadow-amber-900/30' 
            : 'bg-slate-900 text-white border-slate-700 shadow-slate-900/40'
    }`;
    toast.innerHTML = `<span>${isWarning ? '⚠️' : '✨'}</span><span>${escapeHtml(msg)}</span>`;
    
    toast.style.transform = 'translate(-50%, 0)';
    toast.style.opacity = '1';

    clearTimeout(toast._hideTimer);
    toast._hideTimer = setTimeout(() => {
        toast.style.transform = 'translate(-50%, 1rem)';
        toast.style.opacity = '0';
    }, 2800);
}

let isGeneralizedSearch = localStorage.getItem('catalog_search_mode') === 'contains';

function updateSearchModeUI() {
    const btn = document.getElementById('btn-toggle-search-mode');
    const icon = document.getElementById('search-mode-icon');
    const text = document.getElementById('search-mode-text');
    const sw = document.getElementById('search-mode-switch');
    const knob = document.getElementById('search-mode-knob');
    const input = document.getElementById('catalog-search-input');

    if (isGeneralizedSearch) {
        if (btn) {
            btn.className = 'absolute left-1.5 top-1/2 -translate-y-1/2 px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all duration-200 flex items-center gap-1.5 select-none shadow-xs cursor-pointer border bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-700 active:scale-95';
            btn.title = 'بحث معمم';
        }
        if (icon) {
            icon.textContent = '💡';
            icon.className = 'text-xs transition-transform duration-200';
        }
        if (text) {
            text.textContent = 'معمم';
        }
        if (sw) {
            sw.className = 'w-6 h-3 bg-emerald-800 rounded-full relative transition-colors duration-200 inline-flex items-center p-0.5 pointer-events-none';
        }
        if (knob) {
            knob.className = 'w-2 h-2 bg-white rounded-full shadow-xs transition-transform duration-200 -translate-x-3';
        }
        if (input) {
            input.placeholder = 'ابحث باسم الصنف أو الكود (اضغط Enter للإدراج المباشر في الجدول)...';
        }
    } else {
        if (btn) {
            btn.className = 'absolute left-1.5 top-1/2 -translate-y-1/2 px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all duration-200 flex items-center gap-1.5 select-none shadow-xs cursor-pointer border bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300 active:scale-95';
            btn.title = 'بحث بالبداية';
        }
        if (icon) {
            icon.textContent = '🔦';
            icon.className = 'text-xs transition-transform duration-200';
        }
        if (text) {
            text.textContent = 'بداية';
        }
        if (sw) {
            sw.className = 'w-6 h-3 bg-slate-300 rounded-full relative transition-colors duration-200 inline-flex items-center p-0.5 pointer-events-none';
        }
        if (knob) {
            knob.className = 'w-2 h-2 bg-white rounded-full shadow-xs transition-transform duration-200 translate-x-0';
        }
        if (input) {
            input.placeholder = 'ابحث باسم الصنف أو الكود (اضغط Enter للإدراج المباشر في الجدول)...';
        }
    }
}

function initCatalogAutocomplete() {
    const searchInput = document.getElementById('catalog-search-input');
    const dropdown = document.getElementById('catalog-autocomplete-dropdown');
    const btnToggleMode = document.getElementById('btn-toggle-search-mode');

    // تفعيل وتحديث واجهة مفتاح نمط البحث في أقصى يسار الخانة
    updateSearchModeUI();
    if (btnToggleMode && !btnToggleMode._boundListener) {
        btnToggleMode._boundListener = true;
        btnToggleMode.addEventListener('click', (e) => {
            e.stopPropagation();
            isGeneralizedSearch = !isGeneralizedSearch;
            localStorage.setItem('catalog_search_mode', isGeneralizedSearch ? 'contains' : 'start');
            updateSearchModeUI();
            const q = searchInput ? searchInput.value.trim() : '';
            if (q) {
                fetchAndRenderAutocomplete(q);
                if (!isAccumulatedSearchMode) {
                    catalogOffset = 0;
                    loadCatalogProducts();
                }
            }
        });
    }

    if (!searchInput || !dropdown) return;

    // استماع للكتابة المباشرة لتحديث الاقتراحات التلقائية فوراً
    searchInput.addEventListener('input', () => {
        clearTimeout(catalogAutocompleteTimer);
        const q = searchInput.value.replace(/^\s+/, '');

        if (!q) {
            dropdown.innerHTML = '';
            dropdown.classList.add('hidden');
            activeAutocompleteIndex = -1;
            currentAutocompleteResults = [];
            selectedAutocompleteCodes.clear();
            if (!isAccumulatedSearchMode) {
                catalogOffset = 0;
                loadCatalogProducts();
            }
            return;
        }

        catalogAutocompleteTimer = setTimeout(async () => {
            await fetchAndRenderAutocomplete(q);
        }, 120);
    });

    // التنقل بلوحة المفاتيح والضغط على Enter للإدراج المباشر
    searchInput.addEventListener('keydown', (e) => {
        const isDropdownOpen = !dropdown.classList.contains('hidden') && currentAutocompleteResults.length > 0;

        if (e.key === 'ArrowDown') {
            if (isDropdownOpen) {
                e.preventDefault();
                activeAutocompleteIndex = (activeAutocompleteIndex + 1) % currentAutocompleteResults.length;
                updateAutocompleteHighlight();
            }
        } else if (e.key === 'ArrowUp') {
            if (isDropdownOpen) {
                e.preventDefault();
                activeAutocompleteIndex = (activeAutocompleteIndex - 1 + currentAutocompleteResults.length) % currentAutocompleteResults.length;
                updateAutocompleteHighlight();
            }
        } else if (e.key === 'PageDown') {
            if (isDropdownOpen) {
                e.preventDefault();
                activeAutocompleteIndex = Math.min(currentAutocompleteResults.length - 1, (activeAutocompleteIndex < 0 ? 0 : activeAutocompleteIndex) + 8);
                updateAutocompleteHighlight();
            }
        } else if (e.key === 'PageUp') {
            if (isDropdownOpen) {
                e.preventDefault();
                activeAutocompleteIndex = Math.max(0, (activeAutocompleteIndex < 0 ? 0 : activeAutocompleteIndex) - 8);
                updateAutocompleteHighlight();
            }
        } else if (e.key === 'Home' && isDropdownOpen && (e.ctrlKey || e.altKey)) {
            e.preventDefault();
            activeAutocompleteIndex = 0;
            updateAutocompleteHighlight();
        } else if (e.key === 'End' && isDropdownOpen && (e.ctrlKey || e.altKey)) {
            e.preventDefault();
            activeAutocompleteIndex = currentAutocompleteResults.length - 1;
            updateAutocompleteHighlight();
        } else if (e.key === 'Enter' || e.keyCode === 13 || e.which === 13 || e.key === 'Go' || e.key === 'Search' || e.key === 'Next') {
            e.preventDefault();
            const q = searchInput.value.replace(/^\s+/, '');
            if (!q) return;

            // الحالة الثانية: إذا قام المستخدم بتحديد أصناف معينة (بالـ Checkbox)، يتم إدراج الأصناف المحددة فقط
            if (selectedAutocompleteCodes.size > 0) {
                addSelectedAutocompleteItems();
            } 
            // الحالة الأولى: عدم تحديد صنف معين -> يتم إدراج كافة الأصناف المطابقة للبحث فوراً في الجدول
            else {
                if (currentAutocompleteResults && currentAutocompleteResults.length > 0) {
                    addAllAutocompleteResultsToTable(currentAutocompleteResults, q);
                } else {
                    appendSearchQueryToResults(q);
                }
            }
        } else if (e.key === 'Escape') {
            dropdown.classList.add('hidden');
            activeAutocompleteIndex = -1;
            selectedAutocompleteCodes.clear();
        }
    });

    // إغلاق القائمة عند النقر خارجها
    document.addEventListener('click', (e) => {
        if (!dropdown.contains(e.target) && e.target !== searchInput && e.target !== btnToggleMode && !btnToggleMode?.contains(e.target)) {
            dropdown.classList.add('hidden');
            activeAutocompleteIndex = -1;
        }
    });
}

async function fetchAndRenderAutocomplete(query) {
    const dropdown = document.getElementById('catalog-autocomplete-dropdown');
    if (!dropdown) return;

    try {
        // جلب كافة الأصناف المطابقة للبحث بدون تقييد بـ 25 صنفاً لعرض كل الأصناف والتمرير الكامل
        const url = `/api/catalog/products?query=${encodeURIComponent(query)}&mode=${isGeneralizedSearch ? "contains" : "start"}&limit=2000&offset=0`;
        const res = await fetch(url);
        const data = await res.json();
        const items = data.items || [];
        const total = data.total || items.length;
        
        currentAutocompleteResults = items;
        activeAutocompleteIndex = -1;
        selectedAutocompleteCodes.clear();

        if (items.length === 0) {
            dropdown.innerHTML = `
                <div class="p-6 text-center text-slate-400 font-medium">
                    <div class="text-xl mb-1">🔍</div>
                    <div class="text-xs">لم يتم العثور على أي صنف يطابق "<span class="font-bold text-slate-700">${escapeHtml(query)}</span>"</div>
                </div>
            `;
            dropdown.classList.remove('hidden');
            return;
        }

        // شريط علوي مثبت: إجمالي النتائج، تحديد الكل، وإضافة الأصناف
        let topBarHtml = `
            <div class="sticky top-0 z-20 bg-slate-50 border-b border-slate-200 p-2.5 px-3 flex items-center justify-between gap-3 shadow-xs">
                <div class="flex items-center gap-2">
                    <label class="flex items-center gap-1.5 cursor-pointer text-[11px] font-bold text-slate-700 select-none">
                        <input type="checkbox" id="chk-auto-select-all" class="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer">
                        <span>تحديد الكل</span>
                    </label>
                    <span class="text-[10.5px] text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full font-bold font-mono">
                        عرض ${items.length} صنف مطابق
                    </span>
                    <span class="text-[10px] text-slate-400 hidden sm:inline">(يمكن التمرير بالماوس أو الأسهم)</span>
                </div>
                <div class="flex items-center gap-2">
                    <span id="auto-selected-badge" class="px-2 py-0.5 bg-indigo-100 text-indigo-800 rounded-md text-[10.5px] font-mono font-bold">0 محدد</span>
                    <button type="button" id="btn-auto-add-selected-top" class="px-3 py-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-sm">
                        <span>➕</span>
                        <span id="auto-btn-text-top">إضافة المحدد</span>
                    </button>
                </div>
            </div>
        `;

        // قائمة الأصناف القابلة للتمرير الكامل حتى ارتفاع الشاشة مع دعم الماوس ولوحة المفاتيح
        let itemsListHtml = `<div id="autocomplete-items-container" class="divide-y divide-slate-100 overflow-y-auto max-h-[calc(85vh-110px)] scroll-smooth">`;

        items.forEach((it, idx) => {
            const isAlreadyAdded = accumulatedSearchResults.has(it.code);
            const engName = it.name_en || it.name || '';
            const arName = it.name_ar || '';
            const price = parseFloat(it.selling_price || 0).toFixed(2);
            const gList = (it.gtin_list || []).map(g => extractCleanGtin(g) || g).filter(Boolean);
            const bList = it.barcode_list || [];
            const codeIdentifier = gList[0] ? `GTIN: ${gList[0]}` : (bList[0] ? `باركود: ${bList[0]}` : '');

            itemsListHtml += `
                <div class="p-2.5 px-3 flex items-center justify-between gap-2.5 transition select-none autocomplete-item hover:bg-slate-50 cursor-pointer ${isAlreadyAdded ? 'bg-slate-50/60 opacity-80' : ''}" data-index="${idx}" data-code="${escapeHtml(it.code)}">
                    <div class="flex items-center gap-2.5 min-w-0 flex-1">
                        <input type="checkbox" class="chk-auto-item w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer shrink-0" data-code="${escapeHtml(it.code)}" ${isAlreadyAdded ? 'disabled' : ''}>
                        <span class="font-mono text-[11px] font-bold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100 shrink-0 select-all">${escapeHtml(it.code)}</span>
                        <div class="min-w-0 flex-1">
                            <div class="font-bold text-slate-900 truncate text-xs leading-tight">${escapeHtml(engName)}</div>
                            <div class="flex items-center gap-2 text-[10.5px] text-slate-500 mt-0.5 flex-wrap">
                                ${arName ? `<span class="truncate max-w-[190px] font-medium text-slate-600">${escapeHtml(arName)}</span>` : ''}
                                ${codeIdentifier ? `<span class="font-mono text-indigo-600 font-medium">${escapeHtml(codeIdentifier)}</span>` : ''}
                                ${it.category ? `<span class="px-1.5 py-0.2 bg-slate-100 rounded text-[9.5px] text-slate-600">${escapeHtml(it.category)}</span>` : ''}
                            </div>
                        </div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <span class="font-mono font-bold text-emerald-700 text-xs">${price} ر.س</span>
                        
                        <!-- زر عرض كرت الصنف بالكامل مباشرة من نتائج البحث -->
                        <button type="button" class="btn-auto-view-card px-2 py-1 bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-200 rounded-lg text-[11px] font-bold transition flex items-center gap-1 shadow-2xs" data-code="${escapeHtml(it.code)}" title="استعراض وتعديل كرت الصنف بالكامل">
                            <span>👁️</span><span>عرض الكرت</span>
                        </button>

                        ${isAlreadyAdded ? `
                            <span class="px-2 py-1 bg-emerald-100 text-emerald-800 rounded-lg text-[10px] font-bold flex items-center gap-1">
                                <span>✓</span><span>مضاف</span>
                            </span>
                        ` : `
                            <button type="button" class="btn-quick-add-single px-2.5 py-1 bg-indigo-50 hover:bg-indigo-600 hover:text-white text-indigo-700 rounded-lg text-[11px] font-bold transition flex items-center gap-1 shadow-2xs" data-code="${escapeHtml(it.code)}" title="إضافة هذا الصنف مباشرة إلى القائمة">
                                <span>➕</span><span>إضافة</span>
                            </button>
                        `}
                    </div>
                </div>
            `;
        });

        itemsListHtml += `</div>`;

        // شريط سفلي مثبت
        let bottomBarHtml = `
            <div class="sticky bottom-0 z-20 bg-slate-50 border-t border-slate-200 p-2.5 px-3 flex items-center justify-between gap-3 text-[11px] text-slate-500">
                <span class="flex items-center gap-1">
                    <span>⚡</span>
                    <span>اضغط <b>Enter</b> لإدراج كافة النتائج في الجدول مباشرة، أو حدد أصنافاً واضغط <b>Enter</b> لإدراجها فقط</span>
                </span>
                <button type="button" id="btn-auto-add-selected-bottom" class="px-3 py-1 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-xs font-bold transition flex items-center gap-1.5 shadow-sm">
                    <span>➕</span>
                    <span id="auto-btn-text-bottom">إضافة الأصناف المحددة</span>
                </button>
            </div>
        `;

        dropdown.innerHTML = topBarHtml + itemsListHtml + bottomBarHtml;
        dropdown.classList.remove('hidden');

        // ربط أحداث التحديد المتعدد وزر عرض كرت الصنف
        setupAutocompleteEvents(items);

    } catch (e) {
        dropdown.innerHTML = `<div class="p-3 text-center text-rose-500 text-xs">خطأ في جلب الاقتراحات: ${escapeHtml(e.message)}</div>`;
        dropdown.classList.remove('hidden');
    }
}

function setupAutocompleteEvents(items) {
    const dropdown = document.getElementById('catalog-autocomplete-dropdown');
    if (!dropdown) return;

    const chkSelectAll = dropdown.querySelector('#chk-auto-select-all');
    const chkItems = dropdown.querySelectorAll('.chk-auto-item:not([disabled])');
    const btnAddTop = dropdown.querySelector('#btn-auto-add-selected-top');
    const btnAddBottom = dropdown.querySelector('#btn-auto-add-selected-bottom');
    const textTop = dropdown.querySelector('#auto-btn-text-top');
    const textBottom = dropdown.querySelector('#auto-btn-text-bottom');

    const updateUI = () => {
        const count = selectedAutocompleteCodes.size;
        const badge = dropdown.querySelector('#auto-selected-badge');
        if (badge) badge.textContent = `${count} محدد`;

        const btnText = count > 0 ? `إضافة (${count}) أصناف محددة` : 'إضافة الأصناف المحددة';
        if (textTop) textTop.textContent = btnText;
        if (textBottom) textBottom.textContent = btnText;
        if (btnAddTop) btnAddTop.disabled = (count === 0);
        if (btnAddBottom) btnAddBottom.disabled = (count === 0);

        if (chkSelectAll) {
            const availableCount = chkItems.length;
            if (availableCount === 0) {
                chkSelectAll.checked = false;
                chkSelectAll.indeterminate = false;
            } else if (count === availableCount) {
                chkSelectAll.checked = true;
                chkSelectAll.indeterminate = false;
            } else if (count > 0) {
                chkSelectAll.checked = false;
                chkSelectAll.indeterminate = true;
            } else {
                chkSelectAll.checked = false;
                chkSelectAll.indeterminate = false;
            }
        }
    };

    updateUI();

    // زر تحديد الكل
    chkSelectAll?.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        chkItems.forEach(chk => {
            chk.checked = isChecked;
            const code = chk.getAttribute('data-code');
            if (isChecked) {
                selectedAutocompleteCodes.add(code);
            } else {
                selectedAutocompleteCodes.delete(code);
            }
        });
        updateUI();
    });

    // مربعات الاختيار الفردية
    chkItems.forEach(chk => {
        chk.addEventListener('change', (e) => {
            const code = chk.getAttribute('data-code');
            if (chk.checked) {
                selectedAutocompleteCodes.add(code);
            } else {
                selectedAutocompleteCodes.delete(code);
            }
            updateUI();
        });
        chk.addEventListener('click', (e) => e.stopPropagation());
    });

    // النقر على السطر لتبديل التحديد
    dropdown.querySelectorAll('.autocomplete-item').forEach(itemEl => {
        itemEl.addEventListener('click', (e) => {
            const code = itemEl.getAttribute('data-code');
            if (accumulatedSearchResults.has(code)) return;
            const chk = itemEl.querySelector('.chk-auto-item');
            if (chk && !chk.disabled) {
                chk.checked = !chk.checked;
                if (chk.checked) {
                    selectedAutocompleteCodes.add(code);
                } else {
                    selectedAutocompleteCodes.delete(code);
                }
                updateUI();
            }
        });
    });

    // زر عرض كرت الصنف بالكامل مباشرة من الاقتراحات
    dropdown.querySelectorAll('.btn-auto-view-card').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const code = btn.getAttribute('data-code');
            await openEditProductModalByCode(code);
        });
    });

    // أزرار الإضافة السريعة لصنف منفرد
    dropdown.querySelectorAll('.btn-quick-add-single').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const code = btn.getAttribute('data-code');
            const it = items.find(x => x.code === code);
            if (it) {
                addSingleItemToAccumulated(it);
            }
        });
    });

    // أزرار إضافة الأصناف المحددة (العلوي والسفلي)
    btnAddTop?.addEventListener('click', (e) => {
        e.stopPropagation();
        addSelectedAutocompleteItems();
    });
    btnAddBottom?.addEventListener('click', (e) => {
        e.stopPropagation();
        addSelectedAutocompleteItems();
    });
}

function updateAutocompleteHighlight() {
    const dropdown = document.getElementById('catalog-autocomplete-dropdown');
    if (!dropdown) return;
    const items = dropdown.querySelectorAll('.autocomplete-item');
    items.forEach((el, idx) => {
        if (idx === activeAutocompleteIndex) {
            el.classList.add('bg-indigo-50/70', 'ring-1', 'ring-indigo-500');
            el.scrollIntoView({ block: 'nearest' });
        } else {
            el.classList.remove('bg-indigo-50/70', 'ring-1', 'ring-indigo-500');
        }
    });
}

function addSelectedAutocompleteItems() {
    const searchInput = document.getElementById('catalog-search-input');
    const dropdown = document.getElementById('catalog-autocomplete-dropdown');

    if (selectedAutocompleteCodes.size === 0) {
        showCatalogToast('يرجى تحديد صنف واحد على الأقل من قائمة الاقتراحات باستخدام مربعات الاختيار ☑️', true);
        return;
    }

    const itemsToAdd = currentAutocompleteResults.filter(it => 
        selectedAutocompleteCodes.has(it.code) && !accumulatedSearchResults.has(it.code)
    );

    if (itemsToAdd.length === 0) {
        showCatalogToast('جميع الأصناف المحددة مضافة بالفعل إلى النتائج المجمعة!', true);
        if (searchInput) {
            searchInput.value = '';
            searchInput.focus();
        }
        if (dropdown) dropdown.classList.add('hidden');
        selectedAutocompleteCodes.clear();
        return;
    }

    // إضافة جميع الأصناف المحددة إلى القائمة المجمعة دون حذف الأصناف السابقة
    itemsToAdd.forEach(it => {
        accumulatedSearchResults.set(it.code, it);
    });

    isAccumulatedSearchMode = true;

    // تحديث جدول الأصناف ليعرض النتائج المجمعة
    const allItems = Array.from(accumulatedSearchResults.values());
    currentLoadedCatalogItems = allItems;
    renderCatalogItemsTable(allItems, allItems.length, true);

    // مسح خانة البحث فقط بعد نجاح الإضافة وإعادة التركيز عليها للبحث عن صنف آخر مباشرة
    if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
    }
    if (dropdown) dropdown.classList.add('hidden');
    selectedAutocompleteCodes.clear();
    activeAutocompleteIndex = -1;

    showCatalogToast(`✓ تمت إضافة ${itemsToAdd.length} أصناف محددة بنجاح (إجمالي المجمع: ${accumulatedSearchResults.size})`);
}

function addSingleItemToAccumulated(item) {
    if (!item || !item.code) return;
    const searchInput = document.getElementById('catalog-search-input');
    const dropdown = document.getElementById('catalog-autocomplete-dropdown');

    if (accumulatedSearchResults.has(item.code)) {
        showCatalogToast(`الصنف [${item.code}] "${item.name_en || item.name_ar || ''}" موجود بالفعل في النتائج!`, true);
        if (searchInput) {
            searchInput.value = '';
            searchInput.focus();
        }
        if (dropdown) dropdown.classList.add('hidden');
        selectedAutocompleteCodes.clear();
        activeAutocompleteIndex = -1;
        return;
    }

    // إضافة الصنف إلى قائمة الأصناف المجمعة دون حذف الأصناف السابقة
    accumulatedSearchResults.set(item.code, item);
    isAccumulatedSearchMode = true;

    // تحديث جدول الأصناف
    const allItems = Array.from(accumulatedSearchResults.values());
    currentLoadedCatalogItems = allItems;
    renderCatalogItemsTable(allItems, allItems.length, true);

    // مسح خانة البحث فقط بعد نجاح الإضافة وإعادة التركيز عليها للبحث عن صنف آخر مباشرة
    if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
    }
    if (dropdown) dropdown.classList.add('hidden');
    selectedAutocompleteCodes.clear();
    activeAutocompleteIndex = -1;

    showCatalogToast(`✓ تمت إضافة [${item.code}] "${item.name_en || item.name_ar || ''}" (إجمالي المجمع: ${accumulatedSearchResults.size})`);
}

function initCatalogTab() {
    initCatalogAutocomplete();

    // زر إضافة نتائج البحث إلى القائمة المعروضة دون حذف السابقة
    document.getElementById('btn-search-append')?.addEventListener('click', () => {
        const searchInput = document.getElementById('catalog-search-input');
        const q = searchInput?.value.trim();
        if (selectedAutocompleteCodes.size > 0) {
            addSelectedAutocompleteItems();
        } else if (q) {
            appendSearchQueryToResults(q);
        } else {
            searchInput?.focus();
        }
    });

    // زر مسح نتائج البحث المجمعة والعودة للدليل الكامل
    document.getElementById('btn-clear-search-results')?.addEventListener('click', () => {
        clearAccumulatedSearchResults();
    });

    document.getElementById('btn-catalog-prev')?.addEventListener('click', () => {
        if (catalogOffset >= catalogLimit) {
            catalogOffset -= catalogLimit;
            loadCatalogProducts();
        }
    });

    document.getElementById('btn-catalog-next')?.addEventListener('click', () => {
        catalogOffset += catalogLimit;
        loadCatalogProducts();
    });

    document.getElementById('btn-open-create-product-modal')?.addEventListener('click', () => openCreateProductModal());

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

    document.getElementById('btn-export-catalog-excel')?.addEventListener('click', openCatalogExportModal);
    document.getElementById('btn-close-export-modal')?.addEventListener('click', closeCatalogExportModal);
    document.getElementById('btn-cancel-export-modal')?.addEventListener('click', closeCatalogExportModal);

    // إدارة الحقول المفضلة للتصدير
    restorePreferredExportFields();
    document.getElementById('btn-export-select-all-fields')?.addEventListener('click', () => {
        document.querySelectorAll('.chk-export-field').forEach(chk => chk.checked = true);
    });
    document.getElementById('btn-export-deselect-all-fields')?.addEventListener('click', () => {
        document.querySelectorAll('.chk-export-field').forEach(chk => chk.checked = false);
    });
    document.getElementById('btn-export-save-preferred-fields')?.addEventListener('click', () => {
        const fields = getSelectedExportFields();
        localStorage.setItem('preferred_catalog_export_fields', JSON.stringify(fields));
        const btn = document.getElementById('btn-export-save-preferred-fields');
        if (btn) {
            const oldText = btn.textContent;
            btn.textContent = '✓ تم حفظ الإعداد';
            btn.classList.add('bg-emerald-600');
            setTimeout(() => {
                btn.textContent = oldText;
                btn.classList.remove('bg-emerald-600');
            }, 1800);
        }
    });

    // خيارات تصدير كروت الأصناف إلى Excel
    document.getElementById('btn-export-scope-selected')?.addEventListener('click', async () => {
        let codesToExport = Array.from(selectedCatalogCodes);
        if (codesToExport.length === 0 && isAccumulatedSearchMode && accumulatedSearchResults.size > 0) {
            codesToExport = Array.from(accumulatedSearchResults.keys());
        }
        if (codesToExport.length === 0) {
            alert('يرجى تحديد صنف واحد على الأقل من الجدول أولاً باستخدام مربعات الاختيار، أو تجميع أصناف بالبحث.');
            return;
        }
        closeCatalogExportModal();
        showCatalogToast('📊 جاري سحب الأصناف المحددة وفتح ملف Excel أوتوماتيكياً...');
        await downloadCatalogExcelWithScope('selected', codesToExport, getSelectedExportFields());
    });

    document.getElementById('btn-export-scope-invoice')?.addEventListener('click', async () => {
        if (!activeInvoice || !activeInvoice.lines || activeInvoice.lines.length === 0) {
            alert('لا توجد أصناف في الفاتورة الحالية لتصديرها. امسح بعض الأصناف في الفاتورة أولاً.');
            return;
        }
        closeCatalogExportModal();
        showCatalogToast('📊 جاري سحب أصناف الفاتورة وحفظ الملف وفتحه في Excel...');
        const fields = getSelectedExportFields();
        const fieldsParam = fields.length > 0 ? `&fields=${encodeURIComponent(fields.join(','))}` : '';
        const url = `/api/catalog/export-excel?scope=invoice&invoice_id=${activeInvoice.id}${fieldsParam}`;
        await window.downloadAndTriggerSave(url, `Products_Invoice_${activeInvoice.id}.xlsx`);
    });

    document.getElementById('btn-export-scope-all')?.addEventListener('click', async () => {
        closeCatalogExportModal();
        showCatalogToast('📊 جاري سحب دليل الأصناف بالكامل وحفظ الملف وفتحه في Excel...');
        const fields = getSelectedExportFields();
        const fieldsParam = fields.length > 0 ? `&fields=${encodeURIComponent(fields.join(','))}` : '';
        const url = `/api/catalog/export-excel?scope=all${fieldsParam}`;
        await window.downloadAndTriggerSave(url, `Products_Catalog_All.xlsx`);
    });

    document.getElementById('btn-export-selected-direct')?.addEventListener('click', async () => {
        let codesToExport = Array.from(selectedCatalogCodes);
        if (codesToExport.length === 0 && isAccumulatedSearchMode && accumulatedSearchResults.size > 0) {
            codesToExport = Array.from(accumulatedSearchResults.keys());
        }
        if (codesToExport.length === 0) return;
        showCatalogToast('📊 جاري سحب الأصناف المحددة وفتح ملف Excel أوتوماتيكياً...');
        await downloadCatalogExcelWithScope('selected', codesToExport, getSelectedExportFields());
    });

    document.getElementById('btn-clear-catalog-selection')?.addEventListener('click', () => {
        selectedCatalogCodes.clear();
        document.querySelectorAll('.chk-select-product').forEach(chk => chk.checked = false);
        const allChk = document.getElementById('chk-select-all-catalog');
        if (allChk) { allChk.checked = false; allChk.indeterminate = false; }
        updateCatalogSelectionUI();
    });

    document.getElementById('chk-select-all-catalog')?.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        currentLoadedCatalogItems.forEach(it => {
            if (isChecked) {
                selectedCatalogCodes.add(it.code);
            } else {
                selectedCatalogCodes.delete(it.code);
            }
        });
        document.querySelectorAll('.chk-select-product').forEach(chk => {
            chk.checked = isChecked;
        });
        updateCatalogSelectionUI();
    });

    document.getElementById('btn-close-codes-viewer')?.addEventListener('click', () => {
        document.getElementById('modal-codes-viewer')?.classList.add('hidden');
    });
    document.getElementById('btn-codes-viewer-done')?.addEventListener('click', () => {
        document.getElementById('modal-codes-viewer')?.classList.add('hidden');
    });

    document.getElementById('btn-close-product-modal')?.addEventListener('click', closeProductModal);
    document.getElementById('btn-cancel-product-modal')?.addEventListener('click', closeProductModal);
    document.getElementById('btn-save-product-card')?.addEventListener('click', saveProductCard);
    document.getElementById('btn-generate-code')?.addEventListener('click', async () => {
        try {
            const res = await fetch('/api/catalog/next-code');
            const data = await res.json();
            if (data.code) {
                document.getElementById('prod-code-input').value = data.code;
            }
        } catch (e) {
            console.error(e);
        }
    });

    // أزرار إضافة خانات باركود و GTIN إضافية ديناميكية داخل كرت الصنف
    document.getElementById('btn-add-extra-barcode-row')?.addEventListener('click', () => {
        addExtraBarcodeInputRow('');
    });
    document.getElementById('btn-add-extra-gtin-row')?.addEventListener('click', () => {
        addExtraGtinInputRow('');
    });

    // فلتر فحص واستخراج GTIN يطبق فقط على حقول GTIN وليس الباركود العادي
    setupGtinInputFilter('prod-primary-gtin');
    setupGtinInputFilter('quick-prod-gtin');

    // إضافة باركود وشريحة GTIN مع استخراج رقم بند التجارة العالمي فقط (GTIN)
    const inpBarcode = document.getElementById('input-add-barcode');
    inpBarcode?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('btn-add-barcode-chip')?.click();
        }
    });

    document.getElementById('btn-add-barcode-chip')?.addEventListener('click', () => {
        const val = inpBarcode?.value.trim();
        if (val) {
            addChip('chips-barcodes', val);
            if (inpBarcode) inpBarcode.value = '';
        }
    });

    setupGtinInputFilter('input-add-gtin');

    const inpGtin = document.getElementById('input-add-gtin');
    inpGtin?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            document.getElementById('btn-add-gtin-chip')?.click();
        }
    });

    document.getElementById('btn-add-gtin-chip')?.addEventListener('click', () => {
        const raw = inpGtin?.value.trim();
        if (raw) {
            const clean = extractCleanGtin(raw) || raw;
            addChip('chips-gtins', clean); // شريحة العرض تكون رقم بند التجارة العالمي فقط (GTIN)
            if (inpGtin) inpGtin.value = '';
        }
    });

    ['quick-prod-code', 'quick-prod-name-en', 'quick-prod-name-ar', 'quick-prod-name', 'quick-prod-gtin', 'quick-prod-barcode', 'quick-prod-price', 'quick-prod-tax'].forEach(id => {
        document.getElementById(id)?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('btn-quick-save-product')?.click();
            }
        });
    });

    // حفظ كرت الصنف السريع (يدوياً من الشريط السريع)
    document.getElementById('btn-quick-save-product')?.addEventListener('click', async () => {
        const codeVal = document.getElementById('quick-prod-code')?.value.trim() || '';
        const nameEnVal = document.getElementById('quick-prod-name-en')?.value.trim() || '';
        const nameArVal = document.getElementById('quick-prod-name-ar')?.value.trim() || '';
        const legacyName = document.getElementById('quick-prod-name')?.value.trim() || '';
        const nameEn = nameEnVal || legacyName || nameArVal;
        const nameAr = nameArVal || legacyName || nameEnVal;

        const rawGtin = document.getElementById('quick-prod-gtin')?.value.trim();
        const gtinVal = extractCleanGtin(rawGtin) || rawGtin; // رقم بند التجارة العالمي فقط
        const barcodeVal = document.getElementById('quick-prod-barcode')?.value.trim();
        const priceVal = parseFloat(document.getElementById('quick-prod-price')?.value) || 0.0;
        const taxVal = parseFloat(document.getElementById('quick-prod-tax')?.value) || 0.0; // البديهي 0 مع الإدخال اليدوي

        if (!nameEn && !nameAr) {
            alert('يُرجى إدخال اسم الصنف (عربي أو إنجليزي).');
            (document.getElementById('quick-prod-name-en') || document.getElementById('quick-prod-name-ar') || document.getElementById('quick-prod-name'))?.focus();
            return;
        }
        if (!gtinVal && !barcodeVal) {
            alert('يُرجى إدخال رقم الـ GTIN أو الباركود.');
            document.getElementById('quick-prod-gtin')?.focus();
            return;
        }

        const btn = document.getElementById('btn-quick-save-product');
        btn.disabled = true;
        btn.textContent = 'جاري الحفظ...';

        try {
            const payload = {
                name_en: nameEn,
                name_ar: nameAr,
                gtin_list: gtinVal ? [gtinVal] : [],
                barcode_list: barcodeVal ? [barcodeVal] : [],
                selling_price: priceVal,
                unit_price: 0.0,
                tax_rate: taxVal
            };
            if (codeVal) payload.code = codeVal;

            const res = await fetch('/api/catalog/save', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (data.success) {
                alert(`تم حفظ كرت الصنف بنجاح! كود الصنف: [${data.code}]`);
                if (document.getElementById('quick-prod-code')) document.getElementById('quick-prod-code').value = '';
                if (document.getElementById('quick-prod-name-en')) document.getElementById('quick-prod-name-en').value = '';
                if (document.getElementById('quick-prod-name-ar')) document.getElementById('quick-prod-name-ar').value = '';
                if (document.getElementById('quick-prod-name')) document.getElementById('quick-prod-name').value = '';
                document.getElementById('quick-prod-gtin').value = '';
                document.getElementById('quick-prod-barcode').value = '';
                document.getElementById('quick-prod-price').value = '';
                const taxInput = document.getElementById('quick-prod-tax');
                if (taxInput) taxInput.value = '0';
                loadCatalogProducts();
                refreshSystemStats();
            } else {
                alert(data.message || 'فشل حفظ كرت الصنف.');
            }
        } catch (e) {
            alert('خطأ: ' + e.message);
        } finally {
            btn.disabled = false;
            btn.innerHTML = '<span>➕</span><span>حفظ كرت الصنف</span>';
        }
    });
}

function updateCatalogSelectionUI() {
    const count = selectedCatalogCodes.size;
    const bar = document.getElementById('catalog-selection-bar');
    const badge = document.getElementById('catalog-selected-count-badge');
    const modalBadge = document.getElementById('export-badge-selected-count');

    if (badge) badge.textContent = count.toLocaleString();
    if (modalBadge) modalBadge.textContent = `${count} صنف`;

    if (count > 0) {
        bar?.classList.remove('hidden');
    } else {
        bar?.classList.add('hidden');
    }

    const allChk = document.getElementById('chk-select-all-catalog');
    if (allChk && currentLoadedCatalogItems.length > 0) {
        const allLoadedSelected = currentLoadedCatalogItems.every(it => selectedCatalogCodes.has(it.code));
        const someLoadedSelected = currentLoadedCatalogItems.some(it => selectedCatalogCodes.has(it.code));
        allChk.checked = allLoadedSelected;
        allChk.indeterminate = someLoadedSelected && !allLoadedSelected;
    }
}

function openCatalogExportModal() {
    const modal = document.getElementById('modal-catalog-export-options');
    const badgeSelected = document.getElementById('export-badge-selected-count');
    const badgeInvoice = document.getElementById('export-badge-invoice-count');

    const selCount = selectedCatalogCodes.size;
    if (badgeSelected) badgeSelected.textContent = `${selCount} صنف`;

    const invCount = (activeInvoice && activeInvoice.lines) ? activeInvoice.lines.length : 0;
    if (badgeInvoice) badgeInvoice.textContent = `${invCount} صنف`;

    modal?.classList.remove('hidden');
}

function closeCatalogExportModal() {
    document.getElementById('modal-catalog-export-options')?.classList.add('hidden');
}

function restorePreferredExportFields() {
    try {
        const stored = localStorage.getItem('preferred_catalog_export_fields');
        if (stored) {
            const fields = JSON.parse(stored);
            if (Array.isArray(fields) && fields.length > 0) {
                document.querySelectorAll('.chk-export-field').forEach(chk => {
                    chk.checked = fields.includes(chk.value);
                });
            }
        }
    } catch {}
}

function getSelectedExportFields() {
    const checked = Array.from(document.querySelectorAll('.chk-export-field:checked')).map(el => el.value);
    return checked.length > 0 ? checked : [
        'code', 'name_en', 'name_ar', 'selling_price', 'cost_price',
        'tax_rate', 'category', 'unit', 'barcode', 'gtin'
    ];
}

async function downloadCatalogExcelWithScope(scope, codes = [], fields = []) {
    const selectedFields = (fields && fields.length > 0) ? fields : getSelectedExportFields();
    const fieldsParam = selectedFields.length > 0 ? `&fields=${encodeURIComponent(selectedFields.join(','))}` : '';
    const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const fallbackName = `Products_${scope}_${codes.length || 'All'}_${todayStr}.xlsx`;

    if (codes.length <= 50) {
        const codesStr = codes.join(',');
        const url = `/api/catalog/export-excel?scope=${scope}&codes=${encodeURIComponent(codesStr)}${fieldsParam}`;
        await window.downloadAndTriggerSave(url, fallbackName);
    } else {
        await window.downloadAndTriggerSave('/api/catalog/export-excel', fallbackName, {
            scope,
            codes,
            fields: selectedFields
        });
    }
}

// دالة تجميع نتائج البحث المتعددة دون حذف النتائج السابقة
function addAllAutocompleteResultsToTable(items, query = '') {
    const searchInput = document.getElementById('catalog-search-input');
    const dropdown = document.getElementById('catalog-autocomplete-dropdown');

    if (!items || items.length === 0) {
        if (query) {
            appendSearchQueryToResults(query);
        }
        return;
    }

    let addedCount = 0;
    let dupCount = 0;
    items.forEach(it => {
        if (!accumulatedSearchResults.has(it.code)) {
            accumulatedSearchResults.set(it.code, it);
            addedCount++;
        } else {
            dupCount++;
        }
    });

    isAccumulatedSearchMode = true;
    const allItems = Array.from(accumulatedSearchResults.values());
    currentLoadedCatalogItems = allItems;
    renderCatalogItemsTable(allItems, allItems.length, true);

    // إفراغ خانة البحث وإغلاق القائمة وإعادة التركيز للبحث عن الصنف التالي مباشرة
    if (searchInput) {
        searchInput.value = '';
        searchInput.focus();
    }
    if (dropdown) dropdown.classList.add('hidden');
    selectedAutocompleteCodes.clear();
    activeAutocompleteIndex = -1;
    currentAutocompleteResults = [];

    if (addedCount > 0) {
        showCatalogToast(`✓ تم إدراج ${addedCount} صنف ${query ? `مطابق لـ "${query}"` : ''} في الجدول (الإجمالي: ${accumulatedSearchResults.size})`);
    } else {
        showCatalogToast(`الأصناف المطابقة موجودة بالفعل في الجدول`, true);
    }
}

async function appendSearchQueryToResults(query) {
    if (!query) return;
    try {
        const url = `/api/catalog/products?query=${encodeURIComponent(query)}&mode=${isGeneralizedSearch ? "contains" : "start"}&limit=2000&offset=0`;
        const res = await fetch(url);
        const data = await res.json();
        const items = data.items || [];
        if (items.length === 0) {
            showCatalogToast(`لم يتم العثور على أي صنف يطابق: "${query}"`, true);
            return;
        }

        addAllAutocompleteResultsToTable(items, query);
    } catch (e) {
        showCatalogToast('حدث خطأ أثناء البحث: ' + e.message, true);
    }
}

function clearAccumulatedSearchResults() {
    accumulatedSearchResults.clear();
    isAccumulatedSearchMode = false;
    document.getElementById('btn-clear-search-results')?.classList.add('hidden');
    document.getElementById('catalog-search-accumulated-badge')?.classList.add('hidden');
    const searchInput = document.getElementById('catalog-search-input');
    if (searchInput) searchInput.value = '';
    const dropdown = document.getElementById('catalog-autocomplete-dropdown');
    if (dropdown) dropdown.classList.add('hidden');
    activeAutocompleteIndex = -1;
    currentAutocompleteResults = [];
    catalogOffset = 0;
    loadCatalogProducts();
    updateCatalogSelectionUI();
    showCatalogToast('تم مسح نتائج البحث والعودة لدليل الأصناف الكامل');
}

function addExtraBarcodeInputRow(val = '') {
    const container = document.getElementById('extra-barcodes-container');
    if (!container) return null;
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 extra-barcode-row';
    row.innerHTML = `
        <div class="relative flex-1">
            <input type="text" value="${val}" placeholder="رقم باركود إضافي..."
                   class="extra-barcode-input w-full text-xs p-2 bg-white border border-slate-300 rounded-xl focus:border-indigo-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono">
            <span class="absolute left-2.5 top-2 text-[9.5px] font-bold text-slate-400 pointer-events-none">إضافي</span>
        </div>
        <button type="button" class="btn-del-extra-barcode w-8 h-8 rounded-lg text-rose-500 hover:text-rose-700 hover:bg-rose-50 flex items-center justify-center font-bold text-sm shrink-0 transition" title="حذف هذا الباركود">
            🗑️
        </button>
    `;
    row.querySelector('.btn-del-extra-barcode').addEventListener('click', () => {
        row.remove();
    });
    container.appendChild(row);
    const input = row.querySelector('.extra-barcode-input');
    return input;
}

function addExtraGtinInputRow(val = '') {
    const container = document.getElementById('extra-gtins-container');
    if (!container) return null;
    const cleanVal = extractCleanGtin(val) || val;
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2 extra-gtin-row';
    row.innerHTML = `
        <div class="relative flex-1">
            <input type="text" value="${cleanVal}" placeholder="رقم GTIN إضافي (14 رقماً)..."
                   class="extra-gtin-input w-full text-xs p-2 bg-white border border-indigo-200 rounded-xl focus:border-indigo-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 font-mono font-bold text-indigo-900">
            <span class="absolute left-2.5 top-2 text-[9.5px] font-bold text-indigo-400 pointer-events-none">إضافي</span>
        </div>
        <button type="button" class="btn-del-extra-gtin w-8 h-8 rounded-lg text-rose-500 hover:text-rose-700 hover:bg-rose-50 flex items-center justify-center font-bold text-sm shrink-0 transition" title="حذف هذا الـ GTIN">
            🗑️
        </button>
    `;
    row.querySelector('.btn-del-extra-gtin').addEventListener('click', () => {
        row.remove();
    });
    container.appendChild(row);
    const input = row.querySelector('.extra-gtin-input');
    setupGtinInputFilter(input);
    return input;
}

async function openCodesViewerModal(code, type) {
    if (!code) return;
    const isGtin = (type === 'gtin');

    let prod = currentLoadedCatalogItems.find(x => x.code === code);
    if (!prod || !prod.barcode_list || !prod.gtin_list) {
        try {
            const res = await fetch(`/api/catalog/product?code=${encodeURIComponent(code)}`);
            const data = await res.json();
            if (data.success) prod = data.product;
        } catch {}
    }
    if (!prod) return;

    const modal = document.getElementById('modal-codes-viewer');
    const title = document.getElementById('codes-viewer-title');
    const subtitle = document.getElementById('codes-viewer-subtitle');
    const list = document.getElementById('codes-viewer-list');
    const btnEdit = document.getElementById('btn-codes-viewer-edit-prod');

    if (isGtin) {
        title.innerHTML = `<span>🌐</span><span>أرقام بند التجارة العالمي (GTIN) للصنف</span>`;
    } else {
        title.innerHTML = `<span>🏷️</span><span>أرقام الباركود المسجلة للصنف</span>`;
    }

    const prodLabel = prod.name_en || prod.name || prod.name_ar || `صنف [${code}]`;
    subtitle.textContent = `[${code}] ${prodLabel}`;

    const rawList = isGtin ? (prod.gtin_list || []) : (prod.barcode_list || []);
    const itemsToShow = isGtin ? rawList.map(g => extractCleanGtin(g)).filter(Boolean) : rawList;

    list.innerHTML = '';
    if (itemsToShow.length === 0) {
        list.innerHTML = `<div class="p-4 text-center text-slate-400">لا توجد أرقام مسجلة لهذا الصنف</div>`;
    } else {
        itemsToShow.forEach((val, i) => {
            const row = document.createElement('div');
            row.className = 'flex items-center justify-between p-2 hover:bg-slate-50 transition rounded-lg text-xs';
            row.innerHTML = `
                <div class="flex items-center gap-2">
                    <span class="w-5 h-5 rounded-full bg-slate-100 text-slate-600 font-mono text-[10px] flex items-center justify-center font-bold">${i + 1}</span>
                    <span class="font-mono font-bold text-xs ${isGtin ? 'text-indigo-800' : 'text-slate-800'} select-all">${val}</span>
                </div>
                <button type="button" class="btn-copy-code px-2 py-0.5 bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 rounded text-[11px] font-medium transition flex items-center gap-1 shadow-sm" data-val="${val}">
                    <span>📋</span>
                    <span>نسخ</span>
                </button>
            `;
            list.appendChild(row);
        });
    }

    list.querySelectorAll('.btn-copy-code').forEach(btn => {
        btn.addEventListener('click', () => {
            const val = btn.getAttribute('data-val');
            navigator.clipboard.writeText(val).then(() => {
                btn.innerHTML = '<span>✓</span><span>تم النسخ</span>';
                btn.classList.add('bg-emerald-50', 'text-emerald-700', 'border-emerald-300');
                setTimeout(() => {
                    btn.innerHTML = '<span>📋</span><span>نسخ</span>';
                    btn.classList.remove('bg-emerald-50', 'text-emerald-700', 'border-emerald-300');
                }, 1500);
            });
        });
    });

    if (btnEdit) {
        btnEdit.onclick = () => {
            modal.classList.add('hidden');
            openEditProductModal(prod);
        };
    }

    modal?.classList.remove('hidden');
}

// السحابة توقف العدّ عند حد معين لتوفير حصة القراءة: العدد عندها "أكثر من ..."
let catalogTotalIsEstimate = false;
function renderCatalogItemsTable(items, total, isAccumulated = false) {
    const tbody = document.getElementById('catalog-products-tbody');
    if (!tbody) return;

    if (isAccumulated) {
        document.getElementById('catalog-pagination-info').textContent =
            `عرض ${items.length} أصناف مجمعة من نتائج البحث المتعدد`;
        document.getElementById('btn-catalog-prev').disabled = true;
        document.getElementById('btn-catalog-next').disabled = true;
        const accBadge = document.getElementById('catalog-search-accumulated-badge');
        if (accBadge) {
            accBadge.textContent = `${items.length} مجمعة`;
            accBadge.classList.remove('hidden');
        }
        document.getElementById('btn-clear-search-results')?.classList.remove('hidden');
    } else {
        document.getElementById('catalog-pagination-info').textContent =
            `عرض ${items.length} من أصل ${(!isAccumulated && catalogTotalIsEstimate) ? 'أكثر من ' + (total - 1).toLocaleString() : total.toLocaleString()} صنف`;
        document.getElementById('btn-catalog-prev').disabled = (catalogOffset === 0);
        document.getElementById('btn-catalog-next').disabled = (catalogOffset + items.length >= total);
        document.getElementById('catalog-search-accumulated-badge')?.classList.add('hidden');
        document.getElementById('btn-clear-search-results')?.classList.add('hidden');
    }

    if (items.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" class="excel-cell py-6 text-center text-slate-400">لم يتم العثور على أصناف مطابقة</td></tr>';
        updateCatalogSelectionUI();
        return;
    }

    tbody.innerHTML = '';
    items.forEach(it => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-sky-50/70 transition text-center font-medium select-none';

        const isChecked = selectedCatalogCodes.has(it.code);
        const bList = it.barcode_list || [];
        const gList = (it.gtin_list || []).map(g => extractCleanGtin(g) || g).filter(Boolean);

        // الباركود: عرض خانة واحدة فقط وعند وجود أكثر من باركود يظهر زر +N لاستعراض الباقي
        let bHtml = '<span class="text-slate-400 font-mono text-[10px]">-</span>';
        if (bList.length === 1) {
            bHtml = `<span class="font-mono text-[10px] text-slate-700 select-all truncate block" title="${bList[0]}">${bList[0]}</span>`;
        } else if (bList.length > 1) {
            bHtml = `
                <div class="inline-flex items-center justify-between w-full gap-1">
                    <span class="font-mono text-[10px] text-slate-800 select-all truncate max-w-[70px]" title="${bList[0]}">${bList[0]}</span>
                    <button type="button" class="btn-expand-codes px-1 py-0.2 bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 rounded text-[9px] font-bold leading-none shrink-0" 
                            data-code="${it.code}" data-type="barcode" title="عرض باقي الباركودات (${bList.length})">
                        +${bList.length - 1}
                    </button>
                </div>
            `;
        }

        // جي تي ان GTIN: عرض خانة واحدة فقط وعند وجود أكثر من GTIN يظهر زر +N لاستعراض الباقي
        let gHtml = '<span class="text-slate-400 font-mono text-[10px]">-</span>';
        if (gList.length === 1) {
            gHtml = `<span class="font-mono text-[10px] text-indigo-700 font-bold select-all truncate block" title="${gList[0]}">${gList[0]}</span>`;
        } else if (gList.length > 1) {
            gHtml = `
                <div class="inline-flex items-center justify-between w-full gap-1">
                    <span class="font-mono text-[10px] text-indigo-700 font-bold select-all truncate max-w-[80px]" title="${gList[0]}">${gList[0]}</span>
                    <button type="button" class="btn-expand-codes px-1 py-0.2 bg-indigo-50 hover:bg-indigo-100 text-indigo-800 border border-indigo-200 rounded text-[9px] font-bold leading-none shrink-0" 
                            data-code="${it.code}" data-type="gtin" title="عرض باقي أرقام GTIN (${gList.length})">
                        +${gList.length - 1}
                    </button>
                </div>
            `;
        }

        const engName = it.name_en || it.name || '';
        const arName = it.name_ar || '';
        const salesPrice = parseFloat(it.selling_price || 0).toFixed(2);
        const unitPrice = parseFloat(it.unit_price || it.cost_price || 0).toFixed(2);
        const taxRate = parseFloat(it.tax_rate || 0);
        const taxBadge = taxRate > 0 
            ? `<span class="px-1.5 py-0.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded text-[10px] font-bold inline-flex items-center gap-0.5" title="خاضع لضريبة القيمة المضافة ${taxRate.toFixed(0)}%"><span>VAT</span> <span>${taxRate.toFixed(0)}%</span></span>`
            : `<span class="px-1 py-0.5 bg-slate-100 text-slate-400 rounded text-[9.5px]" title="غير خاضع للضريبة (FALSE)">غير خاضع</span>`;

        tr.innerHTML = `
            <td class="excel-cell text-center p-0.5">
                <input type="checkbox" class="chk-select-product cursor-pointer rounded border-slate-300 w-3.5 h-3.5" data-code="${it.code}" ${isChecked ? 'checked' : ''}>
            </td>
            <td class="excel-cell text-center font-mono font-bold text-indigo-700 bg-indigo-50/40 text-[11px] cursor-pointer hover:underline hover:bg-indigo-100 transition cell-click-view-card" data-code="${it.code}" title="انقر لعرض وتعديل كرت الصنف بالكامل">${it.code}</td>
            <td class="excel-cell text-left px-2 max-w-[240px] cursor-pointer hover:bg-slate-100 transition cell-click-view-card" data-code="${it.code}" title="${engName} ${arName ? `(${arName})` : ''} - انقر لعرض كرت الصنف كامل">
                <div class="font-bold text-slate-900 leading-tight truncate select-all text-[11px]">${engName}</div>
                ${arName ? `<div class="text-[9.5px] text-slate-400 font-normal leading-none mt-0.5 truncate select-all">${arName}</div>` : ''}
            </td>
            <td class="excel-cell text-center">
                <span class="px-1.5 py-0.2 bg-slate-100 rounded text-[10px] text-slate-700 truncate max-w-[70px] inline-block" title="${it.category || 'عام'}">${it.category || 'عام'}</span>
            </td>
            <td class="excel-cell text-center font-mono font-bold text-emerald-700 text-[11px]">${salesPrice}</td>
            <td class="excel-cell text-center font-mono text-slate-600 text-[11px]">${unitPrice}</td>
            <td class="excel-cell text-center font-mono text-slate-600 text-[11px]">${taxBadge}</td>
            <td class="excel-cell text-center text-slate-600 text-[10.5px]">
                <span class="truncate max-w-[65px] inline-block" title="${it.unit || 'علبة'}">${it.unit || 'علبة'}</span>
            </td>
            <td class="excel-cell text-center px-1">${bHtml}</td>
            <td class="excel-cell text-center px-1">${gHtml}</td>
            <td class="excel-cell text-center">
                <div class="inline-flex items-center justify-center gap-1">
                    <!-- زر عرض كرت الصنف بالكامل -->
                    <button class="btn-view-product px-2 py-0.5 bg-sky-50 hover:bg-sky-100 text-sky-800 border border-sky-200 rounded text-[10.5px] font-bold inline-flex items-center gap-1 shadow-2xs transition" data-code="${it.code}" title="عرض وتعديل كرت الصنف كامل">
                        <span>👁️</span><span>الكرت</span>
                    </button>
                    ${isAccumulated ? `
                        <button class="btn-remove-from-accumulated text-rose-500 hover:text-rose-700 hover:bg-rose-50 p-1 text-xs leading-none rounded" data-code="${it.code}" title="استبعاد من القائمة المجمعة">❌</button>
                    ` : ''}
                    <button class="btn-edit-product text-indigo-600 hover:text-indigo-900 p-1 text-xs leading-none" data-code="${it.code}" title="تعديل سريع لكرت الصنف">✏️</button>
                    <button class="btn-del-product text-rose-500 hover:text-rose-700 p-1 text-xs leading-none" data-code="${it.code}" title="حذف الصنف">🗑️</button>
                </div>
            </td>
        `;

        // النقر المزدوج على السطر لفتح كرت الصنف كاملاً
        tr.addEventListener('dblclick', async (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' || e.target.closest('button')) return;
            await openEditProductModalByCode(it.code);
        });

        tbody.appendChild(tr);
    });

    // ربط النقر على خلايا الكود والاسم لفتح كرت الصنف كاملاً
    tbody.querySelectorAll('.cell-click-view-card').forEach(cell => {
        cell.addEventListener('click', async (e) => {
            e.stopPropagation();
            const code = cell.getAttribute('data-code');
            await openEditProductModalByCode(code);
        });
    });

    // ربط زر عرض كرت الصنف بالكامل
    tbody.querySelectorAll('.btn-view-product').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const code = btn.getAttribute('data-code');
            await openEditProductModalByCode(code);
        });
    });

    // ربط زر استبعاد الصنف من النتائج المجمعة
    tbody.querySelectorAll('.btn-remove-from-accumulated').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const code = btn.getAttribute('data-code');
            accumulatedSearchResults.delete(code);
            selectedCatalogCodes.delete(code);
            if (accumulatedSearchResults.size === 0) {
                clearAccumulatedSearchResults();
            } else {
                const allItems = Array.from(accumulatedSearchResults.values());
                currentLoadedCatalogItems = allItems;
                renderCatalogItemsTable(allItems, allItems.length, true);
                updateCatalogSelectionUI();
                showCatalogToast(`تم استبعاد الصنف [${code}] من القائمة المجمعة`);
            }
        });
    });

    // ربط مربعات تحديد الأصناف
    tbody.querySelectorAll('.chk-select-product').forEach(chk => {
        chk.addEventListener('change', () => {
            const code = chk.getAttribute('data-code');
            if (chk.checked) {
                selectedCatalogCodes.add(code);
            } else {
                selectedCatalogCodes.delete(code);
            }
            updateCatalogSelectionUI();
        });
    });

    // ربط أزرار استعراض باقي الباركودات و GTIN
    tbody.querySelectorAll('.btn-expand-codes').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const code = btn.getAttribute('data-code');
            const type = btn.getAttribute('data-type');
            openCodesViewerModal(code, type);
        });
    });

    // ربط أزرار التعديل والحذف
    tbody.querySelectorAll('.btn-edit-product').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const code = btn.getAttribute('data-code');
            await openEditProductModalByCode(code);
        });
    });

    tbody.querySelectorAll('.btn-del-product').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const code = btn.getAttribute('data-code');
            if (confirm(`هل أنت متأكد من حذف بطاقة الصنف [${code}]؟`)) {
                try {
                    const res = await fetch('/api/catalog/delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ code })
                    });
                    const data = await res.json();
                    if (data.success) {
                        selectedCatalogCodes.delete(code);
                        if (isAccumulatedSearchMode) {
                            accumulatedSearchResults.delete(code);
                            renderCatalogItemsTable(Array.from(accumulatedSearchResults.values()), accumulatedSearchResults.size, true);
                        } else {
                            loadCatalogProducts();
                        }
                        refreshSystemStats();
                    } else {
                        alert(data.message);
                    }
                } catch (e) {
                    alert('فشل الحذف: ' + e.message);
                }
            }
        });
    });

    updateCatalogSelectionUI();
}

async function loadCatalogProducts() {
    if (isAccumulatedSearchMode) {
        renderCatalogItemsTable(Array.from(accumulatedSearchResults.values()), accumulatedSearchResults.size, true);
        return;
    }

    const query = (document.getElementById('catalog-search-input')?.value || '').replace(/^\s+/, '');
    const tbody = document.getElementById('catalog-products-tbody');
    if (!currentLoadedCatalogItems || currentLoadedCatalogItems.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" class="excel-cell py-6 text-center text-slate-400">جاري التحميل...</td></tr>';
    }

    try {
        const url = `/api/catalog/products?query=${encodeURIComponent(query)}&mode=${isGeneralizedSearch ? "contains" : "start"}&limit=${catalogLimit}&offset=${catalogOffset}`;
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error('جاري تجديد الاتصال بالسيرفر...');
        }
        const data = await res.json();
        if (data.offline_reconnecting) {
            throw new Error(data.message || 'جاري تجديد الاتصال بالسيرفر...');
        }
        const items = data.items || [];
        const total = data.total || 0;
        catalogTotalIsEstimate = Boolean(data.total_is_estimate);

        currentLoadedCatalogItems = items;
        renderCatalogItemsTable(items, total, false);
    } catch (e) {
        if (!currentLoadedCatalogItems || currentLoadedCatalogItems.length === 0) {
            tbody.innerHTML = `<tr><td colspan="11" class="excel-cell py-6 text-center text-amber-600 font-bold">⏳ جاري تجديد الاتصال التلقائي بالسيرفر... سيتم التحديث خلال ثوانٍ</td></tr>`;
        }
        setTimeout(() => {
            if (currentTab === 'catalog') loadCatalogProducts();
        }, 3500);
    }
}

async function clearProductCardInputs(clearCode = false) {
    if (clearCode) {
        activeEditingProductCode = null;
        document.getElementById('prod-code-input').value = '';
        document.getElementById('btn-modal-delete-product')?.classList.add('hidden');
        document.getElementById('btn-footer-delete-product')?.classList.add('hidden');
    }
    document.getElementById('prod-name-ar').value = '';
    document.getElementById('prod-name-en').value = '';
    if (document.getElementById('prod-scientific-name')) document.getElementById('prod-scientific-name').value = '';
    if (document.getElementById('prod-company')) document.getElementById('prod-company').value = '';
    document.getElementById('prod-category').value = '';
    document.getElementById('prod-tax-rate').value = '0'; if (document.getElementById('prod-is-taxable')) document.getElementById('prod-is-taxable').checked = false;
    document.getElementById('prod-selling-price').value = '';
    if (document.getElementById('prod-wholesale-price')) document.getElementById('prod-wholesale-price').value = '';
    document.getElementById('prod-unit-price').value = '';
    document.getElementById('prod-unit').value = 'علبة';
    document.getElementById('prod-unit-divisions').value = '';
    
    const pBar = document.getElementById('prod-primary-barcode');
    const pGtin = document.getElementById('prod-primary-gtin');
    if (pBar) pBar.value = '';
    if (pGtin) pGtin.value = '';

    const eb = document.getElementById('extra-barcodes-container');
    const eg = document.getElementById('extra-gtins-container');
    if (eb) eb.innerHTML = '';
    if (eg) eg.innerHTML = '';
    cancelGs1Inspector();
}

async function openCreateProductModal(prefillGtin = null, initialData = {}) {
    if (typeof prefillGtin !== 'string') prefillGtin = null;
    if (!initialData || typeof initialData !== 'object' || initialData instanceof Event) initialData = {};
    cancelGs1Inspector();
    document.getElementById('modal-product-title').textContent = 'إضافة بطاقة صنف جديدة';
    
    // تعيين الكود: إذا تم تمرير كود مطابق لملف الإكسيل نستخدمه مباشرة، وإلا نقترح كوداً جديداً
    if (initialData.code) {
        document.getElementById('prod-code-input').value = initialData.code;
    } else {
        try {
            const res = await fetch('/api/catalog/next-code');
            const data = await res.json();
            document.getElementById('prod-code-input').value = data.code || '10001';
        } catch {
            document.getElementById('prod-code-input').value = '10001';
        }
    }

    document.getElementById('prod-name-ar').value = initialData.name_ar || '';
    document.getElementById('prod-name-en').value = initialData.name_en || '';
    if (document.getElementById('prod-scientific-name')) document.getElementById('prod-scientific-name').value = initialData.scientific_name || '';
    if (document.getElementById('prod-company')) document.getElementById('prod-company').value = initialData.company || '';
    document.getElementById('prod-category').value = initialData.category || 'دواء';
    const initTax = initialData.tax_rate != null ? initialData.tax_rate : '0'; document.getElementById('prod-tax-rate').value = initTax; if (document.getElementById('prod-is-taxable')) document.getElementById('prod-is-taxable').checked = (parseFloat(initTax || 0) > 0); // البديهي 0 مع الإدخال اليدوي
    document.getElementById('prod-selling-price').value = initialData.selling_price || '';
    if (document.getElementById('prod-wholesale-price')) document.getElementById('prod-wholesale-price').value = initialData.wholesale_price || '';
    document.getElementById('prod-unit-price').value = initialData.unit_price || '';
    document.getElementById('prod-unit').value = initialData.unit || 'علبة';
    document.getElementById('prod-unit-divisions').value = initialData.unit_divisions || '';

    // مسح وتجهيز خانات الباركود و GTIN الديناميكية
    const pBar = document.getElementById('prod-primary-barcode');
    if (pBar) pBar.value = initialData.primary_barcode || initialData.barcode || '';
    const pGtin = document.getElementById('prod-primary-gtin');
    if (pGtin) pGtin.value = extractCleanGtin(prefillGtin || initialData.primary_gtin || initialData.gtin || '') || '';

    const ebContainer = document.getElementById('extra-barcodes-container');
    const egContainer = document.getElementById('extra-gtins-container');
    if (ebContainer) ebContainer.innerHTML = '';
    if (egContainer) egContainer.innerHTML = '';

    document.getElementById('modal-product-card')?.classList.remove('hidden');
    (document.getElementById('prod-name-en') || document.getElementById('prod-name-ar'))?.focus();
}

async function openEditProductModalByCode(code) {
    if (!code) return;
    try {
        const res = await fetch(`/api/catalog/product?code=${encodeURIComponent(code)}`);
        const data = await res.json();
        if (data.success && data.product) {
            openEditProductModal(data.product);
        } else {
            alert(data.message || 'لم يتم العثور على بيانات كرت الصنف.');
        }
    } catch (e) {
        alert('تعذر فتح كرت الصنف: ' + e.message);
    }
}

function openEditProductModal(p) {
    activeEditingProductCode = p.code;
    document.getElementById('btn-modal-delete-product')?.classList.remove('hidden');
    document.getElementById('btn-footer-delete-product')?.classList.remove('hidden');
    cancelGs1Inspector();
    document.getElementById('modal-product-title').textContent = `تعديل بطاقة الصنف [${p.code}]`;
    document.getElementById('prod-code-input').value = p.code;
    document.getElementById('prod-name-ar').value = p.name_ar || '';
    document.getElementById('prod-name-en').value = p.name_en || '';
    if (document.getElementById('prod-scientific-name')) document.getElementById('prod-scientific-name').value = p.scientific_name || '';
    if (document.getElementById('prod-company')) document.getElementById('prod-company').value = p.company || '';
    document.getElementById('prod-category').value = p.category || '';
    const pTax = p.tax_rate != null ? p.tax_rate : 0; document.getElementById('prod-tax-rate').value = pTax; if (document.getElementById('prod-is-taxable')) document.getElementById('prod-is-taxable').checked = (parseFloat(pTax || 0) > 0);
    document.getElementById('prod-selling-price').value = p.selling_price || '';
    if (document.getElementById('prod-wholesale-price')) document.getElementById('prod-wholesale-price').value = p.wholesale_price || '';
    document.getElementById('prod-unit-price').value = p.unit_price || p.cost_price || '';
    document.getElementById('prod-unit').value = p.unit || 'علبة';
    document.getElementById('prod-unit-divisions').value = p.unit_divisions || '';

    const bList = p.barcode_list || [];
    const gList = p.gtin_list || [];

    const pBar = document.getElementById('prod-primary-barcode');
    if (pBar) pBar.value = bList[0] || p.barcode || '';

    const pGtin = document.getElementById('prod-primary-gtin');
    if (pGtin) pGtin.value = extractCleanGtin(gList[0]) || gList[0] || p.gtin || '';

    const ebContainer = document.getElementById('extra-barcodes-container');
    const egContainer = document.getElementById('extra-gtins-container');
    if (ebContainer) ebContainer.innerHTML = '';
    if (egContainer) egContainer.innerHTML = '';

    for (let i = 1; i < bList.length; i++) {
        addExtraBarcodeInputRow(bList[i]);
    }
    for (let i = 1; i < gList.length; i++) {
        addExtraGtinInputRow(extractCleanGtin(gList[i]) || gList[i]);
    }

    document.getElementById('modal-product-card')?.classList.remove('hidden');
}

function closeProductModal() {
    cancelGs1Inspector();
    document.getElementById('modal-product-card')?.classList.add('hidden');
}

async function saveProductCard() {
    const code = document.getElementById('prod-code-input').value.trim();
    const name_ar = document.getElementById('prod-name-ar').value.trim();
    const name_en = document.getElementById('prod-name-en').value.trim();
    if (!name_ar && !name_en) {
        alert('يجب إدخال اسم الصنف بالعربي أو بالإنجليزي على الأقل.');
        return;
    }

    const primaryBarcode = document.getElementById('prod-primary-barcode')?.value.trim() || '';
    const extraBarcodes = Array.from(document.querySelectorAll('.extra-barcode-input'))
        .map(el => el.value.trim())
        .filter(Boolean);

    const rawPrimaryGtin = document.getElementById('prod-primary-gtin')?.value.trim() || '';
    const primaryGtin = extractCleanGtin(rawPrimaryGtin) || rawPrimaryGtin;
    const extraGtins = Array.from(document.querySelectorAll('.extra-gtin-input'))
        .map(el => {
            const raw = el.value.trim();
            return extractCleanGtin(raw) || raw;
        })
        .filter(Boolean);

    // تجميع الباركودات ومنع التكرار داخل الصنف
    const allBarcodes = [];
    if (primaryBarcode) allBarcodes.push(primaryBarcode);
    extraBarcodes.forEach(b => {
        if (!allBarcodes.includes(b)) allBarcodes.push(b);
    });

    // تجميع GTINs ومنع التكرار داخل الصنف
    const allGtins = [];
    if (primaryGtin) allGtins.push(primaryGtin);
    extraGtins.forEach(g => {
        if (!allGtins.includes(g)) allGtins.push(g);
    });

    const payload = {
        code,
        name_ar,
        name_en,
        scientific_name: document.getElementById('prod-scientific-name')?.value.trim() || '',
        company: document.getElementById('prod-company')?.value.trim() || '',
        category: document.getElementById('prod-category')?.value.trim() || 'دواء',
        tax_rate: parseFloat(document.getElementById('prod-tax-rate')?.value) || 0.0,
        selling_price: parseFloat(document.getElementById('prod-selling-price')?.value) || 0.0,
        wholesale_price: parseFloat(document.getElementById('prod-wholesale-price')?.value) || 0.0,
        unit_price: parseFloat(document.getElementById('prod-unit-price')?.value) || 0.0,
        unit: document.getElementById('prod-unit')?.value.trim() || 'علبة',
        unit_divisions: document.getElementById('prod-unit-divisions')?.value.trim() || '',
        primary_barcode: primaryBarcode,
        extra_barcodes: extraBarcodes.join(','),
        barcode_list: allBarcodes,
        primary_gtin: primaryGtin,
        extra_gtins: extraGtins.join(','),
        gtin_list: allGtins
    };

    try {
        const res = await fetch('/api/catalog/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            closeProductModal();
            if (isAccumulatedSearchMode) {
                accumulatedSearchResults.set(code, Object.assign({}, accumulatedSearchResults.get(code) || {}, payload));
                const allItems = Array.from(accumulatedSearchResults.values());
                renderCatalogItemsTable(allItems, allItems.length, true);
            } else {
                loadCatalogProducts();
            }
            refreshSystemStats();
            await loadActiveDraftInvoice();
            alert(data.message || 'تم حفظ وتحديث بطاقة الصنف بنجاح.');

            const unregBox = document.getElementById('unpacked-unregistered-box');
            if (unregBox && !unregBox.classList.contains('hidden')) {
                unregBox.classList.add('hidden');
                if (lastScannedQr) {
                    await executeScan(lastScannedQr);
                }
            }
        } else {
            alert(data.message || 'فشل حفظ الصنف.');
        }
    } catch (e) {
        alert('خطأ أثناء الحفظ: ' + e.message);
    }
}

// ==================== تبويب 3: استيراد الأصناف من Excel ====================
function initImportTab() {
    const dropzone = document.getElementById('import-dropzone');
    const fileInput = document.getElementById('import-file-input');

    dropzone?.addEventListener('click', () => fileInput?.click());
    dropzone?.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('border-indigo-500'); });
    dropzone?.addEventListener('dragleave', () => dropzone.classList.remove('border-indigo-500'));
    dropzone?.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('border-indigo-500');
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            handleImportFileUpload(e.dataTransfer.files[0]);
        }
    });

    fileInput?.addEventListener('change', () => {
        if (fileInput.files && fileInput.files[0]) {
            handleImportFileUpload(fileInput.files[0]);
        }
    });

    document.getElementById('btn-smart-suggest-mapping')?.addEventListener('click', autoSuggestMapping);
    document.getElementById('btn-cancel-mapping')?.addEventListener('click', resetImportWizard);
    document.getElementById('btn-preview-import')?.addEventListener('click', executeImportPreview);
    document.getElementById('btn-back-to-mapping')?.addEventListener('click', () => {
        document.getElementById('import-step-preview')?.classList.add('hidden');
        document.getElementById('import-step-mapping')?.classList.remove('hidden');
    if (data.suggested_mapping && data.suggested_mapping.tax_rate_col && document.getElementById('map-tax-rate')) {
        setTimeout(() => {
            const sel = document.getElementById('map-tax-rate');
            if (sel) sel.value = data.suggested_mapping.tax_rate_col;
        }, 50);
    }
    });
    document.getElementById('btn-commit-import')?.addEventListener('click', executeImportCommit);
    document.getElementById('btn-report-new-import')?.addEventListener('click', resetImportWizard);
}

async function handleImportFileUpload(file) {
    const formData = new FormData();
    formData.append('file', file);

    const dropzone = document.getElementById('import-dropzone');
    if (dropzone) {
        dropzone.innerHTML = `
            <div class="flex flex-col items-center">
                <span class="text-3xl animate-spin mb-2">⏳</span>
                <p class="text-sm font-bold text-slate-700">جاري قراءة ملف Excel وفحص الأعمدة...</p>
            </div>
        `;
    }

    try {
        const res = await fetch('/api/catalog/upload-excel', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();

        if (data.success) {
            uploadedImportFileId = data.file_id;
            uploadedImportHeaders = data.headers || [];
            showImportMappingStep(data);
        } else {
            alert(data.message || 'فشل قراءة الملف.');
            resetImportWizard();
        }
    } catch (e) {
        alert('خطأ أثناء رفع الملف: ' + e.message);
        resetImportWizard();
    }
}

function showImportMappingStep(data) {
    document.getElementById('import-step-upload')?.classList.add('hidden');
    document.getElementById('import-step-mapping')?.classList.remove('hidden');

    const headers = data.headers || [];

    // ملء القوائم المنسدلة: غير مربوطة تلقائياً وفق الشرط رقم 3
    const singleSelects = [
        'map-code', 'map-name-ar', 'map-name-en', 'map-scientific-name', 'map-company',
        'map-category', 'map-selling-price', 'map-unit-price', 'map-wholesale-price',
        'map-tax-rate', 'map-unit', 'map-unit-divisions', 'map-grouping'
    ];

    singleSelects.forEach(selId => {
        const sel = document.getElementById(selId);
        if (!sel) return;
        sel.innerHTML = `<option value="">-- اختر العمود يدويًا --</option>`;
        headers.forEach(h => {
            const opt = document.createElement('option');
            opt.value = h;
            opt.textContent = h;
            sel.appendChild(opt);
        });
        // التأكد من أنها غير محددة (unselected)
        sel.value = '';
    });

    // ملء مربعات اختيار أعمدة الباركود والـ GTIN المتعددة
    const bContainer = document.getElementById('barcode-checkboxes-container');
    const gContainer = document.getElementById('gtin-checkboxes-container');
    bContainer.innerHTML = '';
    gContainer.innerHTML = '';

    headers.forEach((h, idx) => {
        // الباركود
        const bDiv = document.createElement('label');
        bDiv.className = 'flex items-center gap-2 p-1.5 hover:bg-slate-50 rounded cursor-pointer';
        bDiv.innerHTML = `
            <input type="checkbox" class="cb-barcode-col rounded text-indigo-600 focus:ring-indigo-500" value="${h}">
            <span class="font-mono">${h}</span>
        `;
        bContainer.appendChild(bDiv);

        // GTIN
        const gDiv = document.createElement('label');
        gDiv.className = 'flex items-center gap-2 p-1.5 hover:bg-slate-50 rounded cursor-pointer';
        gDiv.innerHTML = `
            <input type="checkbox" class="cb-gtin-col rounded text-indigo-600 focus:ring-indigo-500" value="${h}">
            <span class="font-mono">${h}</span>
        `;
        gContainer.appendChild(gDiv);
    });
}

function autoSuggestMapping() {
    if (!uploadedImportHeaders || uploadedImportHeaders.length === 0) return;

    const findBestHeader = (keywords) => {
        for (const kw of keywords) {
            const match = uploadedImportHeaders.find(h => {
                const low = h.toLowerCase().trim();
                return low === kw.toLowerCase() || low.includes(kw.toLowerCase());
            });
            if (match) return match;
        }
        return '';
    };

    const codeCol = findBestHeader(['internal reference', 'item code', 'product code', 'كود الصنف', 'رمز الصنف', 'code', 'default_code', 'reference', 'sequence']);
    const arCol = findBestHeader(['name (ar)', 'name_ar', 'الاسم بالعربي', 'اسم عربي', 'اسم الصنف عربي', 'عربي']);
    const enCol = findBestHeader(['name (en)', 'name_en', 'name', 'product_name', 'اسم الصنف', 'اسم المنتج', 'english', 'description']);
    const sciCol = findBestHeader(['scientific name', 'scientific_name', 'scientific', 'الاسم العلمي', 'المادة الفعالة']);
    const compCol = findBestHeader(['company', 'manufacturer', 'الشركة', 'المصنع', 'الشركة المصنعة', 'المورد']);
    const catCol = findBestHeader(['category', 'product category', 'تصنيف', 'التصنيف', 'النوع', 'القسم']);
    const sPriceCol = findBestHeader(['sales price', 'sale_price', 'selling_price', 'price', 'سعر البيع', 'سعر']);
    const uPriceCol = findBestHeader(['cost price', 'unit price', 'unit cost', 'purchase price', 'unit_price', 'unitprice', 'cost', 'سعر التكلفة', 'سعر الوحدة', 'التكلفة']);
    const wsCol = findBestHeader(['wholesale price', 'wholesale_price', 'wholesale', 'سعر الجملة', 'جملة']);
    const taxCol = findBestHeader(['customer tax', 'customer_tax', 'customer taxes', 'customer_taxes', 'customertax', 'customertaxes', 'tax rate', 'vat', 'tax', 'taxes', 'ضريبة', 'الضريبة']);
    const unitCol = findBestHeader(['unit', 'وحدة']);
    const groupCol = codeCol || findBestHeader(['sequence', 'internal reference', 'code', 'default_code', 'كود الصنف', 'رمز الصنف']);

    if (codeCol && document.getElementById('map-code')) document.getElementById('map-code').value = codeCol;
    if (arCol) document.getElementById('map-name-ar').value = arCol;
    if (enCol) document.getElementById('map-name-en').value = enCol;
    if (sciCol && document.getElementById('map-scientific-name')) document.getElementById('map-scientific-name').value = sciCol;
    if (compCol && document.getElementById('map-company')) document.getElementById('map-company').value = compCol;
    if (catCol) document.getElementById('map-category').value = catCol;
    if (sPriceCol) document.getElementById('map-selling-price').value = sPriceCol;
    if (uPriceCol) document.getElementById('map-unit-price').value = uPriceCol;
    if (wsCol && document.getElementById('map-wholesale-price')) document.getElementById('map-wholesale-price').value = wsCol;
    // ربط عمود الضريبة تلقائياً إذا كان موجوداً بالملف (مثل CUSTOMER TAX)
    if (taxCol && document.getElementById('map-tax-rate')) document.getElementById('map-tax-rate').value = taxCol;
    if (unitCol) document.getElementById('map-unit').value = unitCol;
    if (groupCol) document.getElementById('map-grouping').value = groupCol;

    document.querySelectorAll('.cb-barcode-col').forEach(cb => {
        const val = cb.value.toLowerCase();
        cb.checked = val.includes('barcode') || val.includes('باركود') || val.includes('ean');
    });

    document.querySelectorAll('.cb-gtin-col').forEach(cb => {
        const val = cb.value.toLowerCase();
        cb.checked = val.includes('gtin');
    });

    alert('تم اقتراح وتعبئة الأعمدة المطابقة تلقائياً! يمكنك تعديل أي خانة يدوياً قبل المعاينة.');
}

function getSelectedMapping() {
    const barcodeCols = Array.from(document.querySelectorAll('.cb-barcode-col:checked')).map(el => el.value);
    const gtinCols = Array.from(document.querySelectorAll('.cb-gtin-col:checked')).map(el => el.value);

    return {
        code_col: document.getElementById('map-code')?.value || '',
        name_ar_col: document.getElementById('map-name-ar')?.value || '',
        name_en_col: document.getElementById('map-name-en')?.value || '',
        scientific_name_col: document.getElementById('map-scientific-name')?.value || '',
        company_col: document.getElementById('map-company')?.value || '',
        category_col: document.getElementById('map-category')?.value || '',
        selling_price_col: document.getElementById('map-selling-price')?.value || '',
        unit_price_col: document.getElementById('map-unit-price')?.value || '',
        wholesale_price_col: document.getElementById('map-wholesale-price')?.value || '',
        tax_rate_col: document.getElementById('map-tax-rate')?.value || '',
        unit_col: document.getElementById('map-unit')?.value || '',
        unit_divisions_col: document.getElementById('map-unit-divisions')?.value || '',
        grouping_col: document.getElementById('map-grouping')?.value || '',
        barcode_cols: barcodeCols,
        gtin_cols: gtinCols
    };
}

async function executeImportPreview() {
    const mapping = getSelectedMapping();
    if (!mapping.name_ar_col && !mapping.name_en_col) {
        alert('يُرجى اختيار عمود الاسم العربي أو الإنجليزي على الأقل لإتمام الربط.');
        return;
    }

    const replace_barcodes = document.getElementById('rad-barcode-mode-replace')?.checked || false;
    // الافتراضي: إضافة الأصناف الجديدة فقط، والموجود لا يتغير (إلا لو اخترت تحديث الموجود)
    const update_existing = document.getElementById('chk-import-update-existing')?.checked || false;

    const btn = document.getElementById('btn-preview-import');
    btn.disabled = true;
    btn.textContent = 'جاري التحقق والمعاينة...';

    try {
        const res = await fetch('/api/catalog/preview-import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_id: uploadedImportFileId,
                mapping,
                replace_barcodes,
                update_existing
            })
        });
        const data = await res.json();
        if (data.success) {
            renderImportPreview(data);
        } else {
            alert(data.message || 'فشلت المعاينة');
        }
    } catch (e) {
        alert('خطأ أثناء المعاينة: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>🔍</span><span>معاينة الاستيراد والتحقق من التعارضات</span>';
    }
}

function renderImportPreview(data) {
    document.getElementById('import-step-mapping')?.classList.add('hidden');
    document.getElementById('import-step-preview')?.classList.remove('hidden');

    document.getElementById('prev-total-file-rows').textContent = (data.total_file_rows || 0).toLocaleString();
    if (document.getElementById('prev-updates-count')) {
        // وضع "إضافة الجديد فقط": الأصناف الموجودة بتتعرض كعدد اللي هيفضل زي ما هو
        const lbl = document.getElementById('prev-updates-label');
        if (data.only_new) {
            if (lbl) lbl.textContent = 'أصناف موجودة بالفعل (مش هتتغير)';
            document.getElementById('prev-updates-count').textContent = (data.existing_count || 0).toLocaleString();
        } else {
            if (lbl) lbl.textContent = 'تحديث أصناف موجودة';
            document.getElementById('prev-updates-count').textContent = (data.updates_count || 0).toLocaleString();
        }
    }
    document.getElementById('prev-valid-count').textContent = (data.new_count != null ? data.new_count : data.valid_products_count || 0).toLocaleString();
    document.getElementById('prev-conflicts-count').textContent = (data.conflicts_count || 0).toLocaleString();
    document.getElementById('prev-skipped-count').textContent = (data.skipped_count || 0).toLocaleString();

    const tbody = document.getElementById('prev-items-tbody');
    tbody.innerHTML = '';

    (data.preview_items || []).forEach(it => {
        const tr = document.createElement('tr');
        tr.className = 'hover:bg-slate-50 text-center';
        const opBadge = it.is_update 
            ? `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-200">تحديث صنف</span>`
            : `<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">صنف جديد</span>`;
        tr.innerHTML = `
            <td class="p-2 text-center font-mono font-bold text-indigo-700 bg-indigo-50/40">${it.system_code_preview || '-'}</td>
            <td class="p-2 text-center">${opBadge}</td>
            <td class="p-2 text-left font-sans font-bold text-slate-800">${it.name_en || '-'}</td>
            <td class="p-2 text-right text-slate-600">${it.name_ar || '-'}</td>
            <td class="p-2 text-center font-mono font-bold text-emerald-700">${parseFloat(it.selling_price || 0).toFixed(2)}</td>
            <td class="p-2 text-right font-mono text-[11px]">${(it.barcode_list || []).join(', ') || '-'}</td>
            <td class="p-2 text-right font-mono text-[11px] text-indigo-700">${(it.gtin_list || []).map(g => extractCleanGtin(g)).join(', ') || '-'}</td>
        `;
        tbody.appendChild(tr);
    });

    // تقرير الفروقات (Old vs New Diff) للأصناف الموجودة
    const diffContainer = document.getElementById('prev-diff-container');
    const diffList = document.getElementById('prev-diff-list');
    const diffBadge = document.getElementById('prev-diff-count-badge');
    if (diffList) {
        diffList.innerHTML = '';
        const itemsWithDiff = (data.preview_items || []).filter(it => it.is_update && it.diff && Object.keys(it.diff).length > 0);
        if (diffBadge) diffBadge.textContent = `${itemsWithDiff.length} صنف معدل`;

        if (itemsWithDiff.length > 0) {
            diffContainer?.classList.remove('hidden');
            const fieldNamesMap = {
                name_ar: 'الاسم العربي',
                name_en: 'الاسم الإنجليزي',
                scientific_name: 'الاسم العلمي',
                company: 'الشركة',
                category: 'التصنيف',
                selling_price: 'سعر البيع',
                cost_price: 'سعر التكلفة',
                wholesale_price: 'سعر الجملة',
                tax_rate: 'نسبة الضريبة',
                unit: 'الوحدة',
                unit_divisions: 'معامل التحويل',
                barcodes: 'الباركودات',
                gtins: 'أرقام GTIN'
            };

            itemsWithDiff.slice(0, 50).forEach(it => {
                const card = document.createElement('div');
                card.className = 'p-2 bg-white rounded-lg border border-blue-200 shadow-sm space-y-1';

                const diffItemsHtml = Object.entries(it.diff).map(([fKey, change]) => {
                    const label = fieldNamesMap[fKey] || fKey;
                    const oldVal = change.old != null ? (Array.isArray(change.old) ? change.old.join(', ') : change.old) : '-';
                    const newVal = change.new != null ? (Array.isArray(change.new) ? change.new.join(', ') : change.new) : '-';
                    return `<span class="inline-block bg-slate-50 border border-slate-200 rounded px-1.5 py-0.5 text-[10px] text-slate-700">
                        <strong>${label}:</strong> <span class="text-rose-600 line-through">${oldVal || '(فارغ)'}</span> ➔ <span class="text-emerald-700 font-bold">${newVal || '(فارغ)'}</span>
                    </span>`;
                }).join(' ');

                card.innerHTML = `
                    <div class="flex items-center justify-between text-xs">
                        <span class="font-mono font-bold text-indigo-700">${it.system_code_preview || it.code}</span>
                        <span class="font-bold text-slate-800 text-[11px]">${it.name_en || it.name_ar}</span>
                    </div>
                    <div class="flex flex-wrap gap-1 mt-1">
                        ${diffItemsHtml}
                    </div>
                `;
                diffList.appendChild(card);
            });

            if (itemsWithDiff.length > 50) {
                const more = document.createElement('p');
                more.className = 'text-center text-[10px] text-slate-500 font-bold';
                more.textContent = `... بالإضافة إلى ${itemsWithDiff.length - 50} صنف معدل آخر.`;
                diffList.appendChild(more);
            }
        } else {
            diffList.innerHTML = '<p class="text-slate-500 text-center py-2 text-xs">لا توجد حقول سيتم تعديلها للأصناف القائمة (لا توجد فروقات أو كل الحقول متطابقة أو أصناف جديدة).</p>';
        }
    }

    const skippedContainer = document.getElementById('prev-skipped-container');
    const skippedList = document.getElementById('prev-skipped-list');
    skippedList.innerHTML = '';

    const skipped = data.skipped_rows || [];
    if (skipped.length > 0) {
        skippedContainer.classList.remove('hidden');
        skipped.slice(0, 50).forEach(s => {
            const li = document.createElement('li');
            li.innerHTML = `<strong>الصف ${s.row_number}:</strong> ${s.reason}`;
            skippedList.appendChild(li);
        });
        if (skipped.length > 50) {
            const li = document.createElement('li');
            li.className = 'font-bold';
            li.textContent = `... بالإضافة إلى ${skipped.length - 50} صفوف أخرى.`;
            skippedList.appendChild(li);
        }
    } else {
        skippedContainer.classList.add('hidden');
    }
}

async function executeImportCommit() {
    const mapping = getSelectedMapping();
    const replace_barcodes = document.getElementById('rad-barcode-mode-replace')?.checked || false;
    // الافتراضي: إضافة الأصناف الجديدة فقط، والموجود لا يتغير (إلا لو اخترت تحديث الموجود)
    const update_existing = document.getElementById('chk-import-update-existing')?.checked || false;
    const btn = document.getElementById('btn-commit-import');
    btn.disabled = true;
    btn.textContent = 'جاري الحفظ والتحديث المجمع في قاعدة البيانات...';

    try {
        const res = await fetch('/api/catalog/commit-import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file_id: uploadedImportFileId,
                mapping,
                replace_barcodes,
                update_existing
            })
        });
        const data = await res.json();
        if (data.success) {
            document.getElementById('import-step-preview')?.classList.add('hidden');
            document.getElementById('import-step-report')?.classList.remove('hidden');

            document.getElementById('report-title').textContent = data.message || `تم استيراد ومعالجة ${data.imported_count} صنف بنجاح!`;
            document.getElementById('report-summary').textContent = (data.products_before != null
                ? `كارت الصنف كان ${Number(data.products_before).toLocaleString()} صنف ← اتضاف ${(data.new_count || 0).toLocaleString()} صنف جديد ← بقى ${Number(data.products_after).toLocaleString()} صنف. `
                : '') + `تم فحص ${data.total_file_rows} صفاً، تحديث ${data.updated_count || 0} صنف موجود، الأصناف الموجودة اللي متغيرتش: ${data.skipped_existing_count || 0}، الصفوف المتخطاة: ${data.skipped_count}. مفيش أي صنف اتمسح.`;
            refreshSystemStats();
            loadCatalogProducts();
            await loadActiveDraftInvoice();
        } else {
            alert(data.message || 'فشل الاستيراد والتحديث.');
        }
    } catch (e) {
        alert('خطأ أثناء الاستيراد: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.innerHTML = '<span>✅</span><span>تأكيد الاستيراد وحفظ بطاقات الأصناف</span>';
    }
}

function resetImportWizard() {
    uploadedImportFileId = null;
    uploadedImportHeaders = [];
    document.getElementById('import-file-input').value = '';
    
    document.getElementById('import-dropzone').innerHTML = `
        <div class="flex flex-col items-center pointer-events-none">
            <span class="text-4xl mb-2">📊</span>
            <p class="text-sm font-bold text-slate-700">اضغط هنا أو اسحب وأفلت ملف إكسيل الأصناف (.xlsx)</p>
            <p class="text-xs text-slate-400 mt-1">يدعم ملفات الأصناف الضخمة حتى مئات الآلاف من الصفوف</p>
        </div>
    `;

    document.getElementById('import-step-upload')?.classList.remove('hidden');
    document.getElementById('import-step-mapping')?.classList.add('hidden');
    document.getElementById('import-step-preview')?.classList.add('hidden');
    document.getElementById('import-step-report')?.classList.add('hidden');
}

// ==================== تبويب 4: سجل الفواتير والإرجاعات ====================
function initInvoicesTab() {
    document.getElementById('btn-refresh-invoices-list')?.addEventListener('click', loadInvoicesList);
    document.getElementById('btn-process-return')?.addEventListener('click', executeReturnProcess);
}

async function loadInvoicesList() {
    const tbody = document.getElementById('invoices-list-tbody');
    const hadPreviousRows = tbody && tbody.querySelectorAll('tr[data-inv-row="1"]').length > 0;
    if (!hadPreviousRows && tbody) {
        tbody.innerHTML = '<tr><td colspan="8" class="py-8 text-center text-slate-400">جاري تحميل الفواتير...</td></tr>';
    }

    try {
        const res = await fetch('/api/invoices/list', { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (isUnavailableApiResponse(res, data) || data.success === false) {
            if (!hadPreviousRows && tbody) {
                tbody.innerHTML = '<tr><td colspan="8" class="py-8 text-center text-amber-600 font-bold">⏳ جاري تجديد الاتصال بالسيرفر المحلي... بياناتك محفوظة بأمان</td></tr>';
            }
            return;
        }
        const invoices = data.invoices || [];

        if (invoices.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" class="py-8 text-center text-slate-400">لا توجد فواتير مسجلة حتى الآن</td></tr>';
            return;
        }

        tbody.innerHTML = '';
        invoices.forEach(inv => {
            const tr = document.createElement('tr');
            tr.setAttribute('data-inv-row', '1');
            tr.className = 'hover:bg-slate-50 transition text-center';

            const isConf = (inv.status === 'confirmed');
            const statusHtml = isConf ?
                '<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800">معتمدة</span>' :
                '<span class="px-2 py-0.5 rounded-full text-[11px] font-bold bg-amber-100 text-amber-800">مسودة</span>';

            tr.innerHTML = `
                <td class="py-3 px-4 font-mono font-bold text-indigo-700">${inv.invoice_number}</td>
                <td class="py-3 px-3 font-mono">${inv.invoice_date}</td>
                <td class="py-3 px-3">${statusHtml}</td>
                <td class="py-3 px-3 font-mono">${inv.total_items}</td>
                <td class="py-3 px-3 font-mono font-bold">${inv.total_packages}</td>
                <td class="py-3 px-3 font-mono font-bold text-emerald-700">${parseFloat(inv.total_amount || 0).toFixed(2)} ر.س</td>
                <td class="py-3 px-3">${inv.user_name || 'المسؤول'}</td>
                <td class="py-3 px-4">
                    <div class="flex items-center justify-center gap-1.5 flex-wrap">
                        <button class="btn-open-invoice px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded text-xs font-bold" data-id="${inv.id}">
                            فتح 👁️
                        </button>
                        <button class="btn-export-inv-history px-2.5 py-1 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded text-xs font-bold" data-id="${inv.id}" data-num="${inv.invoice_number}" title="سحب الإكسيل الأول (الفاتورة)">
                            Excel 1 📊
                        </button>
                        <button class="btn-export-inv-stock-history px-2.5 py-1 bg-teal-50 hover:bg-teal-100 text-teal-700 border border-teal-200 rounded text-xs font-bold" data-id="${inv.id}" data-num="${inv.invoice_number}" title="سحب الإكسيل الثاني (Product / Counted quantity)">
                            Excel 2 📊
                        </button>
                        <button class="btn-print-inv-history px-2.5 py-1 bg-slate-800 hover:bg-slate-900 text-white rounded text-xs font-bold" data-id="${inv.id}" title="طباعة الفاتورة">
                            طباعة 🖨️
                        </button>
                    </div>
                </td>
            `;
            tbody.appendChild(tr);
        });

        document.querySelectorAll('.btn-print-inv-history').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-id');
                try {
                    const res = await fetch(`/api/invoices/get?id=${id}`);
                    const data = await res.json();
                    if (data.success && data.invoice) {
                        window.openPrePrintModal(data.invoice);
                    }
                } catch (e) {
                    alert('فشل جلب بيانات الفاتورة للطباعة: ' + e.message);
                }
            });
        });

        document.querySelectorAll('.btn-open-invoice').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.getAttribute('data-id');
                try {
                    const res = await fetch(`/api/invoices/get?id=${id}`);
                    const data = await res.json();
                    if (data.success && data.invoice) {
                        renderInvoice(data.invoice);
                        switchTab('scanner');
                    }
                } catch (e) {
                    alert('فشل فتح الفاتورة: ' + e.message);
                }
            });
        });

        document.querySelectorAll('.btn-export-inv-history').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                const id = btn.getAttribute('data-id');
                const num = btn.getAttribute('data-num') || 'INV';
                showCatalogToast('📊 جاري سحب الإكسيل الأول وحفظ الملف وفتحه في Excel...');
                await window.downloadAndTriggerSave(`/api/invoice/export-excel?id=${id}`, `Invoice_${num}.xlsx`);
            });
        });

        document.querySelectorAll('.btn-export-inv-stock-history').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                const id = btn.getAttribute('data-id');
                const num = btn.getAttribute('data-num') || 'INV';
                showCatalogToast('📊 جاري سحب الإكسيل الثاني (Counted quantity) وحفظ الملف وفتحه في Excel...');
                await window.downloadAndTriggerSave(`/api/invoice/export-stock-excel?id=${id}`, `StockCount_${num}.xlsx`);
            });
        });

    } catch (e) {
        tbody.innerHTML = `<tr><td colspan="8" class="py-8 text-center text-rose-500">حدث خطأ: ${e.message}</td></tr>`;
    }
}

async function executeReturnProcess() {
    const snInput = document.getElementById('return-serial-input');
    const invInput = document.getElementById('return-inv-input');
    const reasonInput = document.getElementById('return-reason-input');

    const serial_number = snInput?.value.trim();
    const invoice_number = invInput?.value.trim();
    const reason = reasonInput?.value.trim();

    if (!serial_number) {
        alert('يُرجى إدخال رقم السيريال المراد إرجاعه.');
        return;
    }
    if (!reason) {
        alert('يُرجى توضيح سبب الإرجاع.');
        return;
    }

    try {
        const res = await fetch('/api/returns/process', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                serial_number,
                invoice_number,
                reason,
                user_name: 'المسؤول'
            })
        });
        const data = await res.json();
        if (data.success) {
            alert(data.message);
            if (snInput) snInput.value = '';
            if (invInput) invInput.value = '';
            if (reasonInput) reasonInput.value = '';
            loadInvoicesList();
            refreshSystemStats();
        } else {
            alert(data.message || 'فشلت معالجة الإرجاع.');
        }
    } catch (e) {
        alert('خطأ أثناء المعالجة: ' + e.message);
    }
}


// =========================================================================
// نظام إدارة الاستورات والجرد الفعلي ومطابقة التكلفة (ABO KHAIRY PHARMACY SYSTEM)
// =========================================================================

let currentActiveStoreNo = localStorage.getItem('agy_active_store_no') || 'ST-001';
window.RambfeActiveStore = () => currentActiveStoreNo;
let currentActiveStoreName = localStorage.getItem('agy_active_store_name') || 'الاستور الرئيسي';
let stockAudioCtx = null;
let stockStoresSearchTimer = null;
let stockItemsSearchTimer = null;

function playStockAudioAlert(isSuccess = true) {
    try {
        if (!stockAudioCtx) {
            stockAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (stockAudioCtx.state === 'suspended') {
            stockAudioCtx.resume();
        }
        const osc = stockAudioCtx.createOscillator();
        const gain = stockAudioCtx.createGain();
        osc.connect(gain);
        gain.connect(stockAudioCtx.destination);

        if (isSuccess) {
            osc.frequency.setValueAtTime(880, stockAudioCtx.currentTime);
            gain.gain.setValueAtTime(0.15, stockAudioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, stockAudioCtx.currentTime + 0.12);
            osc.start();
            osc.stop(stockAudioCtx.currentTime + 0.12);
        } else {
            osc.frequency.setValueAtTime(320, stockAudioCtx.currentTime);
            gain.gain.setValueAtTime(0.3, stockAudioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.01, stockAudioCtx.currentTime + 0.35);
            osc.start();
            osc.stop(stockAudioCtx.currentTime + 0.35);
        }
    } catch (e) {
        // Audio error ignore
    }
}

let selectedStockEntryIds = new Set();
let currentStoreItemsCache = [];

function initStocktakeTab() {
    const btnNewStore = document.getElementById('btn-stk-new-store');
    const inputNewStore = document.getElementById('stk-new-store-input');
    const btnLoadAll = document.getElementById('btn-stk-load-all');
    const storesSearch = document.getElementById('stk-stores-search');

    const scanInput = document.getElementById('stk-scan-input');
    const itemsSearch = document.getElementById('stk-items-search-filter');

    const btnUpload = document.getElementById('btn-stk-upload-excel');
    const fileUpload = document.getElementById('stk-upload-excel-file');
    const btnClearInventory = document.getElementById('btn-stk-clear-inventory');
    const btnExport = document.getElementById('btn-stk-export-excel');
    const btnPrint = document.getElementById('btn-stk-print');
    const btnSettle = document.getElementById('btn-stk-settle');
    const btnClear = document.getElementById('btn-stk-clear');

    const chkAll = document.getElementById('stk-items-chk-all');
    const btnBulkDelete = document.getElementById('btn-stk-bulk-delete');
    const btnClearSelection = document.getElementById('btn-stk-clear-item-selection');

    // أزرار نافذة تعديل بيانات بند الجرد
    const modalEdit = document.getElementById('modal-edit-stock-item');
    const btnCloseEdit = document.getElementById('btn-close-edit-stock-item');
    const btnCancelEdit = document.getElementById('btn-cancel-edit-stock-item');
    const btnSaveEdit = document.getElementById('btn-save-edit-stock-item');

    // 1. إنشاء استور جديد (بالزر أو بضغط Enter)
    const handleCreateNewStore = async () => {
        const name = inputNewStore?.value?.trim();
        if (!name) {
            alert('يُرجى إدخال اسم الاستور أولاً.');
            inputNewStore?.focus();
            return;
        }
        try {
            const res = await fetch('/api/stock/stores/create', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ store_name: name, branch_name: 'الفرع الرئيسي' })
            });
            const data = await res.json();
            if (data.success) {
                inputNewStore.value = '';
                showCatalogToast?.(`✅ تم إنشاء وحفظ الاستور: ${data.store_name} (${data.store_no})`);
                await loadStocktakeStores();
                selectActiveStockStore(data.store_no, data.store_name);
                setTimeout(() => document.getElementById('stk-scan-input')?.focus(), 150);
            } else {
                alert('فشل إنشاء الاستور: ' + (data.message || ''));
            }
        } catch (e) {
            alert('خطأ: ' + e.message);
        }
    };

    btnNewStore?.addEventListener('click', handleCreateNewStore);

    inputNewStore?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleCreateNewStore();
        }
    });

    btnLoadAll?.addEventListener('click', () => {
        if (storesSearch) storesSearch.value = '';
        loadStocktakeStores();
    });

    // 2. البحث في الاستورات بنفس طريقة البرنامج
    storesSearch?.addEventListener('input', () => {
        clearTimeout(stockStoresSearchTimer);
        stockStoresSearchTimer = setTimeout(() => {
            loadStocktakeStores(storesSearch.value.trim());
        }, 250);
    });

    // 3. البحث الذكي الموحد (نفس محرك كرت الصنف) + مسح الباركود و QR في شاشة الجرد
    initStocktakeCatalogSearch();

    document.getElementById('btn-close-batch-entry-card')?.addEventListener('click', closeBatchEntryCard);
    document.getElementById('btn-add-extra-batch-row')?.addEventListener('click', addExtraBatchRowToCard);
    document.getElementById('btn-finish-batch-entry')?.addEventListener('click', async () => {
        const tbody = document.getElementById('stk-bec-batches-tbody');
        const inputs = Array.from(tbody?.querySelectorAll('.stk-bec-qty-input') || []);
        await commitAllCardBatches(inputs);
    });
    document.getElementById('btn-submit-batch-entry-main')?.addEventListener('click', async () => {
        const tbody = document.getElementById('stk-bec-batches-tbody');
        const inputs = Array.from(tbody?.querySelectorAll('.stk-bec-qty-input') || []);
        await commitAllCardBatches(inputs);
    });

    // حماية تمنع نزول المؤشر إلى خانة البحث عند أصناف الاستور المسحوبة إذا كان كارت الباتشات مفتوحاً
    itemsSearch?.addEventListener('focus', (e) => {
        const card = document.getElementById('stk-batch-entry-card');
        if (card && !card.classList.contains('hidden')) {
            e.preventDefault();
            const activeInput = document.querySelector('.stk-bec-qty-input:focus') ||
                                document.querySelector('.stk-bec-qty-input');
            if (activeInput) {
                activeInput.focus();
                activeInput.select();
            }
        }
    });

    // 4. الخانة الثانية المستقلة: البحث داخل الاستور المختار فقط (تجميع الكميات المعدودة + حالة لم يُجرد بعد)
    updateStkStoreSearchModeUI();
    document.getElementById('btn-stk-store-search-mode')?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isStkStoreSearchGeneralized = !isStkStoreSearchGeneralized;
        localStorage.setItem('stk_store_search_mode', isStkStoreSearchGeneralized ? 'contains' : 'start');
        updateStkStoreSearchModeUI();
        const curQ = (itemsSearch?.value || '').replace(/^\s+/, '');
        loadCurrentStoreItems(curQ);
        itemsSearch?.focus();
    });

    const handleItemsSearchExecute = () => {
        clearTimeout(stockItemsSearchTimer);
        const q = (itemsSearch?.value || '').replace(/^\s+/, '');
        loadCurrentStoreItems(q);
    };

    itemsSearch?.addEventListener('input', () => {
        clearTimeout(stockItemsSearchTimer);
        stockItemsSearchTimer = setTimeout(() => {
            loadCurrentStoreItems((itemsSearch?.value || '').replace(/^\s+/, ''));
        }, 180);
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
    });

    // 5. رفع رصيد المخزون للاستور النشط
    btnUpload?.addEventListener('click', () => fileUpload?.click());
    fileUpload?.addEventListener('change', async (e) => {
        const file = e.target.files?.[0];
        if (!file) return;

        const feedback = document.getElementById('stk-feedback-text');
        if (feedback) feedback.textContent = `جاري رفع واحتساب رصيد المخزون للاستور (${currentActiveStoreNo})...`;

        try {
            // قراءة الملف في المتصفح ورفعه على دفعات للسحابة (يعمل من الرابط بدون الكمبيوتر)
            let data;
            try {
                data = await window.RambfeProfiles.uploadStockFile(file, currentActiveStoreNo, (done, total) => {
                    if (feedback) feedback.textContent = `جاري رفع المخزون للاستور (${currentActiveStoreNo})... ${done} / ${total} سطر`;
                });
            } catch (upErr) {
                data = { success: false, message: upErr.message };
            }
            if (data.success) {
                alert(data.message || 'تم رفع المخزون واحتساب التكلفة وسعر البيع بنجاح.');
                await loadStocktakeStores();
                if (data.store_details) {
                    renderCurrentStoreDetails(data.store_details);
                }
            } else {
                alert('فشل الرفع: ' + (data.message || ''));
            }
        } catch (err) {
            alert('خطأ: ' + err.message);
        } finally {
            fileUpload.value = '';
            scanInput?.focus();
        }
    });

    // 5.ج إدراج كامل المخزون بجميع باتشاته في جدول الجرد
    const btnPopulateAll = document.getElementById('btn-stk-populate-inventory');
    btnPopulateAll?.addEventListener('click', async () => {
        if (!confirm(`هل تريد إدراج جميع أصناف وباتشات المخزون المسجلة للاستور (${currentActiveStoreNo}) في جدول الجرد دفعة واحدة؟`)) {
            return;
        }
        try {
            const res = await fetch('/api/stock/populate-all', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ store_no: currentActiveStoreNo })
            });
            const data = await res.json();
            if (data.success) {
                alert(data.message || 'تم إدراج البنود بنجاح.');
                if (data.store_details) {
                    renderCurrentStoreDetails(data.store_details);
                }
                await loadStocktakeStores();
            } else {
                alert('فشل الإدراج: ' + (data.message || ''));
            }
        } catch (e) {
            alert('خطأ: ' + e.message);
        }
        scanInput?.focus();
    });

    // 5.ب حذف وتصفير رصيد المخزون الدفتري المرفوع
    btnClearInventory?.addEventListener('click', async () => {
        const storeName = currentActiveStoreName || currentActiveStoreNo;
        if (!confirm(`هل أنت متأكد من رغبتك في حذف وتصفيد رصيد المخزون السابق بالكامل للاستور (${storeName}) حتى تتمكن من رفع ملف مخزون جديد؟`)) {
            return;
        }

        // سابقاً كان سؤال "كل الاستورات؟" يأتي بعد التأكيد مباشرة، وضغطة [موافق] كانت تصفّر مخزون كل الاستورات.
        // الآن: الافتراضي هذا الاستور فقط، وكل الاستورات تحتاج كتابة كلمة التأكيد.
        let clearAll = false, confirmText = '';
        if (confirm(`هل تريد حذف المخزون الدفتري لكل الاستورات بدلاً من (${storeName}) فقط؟\n\n[إلغاء] = هذا الاستور فقط (الأأمن)\n• الكميات المجرودة لا تُمسح في الحالتين.\n• لا داعي للحذف قبل رفع ملف جديد: الرفع يستبدل مخزون الاستور تلقائياً.`)) {
            confirmText = window.RambfeProfiles.confirmTyped('سيتم حذف رصيد المخزون الدفتري لكل الاستورات (الكميات المجرودة لن تُمسح).');
            if (!confirmText) return;
            clearAll = true;
        }

        try {
            const res = await fetch('/api/stock/clear-inventory', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    store_no: clearAll ? 'ALL' : currentActiveStoreNo,
                    clear_all: clearAll,
                    confirm_text: confirmText
                })
            });
            const data = await res.json();
            if (data.success) {
                if (typeof showCatalogToast === 'function') {
                    showCatalogToast(data.message || 'تم حذف رصيد المخزون بنجاح');
                }
                alert(data.message || 'تم حذف رصيد المخزون السابق بنجاح.');
                await loadStocktakeStores();
                await loadCurrentStoreItems();
                if (data.store_details) {
                    renderCurrentStoreDetails(data.store_details);
                }
            } else {
                alert('فشل: ' + (data.message || ''));
            }
        } catch (err) {
            alert('خطأ أثناء حذف المخزون: ' + err.message);
        }
        scanInput?.focus();
    });

    // 6. سحب Excel للاستور المختار مباشرة دون أي نوافذ منبثقة، مع الحفظ الفوري والفتح التلقائي في Excel
    btnExport?.addEventListener('click', async () => {
        const title = currentActiveStoreName ? currentActiveStoreName : currentActiveStoreNo;
        const defaultName = `StockCount_${currentActiveStoreNo}_${title}.xlsx`;
        const stkLoc = document.getElementById('select-stocktake-export-location')?.value || (window.getSelectedExportLocation ? window.getSelectedExportLocation() : 'PH004/Stock');
        const qs = new URLSearchParams({
            store_no: currentActiveStoreNo,
            title: title
        });
        if (stkLoc && stkLoc !== '__SHEET_NAME__') qs.set('location_val', stkLoc);
        const url = `/api/stock/export-excel?${qs.toString()}`;
        showCatalogToast(`📊 جاري سحب الإكسيل وحفظ الملف (الفرع: ${stkLoc || 'بدون'})...`);
        await window.downloadAndTriggerSave(url, defaultName);
        scanInput?.focus();
    });

    // 7. طباعة تقرير الجرد للاستور مباشرة وفوراً (يفتح فاتورة الجرد فوراً مع مسمى الاستور ولوجو البرنامج في كل صفحة)
    btnPrint?.addEventListener('click', () => {
        const title = currentActiveStoreName ? `${currentActiveStoreName}` : currentActiveStoreNo;
        printStoreStocktakeView(title);
    });

    // 7.ب فتح ملف واستعراض تقرير الأصناف التي لم تُجرد مع خاصية البحث والطباعة
    const btnPrintUncounted = document.getElementById('btn-stk-print-uncounted');
    btnPrintUncounted?.addEventListener('click', () => {
        openUncountedItemsModal(currentActiveStoreNo || 'ST-001');
    });

    // 7.ج طباعة تقرير الأصناف غير المجرودة بالأقسام مباشرة
    const btnPrintUncountedCat = document.getElementById('btn-stk-print-uncounted-cat');
    btnPrintUncountedCat?.addEventListener('click', () => {
        printUncountedItemsView(true);
    });

    // 7.د سحب إكسيل للأصناف التي لم تُجرد مباشرة مع الحفظ والفتح التلقائي
    const btnExportUncountedExcel = document.getElementById('btn-stk-export-uncounted-excel');
    btnExportUncountedExcel?.addEventListener('click', async () => {
        const storeNo = currentActiveStoreNo || 'ST-001';
        const title = `NOT_FOUND_${storeNo}`;
        const defaultName = `EstimatedNotFound_${storeNo}.xlsx`;
        const url = `/api/stock/uncounted/export-excel?store_no=${encodeURIComponent(storeNo)}&title=${encodeURIComponent(title)}`;
        showCatalogToast('📊 جاري سحب إكسيل الأصناف غير المجرودة وفتحه تلقائياً...');
        await window.downloadAndTriggerSave(url, defaultName);
    });

    // 8. اعتماد وترحيل الاستور الفردي
    btnSettle?.addEventListener('click', async () => {
        if (!confirm(`هل أنت متأكد من رغبتك في اعتماد وترحيل الجرد النهائي للاستور (${currentActiveStoreNo} - ${currentActiveStoreName})؟\n\nسيتم مسح الاستوك القديم واعتماد الفعلي الجديد.`)) {
            return;
        }
        try {
            const res = await fetch('/api/stock/settle', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ store_no: currentActiveStoreNo })
            });
            const data = await res.json();
            if (data.success) {
                alert(data.message || 'تم ترحيل واعتماد الجرد النهائي بنجاح ومسح القديم.');
                loadStocktakeStores();
                loadCurrentStoreItems();
            }
        } catch (e) {
            alert('خطأ: ' + e.message);
        }
        scanInput?.focus();
    });

    // 8.ب ترحيل وتعتماد جميع الاستورات أو المحددة (مسح القديم واعتماد الجديد)
    document.getElementById('btn-stk-commit-all-stores-global')?.addEventListener('click', () => commitAllStoresStocktake(true));
    document.getElementById('btn-stk-commit-all-stores-top')?.addEventListener('click', () => commitAllStoresStocktake(true));
    document.getElementById('btn-stk-commit-selected-stores')?.addEventListener('click', () => commitSelectedStoresStocktake());
    document.getElementById('btn-stk-select-all-stores-direct')?.addEventListener('click', selectAllCountedStores);
    document.getElementById('btn-stk-clear-stores-selection')?.addEventListener('click', clearCountedStoresSelection);
    document.getElementById('stk-counted-stores-chk-all')?.addEventListener('change', (e) => toggleCountedStoresChkAll(e.target.checked));

    // 8.ج التبديل بين تبويبات الاستورات المدمجة (استورات الجرد والترحيل vs دليل الاستورات المنشأة)
    const btnTabCounted = document.getElementById('tab-btn-counted-stores');
    const btnTabCreated = document.getElementById('tab-btn-created-stores');
    const panelCounted = document.getElementById('stk-panel-counted-stores');
    const panelCreated = document.getElementById('stk-panel-created-stores');

    function switchStoreTab(activeTab) {
        if (activeTab === 'counted') {
            btnTabCounted?.classList.add('bg-indigo-600', 'text-white', 'shadow');
            btnTabCounted?.classList.remove('bg-slate-100', 'text-slate-700', 'hover:bg-slate-200');
            btnTabCreated?.classList.remove('bg-indigo-600', 'text-white', 'shadow');
            btnTabCreated?.classList.add('bg-slate-100', 'text-slate-700', 'hover:bg-slate-200');
            panelCounted?.classList.remove('hidden');
            panelCreated?.classList.add('hidden');
        } else {
            btnTabCreated?.classList.add('bg-indigo-600', 'text-white', 'shadow');
            btnTabCreated?.classList.remove('bg-slate-100', 'text-slate-700', 'hover:bg-slate-200');
            btnTabCounted?.classList.remove('bg-indigo-600', 'text-white', 'shadow');
            btnTabCounted?.classList.add('bg-slate-100', 'text-slate-700', 'hover:bg-slate-200');
            panelCreated?.classList.remove('hidden');
            panelCounted?.classList.add('hidden');
        }
    }

    btnTabCounted?.addEventListener('click', () => switchStoreTab('counted'));
    btnTabCreated?.addEventListener('click', () => switchStoreTab('created'));

    // 9. تصفير جرد الاستور
    btnClear?.addEventListener('click', async () => {
        const confirmText = window.RambfeProfiles.confirmTyped(`سيتم تصفير جميع الأصناف المجرودة في الاستور (${currentActiveStoreNo}).\n(تُحفظ نسخة في سلة محذوفات الجرد ويمكن استرجاعها من شريط الصيدلية)`);
        if (!confirmText) return;
        try {
            const res = await fetch('/api/stock/clear', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ store_no: currentActiveStoreNo, confirm_text: confirmText })
            });
            const data = await res.json();
            if (!data.success) alert(data.message || 'لم يتم التصفير');
            if (data.success) {
                await loadStocktakeStores();
                if (data.store_details) {
                    renderCurrentStoreDetails(data.store_details);
                }
            }
        } catch (e) {
            alert('خطأ: ' + e.message);
        }
        scanInput?.focus();
    });

    const btnDeleteActiveStore = document.getElementById('btn-stk-delete-active-store');
    const btnResetAll = document.getElementById('btn-stk-reset-all');

    // 9.ب حذف الاستور النشط بالكامل بجميع بياناته
    btnDeleteActiveStore?.addEventListener('click', async () => {
        await deleteStoreBtn(currentActiveStoreNo, currentActiveStoreName);
    });

    // 9.ج مسح وتصفير كافة تجارب وبيانات الجرد بالكامل للبدء من الصفر
    btnResetAll?.addEventListener('click', async () => {
        const confirmText = window.RambfeProfiles.confirmTyped('⚠️ تحذير: سيتم مسح كل الاستورات والمخزون والجرد لهذه الصيدلية بالكامل.\n(الكميات المجرودة تُحفظ في سلة محذوفات الجرد)');
        if (!confirmText) return;
        try {
            const res = await fetch('/api/stock/reset-all', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirm_text: confirmText })
            });
            const data = await res.json();
            if (!data.success) alert(data.message || 'لم يتم التنفيذ');
            if (data.success) {
                alert(data.message || 'تم تصفير تجارب الجرد بنجاح.');
                currentActiveStoreNo = data.store_no || 'ST-001';
                currentActiveStoreName = data.store_name || 'الاستور الرئيسي';
                selectedStockEntryIds.clear();
                updateStockSelectionBar();
                await loadStocktakeStores();
                await loadCurrentStoreItems();
            }
        } catch (e) {
            alert('خطأ: ' + e.message);
        }
        scanInput?.focus();
    });

    // 10. تحديد الكل وإلغاء تحديد الكل
    chkAll?.addEventListener('change', (e) => {
        const isChecked = e.target.checked;
        const rowCheckboxes = document.querySelectorAll('.stk-row-chk');
        rowCheckboxes.forEach(cb => {
            cb.checked = isChecked;
            const id = parseInt(cb.dataset.id);
            if (isChecked) {
                selectedStockEntryIds.add(id);
            } else {
                selectedStockEntryIds.delete(id);
            }
        });
        updateStockSelectionBar();
    });

    // 11. حذف الأصناف المحددة دفعة واحدة
    btnBulkDelete?.addEventListener('click', async () => {
        if (selectedStockEntryIds.size === 0) {
            alert('لم يتم تحديد أي أصناف للحذف.');
            return;
        }
        if (!confirm(`هل أنت متأكد من حذف (${selectedStockEntryIds.size}) صنف محدد من الجرد؟`)) {
            return;
        }
        try {
            const res = await fetch('/api/stock/bulk-delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    entry_ids: Array.from(selectedStockEntryIds),
                    store_no: currentActiveStoreNo
                })
            });
            const data = await res.json();
            if (data.success) {
                selectedStockEntryIds.clear();
                updateStockSelectionBar();
                await loadStocktakeStores();
                if (data.store_details) {
                    renderCurrentStoreDetails(data.store_details);
                }
            } else {
                alert('فشل الحذف: ' + (data.message || ''));
            }
        } catch (e) {
            alert('خطأ: ' + e.message);
        }
        scanInput?.focus();
    });

    // 12. إلغاء تحديد الأصناف
    btnClearSelection?.addEventListener('click', () => {
        selectedStockEntryIds.clear();
        const rowCheckboxes = document.querySelectorAll('.stk-row-chk');
        rowCheckboxes.forEach(cb => cb.checked = false);
        if (chkAll) chkAll.checked = false;
        updateStockSelectionBar();
        scanInput?.focus();
    });

    // 13. حفظ التعديل من نافذة تعديل بيانات الصنف
    btnSaveEdit?.addEventListener('click', async () => {
        const entryId = parseInt(document.getElementById('modal-edit-entry-id')?.value || 0);
        if (!entryId) return;

        const qtyVal = parseFloat(document.getElementById('modal-edit-qty')?.value || 0);
        const batchVal = decodeArabicKeyboard(document.getElementById('modal-edit-batch')?.value?.trim() || '').toUpperCase();
        const expiryVal = document.getElementById('modal-edit-expiry')?.value?.trim() || '';
        const costVal = parseFloat(document.getElementById('modal-edit-cost')?.value || 0);
        const saleVal = parseFloat(document.getElementById('modal-edit-sale')?.value || 0);

        try {
            const res = await fetch('/api/stock/edit-item', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    entry_id: entryId,
                    store_no: currentActiveStoreNo,
                    updates: {
                        counted_qty: qtyVal,
                        batch_number: batchVal,
                        expiry_date: expiryVal,
                        cost_price: costVal,
                        selling_price: saleVal
                    }
                })
            });
            const data = await res.json();
            if (data.success) {
                modalEdit?.classList.add('hidden');
                await loadStocktakeStores();
                if (data.store_details) {
                    renderCurrentStoreDetails(data.store_details);
                }
            } else {
                alert('فشل التعديل: ' + (data.message || ''));
            }
        } catch (e) {
            alert('خطأ: ' + e.message);
        }
        scanInput?.focus();
    });

    const hideEditModal = () => {
        modalEdit?.classList.add('hidden');
        scanInput?.focus();
    };
    btnCloseEdit?.addEventListener('click', hideEditModal);
    btnCancelEdit?.addEventListener('click', hideEditModal);
}

function updateStockSelectionBar() {
    const bar = document.getElementById('stk-items-selection-bar');
    const badge = document.getElementById('stk-items-selected-count-badge');
    const chkAll = document.getElementById('stk-items-chk-all');

    const count = selectedStockEntryIds.size;
    if (badge) badge.textContent = count;

    if (count > 0) {
        bar?.classList.remove('hidden');
    } else {
        bar?.classList.add('hidden');
        if (chkAll) chkAll.checked = false;
    }
}

// فتح نافذة تعديل بيانات صنف الجرد
function openEditStockItemModal(entryId) {
    const item = currentStoreItemsCache.find(x => x.id === entryId);
    if (!item) return;

    const modal = document.getElementById('modal-edit-stock-item');
    const inputId = document.getElementById('modal-edit-entry-id');
    const subTitle = document.getElementById('modal-edit-item-subtitle');
    const inputQty = document.getElementById('modal-edit-qty');
    const inputBatch = document.getElementById('modal-edit-batch');
    const inputExpiry = document.getElementById('modal-edit-expiry');
    const inputCost = document.getElementById('modal-edit-cost');
    const inputSale = document.getElementById('modal-edit-sale');

    if (inputId) inputId.value = item.id;
    if (subTitle) subTitle.textContent = `${item.product_code} - ${item.product_name || ''}`;
    if (inputQty) inputQty.value = item.counted_qty;
    if (inputBatch) inputBatch.value = String(item.batch_number || '').toUpperCase();
    if (inputExpiry) inputExpiry.value = item.expiry_date || '';
    if (inputCost) inputCost.value = item.cost_price || 0;
    if (inputSale) inputSale.value = item.selling_price || 0;

    modal?.classList.remove('hidden');
    inputQty?.focus();
}

// تحميل قائمة الاستورات وتوزيعها على النصفين العلوي والسفلي والشريط الأوسط
async function loadStocktakeStores(searchQ = '') {
    try {
        const url = `/api/stock/stores?q=${encodeURIComponent(searchQ)}`;
        const res = await fetch(url, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (isUnavailableApiResponse(res, data) || data.success === false) {
            return;
        }

        // 1. تحديث الشريط الفاصل الأوسط بتفاصيل التكلفة وسعر البيع الكاملة
        const sum = data.summary || {};
        const formatMoney = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        const elTotStores = document.getElementById('stk-mid-total-stores');
        const elTotItems = document.getElementById('stk-mid-total-items');
        const elTotQty = document.getElementById('stk-mid-total-qty');
        const elSysCost = document.getElementById('stk-mid-sys-cost');
        const elSysSale = document.getElementById('stk-mid-sys-sale');
        const elActCost = document.getElementById('stk-mid-act-cost');
        const elActSale = document.getElementById('stk-mid-act-sale');
        const elDiffCost = document.getElementById('stk-mid-diff-cost');

        if (elTotStores) elTotStores.textContent = (sum.total_stores || 0).toLocaleString();
        if (elTotItems) elTotItems.textContent = (sum.total_counted_items || 0).toLocaleString();
        if (elTotQty) elTotQty.textContent = (sum.total_counted_qty || 0).toLocaleString();
        if (elSysCost) elSysCost.textContent = formatMoney(sum.total_system_cost);
        if (elSysSale) elSysSale.textContent = formatMoney(sum.total_system_sale);
        if (elActCost) elActCost.textContent = formatMoney(sum.total_counted_cost);
        if (elActSale) elActSale.textContent = formatMoney(sum.total_counted_sale);
        if (elDiffCost) {
            elDiffCost.textContent = `${sum.diff_cost > 0 ? '+' : ''}${formatMoney(sum.diff_cost)}`;
            elDiffCost.className = `text-xs sm:text-sm font-black font-mono ${sum.diff_cost < 0 ? 'text-rose-400' : (sum.diff_cost > 0 ? 'text-emerald-400' : 'text-white')}`;
        }

        // 2. النصف العلوي: الاستورات المنشأة (Created Stores)
        renderCreatedStoresTable(data.created_stores || []);

        // 3. النصف السفلي: الاستورات التي تمت أو جاري فيها الجرد (Counted Stores)
        renderCountedStoresTable(data.counted_stores || []);

        // التحقق من صحة الاستور النشط ومزامنته تلقائياً مع الاستور الفعلي
        const allStores = data.created_stores || [];
        if (allStores.length > 0) {
            const exists = allStores.some(s => s.store_no === currentActiveStoreNo);
            if (!exists) {
                const saved = localStorage.getItem('agy_active_store_no');
                const matched = allStores.find(s => s.store_no === saved) || allStores[0];
                currentActiveStoreNo = matched.store_no;
                currentActiveStoreName = matched.store_name;
                localStorage.setItem('agy_active_store_no', currentActiveStoreNo);
                localStorage.setItem('agy_active_store_name', currentActiveStoreName);
                const displayEl = document.getElementById('stk-active-store-display');
                const titleEl = document.getElementById('stk-current-counting-title');
                if (displayEl) displayEl.textContent = `${currentActiveStoreNo} (${currentActiveStoreName})`;
                if (titleEl) titleEl.textContent = `${currentActiveStoreNo} (${currentActiveStoreName})`;
            }
        }

        // تحميل تفاصيل الاستور النشط
        await loadCurrentStoreItems();
    } catch (e) {
        console.error('Failed to load stock stores', e);
    }
}

function renderCreatedStoresTable(stores) {
    const tbody = document.getElementById('stk-created-stores-tbody');
    const badge = document.getElementById('stk-created-stores-count');
    if (!tbody) return;

    if (badge) badge.textContent = `${stores.length} استور`;

    if (!stores || stores.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="p-4 text-center text-slate-400">لا توجد استورات مطابقة. اضغط NEW STORE لإنشاء استور جديد.</td></tr>`;
        return;
    }

    let html = '';
    stores.forEach((st, idx) => {
        const isCurrent = st.store_no === currentActiveStoreNo;
        const rowBg = isCurrent ? 'bg-indigo-50/70 border-r-4 border-indigo-600' : (idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50');

        let statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-600">جديد</span>`;
        if (st.status === 'in_progress') {
            statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">قيد الجرد</span>`;
        } else if (st.status === 'completed') {
            statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">مكتمل ومرحل</span>`;
        }

        html += `
            <tr class="${rowBg} hover:bg-indigo-50/40 transition border-b border-slate-100">
                <td class="p-2 text-center text-slate-400 font-mono">${idx + 1}</td>
                <td class="p-2 font-mono font-bold text-indigo-950">${st.store_no}</td>
                <td class="p-2 font-bold text-slate-800">${st.store_name}</td>
                <td class="p-2 text-center">${statusBadge}</td>
                <td class="p-2 text-center text-slate-500 font-mono">${st.created_by || 'المسؤول'}</td>
                <td class="p-2 text-center text-slate-400 text-[11px] font-mono">${st.created_at ? st.created_at.slice(0, 10) : '-'}</td>
                <td class="p-2 text-center">
                    <div class="inline-flex items-center gap-1 justify-center">
                        <button type="button" onclick="selectActiveStockStore('${st.store_no}', '${st.store_name}')"
                                class="px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-bold transition shadow-sm flex items-center justify-center gap-1">
                            <span>📥</span>
                            <span>${isCurrent ? 'جاري الجرد' : 'بدء الجرد'}</span>
                        </button>
                        <button type="button" onclick="deleteStoreBtn('${st.store_no}', '${st.store_name}')" title="حذف هذا الاستور بالكامل"
                                class="p-1 rounded text-rose-500 hover:bg-rose-100 hover:text-rose-700 transition text-xs font-bold">
                            🗑️
                        </button>
                    </div>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html;
}

let selectedStockStoreNos = new Set();
let countedStoresCache = [];

function updateStockStoresSelectionBar() {
    const bar = document.getElementById('stk-stores-bulk-bar');
    const badge = document.getElementById('stk-stores-selected-badge');
    const count = selectedStockStoreNos.size;
    if (badge) badge.textContent = count;
    if (bar) {
        if (count > 0) {
            bar.classList.remove('hidden');
        } else {
            bar.classList.add('hidden');
        }
    }
    const chkAll = document.getElementById('stk-counted-stores-chk-all');
    if (chkAll && countedStoresCache.length > 0) {
        chkAll.checked = count === countedStoresCache.length;
        chkAll.indeterminate = count > 0 && count < countedStoresCache.length;
    }
}

function selectAllCountedStores() {
    countedStoresCache.forEach(s => selectedStockStoreNos.add(s.store_no));
    document.querySelectorAll('.stk-store-row-chk').forEach(cb => cb.checked = true);
    updateStockStoresSelectionBar();
}

function clearCountedStoresSelection() {
    selectedStockStoreNos.clear();
    document.querySelectorAll('.stk-store-row-chk').forEach(cb => cb.checked = false);
    updateStockStoresSelectionBar();
}

function toggleCountedStoresChkAll(checked) {
    if (checked) {
        countedStoresCache.forEach(s => selectedStockStoreNos.add(s.store_no));
    } else {
        selectedStockStoreNos.clear();
    }
    document.querySelectorAll('.stk-store-row-chk').forEach(cb => cb.checked = checked);
    updateStockStoresSelectionBar();
}

async function commitAllStoresStocktake(all = true) {
    const msg = `⚠️ تأكيد تعميد وترحيل الجرد النهائي لجميع الاستورات:\n\nسيتم مسح الاستوك الدفتري القديم نهائياً لجميع الاستورات واعتماد الأرصدة والتشغيلات المجرودة فعلياً كأرصدة جديدة للمخزون.\n\nهل أنت متأكد من الاستمرار وتعميد الجرد؟`;
    if (!confirm(msg)) return;

    try {
        showCatalogToast('🚀 جاري مسح الاستوك القديم واعتماد وتعميد الجرد لجميع الاستورات...');
        const res = await fetch('/api/stock/stores/commit-all', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ commit_all: true })
        });
        const data = await res.json();
        if (data.success) {
            alert(data.message || 'تم تعميد وترحيل جميع الاستورات بنجاح!');
            selectedStockStoreNos.clear();
            updateStockStoresSelectionBar();
            await loadStocktakeStores();
            await loadCurrentStoreItems();
        } else {
            alert('تعذر الترحيل: ' + (data.message || 'خطأ غير معروف'));
        }
    } catch (e) {
        alert('خطأ أثناء تعميد الجرد: ' + e.message);
    }
}

async function commitSelectedStoresStocktake() {
    if (selectedStockStoreNos.size === 0) {
        alert('يرجى تحديد استور واحد على الأقل للترحيل.');
        return;
    }
    const storeList = Array.from(selectedStockStoreNos);
    const msg = `⚠️ تأكيد تعميد وترحيل الجرد النهائي:\n\nسيتم مسح الاستوك الدفتري القديم واعتماد الفعلي الجديد لعدد (${storeList.length}) استور:\n[${storeList.join(', ')}]\n\nهل أنت متأكد من المتابعة والاعتماد؟`;
    if (!confirm(msg)) return;

    try {
        showCatalogToast(`🚀 جاري تعميد وترحيل الجرد لعدد ${storeList.length} استور...`);
        const res = await fetch('/api/stock/commit-bulk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ store_nos: storeList })
        });
        const data = await res.json();
        if (data.success) {
            alert(data.message || 'تم تعميد الاستورات المحددة بنجاح!');
            selectedStockStoreNos.clear();
            updateStockStoresSelectionBar();
            await loadStocktakeStores();
            await loadCurrentStoreItems();
        } else {
            alert('تعذر الترحيل: ' + (data.message || 'خطأ غير معروف'));
        }
    } catch (e) {
        alert('خطأ أثناء ترحيل الاستورات: ' + e.message);
    }
}

function renderCountedStoresTable(stores) {
    countedStoresCache = stores || [];
    const tbody = document.getElementById('stk-counted-stores-tbody');
    const badge = document.getElementById('stk-counted-stores-count');
    if (!tbody) return;

    if (badge) badge.textContent = `${stores.length} استور`;

    if (!stores || stores.length === 0) {
        tbody.innerHTML = `<tr><td colspan="11" class="p-4 text-center text-slate-400">لا توجد استورات جارية حتى الآن.</td></tr>`;
        updateStockStoresSelectionBar();
        return;
    }

    const formatMoney = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    let html = '';
    stores.forEach((st, idx) => {
        const isCurrent = st.store_no === currentActiveStoreNo;
        const isChecked = selectedStockStoreNos.has(st.store_no);
        const rowBg = isCurrent ? 'bg-emerald-50/70 border-r-4 border-emerald-600' : (idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50');
        const diff = Number((st.counted_cost || 0) - (st.system_cost || 0));

        let statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">قيد الجرد</span>`;
        if (st.status === 'completed') {
            statusBadge = `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">مكتمل ومرحل</span>`;
        }

        html += `
            <tr class="${rowBg} hover:bg-emerald-50/40 transition border-b border-slate-100">
                <td class="p-2 text-center">
                    <input type="checkbox" class="stk-store-row-chk cursor-pointer rounded border-slate-300 w-3.5 h-3.5" data-store-no="${st.store_no}" ${isChecked ? 'checked' : ''}>
                </td>
                <td class="p-2 text-center text-slate-400 font-mono">${idx + 1}</td>
                <td class="p-2 font-mono font-bold text-slate-900">${st.store_no}</td>
                <td class="p-2 font-bold text-slate-800">${st.store_name}</td>
                <td class="p-2 text-center font-mono font-bold text-amber-700">${st.counted_items || 0}</td>
                <td class="p-2 text-center font-mono font-bold text-indigo-700">${st.counted_qty || 0}</td>
                <td class="p-2 text-center font-mono font-bold text-emerald-700">${formatMoney(st.counted_cost)}</td>
                <td class="p-2 text-center font-mono font-bold text-teal-700">${formatMoney(st.counted_sale)}</td>
                <td class="p-2 text-center font-mono font-bold ${diff < 0 ? 'text-rose-600' : (diff > 0 ? 'text-emerald-600' : 'text-slate-400')}">
                    ${diff > 0 ? '+' : ''}${formatMoney(diff)}
                </td>
                <td class="p-2 text-center">${statusBadge}</td>
                <td class="p-2 text-center">
                    <div class="inline-flex items-center gap-1">
                        <button type="button" onclick="selectActiveStockStore('${st.store_no}', '${st.store_name}')"
                                class="px-2 py-0.5 bg-slate-800 hover:bg-slate-900 text-white rounded text-[11px] font-bold transition">
                            متابعة
                        </button>
                        <button type="button" onclick="quickExportStoreExcel('${st.store_no}')" title="سحب Excel"
                                class="p-1 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded text-xs">
                            📊
                        </button>
                        <button type="button" onclick="quickPrintStore('${st.store_no}')" title="طباعة"
                                class="p-1 bg-amber-50 text-amber-800 hover:bg-amber-100 rounded text-xs">
                            🖨️
                        </button>
                        <button type="button" onclick="deleteStoreBtn('${st.store_no}', '${st.store_name}')" title="حذف هذا الاستور"
                                class="p-1 text-rose-500 hover:bg-rose-100 rounded text-xs">
                            🗑️
                        </button>
                    </div>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html;

    // ربط مربعات التحديد بكل سطر
    tbody.querySelectorAll('.stk-store-row-chk').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const no = e.target.dataset.storeNo;
            if (e.target.checked) {
                selectedStockStoreNos.add(no);
            } else {
                selectedStockStoreNos.delete(no);
            }
            updateStockStoresSelectionBar();
        });
    });
    updateStockStoresSelectionBar();
}

// دالة حذف استور بالكامل
async function deleteStoreBtn(storeNo, storeName) {
    if (!confirm(`هل أنت متأكد من رغبتك في حذف الاستور (${storeNo} - ${storeName || ''}) بالكامل بجميع بياناته وبنوده ومخزونه؟`)) {
        return;
    }
    try {
        const res = await fetch('/api/stock/stores/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ store_no: storeNo })
        });
        const data = await res.json();
        if (data.success) {
            alert(data.message || 'تم حذف الاستور بنجاح.');
            if (currentActiveStoreNo === storeNo) {
                selectActiveStockStore(data.next_store_no, data.next_store_name);
            } else {
                await loadStocktakeStores();
            }
        } else {
            alert('فشل الحذف: ' + (data.message || ''));
        }
    } catch (e) {
        alert('خطأ: ' + e.message);
    }
    document.getElementById('stk-scan-input')?.focus();
}

function selectActiveStockStore(storeNo, storeName) {
    if (!storeNo) return;
    currentActiveStoreNo = storeNo;
    currentActiveStoreName = storeName || '';
    localStorage.setItem('agy_active_store_no', currentActiveStoreNo);
    localStorage.setItem('agy_active_store_name', currentActiveStoreName);
    selectedStockEntryIds.clear();
    updateStockSelectionBar();
    closeStkSearchDropdown();
    stkSearchResults = [];

    const displayEl = document.getElementById('stk-active-store-display');
    const titleEl = document.getElementById('stk-current-counting-title');
    if (displayEl) displayEl.textContent = `${storeNo} (${storeName || ''})`;
    if (titleEl) titleEl.textContent = `${storeNo} (${storeName || ''})`;
    if (typeof updateStkStockFilterUI === 'function') updateStkStockFilterUI();

    const box2Inp = document.getElementById('stk-items-search-filter');
    const box2Q = (box2Inp?.value || '').replace(/^\s+/, '');
    loadCurrentStoreItems(box2Q);
    loadStocktakeStores();
    setTimeout(() => document.getElementById('stk-scan-input')?.focus(), 150);
}

// =========================================================================
// لوحة فحص الصنف وإدخال كميات الباتشات العلوية (للأصناف 1D والأكواد)
// =========================================================================
let currentActiveBatchCardData = null;

function updateBecRowCalc(inputEl) {
    const row = inputEl.closest('tr');
    if (!row) return;
    const sysQty = parseFloat(inputEl.dataset.systemQty) || 0;
    const cost = parseFloat(inputEl.dataset.cost) || 0;
    const sale = parseFloat(inputEl.dataset.sale) || 0;
    const val = inputEl.value.trim();
    const countedVal = val === '' ? 0 : (parseFloat(val) || 0);

    const diff = Number(countedVal - sysQty).toFixed(2);
    const diffCell = row.querySelector('.bec-diff-cell');
    if (diffCell) {
        diffCell.textContent = (diff > 0 ? '+' : '') + diff;
        diffCell.className = `bec-diff-cell font-mono font-bold text-xs ${diff < 0 ? 'text-rose-600' : (diff > 0 ? 'text-emerald-700' : 'text-slate-400')}`;
        const diffTd = diffCell.closest('td');
        if (diffTd) {
            diffTd.className = `border border-slate-300 p-1 text-center font-mono font-bold text-xs ${diff < 0 ? 'text-rose-600 bg-rose-50/40' : (diff > 0 ? 'text-emerald-700 bg-emerald-50/40' : 'text-slate-400')}`;
        }
    }

    const totCostCell = row.querySelector('.bec-totcost-cell');
    if (totCostCell) {
        totCostCell.textContent = formatMoney(countedVal * cost);
    }

    const totSaleCell = row.querySelector('.bec-totsale-cell');
    if (totSaleCell) {
        totSaleCell.textContent = formatMoney(countedVal * sale);
    }
}

let batchCardSourceOrigin = 'desktop_input'; // 'camera' (mobile camera) or 'desktop_input' (barcode scanner/PC)
let wasCameraActiveBeforeBatch = false;

// دالة الكشف هل المستخدم يتصفح من هاتف محمول/تابلت أم من جهاز كمبيوتر ديسكتوب
function isMobileDeviceEnvironment() {
    const ua = navigator.userAgent || '';
    const isMobileUA = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    const isTouch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    const isSmallScreen = window.innerWidth <= 850;
    return isMobileUA || (isTouch && isSmallScreen);
}

// دالة توليد رقم تشغيلة تلقائي بصيغة معيارية B{YYMM}-{index}
function parseQtyInput(val) {
    if (!val) return 0;
    let s = String(val).trim();
    s = s.replace(/[٠-٩]/g, d => '0123456789'['٠١٢٣٤٥٦٧٨٩'.indexOf(d)]);
    s = s.replace(/[۰-۹]/g, d => '0123456789'['۰۱۲۳۴۵۶۷۸۹'.indexOf(d)]);
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}

function generateDefaultBatchNumber(index = 0) {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const seq = String(index + 1).padStart(2, '0');
    return `B${yy}${mm}-${seq}`;
}

// دالة توحيد وتنسيق تاريخ الصلاحية المدخل يدوياً بمختلف الصيغ (01012028، 1-1-2028، 1/1/2028، YYYY-MM)
function normalizeExpiryDate(str_val) {
    if (!str_val) return '';
    let val = String(str_val).trim();
    val = val.replace(/[\s./\\]+/g, '-').replace(/^-+|-+$/g, '');
    if (!val || val === '-') return '';

    // Standard ISO already: YYYY-MM-DD or YYYY-MM
    if (/^\d{4}-\d{2}-\d{2}$/.test(val)) return val;
    if (/^\d{4}-\d{2}$/.test(val)) return val;

    // D-M-YYYY or DD-MM-YYYY (e.g. 1-1-2028, 01-01-2028, 15-10-2027)
    let m = val.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (m) {
        let d = parseInt(m[1], 10);
        let mo = parseInt(m[2], 10);
        let y = m[3];
        if (mo > 12 && d <= 12) {
            let tmp = d; d = mo; mo = tmp;
        }
        return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    // D-M-YY or DD-MM-YY (e.g. 1-1-28, 01-01-28)
    m = val.match(/^(\d{1,2})-(\d{1,2})-(\d{2})$/);
    if (m) {
        let d = parseInt(m[1], 10);
        let mo = parseInt(m[2], 10);
        let y = '20' + m[3];
        if (mo > 12 && d <= 12) {
            let tmp = d; d = mo; mo = tmp;
        }
        return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }

    // 8 digits pure numbers (DDMMYYYY e.g. 01012028 or YYYYMMDD e.g. 20280101)
    if (/^\d{8}$/.test(val)) {
        if (val.startsWith('20') && parseInt(val.slice(4, 6), 10) <= 12 && parseInt(val.slice(6, 8), 10) <= 31) {
            return `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}`;
        } else {
            let d = val.slice(0, 2);
            let mo = val.slice(2, 4);
            let y = val.slice(4, 8);
            return `${y}-${mo}-${d}`;
        }
    }

    // 7 digits (e.g. 1012028 -> 1-01-2028)
    if (/^\d{7}$/.test(val)) {
        let d = '0' + val.slice(0, 1);
        let mo = val.slice(1, 3);
        let y = val.slice(3, 7);
        if (parseInt(mo, 10) <= 12) {
            return `${y}-${mo}-${d}`;
        }
    }

    // MM-YYYY (e.g. 10-2027 or 01-2028)
    m = val.match(/^(\d{1,2})-(\d{4})$/);
    if (m) {
        return `${m[2]}-${m[1].padStart(2, '0')}`;
    }

    // MM-YY (e.g. 10-27 or 01-28)
    m = val.match(/^(\d{1,2})-(\d{2})$/);
    if (m) {
        return `20${m[2]}-${m[1].padStart(2, '0')}`;
    }

    // 6 digits pure numbers (YYYYMM or MMYYYY or DDMMYY)
    if (/^\d{6}$/.test(val)) {
        if (val.startsWith('20')) {
            let y = val.slice(0, 4);
            let mo = val.slice(4, 6);
            if (parseInt(mo, 10) <= 12) return `${y}-${mo}`;
        }
        if (val.endsWith('2026') || val.endsWith('2027') || val.endsWith('2028') || val.endsWith('2029') || val.endsWith('2030')) {
            let mo = val.slice(0, 2);
            let y = val.slice(2, 6);
            return `${y}-${mo}`;
        }
        let d = val.slice(0, 2);
        let mo = val.slice(2, 4);
        let y = '20' + val.slice(4, 6);
        if (parseInt(d, 10) <= 31 && parseInt(mo, 10) <= 12) {
            return `${y}-${mo}-${d}`;
        }
    }

    // 4 digits pure numbers (MMYY or YYMM)
    if (/^\d{4}$/.test(val)) {
        let p1 = parseInt(val.slice(0, 2), 10);
        let p2 = parseInt(val.slice(2, 4), 10);
        if (p1 >= 1 && p1 <= 12 && p2 >= 24 && p2 <= 40) {
            return `20${val.slice(2, 4)}-${val.slice(0, 2)}`;
        } else if (p1 >= 24 && p1 <= 40 && p2 >= 1 && p2 <= 12) {
            return `20${val.slice(0, 2)}-${val.slice(2, 4)}`;
        }
    }

    return val;
}

// إضافة تشغيلة جديدة إضافية لنفس الصنف في كارت الإدخال
function addExtraBatchRowToCard() {
    if (!currentActiveBatchCardData) return;
    if (!currentActiveBatchCardData.batches) currentActiveBatchCardData.batches = [];

    const newIdx = currentActiveBatchCardData.batches.length;
    const prod = currentActiveBatchCardData.product || {};

    currentActiveBatchCardData.batches.push({
        batch_number: generateDefaultBatchNumber(newIdx),
        expiry_date: '',
        system_qty: 0.0,
        counted_qty: 0.0,
        cost_price: Number(prod.cost_price || 0),
        selling_price: Number(prod.selling_price || 0),
        entry_id: null,
        is_new_batch: 1,
        is_manual_batch: 1,
        requires_manual_entry: true,
        is_dynamic_added: true
    });

    renderBatchCardRows(currentActiveBatchCardData);

    // التركيز التلقائي على خانة الصلاحية للتشغيلة الجديدة المضافة
    setTimeout(() => {
        const tbody = document.getElementById('stk-bec-batches-tbody');
        const newExpiry = tbody?.querySelector(`#stk-bec-row-${newIdx} .stk-bec-expiry-input`);
        if (newExpiry) {
            newExpiry.focus();
            newExpiry.select();
            newExpiry.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }, 60);
}

let lastBatchStepTime = 0;

// دالة التنقل بين الباتشات بالسهم/Enter أو اعتماد الترحيل عند آخر باتش
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
                    r.classList.add('ring-2', 'ring-indigo-500', 'bg-sky-50/70');
                } else {
                    r.classList.remove('ring-2', 'ring-indigo-500', 'bg-sky-50/70');
                }
            }
        });
    } else {
        // عند آخر باتش (أو الصنف له باتش واحد فقط): الاعتماد والترحيل المباشر
        commitAllCardBatches(allQtyInputs);
    }
}

// دالة بناء ورسم سطور كارت الباتشات وربط جميع الأحداث
function renderBatchCardRows(data) {
    const tbody = document.getElementById('stk-bec-batches-tbody');
    const elCount = document.getElementById('stk-bec-batches-count');
    if (!tbody || !data) return;

    const prod = data.product || {};
    const batches = data.batches || [];

    if (elCount) elCount.textContent = `${batches.length} تشغيلة`;

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

        // الصنف يعتبر قابل للتعديل اليدوي إن كان جديداً أو بدون باتش مسجل أو بدون صلاحية
        const isEditable = Boolean(b.is_new_batch || b.requires_manual_entry || b.is_manual_batch || !b.batch_number || b.batch_number === '-' || !b.expiry_date || b.expiry_date === '-' || b.force_edit);
        const defaultBatch = String((b.batch_number && b.batch_number !== '-') ? b.batch_number : generateDefaultBatchNumber(idx)).toUpperCase();
        const expiryVal = (b.expiry_date && b.expiry_date !== '-') ? b.expiry_date : '';

        const batchBadge = (b.is_new_batch || isEditable || sysQty === 0)
            ? `<span class="px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-bold border border-amber-300 text-[10px] whitespace-nowrap">⚠️ تشغيلة جديدة</span>`
            : `<span class="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-bold border border-emerald-200 text-[10px] whitespace-nowrap">مطابق ✅</span>`;

        // خلية رقم التشغيلة: إدخال مفتوح أو قابل للتعديل
        const batchCell = isEditable
            ? `<div class="flex items-center justify-center gap-1">
                 <input type="text"
                        class="stk-bec-batch-input font-mono font-bold text-center text-xs w-28 py-1 px-1.5 border border-indigo-300 focus:border-indigo-600 focus:bg-white rounded-lg bg-slate-50 text-indigo-950 shadow-2xs outline-none transition"
                        data-index="${idx}"
                        value="${escapeHtml(defaultBatch)}"
                        placeholder="رقم التشغيلة"
                        dir="ltr"
                        enterkeyhint="next"
                        title="رقم التشغيلة (يتم إنشاؤه تلقائياً أو تعديله يدوياً)">
               </div>`
            : `<div class="flex items-center justify-center gap-1">
                 <span class="px-2 py-0.5 rounded bg-indigo-100 border border-indigo-300 text-indigo-950 font-black font-mono text-xs shadow-sm" dir="ltr">${escapeHtml(String(b.batch_number || '-').toUpperCase())}</span>
                 <button type="button" class="stk-bec-btn-toggle-edit p-1 rounded text-indigo-600 hover:bg-indigo-100 transition text-xs" data-index="${idx}" title="تعديل التشغيلة والصلاحية يدوياً">✏️</button>
               </div>`;

        // خلية الصلاحية: إدخال يدوي إلزامي بالصيغة المطلوبة (YYYY-MM)
        const expiryCell = isEditable
            ? `<div class="flex flex-col items-center gap-0.5">
                 <input type="text"
                        class="stk-bec-expiry-input font-mono font-bold text-center text-xs w-28 py-1 px-1.5 border ${!expiryVal ? 'border-amber-400 bg-amber-50/70' : 'border-slate-300 bg-slate-50'} focus:border-indigo-600 focus:bg-white rounded-lg text-slate-900 shadow-2xs outline-none transition"
                        data-index="${idx}"
                        value="${escapeHtml(expiryVal)}"
                        placeholder="مثال 01012028 أو 1-1-2028"
                        dir="ltr"
                        enterkeyhint="next"
                        title="تاريخ الصلاحية (إدخال يدوي إلزامي: مثال 2027-10)">
                 ${!expiryVal ? '<span class="text-[9px] text-amber-700 font-bold whitespace-nowrap">مطلوب يدوياً ⚠️</span>' : ''}
               </div>`
            : `<div class="flex items-center justify-center gap-1">
                 <span class="font-mono font-bold text-slate-900 text-xs" dir="ltr">${escapeHtml(b.expiry_date || '-')}</span>
               </div>`;

        // زر السطر: إن كان هناك باتشات تالية يظهر 'التالي ➔'، وإن كان الأخير يظهر 'ترحيل ↵'
        const isLastBatch = (idx === batches.length - 1);
        const actionBtn = isLastBatch
            ? `<button type="button" class="stk-bec-btn-action px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white font-bold text-[11px] shadow-xs flex items-center justify-center gap-1 mx-auto transition" data-action="commit" data-index="${idx}"><span>ترحيل</span> <span>↵</span></button>`
            : `<button type="button" class="stk-bec-btn-action px-2.5 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white font-bold text-[11px] shadow-xs flex items-center justify-center gap-1 mx-auto transition" data-action="next" data-index="${idx}"><span>التالي</span> <span>➔</span></button>`;

        const deleteRowBtn = (b.is_dynamic_added && batches.length > 1)
            ? `<button type="button" class="stk-bec-btn-delete-row text-rose-500 hover:text-rose-700 p-0.5 text-xs transition" data-index="${idx}" title="حذف هذه التشغيلة">🗑️</button>`
            : '';

        const statusCellContent = hasCounted
            ? `<div class="flex flex-col items-center gap-1"><span class="px-1.5 py-0.5 rounded bg-emerald-600 text-white font-bold text-[10px]">✅ تم (${countedVal})</span><div class="flex items-center gap-1">${actionBtn}${deleteRowBtn}</div></div>`
            : `<div class="flex items-center justify-center gap-1">${actionBtn}${deleteRowBtn}</div>`;

        html += `
            <tr class="${hasCounted ? 'bg-emerald-50/40 hover:bg-sky-50/40' : ((b.is_new_batch || sysQty === 0) ? 'bg-amber-50/60 hover:bg-amber-100/60' : (idx % 2 === 0 ? 'bg-white hover:bg-sky-50/40' : 'bg-slate-50/70 hover:bg-sky-50/40'))} transition text-slate-700 text-xs" id="stk-bec-row-${idx}">
                <td class="border border-slate-300 p-1 text-center text-slate-500 font-mono text-[11px] select-none bg-slate-50/50">${idx + 1}</td>
                <td class="border border-slate-300 p-1 font-mono font-bold text-slate-900 text-center">${escapeHtml(prod.code || '')}</td>
                <td class="border border-slate-300 p-1 text-left font-bold text-slate-900 select-text min-w-[260px] whitespace-normal leading-snug" dir="ltr">
                    ${escapeHtml(prod.name || '')}
                </td>
                <td class="border border-slate-300 p-1 font-mono text-[11px] text-slate-600 text-center" dir="ltr">${escapeHtml(prod.barcode || prod.gtin || '-')}</td>
                <td class="border border-slate-300 p-1 text-center">
                    ${batchCell}
                </td>
                <td class="border border-slate-300 p-1 text-center font-mono font-bold text-slate-900 text-xs" dir="ltr">
                    ${expiryCell}
                </td>
                <td class="border border-slate-300 p-1 text-center bg-sky-50/40">
                    <span class="font-mono font-black text-slate-900 text-xs px-2 py-0.5 rounded bg-slate-200/80 border border-slate-300 shadow-sm">${sysQty}</span>
                </td>
                <td class="border border-slate-300 p-1 text-center bg-emerald-50/40">
                    <input type="text"
                           inputmode="decimal"
                           class="stk-bec-qty-input font-mono font-black text-center text-xs w-16 py-0.5 px-1 border border-emerald-400 focus:border-indigo-600 focus:bg-white rounded bg-white text-emerald-950 shadow-inner outline-none transition"
                           data-index="${idx}"
                           data-product-code="${escapeHtml(prod.code || '')}"
                           data-entry-id="${b.entry_id || ''}"
                           data-batch="${escapeHtml(String(b.batch_number || '').toUpperCase())}"
                           data-expiry="${escapeHtml(b.expiry_date || '')}"
                           data-system-qty="${sysQty}"
                           data-cost="${cost}"
                           data-sale="${sale}"
                           value="${b.counted_qty > 0 ? b.counted_qty : ''}"
                           placeholder="أدخل..."
                           enterkeyhint="done"
                           oninput="updateBecRowCalc(this)">
                </td>
                <td class="border border-slate-300 p-1 text-center font-mono font-bold text-xs ${diff < 0 ? 'text-rose-600 bg-rose-50/40' : (diff > 0 ? 'text-emerald-700 bg-emerald-50/40' : 'text-slate-400')}">
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

    // ربط مستمعي أحداث حقول الإدخال والأزرار ديناميكياً
    attachBatchCardRowEvents(data);
}

// دالة ربط أحداث الإدخال والتنقل الذكي بالسهم والإنتر بين الحقول
function attachBatchCardRowEvents(data) {
    const tbody = document.getElementById('stk-bec-batches-tbody');
    if (!tbody) return;

    const batches = data.batches || [];
    const qtyInputs = Array.from(tbody.querySelectorAll('.stk-bec-qty-input'));

    // 1. ربط حقول رقم التشغيلة
    tbody.querySelectorAll('.stk-bec-batch-input').forEach(batchInp => {
        const idx = parseInt(batchInp.dataset.index);
        batchInp.addEventListener('input', () => {
            const start = batchInp.selectionStart;
            const end = batchInp.selectionEnd;
            const up = decodeArabicKeyboard(batchInp.value).toUpperCase();
            if (batchInp.value !== up) {
                batchInp.value = up;
                try { batchInp.setSelectionRange(start, end); } catch (_) {}
            }
        });
        const handleBatchStep = (e) => {
            const isEnter = (e.key === 'Enter' || e.keyCode === 13 || e.which === 13 || e.code === 'Enter');
            const isTab = (e.key === 'Tab' || e.keyCode === 9 || e.which === 9) && !e.shiftKey;
            const isDown = (e.key === 'ArrowDown' || e.keyCode === 40);

            if (isEnter || isTab || isDown) {
                e.preventDefault();
                e.stopPropagation();
                const expInp = tbody.querySelector(`#stk-bec-row-${idx} .stk-bec-expiry-input`);
                const qtyInp = tbody.querySelector(`#stk-bec-row-${idx} .stk-bec-qty-input`);
                const target = expInp || qtyInp;
                if (target) {
                    target.focus();
                    target.select();
                }
            }
        };
        batchInp.addEventListener('keydown', handleBatchStep);
        batchInp.addEventListener('beforeinput', (e) => {
            if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
                e.preventDefault();
                e.stopPropagation();
                const expInp = tbody.querySelector(`#stk-bec-row-${idx} .stk-bec-expiry-input`);
                const qtyInp = tbody.querySelector(`#stk-bec-row-${idx} .stk-bec-qty-input`);
                const target = expInp || qtyInp;
                if (target) {
                    target.focus();
                    target.select();
                }
            }
        });
    });

    // 2. ربط حقول تاريخ الصلاحية (مع التنسيق والتحقق التلقائي)
    tbody.querySelectorAll('.stk-bec-expiry-input').forEach(expInp => {
        const idx = parseInt(expInp.dataset.index);

        expInp.addEventListener('blur', () => {
            expInp.value = normalizeExpiryDate(expInp.value);
            if (expInp.value) {
                expInp.classList.remove('border-rose-500', 'ring-2', 'ring-rose-500', 'bg-rose-50');
            }
        });

        const handleExpiryStep = (e) => {
            const isEnter = (e.key === 'Enter' || e.keyCode === 13 || e.which === 13 || e.code === 'Enter');
            const isTab = (e.key === 'Tab' || e.keyCode === 9 || e.which === 9) && !e.shiftKey;
            const isDown = (e.key === 'ArrowDown' || e.keyCode === 40 || e.key === 'ArrowRight' || e.keyCode === 39);

            if (isEnter || isTab || isDown) {
                if (e.preventDefault) e.preventDefault();
                if (e.stopPropagation) e.stopPropagation();
                expInp.value = normalizeExpiryDate(expInp.value);
                if (expInp.value) {
                    expInp.classList.remove('border-rose-500', 'ring-2', 'ring-rose-500', 'bg-rose-50');
                }
                const qtyInp = tbody.querySelector(`#stk-bec-row-${idx} .stk-bec-qty-input`);
                if (qtyInp) {
                    qtyInp.focus();
                    qtyInp.select();
                }
            }
        };

        expInp.addEventListener('keydown', handleExpiryStep);
        expInp.addEventListener('keyup', (e) => {
            if (e.key === 'Enter' || e.keyCode === 13 || e.which === 13) {
                handleExpiryStep(e);
            }
        });
        expInp.addEventListener('beforeinput', (e) => {
            if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
                e.preventDefault();
                e.stopPropagation();
                expInp.value = normalizeExpiryDate(expInp.value);
                if (expInp.value) {
                    expInp.classList.remove('border-rose-500', 'ring-2', 'ring-rose-500', 'bg-rose-50');
                }
                const qtyInp = tbody.querySelector(`#stk-bec-row-${idx} .stk-bec-qty-input`);
                if (qtyInp) {
                    qtyInp.focus();
                    qtyInp.select();
                }
            }
        });
    });

    // 3. ربط حقول الرصيد الفعلي (الكمية)
    qtyInputs.forEach((inp, idx) => {
        inp.addEventListener('focus', () => {
            qtyInputs.forEach((otherInp, j) => {
                const r = document.getElementById(`stk-bec-row-${j}`);
                if (r) {
                    if (idx === j) {
                        r.classList.add('ring-2', 'ring-indigo-500', 'bg-sky-50/70');
                    } else {
                        r.classList.remove('ring-2', 'ring-indigo-500', 'bg-sky-50/70');
                    }
                }
            });
        });

        const handleKeyStep = (e) => {
            const isEnter = (e.key === 'Enter' || e.keyCode === 13 || e.which === 13 || e.code === 'Enter' || e.code === 'NumpadEnter');
            const isTab = (e.key === 'Tab' || e.keyCode === 9 || e.which === 9) && !e.shiftKey;
            const isDown = (e.key === 'ArrowDown' || e.keyCode === 40 || e.key === 'ArrowRight' || e.keyCode === 39);
            const isAction = (e.key === 'Done' || e.key === 'Go' || e.key === 'Next' || e.key === 'Submit');

            if (isEnter || isTab || isDown || isAction) {
                if (e.preventDefault) e.preventDefault();
                if (e.stopPropagation) e.stopPropagation();
                moveToNextBatchOrCommit(idx);
            } else if (e.key === 'Escape') {
                if (e.preventDefault) e.preventDefault();
                closeBatchEntryCard(false);
            }
        };

        inp.addEventListener('keydown', handleKeyStep);
        inp.addEventListener('keyup', (e) => {
            if (e.key === 'Enter' || e.keyCode === 13 || e.which === 13) {
                handleKeyStep(e);
            }
        });
        inp.addEventListener('beforeinput', (e) => {
            if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
                e.preventDefault();
                e.stopPropagation();
                moveToNextBatchOrCommit(idx);
            }
        });
    });

    // 4. ربط أزرار الإجراء (التالي / ترحيل) الموضعية بكل سطر
    tbody.querySelectorAll('.stk-bec-btn-action').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const btnIdx = parseInt(btn.dataset.index);
            moveToNextBatchOrCommit(btnIdx);
        });
    });

    // 5. زر تفعيل التعديل اليدوي للسطر
    tbody.querySelectorAll('.stk-bec-btn-toggle-edit').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const editIdx = parseInt(btn.dataset.index);
            if (batches[editIdx]) {
                batches[editIdx].force_edit = true;
                renderBatchCardRows(data);
                setTimeout(() => {
                    const rowExp = tbody.querySelector(`#stk-bec-row-${editIdx} .stk-bec-expiry-input`);
                    if (rowExp) {
                        rowExp.focus();
                        rowExp.select();
                    }
                }, 50);
            }
        });
    });

    // 6. زر حذف التشغيلة المضافة يدوياً
    tbody.querySelectorAll('.stk-bec-btn-delete-row').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const delIdx = parseInt(btn.dataset.index);
            if (batches[delIdx]) {
                batches.splice(delIdx, 1);
                renderBatchCardRows(data);
            }
        });
    });
}

function openBatchEntryCard(data, source = 'desktop_input') {
    batchCardSourceOrigin = source; // حفظ مصدر السحب (كاميرا موبايل أم سكانر كمبيوتر)
    wasCameraActiveBeforeBatch = (source === 'camera');
    currentActiveBatchCardData = data;

    const card = document.getElementById('stk-batch-entry-card');
    if (!card) return;

    const prod = data.product || {};
    const batches = data.batches || [];

    const elCode = document.getElementById('stk-bec-product-code');
    const elName = document.getElementById('stk-bec-product-name');
    const elBarcode = document.getElementById('stk-bec-barcode');

    if (elCode) elCode.textContent = prod.code || '-';
    if (elName) elName.textContent = prod.name || '-';
    if (elBarcode) elBarcode.textContent = prod.barcode || prod.gtin || '-';

    // رسم السطور
    renderBatchCardRows(data);

    card.classList.remove('hidden');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });

    // حماية تمنع القفز لحقل البحث أثناء فتح كارت الباتشات
    const searchFilter = document.getElementById('stk-items-search-filter');
    if (searchFilter) {
        searchFilter.setAttribute('tabindex', '-1');
    }

    const tbody = document.getElementById('stk-bec-batches-tbody');
    const qtyInputs = Array.from(tbody?.querySelectorAll('.stk-bec-qty-input') || []);

    // تأمين النموذج من إرسال المتصفح التلقائي والتوجيه الذكي لمفاتيح الكيبورد
    const batchForm = document.getElementById('stk-bec-batches-form');
    if (batchForm) {
        batchForm.onsubmit = (e) => {
            e.preventDefault();
            e.stopPropagation();
            const activeEl = document.activeElement;

            // إذا كان المؤشر في خانة رقم التشغيلة -> توجه لخانة الصلاحية
            if (activeEl && activeEl.classList.contains('stk-bec-batch-input')) {
                const idx = parseInt(activeEl.dataset.index, 10);
                const expInp = tbody?.querySelector(`#stk-bec-row-${idx} .stk-bec-expiry-input`);
                if (expInp) { expInp.focus(); expInp.select(); }
                return false;
            }

            // إذا كان المؤشر في خانة الصلاحية -> نسق التاريخ وتوجه لخانة الكمية (ممنوع الإغلاق أو الاعتماد هنا)
            if (activeEl && activeEl.classList.contains('stk-bec-expiry-input')) {
                activeEl.value = normalizeExpiryDate(activeEl.value);
                if (activeEl.value) {
                    activeEl.classList.remove('border-rose-500', 'ring-2', 'ring-rose-500', 'bg-rose-50');
                }
                const idx = parseInt(activeEl.dataset.index, 10);
                const qtyInp = tbody?.querySelector(`#stk-bec-row-${idx} .stk-bec-qty-input`);
                if (qtyInp) { qtyInp.focus(); qtyInp.select(); }
                return false;
            }

            // فقط إذا كان المؤشر في خانة الكمية -> يتم الاعتماد والترحيل
            let activeIdx = qtyInputs.indexOf(activeEl);
            if (activeIdx === -1) {
                activeIdx = qtyInputs.length - 1;
            }
            moveToNextBatchOrCommit(activeIdx);
            return false;
        };
    }

    // التركيز التلقائي الذكي: إن كانت هناك خانة صلاحية فارغة نركز عليها، وإلا على خانة الكمية
    setTimeout(() => {
        const firstEmptyExpiry = tbody?.querySelector('.stk-bec-expiry-input');
        const firstQtyInput = tbody?.querySelector('.stk-bec-qty-input');

        if (firstEmptyExpiry && (!firstEmptyExpiry.value || firstEmptyExpiry.value === '-')) {
            firstEmptyExpiry.focus();
            firstEmptyExpiry.select();
            const firstRow = document.getElementById('stk-bec-row-0');
            if (firstRow) {
                firstRow.classList.add('ring-2', 'ring-indigo-500', 'bg-sky-50/70');
            }
        } else if (firstQtyInput) {
            firstQtyInput.focus();
            firstQtyInput.select();
            const firstRow = document.getElementById('stk-bec-row-0');
            if (firstRow) {
                firstRow.classList.add('ring-2', 'ring-indigo-500', 'bg-sky-50/70');
            }
        }
    }, 60);
}

let isBatchCommittingLock = false;
async function commitAllCardBatches(allInputs) {
    if (isBatchCommittingLock) return;
    isBatchCommittingLock = true;

    try {
        const tbody = document.getElementById('stk-bec-batches-tbody');
        const rowsToSave = [];

        // 1. التحقق أولاً من جميع السطور التي تحتوي على كمية فعلية > 0
        for (const inputEl of allInputs) {
            const idx = parseInt(inputEl.dataset.index);
            const rowEl = document.getElementById(`stk-bec-row-${idx}`);
            const val = inputEl.value.trim();
            const countedVal = parseQtyInput(val);

            // إذا كانت الكمية صفر أو فارغة، نتخطى هذا السطر
            if (isNaN(countedVal) || countedVal <= 0) {
                continue;
            }

            const batchInput = rowEl?.querySelector('.stk-bec-batch-input');
            const expiryInput = rowEl?.querySelector('.stk-bec-expiry-input');

            let batch = decodeArabicKeyboard(batchInput ? batchInput.value.trim() : (inputEl.dataset.batch || '')).toUpperCase();
            let expiry = expiryInput ? normalizeExpiryDate(expiryInput.value.trim()) : (inputEl.dataset.expiry || '');

            if (batchInput) batchInput.value = batch;
            if (expiryInput) expiryInput.value = expiry;

            // إذا لم يتم تحديد باتش، ننشئ رقم تشغيلة افتراضي معتمد
            if (!batch || batch === '-') {
                batch = generateDefaultBatchNumber(idx);
                if (batchInput) batchInput.value = batch;
            }

            // شرط إلزامي قطعي: تاريخ الصلاحية يجب إدخاله للصنف
            if (!expiry || expiry === '-') {
                isBatchCommittingLock = false;
                playStockAudioAlert(false);
                showCatalogToast('⚠️ يرجى إدخال تاريخ الصلاحية (الاكسبير) للصنف أولاً');
                if (expiryInput) {
                    expiryInput.classList.add('border-rose-500', 'ring-2', 'ring-rose-500', 'bg-rose-50');
                    expiryInput.focus();
                    expiryInput.select();
                    expiryInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
                return;
            }

            rowsToSave.push({
                store_no: currentActiveStoreNo,
                product_code: inputEl.dataset.productCode,
                entry_id: inputEl.dataset.entryId ? parseInt(inputEl.dataset.entryId) : null,
                batch_number: batch,
                expiry_date: expiry,
                counted_qty: countedVal,
                system_qty: parseFloat(inputEl.dataset.systemQty) || 0,
                cost_price: parseFloat(inputEl.dataset.cost) || 0,
                selling_price: parseFloat(inputEl.dataset.sale) || 0
            });
        }

        if (rowsToSave.length === 0) {
            playStockAudioAlert(false);
            showCatalogToast('⚠️ يرجى إدخال الكمية الفعلية للصنف أولاً');
            const firstQty = tbody.querySelector('.stk-bec-qty-input');
            if (firstQty) {
                firstQty.focus();
                firstQty.select();
            }
            return;
        }

        let savedCount = 0;
        let lastStoreDetails = null;

        for (const rowData of rowsToSave) {
            try {
                const res = await fetch('/api/stock/save-batch-qty', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(rowData)
                });
                const resData = await res.json();
                if (resData.success) {
                    savedCount++;
                    if (resData.store_details) {
                        lastStoreDetails = resData.store_details;
                    }
                } else {
                    console.error('Error saving batch row:', resData.message);
                }
            } catch (err) {
                console.error('Network error saving batch row', err);
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

        // إغلاق الكارت مع الفصل التام بين الكمبيوتر والموبايل:
        // على الموبايل حصراً (وإذا كان المسح بدأ من الكاميرا) يُعاد فتح الكاميرا
        // على الكمبيوتر (الديسكتوب) يُمنع فتح الكاميرا نهائياً ويعود الفوكس لخانة الباركود
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

function closeBatchEntryCard(isCommit = false) {
    const card = document.getElementById('stk-batch-entry-card');
    if (card) card.classList.add('hidden');
    currentActiveBatchCardData = null;

    // استرجاع مؤشر البحث
    const searchFilter = document.getElementById('stk-items-search-filter');
    if (searchFilter) {
        searchFilter.removeAttribute('tabindex');
    }

    const scanInput = document.getElementById('stk-scan-input');

    // الفصل الجذري بين الكمبيوتر والموبايل:
    // تفتح الكاميرا تلقائياً فقط إذا كان الجهاز هاتف محمول/تابلت، وكان المسح قد بدأ من كاميرا الموبايل
    // على الكمبيوتر (الديسكتوب / PC): لا تفتح الكاميرا نهائياً بل يعود الفوكس فوراً لخانة المسح لاستقبال الباركود التالي بسكانر الكمبيوتر
    const isMobile = isMobileDeviceEnvironment();
    const isFromCamera = (batchCardSourceOrigin === 'camera');
    const shouldOpenMobileCamera = isCommit && isFromCamera && isMobile;

    // تصفير المصدر
    batchCardSourceOrigin = 'desktop_input';
    wasCameraActiveBeforeBatch = false;

    if (shouldOpenMobileCamera) {
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
    }
}

// ==================== محرك البحث الموحد داخل شاشة الجرد (يعتمد 100% على كرت الصنف) ====================
let isStkGeneralizedSearch = localStorage.getItem('stk_search_mode')
    ? (localStorage.getItem('stk_search_mode') === 'contains')
    : (localStorage.getItem('catalog_search_mode') === 'contains');
let isStkStockFilterEnabled = false;
let stkSearchDebounceTimer = null;
let stkSearchResults = [];
let stkActiveSearchIndex = -1;
let stkSearchReqSeq = 0;

function updateStkSearchModeUI() {
    const btn = document.getElementById('btn-stk-toggle-search-mode');
    const icon = document.getElementById('stk-search-mode-icon');
    const text = document.getElementById('stk-search-mode-text');
    const sw = document.getElementById('stk-search-mode-switch');
    const knob = document.getElementById('stk-search-mode-knob');

    if (isStkGeneralizedSearch) {
        if (btn) {
            btn.className = 'absolute left-1.5 top-1/2 -translate-y-1/2 px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all duration-200 flex items-center gap-1.5 select-none shadow-xs cursor-pointer border bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-700 active:scale-95';
            btn.title = 'بحث معمم (يحتوي على)';
        }
        if (icon) icon.textContent = '💡';
        if (text) text.textContent = (typeof currentAppLang !== 'undefined' && currentAppLang === 'en') ? 'Contains' : 'معمم';
        if (sw) sw.className = 'w-6 h-3 bg-emerald-800 rounded-full relative transition-colors duration-200 inline-flex items-center p-0.5 pointer-events-none';
        if (knob) knob.className = 'w-2 h-2 bg-white rounded-full shadow-xs transition-transform duration-200 -translate-x-3';
    } else {
        if (btn) {
            btn.className = 'absolute left-1.5 top-1/2 -translate-y-1/2 px-2.5 py-1 rounded-lg text-[11px] font-bold transition-all duration-200 flex items-center gap-1.5 select-none shadow-xs cursor-pointer border bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300 active:scale-95';
            btn.title = 'بحث بالبداية (يبدأ بـ)';
        }
        if (icon) icon.textContent = '🔦';
        if (text) text.textContent = (typeof currentAppLang !== 'undefined' && currentAppLang === 'en') ? 'Starts' : 'بداية';
        if (sw) sw.className = 'w-6 h-3 bg-slate-300 rounded-full relative transition-colors duration-200 inline-flex items-center p-0.5 pointer-events-none';
        if (knob) knob.className = 'w-2 h-2 bg-white rounded-full shadow-xs transition-transform duration-200 translate-x-0';
    }
}

function updateStkStockFilterUI() {
    const btn = document.getElementById('btn-stk-toggle-stock-filter');
    const sw = document.getElementById('stk-stock-filter-switch');
    const knob = document.getElementById('stk-stock-filter-knob');
    const feedbackText = document.getElementById('stk-feedback-text');
    if (btn) btn.setAttribute('aria-pressed', isStkStockFilterEnabled ? 'true' : 'false');

    if (isStkStockFilterEnabled) {
        if (btn) {
            btn.className = 'h-[42px] px-2.5 rounded-xl text-[11px] font-bold transition-all duration-200 flex items-center gap-1.5 select-none shadow-xs cursor-pointer border bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-700 active:scale-95 shrink-0';
        }
        if (sw) sw.className = 'w-6 h-3 bg-emerald-800 rounded-full relative transition-colors duration-200 inline-flex items-center p-0.5 pointer-events-none';
        if (knob) knob.className = 'w-2 h-2 bg-white rounded-full shadow-xs transition-transform duration-200 -translate-x-3 pointer-events-none';
        if (feedbackText && (feedbackText.textContent.includes('جاهز لمسح') || feedbackText.textContent.includes('فلترة البحث بالاسم'))) {
            feedbackText.textContent = `🟢 فلترة المخزون قبل الجرد مفعّلة (البحث بالاسم في مخزون النظام) — الكود والباركود وQR تبقى مباشرة بدون فلترة`;
        }
    } else {
        if (btn) {
            btn.className = 'h-[42px] px-2.5 rounded-xl text-[11px] font-bold transition-all duration-200 flex items-center gap-1.5 select-none shadow-xs cursor-pointer border bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300 active:scale-95 shrink-0';
        }
        if (sw) sw.className = 'w-6 h-3 bg-slate-300 rounded-full relative transition-colors duration-200 inline-flex items-center p-0.5 pointer-events-none';
        if (knob) knob.className = 'w-2 h-2 bg-white rounded-full shadow-xs transition-transform duration-200 translate-x-0 pointer-events-none';
        if (feedbackText && feedbackText.textContent.includes('فلترة البحث بالاسم')) {
            feedbackText.textContent = 'جاهز لمسح الباركود والداتا ماتريكس بالاسكانر...';
        }
    }
}

function isStkCodeOrBarcodeSearch(raw) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return false;
    if (looksLikeDirectBarcodeOrQr(trimmed)) return true;
    const decoded = (typeof decodeArabicKeyboard === 'function') ? decodeArabicKeyboard(trimmed).trim() : trimmed;
    if (/^\d+$/.test(trimmed) || (decoded && /^\d+$/.test(decoded))) return true;
    return false;
}

function closeStkSearchDropdown() {
    const dd = document.getElementById('stk-search-dropdown');
    if (dd) {
        dd.innerHTML = '';
        dd.classList.add('hidden');
    }
    stkActiveSearchIndex = -1;
}

function highlightStkSearchRow() {
    const container = document.getElementById('stk-search-items-list');
    if (!container) return;
    const rows = container.querySelectorAll('.stk-search-item');
    rows.forEach((el, idx) => {
        if (idx === stkActiveSearchIndex) {
            el.classList.add('bg-indigo-50', 'ring-1', 'ring-inset', 'ring-indigo-300');
            el.scrollIntoView({ block: 'nearest' });
        } else {
            el.classList.remove('bg-indigo-50', 'ring-1', 'ring-inset', 'ring-indigo-300');
        }
    });
}

async function selectStocktakeSearchItem(productCode) {
    const scanInput = document.getElementById('stk-scan-input');
    closeStkSearchDropdown();
    stkSearchResults = [];
    if (scanInput) {
        scanInput.value = '';
    }
    await processStoreScan(productCode, productCode);
}

async function fetchAndRenderStkCatalogSearch(rawQuery) {
    const dd = document.getElementById('stk-search-dropdown');
    if (!dd) return;

    const seq = ++stkSearchReqSeq;
    try {
        const mode = isStkGeneralizedSearch ? 'contains' : 'start';
        const isDirectCodeOrBarcode = isStkCodeOrBarcodeSearch(rawQuery);
        const requestStockOnly = isStkStockFilterEnabled && !isDirectCodeOrBarcode;
        const url = `/api/stock/preinventory-search?query=${encodeURIComponent(rawQuery)}&mode=${mode}&stock_only=${requestStockOnly ? '1' : '0'}&limit=100&offset=0`;
        const res = await fetch(url, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (seq !== stkSearchReqSeq) return;
        if (typeof isUnavailableApiResponse === 'function' && isUnavailableApiResponse(res, data)) return;

        const items = data.items || [];
        const total = data.total ?? items.length;
        const effectiveStockFiltered = requestStockOnly && !data.bypassed_stock_filter;
        stkSearchResults = items;
        stkActiveSearchIndex = -1;

        if (items.length === 0) {
            const emptyMsg = effectiveStockFiltered
                ? `لا توجد أصناف ذات رصيد مخزني مسجل قبل الجرد في أي مخزن بالنظام تطابق "<span class="font-bold text-slate-700">${escapeHtml(rawQuery)}</span>"`
                : `لم يتم العثور على أي صنف في كرت الصنف يطابق "<span class="font-bold text-slate-700">${escapeHtml(rawQuery)}</span>"`;
            dd.innerHTML = `
                <div class="p-4 text-center text-slate-400 font-medium">
                    <div class="text-lg mb-1">🔍</div>
                    <div class="text-xs">${emptyMsg}</div>
                </div>
            `;
            dd.classList.remove('hidden');
            return;
        }

        const headerLabel = effectiveStockFiltered
            ? `أصناف لها رصيد أصلي قبل الجرد بالنظام: <span class="text-emerald-700 font-mono">${total.toLocaleString()}</span> صنف (عرض ${items.length})`
            : `بحث المخزون قبل الجرد وكرت الصنف: <span class="text-indigo-700 font-mono">${total.toLocaleString()}</span> صنف (عرض ${items.length})`;
        let html = `
            <div class="sticky top-0 z-10 bg-slate-50 border-b border-slate-200 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px] font-bold text-slate-700">
                <span>${headerLabel}</span>
                <span class="text-[10.5px] text-slate-500 font-medium">اضغط على الصنف أو استخدم ↑↓ و Enter لإضافته لجرد ${escapeHtml(currentActiveStoreNo || '')}</span>
            </div>
            <div id="stk-search-items-list" class="divide-y divide-slate-200 overflow-y-auto max-h-[60vh] bg-white">
        `;

        items.forEach((it, idx) => {
            const engName = it.name_en || it.name || '';
            const arName = it.name_ar || '';
            const sciName = it.scientific_name || '';
            const company = it.company || '';
            const price = parseFloat(it.selling_price || 0).toFixed(2);
            const preStores = Array.isArray(it.pre_inventory_stores) ? it.pre_inventory_stores : [];
            const matchedBatches = Array.isArray(it.matched_batch_numbers) ? it.matched_batch_numbers : [];
            const gList = (it.gtin_list || []).filter(Boolean);
            const bList = (it.barcode_list || []).filter(Boolean);
            const barcodeBadge = bList[0] || it.barcode || '';
            const gtinBadge = gList[0] || it.gtin || '';

            const storeBadgesHtml = preStores.length > 0
                ? preStores.map(st => {
                    const qFmt = Number.isInteger(st.system_qty) ? st.system_qty : Number(st.system_qty || 0).toFixed(2);
                    const bTxt = st.batch_count > 1 ? ` (${st.batch_count} دفعات)` : '';
                    return `<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-50 text-emerald-800 border border-emerald-200 rounded-md font-mono text-[10.5px] font-bold whitespace-nowrap" title="رصيد النظام الأصلي قبل الجرد في ${escapeHtml(st.store_name || st.store_no)}">📦 ${escapeHtml(st.store_no)}${st.store_name ? ` (${escapeHtml(st.store_name)})` : ''}: ${qFmt}${bTxt}</span>`;
                }).join(' ')
                : `<span class="inline-flex items-center px-2 py-0.5 bg-slate-100 text-slate-600 border border-slate-200 rounded-md text-[10.5px] whitespace-nowrap">بدون رصيد مسجل قبل الجرد</span>`;

            const batchMatchBadgeHtml = matchedBatches.length > 0
                ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-100 text-indigo-950 border border-indigo-300 rounded-md text-[10.5px] font-bold whitespace-nowrap"><span>دفعة:</span><strong class="font-mono" dir="ltr">${escapeHtml(matchedBatches.join(', '))}</strong></span>`
                : '';

            html += `
                <div class="stk-search-item p-2.5 px-3 flex flex-col gap-1.5 hover:bg-indigo-50/50 cursor-pointer transition select-none" data-index="${idx}" data-code="${escapeHtml(it.code)}">
                    <div class="flex items-start sm:items-center justify-between gap-2.5 flex-wrap sm:flex-nowrap">
                        <div class="flex items-center gap-2 min-w-0 flex-1 flex-wrap">
                            <span class="font-mono text-[11px] font-bold text-indigo-800 bg-indigo-50 px-2 py-0.5 rounded-lg border border-indigo-200 shadow-2xs shrink-0">${escapeHtml(it.code)}</span>
                            <div class="min-w-0 flex-1">
                                <div class="font-bold text-slate-900 text-xs leading-snug break-words" dir="ltr">${escapeHtml(engName)}</div>
                                ${arName ? `<div class="font-medium text-slate-600 text-[11px] leading-snug mt-0.5">${escapeHtml(arName)}</div>` : ''}
                            </div>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                            <span class="px-2 py-0.5 rounded-lg bg-emerald-50 border border-emerald-200 font-mono font-bold text-emerald-800 text-xs whitespace-nowrap">${price} ر.س</span>
                            <button type="button" class="btn-stk-pick-item px-2.5 py-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-[11px] font-bold transition shadow-xs whitespace-nowrap" data-code="${escapeHtml(it.code)}">
                                ➕ إضافة للجرد
                            </button>
                        </div>
                    </div>
                    <div class="flex flex-wrap items-center justify-between gap-1.5 pt-1.5 border-t border-slate-100">
                        <div class="flex flex-wrap items-center gap-1.5">
                            ${sciName ? `<span class="inline-flex items-center px-2 py-0.5 bg-sky-50 text-sky-800 border border-sky-200 rounded-md text-[10px] font-medium">${escapeHtml(sciName)}</span>` : ''}
                            ${company ? `<span class="inline-flex items-center px-2 py-0.5 bg-amber-50 text-amber-800 border border-amber-200 rounded-md text-[10px] font-medium">${escapeHtml(company)}</span>` : ''}
                            ${barcodeBadge ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-slate-50 border border-slate-200 rounded-md text-[10.5px] text-slate-600 whitespace-nowrap"><span>باركود:</span><strong class="font-mono text-slate-900" dir="ltr">${escapeHtml(barcodeBadge)}</strong></span>` : ''}
                            ${gtinBadge ? `<span class="inline-flex items-center gap-1 px-2 py-0.5 bg-indigo-50/70 border border-indigo-200 rounded-md text-[10.5px] text-indigo-700 whitespace-nowrap"><span dir="ltr">GTIN:</span><strong class="font-mono text-indigo-950" dir="ltr">${escapeHtml(gtinBadge)}</strong></span>` : ''}
                            ${batchMatchBadgeHtml}
                        </div>
                        <div class="flex flex-wrap items-center gap-1.5">
                            ${storeBadgesHtml}
                        </div>
                    </div>
                </div>
            `;
        });

        html += `</div>`;
        dd.innerHTML = html;
        dd.classList.remove('hidden');

        dd.querySelectorAll('.stk-search-item').forEach(row => {
            row.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const code = row.getAttribute('data-code');
                if (code) selectStocktakeSearchItem(code);
            });
        });
    } catch (err) {
        console.error('Stocktake catalog search failed:', err);
    }
}

function looksLikeDirectBarcodeOrQr(raw) {
    if (!raw) return false;
    const decoded = (typeof decodeArabicKeyboard === 'function') ? decodeArabicKeyboard(raw) : raw;
    if (decoded.startsWith('01') && decoded.length >= 16) return true;
    if (raw.includes('(01)') || raw.includes('(10)') || raw.includes('(21)')) return true;
    return false;
}

function initStocktakeCatalogSearch() {
    const scanInput = document.getElementById('stk-scan-input');
    const dropdown = document.getElementById('stk-search-dropdown');
    const btnToggle = document.getElementById('btn-stk-toggle-search-mode');
    const btnStockFilter = document.getElementById('btn-stk-toggle-stock-filter');
    const form = document.getElementById('stk-scan-form');
    if (!scanInput || scanInput._stkSearchBound) return;
    scanInput._stkSearchBound = true;

    updateStkSearchModeUI();
    updateStkStockFilterUI();

    btnStockFilter?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isStkStockFilterEnabled = !isStkStockFilterEnabled;
        updateStkStockFilterUI();
        clearTimeout(stkSearchDebounceTimer);
        const q = scanInput.value.replace(/^\s+/, '');
        if (q && !looksLikeDirectBarcodeOrQr(q)) {
            fetchAndRenderStkCatalogSearch(q);
        }
        scanInput.focus();
    });

    btnToggle?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        isStkGeneralizedSearch = !isStkGeneralizedSearch;
        localStorage.setItem('stk_search_mode', isStkGeneralizedSearch ? 'contains' : 'start');
        updateStkSearchModeUI();
        const q = scanInput.value.replace(/^\s+/, '');
        if (q && !looksLikeDirectBarcodeOrQr(q)) {
            fetchAndRenderStkCatalogSearch(q);
        }
        scanInput.focus();
    });

    scanInput.addEventListener('input', () => {
        clearTimeout(stkSearchDebounceTimer);
        const q = scanInput.value.replace(/^\s+/, '');
        if (!q || looksLikeDirectBarcodeOrQr(q)) {
            closeStkSearchDropdown();
            stkSearchResults = [];
            return;
        }
        stkSearchDebounceTimer = setTimeout(() => {
            fetchAndRenderStkCatalogSearch(q);
        }, 120);
    });

    const handleEnterOrScan = async () => {
        if (scanInput._handlingEnter) return;
        scanInput._handlingEnter = true;
        try {
        clearTimeout(stkSearchDebounceTimer);
        let raw = (scanInput.value || '').replace(/^\s+/, '');
        if (!raw.trim()) return;

        // 1. إذا اختار المستخدم سطراً بالأسهم من قائمة البحث
        const isDropdownOpen = dropdown && !dropdown.classList.contains('hidden');
        if (isDropdownOpen && stkActiveSearchIndex >= 0 && stkSearchResults[stkActiveSearchIndex]) {
            await selectStocktakeSearchItem(stkSearchResults[stkActiveSearchIndex].code);
            return;
        }

        const trimmed = raw.trim();
        // 2. إذا كان مسح QR ثنائي الأبعاد أو باركوداً/كوداً رقمياً بالكامل: نرسله مباشرة لمحرك المسح بدون فلترة
        if (isStkCodeOrBarcodeSearch(trimmed)) {
            closeStkSearchDropdown();
            stkSearchResults = [];
            const decoded = (typeof decodeArabicKeyboard === 'function') ? decodeArabicKeyboard(trimmed) : trimmed;
            scanInput.value = '';
            await processStoreScan(decoded);
            scanInput.focus();
            return;
        }

        // 3. إذا كان بحثاً بالاسم/العلمي/الشركة (أو كوداً مختلطاً مثل 26606n): نجلب النتائج ونعرضها ولا نحول الاسم الفاشل لمسح باركود
        if (!isDropdownOpen || stkSearchResults.length === 0) {
            await fetchAndRenderStkCatalogSearch(raw);
        }
        if (stkSearchResults.length === 1) {
            await selectStocktakeSearchItem(stkSearchResults[0].code);
        } else if (stkSearchResults.length > 1) {
            stkActiveSearchIndex = 0;
            highlightStkSearchRow();
        }
        } finally {
            scanInput._handlingEnter = false;
        }
    };

    scanInput.addEventListener('keydown', async (e) => {
        const isDropdownOpen = dropdown && !dropdown.classList.contains('hidden') && stkSearchResults.length > 0;
        if (e.key === 'ArrowDown' && isDropdownOpen) {
            e.preventDefault();
            stkActiveSearchIndex = (stkActiveSearchIndex + 1) % stkSearchResults.length;
            highlightStkSearchRow();
            return;
        }
        if (e.key === 'ArrowUp' && isDropdownOpen) {
            e.preventDefault();
            stkActiveSearchIndex = (stkActiveSearchIndex - 1 + stkSearchResults.length) % stkSearchResults.length;
            highlightStkSearchRow();
            return;
        }
        if (e.key === 'Escape') {
            closeStkSearchDropdown();
            return;
        }
        const isEnterOrArrow = (e.key === 'Enter' || e.keyCode === 13 || e.which === 13 ||
                                e.key === 'Go' || e.key === 'Search' || e.key === 'Next' ||
                                e.code === 'Enter' || e.code === 'NumpadEnter');
        if (isEnterOrArrow) {
            e.preventDefault();
            e.stopPropagation();
            await handleEnterOrScan();
        }
    });

    scanInput.addEventListener('beforeinput', async (e) => {
        if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
            e.preventDefault();
            e.stopPropagation();
            await handleEnterOrScan();
        }
    });

    form?.addEventListener('submit', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await handleEnterOrScan();
        return false;
    });

    document.addEventListener('click', (e) => {
        if (dropdown && !dropdown.contains(e.target) && e.target !== scanInput && e.target !== btnToggle && !btnToggle?.contains(e.target) && e.target !== btnStockFilter && !btnStockFilter?.contains(e.target)) {
            closeStkSearchDropdown();
        }
    });
}

// مسح صنف للاستور المختار
async function processStoreScan(rawCode, explicitProductCode = '') {
    const feedbackBox = document.getElementById('stk-scan-feedback');
    const feedbackText = document.getElementById('stk-feedback-text');
    const feedbackDetails = document.getElementById('stk-feedback-details');

    try {
        const payload = {
            code: rawCode,
            store_no: currentActiveStoreNo
        };
        if (explicitProductCode) {
            payload.product_code = explicitProductCode;
        }
        const res = await fetch('/api/stock/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();

        if (data.success) {
            if (data.requires_batch_entry) {
                // للأصناف المسحوبة بباركود 1D أو إدخال كود: تفتح اللوحة العلوية لعرض الصنف وباتشاته
                openBatchEntryCard(data, 'desktop_input');
                return;
            }

            // للدواء المسحوب كيو ار (2D DataMatrix): ينزل مباشرة في الفاتورة ويزيد العدد تلقائياً
            closeBatchEntryCard();
            playStockAudioAlert(true);
            if (feedbackBox) {
                feedbackBox.className = 'text-xs font-bold py-1.5 px-3 rounded-lg bg-emerald-50 text-emerald-800 border border-emerald-300 flex items-center justify-between transition';
            }
            if (feedbackText) {
                feedbackText.innerHTML = `✅ ${data.message}`;
            }
            if (feedbackDetails) {
                feedbackDetails.textContent = `الباتش: ${data.batch_number || 'بدون'} | الصلاحية: ${data.expiry_date || '-'}`;
            }

            if (data.store_details) {
                if (data.store_details.store && data.store_details.store.store_no && data.store_details.store.store_no !== currentActiveStoreNo) {
                    currentActiveStoreNo = data.store_details.store.store_no;
                    currentActiveStoreName = data.store_details.store.store_name || '';
                    localStorage.setItem('agy_active_store_no', currentActiveStoreNo);
                    localStorage.setItem('agy_active_store_name', currentActiveStoreName);
                    const displayEl = document.getElementById('stk-active-store-display');
                    const titleEl = document.getElementById('stk-current-counting-title');
                    if (displayEl) displayEl.textContent = `${currentActiveStoreNo} (${currentActiveStoreName})`;
                    if (titleEl) titleEl.textContent = `${currentActiveStoreNo} (${currentActiveStoreName})`;
                }
                renderCurrentStoreDetails(data.store_details);
            }
            loadStocktakeStores();
        } else {
            playStockAudioAlert(false);
            if (data.is_duplicate_serial) {
                if (feedbackBox) {
                    feedbackBox.className = 'text-xs font-bold py-2 px-3 rounded-lg bg-amber-100 text-amber-900 border-2 border-amber-500 flex items-center justify-between animate-pulse';
                }
                if (feedbackText) {
                    feedbackText.innerHTML = `⚠️ <strong>تم منع التكرار:</strong> السيريال (${data.serial}) تم جرده مسبقاً لهذه العبوة!`;
                }
                if (feedbackDetails) {
                    feedbackDetails.textContent = `الصنف: ${data.product_name}`;
                }
            } else {
                if (feedbackBox) {
                    feedbackBox.className = 'text-xs font-bold py-1.5 px-3 rounded-lg bg-rose-50 text-rose-800 border border-rose-300 flex items-center justify-between';
                }
                if (feedbackText) {
                    feedbackText.innerHTML = `❌ ${data.message || 'خطأ أثناء المسح'}`;
                }
                if (feedbackDetails) {
                    feedbackDetails.textContent = rawCode;
                }
            }
        }
    } catch (e) {
        playStockAudioAlert(false);
        if (feedbackText) feedbackText.textContent = 'خطأ في الاتصال: ' + e.message;
    }
}

let isStkStoreSearchGeneralized = localStorage.getItem('stk_store_search_mode') === 'contains';
let stkStoreSearchReqSeq = 0;

function updateStkStoreSearchModeUI() {
    const btn = document.getElementById('btn-stk-store-search-mode');
    const icon = document.getElementById('stk-store-mode-icon');
    const text = document.getElementById('stk-store-mode-text');
    const sw = document.getElementById('stk-store-mode-switch');
    const knob = document.getElementById('stk-store-mode-knob');

    if (isStkStoreSearchGeneralized) {
        if (btn) {
            btn.className = 'absolute left-1 top-1/2 -translate-y-1/2 px-2 py-0.5 rounded text-[10px] font-bold transition-all duration-150 flex items-center gap-1 select-none cursor-pointer border bg-emerald-600 hover:bg-emerald-700 text-white border-emerald-700';
            btn.title = 'بحث معمم داخل الاستور (يحتوي على)';
        }
        if (icon) icon.textContent = '💡';
        if (text) text.textContent = (typeof currentAppLang !== 'undefined' && currentAppLang === 'en') ? 'Contains' : 'معمم';
        if (sw) sw.className = 'w-5 h-2.5 bg-emerald-800 rounded-full relative inline-flex items-center p-0.5 pointer-events-none';
        if (knob) knob.className = 'w-1.5 h-1.5 bg-white rounded-full shadow-xs transition-transform duration-150 -translate-x-2.5 pointer-events-none';
    } else {
        if (btn) {
            btn.className = 'absolute left-1 top-1/2 -translate-y-1/2 px-2 py-0.5 rounded text-[10px] font-bold transition-all duration-150 flex items-center gap-1 select-none cursor-pointer border bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300';
            btn.title = 'بحث بالبداية داخل الاستور (يبدأ بـ)';
        }
        if (icon) icon.textContent = '🔦';
        if (text) text.textContent = (typeof currentAppLang !== 'undefined' && currentAppLang === 'en') ? 'Starts' : 'بداية';
        if (sw) sw.className = 'w-5 h-2.5 bg-slate-300 rounded-full relative inline-flex items-center p-0.5 pointer-events-none';
        if (knob) knob.className = 'w-1.5 h-1.5 bg-white rounded-full shadow-xs transition-transform duration-150 translate-x-0 pointer-events-none';
    }
}

function renderStoreSearchSummary(searchData) {
    const panel = document.getElementById('stk-store-search-summary');
    if (!panel) return;
    const q = String(searchData?.query || '').trim();
    if (!q) {
        panel.innerHTML = '';
        panel.classList.add('hidden');
        return;
    }

    const stNo = searchData.store_no || currentActiveStoreNo || '';
    const stName = searchData.store?.store_name || stNo;
    const summaries = Array.isArray(searchData.product_summaries) ? searchData.product_summaries : [];
    const statusLabelMap = { new: 'جديد', in_progress: 'جاري الجرد', completed: 'معتمد/منتهي', settled: 'مرحّل' };

    if (summaries.length === 0) {
        panel.innerHTML = `
            <div class="flex items-center justify-between text-slate-600 py-1">
                <span>🔍 نتيجة البحث داخل جرد الاستور <strong class="font-mono text-indigo-800">${escapeHtml(stNo)} (${escapeHtml(stName)})</strong> عن "<strong class="text-slate-900">${escapeHtml(q)}</strong>": <span class="font-bold text-rose-700">لا توجد أي أصناف أو بنود مطابقة</span></span>
            </div>
        `;
        panel.classList.remove('hidden');
        return;
    }

    let html = `
        <div class="flex flex-wrap items-center justify-between gap-2 pb-1 border-b border-indigo-200/80 text-[11px] font-bold text-indigo-950">
            <span>📋 نتائج البحث المستقل داخل جرد الاستور: <span class="font-mono text-indigo-700">${escapeHtml(stNo)} (${escapeHtml(stName)})</span> — ${searchData.counted_matches_count || 0} صنف مجرود • ${searchData.uncounted_matches_count || 0} غير مجرود بعد</span>
            <span class="text-[10px] text-slate-500 font-medium">الأرقام تعرض الكمية المعدودة فعلياً في هذا الاستور فقط</span>
        </div>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-1.5 max-h-56 overflow-y-auto pr-0.5">
    `;

    summaries.slice(0, 12).forEach(s => {
        const qFmt = Number.isInteger(s.total_counted_qty) ? s.total_counted_qty : Number(s.total_counted_qty || 0).toFixed(2);
        const sysStoreFmt = Number.isInteger(s.store_system_qty) ? s.store_system_qty : Number(s.store_system_qty || 0).toFixed(2);
        const stCycleLabel = statusLabelMap[s.store_status] || s.store_status || 'جاري';

        if (s.is_counted_in_store) {
            const batchesHtml = (s.batch_rows || []).map(b => {
                const bQty = Number.isInteger(b.counted_qty) ? b.counted_qty : Number(b.counted_qty || 0).toFixed(2);
                return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-white border border-emerald-300 text-emerald-900 font-mono text-[10px]">دفعة: <strong>${escapeHtml(b.batch_number)}</strong>${b.expiry_date && b.expiry_date !== '-' ? ` (${escapeHtml(b.expiry_date)})` : ''} • معدود: <strong>${bQty}</strong></span>`;
            }).join(' ');

            html += `
                <div class="bg-white border border-emerald-300 rounded-lg p-2 flex flex-col gap-1 shadow-xs">
                    <div class="flex items-start justify-between gap-2">
                        <div class="min-w-0">
                            <div class="font-bold text-slate-900 text-xs truncate" dir="ltr">${escapeHtml(s.name_en)}</div>
                            <div class="text-[10.5px] text-slate-600 flex items-center gap-2 flex-wrap">
                                <span class="font-mono font-bold text-indigo-700">${escapeHtml(s.product_code)}</span>
                                ${s.name_ar ? `<span>${escapeHtml(s.name_ar)}</span>` : ''}
                                ${s.barcode ? `<span class="font-mono">باركود: ${escapeHtml(s.barcode)}</span>` : ''}
                            </div>
                        </div>
                        <span class="px-2 py-0.5 rounded-full bg-emerald-600 text-white font-mono font-bold text-[11px] shrink-0">✅ المعدود في ${escapeHtml(stNo)}: ${qFmt}</span>
                    </div>
                    <div class="flex items-center gap-1 flex-wrap pt-0.5">${batchesHtml}</div>
                </div>
            `;
        } else {
            html += `
                <div class="bg-white/90 border border-slate-300 rounded-lg p-2 flex flex-col gap-1">
                    <div class="flex items-start justify-between gap-2">
                        <div class="min-w-0">
                            <div class="font-bold text-slate-800 text-xs truncate" dir="ltr">${escapeHtml(s.name_en)}</div>
                            <div class="text-[10.5px] text-slate-500 flex items-center gap-2 flex-wrap">
                                <span class="font-mono font-bold text-slate-700">${escapeHtml(s.product_code)}</span>
                                ${s.name_ar ? `<span>${escapeHtml(s.name_ar)}</span>` : ''}
                                ${s.barcode ? `<span class="font-mono">باركود: ${escapeHtml(s.barcode)}</span>` : ''}
                            </div>
                        </div>
                        <span class="px-2 py-0.5 rounded-full bg-amber-100 text-amber-900 border border-amber-300 font-bold text-[10.5px] shrink-0">⏳ لم يُجرد بعد في ${escapeHtml(stNo)} (المعدود: 0)</span>
                    </div>
                    <div class="text-[10px] text-slate-500 flex items-center justify-between gap-2">
                        <span>حالة دورة الاستور: <strong>${escapeHtml(stCycleLabel)}</strong> • ${s.store_system_qty > 0 ? `رصيد دفتري خاص بهذا الاستور: <strong class="font-mono">${sysStoreFmt}</strong>` : 'لا يوجد رصيد دفتري مسجل داخل هذا الاستور'}</span>
                    </div>
                </div>
            `;
        }
    });

    html += `</div>`;
    panel.innerHTML = html;
    panel.classList.remove('hidden');
}

// تحميل أو بحث بنود الاستور الحالي فقط (الخانة الثانية المستقلة)
async function loadCurrentStoreItems(searchQ = '') {
    const seq = ++stkStoreSearchReqSeq;
    const rawQ = String(searchQ || '').replace(/^\s+/, '');
    try {
        if (!rawQ.trim()) {
            const url = `/api/stock/store/details?store_no=${encodeURIComponent(currentActiveStoreNo)}`;
            const res = await fetch(url, { cache: 'no-store' });
            const data = await res.json().catch(() => ({}));
            if (seq !== stkStoreSearchReqSeq) return;
            if (isUnavailableApiResponse(res, data) || data.success === false) {
                return;
            }
            renderStoreSearchSummary({ query: '' });
            renderCurrentStoreDetails(data);
            return;
        }

        const mode = isStkStoreSearchGeneralized ? 'contains' : 'start';
        const url = `/api/stock/store/search?store_no=${encodeURIComponent(currentActiveStoreNo)}&query=${encodeURIComponent(rawQ)}&mode=${mode}`;
        const res = await fetch(url, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (seq !== stkStoreSearchReqSeq) return;
        if (isUnavailableApiResponse(res, data) || data.success === false) {
            return;
        }
        renderStoreSearchSummary(data);
        renderCurrentStoreDetails(data.store_details || { store: data.store, items: data.items || [], stats: {} }, rawQ.trim());
    } catch (e) {
        console.error('Failed to load/search store items', e);
        updateConnectionBanner('offline');
    }
}

function renderCurrentStoreDetails(storeData, activeSearchQuery = '') {
    const items = storeData.items || [];
    currentStoreItemsCache = items;
    const stats = storeData.stats || {};
    const formatMoney = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    // تحديث مؤشرات التكلفة في صندوق المسح
    const elSys = document.getElementById('stk-box-sys-cost');
    const elAct = document.getElementById('stk-box-act-cost');
    const elDiff = document.getElementById('stk-box-diff-cost');
    const badgeCount = document.getElementById('stk-items-table-count');

    if (elSys) elSys.textContent = formatMoney(stats.system_cost);
    if (elAct) elAct.textContent = formatMoney(stats.counted_cost);
    if (elDiff) elDiff.textContent = `${stats.diff_cost > 0 ? '+' : ''}${formatMoney(stats.diff_cost)}`;
    if (badgeCount) badgeCount.textContent = `${items.length} بند`;

    // تعبئة جدول الأصناف المجرودة
    const tbody = document.getElementById('stk-items-table-tbody');
    if (!tbody) return;

    if (!items || items.length === 0) {
        const emptyRowMsg = activeSearchQuery
            ? `لم يتم جرد أصناف تطابق "${escapeHtml(activeSearchQuery)}" داخل الاستور (${escapeHtml(currentActiveStoreNo || '')}) حتى الآن.`
            : 'لا توجد أصناف مجرودة في هذا الاستور حتى الآن. ابدأ المسح بالاسكانر مباشرة!';
        tbody.innerHTML = `<tr><td colspan="16" class="p-6 text-center text-slate-400">${emptyRowMsg}</td></tr>`;
        updateStockSelectionBar();
        return;
    }

    let html = '';
    items.forEach((item, idx) => {
        const diff = Number((item.counted_qty || 0) - (item.system_qty || 0)).toFixed(2);
        const totCost = formatMoney((item.counted_qty || 0) * (item.cost_price || 0));
        const totSale = formatMoney((item.counted_qty || 0) * (item.selling_price || 0));

        const batchBadge = item.is_new_batch ?
            `<span class="px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-bold border border-amber-300 text-[10px] whitespace-nowrap">⚠️ باتش جديد</span>` :
            `<span class="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 font-bold border border-emerald-200 text-[10px] whitespace-nowrap">مطابق ✅</span>`;

        const rowBg = item.is_new_batch ? 'bg-amber-50/60 hover:bg-amber-100/60' : (idx % 2 === 0 ? 'bg-white hover:bg-sky-50/40' : 'bg-slate-50/70 hover:bg-sky-50/40');
        const isChecked = selectedStockEntryIds.has(item.id);

        html += `
            <tr class="${rowBg} transition text-slate-700 text-xs">
                <td class="border border-slate-300 p-1 text-center">
                    <input type="checkbox" class="stk-row-chk cursor-pointer rounded border-slate-300 w-3.5 h-3.5" data-id="${item.id}" ${isChecked ? 'checked' : ''}>
                </td>
                <td class="border border-slate-300 p-1 text-center text-slate-500 font-mono text-[11px] select-none bg-slate-50/50">${idx + 1}</td>
                <td class="border border-slate-300 p-1 font-mono font-bold text-slate-900 text-center">${escapeHtml(item.product_code || '')}</td>
                <td class="border border-slate-300 p-1 text-left font-bold text-slate-900 select-text min-w-[260px] whitespace-normal leading-snug" dir="ltr">
                    ${escapeHtml(item.product_name || '')}
                </td>
                <td class="border border-slate-300 p-1 font-mono text-[11px] text-slate-600 text-center" dir="ltr">${escapeHtml(item.gtin || item.barcode || '-')}</td>
                <td class="border border-slate-300 p-1 text-center">
                    ${item.batch_number ? `<span class="px-2 py-0.5 rounded bg-indigo-100 border border-indigo-300 text-indigo-950 font-black font-mono text-xs shadow-sm" dir="ltr">${escapeHtml(String(item.batch_number).toUpperCase())}</span>` : '<span class="text-slate-400 font-mono">-</span>'}
                </td>
                <td class="border border-slate-300 p-1 text-center font-mono font-bold text-slate-900 text-xs" dir="ltr">${escapeHtml(item.expiry_date || '-')}</td>
                <td class="border border-slate-300 p-1 text-center bg-sky-50/40">
                    <span class="font-mono font-black text-slate-900 text-xs px-2 py-0.5 rounded bg-slate-200/80 border border-slate-300 shadow-sm">${item.system_qty}</span>
                </td>
                <td class="border border-slate-300 p-1 text-center bg-emerald-50/40">
                    <div class="inline-flex items-center justify-center gap-1">
                        <button type="button" onclick="quickEditStoreQty(${item.id}, ${item.counted_qty - 1})"
                                class="w-5 h-5 rounded bg-slate-200 hover:bg-slate-300 text-slate-700 font-bold text-xs flex items-center justify-center transition select-none">-</button>
                        <input type="number" min="0" step="1" value="${item.counted_qty}"
                               onchange="saveStoreEntryQty(${item.id}, this.value)"
                               class="w-14 text-center font-mono font-black text-emerald-950 border border-emerald-400 focus:border-indigo-600 rounded py-0.5 bg-white text-xs shadow-inner">
                        <button type="button" onclick="quickEditStoreQty(${item.id}, ${item.counted_qty + 1})"
                                class="w-5 h-5 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs flex items-center justify-center transition select-none">+</button>
                    </div>
                </td>
                <td class="border border-slate-300 p-1 text-center font-mono font-bold text-xs ${diff < 0 ? 'text-rose-600 bg-rose-50/40' : (diff > 0 ? 'text-emerald-700 bg-emerald-50/40' : 'text-slate-400')}">
                    ${diff > 0 ? '+' : ''}${diff}
                </td>
                <td class="border border-slate-300 p-1 text-center font-mono font-bold text-slate-800">${formatMoney(item.cost_price)}</td>
                <td class="border border-slate-300 p-1 text-center font-mono font-bold text-indigo-700">${formatMoney(item.selling_price)}</td>
                <td class="border border-slate-300 p-1 text-center font-mono font-bold text-slate-900">${totCost}</td>
                <td class="border border-slate-300 p-1 text-center font-mono font-bold text-indigo-950">${totSale}</td>
                <td class="border border-slate-300 p-1 text-center">${batchBadge}</td>
                <td class="border border-slate-300 p-1 text-center">
                    <div class="inline-flex items-center gap-1">
                        <button type="button" onclick="openEditStockItemModal(${item.id})" title="تعديل بيانات الصنف"
                                class="p-1 rounded text-indigo-600 hover:bg-indigo-100 transition">
                            ✏️
                        </button>
                        <button type="button" onclick="deleteStoreItem(${item.id})" title="حذف السطر"
                                class="p-1 rounded text-rose-500 hover:bg-rose-100 hover:text-rose-700 transition">
                            🗑️
                        </button>
                    </div>
                </td>
            </tr>
        `;
    });
    tbody.innerHTML = html;

    // ربط مربعات التحديد بكل سطر
    tbody.querySelectorAll('.stk-row-chk').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const id = parseInt(e.target.dataset.id);
            if (e.target.checked) {
                selectedStockEntryIds.add(id);
            } else {
                selectedStockEntryIds.delete(id);
            }
            updateStockSelectionBar();
        });
    });

    updateStockSelectionBar();
}

window.toggleNameExpand = function(tdEl) {
    if (!tdEl) return;
    const textSpan = tdEl.querySelector('.stk-prod-name-text');
    const iconSpan = tdEl.querySelector('.flex-shrink-0');
    if (!textSpan) return;
    if (textSpan.classList.contains('line-clamp-1')) {
        textSpan.classList.remove('line-clamp-1');
        textSpan.classList.add('whitespace-normal');
        tdEl.classList.add('bg-indigo-50/60');
        if (iconSpan) iconSpan.textContent = '⤓';
    } else {
        textSpan.classList.add('line-clamp-1');
        textSpan.classList.remove('whitespace-normal');
        tdEl.classList.remove('bg-indigo-50/60');
        if (iconSpan) iconSpan.textContent = '⤢';
    }
};

async function quickEditStoreQty(id, newQty) {
    if (newQty < 0) newQty = 0;
    await saveStoreEntryQty(id, newQty);
}

async function saveStoreEntryQty(id, newQty) {
    try {
        const res = await fetch('/api/stock/update-qty', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                entry_id: id,
                quantity: parseFloat(newQty) || 0,
                store_no: currentActiveStoreNo
            })
        });
        const data = await res.json();
        if (data.success && data.store_details) {
            const box2Q = (document.getElementById('stk-items-search-filter')?.value || '').replace(/^\s+/, '');
            if (box2Q.trim()) {
                await loadCurrentStoreItems(box2Q);
            } else {
                renderCurrentStoreDetails(data.store_details);
            }
            loadStocktakeStores();
        }
    } catch (e) {
        alert('خطأ: ' + e.message);
    }
}

async function deleteStoreItem(id) {
    if (!confirm('هل تريد بالتأكيد حذف هذا الصنف من الجرد؟')) return;
    try {
        const res = await fetch('/api/stock/delete-item', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                entry_id: id,
                store_no: currentActiveStoreNo
            })
        });
        const data = await res.json();
        if (data.success) {
            selectedStockEntryIds.delete(id);
            updateStockSelectionBar();
            const box2Q = (document.getElementById('stk-items-search-filter')?.value || '').replace(/^\s+/, '');
            if (box2Q.trim() || !data.store_details) {
                await loadCurrentStoreItems(box2Q);
            } else {
                renderCurrentStoreDetails(data.store_details);
            }
            await loadStocktakeStores();
            showCatalogToast('🗑️ تم مسح الصنف من الجرد بنجاح');
        } else {
            alert('فشل المسح: ' + (data.message || 'خطأ'));
        }
    } catch (e) {
        alert('خطأ أثناء المسح: ' + e.message);
    }
}

async function quickExportStoreExcel(storeNo) {
    selectActiveStockStore(storeNo, '');
    const title = currentActiveStoreName ? currentActiveStoreName : storeNo;
    const defaultName = `StockCount_${storeNo}_${title}.xlsx`;
    const stkLoc = document.getElementById('select-stocktake-export-location')?.value || (window.getSelectedExportLocation ? window.getSelectedExportLocation() : 'PH004/Stock');
    const qs = new URLSearchParams({ store_no: storeNo, title: title });
    if (stkLoc && stkLoc !== '__SHEET_NAME__') qs.set('location_val', stkLoc);
    const url = `/api/stock/export-excel?${qs.toString()}`;
    showCatalogToast('📊 جاري سحب الإكسيل وحفظ الملف وفتحه في Excel تلقائياً...');
    await window.downloadAndTriggerSave(url, defaultName);
}

function quickPrintStore(storeNo) {
    selectActiveStockStore(storeNo, '');
    const title = currentActiveStoreName ? `${currentActiveStoreName}` : storeNo;
    printStoreStocktakeView(title);
}

// نافذة اختيار مسمى الورقة والملف (1-50 مع MEDICINE / COSMETICS)
function openSheetNamingDialogForStock(onConfirmCallback) {
    const modal = document.getElementById('modal-pre-print-name');
    const inputName = document.getElementById('modal-sheet-name-input');
    const btnConfirm = document.getElementById('btn-confirm-pre-print');
    const btnCancel = document.getElementById('btn-cancel-pre-print');
    const btnClose = document.getElementById('btn-close-pre-print-modal');

    if (!modal) {
        const val = prompt('أدخل اسم التقرير / الورقة:', `${currentActiveStoreName} 1`);
        if (val && onConfirmCallback) onConfirmCallback(val.trim());
        return;
    }

    if (inputName) {
        inputName.value = `${currentActiveStoreName} 1`;
    }

    const doConfirm = () => {
        const finalTitle = inputName?.value?.trim() || `${currentActiveStoreName} 1`;
        modal.classList.add('hidden');
        cleanup();
        if (onConfirmCallback) onConfirmCallback(finalTitle);
    };

    const doCancel = () => {
        modal.classList.add('hidden');
        cleanup();
    };

    const cleanup = () => {
        btnConfirm?.removeEventListener('click', doConfirm);
        btnCancel?.removeEventListener('click', doCancel);
        btnClose?.removeEventListener('click', doCancel);
    };

    btnConfirm?.addEventListener('click', doConfirm);
    btnCancel?.addEventListener('click', doCancel);
    btnClose?.addEventListener('click', doCancel);

    modal.classList.remove('hidden');
    inputName?.focus();
}

// دالة طباعة تقرير الجرد المتطابقة تماماً مع طباعة الفاتورة الاحترافية
async function printStoreStocktakeView(reportTitle) {
    try {
        const res = await fetch(`/api/stock/store/details?store_no=${encodeURIComponent(currentActiveStoreNo)}`);
        const data = await res.json();
        const items = data.items || [];
        const stats = data.stats || {};
        const stInfo = data.store || {};

        const sheetTitle = (reportTitle || `${stInfo.store_name || currentActiveStoreNo} 1`).trim();
        const formatMoney = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const todayStr = new Date().toISOString().slice(0, 10);
        const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

        const printHtml = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>${sheetTitle}</title>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        * {
            box-sizing: border-box;
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
        }
        body {
            font-family: 'Cairo', Tahoma, Arial, sans-serif;
            margin: 0;
            padding: 16px;
            color: #0f172a;
            background: #fff;
            font-size: 11px;
        }
        .no-print-bar {
            background: #0f172a;
            color: #fff;
            padding: 10px 16px;
            border-radius: 12px;
            margin-bottom: 16px;
            display: flex;
            flex-direction: column;
            gap: 8px;
            box-shadow: 0 4px 14px rgba(15,23,42,0.18);
        }
        .no-print-row {
            display: flex;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
            gap: 10px;
        }
        .no-print-bar button {
            font-family: 'Cairo', sans-serif;
            cursor: pointer;
            border: none;
            border-radius: 6px;
            padding: 5px 12px;
            font-size: 11.5px;
            font-weight: 700;
            transition: 0.15s;
        }
        .btn-print-now { background: #10b981; color: #fff; font-size: 13px !important; padding: 6px 18px !important; }
        .btn-print-now:hover { background: #059669; }
        .btn-cat-pill { background: #1e293b; color: #fbbf24; border: 1px solid #f59e0b !important; font-family: monospace !important; }
        .btn-cat-pill:hover { background: #f59e0b; color: #0f172a; }
        .btn-close { background: #ef4444; color: #fff; }

        /* الترويسة الاحترافية المتكررة في جميع صفحات الطباعة: لوجو R [A • M • B • F] E + العنوان البارز (مثل MEDICINE 1) + ملخص التكلفة والبيع */
        thead {
            display: table-header-group !important;
        }
        tfoot {
            display: table-footer-group !important;
        }
        tr {
            page-break-inside: avoid;
            break-inside: avoid;
        }
        th.repeating-header-cell {
            background: #ffffff !important;
            color: #0f172a !important;
            border: none !important;
            padding: 0 0 10px 0 !important;
        }
        .pro-print-header {
            border: 2.5px solid #0f172a;
            border-radius: 12px;
            padding: 10px 16px;
            display: grid;
            grid-template-columns: 1fr auto 1fr;
            align-items: center;
            gap: 12px;
            background: linear-gradient(180deg, #f8fafc 0%, #f1f5f9 100%) !important;
            direction: rtl;
        }
        .brand-logo-box {
            display: flex;
            align-items: center;
            gap: 10px;
            direction: ltr;
            justify-self: start;
        }
        .ramadan-logo-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%) !important;
            border: 2px solid #f59e0b;
            border-radius: 10px;
            padding: 5px 8px;
            box-shadow: 0 2px 6px rgba(15,23,42,0.16);
            direction: ltr;
        }
        .ramadan-monogram {
            width: 30px;
            height: 30px;
            border-radius: 7px;
            background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%) !important;
            color: #0f172a !important;
            font-family: Consolas, Monaco, monospace;
            font-size: 18px;
            font-weight: 900;
            display: flex;
            align-items: center;
            justify-content: center;
            overflow: hidden;
        }
        .ramadan-mid-letters {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            background: #0f172a !important;
            border: 1px solid rgba(251, 191, 36, 0.45);
            border-radius: 6px;
            padding: 2px 7px;
            font-family: Consolas, Monaco, monospace;
            font-size: 13.5px;
            font-weight: 900;
            color: #ffffff !important;
            line-height: 1.1;
        }
        .ramadan-mid-dot {
            color: #fbbf24 !important;
            font-size: 9px;
        }
        .ramadan-end-monogram {
            width: 30px;
            height: 30px;
            border-radius: 7px;
            background: #0f172a !important;
            color: #fbbf24 !important;
            border: 1.5px solid #f59e0b;
            font-family: Consolas, Monaco, monospace;
            font-size: 18px;
            font-weight: 900;
            display: flex;
            align-items: center;
            justify-content: center;
        }

        /* العنوان الرئيسي البارز في المنتصف (مثل MEDICINE 1 / COSMETICS 1) */
        .hero-title-center {
            text-align: center;
            padding: 6px 26px;
            background: #0f172a !important;
            color: #ffffff !important;
            border: 3px solid #f59e0b;
            border-radius: 12px;
            min-width: 240px;
            box-shadow: 0 3px 10px rgba(15,23,42,0.15);
        }
        .hero-title-label {
            display: block;
            font-size: 9px;
            font-weight: 700;
            color: #fbbf24 !important;
            letter-spacing: 0.8px;
            margin-bottom: 1px;
        }
        .hero-title-value {
            font-family: Consolas, Monaco, 'Cairo', monospace;
            font-size: 24px;
            font-weight: 900;
            letter-spacing: 1.5px;
            color: #ffffff !important;
            direction: ltr;
            line-height: 1.15;
            text-transform: uppercase;
        }

        /* ملخص الجرد والتاريخ على اليسار */
        .header-stats-left {
            display: flex;
            flex-direction: column;
            align-items: flex-end;
            gap: 4px;
            justify-self: end;
        }
        .stats-pills-row {
            display: flex;
            gap: 5px;
            flex-wrap: wrap;
            justify-content: flex-end;
        }
        .stat-pill {
            border: 1.5px solid #94a3b8;
            background: #ffffff !important;
            border-radius: 8px;
            padding: 2px 7px;
            text-align: center;
            min-width: 65px;
        }
        .stat-pill .lbl {
            font-size: 8.5px;
            font-weight: 700;
            color: #475569;
            display: block;
        }
        .stat-pill .val {
            font-size: 11.5px;
            font-weight: 900;
            font-family: Consolas, Monaco, monospace;
            color: #0f172a;
        }
        .meta-date-line {
            font-size: 10px;
            color: #334155;
            font-weight: 700;
            font-family: Consolas, Monaco, 'Cairo', monospace;
        }

        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 0;
            direction: rtl;
        }
        th, td {
            border: 1.2px solid #334155;
            padding: 5px 6px;
            font-size: 10.5px;
            text-align: center;
        }
        th {
            background: #1e293b !important;
            color: #ffffff !important;
            font-weight: 800;
            font-family: 'Cairo', Consolas, Monaco, monospace;
            font-size: 10.5px;
        }
        td.name-cell {
            text-align: right;
            font-weight: 700;
            color: #0f172a;
        }
        tr:nth-child(even) td { background: #f8fafc; }
        .batch-new { background: #fef3c7 !important; color: #92400e !important; font-weight: bold; }
        tfoot td {
            background: #e2e8f0 !important;
            color: #0f172a !important;
            font-weight: 900;
            border-top: 2px solid #0f172a;
        }
        @media print {
            .no-print-bar { display: none !important; }
            body { padding: 0; }
            @page { size: A4 landscape; margin: 8mm; }
        }
    </style>
</head>
<body>
    <div class="no-print-bar">
        <div class="no-print-row">
            <div style="display:flex;align-items:center;gap:10px;">
                <button class="btn-print-now" onclick="window.print()">🖨️ طباعة الآن (Ctrl + P)</button>
                <button class="btn-close" onclick="window.close()">✕ إغلاق</button>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
                <span style="color:#94a3b8;font-size:11px;">تعديل مسمى الورقة:</span>
                <input type="text" id="interactive-title-input" value="${sheetTitle}"
                       style="padding:4px 8px;border-radius:6px;border:1px solid #475569;background:#1e293b;color:#fff;font-family:monospace;font-weight:bold;font-size:12px;width:180px;text-align:center;"
                       oninput="document.querySelectorAll('.hero-title-value').forEach(el => el.textContent = this.value); document.title = this.value;">
            </div>
        </div>
        <div class="no-print-row" style="padding-top:4px;border-top:1px solid #334155;">
            <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
                <span style="color:#fbbf24;font-size:10px;font-weight:bold;">اختيار سريع:</span>
                <button class="btn-cat-pill" onclick="setTitlePreset('MEDICINE 1')">MEDICINE 1</button>
                <button class="btn-cat-pill" onclick="setTitlePreset('MEDICINE 2')">MEDICINE 2</button>
                <button class="btn-cat-pill" onclick="setTitlePreset('COSMETICS 1')">COSMETICS 1</button>
                <button class="btn-cat-pill" onclick="setTitlePreset('COSMETICS 2')">COSMETICS 2</button>
                <button class="btn-cat-pill" onclick="setTitlePreset('${stInfo.store_name || currentActiveStoreNo}')">${stInfo.store_name || currentActiveStoreNo}</button>
            </div>
        </div>
    </div>

    <!-- جدول الأصناف مع الترويسة المتكررة في كل الصفحات داخل thead -->
    <table id="print-table">
        <thead>
            <tr>
                <th colspan="14" class="repeating-header-cell">
                    <div class="pro-print-header">
                        <!-- 1. الشعار على اليمين بالإنجليزية R [A • M • B • F] E -->
                        <div class="brand-logo-box">
                            <div class="ramadan-logo-badge">
                                <div class="ramadan-monogram">R</div>
                                <div class="ramadan-mid-col">
                                    <div class="ramadan-mid-letters">
                                        <span>A</span><span class="ramadan-mid-dot">•</span>
                                        <span>M</span><span class="ramadan-mid-dot">•</span>
                                        <span>B</span><span class="ramadan-mid-dot">•</span>
                                        <span>F</span>
                                    </div>
                                    <div class="ramadan-brand-sub">RAMADAN PHARMACY</div>
                                </div>
                                <div class="ramadan-end-monogram">E</div>
                            </div>
                        </div>

                        <!-- 2. العنوان البارز المختار في المنتصف (مثل MEDICINE 1 أو COSMETICS 1) -->
                        <div class="hero-title-center">
                            <span class="hero-title-label">STORE STOCKTAKE / كشف جرد الاستور</span>
                            <span class="hero-title-value">${sheetTitle}</span>
                        </div>

                        <!-- 3. ملخص الجرد والتكلفة وسعر البيع على اليسار -->
                        <div class="header-stats-left">
                            <div class="stats-pills-row">
                                <div class="stat-pill">
                                    <span class="lbl">الأصناف</span>
                                    <span class="val">${items.length}</span>
                                </div>
                                <div class="stat-pill">
                                    <span class="lbl">الكمية</span>
                                    <span class="val">${stats.counted_qty || 0}</span>
                                </div>
                                <div class="stat-pill">
                                    <span class="lbl">تكلفة الجرد</span>
                                    <span class="val">${formatMoney(stats.counted_cost)}</span>
                                </div>
                                <div class="stat-pill">
                                    <span class="lbl">بيع الجرد</span>
                                    <span class="val">${formatMoney(stats.counted_sale)}</span>
                                </div>
                                <div class="stat-pill">
                                    <span class="lbl">فرق التكلفة</span>
                                    <span class="val">${stats.diff_cost > 0 ? '+' : ''}${formatMoney(stats.diff_cost)}</span>
                                </div>
                            </div>
                            <div class="meta-date-line">
                                <span>${stInfo.store_name || currentActiveStoreNo} (${currentActiveStoreNo})</span>
                                <span> | </span>
                                <span>${todayStr} ${timeStr}</span>
                            </div>
                        </div>
                    </div>
                </th>
            </tr>
            <!-- أعمدة جدول الجرد الكاملة -->
            <tr>
                <th style="width:25px;">م</th>
                <th style="width:75px;">كود الصنف</th>
                <th>اسم الصنف</th>
                <th style="width:95px;">الباركود / GTIN</th>
                <th style="width:75px;">التشغيلة (Batch)</th>
                <th style="width:70px;">الصلاحية (Exp)</th>
                <th style="width:60px;">رصيد المخزون</th>
                <th style="width:60px;background:#312e81 !important;">الرصيد الفعلي (الجرد)</th>
                <th style="width:50px;">الفرق</th>
                <th style="width:65px;">سعر التكلفة</th>
                <th style="width:65px;">سعر البيع</th>
                <th style="width:75px;">إجمالي التكلفة</th>
                <th style="width:75px;">إجمالي البيع</th>
                <th style="width:65px;">حالة الباتش</th>
            </tr>
        </thead>
        <tbody>
            ${items.length === 0 ? '<tr><td colspan="14" style="padding:25px;color:#64748b;text-align:center;">لا توجد أصناف مجرودة في هذا الاستور حتى الآن</td></tr>' :
                items.map((it, idx) => {
                    const diff = Number((it.counted_qty || 0) - (it.system_qty || 0)).toFixed(2);
                    const totC = formatMoney((it.counted_qty || 0) * (it.cost_price || 0));
                    const totS = formatMoney((it.counted_qty || 0) * (it.selling_price || 0));
                    const isNew = it.is_new_batch;
                    return `
                        <tr class="${isNew ? 'batch-new' : ''}">
                            <td style="font-family:monospace;">${idx + 1}</td>
                            <td style="font-family:monospace;font-weight:bold;">${it.product_code}</td>
                            <td class="name-cell">${it.product_name}</td>
                            <td style="font-family:monospace;font-size:9.5px;">${it.gtin || it.barcode || '-'}</td>
                            <td style="font-family:monospace;font-weight:bold;">${String(it.batch_number || '-').toUpperCase()}</td>
                            <td style="font-family:monospace;">${it.expiry_date || '-'}</td>
                            <td style="font-family:monospace;">${it.system_qty}</td>
                            <td style="font-family:monospace;font-weight:bold;font-size:11.5px;background:#eef2ff;">${it.counted_qty}</td>
                            <td style="font-family:monospace;font-weight:bold;">${diff > 0 ? '+' : ''}${diff}</td>
                            <td style="font-family:monospace;">${formatMoney(it.cost_price)}</td>
                            <td style="font-family:monospace;color:#1e3a8a;font-weight:bold;">${formatMoney(it.selling_price)}</td>
                            <td style="font-family:monospace;font-weight:bold;">${totC}</td>
                            <td style="font-family:monospace;font-weight:bold;color:#1e3a8a;">${totS}</td>
                            <td>${isNew ? '⚠️ جديد' : 'مطابق'}</td>
                        </tr>
                    `;
                }).join('')
            }
        </tbody>
        <tfoot>
            <tr>
                <td colspan="6" style="text-align:right;padding-right:12px;font-weight:bold;">Grand Totals (الإجماليات العامة للمطابقة):</td>
                <td style="font-family:monospace;">${stats.system_qty || 0}</td>
                <td style="font-family:monospace;font-size:12px;">${stats.counted_qty || 0}</td>
                <td style="font-family:monospace;">${stats.diff_qty > 0 ? '+' : ''}${stats.diff_qty || 0}</td>
                <td>-</td>
                <td>-</td>
                <td style="font-family:monospace;font-size:11.5px;">${formatMoney(stats.counted_cost)}</td>
                <td style="font-family:monospace;font-size:11.5px;color:#1e3a8a;">${formatMoney(stats.counted_sale)}</td>
                <td>-</td>
            </tr>
        </tfoot>
    </table>

    <script>
        function setTitlePreset(preset) {
            const inp = document.getElementById('interactive-title-input');
            if (inp) {
                inp.value = preset;
                document.querySelectorAll('.hero-title-value').forEach(el => el.textContent = preset);
                document.title = preset;
            }
        }
        window.onload = function() {
            setTimeout(function() { window.print(); }, 250);
        };
    </script>
</body>
</html>`;

        const printWin = window.open('', '_blank', 'width=1100,height=850');
        if (printWin) {
            printWin.document.open();
            printWin.document.write(printHtml);
            printWin.document.close();
        } else {
            alert('يُرجى السماح بالنوافذ المنبثقة لإجراء الطباعة.');
        }
    } catch (e) {
        alert('خطأ أثناء تجهيز الطباعة: ' + e.message);
    }
}

// دالة طباعة تقرير الأصناف التي لم تُجرد (PRINT ESTIMATED NOT FOUND)
async function printUncountedItemsView(byCategory = false, overrideItems = null) {
    try {
        let items = [];
        let stats = {};
        let stInfo = {};
        let cats = {};

        if (overrideItems && Array.isArray(overrideItems)) {
            items = overrideItems;
            const totalQty = items.reduce((acc, it) => acc + (parseFloat(it.system_qty) || 0), 0);
            const totalCost = items.reduce((acc, it) => acc + (parseFloat(it.total_cost) || 0), 0);
            const totalSale = items.reduce((acc, it) => acc + (parseFloat(it.total_sale) || 0), 0);
            stats = {
                total_uncounted_items: items.length,
                total_uncounted_qty: totalQty,
                total_uncounted_cost: totalCost,
                total_uncounted_sale: totalSale
            };
            stInfo = currentUncountedData?.store || { store_no: currentActiveStoreNo, store_name: currentActiveStoreName };
        } else {
            const res = await fetch(`/api/stock/uncounted?store_no=${encodeURIComponent(currentActiveStoreNo)}`);
            const data = await res.json();
            items = data.items || [];
            stats = data.stats || {};
            stInfo = data.store || {};
            cats = data.categories_summary || {};
        }

        if (items.length === 0) {
            alert('تهانينا! جميع أصناف المخزون لهذا الاستور تم جردها بالكامل، لا توجد أصناف غير مجرودة.');
            return;
        }

        const sheetTitle = byCategory ? `NOT FOUND BY CATEGORIES` : `ESTIMATED NOT FOUND`;
        const formatMoney = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const todayStr = new Date().toISOString().slice(0, 10);
        const timeStr = new Date().toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' });

        let tableRowsHtml = '';

        if (!byCategory) {
            tableRowsHtml = items.map((it, idx) => `
                <tr>
                    <td style="font-family:monospace;">${idx + 1}</td>
                    <td style="font-family:monospace;font-weight:bold;">${it.product_code}</td>
                    <td class="name-cell">${it.product_name}</td>
                    <td style="font-family:monospace;font-size:9.5px;">${it.barcode || '-'}</td>
                    <td style="font-family:monospace;font-weight:bold;color:#b91c1c;">${String(it.batch_number || '-').toUpperCase()}</td>
                    <td style="font-family:monospace;">${it.expiry_date || '-'}</td>
                    <td style="font-family:monospace;font-weight:bold;background:#fee2e2;color:#991b1b;">${it.system_qty}</td>
                    <td style="font-family:monospace;">${formatMoney(it.cost_price)}</td>
                    <td style="font-family:monospace;">${formatMoney(it.selling_price)}</td>
                    <td style="font-family:monospace;font-weight:bold;color:#991b1b;">${formatMoney(it.total_cost)}</td>
                    <td style="font-family:monospace;font-weight:bold;">${formatMoney(it.total_sale)}</td>
                    <td style="font-size:10px;">${it.category || 'عام'}</td>
                </tr>
            `).join('');
        } else {
            // تجميع وتفصيل حسب الأقسام
            const grouped = {};
            items.forEach(it => {
                const k = it.category || 'عام';
                if (!grouped[k]) grouped[k] = [];
                grouped[k].push(it);
            });

            let globalIdx = 1;
            for (const [catName, catItems] of Object.entries(grouped)) {
                const catSummary = cats[catName] || {};
                tableRowsHtml += `
                    <tr style="background:#f1f5f9;border-top:2px solid #0f172a;border-bottom:2px solid #0f172a;">
                        <td colspan="6" style="text-align:right;font-weight:900;font-size:12px;color:#0f172a;padding:7px 10px;">
                            📂 القسم: <span style="color:#b91c1c;">${catName}</span> (${catItems.length} صنف غير مجرود)
                        </td>
                        <td style="font-family:monospace;font-weight:900;background:#fee2e2;color:#991b1b;">${catSummary.qty || 0}</td>
                        <td colspan="2">-</td>
                        <td style="font-family:monospace;font-weight:900;color:#991b1b;">${formatMoney(catSummary.cost)}</td>
                        <td style="font-family:monospace;font-weight:900;">${formatMoney(catSummary.sale)}</td>
                        <td>-</td>
                    </tr>
                `;
                catItems.forEach(it => {
                    tableRowsHtml += `
                        <tr>
                            <td style="font-family:monospace;">${globalIdx++}</td>
                            <td style="font-family:monospace;font-weight:bold;">${it.product_code}</td>
                            <td class="name-cell">${it.product_name}</td>
                            <td style="font-family:monospace;font-size:9.5px;">${it.barcode || '-'}</td>
                            <td style="font-family:monospace;font-weight:bold;color:#b91c1c;">${String(it.batch_number || '-').toUpperCase()}</td>
                            <td style="font-family:monospace;">${it.expiry_date || '-'}</td>
                            <td style="font-family:monospace;font-weight:bold;background:#fff1f2;color:#991b1b;">${it.system_qty}</td>
                            <td style="font-family:monospace;">${formatMoney(it.cost_price)}</td>
                            <td style="font-family:monospace;">${formatMoney(it.selling_price)}</td>
                            <td style="font-family:monospace;font-weight:bold;color:#991b1b;">${formatMoney(it.total_cost)}</td>
                            <td style="font-family:monospace;font-weight:bold;">${formatMoney(it.total_sale)}</td>
                            <td style="font-size:10px;">${it.category || 'عام'}</td>
                        </tr>
                    `;
                });
            }
        }

        const printHtml = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
    <meta charset="UTF-8">
    <title>${sheetTitle} - ${stInfo.store_name || currentActiveStoreNo}</title>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&display=swap" rel="stylesheet">
    <style>
        * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
        body { font-family: 'Cairo', Tahoma, Arial, sans-serif; margin: 0; padding: 16px; color: #0f172a; background: #fff; font-size: 11px; }
        .no-print-bar { background: #991b1b; color: #fff; padding: 10px 16px; border-radius: 12px; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .no-print-bar button { font-family: 'Cairo', sans-serif; cursor: pointer; border: none; border-radius: 6px; padding: 6px 16px; font-size: 12px; font-weight: 700; }
        .btn-print-now { background: #10b981; color: #fff; }
        .btn-close { background: #475569; color: #fff; }
        thead { display: table-header-group !important; }
        tfoot { display: table-footer-group !important; }
        tr { page-break-inside: avoid; break-inside: avoid; }
        th.repeating-header-cell { background: #fff !important; border: none !important; padding: 0 0 10px 0 !important; }
        .pro-print-header { border: 2.5px solid #991b1b; border-radius: 12px; padding: 10px 16px; display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 16px; background: #fff; margin-bottom: 8px; }
        .ramadan-logo-badge { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border: 1.5px solid #991b1b; border-radius: 9px; background: #fff; }
        .ramadan-monogram { width: 30px; height: 30px; border-radius: 7px; background: #991b1b !important; color: #fff !important; font-family: monospace; font-size: 18px; font-weight: 900; display: flex; align-items: center; justify-content: center; }
        .ramadan-mid-letters { display: inline-flex; align-items: center; gap: 3px; background: #0f172a; border-radius: 5px; padding: 2px 6px; font-family: monospace; font-size: 13px; font-weight: 900; color: #fff; }
        .ramadan-brand-sub { font-size: 8px; font-weight: 800; color: #991b1b; text-align: center; }
        .hero-title-center { text-align: center; padding: 6px 20px; background: #991b1b; color: #fff; border: 2px solid #b91c1c; border-radius: 10px; min-width: 250px; }
        .hero-title-label { display: block; font-size: 9.5px; font-weight: 700; color: #fecaca; }
        .hero-title-value { font-family: monospace; font-size: 20px; font-weight: 900; color: #fff; text-transform: uppercase; }
        .header-stats-left { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
        .stats-pills-row { display: flex; align-items: center; gap: 5px; }
        .stat-pill { border: 1.5px solid #b91c1c; border-radius: 7px; padding: 2px 7px; text-align: center; background: #fef2f2; }
        .stat-pill .lbl { display: block; font-size: 8.5px; color: #7f1d1d; font-weight: 700; }
        .stat-pill .val { font-family: monospace; font-size: 11px; font-weight: 900; color: #991b1b; }
        table { width: 100%; border-collapse: collapse; direction: rtl; }
        th, td { border: 1.2px solid #475569; padding: 5px 6px; font-size: 10.5px; text-align: center; }
        th { background: #991b1b !important; color: #fff !important; font-weight: 800; }
        td.name-cell { text-align: right; font-weight: 700; color: #0f172a; }
        tr:nth-child(even) td { background: #fff1f2; }
        tfoot td { background: #f1f5f9 !important; font-weight: 900; border-top: 2px solid #0f172a; }
        @media print { .no-print-bar { display: none !important; } body { padding: 0; } @page { size: A4 landscape; margin: 8mm; } }
    </style>
</head>
<body>
    <div class="no-print-bar">
        <div style="display:flex;align-items:center;gap:10px;">
            <button class="btn-print-now" onclick="window.print()">🖨️ طباعة تقرير الأصناف غير المجرودة (Ctrl + P)</button>
            <button class="btn-close" onclick="window.close()">✕ إغلاق</button>
        </div>
        <div style="font-weight:bold;font-size:12px;">
            ⚠️ تقرير الأصناف المسجلة في المخزون والتي لم يتم جردها أو العثور عليها في هذا الاستور
        </div>
    </div>

    <table>
        <thead>
            <tr>
                <th colspan="12" class="repeating-header-cell">
                    <div class="pro-print-header">
                        <div class="ramadan-logo-badge">
                            <div class="ramadan-monogram">R</div>
                            <div style="display:flex;flex-direction:column;align-items:center;">
                                <div class="ramadan-mid-letters">A • M • B • F</div>
                                <div class="ramadan-brand-sub">RAMADAN PHARMACY</div>
                            </div>
                        </div>

                        <div class="hero-title-center">
                            <span class="hero-title-label">تقرير العجز / الأصناف التي لم تُجرد</span>
                            <span class="hero-title-value">${sheetTitle}</span>
                        </div>

                        <div class="header-stats-left">
                            <div class="stats-pills-row">
                                <div class="stat-pill"><span class="lbl">أصناف لم تُجرد</span><span class="val">${stats.total_uncounted_items || 0}</span></div>
                                <div class="stat-pill"><span class="lbl">كمية المخزون المفقودة</span><span class="val">${stats.total_uncounted_qty || 0}</span></div>
                                <div class="stat-pill"><span class="lbl">إجمالي التكلفة</span><span class="val">${formatMoney(stats.total_uncounted_cost)}</span></div>
                                <div class="stat-pill"><span class="lbl">إجمالي البيع</span><span class="val">${formatMoney(stats.total_uncounted_sale)}</span></div>
                            </div>
                            <div style="font-size:9.5px;color:#475569;font-weight:bold;">
                                ${stInfo.store_name || currentActiveStoreNo} (${currentActiveStoreNo}) | ${todayStr} ${timeStr}
                            </div>
                        </div>
                    </div>
                </th>
            </tr>
            <tr>
                <th style="width:25px;">م</th>
                <th style="width:75px;">كود الصنف</th>
                <th>اسم الصنف</th>
                <th style="width:95px;">الباركود</th>
                <th style="width:75px;">الباتش</th>
                <th style="width:70px;">الصلاحية</th>
                <th style="width:65px;background:#7f1d1d !important;">رصيد لم يُجرد</th>
                <th style="width:65px;">سعر التكلفة</th>
                <th style="width:65px;">سعر البيع</th>
                <th style="width:75px;">إجمالي التكلفة</th>
                <th style="width:75px;">إجمالي البيع</th>
                <th style="width:75px;">القسم</th>
            </tr>
        </thead>
        <tbody>
            ${tableRowsHtml}
        </tbody>
        <tfoot>
            <tr>
                <td colspan="6" style="text-align:right;padding-right:12px;font-weight:bold;">إجمالي الأصناف التي لم تُجرد:</td>
                <td style="font-family:monospace;font-size:12px;color:#991b1b;">${stats.total_uncounted_qty || 0}</td>
                <td>-</td>
                <td>-</td>
                <td style="font-family:monospace;font-size:11.5px;color:#991b1b;">${formatMoney(stats.total_uncounted_cost)}</td>
                <td style="font-family:monospace;font-size:11.5px;">${formatMoney(stats.total_uncounted_sale)}</td>
                <td>-</td>
            </tr>
        </tfoot>
    </table>

    <script>
        window.onload = function() {
            setTimeout(function() { window.print(); }, 250);
        };
    </script>
</body>
</html>`;

        const printWin = window.open('', '_blank', 'width=1100,height=850');
        if (printWin) {
            printWin.document.open();
            printWin.document.write(printHtml);
            printWin.document.close();
        } else {
            alert('يُرجى السماح بالنوافذ المنبثقة لإجراء الطباعة.');
        }
    } catch (e) {
        alert('خطأ أثناء تجهيز طباعة الأصناف التي لم تُجرد: ' + e.message);
    }
}

// =========================================================================
// ملف تقرير الأصناف التي لم تُجرد مع خاصية البحث والفلترة والطباعة
// =========================================================================
let currentUncountedData = null;
let currentUncountedItemsList = [];

async function openUncountedItemsModal(storeNo = currentActiveStoreNo) {
    const modal = document.getElementById('modal-uncounted-items');
    if (!modal) return;
    modal.classList.remove('hidden');

    const badge = document.getElementById('uncounted-modal-store-badge');
    if (badge) badge.textContent = `${storeNo} (${currentActiveStoreName || ''})`;

    const tbody = document.getElementById('uncounted-items-tbody');
    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="12" class="p-6 text-center text-slate-400">جاري تحميل تقرير الأصناف غير المجرودة...</td></tr>`;
    }

    try {
        const res = await fetch(`/api/stock/uncounted?store_no=${encodeURIComponent(storeNo)}`);
        const data = await res.json();
        currentUncountedData = data;
        currentUncountedItemsList = data.items || [];

        // تعبئة قائمة الأقسام
        const catSelect = document.getElementById('uncounted-category-filter');
        if (catSelect) {
            const cats = Array.from(new Set(currentUncountedItemsList.map(it => it.category || 'عام'))).filter(Boolean).sort();
            catSelect.innerHTML = `<option value="">جميع الأقسام (${currentUncountedItemsList.length})</option>` +
                cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
        }

        const searchInput = document.getElementById('uncounted-search-input');
        if (searchInput) searchInput.value = '';

        renderFilteredUncountedItems();
    } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="12" class="p-6 text-center text-rose-500 font-bold">خطأ أثناء جلب تقرير الأصناف: ${err.message}</td></tr>`;
    }
}

function closeUncountedItemsModal() {
    const modal = document.getElementById('modal-uncounted-items');
    if (modal) modal.classList.add('hidden');
}

function getCurrentlyFilteredUncountedItems() {
    const query = (document.getElementById('uncounted-search-input')?.value || '').trim().toLowerCase();
    const cat = (document.getElementById('uncounted-category-filter')?.value || '').trim();

    return currentUncountedItemsList.filter(it => {
        if (cat && (it.category || 'عام') !== cat) return false;
        if (!query) return true;
        const code = String(it.product_code || '').toLowerCase();
        const name = String(it.product_name || '').toLowerCase();
        const barcode = String(it.barcode || '').toLowerCase();
        const batch = String(it.batch_number || '').toLowerCase();
        return code.includes(query) || name.includes(query) || barcode.includes(query) || batch.includes(query);
    });
}

function renderFilteredUncountedItems() {
    const tbody = document.getElementById('uncounted-items-tbody');
    if (!tbody) return;

    const filtered = getCurrentlyFilteredUncountedItems();

    // تحديث إجماليات الكشف
    const totalQty = filtered.reduce((acc, it) => acc + (parseFloat(it.system_qty) || 0), 0);
    const totalCost = filtered.reduce((acc, it) => acc + (parseFloat(it.total_cost) || 0), 0);

    const elCount = document.getElementById('uncounted-stat-count');
    const elQty = document.getElementById('uncounted-stat-qty');
    const elCost = document.getElementById('uncounted-stat-cost');

    if (elCount) elCount.textContent = `${filtered.length} صنف`;
    if (elQty) elQty.textContent = totalQty.toLocaleString();
    if (elCost) elCost.textContent = formatMoney(totalCost);

    if (filtered.length === 0) {
        tbody.innerHTML = `<tr><td colspan="12" class="p-6 text-center text-slate-400">لا توجد أصناف مطابقة للبحث أو تم جرد جميع الأصناف بنجاح! 🎉</td></tr>`;
        return;
    }

    let html = '';
    filtered.forEach((it, idx) => {
        const rowBg = idx % 2 === 0 ? 'bg-white hover:bg-rose-50/40' : 'bg-slate-50/70 hover:bg-rose-50/40';
        html += `
            <tr class="${rowBg} transition text-slate-700 text-xs">
                <td class="border border-slate-300 p-1 text-center font-mono text-[11px] text-slate-400 bg-slate-50/50">${idx + 1}</td>
                <td class="border border-slate-300 p-1 font-mono font-bold text-slate-900 text-center">${escapeHtml(it.product_code || '')}</td>
                <td class="border border-slate-300 p-1 text-left font-semibold text-slate-800 select-text min-w-[220px]" dir="ltr">
                    <span class="line-clamp-1 leading-relaxed">${escapeHtml(it.product_name || '')}</span>
                </td>
                <td class="border border-slate-300 p-1 font-mono text-[11px] text-slate-600 text-center" dir="ltr">${escapeHtml(it.barcode || '-')}</td>
                <td class="border border-slate-300 p-1 text-center font-mono font-bold text-rose-700 text-[11px]" dir="ltr">${escapeHtml(String(it.batch_number || '-').toUpperCase())}</td>
                <td class="border border-slate-300 p-1 text-center font-mono font-bold text-slate-800 text-[11px]" dir="ltr">${escapeHtml(it.expiry_date || '-')}</td>
                <td class="border border-slate-300 p-1 text-center font-mono font-black text-rose-800 bg-rose-50/70">${it.system_qty}</td>
                <td class="border border-slate-300 p-1 text-center font-mono font-bold text-slate-800">${formatMoney(it.cost_price)}</td>
                <td class="border border-slate-300 p-1 text-center font-mono font-bold text-indigo-700">${formatMoney(it.selling_price)}</td>
                <td class="border border-slate-300 p-1 text-center font-mono font-bold text-rose-900">${formatMoney(it.total_cost)}</td>
                <td class="border border-slate-300 p-1 text-center font-mono font-bold text-slate-900">${formatMoney(it.total_sale)}</td>
                <td class="border border-slate-300 p-1 text-center text-[10px] text-slate-500">${escapeHtml(it.category || 'عام')}</td>
            </tr>
        `;
    });
    tbody.innerHTML = html;
}

// ربط أحداث مودال الأصناف غير المجرودة
document.getElementById('uncounted-search-input')?.addEventListener('input', () => {
    renderFilteredUncountedItems();
});

document.getElementById('uncounted-category-filter')?.addEventListener('change', () => {
    renderFilteredUncountedItems();
});

document.getElementById('btn-close-uncounted-modal')?.addEventListener('click', closeUncountedItemsModal);

document.getElementById('btn-uncounted-modal-print')?.addEventListener('click', () => {
    const filtered = getCurrentlyFilteredUncountedItems();
    printUncountedItemsView(false, filtered);
});

document.getElementById('btn-uncounted-modal-excel')?.addEventListener('click', async () => {
    const storeNo = currentActiveStoreNo || 'ST-001';
    const title = `NOT_FOUND_${storeNo}`;
    const defaultName = `EstimatedNotFound_${storeNo}.xlsx`;
    const url = `/api/stock/uncounted/export-excel?store_no=${encodeURIComponent(storeNo)}&title=${encodeURIComponent(title)}`;
    showCatalogToast('📊 جاري سحب إكسيل الأصناف غير المجرودة وفتحه تلقائياً...');
    await window.downloadAndTriggerSave(url, defaultName);
});

// تصدير الدوال على مستوى النافذة لاستدعائها بأمان
window.openUncountedItemsModal = openUncountedItemsModal;
window.closeUncountedItemsModal = closeUncountedItemsModal;
window.printUncountedItemsView = printUncountedItemsView;

    // =========================================================================
    // وظائف مسح وحذف كرت الصنف (كامل أو بعض كرت الصنف)
    // =========================================================================
    // activeEditingProductCode معرف في بداية الملف

    // فتح وإغلاق القائمة المنسدلة لمسح خانات كرت الصنف
    const btnClearMenu = document.getElementById('btn-card-clear-menu');
    const clearDropdown = document.getElementById('card-clear-dropdown');

    btnClearMenu?.addEventListener('click', (e) => {
        e.stopPropagation();
        clearDropdown?.classList.toggle('hidden');
    });

    document.addEventListener('click', (e) => {
        if (!clearDropdown?.contains(e.target) && e.target !== btnClearMenu) {
            clearDropdown?.classList.add('hidden');
        }
    });

    // 1. مسح كرت الصنف كاملاً (تفريغ جميع الحقول والباركودات)
    document.getElementById('btn-clear-entire-card')?.addEventListener('click', () => {
        clearDropdown?.classList.add('hidden');
        if (confirm('هل تريد مسح وتفريغ كامل خانات كرت الصنف؟')) {
            clearProductCardInputs(true);
            showCatalogToast('تم مسح كامل خانات كرت الصنف');
        }
    });

    // 2. مسح الباركودات و GTIN فقط
    document.getElementById('btn-clear-barcodes-only')?.addEventListener('click', () => {
        clearDropdown?.classList.add('hidden');
        const pBar = document.getElementById('prod-primary-barcode');
        const pGtin = document.getElementById('prod-primary-gtin');
        const eb = document.getElementById('extra-barcodes-container');
        const eg = document.getElementById('extra-gtins-container');
        if (pBar) pBar.value = '';
        if (pGtin) pGtin.value = '';
        if (eb) eb.innerHTML = '';
        if (eg) eg.innerHTML = '';
        cancelGs1Inspector();
        showCatalogToast('تم مسح جميع الباركودات و GTIN من كرت الصنف');
    });

    // 3. مسح وتصفير الأسعار فقط
    document.getElementById('btn-clear-prices-only')?.addEventListener('click', () => {
        clearDropdown?.classList.add('hidden');
        const sp = document.getElementById('prod-selling-price');
        const up = document.getElementById('prod-unit-price');
        const wp = document.getElementById('prod-wholesale-price');
        const tx = document.getElementById('prod-tax-rate');
        if (sp) sp.value = '';
        if (up) up.value = '';
        if (wp) wp.value = '';
        if (tx) tx.value = '0';
        showCatalogToast('تم تصفير خانات الأسعار والضريبة');
    });

    // 4. مسح بيانات الأسماء والتصنيف فقط
    document.getElementById('btn-clear-names-only')?.addEventListener('click', () => {
        clearDropdown?.classList.add('hidden');
        const na = document.getElementById('prod-name-ar');
        const ne = document.getElementById('prod-name-en');
        const sc = document.getElementById('prod-scientific-name');
        const co = document.getElementById('prod-company');
        const ca = document.getElementById('prod-category');
        if (na) na.value = '';
        if (ne) ne.value = '';
        if (sc) sc.value = '';
        if (co) co.value = '';
        if (ca) ca.value = '';
        showCatalogToast('تم مسح الأسماء والتصنيف');
    });

    // حذف كرت الصنف المفتوح حالياً نهائياً من قاعدة البيانات
    const executeDeleteCurrentProductCard = async () => {
        const code = activeEditingProductCode || document.getElementById('prod-code-input')?.value.trim();
        if (!code) {
            alert('لا يوجد كود صنف محدد للحذف.');
            return;
        }
        const name = document.getElementById('prod-name-en')?.value || document.getElementById('prod-name-ar')?.value || code;
        if (!confirm(`هل أنت متأكد من حذف كرت الصنف [${code}] (${name}) نهائياً من قاعدة البيانات؟\nلن يمكن التراجع عن هذا الإجراء.`)) {
            return;
        }

        try {
            const res = await fetch('/api/catalog/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code })
            });
            const data = await res.json();
            if (data.success) {
                closeProductModal();
                selectedCatalogCodes.delete(code);
                if (isAccumulatedSearchMode) {
                    accumulatedSearchResults.delete(code);
                    renderCatalogItemsTable(Array.from(accumulatedSearchResults.values()), accumulatedSearchResults.size, true);
                } else {
                    loadCatalogProducts();
                }
                refreshSystemStats();
                showCatalogToast(`تم حذف كرت الصنف [${code}] بنجاح 🗑️`);
            } else {
                alert(data.message || 'فشل حذف الصنف.');
            }
        } catch (e) {
            alert('حدث خطأ أثناء الحذف: ' + e.message);
        }
    };

    document.getElementById('btn-modal-delete-product')?.addEventListener('click', executeDeleteCurrentProductCard);
    document.getElementById('btn-footer-delete-product')?.addEventListener('click', executeDeleteCurrentProductCard);

    // حذف مجموعة الأصناف المحددة من شريط التحديد catalog-selection-bar
    document.getElementById('btn-delete-selected-catalog')?.addEventListener('click', async () => {
        const count = selectedCatalogCodes.size;
        if (count === 0) {
            alert('لم يتم تحديد أي أصناف لحذفها.');
            return;
        }
        if (!confirm(`تحذير: هل أنت متأكد من حذف (${count}) كرت صنف محدد نهائياً من قاعدة البيانات؟`)) {
            return;
        }

        try {
            const codes = Array.from(selectedCatalogCodes);
            const res = await fetch('/api/catalog/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ codes })
            });
            const data = await res.json();
            if (data.success) {
                selectedCatalogCodes.clear();
                if (isAccumulatedSearchMode) {
                    codes.forEach(c => accumulatedSearchResults.delete(c));
                    renderCatalogItemsTable(Array.from(accumulatedSearchResults.values()), accumulatedSearchResults.size, true);
                } else {
                    loadCatalogProducts();
                }
                refreshSystemStats();
                updateCatalogSelectionUI();
                showCatalogToast(`تم حذف (${data.deleted_count || count}) صنف بنجاح 🗑️`);
            } else {
                alert(data.message || 'فشل حذف الأصناف المحددة.');
            }
        } catch (e) {
            alert('حدث خطأ أثناء حذف الأصناف: ' + e.message);
        }
    });

    // مسح دليل الأصناف بالكامل
    document.getElementById('btn-clear-all-catalog')?.addEventListener('click', async () => {
        const confirmWord = prompt('⚠️ تحذير شديد: أنت على وشك مسح جميع كروت الأصناف في الدليل بالكامل!\n\nللتأكيد، اكتب كلمة "حذف" في المربع أدناه:');
        if (confirmWord !== 'حذف') {
            if (confirmWord !== null) alert('تم إلغاء العملية، الكلمة المدخلة غير صحيحة.');
            return;
        }

        try {
            const res = await fetch('/api/catalog/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clear_all: true })
            });
            const data = await res.json();
            if (data.success) {
                selectedCatalogCodes.clear();
                accumulatedSearchResults.clear();
                loadCatalogProducts();
                refreshSystemStats();
                updateCatalogSelectionUI();
                alert('تم تفريغ دليل الأصناف بالكامل بنجاح.');
            } else {
                alert(data.message || 'فشل مسح دليل الأصناف.');
            }
        } catch (e) {
            alert('حدث خطأ أثناء مسح الدليل: ' + e.message);
        }
    });
    