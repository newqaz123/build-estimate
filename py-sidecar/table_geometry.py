"""Geometry-aware clean-up of Docling table cells before source-row building.

Scanned BOQs come back from TableFormer with three recurring defects that the
row builder cannot fix from text alone:

1. continuation pages are separate tables without a header band, and their
   column indices do not line up with the header page (one column fewer, the
   item-number column moved to the end);
2. single cells land in the wrong column index even though their position on
   the page is unambiguous (an item number at the far left indexed as the last
   column, a description indexed into an empty pricing column);
3. OCR turns ruling-line fragments in empty numeric cells into "=", "π", "”".

Everything here is decided from cell bounding boxes, so it is layout-generic:
no vendor vocabulary, no fixed column counts. Tables without bounding boxes
are passed through unchanged.
"""

from __future__ import annotations

import re
import statistics
from typing import Any

from boq_source_rows import _cell_pricing_concepts, _cell_text, _read
from pdf_text_layer import TextLayer, repaired_cell_text

_NUMBER = re.compile(r"^\(?[-+]?\d[\d,]*(?:\.\d+)?\)?$")
_EMPTY_MARKS = {"-", "—", "–"}
# Edge tolerance (PDF points) when testing whether a position is inside a column.
_TOLERANCE = 8.0
_MIN_MAPPED_COLUMN_SHARE = 0.6


def _is_number(text: str) -> bool:
    return bool(_NUMBER.match(text.strip()))


def _bbox(cell: Any) -> tuple[float, float] | None:
    box = _read(cell, "bbox", None)
    if box is None:
        return None
    left = box.get("l") if isinstance(box, dict) else getattr(box, "l", None)
    right = box.get("r") if isinstance(box, dict) else getattr(box, "r", None)
    if left is None or right is None:
        return None
    return float(min(left, right)), float(max(left, right))


def _to_dict(
    cell: Any, document: Any | None, layer: TextLayer | None = None, page_no: int | None = None,
) -> dict[str, Any]:
    start_row = _read(cell, "start_row_offset_idx")
    end_row = _read(cell, "end_row_offset_idx")
    start_col = _read(cell, "start_col_offset_idx")
    end_col = _read(cell, "end_col_offset_idx")
    data = {
        "text": repaired_cell_text(layer, page_no, cell, _cell_text(cell, document)),
        "start_row_offset_idx": start_row,
        "end_row_offset_idx": end_row,
        "start_col_offset_idx": start_col,
        "end_col_offset_idx": end_col,
        "row_span": _read(cell, "row_span", end_row - start_row),
        "col_span": _read(cell, "col_span", end_col - start_col),
        "column_header": _read(cell, "column_header", False),
        "row_header": _read(cell, "row_header", False),
        "row_section": _read(cell, "row_section", False),
    }
    box = _bbox(cell)
    if box is not None:
        data["bbox"] = {"l": box[0], "r": box[1]}
    return data


def _rows(cells: list[dict[str, Any]]) -> dict[int, list[dict[str, Any]]]:
    rows: dict[int, list[dict[str, Any]]] = {}
    for cell in cells:
        rows.setdefault(cell["start_row_offset_idx"], []).append(cell)
    return rows


def _numeric_count(row_cells: list[dict[str, Any]]) -> int:
    return sum(1 for cell in row_cells if _is_number(cell["text"]))


def _unflag_numeric_header_rows(cells: list[dict[str, Any]]) -> None:
    """A row carrying two or more standalone numbers is data, whatever its flag."""
    for row_cells in _rows(cells).values():
        if _numeric_count(row_cells) >= 2:
            for cell in row_cells:
                cell["column_header"] = False


def _clean_numeric_column_noise(cells: list[dict[str, Any]], num_cols: int) -> int:
    """Replace OCR'd ruling-line fragments in numeric columns with "-"."""
    by_column: dict[int, list[dict[str, Any]]] = {}
    for cell in cells:
        if cell["col_span"] == 1 and not cell["column_header"] and cell["text"].strip():
            by_column.setdefault(cell["start_col_offset_idx"], []).append(cell)
    cleaned = 0
    for column_cells in by_column.values():
        numeric = sum(1 for cell in column_cells if _is_number(cell["text"]) or cell["text"].strip() in _EMPTY_MARKS)
        if numeric < 3 or numeric / len(column_cells) < 0.6:
            continue
        for cell in column_cells:
            text = cell["text"].strip()
            if _is_number(text) or text in _EMPTY_MARKS:
                continue
            if len(text) <= 2 and not any(char.isdigit() for char in text):
                cell["text"] = "-"
                cleaned += 1
    return cleaned


def _column_intervals(cells: list[dict[str, Any]], num_cols: int) -> list[tuple[float, float] | None]:
    """Per column (median left, median right) of its single-span cells.

    Body cells win; header cells are the fallback for columns with no body.
    Cells far from the column's main cluster (mis-indexed strays) are ignored.
    """
    intervals: list[tuple[float, float] | None] = []
    for column in range(num_cols):
        boxes = [
            (cell["bbox"]["l"], cell["bbox"]["r"])
            for cell in cells
            if "bbox" in cell and cell["col_span"] == 1
            and cell["start_col_offset_idx"] == column and cell["text"].strip()
            and not cell["column_header"]
        ]
        if len(boxes) < 2:
            # One body cell cannot vouch for a column (it may be the stray);
            # the column's own header label is better evidence.
            header_boxes = [
                (cell["bbox"]["l"], cell["bbox"]["r"])
                for cell in cells
                if "bbox" in cell and cell["col_span"] == 1 and cell["column_header"]
                and cell["start_col_offset_idx"] == column and cell["text"].strip()
            ]
            boxes = header_boxes or boxes
        if not boxes:
            intervals.append(None)
            continue
        centres = [(left + right) / 2 for left, right in boxes]
        middle = statistics.median(centres)
        spread = max(40.0, statistics.median(right - left for left, right in boxes))
        cluster = [box for box, centre in zip(boxes, centres) if abs(centre - middle) <= spread]
        if not cluster:
            cluster = boxes
        intervals.append((
            statistics.median(left for left, _ in cluster),
            statistics.median(right for _, right in cluster),
        ))
    return intervals


def _distance(position: float, interval: tuple[float, float]) -> float:
    left, right = interval
    if left - _TOLERANCE <= position <= right + _TOLERANCE:
        return 0.0
    return min(abs(position - left), abs(position - right))


def _target_column(cell: dict[str, Any], intervals: list[tuple[float, float] | None]) -> int | None:
    """Column whose interval holds the cell's centre (or, for text, its left edge)."""
    left, right = cell["bbox"]["l"], cell["bbox"]["r"]
    probes = [(left + right) / 2]
    if not _is_number(cell["text"]):
        probes.append(left + 2)  # left-aligned descriptions may overrun the column
    for probe in probes:
        hits = [
            column for column, interval in enumerate(intervals)
            if interval is not None and _distance(probe, interval) == 0.0
        ]
        if len(hits) == 1:
            return hits[0]
        strict = [
            column for column in hits
            if intervals[column][0] <= probe <= intervals[column][1]  # type: ignore[index]
        ]
        if len(strict) == 1:
            return strict[0]
        if len(hits) > 1:
            return min(hits, key=lambda column: abs(probe - sum(intervals[column]) / 2))  # type: ignore[arg-type]
    return None


def _move(cell: dict[str, Any], column: int) -> None:
    span = cell["end_col_offset_idx"] - cell["start_col_offset_idx"]
    cell["start_col_offset_idx"] = column
    cell["end_col_offset_idx"] = column + span


def _occupied(cells: list[dict[str, Any]]) -> set[tuple[int, int]]:
    taken: set[tuple[int, int]] = set()
    for cell in cells:
        for row in range(cell["start_row_offset_idx"], cell["end_row_offset_idx"]):
            for column in range(cell["start_col_offset_idx"], cell["end_col_offset_idx"]):
                taken.add((row, column))
    return taken


def _realign_strays(cells: list[dict[str, Any]], num_cols: int) -> int:
    """Move single cells that sit visibly inside another, empty, column."""
    intervals = _column_intervals(cells, num_cols)
    moved = 0
    taken = _occupied(cells)
    for cell in cells:
        if "bbox" not in cell or cell["col_span"] != 1 or not cell["text"].strip():
            continue
        own = cell["start_col_offset_idx"]
        own_interval = intervals[own] if own < len(intervals) else None
        centre = (cell["bbox"]["l"] + cell["bbox"]["r"]) / 2
        if own_interval is not None and _distance(centre, own_interval) == 0.0:
            continue
        target = _target_column(cell, intervals)
        row = cell["start_row_offset_idx"]
        if target is None or target == own or (row, target) in taken:
            continue
        taken.discard((row, own))
        taken.add((row, target))
        _move(cell, target)
        moved += 1
    return moved


def _has_header_band(cells: list[dict[str, Any]]) -> bool:
    """True when rows before the first priced row carry header vocabulary."""
    for row in sorted(_rows(cells)):
        row_cells = [cell for cell in cells if cell["start_row_offset_idx"] == row]
        if _numeric_count(row_cells) >= 2:
            return False
        concepts: set[str] = set()
        for cell in row_cells:
            concepts |= _cell_pricing_concepts(cell["text"])
        if len(concepts) >= 2 or any(cell["column_header"] for cell in row_cells):
            return True
    return False


def _map_to_grid(
    cells: list[dict[str, Any]], num_cols: int, grid: list[tuple[float, float] | None],
) -> list[dict[str, Any]] | None:
    """Re-index a headerless continuation table onto the previous header grid."""
    if any("bbox" not in cell for cell in cells):
        return None
    own_intervals = _column_intervals(cells, num_cols)
    column_map: dict[int, int] = {}
    for column, interval in enumerate(own_intervals):
        if interval is None:
            continue
        probe = {"bbox": {"l": interval[0], "r": interval[1]}, "text": "0"}
        target = _target_column(probe, grid)
        if target is not None:
            column_map[column] = target
    populated = [column for column, interval in enumerate(own_intervals) if interval is not None]
    if not populated or len(column_map) / len(populated) < _MIN_MAPPED_COLUMN_SHARE:
        return None
    mapped = [dict(cell) for cell in cells]
    taken: set[tuple[int, int]] = set()
    for cell in mapped:
        row = cell["start_row_offset_idx"]
        if cell["col_span"] == 1:
            target = _target_column(cell, grid)
            if target is None:
                target = column_map.get(cell["start_col_offset_idx"])
            if target is None or (row, target) in taken:
                fallback = column_map.get(cell["start_col_offset_idx"])
                if fallback is None or (row, fallback) in taken:
                    return None
                target = fallback
            _move(cell, target)
            taken.add((row, target))
            continue
        start = column_map.get(cell["start_col_offset_idx"])
        end = column_map.get(cell["end_col_offset_idx"] - 1)
        if start is None or end is None or end < start:
            return None
        cell["start_col_offset_idx"], cell["end_col_offset_idx"] = start, end + 1
        cell["col_span"] = end + 1 - start
        for column in range(start, end + 1):
            if (row, column) in taken:
                return None
            taken.add((row, column))
    return mapped


def prepare_tables(
    tables: list[dict[str, Any]], *, document: Any | None = None, text_layer: TextLayer | None = None,
) -> list[dict[str, Any]]:
    """Return tables with plain-dict cells, cleaned and aligned by geometry.

    Adds ``continuesTable: True`` to a headerless table that was mapped onto
    the previous table's header grid; the row builder then carries that
    table's header band and open section forward.
    """
    prepared: list[dict[str, Any]] = []
    grid: list[tuple[float, float] | None] | None = None
    grid_cols = 0
    for table in tables:
        num_cols = table["num_cols"]
        # "sourcePage" is the page inside the converted PDF (it differs from
        # "page" when only selected pages were converted).
        source_page = table.get("sourcePage", table.get("page"))
        cells = [_to_dict(cell, document, text_layer, source_page) for cell in table["cells"]]
        _unflag_numeric_header_rows(cells)
        _clean_numeric_column_noise(cells, num_cols)
        result = {**table, "cells": cells}
        geometric = bool(cells) and all("bbox" in cell for cell in cells)
        header_band = _has_header_band(cells)
        if geometric and grid is not None and not header_band:
            mapped = _map_to_grid(cells, num_cols, grid)
            if mapped is not None:
                result = {**table, "cells": mapped, "num_cols": grid_cols, "continuesTable": True}
                cells = mapped
                num_cols = grid_cols
        if geometric and not result.get("continuesTable"):
            _realign_strays(cells, num_cols)
        if geometric and (header_band or result.get("continuesTable")):
            intervals = _column_intervals(cells, num_cols)
            if grid is not None and result.get("continuesTable"):
                # Keep the header page's intervals where this page has none.
                intervals = [own or previous for own, previous in zip(intervals, grid)]
            grid, grid_cols = intervals, num_cols
        elif not geometric:
            grid = None
        prepared.append(result)
    return prepared
