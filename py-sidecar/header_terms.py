"""Thai BOQ header vocabulary folded onto the English terms the parser knows."""

from __future__ import annotations

import re
import unicodedata

_THAI = re.compile(r"[\u0E00-\u0E7F]")
_THAI_GAP = re.compile(r"(?<=[\u0E00-\u0E7F])\s+(?=[\u0E00-\u0E7F])")

# Longest first so ราคาต่อหน่วย wins over หน่วย and ลำดับที่ over ลำดับ.
THAI_HEADER_TERMS: tuple[tuple[str, str], ...] = (
    ("ราคาต่อหน่วย", "unit price"), ("ราคารวม", "total price"),
    ("จำนวนเงิน", "amount"), ("ค่าวัสดุ", "material cost"), ("ค่าแรงงาน", "labour cost"),
    ("ค่าแรง", "labour cost"), ("ลำดับที่", "no"), ("ลำดับ", "no"),
    ("รายละเอียด", "description"), ("รายการ", "description"), ("จำนวน", "qty"),
    ("หน่วย", "unit"), ("หมายเหตุ", "remark"),
)


def fold_thai_header_terms(text: str) -> str:
    """Return ``text`` with Thai header words replaced by English vocabulary.

    Thai is NFC-normalised (marks kept) and OCR spaces between Thai letters are
    removed first. Text without Thai is returned unchanged.
    """
    # NFC keeps tone marks; sara am written as nikhahit + sara aa (common in
    # PDF text layers) only composes under NFKC, so fold that pair by hand.
    value = unicodedata.normalize("NFC", str(text or "")).replace("\u0e4d\u0e32", "\u0e33")
    if not _THAI.search(value):
        return value
    value = _THAI_GAP.sub("", value)
    for thai, english in THAI_HEADER_TERMS:
        value = value.replace(thai, f" {english} ")
    return value
