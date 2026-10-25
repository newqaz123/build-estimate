"""Section, row-pairing and OCR-repair rules of the row builder and parser.

Synthetic BOQs only: generic work names and invented prices.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from boq_compound_parser import derive_document, repair_ocr_unit  # noqa: E402
from boq_source_rows import (  # noqa: E402
    _fold_ocr_header,
    _normalize_cell_text,
    build_source_rows,
    remap_legacy_warnings,
)
from test_extraction_fixes import cell, items_of, table, two_tier_header  # noqa: E402

SIMPLE_HEADER = ["No.", "Description", "Qty", "Unit", "Rate", "Amount"]


def simple_table(body, header=SIMPLE_HEADER, page=1):
    cells = [cell(text, 0, column, header=True) for column, text in enumerate(header)]
    for row, values in enumerate(body, start=1):
        cells += [cell(value, row, column) for column, value in enumerate(values) if value != ""]
    return table(cells, page=page, num_cols=len(header))


def instances(result):
    return [(section["header"], [item["desc"] for item in section["items"]]) for section in result["sections"]]


class OutlineSectionTests(unittest.TestCase):
    def test_numbered_rows_open_nested_sections_and_a_sibling_closes_them(self):
        rows = build_source_rows([simple_table([
            ["1", "Pipe line A", "", "", "", ""],
            ["1.1", "Supply", "", "", "", ""],
            ["", "Pipe 2B", "10", "m", "5.00", "50.00"],
            ["1.2", "Install", "", "", "", ""],
            ["", "Welding", "1", "lot", "30.00", "30.00"],
            ["2", "Pipe line B", "", "", "", ""],
            ["", "Pipe 1B", "4", "m", "2.50", "10.00"],
        ])])
        self.assertEqual(instances(derive_document(rows)), [
            ("1 Pipe line A / 1.1 Supply", ["Pipe 2B"]),
            ("1 Pipe line A / 1.2 Install", ["Welding"]),
            ("2 Pipe line B", ["Pipe 1B"]),
        ])

    def test_description_only_title_inside_an_outline_is_a_subsection(self):
        rows = build_source_rows([simple_table([
            ["1", "Pipe line A", "", "", "", ""],
            ["", "Pipe 2B", "10", "m", "5.00", "50.00"],
            ["", "Hanger work", "", "", "", ""],
            ["", "Bracket", "4", "set", "2.50", "10.00"],
        ])])
        self.assertEqual(instances(derive_document(rows)), [
            ("1 Pipe line A", ["Pipe 2B"]),
            ("1 Pipe line A / Hanger work", ["Bracket"]),
        ])

    def test_total_row_closes_the_outline_so_later_lump_sums_are_unsectioned(self):
        rows = build_source_rows([simple_table([
            ["1", "Pipe line A", "", "", "", ""],
            ["", "Pipe 2B", "10", "m", "5.00", "50.00"],
            ["", "Total", "", "", "", "50.00"],
            ["2", "Mobilisation", "1", "lot", "20.00", "20.00"],
            ["", "Grand Total", "", "", "", "70.00"],
        ])])
        result = derive_document(rows)
        self.assertEqual(instances(result), [
            ("1 Pipe line A", ["Pipe 2B"]),
            ("Unsectioned", ["Mobilisation"]),
        ])
        self.assertEqual(result["sourceTotal"], 70.0)
        self.assertTrue(result["reconciliation"]["reconciled"])
        self.assertNotIn("section_total_mismatch", result["warningCodes"])

    def test_priced_row_with_a_higher_item_number_closes_the_outline(self):
        rows = build_source_rows([simple_table([
            ["1", "Pipe line A", "", "", "", ""],
            ["", "Pipe 2B", "10", "m", "5.00", "50.00"],
            ["2", "Safety control", "1", "lot", "20.00", "20.00"],
        ])])
        self.assertEqual(instances(derive_document(rows)), [
            ("1 Pipe line A", ["Pipe 2B"]),
            ("Unsectioned", ["Safety control"]),
        ])

    def test_legacy_unparsed_row_on_a_recognised_section_is_dropped(self):
        rows = build_source_rows([simple_table([
            ["1", "Pipe line A", "", "", "", ""],
            ["", "Pipe 2B", "10", "m", "5.00", "50.00"],
        ])])
        warnings = [
            {"code": "unparsed_row", "message": "Could not normalize row: Pipe line A", "sourceRef": None},
            {"code": "unparsed_row", "message": "Could not normalize row: Mystery", "sourceRef": None},
        ]
        kept = remap_legacy_warnings(warnings, [], rows)
        self.assertEqual([w["message"] for w in kept], ["Could not normalize row: Mystery"])


class RowPairingTests(unittest.TestCase):
    def test_description_row_followed_by_values_only_row_is_one_item(self):
        rows = build_source_rows([simple_table([
            ["", "Elbow 2B", "2", "pcs", "5.00", "10.00"],
            ["", "Tee, SS, Sch10S, Dia. 2B", "", "", "", ""],
            ["", "", "2", "pcs", "7.00", "14.00"],
        ])])
        result = derive_document(rows)
        items = items_of(result)
        self.assertEqual([(i["desc"], i["total"]) for i in items], [
            ("Elbow 2B", 10.0), ("Tee, SS, Sch10S, Dia. 2B", 14.0),
        ])
        self.assertEqual(len(items[1]["sourceRowIds"]), 2)
        self.assertNotIn("unsupported_row", result["warningCodes"])

    def test_text_note_in_a_component_price_column_is_not_a_bad_number(self):
        cells = two_tier_header() + [
            cell(text, 2, column) for column, text in {
                1: "Install pump", 2: "1", 3: "Set", 4: "Owner Supply",
                6: "500.00", 7: "500.00", 8: "500.00",
            }.items()
        ]
        result = derive_document(build_source_rows([table(cells)]))
        items = items_of(result)
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]["total"], 500.0)
        self.assertNotIn("invalid_numeric_format", result["warningCodes"])


class OcrRepairTests(unittest.TestCase):
    def test_confusable_header_letters_are_folded(self):
        self.assertEqual(_fold_ocr_header("Unlt/Price"), "Unit/Price")
        self.assertEqual(_fold_ocr_header("Materlal"), "Material")
        self.assertEqual(_fold_ocr_header("Spac"), "Spac")  # unknown word stays

    def test_lost_quantity_header_is_inferred_from_numeric_column_before_unit(self):
        header = ["No.", "Description", "41,0", "Unlt", "Rate", "Amount"]
        rows = build_source_rows([simple_table([
            ["1", "Panel", "50.0", "m2", "4.00", "200.00"],
            ["2", "Purlin", "24.0", "m", "2.00", "48.00"],
            ["3", "Painting", "1.0", "lot", "40.00", "40.00"],
        ], header=header)])
        self.assertEqual(rows[1]["headers"][2], "Qty")
        self.assertEqual(rows[1]["headers"][3], "Unit")
        items = items_of(derive_document(rows))
        self.assertEqual([(i["qty"], i["unit"]) for i in items], [(50.0, "m2"), (24.0, "m"), (1.0, "lot")])

    def test_ocr_unit_is_repaired_with_a_warning(self):
        self.assertEqual(repair_ocr_unit("1ot."), "lot.")
        self.assertIsNone(repair_ocr_unit("lot."))
        self.assertIsNone(repair_ocr_unit("m2"))
        self.assertIsNone(repair_ocr_unit("widgets"))
        rows = build_source_rows([simple_table([
            ["1", "Safety control", "1", "1ot.", "40.00", "40.00"],
        ])])
        result = derive_document(rows)
        self.assertEqual(items_of(result)[0]["unit"], "lot.")
        self.assertIn("ocr_corrected_value", result["warningCodes"])

    def test_thai_header_terms_normalise_to_vocabulary(self):
        self.assertEqual(_normalize_cell_text("ลำดับ"), "no")
        self.assertEqual(_normalize_cell_text("จำนวนเงิน"), "amount")
        self.assertEqual(_normalize_cell_text("ราคาต่อ หน่วย"), "unit price")
        rows = build_source_rows([simple_table(
            [["1", "งานทาสี", "1", "งาน", "100.00", "100.00"]],
            header=["ลำดับ", "รายการ", "จำนวน", "หน่วย", "ราคาต่อหน่วย", "จำนวนเงิน"],
        )])
        self.assertEqual(rows[0]["classification"], "header")
        self.assertEqual(items_of(derive_document(rows))[0]["total"], 100.0)


class QuoteSummaryTests(unittest.TestCase):
    def test_blank_discount_line_counts_as_zero(self):
        rows = build_source_rows([simple_table([
            ["1", "Widget", "2", "set", "50.00", "100.00"],
            ["", "SUB TOTAL", "", "", "", "100.00"],
            ["", "OVERHEAD & EXPENSES", "", "", "", "10.00"],
            ["", "TOTAL", "", "", "", "110.00"],
            ["", "DISCOUNT", "", "", "", ""],
            ["", "GRAND TOTAL", "", "", "", "110.00"],
        ])])
        result = derive_document(rows)
        self.assertEqual(result["sourceTotal"], 110.0)
        self.assertIsNotNone(result["sourceQuoteSummary"])
        self.assertEqual(result["sourceQuoteSummary"]["discountAmount"], "0")
        self.assertTrue(result["reconciliation"]["reconciled"])


if __name__ == "__main__":
    unittest.main()
