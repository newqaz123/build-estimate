from decimal import Decimal, InvalidOperation
import math
import re
import sys
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, PositiveInt, model_validator


Confidence = Annotated[FiniteFloat, Field(ge=0.0, le=1.0)]
NonNegativeFinite = Annotated[FiniteFloat, Field(ge=0.0)]
RECONCILIATION_TOLERANCE = Decimal("0.01")
MAX_FINITE_FLOAT = Decimal(str(sys.float_info.max))
CANONICAL_DECIMAL = re.compile(r"^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$")


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


class SourceCostEvidence(ContractModel):
    qty: NonNegativeFinite
    unit: Annotated[str, Field(min_length=1)]
    rate: NonNegativeFinite
    total: NonNegativeFinite

    @model_validator(mode="after")
    def validate_arithmetic(self):
        if abs(
            _decimal(self.qty, "source cost qty") * _decimal(self.rate, "source cost rate")
            - _decimal(self.total, "source cost total")
        ) > RECONCILIATION_TOLERANCE:
            raise ValueError("source cost quantity multiplied by rate must match total")
        return self


class SourceCostsEvidence(ContractModel):
    material: SourceCostEvidence
    labour: SourceCostEvidence


class DerivedItemV3(ContractModel):
    id: Annotated[str, Field(min_length=1)]
    desc: Annotated[str, Field(min_length=1)]
    pricingRole: Literal["standard", "bundle_parent", "bundle_child"]
    sourceRowIds: Annotated[list[str], Field(min_length=1)]
    parentBundleId: str | None = None
    optional: bool = False
    excludedFromTotal: bool = False
    exclusionReason: str | None = None
    entryOrigin: Literal["docling", "ai_accepted", "user"] = "docling"
    costComponent: Literal["material", "labour", "combined", "lump_sum"] | None = None
    sourceCosts: SourceCostsEvidence | None = None
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
            if self.sourceCosts is not None:
                raise ValueError("bundle_child cannot carry source costs")
            if self.costComponent is not None:
                raise ValueError("bundle_child cannot carry a cost component")
        else:
            if self.parentBundleId is not None:
                raise ValueError("priced items cannot have parentBundleId")
            if not self.unit or any(value is None for value in (self.qty, self.rate, self.total)):
                raise ValueError("standard and bundle_parent items require unit, qty, rate, and total")
            if self.costComponent is None:
                raise ValueError("priced items require costComponent")
            quantity = _decimal(self.qty, "derived item qty")
            rate = _decimal(self.rate, "derived item rate")
            total = _decimal(self.total, "derived item total")
            if abs(quantity * rate - total) > RECONCILIATION_TOLERANCE:
                raise ValueError("priced item quantity multiplied by rate must match total")
        if self.excludedFromTotal and not self.optional:
            raise ValueError("excludedFromTotal requires optional")
        if self.excludedFromTotal and not self.exclusionReason:
            raise ValueError("excludedFromTotal requires exclusionReason")
        if not self.excludedFromTotal and self.exclusionReason is not None:
            raise ValueError("exclusionReason requires excludedFromTotal")
        if self.sourceCosts is not None and self.costComponent != "combined":
            raise ValueError("sourceCosts require the combined cost component")
        if self.sourceCosts is not None:
            material, labour = self.sourceCosts.material, self.sourceCosts.labour
            component_total = (
                _decimal(material.total, "material total")
                + _decimal(labour.total, "labour total")
            )
            if abs(component_total - _decimal(self.total, "item total")) > RECONCILIATION_TOLERANCE:
                raise ValueError("component totals must sum to item total")
            # Same-unit combined rows keep shared qty/unit/rate identity.
            # Different native component units stay on one line; comparison
            # uses sourceCosts for each component's own unit and quantity.
            if material.unit == labour.unit:
                if material.unit != self.unit:
                    raise ValueError("combined source costs and item must share a unit")
                component_qty = _decimal(material.qty, "material qty")
                if (
                    component_qty != _decimal(labour.qty, "labour qty")
                    or component_qty != _decimal(self.qty, "item qty")
                ):
                    raise ValueError("combined source costs and item must share quantity")
                component_rate = (
                    _decimal(material.rate, "material rate")
                    + _decimal(labour.rate, "labour rate")
                )
                if abs(component_rate - _decimal(self.rate, "item rate")) > RECONCILIATION_TOLERANCE:
                    raise ValueError("component rates must sum to item rate")
        return self


class SectionV3(ContractModel):
    header: str
    items: list[DerivedItemV3]


class Reconciliation(ContractModel):
    itemTotal: NonNegativeFinite
    sourceTotal: NonNegativeFinite | None = None
    reconciled: bool
    difference: FiniteFloat


class SourceQuoteSummary(ContractModel):
    directWorkTotal: str
    overheadProfitAmount: str | None = None
    quotedSubtotal: str
    discountAmount: str | None = None
    payableTotal: str | None = None
    overheadProfitSourceRef: SourceRef | None = None
    discountSourceRef: SourceRef | None = None
    subtotalSourceRef: SourceRef | None = None
    payableTotalSourceRef: SourceRef | None = None


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
    sourceQuoteSummary: SourceQuoteSummary | None = None
    reconciliation: Reconciliation
    totalItems: Annotated[int, Field(ge=0)]

    @model_validator(mode="after")
    def validate_response_invariants(self):
        source_ids = [row.id for row in self.sourceRows]
        if len(source_ids) != len(set(source_ids)):
            raise ValueError("source row IDs must be unique")
        source_locations = [(row.page, row.table, row.row) for row in self.sourceRows]
        if len(source_locations) != len(set(source_locations)):
            raise ValueError("source row locations must be unique")
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
        _, serialized_total = _checked_float_round_trip(calculated_total, "contributing item total")
        if _decimal(self.reconciliation.itemTotal, "reconciliation.itemTotal") != serialized_total:
            raise ValueError("reconciliation.itemTotal does not match contributing items")

        response_source = _optional_decimal(self.sourceTotal, "sourceTotal")
        reconciliation_source = _optional_decimal(
            self.reconciliation.sourceTotal, "reconciliation.sourceTotal"
        )
        if response_source != reconciliation_source:
            raise ValueError("sourceTotal must match reconciliation.sourceTotal")

        comparison_total = serialized_total
        summary = self.sourceQuoteSummary
        if summary is not None:
            direct = _canonical_nonnegative_decimal(
                summary.directWorkTotal, "sourceQuoteSummary.directWorkTotal"
            )
            quoted = _canonical_nonnegative_decimal(
                summary.quotedSubtotal, "sourceQuoteSummary.quotedSubtotal"
            )
            overhead = (
                Decimal(0)
                if summary.overheadProfitAmount is None
                else _canonical_nonnegative_decimal(
                    summary.overheadProfitAmount,
                    "sourceQuoteSummary.overheadProfitAmount",
                )
            )
            if direct != serialized_total or direct + overhead != quoted:
                raise ValueError(
                    "sourceQuoteSummary does not reconcile direct work to quoted subtotal"
                )
            if response_source != quoted:
                raise ValueError("sourceTotal must match sourceQuoteSummary.quotedSubtotal")

            if (summary.discountAmount is None) != (summary.payableTotal is None):
                raise ValueError(
                    "sourceQuoteSummary discount and payable total must both be present or absent"
                )
            if summary.discountAmount is not None and summary.payableTotal is not None:
                discount = _canonical_nonnegative_decimal(
                    summary.discountAmount, "sourceQuoteSummary.discountAmount"
                )
                payable = _canonical_nonnegative_decimal(
                    summary.payableTotal, "sourceQuoteSummary.payableTotal"
                )
                if quoted - discount != payable:
                    raise ValueError(
                        "sourceQuoteSummary discount does not reconcile to payable total"
                    )

            known_source_locations = set(source_locations)
            for name in (
                "overheadProfitSourceRef", "discountSourceRef",
                "subtotalSourceRef", "payableTotalSourceRef",
            ):
                source_ref = getattr(summary, name)
                if source_ref is not None and (
                    source_ref.page, source_ref.table, source_ref.row
                ) not in known_source_locations:
                    raise ValueError(
                        f"sourceQuoteSummary.{name} references an unknown source row"
                    )
            comparison_total = quoted

        expected_difference = comparison_total - response_source if response_source is not None else Decimal(0)
        _, serialized_difference = _checked_float_round_trip(
            expected_difference, "reconciliation difference"
        )
        if _decimal(self.reconciliation.difference, "reconciliation.difference") != serialized_difference:
            raise ValueError("reconciliation.difference is inconsistent")
        expected_reconciled = (
            response_source is not None and abs(serialized_difference) <= RECONCILIATION_TOLERANCE
        )
        if self.reconciliation.reconciled is not expected_reconciled:
            raise ValueError("reconciliation.reconciled is inconsistent")
        return self


def _canonical_nonnegative_decimal(value: Any, name: str) -> Decimal:
    if not isinstance(value, str) or not CANONICAL_DECIMAL.fullmatch(value):
        raise ValueError(f"{name} must be a canonical nonnegative decimal string")
    parsed = Decimal(value)
    if not parsed.is_finite() or parsed < 0:
        raise ValueError(f"{name} must be a canonical nonnegative decimal string")
    return parsed


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


def _checked_float_round_trip(value: Decimal, name: str) -> tuple[float, Decimal]:
    """Serialize a checked Decimal through the finite JSON-number representation used by v3."""
    _ensure_float_representable(value, name)
    serialized = float(value)
    if not math.isfinite(serialized):
        raise ValueError(f"{name} exceeds finite float range")
    return serialized, Decimal(str(serialized))


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


def build_reconciliation(
    sections: list[Any],
    source_total: float | None,
    source_quote_summary: SourceQuoteSummary | dict[str, Any] | None = None,
) -> tuple[int, dict[str, Any]]:
    items = [
        item
        for section in sections
        for item in (section["items"] if isinstance(section, dict) else section.items)
    ]
    item_total = checked_contributing_total(items)
    serialized_item_total, item_total_representation = _checked_float_round_trip(
        item_total, "contributing item total"
    )
    source = _optional_decimal(source_total, "sourceTotal")
    comparison_total = item_total_representation
    if source_quote_summary is not None:
        quoted_subtotal = (
            source_quote_summary.quotedSubtotal
            if hasattr(source_quote_summary, "quotedSubtotal")
            else source_quote_summary["quotedSubtotal"]
        )
        comparison_total = _canonical_nonnegative_decimal(
            quoted_subtotal, "sourceQuoteSummary.quotedSubtotal"
        )
    difference = comparison_total - source if source is not None else Decimal(0)
    serialized_difference, difference_representation = _checked_float_round_trip(
        difference, "reconciliation difference"
    )
    priced_count = sum(
        (item.pricingRole if hasattr(item, "pricingRole") else item["pricingRole"]) != "bundle_child"
        for item in items
    )
    return priced_count, {
        "itemTotal": serialized_item_total,
        "sourceTotal": source_total,
        "reconciled": source is not None and abs(difference_representation) <= RECONCILIATION_TOLERANCE,
        "difference": serialized_difference,
    }
