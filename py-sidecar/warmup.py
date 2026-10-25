"""Download/verify the OCR and layout models once so the first upload is fast.

Run by scripts/setup-docling.{sh,ps1}. Exits non-zero with a clear message when
OCR cannot initialise, instead of letting uploads silently skip scanned pages.
"""

from __future__ import annotations

import sys


def main() -> int:
    from page_normalizer import get_ocr_engine, ocr_available

    available, reason = ocr_available()
    if not available:
        print(f"OCR unavailable: {reason}", file=sys.stderr)
        return 1
    from PIL import Image, ImageDraw

    image = Image.new("RGB", (400, 100), "white")
    ImageDraw.Draw(image).text((10, 40), "OCR warm-up 123", fill="black")
    engine = get_ocr_engine()
    engine.detect(image)
    engine.recognise_score(image)

    # One real conversion of a tiny scanned page pulls the layout, table and
    # OCR models into the local caches exactly as an upload would.
    from io import BytesIO

    from docling.datamodel.base_models import DocumentStream

    from main import get_converter

    pdf = BytesIO()
    image.save(pdf, format="PDF", resolution=72)
    get_converter(True).convert(DocumentStream(name="warmup.pdf", stream=BytesIO(pdf.getvalue())))
    print("Docling sidecar ready: RapidOCR + layout/table models available.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
