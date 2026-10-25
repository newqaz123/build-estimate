"""Regression tests for scanned/two-tier BOQ extraction fixes.

All fixtures are synthetic: generic descriptions and invented prices that only
mirror the *layout* of real quotations (no vendor names or real figures).
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from boq_compound_parser import _find_columns, derive_document  # noqa: E402
from boq_source_rows import build_source_rows  # noqa: E402


def cell(text, row, column, *, header=False, col_span=1, row_span=1, left=None, right=None):
    data = {
        "text": text,
        "start_row_offset_idx": row,
        "end_row_offset_idx": row + row_span,
        "start_col_offset_idx": column,
        "end_col_offset_idx": column + col_span,
        "row_span": row_span,
        "col_span": col_span,
        "column_header": header,
        "row_header": False,
        "row_section": False,
    }
    if left is not None:
        data["bbox"] = {"l": left, "r": right if right is not None else left + 10}
    return data


def table(cells, page=1, number=1, num_cols=None):
    return {
        "page": page,
        "table": number,
        "cells": cells,
        "num_rows": max(c["end_row_offset_idx"] for c in cells),
        "num_cols": num_cols or max(c["end_col_offset_idx"] for c in cells),
    }


def two_tier_header():
    """Item | Description | Q'ty | Unit | Material(Price/Unit, Price) | Labour(...) | TOTAL"""
    return [
        cell("Item", 0, 0, header=True),
        cell("Q'ty", 0, 2, header=True),
        cell("Unit", 0, 3, header=True),
        cell("Material", 0, 4, header=True, col_span=2),
        cell("Labour", 0, 6, header=True, col_span=2),
        cell("TOTAL", 0, 8, header=True),
        cell("Description", 1, 1, header=True),
        cell("Price/Unit", 1, 4, header=True),
        cell("Price", 1, 5, header=True),
        cell("Price/Unit", 1, 6, header=True),
        cell("Price", 1, 7, header=True),
    ]


def data_row(row, values):
    return [cell(value, row, column) for column, value in values.items()]


def items_of(result):
    return [item for section in result["sections"] for item in section["items"]]


class ComponentPriceColumnTests(unittest.TestCase):
    def test_bare_price_under_component_is_total_not_rate(self):
        cells = two_tier_header() + data_row(2, {
            1: "Elbow, Dia. 2B", 2: "4", 3: "No.", 4: "10.00", 5: "40.00",
            6: "5.00", 7: "20.00", 8: "60.00",
        })
        rows = build_source_rows([table(cells)])
        roles = _find_columns(rows[-1])
        self.assertEqual(
            {key: roles[key] for key in ("material_rate", "material_total", "labour_rate", "labour_total")},
            {"material_rate": 4, "material_total": 5, "labour_rate": 6, "labour_total": 7},
        )
        items = items_of(derive_document(rows))
        self.assertEqual(len(items), 1)
        costs = items[0]["sourceCosts"]
        self.assertEqual((costs["material"]["rate"], costs["material"]["total"]), (10.0, 40.0))
        self.assertEqual((costs["labour"]["rate"], costs["labour"]["total"]), (5.0, 20.0))
        self.assertEqual(items[0]["total"], 60.0)


if __name__ == "__main__":
    unittest.main()
