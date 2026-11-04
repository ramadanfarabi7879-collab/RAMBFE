import difflib
import re
from typing import List, Dict, Any, Optional
from .normalizer import normalize_arabic, normalize_english
from .db import get_all_products, get_aliases, clean_numeric_code, get_all_product_barcodes, split_barcodes

def sequence_ratio(s1: str, s2: str) -> int:
    if not s1 or not s2:
        return 0
    return int(difflib.SequenceMatcher(None, s1, s2).ratio() * 100)

def token_sort_ratio(s1: str, s2: str) -> int:
    t1 = " ".join(sorted(s1.split()))
    t2 = " ".join(sorted(s2.split()))
    return sequence_ratio(t1, t2)

def token_set_ratio(s1: str, s2: str) -> int:
    set1 = set(s1.split())
    set2 = set(s2.split())
    if not set1 or not set2:
        return 0
    intersection = " ".join(sorted(set1 & set2))
    diff1 = " ".join(sorted(set1 - set2))
    diff2 = " ".join(sorted(set2 - set1))
    t0 = intersection.strip()
    t1 = (intersection + " " + diff1).strip()
    t2 = (intersection + " " + diff2).strip()
    candidates = [
        sequence_ratio(t1, t2),
        sequence_ratio(t0, t1) if t0 else 0,
        sequence_ratio(t0, t2) if t0 else 0
    ]
    return max(candidates)

def get_barcode_variants(bc: str) -> List[str]:
    bc_clean = re.sub(r'[^0-9a-zA-Z]', '', str(bc).strip())
    if not bc_clean:
        return []
    variants = [bc_clean]
    stripped = bc_clean.lstrip('0')
    if stripped and stripped != bc_clean:
        variants.append(stripped)
    if len(stripped) == 12:
        variants.append('0' + stripped)
        variants.append(stripped.zfill(14))
    elif len(stripped) == 13:
        variants.append('0' + stripped)
        variants.append(stripped.zfill(14))
    elif len(stripped) == 14:
        variants.append(stripped.lstrip('0'))
    return list(dict.fromkeys(variants))

class SmartMatcher:
    def __init__(self):
        self.reload_catalog()

    def reload_catalog(self):
        self.products = get_all_products()
        self.aliases = get_aliases()
        barcodes_list = get_all_product_barcodes()
        
        self.by_code = {}
        self.by_gtin = {}
        self.by_barcode = {}
        self.catalog_names = [] # list of (norm_ar, norm_en, product)
        
        for p in self.products:
            code = clean_numeric_code(p.get("code"))
            raw_code = str(p.get("code") or "").strip()
            norm_ar = str(p.get("normalized_name_ar") or "").strip()
            norm_en = str(p.get("normalized_name_en") or "").strip()
            
            if code:
                self.by_code[code] = p
            if raw_code:
                self.by_code[raw_code] = p
                self.by_code[raw_code.lower()] = p
            
            # تسجيل جميع الباركودات و GTINs للصنف مع كافة اشتقاقاتها
            for g in split_barcodes(p.get("gtin")):
                for v in get_barcode_variants(g):
                    self.by_gtin[v] = p
                    self.by_gtin[v.lower()] = p
                    self.by_barcode[v] = p
                    self.by_barcode[v.lower()] = p
                
            for b in split_barcodes(p.get("barcode")):
                for v in get_barcode_variants(b):
                    self.by_barcode[v] = p
                    self.by_barcode[v.lower()] = p
                    if len(v) == 14:
                        self.by_gtin[v] = p
                        self.by_gtin[v.lower()] = p

            self.catalog_names.append((norm_ar, norm_en, p))

        # تسجيل الباركودات من جدول الباركودات المتعددة
        for b_row in barcodes_list:
            p_code = clean_numeric_code(b_row.get("product_code"))
            raw_p_code = str(b_row.get("product_code") or "").strip()
            p_obj = self.by_code.get(p_code) or self.by_code.get(raw_p_code)
            if p_obj:
                for b_val in split_barcodes(b_row.get("barcode")):
                    for v in get_barcode_variants(b_val):
                        self.by_barcode[v] = p_obj
                        self.by_barcode[v.lower()] = p_obj
                        if b_row.get("barcode_type") == 'gtin' or len(v) == 14:
                            self.by_gtin[v] = p_obj
                            self.by_gtin[v.lower()] = p_obj

        # بناء فهرس معكوس سريع للكلمات لتسريع المطابقة 500 ضعف
        self.token_to_indices = {}
        for idx, (cat_ar, cat_en, p) in enumerate(self.catalog_names):
            tokens = set(re.findall(r'[a-zA-Z0-9\u0600-\u06FF]+', cat_ar + " " + cat_en))
            for tok in tokens:
                t_lower = tok.lower()
                if len(t_lower) >= 3:
                    if t_lower not in self.token_to_indices:
                        self.token_to_indices[t_lower] = []
                    self.token_to_indices[t_lower].append(idx)

    def match_item(self, item: Dict[str, Any]) -> Dict[str, Any]:
        """
        مطابقة بند الفاتورة مع قاعدة الأصناف:
        الخوارزمية الذكية المحدثة:
        1. أولوية قصوى 100%: مطابقة الباركود والـ GTIN أولاً (إذا وجد باركود في الفاتورة يتم الاعتماد عليه فوراً)
        2. مطابقة الكود التعريفي (أرقام فقط)
        3. مطابقة الربط المحفوظ مسبقاً لمسمى المورد (Alias)
        4. مطابقة الاسم التام (عربي أو إنجليزي)
        5. مطابقة الاسم الذكية والتقريبية
        """
        raw_name = str(item.get("raw_name") or "").strip()
        barcode_raw = str(item.get("barcode") or "").strip()
        gtin_raw = str(item.get("gtin") or "").strip()
        item_code_raw = str(item.get("item_code") or "").strip()
        candidate_barcodes_in = item.get("candidate_barcodes") or []
        
        # -------------------------------------------------------------
        # المرحلة 1: المطابقة بالباركود أو GTIN بأعلى أولوية (Barcode First)
        # -------------------------------------------------------------
        candidate_barcodes = []
        for cand in split_barcodes(gtin_raw):
            candidate_barcodes.append((cand, "gtin"))
        for cand in split_barcodes(barcode_raw):
            candidate_barcodes.append((cand, "barcode"))
        for cand in split_barcodes(candidate_barcodes_in):
            candidate_barcodes.append((cand, "barcode"))
        for cand in split_barcodes(item_code_raw):
            candidate_barcodes.append((cand, "code"))
            
        # فحص وجود أرقام باركود مدمجة في اسم الصنف (8 إلى 14 رقماً)
        if raw_name:
            embedded_numbers = re.findall(r'\b\d{8,14}\b', raw_name)
            for emb in embedded_numbers:
                candidate_barcodes.append((emb, "barcode"))

        for bc_val, bc_type in candidate_barcodes:
            for v in get_barcode_variants(bc_val):
                if not v:
                    continue

                # 1. مطابقة GTIN
                if v in self.by_gtin:
                    return self._build_result(item, self.by_gtin[v], score=100, confidence="high", match_type="gtin")
                if v.lower() in self.by_gtin:
                    return self._build_result(item, self.by_gtin[v.lower()], score=100, confidence="high", match_type="gtin")

                # 2. مطابقة الباركود الدولي
                if v in self.by_barcode:
                    return self._build_result(item, self.by_barcode[v], score=100, confidence="high", match_type="barcode")
                if v.lower() in self.by_barcode:
                    return self._build_result(item, self.by_barcode[v.lower()], score=100, confidence="high", match_type="barcode")

                # 3. مطابقة الكود
                clean_code = clean_numeric_code(v)
                if clean_code in self.by_code:
                    return self._build_result(item, self.by_code[clean_code], score=100, confidence="high", match_type="code")
                if v in self.by_code:
                    return self._build_result(item, self.by_code[v], score=100, confidence="high", match_type="code")

        # -------------------------------------------------------------
        # المرحلة 2: في حال عدم وجود باركود أو عدم تطابقه -> المطابقة بالاسم
        # -------------------------------------------------------------
        norm_ar = normalize_arabic(raw_name)
        norm_en = normalize_english(raw_name)

        # 2.1 فحص الروابط السابقة المحفوظة (Aliases)
        if raw_name in self.aliases:
            code = self.aliases[raw_name]
            if code in self.by_code:
                return self._build_result(item, self.by_code[code], score=100, confidence="high", match_type="alias")
        if norm_ar in self.aliases:
            code = self.aliases[norm_ar]
            if code in self.by_code:
                return self._build_result(item, self.by_code[code], score=100, confidence="high", match_type="alias")
        if norm_en in self.aliases:
            code = self.aliases[norm_en]
            if code in self.by_code:
                return self._build_result(item, self.by_code[code], score=100, confidence="high", match_type="alias")

        # 2.2 مطابقة الاسم التام (عربي أو انجليزي)
        for cat_ar, cat_en, prod in self.catalog_names:
            if norm_ar and cat_ar and norm_ar == cat_ar:
                return self._build_result(item, prod, score=100, confidence="high", match_type="exact_name")
            if norm_en and cat_en and norm_en == cat_en:
                return self._build_result(item, prod, score=100, confidence="high", match_type="exact_name")

        # 5. مطابقة تقريبية ذكية وفائقة السرعة (عربي وانجليزي)
        if not self.catalog_names:
            return self._build_result(item, None, score=0, confidence="low", match_type="none")

        input_tokens = [t.lower() for t in re.findall(r'[a-zA-Z0-9\u0600-\u06FF]+', norm_ar + " " + norm_en) if len(t) >= 3]
        candidate_indices = set()
        for t in input_tokens:
            if t in self.token_to_indices:
                candidate_indices.update(self.token_to_indices[t])
        
        # إذا لم نجد مرشحين كافيين، نبحث بالبوادئ (Prefixes)
        if len(candidate_indices) < 5:
            for t in input_tokens:
                prefix = t[:4]
                if len(prefix) >= 3:
                    for k, idxs in self.token_to_indices.items():
                        if k.startswith(prefix):
                            candidate_indices.update(idxs[:15])

        if candidate_indices:
            candidates = [self.catalog_names[i] for i in candidate_indices]
        else:
            candidates = self.catalog_names[:200]

        inv_price = float(item.get("invoice_price") or 0.0)
        generic_terms = {'cream', 'ointment', 'solution', 'spray', 'tablet', 'tab', 'capsule', 'cap', 'drops', 'suspension', 'susp', 'syrup', 'sachet', 'sachets', 'sach', 'vial', 'ampoule', 'extra', 'forte', 'plus', 'adult', 'infant', 'pediatric'}
        distinctive_input_tokens = [t for t in input_tokens if t not in generic_terms and len(t) >= 4]
        input_nums = set(re.findall(r'\b\d+\b', norm_en))

        RELEASE_MODIFIERS_EN = {'xr', 'sr', 'mr', 'er', 'cr', 'retard', 'la', 'xl', 'plus', 'forte', 'extra', 'max', 'hct', 'comp', 'duo', 'advance'}
        RELEASE_MODIFIERS_AR = {
            'اكس ار': 'xr', 'اس ار': 'sr', 'ام ار': 'mr', 'اي ار': 'er', 'سي ار': 'cr',
            'بلس': 'plus', 'فورت': 'forte', 'اكسترا': 'extra', 'ماكس': 'max', 'مركب': 'comp'
        }
        
        input_mods = set()
        for m in RELEASE_MODIFIERS_EN:
            if re.search(r'\b' + m + r'\b', norm_en):
                input_mods.add(m)
        for ar_m, m_code in RELEASE_MODIFIERS_AR.items():
            if ar_m in norm_ar:
                input_mods.add(m_code)

        scored_matches = []
        for cat_ar, cat_en, prod in candidates:
            sc_en = max(token_sort_ratio(norm_en, cat_en), token_set_ratio(norm_en, cat_en)) if cat_en else 0
            sc_ar = max(token_sort_ratio(norm_ar, cat_ar), token_set_ratio(norm_ar, cat_ar)) if cat_ar else 0
            sc = max(sc_en, sc_ar)

            # تعزيز النتيجة للكلمات الدوائية والعلامات التجارية المميزة
            cat_text_lower = (cat_ar + " " + cat_en).lower()
            matching_distinctive = sum(1 for dt in distinctive_input_tokens if dt in cat_text_lower)
            if matching_distinctive > 0:
                sc += min(20, matching_distinctive * 10)

            # فحص ومطابقة محددات التركيبات والتحرر الدوائي (مثل XR, Forte, Plus):
            cat_mods = set()
            for m in RELEASE_MODIFIERS_EN:
                if re.search(r'\b' + m + r'\b', cat_en.lower()):
                    cat_mods.add(m)
            for ar_m, m_code in RELEASE_MODIFIERS_AR.items():
                if ar_m in cat_ar:
                    cat_mods.add(m_code)

            if input_mods != cat_mods:
                # عقوبة حاسمة لاختلاف نوع التركيبة الدوائية (مثل جلوكوفاج عادي مقابل جلوكوفاج XR)
                sc -= 35
            elif input_mods and input_mods == cat_mods:
                # تعزيز التطابق عند وجود نفس المحدد الدوائي الصريح
                sc += 20

            if sc >= 40:
                # مطابقة الأرقام والتركيزات والأحجام (مثل 30gm مقابل 75gm)
                cat_nums = set(re.findall(r'\b\d+\b', cat_en))
                common_nums = input_nums & cat_nums
                if common_nums:
                    sc += min(15, len(common_nums) * 8)
                elif input_nums and cat_nums and not common_nums:
                    sc -= 15

                # أخذ السعر في الاعتبار مع الاسم:
                # إذا تطابق سعر الفاتورة مع سعر كرت الصنف (البيع أو التكلفة) يحصل الصنف على دفعة قوية لحسم المطابقة
                if inv_price > 0 and prod.get("selling_price"):
                    sell_p = float(prod.get("selling_price") or 0.0)
                    cost_p = float(prod.get("cost_price") or 0.0)
                    if abs(inv_price - sell_p) < 0.05:
                        sc += 35
                    elif abs(inv_price - sell_p) < 0.5:
                        sc += 15
                    elif cost_p > 0 and abs(inv_price - cost_p) < 0.05:
                        sc += 25
                
            if sc >= 35:
                scored_matches.append((sc, prod))

        scored_matches.sort(key=lambda x: x[0], reverse=True)

        if scored_matches:
            top_score, top_prod = scored_matches[0]
            suggestions = []
            for sc, alt_prod in scored_matches[1:4]:
                suggestions.append({
                    "code": alt_prod["code"],
                    "gtin": alt_prod.get("gtin", ""),
                    "barcode": alt_prod.get("barcode", ""),
                    "name_ar": alt_prod.get("name_ar", ""),
                    "name_en": alt_prod.get("name_en", ""),
                    "name": alt_prod.get("name", ""),
                    "selling_price": alt_prod.get("selling_price", 0.0),
                    "cost_price": alt_prod.get("cost_price", 0.0),
                    "score": sc
                })

            confidence = "high" if top_score >= 80 else ("medium" if top_score >= 60 else "low")
            match_type = "fuzzy_high" if top_score >= 80 else ("fuzzy_medium" if top_score >= 60 else "none")

            return self._build_result(
                item,
                top_prod if top_score >= 45 else None,
                score=top_score,
                confidence=confidence,
                match_type=match_type,
                suggestions=suggestions
            )

        return self._build_result(item, None, score=0, confidence="low", match_type="none")

    def _build_result(self, item: Dict[str, Any], matched: Optional[Dict[str, Any]], 
                      score: int, confidence: str, match_type: str, suggestions: List[Dict[str, Any]] = None) -> Dict[str, Any]:
        
        inv_price = float(item.get("invoice_price") or 0.0)
        item_cost = item.get("cost_price")
        if item_cost is not None and str(item_cost).strip() != '':
            try:
                inv_cost = float(str(item_cost).replace(',', '').strip())
            except:
                inv_cost = 0.0
        else:
            inv_cost = 0.0

        inv_effective_cost = inv_cost if inv_cost > 0 else inv_price
        if inv_price <= 0 and inv_cost > 0:
            inv_price = inv_cost

        item_selling = item.get("selling_price")
        if item_selling is not None and str(item_selling).strip() != '':
            try:
                inv_selling = float(str(item_selling).replace(',', '').strip())
            except:
                inv_selling = 0.0
        else:
            inv_selling = 0.0

        # قاعدة الأسعار والتوزيع المعتمدة:
        # 1. سعر البيع (selling_price): من كرت الصنف المعتمد في البرنامج
        if matched and float(matched.get("selling_price") or 0.0) > 0:
            selling_price = float(matched["selling_price"])
        elif matched and float(matched.get("price") or 0.0) > 0:
            selling_price = float(matched["price"])
        elif inv_selling > 0:
            selling_price = inv_selling
        elif inv_effective_cost > 0:
            selling_price = inv_effective_cost
        else:
            selling_price = 0.0

        # 2. سعر التكلفة (cost_price): نفس الفاتورة المرفوعة أياً كان
        if inv_effective_cost > 0:
            cost_price = inv_effective_cost
        elif inv_cost > 0:
            cost_price = inv_cost
        elif inv_price > 0:
            cost_price = inv_price
        elif matched and float(matched.get("cost_price") or 0.0) > 0:
            cost_price = float(matched["cost_price"])
        else:
            cost_price = 0.0

        # تطبيق صمام الأمان المحاسبي للكميات والبونص:
        raw_qty = item.get("quantity")
        raw_bonus = item.get("bonus")

        try:
            b_val = int(raw_bonus) if raw_bonus is not None and str(raw_bonus).strip() != '' else 0
        except:
            b_val = 0

        try:
            if raw_qty is not None and str(raw_qty).strip() != '':
                q_val = int(raw_qty)
            else:
                q_val = 0 if b_val > 0 else 1
        except:
            q_val = 0 if b_val > 0 else 1

        # 1. إذا كان الصنف غير مجاني (ليس بونص: bonus == 0)، فلا يمكن إطلاقاً أن تترك خانة العدد فارغة أو صفراً
        if b_val == 0 and q_val <= 0:
            q_val = 1

        # 2. بالعكس: إذا كانت خانة العدد صفراً (بونص مجاني 100%)، فيجب ألا تكون خانة البونص صفراً أو فارغة
        if q_val == 0 and b_val <= 0:
            b_val = 1

        return {
            "raw_name": item.get("raw_name", ""),
            "invoice_barcode": item.get("barcode", ""),
            "invoice_gtin": item.get("gtin", ""),
            "quantity": q_val,
            "bonus": b_val,
            "discount_1": item.get("discount_1", 0.0),
            "discount_2": item.get("discount_2", 0.0),
            "discount_percent": item.get("discount_1", 0.0),
            "batch_number": item.get("batch_number", ""),
            "expiry_date": item.get("expiry_date", ""),

            "invoice_price": inv_price,
            "item_code": str(item.get("item_code") or "").strip(),
            "invoice_code": str(item.get("item_code") or "").strip(),
            
            # بيانات الصنف المطابق من كرت الصنف (الاسم الإنجليزي هو الأساس المعتمد)
            "matched_code": str(matched["code"] if matched else (clean_numeric_code(item.get("item_code")) or clean_numeric_code(item.get("barcode")))).strip(),
            "matched_gtin": matched.get("gtin", "") if matched else item.get("gtin", ""),
            "matched_barcode": matched.get("barcode", "") if matched else item.get("barcode", ""),
            "matched_name_ar": matched.get("name_ar", "") if matched else "",
            "matched_name_en": matched.get("name_en", "") if matched else "",
            "matched_name": (matched.get("name_en") or matched.get("name", "") or matched.get("name_ar", "")) if matched else item.get("raw_name", ""),
            "selling_price": selling_price,
            "cost_price": cost_price,
            
            "score": score,
            "confidence": confidence,
            "match_type": match_type,
            "suggestions": suggestions or []
        }
