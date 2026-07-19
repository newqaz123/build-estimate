from decimal import Decimal, InvalidOperation
import sys
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, PositiveInt, model_validator


Confidence = Annotated[FiniteFloat, Field(ge=0.0, le=1.0)]
NonNegativeFinite = Annotated[FiniteFloat, Field(ge=0.0)]
RECONCILIATION_TOLERANCE = Decimal("0.01")
MAX_FINITE_FLOAT = Decimal(str(sys.float_info.max))


class ContractModel(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")


class SourceRef(ContractModel):
    page: PositiveInt
    table: PositiveInt
    row: PositiveInt


class MetadataField(ContractModel):
    value: str
    confidence: Confidence
    source: str


class WorkTypeMetadataField(MetadataField):
    value: Literal["MEP", "Structural", "Finishing", "Unclassified"]


class Metadata(ContractModel):
    vendor: MetadataField
    project: MetadataField
    date: MetadataField
    workType: WorkTypeMetadataField


class ExtractionWarning(ContractModel):
    code: str
    message: str
    sourceRef: SourceRef | None = None


class RawCell(ContractModel):
    column: Annotated[int, Field(ge=0)]
    rawText: str
    lines: list[str]
    rowSpan: PositiveInt = 1
    columnSpan: PositiveInt = 1
    startRowOffset: Annotated[int, Field(ge=0)]
    endRowOffset: PositiveInt
    startColumnOffset: Annotated[int, Field(ge=0)]
    endColumnOffset: PositiveInt
    columnHeader: bool = False
    rowHeader: bool = False
    rowSection: bool = False
    carried: bool = False

    @model_validator(mode="after")
    def validate_offsets(self):
        if self.endRowOffset <= self.startRowOffset:
            raise ValueError("endRowOffset must be greater than startRowOffset")
        if self.endColumnOffset <= self.startColumnOffset:
            raise ValueError("endColumnOffset must be greater than startColumnOffset")
        if self.rowSpan != self.endRowOffset - self.startRowOffset:
            raise ValueError("rowSpan must match the row offsets")
        if self.columnSpan != self.endColumnOffset - self.startColumnOffset:
            raise ValueError("columnSpan must match the column offsets")
        if self.column != self.startColumnOffset:
            raise ValueError("column must match startColumnOffset")
        return self


class SourceRow(ContractModel):
    id: Annotated[str, Field(min_length=1)]
    page: PositiveInt
    table: PositiveInt
    row: PositiveInt
    section: str | None = None
    headers: list[str]
    rawCells: list[RawCell]
    rawText: str
    classification: Literal[
        "header", "section", "item", "continuation", "total", "option", "note", "unknown"
    ]
    confidence: Confidence
    warnings: list[ExtractionWarning]


class DerivedItemV3(ContractModel):
    id: Annotated[str, Field(min_length=1)]
    desc: Annotated[str, Field(min_length=1)]
    pricingRole: Literal["standard", "bundle_parent", "bundle_child"]
    sourceRowIds: Annotated[list[str], Field(min_length=1)]
    parentBundleId: str | None = None
    optional: bool = False
    excludedFromTotal: bool = False
    unit: str | None = None
    qty: NonNegativeFinite | None = None
    rate: NonNegativeFinite | None = None
    total: NonNegativeFinite | None = None

    @model_validator(mode="after")
    def validate_pricing_shape(self):
        priced_values = (self.unit, self.qty, self.rate, self.total)
        if self.pricingRole == "bundle_child":
            if not self.parentBundleId:
                raise ValueError("bundle_child requires parentBundleId")
            if any(value is not None for value in priced_values):
                raise ValueError("bundle_child cannot carry priced fields")
            if self.excludedFromTotal:
                raise ValueError("bundle_child is informational and cannot be excluded from totals")
        else:
            if self.parentBundleId is not None:
                raise ValueError("priced items cannot have parentBundleId")
            if not self.unit or any(value is None for value in (self.qty, self.rate, self.total)):
                raise ValueError("standard and bundle_parent items require unit, qty, rate, and total")
        if self.excludedFromTotal and not self.optional:
            raise ValueError("excludedFromTotal requires optional")
        return self


class SectionV3(ContractModel):
    header: str
    items: list[DerivedItemV3]


class Reconciliation(ContractModel):
    itemTotal: NonNegativeFinite
    sourceTotal: NonNegativeFinite | None = None
    reconciled: bool
    difference: FiniteFloat


class ParseResponseV3(ContractModel):
    contractVersion: Literal[3] = 3
    documentName: str
    pageCount: Annotated[int, Field(ge=0)]
    documentText: str
    sourceRows: list[SourceRow]
    sections: list[SectionV3]
    metadata: Metadata
    warnings: list[ExtractionWarning]
    sourceTotal: NonNegativeFinite | None = None
    reconciliation: Reconciliation
    totalItems: Annotated[int, Field(ge=0)]

    @model_validator(mode="after")
    def validate_response_invariants(self):
        source_ids = [row.id for row in self.sourceRows]
        if len(source_ids) != len(set(source_ids)):
            raise ValueError("source row IDs must be unique")
        known_source_ids = set(source_ids)

        items = [item for section in self.sections for item in section.items]
        item_ids = [item.id for item in items]
        if len(item_ids) != len(set(item_ids)):
            raise ValueError("derived item IDs must be unique")
        for item in items:
            if len(item.sourceRowIds) != len(set(item.sourceRowIds)):
                raise ValueError(f"derived item {item.id} repeats a source row ID")
            if not set(item.sourceRowIds) <= known_source_ids:
                raise ValueError(f"derived item {item.id} references an unknown source row")

        for section in self.sections:
            section_items = {item.id: item for item in section.items}
            for item in section.items:
                if item.pricingRole != "bundle_child":
                    continue
                parent = section_items.get(item.parentBundleId or "")
                if parent is None or parent.id == item.id or parent.pricingRole != "bundle_parent":
                    raise ValueError(f"bundle child {item.id} requires a bundle parent in the same section")

        priced_count = sum(item.pricingRole != "bundle_child" for item in items)
        if self.totalItems != priced_count:
            raise ValueError("totalItems must equal the number of priced derived items")

        calculated_total = checked_contributing_total(items)
        if _decimal(self.reconciliation.itemTotal, "reconciliation.itemTotal") != calculated_total:
            raise ValueError("reconciliation.itemTotal does not match contributing items")

        response_source = _optional_decimal(self.sourceTotal, "sourceTotal")
        reconciliation_source = _optional_decimal(
            self.reconciliation.sourceTotal, "reconciliation.sourceTotal"
        )
        if response_source != reconciliation_source:
            raise ValueError("sourceTotal must match reconciliation.sourceTotal")

        expected_difference = calculated_total - response_source if response_source is not None else Decimal(0)
        _ensure_float_representable(expected_difference, "reconciliation difference")
        if _decimal(self.reconciliation.difference, "reconciliation.difference") != expected_difference:
            raise ValueError("reconciliation.difference is inconsistent")
        expected_reconciled = (
            response_source is not None and abs(expected_difference) <= RECONCILIATION_TOLERANCE
        )
        if self.reconciliation.reconciled is not expected_reconciled:
            raise ValueError("reconciliation.reconciled is inconsistent")
        return self


def _decimal(value: Any, name: str) -> Decimal:
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError) as error:
        raise ValueError(f"{name} must be finite") from error
    if not result.is_finite():
        raise ValueError(f"{name} must be finite")
    return result


def _optional_decimal(value: Any, name: str) -> Decimal | None:
    return None if value is None else _decimal(value, name)


def _ensure_float_representable(value: Decimal, name: str) -> None:
    if not value.is_finite() or abs(value) > MAX_FINITE_FLOAT:
        raise ValueError(f"{name} exceeds finite float range")


def checked_contributing_total(items: list[Any]) -> Decimal:
    total = Decimal(0)
    for item in items:
        role = item.pricingRole if hasattr(item, "pricingRole") else item["pricingRole"]
        excluded = (
            item.excludedFromTotal if hasattr(item, "excludedFromTotal")
            else item.get("excludedFromTotal", False)
        )
        if role == "bundle_child" or excluded:
            continue
        value = item.total if hasattr(item, "total") else item["total"]
        total += _decimal(value, "derived item total")
        _ensure_float_representable(total, "contributing item total")
    return total


def build_reconciliation(sections: list[Any], source_total: float | None) -> tuple[int, dict[str, Any]]:
    items = [
        item
        for section in sections
        for item in (section["items"] if isinstance(section, dict) else section.items)
    ]
    item_total = checked_contributing_total(items)
    source = _optional_decimal(source_total, "sourceTotal")
    difference = item_total - source if source is not None else Decimal(0)
    _ensure_float_representable(difference, "reconciliation difference")
    priced_count = sum(
        (item.pricingRole if hasattr(item, "pricingRole") else item["pricingRole"]) != "bundle_child"
        for item in items
    )
    return priced_count, {
        "itemTotal": float(item_total),
        "sourceTotal": source_total,
        "reconciled": source is not None and abs(difference) <= RECONCILIATION_TOLERANCE,
        "difference": float(difference),
    }
