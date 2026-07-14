import math
import re
import uuid
from typing import Any, Iterable


HEADER_ALIASES = {
    "code": ("item", "item no", "item number", "code", "ref", "reference", "no"),
    "desc": ("description", "description of works", "particulars", "work description", "item description"),
    "unit": ("unit", "uom", "unit of measure"),
    "qty": ("qty", "q ty", "quantity", "quant"),
    "rate": ("rate", "unit rate", "price", "unit price"),
    "total": ("amount", "total", "total amount", "extended amount", "value"),
}
TOTAL_ROW = re.compile(
    r"^(?:sub\s*total|grand\s+total|total|vat(?:\s+\d+(?:\.\d+)?\s*%)?|discount|"
    r"carried\s+forward|brought\s+forward)\b",
    re.I,
)
AMOUNT_IN_WORDS = re.compile(r"\bbaht\s*:?.*\bonly\b", re.I)
DETAIL_ROW = re.compile(r"^(?:detail|note|remark)s?\b", re.I)


def clean_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def normalize_header(value: Any) -> str:
    text = clean_cell(value).lower().replace(".", "")
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def parse_number(value: Any) -> float:
    text = clean_cell(value)
    if not text or text in {"-", "—", "–", "n/a", "N/A"}:
        return 0.0
    negative = text.startswith("(") and text.endswith(")")
    normalized = re.sub(r"[^0-9.\-]", "", text.replace(",", ""))
    if normalized in {"", "-", ".", "-."}:
        return 0.0
    try:
        number = float(normalized)
        return -abs(number) if negative else number
    except ValueError:
        return 0.0


def parse_qty_unit(value: Any) -> tuple[float, str]:
    text = clean_cell(value)
    match = re.match(r"^\s*([+-]?(?:\d[\d,]*)(?:\.\d+)?)\s*(.*?)\s*$", text)
    if not match:
        return parse_number(text), ""
    return parse_number(match.group(1)), clean_cell(match.group(2))


def flatten_headers(rows: list[list[Any]]) -> list[str]:
    if not rows:
        return []
    width = max(len(row) for row in rows)
    inherited_groups: list[str] = []
    current_group = ""
    for column in range(width):
        cell = clean_cell(rows[0][column]) if column < len(rows[0]) else ""
        if cell:
            current_group = cell
        inherited_groups.append(current_group)

    flattened: list[str] = []
    for column in range(width):
        parts: list[str] = []
        for row_index, row in enumerate(rows):
            cell = clean_cell(row[column]) if column < len(row) else ""
            if row_index == 0 and not cell:
                cell = inherited_groups[column]
            normalized = normalize_header(cell)
            if normalized and normalized not in parts:
                parts.append(normalized)
        flattened.append(" ".join(parts))
    return flattened


def _matches_alias(header: str, aliases: tuple[str, ...]) -> bool:
    return any(header == alias or header.startswith(f"{alias} ") for alias in aliases)


def _columns_from_headers(headers: list[str]) -> dict[str, int]:
    columns: dict[str, int] = {}
    last_component = ""
    for index, header in enumerate(headers):
        normalized = normalize_header(header)
        if not normalized:
            continue
        component = "material" if "material" in normalized else "labour" if "labour" in normalized else ""
        if component:
            if re.search(r"\b(?:total|amount)\b", normalized):
                field = f"{component}_total"
            elif re.search(r"\b(?:qty|q ty|quantity|quant)\b", normalized):
                field = f"{component}_qty"
            else:
                field = f"{component}_rate"
            columns.setdefault(field, index)
            last_component = component
            continue
        if _matches_alias(normalized, HEADER_ALIASES["desc"]):
            columns.setdefault("desc", index)
        elif _matches_alias(normalized, HEADER_ALIASES["code"]):
            columns.setdefault("code", index)
        elif _matches_alias(normalized, HEADER_ALIASES["qty"]):
            columns.setdefault("qty", index)
        elif _matches_alias(normalized, HEADER_ALIASES["rate"]):
            columns.setdefault("rate", index)
        elif _matches_alias(normalized, HEADER_ALIASES["unit"]):
            columns.setdefault("unit", index)
        elif _matches_alias(normalized, HEADER_ALIASES["total"]):
            if normalized == "total" and last_component:
                columns.setdefault(f"{last_component}_total", index)
            elif normalized == "amount":
                columns.setdefault("amount", index)
                columns.setdefault("total", index)
                last_component = ""
            else:
                columns.setdefault("total", index)
    return columns


def _column_map(header: list[Any]) -> dict[str, int]:
    return _columns_from_headers([normalize_header(value) for value in header])


def _find_header(rows: list[list[Any]]) -> tuple[int, dict[str, int]] | None:
    best: tuple[int, dict[str, int]] | None = None
    for index, row in enumerate(rows[:8]):
        columns = _column_map(row)
        if "desc" not in columns:
            continue
        score = len(columns)
        if score >= 3 and (best is None or score > len(best[1])):
            best = (index, columns)
    return best


def _find_document_header(rows: list[list[Any]]) -> tuple[int, dict[str, int]] | None:
    best: tuple[int, dict[str, int]] | None = None
    for count in range(1, min(3, len(rows)) + 1):
        columns = _columns_from_headers(flatten_headers(rows[:count]))
        if "desc" not in columns:
            continue
        has_costs = any(
            key in columns
            for key in ("rate", "total", "amount", "material_rate", "material_total", "labour_rate", "labour_total")
        )
        if not has_costs:
            continue
        if best is None or len(columns) > len(best[1]):
            best = (count, columns)
    return best


def _cell(row: list[Any], columns: dict[str, int], field: str) -> str:
    index = columns.get(field)
    return clean_cell(row[index]) if index is not None and index < len(row) else ""


def _has_number(value: Any) -> bool:
    text = clean_cell(value)
    return bool(text and text not in {"-", "—", "–", "n/a", "N/A"} and re.search(r"\d", text))


def _make_item(
    description: str,
    component: str,
    qty: float,
    unit: str,
    rate: float,
    total: float,
    source_ref: dict[str, int] | None,
) -> dict[str, Any]:
    return {
        "id": uuid.uuid4().hex,
        "desc": description,
        "unit": unit,
        "qty": qty,
        "rate": rate,
        "total": total,
        "type": "lump_sum" if component == "lump_sum" else "unit",
        "costComponent": component,
        "sourceRef": source_ref or {},
    }


def _attach_source_code(items: list[dict[str, Any]], code: str) -> list[dict[str, Any]]:
    if code:
        for item in items:
            item["code"] = code
    return items


def _component_values(row: list[Any], columns: dict[str, int], name: str) -> dict[str, Any]:
    qty_text = _cell(row, columns, f"{name}_qty")
    if qty_text:
        qty, embedded_unit = parse_qty_unit(qty_text)
    else:
        qty = parse_number(_cell(row, columns, "qty"))
        embedded_unit = ""
    unit = embedded_unit or _cell(row, columns, f"{name}_unit") or _cell(row, columns, "unit")
    rate_text = _cell(row, columns, f"{name}_rate")
    total_text = _cell(row, columns, f"{name}_total")
    rate = parse_number(rate_text)
    total = parse_number(total_text)
    priced = _has_number(rate_text) or _has_number(total_text)
    present = priced and bool(qty and unit)
    if present and not total and qty and rate:
        total = qty * rate
    if present and not rate and qty and total:
        rate = total / qty
    return {"present": present, "qty": qty, "unit": unit, "rate": rate, "total": total}


def normalize_cost_row(
    row: list[Any],
    columns: dict[str, int],
    source_ref: dict[str, int] | None = None,
) -> list[dict[str, Any]]:
    description = _cell(row, columns, "desc")
    if not description:
        return []
    source_code = _cell(row, columns, "code")

    material = _component_values(row, columns, "material")
    labour = _component_values(row, columns, "labour")
    amount_text = _cell(row, columns, "amount")
    source_amount = parse_number(amount_text)

    if material["present"] and labour["present"]:
        same_qty_unit = (
            material["qty"] == labour["qty"]
            and normalize_header(material["unit"]) == normalize_header(labour["unit"])
        )
        if same_qty_unit:
            total = source_amount or material["total"] + labour["total"]
            item = _make_item(
                description,
                "combined",
                material["qty"],
                material["unit"],
                material["rate"] + labour["rate"],
                total,
                source_ref,
            )
            item["sourceCosts"] = {"material": material, "labour": labour}
            return _attach_source_code([item], source_code)
        return _attach_source_code([
            _make_item(description, "material", material["qty"], material["unit"], material["rate"], material["total"], source_ref),
            _make_item(description, "labour", labour["qty"], labour["unit"], labour["rate"], labour["total"], source_ref),
        ], source_code)

    if material["present"] or labour["present"]:
        name = "material" if material["present"] else "labour"
        component = material if material["present"] else labour
        return _attach_source_code(
            [_make_item(description, name, component["qty"], component["unit"], component["rate"], component["total"], source_ref)],
            source_code,
        )

    unit = _cell(row, columns, "unit")
    qty = parse_number(_cell(row, columns, "qty"))
    rate_text = _cell(row, columns, "rate")
    total_text = _cell(row, columns, "total")
    rate = parse_number(rate_text)
    total = parse_number(total_text)
    if (_has_number(rate_text) or _has_number(total_text)) and (unit or qty):
        if not total and qty and rate:
            total = qty * rate
        if not rate and qty and total:
            rate = total / qty
        if qty and unit and (rate or total):
            return _attach_source_code(
                [_make_item(description, "combined", qty, unit, rate, total, source_ref)],
                source_code,
            )

    amount = source_amount or (parse_number(total_text) if _has_number(total_text) else 0.0)
    if amount:
        return _attach_source_code(
            [_make_item(description, "lump_sum", 1.0, "L/S", amount, amount, source_ref)],
            source_code,
        )
    return []


def classify_row(row: list[Any], columns: dict[str, int]) -> str:
    description = _cell(row, columns, "desc")
    row_text = " ".join(clean_cell(cell) for cell in row if clean_cell(cell))
    if not row_text:
        return "empty"
    if AMOUNT_IN_WORDS.search(row_text):
        return "amount_words"
    if TOTAL_ROW.match(description) or TOTAL_ROW.match(row_text):
        return "total"
    if DETAIL_ROW.match(description):
        return "detail"
    if normalize_cost_row(row, columns):
        return "item"
    source_code = _cell(row, columns, "code")
    if description and (
        (description == description.upper() and re.search(r"[A-Z]", description))
        or (source_code.isalpha() and len(source_code) <= 4)
        or re.match(r"^[A-Z]\s*[.)-]\s+", description, re.I)
    ):
        return "section"
    return "unpriced"


def extract_boq_document(tables: Iterable[dict[str, Any]], document_text: str) -> dict[str, Any]:
    del document_text
    sections: list[dict[str, Any]] = []
    for table_index, table in enumerate(tables, start=1):
        page = int(table.get("page") or 1)
        rows = [list(row) for row in table.get("rows", [])]
        detected = _find_document_header(rows)
        if not detected:
            continue
        header_count, columns = detected
        current_header = f"Parsed Table {table_index}"
        current_items: list[dict[str, Any]] = []

        def flush_section() -> None:
            nonlocal current_items
            if current_items:
                sections.append({"header": current_header, "items": current_items})
                current_items = []

        for zero_based_row, row in enumerate(rows[header_count:], start=header_count):
            row_class = classify_row(row, columns)
            if row_class == "section":
                flush_section()
                current_header = _cell(row, columns, "desc")
                continue
            if row_class != "item":
                continue
            source_ref = {"page": page, "table": table_index, "row": zero_based_row + 1}
            current_items.extend(normalize_cost_row(row, columns, source_ref))
        flush_section()
    return {"sections": sections}


def extract_boq_sections(tables: Iterable[list[list[Any]]]) -> list[dict[str, Any]]:
    document_tables = [
        {"page": 1, "rows": [list(row) for row in raw_rows]}
        for raw_rows in tables
    ]
    return extract_boq_document(document_tables, "")["sections"]
