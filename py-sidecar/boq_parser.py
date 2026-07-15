import math
import re
import uuid
from datetime import datetime
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
    r"^(?:sub[\s-]*total|grand[\s-]+total|total|(?:add\s+)?vat(?:\s*\d+(?:\.\d+)?\s*%)?|"
    r"(?:less\s+)?discount|"
    r"carried\s+forward|brought\s+forward)(?=\s|$|\b)",
    re.I,
)
AMOUNT_IN_WORDS = re.compile(r"\bbaht\s*:?.*\bonly\b", re.I)
DETAIL_ROW = re.compile(r"^(?:detail|note|remark)s?\b", re.I)
SUBTOTAL_ROW = re.compile(r"^sub[\s-]*total\b", re.I)
LABELED_VALUE = re.compile(r"^\s*([^:\n]+?)\s*:\s*(.*?)\s*$")
RECIPIENT_LABELS = {"to", "owner", "customer", "client", "attention", "attn"}
MONTHS = {
    "january": 1, "jan": 1, "february": 2, "feb": 2, "march": 3, "mar": 3,
    "april": 4, "apr": 4, "may": 5, "june": 6, "jun": 6, "july": 7, "jul": 7,
    "august": 8, "aug": 8, "september": 9, "sep": 9, "sept": 9,
    "october": 10, "oct": 10, "november": 11, "nov": 11, "december": 12, "dec": 12,
}
WORK_TYPE_KEYWORDS = (
    ("MEP", re.compile(r"\b(?:pump|pipe|piping|valve|mechanical|electrical)\b", re.I)),
    ("Structural", re.compile(r"\b(?:concrete|civil|steel|earthwork|slab|grating)\b", re.I)),
    ("Finishing", re.compile(r"\b(?:paint|painting|tile|ceiling|finish|finishing)\b", re.I)),
)


def clean_cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def normalize_header(value: Any) -> str:
    text = clean_cell(value).lower().replace(".", " ")
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


def _metadata_value(value: str, confidence: float, source: str) -> dict[str, Any]:
    return {"value": value, "confidence": confidence, "source": source}


def _labeled_lines(document_text: str) -> dict[str, tuple[str, str]]:
    values: dict[str, tuple[str, str]] = {}
    for raw_line in document_text.splitlines():
        match = LABELED_VALUE.match(raw_line)
        if not match or not clean_cell(match.group(2)):
            continue
        label = normalize_header(match.group(1))
        values.setdefault(label, (clean_cell(match.group(2)), clean_cell(raw_line)))
    return values


def _normalize_date(value: str, document_text: str) -> str:
    text = clean_cell(value).strip(".,")
    numeric = re.search(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})\b", text)
    if numeric:
        day, month, raw_year = (int(part) for part in numeric.groups())
        if len(numeric.group(3)) == 2:
            context_year = re.search(r"\b(?:19|20)\d{2}\b", document_text)
            century = int(context_year.group(0)) // 100 * 100 if context_year else 2000
            year = century + raw_year
        else:
            year = raw_year
        try:
            return datetime(year, month, day).date().isoformat()
        except ValueError:
            return ""

    english = re.search(
        r"\b(\d{1,2})\s+([A-Za-z]+)\s*,?\s*(\d{2}|\d{4})\b",
        text,
        re.I,
    )
    month_first = re.search(
        r"\b([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(\d{2}|\d{4})\b",
        text,
        re.I,
    )
    if english:
        day, month_name, raw_year_text = english.groups()
    elif month_first:
        month_name, day, raw_year_text = month_first.groups()
    else:
        return ""
    month = MONTHS.get(month_name.lower())
    if not month:
        return ""
    raw_year = int(raw_year_text)
    year = raw_year if len(raw_year_text) == 4 else 2000 + raw_year
    try:
        return datetime(year, month, int(day)).date().isoformat()
    except ValueError:
        return ""


def _classify_work_type(text: str) -> tuple[str, str] | None:
    matches: list[tuple[int, str, str]] = []
    for value, pattern in WORK_TYPE_KEYWORDS:
        match = pattern.search(text)
        if match:
            matches.append((match.start(), value, match.group(0)))
    if not matches:
        return None
    _, value, keyword = min(matches)
    return value, keyword


def extract_metadata(
    document_text: str,
    section_headers: Iterable[str],
    item_descriptions: Iterable[str] = (),
) -> dict[str, dict[str, Any]]:
    """Extract reviewable quotation metadata using deterministic, label-first rules."""
    lines = [clean_cell(line) for line in document_text.splitlines() if clean_cell(line)]
    labels = _labeled_lines(document_text)
    headers = [clean_cell(header) for header in section_headers if clean_cell(header)]
    descriptions = [clean_cell(description) for description in item_descriptions if clean_cell(description)]

    vendor = _metadata_value("", 0.0, "not found")
    for label in ("contractor", "seller"):
        if label in labels:
            value, source = labels[label]
            vendor = _metadata_value(value, 0.98, source)
            break
    else:
        for line in lines:
            label_match = LABELED_VALUE.match(line)
            first_word = normalize_header(line).split(" ", 1)[0]
            if first_word in RECIPIENT_LABELS or (
                label_match and normalize_header(label_match.group(1)) in RECIPIENT_LABELS
            ):
                continue
            if re.search(r"\b(?:co\.?\s*,?\s*ltd\.?|company\s+limited|group)\b", line, re.I):
                vendor = _metadata_value(line, 0.82, "seller header")
                break

    project = _metadata_value("", 0.0, "not found")
    for label in ("project", "subject"):
        if label in labels:
            value, source = labels[label]
            project = _metadata_value(value, 0.98, source)
            break
    else:
        if headers:
            project = _metadata_value(headers[0], 0.78, "section heading")
        elif len(descriptions) == 1:
            project = _metadata_value(descriptions[0], 0.72, "sole priced item")

    date = _metadata_value("", 0.0, "not found")
    for label in ("doc date", "date"):
        if label not in labels:
            continue
        value, source = labels[label]
        normalized = _normalize_date(value, document_text)
        if normalized:
            date = _metadata_value(normalized, 0.98, source)
            break
    if not date["value"]:
        for line in lines:
            normalized = _normalize_date(line, document_text)
            if normalized:
                date = _metadata_value(normalized, 0.78, line)
                break

    work_type = _metadata_value("Unclassified", 0.2, "no matching work keywords")
    classified = _classify_work_type(project["value"])
    if classified is None:
        classified = _classify_work_type("\n".join([*headers, *descriptions]))
    if classified:
        value, keyword = classified
        work_type = _metadata_value(value, 0.9, f"keyword: {keyword}")

    return {"vendor": vendor, "project": project, "date": date, "workType": work_type}


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
    component_groups = {
        name: [index for index, header in enumerate(headers) if name in normalize_header(header)]
        for name in ("material", "labour")
    }
    for name, indexes in component_groups.items():
        if (
            len(indexes) not in (3, 4)
            or indexes != list(range(indexes[0], indexes[-1] + 1))
            or not all(re.search(fr"\b{name}\s+cost\b", normalize_header(headers[index])) for index in indexes)
        ):
            continue
        columns[f"{name}_qty"] = indexes[0]
        if len(indexes) == 4:
            columns[f"{name}_unit"] = indexes[1]
            columns[f"{name}_rate"] = indexes[2]
        else:
            columns[f"{name}_rate"] = indexes[1]
        columns[f"{name}_total"] = indexes[-1]
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
            elif re.search(r"\b(?:rate|price)\b|\bunit\s+cost\b", normalized):
                field = f"{component}_rate"
            elif re.search(r"\b(?:unit|uom)\b", normalized):
                field = f"{component}_unit"
            else:
                field = f"{component}_rate"
            if field.endswith("_rate") and re.search(r"\b(?:price|unit\s+cost)\b", normalized):
                columns[field] = index
            else:
                columns.setdefault(field, index)
            last_component = component
            continue
        if last_component and re.search(r"\bunit\s+cost\s+total\b", normalized):
            columns.setdefault(f"{last_component}_total", index)
            continue
        if _matches_alias(normalized, HEADER_ALIASES["desc"]) or re.match(
            r"^(?:no|item)\s+description\b", normalized
        ):
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
    qty_index = columns.get("qty")
    inferred_unit_index = qty_index + 1 if qty_index is not None else None
    if (
        "unit" not in columns
        and inferred_unit_index is not None
        and inferred_unit_index < len(headers)
        and (
            not normalize_header(headers[inferred_unit_index])
            or normalize_header(headers[inferred_unit_index]) == normalize_header(headers[qty_index])
        )
        and any(
            index > inferred_unit_index
            for field, index in columns.items()
            if field in {"rate", "total", "amount", "material_rate", "material_total", "labour_rate", "labour_total"}
        )
    ):
        columns["unit"] = inferred_unit_index
    return columns


def _find_document_header(rows: list[list[Any]]) -> tuple[int, dict[str, int]] | None:
    best: tuple[int, dict[str, int]] | None = None
    best_score = (-1, -1)
    for start in range(min(8, len(rows))):
        for count in range(1, min(3, len(rows) - start) + 1):
            headers = flatten_headers(rows[start:start + count])
            columns = _columns_from_headers(headers)
            if "desc" not in columns:
                continue
            has_costs = any(
                key in columns
                for key in ("rate", "total", "amount", "material_rate", "material_total", "labour_rate", "labour_total")
            )
            if not has_costs:
                continue
            detail_score = sum(bool(re.search(
                r"\b(?:qty|q ty|quantity|unit|uom|rate|price|total|amount)\b",
                normalize_header(header),
            )) for header in headers)
            score = (len(columns), detail_score)
            if best is None or score > best_score:
                best = (start + count, columns)
                best_score = score
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


def _cost_specs(row: list[Any], columns: dict[str, int]) -> tuple[str, str, list[dict[str, Any]]]:
    description = _cell(row, columns, "desc")
    if not description:
        return "", "", []
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
            return description, source_code, [{
                "component": "combined",
                "qty": material["qty"],
                "unit": material["unit"],
                "rate": material["rate"] + labour["rate"],
                "total": total,
                "sourceCosts": {"material": material, "labour": labour},
            }]
        return description, source_code, [
            {"component": "material", **{key: material[key] for key in ("qty", "unit", "rate", "total")}},
            {"component": "labour", **{key: labour[key] for key in ("qty", "unit", "rate", "total")}},
        ]

    if material["present"] or labour["present"]:
        name = "material" if material["present"] else "labour"
        component = material if material["present"] else labour
        return description, source_code, [
            {"component": name, **{key: component[key] for key in ("qty", "unit", "rate", "total")}},
        ]

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
            return description, source_code, [{
                "component": "combined", "qty": qty, "unit": unit, "rate": rate, "total": total,
            }]

    amount = source_amount or (parse_number(total_text) if _has_number(total_text) else 0.0)
    if amount:
        return description, source_code, [{
            "component": "lump_sum", "qty": 1.0, "unit": "L/S", "rate": amount, "total": amount,
        }]
    return description, source_code, []


def normalize_cost_row(
    row: list[Any],
    columns: dict[str, int],
    source_ref: dict[str, int] | None = None,
) -> list[dict[str, Any]]:
    description, source_code, specs = _cost_specs(row, columns)
    items: list[dict[str, Any]] = []
    for spec in specs:
        item = _make_item(
            description,
            spec["component"],
            spec["qty"],
            spec["unit"],
            spec["rate"],
            spec["total"],
            source_ref,
        )
        if "sourceCosts" in spec:
            item["sourceCosts"] = spec["sourceCosts"]
        items.append(item)
    return _attach_source_code(items, source_code)


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
    letters = [character for character in description if character.isalpha()]
    mostly_uppercase = bool(letters) and sum(character.isupper() for character in letters) / len(letters) >= 0.9
    repeated_description = sum(clean_cell(cell) == description for cell in row) >= 2
    distinct_pricing = any(
        _has_number(value) and clean_cell(value) != description
        for value in (
            _cell(row, columns, "rate"), _cell(row, columns, "total"), _cell(row, columns, "amount"),
            _cell(row, columns, "material_qty"), _cell(row, columns, "material_rate"),
            _cell(row, columns, "material_total"), _cell(row, columns, "labour_qty"),
            _cell(row, columns, "labour_rate"), _cell(row, columns, "labour_total"),
        )
    )
    if description and mostly_uppercase and repeated_description and not distinct_pricing:
        return "section"
    if _cost_specs(row, columns)[2]:
        return "item"
    source_code = _cell(row, columns, "code")
    if description and (
        mostly_uppercase
        or (source_code.isalpha() and len(source_code) <= 4)
        or re.match(r"^[A-Z]\s*[.)-]\s+", description, re.I)
    ):
        return "section"
    return "unpriced"


def _select_source_total(
    candidates: Iterable[tuple[str, float, bool]],
) -> float | None:
    candidate_list = list(candidates)
    if not candidate_list:
        return None
    discounts = [value for kind, value, _ in candidate_list if kind == "discount"]
    pre_discount_totals = [value for kind, value, _ in candidate_list if kind == "pre_discount"]
    if discounts and pre_discount_totals:
        return pre_discount_totals[-1]
    pre_vat_totals = [
        value for kind, value, _ in candidate_list if kind == "pre_vat"
    ]
    if pre_vat_totals:
        return pre_vat_totals[-1]
    subtotals = [
        (value, is_trailing) for kind, value, is_trailing in candidate_list
        if kind == "subtotal"
    ]
    if subtotals:
        preceding_total = math.fsum(value for value, _ in subtotals[:-1])
        final_value, final_is_trailing = subtotals[-1]
        if len(subtotals) > 1 and final_is_trailing and math.isclose(
            final_value, preceding_total, rel_tol=1e-9, abs_tol=0.05
        ):
            return final_value
        return math.fsum(value for value, _ in subtotals)
    return None


def extract_boq_document(tables: Iterable[dict[str, Any]], document_text: str) -> dict[str, Any]:
    sections: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    total_candidates: list[tuple[str, float, bool]] = []
    discount_sources: list[tuple[float, dict[str, int]]] = []
    document_excludes_vat = bool(re.search(
        r"(?:price\s+)?exclud(?:e|es|ed|ing)\s+(?:of\s+)?vat|excl\.?\s*vat|vat\s+excluded",
        document_text,
        re.I,
    ))
    for table_index, table in enumerate(tables, start=1):
        page = int(table.get("page") or 1)
        rows = [list(row) for row in table.get("rows", [])]
        detected = _find_document_header(rows)
        if not detected:
            continue
        header_count, columns = detected
        current_header = f"Parsed Table {table_index}"
        current_items: list[dict[str, Any]] = []
        previous_subtotal_in_table = False
        boundary_since_subtotal = False

        def flush_section() -> None:
            nonlocal current_items
            if current_items:
                sections.append({"header": current_header, "items": current_items})
                current_items = []

        for zero_based_row, row in enumerate(rows[header_count:], start=header_count):
            row_class = classify_row(row, columns)
            source_ref = {"page": page, "table": table_index, "row": zero_based_row + 1}
            if row_class == "section":
                boundary_since_subtotal = True
                flush_section()
                current_header = _cell(row, columns, "desc")
                continue
            if row_class == "total":
                row_text = " ".join(clean_cell(cell) for cell in row if clean_cell(cell))
                total_label = _cell(row, columns, "desc") or row_text
                total_text = _cell(row, columns, "total") or _cell(row, columns, "amount")
                is_pre_vat = bool(re.search(
                    r"before\s+vat|pre[\s-]*vat|"
                    r"exclud(?:e|es|ed|ing)\s+(?:of\s+)?vat|excl\.?\s*vat|vat\s+excluded",
                    total_label,
                    re.I,
                )) or (document_excludes_vat and bool(re.search(r"grand\s+total", total_label, re.I)))
                if _has_number(total_text) and not re.search(
                    r"\b(?:carried|brought)\b", total_label, re.I
                ) and (is_pre_vat or not re.search(r"\bvat\b", total_label, re.I)):
                    if re.search(r"\b(?:less\s+)?discount\b", total_label, re.I):
                        kind = "discount"
                    elif is_pre_vat:
                        kind = "pre_vat"
                    elif SUBTOTAL_ROW.match(total_label):
                        kind = "subtotal"
                    elif re.match(r"^total(?:\s|$)", total_label, re.I):
                        kind = "pre_discount"
                    else:
                        continue
                    is_trailing = (
                        kind == "subtotal"
                        and previous_subtotal_in_table
                        and not boundary_since_subtotal
                    )
                    candidate_value = parse_number(total_text)
                    if kind == "discount":
                        candidate_value = abs(candidate_value)
                    total_candidates.append((kind, candidate_value, is_trailing))
                    if kind == "discount":
                        discount_sources.append((candidate_value, source_ref))
                    if kind == "subtotal":
                        previous_subtotal_in_table = True
                        boundary_since_subtotal = False
                continue
            if row_class == "unpriced" and _cell(row, columns, "desc"):
                warnings.append({
                    "code": "unparsed_row",
                    "message": f"Could not normalize row: {_cell(row, columns, 'desc')}",
                    "sourceRef": source_ref,
                })
            if row_class != "item":
                if row_class == "unpriced" and any(
                    _has_number(_cell(row, columns, field))
                    for field in (
                        "rate", "total", "amount", "material_rate", "material_total",
                        "labour_rate", "labour_total",
                    )
                ):
                    boundary_since_subtotal = True
                continue
            boundary_since_subtotal = True
            current_items.extend(normalize_cost_row(row, columns, source_ref))
        flush_section()
    if discount_sources:
        pre_discount_totals = [value for kind, value, _ in total_candidates if kind == "pre_discount"]
        payable_totals = [value for kind, value, _ in total_candidates if kind == "pre_vat"]
        if pre_discount_totals:
            discount, source_ref = discount_sources[-1]
            payable = payable_totals[-1] if payable_totals else pre_discount_totals[-1] - discount
            warnings.append({
                "code": "source_discount",
                "message": (
                    f"Source discount {discount:,.2f}; item reconciliation uses pre-discount total "
                    f"{pre_discount_totals[-1]:,.2f}. Payable total is {payable:,.2f}."
                ),
                "sourceRef": source_ref,
            })
    section_headers = [
        section["header"] for section in sections
        if not section["header"].startswith("Parsed Table ")
    ]
    item_descriptions = [item["desc"] for section in sections for item in section["items"]]
    return {
        "sections": sections,
        "metadata": extract_metadata(document_text, section_headers, item_descriptions),
        "warnings": warnings,
        "sourceTotal": _select_source_total(total_candidates),
    }


def extract_boq_sections(tables: Iterable[list[list[Any]]]) -> list[dict[str, Any]]:
    document_tables = [
        {"page": 1, "rows": [list(row) for row in raw_rows]}
        for raw_rows in tables
    ]
    return extract_boq_document(document_tables, "")["sections"]
