import os
import shutil
import uuid
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, UploadFile, File, Form, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import pandas as pd

from .db import (
    init_db, bulk_save_products, get_all_products, get_product_by_code,
    get_aliases, save_alias, get_stats, clear_catalog
)
from .normalizer import normalize_arabic
from .matcher import SmartMatcher
from .invoice_parser import parse_excel_invoice, parse_pdf_invoice, find_best_column, NAME_KEYWORDS, BARCODE_KEYWORDS, PRICE_KEYWORDS
from .excel_exporter import export_matched_items_to_excel

app = FastAPI(title="Smart Invoice Matcher API", version="1.0.0")

# إتاحة CORS لأي طلبات محلية
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMP_DIR = os.path.join(BASE_DIR, "temp")
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")
os.makedirs(TEMP_DIR, exist_ok=True)

# تهيئة قاعدة البيانات ومحرك المطابقة
init_db()
matcher = SmartMatcher()

class AliasRequest(BaseModel):
    invoice_name: str
    product_code: str

class ExportRequest(BaseModel):
    items: List[Dict[str, Any]]
    filename: Optional[str] = "الفاتورة_المطابقة.xlsx"

@app.get("/api/stats")
def get_system_stats():
    return get_stats()

@app.get("/api/catalog/products")
def list_products(query: Optional[str] = None, limit: int = 50):
    products = get_all_products()
    if query:
        norm_q = normalize_arabic(query)
        q_lower = query.lower().strip()
        filtered = [
            p for p in products 
            if norm_q in p["normalized_name"] or q_lower in str(p["code"]).lower() or q_lower in str(p["barcode"]).lower()
        ]
        return filtered[:limit]
    return products[:limit]

@app.get("/api/catalog/search")
def search_catalog(q: str = Query(..., min_length=1)):
    """بحث سريع لقوائم الإكمال التلقائي في شاشة المراجعة"""
    norm_q = normalize_arabic(q)
    q_lower = q.lower().strip()
    products = get_all_products()
    results = []
    
    for p in products:
        score = 0
        if q_lower == str(p.get("code", "")).lower() or q_lower == str(p.get("barcode", "")).lower():
            score = 100
        elif norm_q in p["normalized_name"]:
            score = 90
        elif any(part in p["normalized_name"] for part in norm_q.split()):
            score = 60
            
        if score > 0:
            results.append({
                "code": p["code"],
                "barcode": p.get("barcode", ""),
                "name": p["name"],
                "selling_price": p.get("selling_price", 0.0),
                "score": score
            })
            
    # ترتيب حسب أعلى تطابق
    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:15]

@app.post("/api/catalog/upload")
async def upload_master_catalog(file: UploadFile = File(...)):
    """استيراد قاعدة الأصناف الأساسية من ملف إكسيل"""
    if not file.filename.endswith(('.xlsx', '.xls', '.csv')):
        raise HTTPException(status_code=400, detail="يرجى رفع ملف إكسيل صالح (.xlsx أو .xls)")

    temp_path = os.path.join(TEMP_DIR, f"catalog_{uuid.uuid4().hex}_{file.filename}")
    with open(temp_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        if file.filename.endswith('.csv'):
            df = pd.read_csv(temp_path)
        else:
            df = pd.read_excel(temp_path)
            
        df.columns = [str(c).strip() for c in df.columns]
        
        # التعرف على الأعمدة
        col_name = find_best_column(df.columns, NAME_KEYWORDS)
        col_barcode = find_best_column(df.columns, BARCODE_KEYWORDS)
        col_price = find_best_column(df.columns, PRICE_KEYWORDS)
        
        # إذا لم نجد كود صنف أو باركود، نبحث عن أي عمود كود أو نستخدم فهرساً
        col_code = None
        for c in df.columns:
            cl = c.lower()
            if any(k in cl for k in ['كود', 'code', 'id', 'رقم الصنف', 'الرقم التعريفي']):
                col_code = c
                break
                
        if not col_code and col_barcode:
            col_code = col_barcode
        elif not col_code:
            # إذا لم يوجد عمود كود، ننشئ كود تلقائي
            df['Auto_Code'] = [f"PRD-{i+1:05d}" for i in range(len(df))]
            col_code = 'Auto_Code'

        if not col_name:
            raise HTTPException(status_code=400, detail="لم نتمكن من العثور على عمود اسم الصنف في الملف.")

        products = []
        for _, row in df.iterrows():
            name = str(row.get(col_name, "")).strip()
            if not name or name.lower() in ('nan', 'none'):
                continue
            
            code = str(row.get(col_code, "")).strip()
            if not code or code.lower() in ('nan', 'none'):
                code = f"PRD-{uuid.uuid4().hex[:8].upper()}"
            if code.endswith('.0') and code[:-2].isdigit():
                code = code[:-2]
                
            barcode = str(row.get(col_barcode, "")).strip() if col_barcode else ""
            if barcode.lower() in ('nan', 'none'):
                barcode = ""
            if barcode.endswith('.0') and barcode[:-2].isdigit():
                barcode = barcode[:-2]
                
            selling_price = 0.0
            if col_price and pd.notna(row.get(col_price)):
                try:
                    selling_price = float(str(row.get(col_price)).replace(',', ''))
                except:
                    selling_price = 0.0
                    
            products.append({
                "code": code,
                "barcode": barcode,
                "name": name,
                "normalized_name": normalize_arabic(name),
                "selling_price": selling_price,
                "cost_price": 0.0,
                "category": ""
            })

        count = bulk_save_products(products)
        matcher.reload_catalog()
        
        return {
            "success": True,
            "message": f"تم استيراد {count} صنف بنجاح إلى قاعدة البيانات المرجعية.",
            "count": count
        }
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

@app.post("/api/catalog/clear")
def clear_catalog_endpoint():
    clear_catalog()
    matcher.reload_catalog()
    return {"success": True, "message": "تم إفراغ قاعدة الأصناف بنجاح."}

@app.post("/api/invoice/upload")
async def upload_and_process_invoice(file: UploadFile = File(...)):
    """رفع فاتورة المورد (إكسيل أو PDF) ومطابقتها ذكياً"""
    filename = file.filename.lower()
    if not (filename.endswith(('.xlsx', '.xls', '.csv', '.pdf'))):
        raise HTTPException(status_code=400, detail="يرجى رفع ملف إكسيل أو PDF صالح")

    temp_path = os.path.join(TEMP_DIR, f"inv_{uuid.uuid4().hex}_{file.filename}")
    with open(temp_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    try:
        # 1. استخراج البنود من الفاتورة
        if filename.endswith('.pdf'):
            raw_items = parse_pdf_invoice(temp_path)
        else:
            raw_items = parse_excel_invoice(temp_path)

        if not raw_items:
            raise HTTPException(status_code=400, detail="لم يتم العثور على بنود قابلة للقراءة في الفاتورة المرفوعة.")

        # 2. المطابقة الذكية لكل بند
        matched_results = []
        for item in raw_items:
            res = matcher.match_item(item)
            matched_results.append(res)

        return {
            "success": True,
            "filename": file.filename,
            "total_items": len(matched_results),
            "items": matched_results
        }
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

@app.post("/api/aliases/save")
def save_alias_mapping(req: AliasRequest):
    """حفظ ربط مسمى من الفاتورة بكود صنف ليتذكره البرنامج مستقبلاً"""
    save_alias(req.invoice_name, req.product_code)
    matcher.reload_catalog()
    return {"success": True, "message": "تم حفظ الربط بنجاح وسيتذكره النظام تلقائياً."}

@app.post("/api/export/excel")
def export_invoice_to_excel(req: ExportRequest):
    """توليد وتحميل ملف الإكسيل النهائي"""
    if not req.items:
        raise HTTPException(status_code=400, detail="لا توجد بيانات لتصديرها")

    out_file = os.path.join(TEMP_DIR, f"export_{uuid.uuid4().hex}.xlsx")
    export_matched_items_to_excel(req.items, out_file)
    
    return FileResponse(
        out_file,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename="الفاتورة_المطابقة.xlsx"
    )

# خدمة ملفات الواجهة
if os.path.exists(FRONTEND_DIR):
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
