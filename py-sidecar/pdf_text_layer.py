"""Read a digital PDF's own text layer (pdfium) inside a Docling box.

Docling splits Thai combining vowels and tone marks into separate glyph runs
("ชื อ" for "ชื่อ"), and some marks are lost entirely. pdfium returns the text
layer in logical order with marks attached, so table cells on digital pages
are re-read from it. Scanned pages have no text layer and are left alone.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Any

THAI = re.compile(r"[\u0E00-\u0E7F]")


class TextLayer:
    """Lazily opened pdfium view of one PDF; use as a context manager."""

    def __init__(self, content: bytes) -> None:
        import pypdfium2 as pdfium

        self._pdf = pdfium.PdfDocument(content)
        self._pages: dict[int, tuple[Any, float, bool]] = {}

    def __enter__(self) -> "TextLayer":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    def close(self) -> None:
        for page, _height, _ok in self._pages.values():
            page.close()
        self._pages.clear()
        self._pdf.close()

    def _page(self, page_no: int) -> tuple[Any, float, bool] | None:
        if page_no in self._pages:
            return self._pages[page_no]
        if not 1 <= page_no <= len(self._pdf):
            return None
        page = self._pdf[page_no - 1]
        textpage = page.get_textpage()
        # Rotated pages are scanned ones we normalised; their boxes are in
        # display space, and they have no text layer worth reading anyway.
        usable = page.get_rotation() == 0 and textpage.count_chars() > 0
        entry = (textpage, float(page.get_height()), usable)
        self._pages[page_no] = entry
        return entry

    def text_in(self, page_no: int, box: Any) -> str | None:
        """Text inside a Docling BoundingBox, or None if there is no text layer."""
        entry = self._page(page_no)
        if entry is None or not entry[2]:
            return None
        textpage, height, _ = entry
        left, right = sorted((float(box.l), float(box.r)))
        top, bottom = float(box.t), float(box.b)
        if "TOP" in str(getattr(box, "coord_origin", "")).upper():
            top, bottom = height - top, height - bottom
        bottom, top = sorted((bottom, top))
        # Thai above/below marks extend past the line box Docling reports.
        pad = max(2.0, (top - bottom) * 0.6)
        text = textpage.get_text_bounded(left=left - 1, bottom=bottom - pad, right=right + 1, top=top + pad)
        text = unicodedata.normalize("NFC", re.sub(r"\s+", " ", text)).strip()
        return text or None


def repaired_cell_text(layer: TextLayer | None, page_no: int | None, cell: Any, text: str) -> str:
    """Prefer the PDF's own text for Thai cells on digital pages."""
    if layer is None or page_no is None or not THAI.search(text):
        return text
    box = getattr(cell, "bbox", None)
    if box is None:
        return text
    repaired = layer.text_in(page_no, box)
    return repaired if repaired and THAI.search(repaired) else text
