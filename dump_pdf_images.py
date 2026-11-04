import os
import pypdf

try:
    import pypdf
    reader = pypdf.PdfReader('data/last_uploaded_invoice.pdf')
    for i, page in enumerate(reader.pages):
        print(f"Page {i+1} has {len(page.images)} images:")
        for j, img in enumerate(page.images):
            out_name = f"page_{i+1}_img_{j+1}_{img.name}"
            with open(out_name, "wb") as f_out:
                f_out.write(img.data)
            print(f"  Saved {out_name} (size: {len(img.data)} bytes)")
except Exception as e:
    print("Error:", e)
