"""Quote totals printed outside tables (cover pages, footers).

Thai quotations usually put the job as one numbered lump-sum line on a cover
page and the money summary (มูลค่ารวม/Subtotal, ส่วนลด/Discount, VAT,
มูลค่าสุทธิ/Net Amount) as free text, not as a table. These are read from the
PDF's own text layer and reconciled against the table-derived total; nothing
is invented when a value is missing.
"""

from __future__ import annotations

import re
from decimal import Decimal, InvalidOperation
from typing import Any

_AMOUNT = r"(\(?-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\)?|\(?-?\d+(?:\.\d{1,2})?\)?)"
_TRAILING_AMOUNT = re.compile(_AMOUNT + r"\s*(?:บาท|baht|thb)?\s*$", re.I)
_LABELS: list[tuple[str, re.Pattern[str]]] = [
    ("net", re.compile(r"net\s*amount|มูลค่าสุทธิ|ยอดสุทธิ|รวมทั้งสิ้น|grand\s*total|total\s*amount", re.I)),
    ("vat", re.compile(r"\bvat\b|ภาษีมูลค่าเพิ่ม", re.I)),
    ("discount", re.compile(r"discount|ส่วนลด", re.I)),
    ("overhead", re.compile(r"overhead|ค่าดำเนินการ", re.I)),
    ("subtotal", re.compile(r"sub\s*-?\s*total|มูลค่ารวม|รวมเงิน|รวมราคา", re.I)),
]
_LUMP_SUM = re.compile(
    r"^(\d{1,3})\.?\s+(?P<desc>.*?[A-Za-z\u0E00-\u0E7F].*?)\s+" + _AMOUNT + r"$"
)
_STANDALONE_NUMBER = re.compile(r"(?<![\w.,])\d[\d,]*(?:\.\d+)?(?![\w.,])")
_SUMMARY_WORDS = re.compile(
    r"total|vat|discount|amount|tax|tel|fax|date|page|มูลค่า|ส่วนลด|ภาษี|รวม|โทร|วันที่", re.I
)


def _decimal(text: str) -> Decimal | None:
    raw = text.strip()
    negative = raw.startswith("(") and raw.endswith(")")
    try:
        value = Decimal(raw.strip("()").replace(",", ""))
    except InvalidOperation:
        return None
    return -value if negative else value


def summarise_text(page_texts: list[str] | None) -> dict[str, Any] | None:
    """Pick summary amounts and numbered lump sums out of page text lines."""
    summary: dict[str, Any] = {}
    lump_sums: list[dict[str, Any]] = []
    for page_index, page_text in enumerate(page_texts or [], start=1):
        for raw_line in page_text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
            line = re.sub(r"\s+", " ", raw_line).strip()
            amount_match = _TRAILING_AMOUNT.search(line)
            if not line or amount_match is None:
                continue
            label = line[: amount_match.start()]
            kind = next((name for name, pattern in _LABELS if pattern.search(label)), None)
            value = _decimal(amount_match.group(1))
            if value is None:
                continue
            if kind is not None:
                # Later pages win: covers repeat the summary of the detail pages.
                summary[kind] = {"value": value, "page": page_index, "text": line}
                continue
            lump = _LUMP_SUM.match(line)
            if lump and len(_STANDALONE_NUMBER.findall(lump.group("desc"))) < 2 and not _SUMMARY_WORDS.search(lump.group("desc")):
                lump_sums.append({
                    "itemNo": lump.group(1),
                    "description": lump.group("desc").strip(),
                    "value": value,
                    "page": page_index,
                })
    if not summary and not lump_sums:
        return None
    summary["lumpSums"] = lump_sums
    return summary


def pre_vat_total(summary: dict[str, Any]) -> Decimal | None:
    """The amount a table total should equal: before VAT, after discount."""
    discount = summary.get("discount", {}).get("value", Decimal(0))
    if "subtotal" in summary:
        return summary["subtotal"]["value"] - abs(discount)
    if "net" in summary:
        return summary["net"]["value"] - summary.get("vat", {}).get("value", Decimal(0))
    return None


def summary_warnings(summary: dict[str, Any] | None, source_total: float | None) -> list[dict[str, Any]]:
    """Mismatch warnings between the printed summary and the table total."""
    if not summary:
        return []
    warnings: list[dict[str, Any]] = []
    expected = pre_vat_total(summary)
    tolerance = Decimal("0.01")
    subtotal = summary.get("subtotal", {}).get("value")
    discount = summary.get("discount", {}).get("value", Decimal(0))
    vat = summary.get("vat", {}).get("value", Decimal(0))
    net = summary.get("net", {}).get("value")
    if subtotal is not None and net is not None and abs(subtotal - abs(discount) + vat - net) > tolerance:
        warnings.append({
            "code": "document_summary_mismatch",
            "message": (
                f"Printed summary does not add up: subtotal {subtotal} - discount {abs(discount)}"
                f" + VAT {vat} != net {net}."
            ),
        })
    lump_total = sum((item["value"] for item in summary.get("lumpSums", [])), Decimal(0))
    if summary.get("lumpSums") and subtotal is not None and abs(lump_total - subtotal) > tolerance:
        warnings.append({
            "code": "document_summary_mismatch",
            "message": f"Cover lump sums total {lump_total} but the printed subtotal is {subtotal}.",
        })
    if expected is not None and source_total is not None:
        candidates = {expected, *(value for value in (subtotal, net) if value is not None)}
        if all(abs(Decimal(str(source_total)) - value) > tolerance for value in candidates):
            warnings.append({
                "code": "document_summary_mismatch",
                "message": (
                    f"Table total {Decimal(str(source_total))} does not match the printed summary"
                    f" total {expected} (page {summary.get('subtotal', summary.get('net', {})).get('page')})."
                ),
            })
    return warnings
