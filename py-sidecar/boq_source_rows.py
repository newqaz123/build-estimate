import hashlib
import json
import re
import unicodedata
from collections import Counter
from decimal import Decimal, InvalidOperation
from typing import Any

from boq_contract import RECONCILIATION_TOLERANCE, RawCell, SourceRow
from boq_parser import parse_number


TOTAL_ROW = re.compile(r"^(?:sub[\s-]*total|grand[\s-]+total|total|vat|discount)\b", re.I)
OPTION_ROW = re.compile(r"\b(?:optional|option|alternate|alternative|provisional|add-on)\b", re.I)
NOTE_ROW = re.compile(r"^(?:note|notes|remark|remarks)\b", re.I)
NUMBER_TOKEN = re.compile(r"(?:\(?[-+]?\d[\d,]*(?:\.\d+)?\)?)")
MISSING = object()


def _read(value: Any, name: str, default: Any = MISSING) -> Any:
    if isinstance(value, dict):
        result = value.get(name, MISSING)
    else:
        result = getattr(value, name, MISSING)
    if result is MISSING:
        if default is MISSING:
            raise ValueError(f"missing required source evidence field: {name}")
        return default
    return result


def _strict_int(value: Any, name: str, *, minimum: int = 0) -> int:
    if type(value) is not int or value < minimum:
        raise ValueError(f"{name} must be an integer greater than or equal to {minimum}")
    return value


def _strict_bool(value: Any, name: str) -> bool:
    if type(value) is not bool:
        raise ValueError(f"{name} must be a boolean")
    return value


def _strict_text(value: Any, name: str) -> str:
    if type(value) is not str:
        raise ValueError(f"{name} must be a string")
    return value


def _cell_text(cell: Any, document: Any | None) -> str:
    text = _strict_text(_read(cell, "text"), "raw cell text")
    if text or _read(cell, "ref", None) is None:
        return text
    if document is None:
        raise ValueError("rich table cell text requires document context")
    resolver = getattr(cell, "_get_text", None)
    if not callable(resolver):
        raise ValueError("rich table cell has no supported text resolver")
    return _strict_text(resolver(doc=document), "resolved rich table cell text")


def _raw_cell(cell: Any, document: Any | None) -> dict[str, Any]:
    text = _cell_text(cell, document)
    start_row = _strict_int(_read(cell, "start_row_offset_idx"), "start_row_offset_idx")
    end_row = _strict_int(_read(cell, "end_row_offset_idx"), "end_row_offset_idx", minimum=1)
    start_column = _strict_int(_read(cell, "start_col_offset_idx"), "start_col_offset_idx")
    end_column = _strict_int(_read(cell, "end_col_offset_idx"), "end_col_offset_idx", minimum=1)
    row_span = _strict_int(_read(cell, "row_span", end_row - start_row), "row_span", minimum=1)
    column_span = _strict_int(_read(cell, "col_span", end_column - start_column), "col_span", minimum=1)
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
        columnHeader=_strict_bool(_read(cell, "column_header", False), "column_header"),
        rowHeader=_strict_bool(_read(cell, "row_header", False), "row_header"),
        rowSection=_strict_bool(_read(cell, "row_section", False), "row_section"),
        carried=False,
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


def _index_cells_by_row(
    cells: list[dict[str, Any]], row_count: int
) -> list[list[dict[str, Any]]]:
    """Index each raw cell into its covered logical rows once."""
    buckets: list[list[dict[str, Any]]] = [[] for _ in range(row_count)]
    for cell in cells:
        for row_offset in range(cell["startRowOffset"], cell["endRowOffset"]):
            buckets[row_offset].append({
                **cell,
                "carried": cell["startRowOffset"] != row_offset,
            })
    for bucket in buckets:
        bucket.sort(key=lambda cell: (cell["startColumnOffset"], cell["endColumnOffset"]))
    return buckets


def build_source_rows(tables: list[Any], *, document: Any | None = None) -> list[dict[str, Any]]:
    """Build lossless, run-local source rows directly from Docling table cells and dimensions."""
    if type(tables) is not list:
        raise ValueError("tables must be a list")
    rows: list[dict[str, Any]] = []
    occurrences: Counter[tuple[int, int, int, str]] = Counter()

    for table_value in tables:
        page = _strict_int(_read(table_value, "page"), "page", minimum=1)
        table = _strict_int(_read(table_value, "table"), "table", minimum=1)
        row_count = _strict_int(_read(table_value, "num_rows"), "num_rows")
        column_count = _strict_int(_read(table_value, "num_cols"), "num_cols")
        raw_cells = _read(table_value, "cells")
        if type(raw_cells) is not list:
            raise ValueError("cells must be a list")
        cells = [_raw_cell(cell, document) for cell in raw_cells]
        for cell in cells:
            if cell["endRowOffset"] > row_count or cell["endColumnOffset"] > column_count:
                raise ValueError("raw cell geometry exceeds declared table dimensions")

        headers: dict[int, str] = {}
        section: str | None = None
        indexed_cells = _index_cells_by_row(cells, row_count)
        for row_offset, covered_cells in enumerate(indexed_cells):
            anchor_cells = [cell for cell in covered_cells if not cell["carried"]]

            for cell in anchor_cells:
                if cell["columnHeader"] and cell["rawText"]:
                    for column in range(cell["startColumnOffset"], cell["endColumnOffset"]):
                        headers[column] = cell["rawText"]
            section_cells = [
                cell["rawText"] for cell in anchor_cells if cell["rowSection"] and cell["rawText"]
            ]
            if section_cells:
                section = " | ".join(section_cells)
            raw_text = " | ".join(cell["rawText"] for cell in anchor_cells if cell["rawText"])
            evidence = json.dumps(covered_cells, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
            evidence_hash = hashlib.sha256(evidence.encode("utf-8")).hexdigest()
            occurrence_key = (page, table, row_offset + 1, evidence_hash)
            occurrence = occurrences[occurrence_key]
            occurrences[occurrence_key] += 1
            source_row = SourceRow(
                id=_row_id(page, table, row_offset + 1, covered_cells, occurrence),
                page=page,
                table=table,
                row=row_offset + 1,
                section=section,
                headers=[headers[column] for column in sorted(headers)],
                rawCells=covered_cells,
                rawText=raw_text,
                classification=_classify(anchor_cells, raw_text),
                confidence=1.0,
                warnings=[],
            )
            rows.append(source_row.model_dump())
    return rows


def _canonical_text(value: Any) -> str:
    if type(value) is not str:
        return ""
    normalized = "".join(
        character if unicodedata.category(character)[0] in {"L", "M", "N"} else " "
        for character in value.casefold()
    )
    return " ".join(normalized.split())


def _numbers_from_cells(cells: list[dict[str, Any]]) -> list[float]:
    numbers: list[float] = []
    for cell in cells:
        for token in NUMBER_TOKEN.findall(cell["rawText"]):
            numbers.append(parse_number(token))
    return numbers


def _number_present(expected: float, actual: list[float]) -> bool:
    return any(abs(expected - value) <= 0.01 for value in actual)


def _numeric_evidence_reconciles(item: dict[str, Any], numbers: list[float]) -> bool:
    total = item.get("total")
    if type(total) not in (int, float):
        return False
    if _number_present(float(total), numbers):
        return True
    qty, rate = item.get("qty"), item.get("rate")
    if type(qty) not in (int, float) or type(rate) not in (int, float):
        return False
    if not _number_present(float(qty), numbers) or not _number_present(float(rate), numbers):
        return False
    try:
        quantity = Decimal(str(qty))
        unit_rate = Decimal(str(rate))
        derived_total = Decimal(str(total))
    except (InvalidOperation, ValueError):
        return False
    if not all(value.is_finite() for value in (quantity, unit_rate, derived_total)):
        return False
    return abs(quantity * unit_rate - derived_total) <= RECONCILIATION_TOLERANCE


def _candidate_rows(item: dict[str, Any], source_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    source_ref = item.get("sourceRef") or {}
    page, table = source_ref.get("page"), source_ref.get("table")
    description = _canonical_text(item.get("desc"))
    unit = _canonical_text(item.get("unit"))
    candidates: list[dict[str, Any]] = []
    for row in source_rows:
        if row["page"] != page or row["table"] != table or not row["rawText"]:
            continue
        anchor_cells = [
            cell for cell in row["rawCells"] if not cell["carried"] and cell["rawText"]
        ]
        cell_texts = [_canonical_text(cell["rawText"]) for cell in anchor_cells]
        description_indexes = {
            index
            for index, cell_text in enumerate(cell_texts)
            if f" {description} " in f" {cell_text} "
        }
        if not description or not description_indexes:
            continue
        if unit and unit != "l s" and not any(
            f" {unit} " in f" {cell_text} " for cell_text in cell_texts
        ):
            continue
        numeric_cells = [
            cell for index, cell in enumerate(anchor_cells)
            if index not in description_indexes or (len(anchor_cells) == 1 and unit != "l s")
        ]
        numbers = _numbers_from_cells(numeric_cells)
        if not _numeric_evidence_reconciles(item, numbers):
            continue
        candidates.append(row)
    return candidates


def _derived_id(item: dict[str, Any], source_row_id: str, ordinal: int) -> str:
    evidence = {
        "sourceRowIds": [source_row_id],
        "pricingRole": "standard",
        "costComponent": item.get("costComponent"),
        "desc": item.get("desc"),
        "unit": item.get("unit"),
        "qty": item.get("qty"),
        "rate": item.get("rate"),
        "total": item.get("total"),
        "ordinal": ordinal,
    }
    encoded = json.dumps(evidence, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()[:32]


def bind_legacy_sections(
    normalized: dict[str, Any], source_rows: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Adapt legacy priced items only when exactly one raw source row matches their evidence."""
    sections: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    ordinal = 0
    for section in normalized["sections"]:
        items: list[dict[str, Any]] = []
        for item in section["items"]:
            candidates = _candidate_rows(item, source_rows)
            if len(candidates) != 1:
                warnings.append({
                    "code": "ambiguous_source_binding" if candidates else "unmatched_source_binding",
                    "message": "Legacy derived item was retained only as source evidence because its source row binding was not unique.",
                })
                continue
            source_row_id = candidates[0]["id"]
            items.append({
                "id": _derived_id(item, source_row_id, ordinal),
                "desc": item["desc"],
                "pricingRole": "standard",
                "sourceRowIds": [source_row_id],
                "unit": item["unit"],
                "qty": item["qty"],
                "rate": item["rate"],
                "total": item["total"],
            })
            ordinal += 1
        sections.append({"header": section["header"], "items": items})
    return sections, warnings


def _warning_evidence(values: list[Any]) -> Counter[str]:
    return Counter(
        canonical
        for value in values
        if (canonical := _canonical_text(value))
    )


def _source_row_evidence(row: dict[str, Any]) -> Counter[str]:
    return Counter(
        canonical
        for cell in row["rawCells"]
        if not cell["carried"] and (canonical := _canonical_text(cell["rawText"]))
    )


def remap_legacy_warnings(
    warnings: list[dict[str, Any]],
    legacy_tables: list[dict[str, Any]],
    source_rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Remap flattened warning coordinates only when row evidence identifies one raw row."""
    tables_by_location = {
        (table["page"], table["table"]): table for table in legacy_tables
    }
    remapped: list[dict[str, Any]] = []
    for warning in warnings:
        source_ref = warning.get("sourceRef")
        output = {key: value for key, value in warning.items() if key != "sourceRef"}
        if not isinstance(source_ref, dict):
            remapped.append(output)
            continue
        page, table_number, legacy_row = (
            source_ref.get("page"), source_ref.get("table"), source_ref.get("row")
        )
        table = tables_by_location.get((page, table_number))
        table_rows = table.get("rows") if table else None
        if type(legacy_row) is not int or not isinstance(table_rows, list) or not 1 <= legacy_row <= len(table_rows):
            remapped.append(output)
            continue
        evidence = _warning_evidence(table_rows[legacy_row - 1])
        candidates = [
            row for row in source_rows
            if row["page"] == page
            and row["table"] == table_number
            and evidence
            and evidence <= _source_row_evidence(row)
        ]
        if len(candidates) == 1:
            candidate = candidates[0]
            output["sourceRef"] = {
                "page": candidate["page"],
                "table": candidate["table"],
                "row": candidate["row"],
            }
        remapped.append(output)
    return remapped
