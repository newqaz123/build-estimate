"""Out-of-table quote summary and Thai text-layer repair (synthetic data)."""

import sys
import unittest
from decimal import Decimal
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent))

from document_summary import pre_vat_total, summarise_text, summary_warnings  # noqa: E402
from header_terms import fold_thai_header_terms  # noqa: E402
from pdf_text_layer import repaired_cell_text  # noqa: E402

COVER = "\n".join([
    "ใบเสนอราคา / QUOTATION",
    "ลำดับ รายการ จำนวนเงิน",
    "1 งานติดตั้งระบบท่อ 10,400.00",
    "2 งานทาสี 2,150.00",
    "มูลค่ารวม / Sub Total 12,550.00",
    "ส่วนลด / Discount 550.00",
    "ภาษีมูลค่าเพิ่ม 7% / VAT 840.00",
    "มูลค่าสุทธิ / Net Amount 12,840.00",
    "โทร 02 123 4567",
])


class SummaryTests(unittest.TestCase):
    def test_cover_summary_and_lump_sums_are_read(self):
        summary = summarise_text(["detail page", COVER])
        self.assertEqual(summary["subtotal"]["value"], Decimal("12550.00"))
        self.assertEqual(summary["discount"]["value"], Decimal("550.00"))
        self.assertEqual(summary["vat"]["value"], Decimal("840.00"))
        self.assertEqual(summary["net"]["value"], Decimal("12840.00"))
        self.assertEqual(summary["net"]["page"], 2)
        self.assertEqual(
            [(lump["itemNo"], lump["value"]) for lump in summary["lumpSums"]],
            [("1", Decimal("10400.00")), ("2", Decimal("2150.00"))],
        )
        self.assertEqual(pre_vat_total(summary), Decimal("12000.00"))

    def test_table_rows_with_quantities_are_not_lump_sums(self):
        summary = summarise_text(["1 Widget 2 set 50.00 100.00\nSub Total 100.00"])
        self.assertEqual(summary["lumpSums"], [])

    def test_no_amounts_means_no_summary(self):
        self.assertIsNone(summarise_text(["just words", ""]))
        self.assertIsNone(summarise_text(None))

    def test_consistent_summary_has_no_warnings(self):
        summary = summarise_text([COVER])
        self.assertEqual(summary_warnings(summary, 12000.0), [])
        self.assertEqual(summary_warnings(summary, 12550.0), [])  # matches printed subtotal

    def test_mismatches_are_reported(self):
        summary = summarise_text([COVER.replace("12,840.00", "13,100.00").replace("2 งานทาสี 2,150.00", "2 งานทาสี 1,950.00")])
        messages = [w["message"] for w in summary_warnings(summary, 9999.0)]
        self.assertEqual(len(messages), 3)
        self.assertTrue(all(w["code"] == "document_summary_mismatch" for w in summary_warnings(summary, 9999.0)))
        self.assertIn("does not add up", messages[0])
        self.assertIn("lump sums total 12350.00", messages[1])
        self.assertIn("Table total 9999.0", messages[2])


class FakeLayer:
    def __init__(self, text):
        self.text, self.calls = text, []

    def text_in(self, page_no, box):
        self.calls.append((page_no, box))
        return self.text


class TextLayerRepairTests(unittest.TestCase):
    cell = SimpleNamespace(bbox=(1, 2, 3, 4))

    def test_thai_cell_uses_pdf_text(self):
        layer = FakeLayer("ค่าแรงงานติดตั้ง")
        self.assertEqual(repaired_cell_text(layer, 1, self.cell, "คาแรงงานตดตง"), "ค่าแรงงานติดตั้ง")
        self.assertEqual(layer.calls, [(1, (1, 2, 3, 4))])

    def test_latin_cell_and_missing_layer_are_untouched(self):
        layer = FakeLayer("ค่าแรง")
        self.assertEqual(repaired_cell_text(layer, 1, self.cell, "Pipe 2B"), "Pipe 2B")
        self.assertEqual(layer.calls, [])
        self.assertEqual(repaired_cell_text(None, 1, self.cell, "คาแรง"), "คาแรง")
        self.assertEqual(repaired_cell_text(layer, None, self.cell, "คาแรง"), "คาแรง")

    def test_non_thai_layer_text_is_not_trusted(self):
        self.assertEqual(repaired_cell_text(FakeLayer("???"), 1, self.cell, "คาแรง"), "คาแรง")
        self.assertEqual(repaired_cell_text(FakeLayer(None), 1, self.cell, "คาแรง"), "คาแรง")


class ThaiHeaderTermTests(unittest.TestCase):
    def test_terms_fold_longest_first_and_keep_marks(self):
        self.assertEqual(fold_thai_header_terms("ราคาต่อ หน่วย").split(), ["unit", "price"])
        self.assertEqual(fold_thai_header_terms("ลำดับที่").split(), ["no"])
        self.assertEqual(fold_thai_header_terms("Unit Price"), "Unit Price")
        # A PDF-style split sara am (nikhahit + sara aa) still matches จำนวน.
        decomposed = "จ\u0e4d\u0e32นวน"
        self.assertEqual(fold_thai_header_terms(decomposed).split(), ["qty"])


if __name__ == "__main__":
    unittest.main()
