"""Pure, deterministic source-row-first BOQ derivation.

The rules in this module deliberately return no item when evidence is incomplete.
Source rows are treated as immutable evidence and all uncertainty is additive.
"""

from __future__ import annotations

from copy import deepcopy
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
import re
from typing import Any

from boq_contract import RECONCILIATION_TOLERANCE, build_reconciliation, checked_contributing_total


OPTION = re.compile(
    r"^\s*(?:(?:optional|option|provisional|add[ -]?on)\b|"
    r"(?:alternate|alternative)(?=\s*(?:[:.)#-]|\d|option\b|no\.?\b)))",
    re.I,
)
CONTEXTUAL_ALTERNATE = re.compile(r"^\s*alternate\b", re.I)
OPTION_CONTEXT = re.compile(r"\b(?:options?|alternates?|alternatives?|remarks?|status)\b", re.I)
CONTINUATION_PREFIX = re.compile(r"^(?:including|continued|comprising|consisting|together with|complete with)\b", re.I)
NON_NUMBER = {"", "-", "—", "–", "n/a", "N/A"}
NUMBER_TOKEN = re.compile(r"(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$")


def _normal(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").casefold()).strip()


def _decimal(value: Any) -> Decimal | None:
    text = str(value or "").strip()
    if text in NON_NUMBER:
        return None
    if text.startswith("(") or text.startswith("-") or text.startswith("+"):
        return None
    normalized = re.sub(r"^(?:THB|USD|SGD|฿|\$)\s*", "", text, flags=re.I)
    normalized = re.sub(r"\s*(?:THB|USD|SGD|฿|\$)$", "", normalized, flags=re.I)
    if not NUMBER_TOKEN.fullmatch(normalized):
        return None
    try:
        result = Decimal(normalized.replace(",", ""))
    except InvalidOperation:
        return None
    if not result.is_finite() or result < 0:
        return None
    return result


def _number(value: Any) -> float | None:
    parsed = _decimal(value)
    if parsed is None:
        return None
    try:
        converted = float(parsed)
    except (OverflowError, ValueError):
        return None
    return converted if math.isfinite(converted) else None


def _finite_float(value: Decimal) -> float | None:
    if not value.is_finite():
        return None
    try:
        converted = float(value)
    except (OverflowError, ValueError):
        return None
    return converted if math.isfinite(converted) else None


def _anchor_cells(row: dict[str, Any]) -> list[dict[str, Any]]:
    return [cell for cell in row.get("rawCells", []) if not cell.get("carried", False)]


def _cells(row: dict[str, Any]) -> dict[int, dict[str, Any]]:
    return {cell["column"]: cell for cell in _anchor_cells(row)}


def _header(row: dict[str, Any], column: int) -> str:
    headers = row.get("headers", [])
    return _normal(headers[column]) if column < len(headers) else ""


def _header_leaf(row: dict[str, Any], column: int) -> str:
    headers = row.get("headers", [])
    if column >= len(headers):
        return ""
    return _normal(str(headers[column]).rsplit("/", 1)[-1])


def _find_columns(row: dict[str, Any]) -> dict[str, int]:
    roles: dict[str, int] = {}
    # Iterate over the full retained header vector, not only cells present in
    # this row. Docling omits empty cells entirely, so a material-only row may
    # have no anchor cells at the labour columns. Without scanning headers we
    # would never discover those labour_* roles and _derive_components would
    # bail before attempting single-component derivation.
    headers = row.get("headers", [])
    for column in range(len(headers)):
        header = _header(row, column)
        leaf_header = _header_leaf(row, column)
        component = "material" if "material" in header else "labour" if "labour" in header else ""
        if "desc" in header or "particular" in header:
            roles["desc"] = column
        elif header in {"item", "work"}:
            roles.setdefault("desc", column)
        elif component and ("qty" in header or "quantity" in header):
            roles[f"{component}_qty"] = column
        elif component and ("total" in header or "amount" in header):
            roles[f"{component}_total"] = column
        elif component and ("rate" in header or "price" in header):
            roles[f"{component}_rate"] = column
        elif component and ("unit" in header or "uom" in header):
            roles[f"{component}_unit"] = column
        elif leaf_header in {"qty", "q ty", "quantity"}:
            roles["qty"] = column
        elif leaf_header in {"unit", "uom", "unit of measure"}:
            roles["unit"] = column
        elif "rate" in leaf_header or leaf_header in {"price", "unit price"}:
            roles["rate"] = column
        elif "amount" in leaf_header or leaf_header in {"total", "total price", "value"}:
            roles["amount"] = column
    if "desc" not in roles and _cells(row):
        assigned_pricing_columns = {
            column for role, column in roles.items()
            if role != "desc"
        }
        description_columns = [
            column for column in _cells(row)
            if column not in assigned_pricing_columns
        ]
        if description_columns:
            roles["desc"] = min(description_columns)
    return roles


def _lines(row: dict[str, Any], column: int | None) -> list[str]:
    if column is None:
        return []
    cell = _cells(row).get(column)
    if cell is None:
        return []
    values = cell.get("lines")
    if not isinstance(values, list):
        values = str(cell.get("rawText", "")).replace("\r", "").split("\n")
    return [str(value).strip() for value in values if str(value).strip()]


def _value(row: dict[str, Any], column: int | None) -> str:
    values = _lines(row, column)
    return values[0] if len(values) == 1 else ""


def _warning(row: dict[str, Any], code: str, message: str) -> dict[str, Any]:
    return {
        "code": code,
        "message": message,
        "sourceRef": {"page": row["page"], "table": row["table"], "row": row["row"]},
        "sourceRowId": row["id"],
    }


def _item_id(row_id: str, kind: str, ordinal: int) -> str:
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", row_id).strip("-")
    if safe != row_id:
        safe = f"{safe}-{hashlib.sha256(row_id.encode('utf-8')).hexdigest()[:8]}"
    return f"di-{safe}-{kind}-{ordinal}"


def _optional_fields(row: dict[str, Any]) -> dict[str, Any]:
    contextual_alternate = (
        CONTEXTUAL_ALTERNATE.search(row.get("rawText", ""))
        and (
            OPTION_CONTEXT.search(row.get("section") or "")
            or any(OPTION_CONTEXT.search(header) for header in row.get("headers", []))
        )
    )
    if (
        row.get("classification") == "option"
        or OPTION.search(row.get("rawText", ""))
        or contextual_alternate
    ):
        return {
            "optional": True,
            "excludedFromTotal": True,
            "exclusionReason": "Source row is marked optional or alternative",
        }
    return {}


def _priced_item(
    row: dict[str, Any], *, ordinal: int, desc: str, unit: str, qty: float,
    rate: float, total: float, component: str = "combined", kind: str = "standard",
    source_row_ids: list[str] | None = None, source_costs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    item = {
        "id": _item_id(row["id"], kind, ordinal),
        "desc": desc,
        "pricingRole": "bundle_parent" if kind == "bundle" else "standard",
        "sourceRowIds": source_row_ids or [row["id"]],
        "entryOrigin": "docling",
        "costComponent": component,
    }
    if source_costs is not None:
        item["sourceCosts"] = source_costs
    item.update(_optional_fields(row))
    item.update({"unit": unit, "qty": qty, "rate": rate, "total": total})
    return item


def _contributing_decimal(items: list[dict[str, Any]]) -> Decimal:
    total = Decimal(0)
    for item in items:
        if item["pricingRole"] == "bundle_child" or item.get("excludedFromTotal", False):
            continue
        total += Decimal(str(item["total"]))
    return total


def _has_pricing(row: dict[str, Any]) -> bool:
    roles = _find_columns(row)
    for role, column in roles.items():
        if role != "desc" and _decimal(_value(row, column)) is not None:
            return True
    return False


def _has_pricing_text(row: dict[str, Any]) -> bool:
    roles = _find_columns(row)
    return any(
        role != "desc" and _value(row, column).strip() not in NON_NUMBER
        for role, column in roles.items()
    )


def _has_numeric_overflow(row: dict[str, Any], roles: dict[str, int]) -> bool:
    for role, column in roles.items():
        if role == "desc" or role == "unit" or role.endswith("_unit"):
            continue
        raw = _value(row, column)
        if _decimal(raw) is not None and _number(raw) is None:
            return True
    return False


def _has_invalid_numeric_format(row: dict[str, Any], roles: dict[str, int]) -> bool:
    for role, column in roles.items():
        if role == "desc" or role == "unit" or role.endswith("_unit"):
            continue
        raw = _value(row, column).strip()
        if raw not in NON_NUMBER and _decimal(raw) is None:
            return True
    return False


def _has_continuation_cue(row: dict[str, Any]) -> bool:
    if row.get("classification") == "continuation":
        return True
    roles = _find_columns(row)
    text = _value(row, roles.get("desc")).lstrip()
    if not text:
        return False
    return bool(
        CONTINUATION_PREFIX.match(text)
        or text[0].islower()
        or not text[0].isalnum()
    )


def _continuation_map(rows: list[dict[str, Any]]) -> tuple[dict[str, list[dict[str, Any]]], set[str]]:
    additions: dict[str, list[dict[str, Any]]] = {}
    consumed: set[str] = set()
    base: dict[str, Any] | None = None
    last_content: dict[str, Any] | None = None
    boundary_headers: list[dict[str, Any]] = []
    for row in rows:
        classification = row.get("classification")
        if classification == "header":
            if base is not None:
                boundary_headers.append(row)
            continue
        is_candidate = (
            classification in {"continuation", "item"}
            and not _has_pricing_text(row)
            and _has_continuation_cue(row)
        )
        if is_candidate and base is not None and last_content is not None:
            compatible_section = row.get("section") in {None, base.get("section")}
            compatible_headers = base.get("headers") == row.get("headers")
            same_table = (
                not boundary_headers
                and last_content["page"] == row["page"]
                and last_content["table"] == row["table"]
            )
            cross_page = (
                bool(boundary_headers)
                and base["page"] != row["page"]
                and base["table"] != row["table"]
                and boundary_headers[-1].get("headers") == base.get("headers")
            )
            if compatible_section and compatible_headers and (same_table or cross_page):
                additions.setdefault(base["id"], []).append(row)
                consumed.add(row["id"])
                last_content = row
                boundary_headers = []
                continue
        if classification in {"item", "option"} and _has_pricing(row):
            roles = _find_columns(row)
            base = row if len(_lines(row, roles.get("desc"))) == 1 else None
            last_content = row if base is not None else None
        else:
            base = None
            last_content = None
        boundary_headers = []
    return additions, consumed


def _header_signature(row: dict[str, Any]) -> tuple[str, ...]:
    return tuple(_normal(header) for header in row.get("headers", []))


def _is_section_total(row: dict[str, Any]) -> bool:
    if row.get("classification") != "total":
        return False
    label = _normal(row.get("rawText"))
    return (
        not re.search(r"\b(?:grand|vat|discount|carried|brought)\b", label)
        and (label.startswith("total") or label.startswith("sub total"))
    )


def _section_instances(
    rows: list[dict[str, Any]],
) -> tuple[dict[str, int], dict[int, str]]:
    """Assign ordered evidence rows to semantic section instances."""
    row_instances: dict[str, int] = {}
    names: dict[int, str] = {}
    signatures: dict[int, tuple[str, ...]] = {}
    active: int | None = None
    last_context: tuple[int, int] | None = None

    def open_instance(name: str | None, signature: tuple[str, ...]) -> int:
        instance = len(names)
        names[instance] = name or "Unsectioned"
        signatures[instance] = signature
        return instance

    def next_header_signature(index: int, context: tuple[int, int]) -> tuple[str, ...]:
        for candidate in rows[index + 1:]:
            if (candidate["page"], candidate["table"]) != context:
                return ()
            classification = candidate.get("classification")
            if classification == "header":
                return _header_signature(candidate)
            if classification not in {"note", "unknown"}:
                return ()
        return ()

    for index, row in enumerate(rows):
        classification = row.get("classification")
        context = (row["page"], row["table"])
        signature = _header_signature(row)
        section_name = row.get("section")
        context_changed = last_context is not None and context != last_context

        if classification == "section":
            repeated_signature = next_header_signature(index, context)
            continues_open_instance = (
                active is not None
                and context_changed
                and _normal(section_name or row.get("rawText")) == _normal(names[active])
                and bool(repeated_signature)
                and bool(signatures[active])
                and repeated_signature == signatures[active]
            )
            if not continues_open_instance:
                active = open_instance(section_name or row.get("rawText"), signature)
        elif classification == "header":
            if active is None:
                active = open_instance(section_name, signature)
            elif section_name and _normal(section_name) != _normal(names[active]):
                active = open_instance(section_name, signature)
            elif (
                context_changed
                and signatures[active]
                and signature
                and signatures[active] != signature
            ):
                active = open_instance(section_name, signature)
            elif signature:
                signatures[active] = signature
        elif classification in {"item", "option", "continuation", "total"}:
            if active is None:
                active = open_instance(section_name, signature)
            elif section_name and _normal(section_name) != _normal(names[active]):
                active = open_instance(section_name, signature)
            elif (
                context_changed
                and signatures[active]
                and signature
                and signatures[active] != signature
            ):
                active = open_instance(section_name, signature)
            elif signature and not signatures[active]:
                signatures[active] = signature

        if active is not None:
            row_instances[row["id"]] = active
        if _is_section_total(row):
            active = None
        last_context = context
    return row_instances, names


def _derive_components(row: dict[str, Any], roles: dict[str, int], desc: str) -> tuple[list[dict[str, Any]], list[dict[str, Any]]] | None:
    # Proceed when at least one component has declared header roles. A
    # material-only row has no anchor cells at the labour columns (Docling
    # omits empty cells), but the header vector still declares them, so
    # _find_columns discovers labour_* roles even without present cells.
    if not any(role.startswith("material_") for role in roles) and not any(role.startswith("labour_") for role in roles):
        return None
    shared_qty_decimal = _decimal(_value(row, roles.get("qty")))
    shared_unit = _value(row, roles.get("unit"))
    components: dict[str, dict[str, Any]] = {}
    component_decimals: dict[str, dict[str, Decimal]] = {}
    component_has_evidence: dict[str, bool] = {}
    arithmetic_mismatch = False
    for component in ("material", "labour"):
        qty_decimal = _decimal(_value(row, roles.get(f"{component}_qty")))
        unit = _value(row, roles.get(f"{component}_unit"))
        rate_decimal = _decimal(_value(row, roles.get(f"{component}_rate")))
        total_decimal = _decimal(_value(row, roles.get(f"{component}_total")))
        qty_decimal = shared_qty_decimal if qty_decimal is None else qty_decimal
        unit = shared_unit if not unit else unit
        component_has_evidence[component] = rate_decimal is not None or total_decimal is not None
        if total_decimal is not None and qty_decimal is not None and rate_decimal is not None:
            if abs(
                qty_decimal * rate_decimal - total_decimal
            ) > RECONCILIATION_TOLERANCE:
                arithmetic_mismatch = True
        if total_decimal is not None and qty_decimal is not None and unit and rate_decimal is not None:
            component_decimals[component] = {
                "qty": qty_decimal, "rate": rate_decimal, "total": total_decimal,
            }
            components[component] = {
                "qty": _finite_float(qty_decimal), "unit": unit,
                "rate": _finite_float(rate_decimal), "total": _finite_float(total_decimal),
            }
    # When neither component has any numeric evidence at all, defer to the
    # non-component derivation path. A row like OVERHEAD&EXPENSES has only a
    # description and an aggregate amount; it should become a lump_sum item,
    # not an incomplete_component_evidence dead end.
    if not any(component_has_evidence.values()):
        return None
    if arithmetic_mismatch:
        return ([], [_warning(
            row, "component_arithmetic_mismatch",
            "A component quantity multiplied by rate does not reconcile to its source total.",
        )])
    if not components:
        return ([], [_warning(row, "incomplete_component_evidence", "Component prices were incomplete and were not inferred from the aggregate.")])
    if len(components) == 1:
        component, values = next(iter(components.items()))
        other = "labour" if component == "material" else "material"
        warnings: list[dict[str, Any]] = []
        # Only warn when the other component had partial evidence that could
        # not be completed. When the other component's columns are simply
        # absent (no rate or total at all), the row is a valid single-
        # component item, not an incomplete dual-component row.
        if component_has_evidence.get(other):
            warnings.append(_warning(
                row, "incomplete_component_evidence",
                "Only one component has complete source pricing; the missing component was not inferred from the aggregate.",
            ))
        return (
            [_priced_item(row, ordinal=1, desc=desc, component=component, **values)],
            warnings,
        )
    material, labour = components["material"], components["labour"]
    material_decimals = component_decimals["material"]
    labour_decimals = component_decimals["labour"]
    aggregate = _decimal(_value(row, roles.get("amount")))
    component_sum = material_decimals["total"] + labour_decimals["total"]
    warnings: list[dict[str, Any]] = []
    if aggregate is not None and abs(component_sum - aggregate) > RECONCILIATION_TOLERANCE:
        return ([], [_warning(row, "component_total_mismatch", "Material and labour totals do not reconcile to the quoted aggregate.")])
    if material_decimals["qty"] == labour_decimals["qty"] and material["unit"] == labour["unit"]:
        total = _finite_float(component_sum)
        qty = material["qty"]
        combined_rate = material_decimals["rate"] + labour_decimals["rate"]
        rate = _finite_float(combined_rate)
        if total is None or rate is None:
            return ([], [_warning(
                row, "numeric_overflow",
                "Combined component arithmetic exceeds the finite response range.",
            )])
        if abs(material_decimals["qty"] * combined_rate - component_sum) > RECONCILIATION_TOLERANCE:
            return ([], [_warning(
                row, "component_arithmetic_mismatch",
                "Combined component rate and total do not reconcile for the shared quantity.",
            )])
        return ([_priced_item(
            row, ordinal=1, desc=desc, component="combined", qty=qty,
            unit=material["unit"], rate=rate, total=total,
            source_costs={"material": material, "labour": labour}, kind="combined",
        )], warnings)
    return ([
        _priced_item(row, ordinal=1, desc=f"{desc} — material", component="material", kind="material", **material),
        _priced_item(row, ordinal=2, desc=f"{desc} — labour", component="labour", kind="labour", **labour),
    ], warnings)


def _derive_row(row: dict[str, Any], continuations: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    roles = _find_columns(row)
    if _has_numeric_overflow(row, roles):
        return [], [_warning(
            row, "numeric_overflow",
            "Numeric source evidence exceeds the finite response range.",
        )]
    if _has_invalid_numeric_format(row, roles):
        return [], [_warning(
            row, "invalid_numeric_format",
            "Numeric source evidence uses an unsupported or ambiguous token format.",
        )]
    if any(
        (cell.get("rowSpan", 1) > 1 or cell.get("columnSpan", 1) > 1 or cell.get("carried", False))
        and len(cell.get("lines") or []) > 1
        for cell in row.get("rawCells", [])
    ):
        return [], [_warning(
            row, "ambiguous_merged_cell",
            "Merged multiline cell geometry does not support an unambiguous deterministic split.",
        )]
    descriptions = _lines(row, roles.get("desc"))
    if not descriptions:
        return [], [_warning(row, "unsupported_row", "No deterministic description evidence was found.")]
    desc = " ".join([descriptions[0], *[
        _value(tail, _find_columns(tail).get("desc")) for tail in continuations
    ]]).strip()
    source_ids = [row["id"], *[tail["id"] for tail in continuations]]

    component = _derive_components(row, roles, desc)
    if component is not None:
        items, warnings = component
        for item in items:
            item["sourceRowIds"] = source_ids
        return items, warnings

    amount_lines = _lines(row, roles.get("amount"))
    qty_lines = _lines(row, roles.get("qty"))
    unit_lines = _lines(row, roles.get("unit"))
    rate_lines = _lines(row, roles.get("rate"))
    amount_decimal = _decimal(_value(row, roles.get("amount")))
    amount = _finite_float(amount_decimal) if amount_decimal is not None else None
    if len(descriptions) > 1 and amount is not None and not qty_lines and not rate_lines:
        parent_id = _item_id(row["id"], "bundle", 1)
        parent = _priced_item(
            row, ordinal=1, desc=" + ".join(descriptions), unit="L/S", qty=1.0,
            rate=amount, total=amount, component="lump_sum", kind="bundle",
        )
        children = [{
            "id": _item_id(row["id"], "child", index), "desc": child,
            "pricingRole": "bundle_child", "sourceRowIds": [row["id"]],
            "parentBundleId": parent_id, "entryOrigin": "docling",
        } for index, child in enumerate(descriptions, start=1)]
        return [parent, *children], []

    multiline = max(map(len, (descriptions, amount_lines, qty_lines, unit_lines, rate_lines)), default=0) > 1
    if multiline:
        counts = [len(values) for values in (descriptions, qty_lines, unit_lines, rate_lines, amount_lines)]
        if len(set(counts)) != 1:
            return [], [_warning(row, "unequal_multiline_counts", "Compound cell line counts do not support a one-to-one split.")]
        items: list[dict[str, Any]] = []
        for index, values in enumerate(zip(descriptions, qty_lines, unit_lines, rate_lines, amount_lines), start=1):
            line_desc, raw_qty, unit, raw_rate, raw_total = values
            qty_decimal, rate_decimal, total_decimal = (
                _decimal(raw_qty), _decimal(raw_rate), _decimal(raw_total)
            )
            if (
                qty_decimal is None or rate_decimal is None or total_decimal is None
                or abs(qty_decimal * rate_decimal - total_decimal) > RECONCILIATION_TOLERANCE
            ):
                return [], [_warning(row, "item_arithmetic_mismatch", "Aligned line arithmetic does not reconcile; the compound row was left unpriced.")]
            qty, rate, total = (
                _finite_float(qty_decimal), _finite_float(rate_decimal), _finite_float(total_decimal)
            )
            if qty is None or rate is None or total is None:
                return [], [_warning(row, "numeric_overflow", "Aligned numeric evidence exceeds the finite response range.")]
            items.append(_priced_item(row, ordinal=index, desc=line_desc, unit=unit, qty=qty, rate=rate, total=total))
        return items, []

    qty_decimal = _decimal(_value(row, roles.get("qty")))
    qty = _finite_float(qty_decimal) if qty_decimal is not None else None
    unit = _value(row, roles.get("unit"))
    rate_decimal = _decimal(_value(row, roles.get("rate")))
    rate = _finite_float(rate_decimal) if rate_decimal is not None else None
    if amount is not None and qty is None and rate is None:
        return [_priced_item(row, ordinal=1, desc=desc, unit="L/S", qty=1.0, rate=amount, total=amount, component="lump_sum", source_row_ids=source_ids)], []
    if qty is not None and unit and rate is not None and amount is None:
        computed = _finite_float(qty_decimal * rate_decimal)
        if computed is None:
            return [], [_warning(
                row, "numeric_overflow",
                "Quantity multiplied by rate exceeds the finite response range.",
            )]
        return [_priced_item(row, ordinal=1, desc=desc, unit=unit, qty=qty, rate=rate, total=computed, source_row_ids=source_ids)], []
    if qty is None or not unit or rate is None or amount is None:
        return [], [_warning(row, "unsupported_row", "Pricing evidence was incomplete; no numeric value was fabricated.")]
    if abs(qty_decimal * rate_decimal - amount_decimal) > RECONCILIATION_TOLERANCE:
        return [], [_warning(row, "item_arithmetic_mismatch", "Quantity multiplied by rate does not match the source amount.")]
    return [_priced_item(row, ordinal=1, desc=desc, unit=unit, qty=qty, rate=rate, total=amount, source_row_ids=source_ids)], []


def _total_rows(rows: list[dict[str, Any]]) -> list[tuple[dict[str, Any], float]]:
    totals: list[tuple[dict[str, Any], float]] = []
    for row in rows:
        if row.get("classification") != "total":
            continue
        roles = _find_columns(row)
        value = _number(_value(row, roles.get("amount")))
        if value is not None:
            totals.append((row, value))
    return totals


def _total_kind(label: str) -> str | None:
    if "grand total" in label:
        return "grand"
    if label.startswith("discount") or label.startswith("less discount"):
        return "discount"
    if re.search(r"before vat|pre vat|exclud\w* vat|excl vat|vat excluded", label):
        return "pre_vat"
    if re.search(r"\bvat\b", label):
        return "vat"
    if label.startswith("sub total"):
        return "subtotal"
    if label.startswith("total"):
        return "pre_discount"
    return None


def _adjustment_decimal(raw: str) -> Decimal | None:
    text = raw.strip()
    if text.startswith("(") and text.endswith(")"):
        text = text[1:-1].strip()
    return _decimal(text)


def _source_total(
    rows: list[dict[str, Any]],
    row_instances: dict[str, int],
    instance_names: dict[int, str],
) -> tuple[float | None, list[dict[str, Any]]]:
    evidence_warnings: list[dict[str, Any]] = []
    candidates: dict[str, list[dict[str, Any]]] = {
        kind: [] for kind in (
            "discount", "vat", "pre_discount", "pre_vat", "subtotal", "grand"
        )
    }
    invalid_adjustment = False
    for order, row in enumerate(rows):
        if row.get("classification") != "total":
            continue
        label = _normal(row.get("rawText"))
        kind = _total_kind(label)
        if kind is None:
            continue
        roles = _find_columns(row)
        raw = _value(row, roles.get("amount")).strip()
        value = _adjustment_decimal(raw) if kind in {"discount", "vat"} else _decimal(raw)
        if raw not in NON_NUMBER and value is None:
            evidence_warnings.append(_warning(
                row, "invalid_numeric_format",
                "Source total evidence uses an unsupported or ambiguous token format.",
            ))
            invalid_adjustment = invalid_adjustment or kind in {"discount", "vat"}
            continue
        if value is not None and _finite_float(value) is None:
            evidence_warnings.append(_warning(
                row, "numeric_overflow",
                "Source total exceeds the finite response range.",
            ))
            invalid_adjustment = invalid_adjustment or kind in {"discount", "vat"}
            continue
        if value is None or re.search(r"\b(?:carried|brought)\b", label):
            continue
        instance = row_instances.get(row["id"])
        candidates[kind].append({
            "row": row,
            "value": value,
            "order": order,
            "instance": instance,
            "documentSummary": (
                row.get("section") is None
                and instance is not None
                and instance_names.get(instance) == "Unsectioned"
            ),
        })

    if candidates["pre_vat"]:
        value = candidates["pre_vat"][-1]["value"]
        return _finite_float(value), evidence_warnings

    base_candidates = sorted(
        [*candidates["subtotal"], *candidates["pre_discount"]],
        key=lambda candidate: candidate["order"],
    )
    document_summaries = [
        candidate for candidate in base_candidates if candidate["documentSummary"]
    ]
    if document_summaries:
        return _finite_float(document_summaries[-1]["value"]), evidence_warnings
    if base_candidates:
        latest_by_instance: dict[int, dict[str, Any]] = {}
        for candidate in base_candidates:
            instance = candidate["instance"]
            if instance is not None:
                latest_by_instance[instance] = candidate
        selected = list(latest_by_instance.values())
        combined = sum((candidate["value"] for candidate in selected), Decimal(0))
        if _finite_float(combined) is None:
            return None, [*evidence_warnings, _warning(
                selected[-1]["row"], "numeric_overflow",
                "Aggregated source totals exceed the finite response range.",
            )]
        return _finite_float(combined), evidence_warnings

    grand = candidates["grand"][-1] if candidates["grand"] else None
    if invalid_adjustment:
        return None, evidence_warnings
    if candidates["vat"] and candidates["discount"]:
        warning_row = grand["row"] if grand is not None else candidates["vat"][-1]["row"]
        return None, [*evidence_warnings, _warning(
            warning_row, "ambiguous_total_adjustments",
            "VAT and discount adjustments lack explicit pre-adjustment ordering; source total was not guessed.",
        )]
    if grand is None:
        return None, evidence_warnings
    grand_row, grand_value = grand["row"], grand["value"]
    if candidates["vat"]:
        vat = sum((candidate["value"] for candidate in candidates["vat"]), Decimal(0))
        derived = grand_value - vat
        if derived < 0:
            return None, [*evidence_warnings, _warning(
                grand_row, "invalid_total_hierarchy",
                "Grand total is less than its explicit VAT adjustment.",
            )]
    elif candidates["discount"]:
        discount = sum(
            (candidate["value"] for candidate in candidates["discount"]), Decimal(0)
        )
        derived = grand_value + discount
    else:
        derived = grand_value
    if _finite_float(derived) is None:
        return None, [*evidence_warnings, _warning(
            grand_row, "numeric_overflow",
            "Derived pre-adjustment source total exceeds the finite response range.",
        )]
    return _finite_float(derived), evidence_warnings


def _section_total_warnings(
    section_items: dict[int, list[dict[str, Any]]],
    row_instances: dict[str, int],
    rows: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    latest: dict[int, tuple[dict[str, Any], float]] = {}
    for row, value in _total_rows(rows):
        instance = row_instances.get(row["id"])
        if instance is None or instance not in section_items:
            continue
        label = _normal(row.get("rawText"))
        if "grand total" not in label and not re.search(r"\b(?:vat|discount|carried|brought)\b", label) and (label.startswith("total") or label.startswith("sub total")):
            latest[instance] = (row, value)
    warnings: list[dict[str, Any]] = []
    for instance, (row, quoted) in latest.items():
        derived = checked_contributing_total(section_items.get(instance, []))
        if abs(derived - Decimal(str(quoted))) > RECONCILIATION_TOLERANCE:
            warnings.append(_warning(
                row, "section_total_mismatch",
                "Contributing items do not reconcile to the identifiable section total.",
            ))
    return warnings


def derive_source_rows(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """Derive items in fixed rule order without mutating lossless source rows."""
    if not isinstance(rows, list):
        raise ValueError("source rows must be a list")
    evidence = deepcopy(rows)
    continuation_map, consumed = _continuation_map(evidence)
    row_instances, instance_names = _section_instances(evidence)
    sections: list[dict[str, Any]] = []
    sections_by_instance: dict[int, dict[str, Any]] = {}
    warnings: list[dict[str, Any]] = []
    review_ids: list[str] = []
    cumulative_contribution = Decimal(0)

    def section_for(row: dict[str, Any]) -> dict[str, Any]:
        instance = row_instances[row["id"]]
        if instance not in sections_by_instance:
            section = {"header": instance_names[instance], "items": []}
            sections_by_instance[instance] = section
            sections.append(section)
        return sections_by_instance[instance]

    for row in evidence:
        classification = row.get("classification")
        if classification in {"header", "section", "total", "note"} or row["id"] in consumed:
            continue
        if classification not in {"item", "option"}:
            warning = _warning(row, "unsupported_row", "The source row was retained but could not be deterministically classified.")
            warnings.append(warning)
            review_ids.append(row["id"])
            continue
        section = section_for(row)
        items, row_warnings = _derive_row(row, continuation_map.get(row["id"], []))
        candidate_contribution = cumulative_contribution + _contributing_decimal(items)
        if items and _finite_float(candidate_contribution) is None:
            items = []
            row_warnings.append(_warning(
                row, "numeric_overflow",
                "Adding this row would exceed the finite document contribution range.",
            ))
        else:
            cumulative_contribution = candidate_contribution
        section["items"].extend(items)
        warnings.extend(row_warnings)
        if row_warnings:
            review_ids.append(row["id"])
    source_total, source_warnings = _source_total(
        evidence, row_instances, instance_names
    )
    warnings.extend(source_warnings)
    review_ids.extend(warning["sourceRowId"] for warning in source_warnings)
    section_warnings = _section_total_warnings(
        {instance: section["items"] for instance, section in sections_by_instance.items()},
        row_instances,
        evidence,
    )
    warnings.extend(section_warnings)
    review_ids.extend(warning["sourceRowId"] for warning in section_warnings)
    _total_items, reconciliation = build_reconciliation(sections, source_total)
    if source_total is not None and not reconciliation["reconciled"]:
        warnings.append({
            "code": "document_total_mismatch",
            "message": "Contributing derived items do not reconcile to the identifiable document total.",
        })
    annotated_rows = deepcopy(evidence)
    rows_by_id = {row["id"]: row for row in annotated_rows}
    for warning in warnings:
        row_id = warning.get("sourceRowId")
        if row_id not in rows_by_id:
            continue
        row_warnings = rows_by_id[row_id].setdefault("warnings", [])
        annotation = {
            key: value for key, value in warning.items() if key != "sourceRowId"
        }
        signature = json.dumps(annotation, sort_keys=True, ensure_ascii=False)
        existing = {
            json.dumps(value, sort_keys=True, ensure_ascii=False) for value in row_warnings
        }
        if signature not in existing:
            row_warnings.append(annotation)
    return {
        "sourceRows": annotated_rows,
        "sections": sections,
        "warnings": warnings,
        "warningCodes": [warning["code"] for warning in warnings],
        "reviewCandidateRowIds": list(dict.fromkeys(review_ids)),
        "sourceTotal": source_total,
        "reconciliation": reconciliation,
        "totalItems": _total_items,
    }


def derive_document(source_rows: list[dict[str, Any]]) -> dict[str, Any]:
    return derive_source_rows(source_rows)
