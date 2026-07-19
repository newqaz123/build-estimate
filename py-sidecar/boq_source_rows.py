import hashlib
import json
import re
from collections import Counter
from typing import Any

from boq_contract import RawCell, SourceRow


TOTAL_ROW = re.compile(r"^(?:sub[\s-]*total|grand[\s-]+total|total|vat|discount)\b", re.I)
OPTION_ROW = re.compile(r"\b(?:optional|option|alternate|alternative|provisional|add-on)\b", re.I)
NOTE_ROW = re.compile(r"^(?:note|notes|remark|remarks)\b", re.I)


def _read(value: Any, name: str, default: Any = None) -> Any:
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _integer(value: Any, name: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError) as error:
        raise ValueError(f"raw cell {name} must be an integer") from error


def _raw_cell(cell: Any) -> dict[str, Any]:
    text = str(_read(cell, "text", "") or "")
    start_row = _integer(_read(cell, "start_row_offset_idx"), "start_row_offset_idx")
    end_row = _integer(_read(cell, "end_row_offset_idx"), "end_row_offset_idx")
    start_column = _integer(_read(cell, "start_col_offset_idx"), "start_col_offset_idx")
    end_column = _integer(_read(cell, "end_col_offset_idx"), "end_col_offset_idx")
    row_span = _integer(_read(cell, "row_span", end_row - start_row), "row_span")
    column_span = _integer(_read(cell, "col_span", end_column - start_column), "col_span")
    model = RawCell(
        column=start_column,
        rawText=text,
        lines=text.replace("\r\n", "\n").replace("\r", "\n").split("\n"),
        rowSpan=row_span,
        columnSpan=column_span,
        startRowOffset=start_row,
        endRowOffset=end_row,
        startColumnOffset=start_column,
        endColumnOffset=end_column,
        columnHeader=bool(_read(cell, "column_header", False)),
        rowHeader=bool(_read(cell, "row_header", False)),
        rowSection=bool(_read(cell, "row_section", False)),
    )
    return model.model_dump()


def _classify(cells: list[dict[str, Any]], raw_text: str) -> str:
    if any(cell["columnHeader"] for cell in cells):
        return "header"
    if any(cell["rowSection"] for cell in cells):
        return "section"
    normalized = raw_text.strip()
    if TOTAL_ROW.search(normalized):
        return "total"
    if OPTION_ROW.search(normalized):
        return "option"
    if NOTE_ROW.search(normalized):
        return "note"
    return "item" if normalized else "unknown"


def _row_id(page: int, table: int, row: int, cells: list[dict[str, Any]], occurrence: int) -> str:
    evidence = json.dumps(cells, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    raw_hash = hashlib.sha256(evidence.encode("utf-8")).hexdigest()
    provenance = f"{page}:{table}:{row}:{raw_hash}:{occurrence}"
    return f"sr-{hashlib.sha256(provenance.encode('utf-8')).hexdigest()[:32]}"


def build_source_rows(tables: list[Any]) -> list[dict[str, Any]]:
    """Build lossless, run-local source rows directly from Docling table cells."""
    rows: list[dict[str, Any]] = []
    occurrences: Counter[tuple[int, int, int, str]] = Counter()

    for table_value in tables:
        page = _integer(_read(table_value, "page", 1), "page")
        table = _integer(_read(table_value, "table", 1), "table")
        cells = [_raw_cell(cell) for cell in (_read(table_value, "cells", []) or [])]
        row_count = max((cell["endRowOffset"] for cell in cells), default=0)
        headers: dict[int, str] = {}
        section: str | None = None

        for row_offset in range(row_count):
            row_cells = sorted(
                [
                    cell for cell in cells
                    if cell["startRowOffset"] <= row_offset < cell["endRowOffset"]
                ],
                key=lambda cell: (cell["startColumnOffset"], cell["endColumnOffset"]),
            )
            for cell in row_cells:
                if cell["columnHeader"] and cell["rawText"]:
                    headers[cell["column"]] = cell["rawText"]
            section_cells = [cell["rawText"] for cell in row_cells if cell["rowSection"] and cell["rawText"]]
            if section_cells:
                section = " | ".join(section_cells)
            raw_text = " | ".join(cell["rawText"] for cell in row_cells if cell["rawText"])
            evidence = json.dumps(row_cells, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            evidence_hash = hashlib.sha256(evidence.encode("utf-8")).hexdigest()
            occurrence_key = (page, table, row_offset + 1, evidence_hash)
            occurrence = occurrences[occurrence_key]
            occurrences[occurrence_key] += 1
            source_row = SourceRow(
                id=_row_id(page, table, row_offset + 1, row_cells, occurrence),
                page=page,
                table=table,
                row=row_offset + 1,
                section=section,
                headers=[headers[column] for column in sorted(headers)],
                rawCells=row_cells,
                rawText=raw_text,
                classification=_classify(row_cells, raw_text),
                confidence=1.0,
                warnings=[],
            )
            rows.append(source_row.model_dump())
    return rows
