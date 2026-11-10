-- تحديث فهرس البحث تلقائياً مع أي تعديل على الأصناف أو باركوداتها (يُطبّق بعد تحميل البيانات الأولي)
DROP TRIGGER IF EXISTS products_ai;
DROP TRIGGER IF EXISTS products_au;
DROP TRIGGER IF EXISTS products_ad;
DROP TRIGGER IF EXISTS barcodes_ai;
DROP TRIGGER IF EXISTS barcodes_ad;

CREATE TRIGGER products_ai AFTER INSERT ON products BEGIN
  INSERT INTO product_search(rowid, txt) SELECT p.id,
    p.code||' | '||ifnull(p.gtin,'')||' | '||ifnull(p.barcode,'')||' | '||ifnull(p.name_ar,'')||' | '||ifnull(p.name_en,'')||' | '||ifnull(p.name,'')||' | '||ifnull(p.normalized_name,'')||' | '||ifnull(p.normalized_name_ar,'')||' | '||ifnull(p.normalized_name_en,'')||' | '||ifnull(p.scientific_name,'')||' | '||ifnull(p.company,'')||' | '||ifnull(p.category,'')||' | '||ifnull((SELECT group_concat(barcode,' ') FROM product_barcodes WHERE product_code=p.code),'')
  FROM products p WHERE p.id = new.id;
END;

CREATE TRIGGER products_au AFTER UPDATE ON products BEGIN
  DELETE FROM product_search WHERE rowid = old.id;
  INSERT INTO product_search(rowid, txt) SELECT p.id,
    p.code||' | '||ifnull(p.gtin,'')||' | '||ifnull(p.barcode,'')||' | '||ifnull(p.name_ar,'')||' | '||ifnull(p.name_en,'')||' | '||ifnull(p.name,'')||' | '||ifnull(p.normalized_name,'')||' | '||ifnull(p.normalized_name_ar,'')||' | '||ifnull(p.normalized_name_en,'')||' | '||ifnull(p.scientific_name,'')||' | '||ifnull(p.company,'')||' | '||ifnull(p.category,'')||' | '||ifnull((SELECT group_concat(barcode,' ') FROM product_barcodes WHERE product_code=p.code),'')
  FROM products p WHERE p.id = new.id;
END;

CREATE TRIGGER products_ad AFTER DELETE ON products BEGIN
  DELETE FROM product_search WHERE rowid = old.id;
  DELETE FROM product_barcodes WHERE product_code = old.code;
END;

CREATE TRIGGER barcodes_ai AFTER INSERT ON product_barcodes BEGIN
  UPDATE products SET code = code WHERE code = new.product_code;
END;

CREATE TRIGGER barcodes_ad AFTER DELETE ON product_barcodes BEGIN
  UPDATE products SET code = code WHERE code = old.product_code;
END;
