"""Geometry clean-up of Docling table cells (synthetic layouts only)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from boq_compound_parser import derive_document  # noqa: E402
from boq_source_rows import build_source_rows  # noqa: E402
from table_geometry import prepare_tables  # noqa: E402
from test_extraction_fixes import cell, items_of, table  # noqa: E402

# Column x-ranges of a synthetic 6-column BOQ: No | Description | Qty | Unit | Rate | Amount
X = [(40, 50), (52, 200), (210, 230), (240, 260), (270, 300), (310, 340)]
HEADER = ["No.", "Description", "Qty", "Unit", "Rate", "Amount"]


def positioned(text, row, column, *, header=False, at=None, width=None):
    left, right = X[at if at is not None else column]
    if width is not None:
        right = left + width
    return cell(text, row, column, header=header, left=left, right=right)


def header_band():
    return [positioned(text, 0, column, header=True) for column, text in enumerate(HEADER)]


def priced(row, number, desc, qty, unit, rate, amount):
    return [
        positioned(number, row, 0), positioned(desc, row, 1, width=60),
        positioned(qty, row, 2), positioned(unit, row, 3),
        positioned(rate, row, 4), positioned(amount, row, 5),
    ]


def by_position(prepared_table):
    return {
        (c["start_row_offset_idx"], c["start_col_offset_idx"]): c["text"]
        for c in prepared_table["cells"]
    }


class RealignTests(unittest.TestCase):
    def test_item_number_indexed_into_wrong_column_moves_back_by_position(self):
        cells = header_band() + priced(1, "1", "Widget A", "2", "set", "10.00", "20.00")
        cells += [
            cell("2", 2, 5, left=42, right=48),  # number indexed as the last column
            positioned("Widget B", 2, 1, width=60), positioned("3", 2, 2),
            positioned("pcs", 2, 3), positioned("5.00", 2, 4),
        ]
        prepared = prepare_tables([table(cells, num_cols=6)])
        self.assertEqual(by_position(prepared[0])[(2, 0)], "2")
        self.assertNotIn((2, 5), by_position(prepared[0]))

    def test_long_description_starting_in_its_column_stays_there(self):
        cells = header_band() + priced(1, "1", "Widget A", "2", "set", "10.00", "20.00")
        cells += priced(2, "2", "Widget B", "1", "set", "5.00", "5.00")
        # Starts at the description column's left edge, overruns the column,
        # and its left edge is also within tolerance of the No. column.
        long_text = cell("Sheet : TYPE X long description", 3, 1, left=52, right=260)
        cells += [long_text, positioned("4", 3, 2), positioned("m2", 3, 3),
                  positioned("3.00", 3, 4), positioned("12.00", 3, 5)]
        prepared = prepare_tables([table(cells, num_cols=6)])
        self.assertEqual(by_position(prepared[0])[(3, 1)], "Sheet : TYPE X long description")

    def test_column_with_one_body_cell_uses_its_header_position(self):
        cells = [positioned(text, 0, column, header=True) for column, text in enumerate(HEADER)]
        cells += [cell("Remark", 0, 6, header=True, left=350, right=380)]
        # The only body cell of the Remark column is an item number placed far left.
        cells += [cell("A", 1, 6, left=42, right=48), positioned("Job title", 1, 1, width=60)]
        cells += priced(2, "1", "Widget", "1", "set", "5.00", "5.00")
        prepared = prepare_tables([table(cells, num_cols=7)])
        self.assertEqual(by_position(prepared[0])[(1, 0)], "A")

    def test_ruling_noise_in_numeric_column_becomes_empty_marker(self):
        cells = header_band()
        for row in range(1, 5):
            cells += priced(row, str(row), f"Widget {row}", "1", "set", "5.00", "5.00")
        cells += [positioned("Section title", 5, 1, width=60), positioned("=", 5, 4), positioned("π", 5, 5)]
        prepared = prepare_tables([table(cells, num_cols=6)])
        positions = by_position(prepared[0])
        self.assertEqual((positions[(5, 4)], positions[(5, 5)]), ("-", "-"))

    def test_header_flag_on_a_numeric_row_is_dropped(self):
        cells = header_band() + [
            cell(text, 1, column, header=True, left=X[column][0], right=X[column][1])
            for column, text in enumerate(["1", "Widget", "2", "set", "10.00", "20.00"])
        ]
        prepared = prepare_tables([table(cells, num_cols=6)])
        self.assertFalse(any(
            c["column_header"] for c in prepared[0]["cells"] if c["start_row_offset_idx"] == 1
        ))


class ContinuationTests(unittest.TestCase):
    def test_headerless_next_page_is_mapped_onto_header_grid_and_inherits_headers(self):
        first = header_band() + priced(1, "1", "Widget A", "2", "set", "10.00", "20.00")
        # Page 2: TableFormer dropped the empty No. column and re-indexed the
        # rest one to the left; positions still match page 1's columns.
        second = []
        for row, (desc, qty, rate, amount) in enumerate([
            ("Widget B", "1", "5.00", "5.00"), ("Widget C", "4", "2.50", "10.00"),
        ]):
            second += [
                cell(desc, row, 0, left=53, right=120), cell(qty, row, 1, left=212, right=228),
                cell("pcs", row, 2, left=242, right=258), cell(rate, row, 3, left=272, right=298),
                cell(amount, row, 4, left=312, right=338),
            ]
        prepared = prepare_tables([table(first, num_cols=6), table(second, page=2, num_cols=5)])
        self.assertTrue(prepared[1]["continuesTable"])
        self.assertEqual(prepared[1]["num_cols"], 6)
        self.assertEqual(by_position(prepared[1])[(0, 1)], "Widget B")
        rows = build_source_rows(prepared)
        page_two = [row for row in rows if row["page"] == 2]
        self.assertEqual(page_two[0]["classification"], "item")  # first data row is kept
        self.assertEqual(page_two[0]["headers"], rows[1]["headers"])
        items = items_of(derive_document(rows))
        self.assertEqual([item["desc"] for item in items], ["Widget A", "Widget B", "Widget C"])
        self.assertEqual([item["total"] for item in items], [20.0, 5.0, 10.0])

    def test_table_without_geometry_passes_through(self):
        cells = [cell(text, 0, column, header=True) for column, text in enumerate(HEADER)]
        prepared = prepare_tables([table(cells)])
        self.assertNotIn("continuesTable", prepared[0])
        self.assertEqual(len(prepared[0]["cells"]), 6)


if __name__ == "__main__":
    unittest.main()
