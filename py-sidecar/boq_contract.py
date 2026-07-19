from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, FiniteFloat, PositiveInt, model_validator


Confidence = Annotated[FiniteFloat, Field(ge=0.0, le=1.0)]
NonNegativeFinite = Annotated[FiniteFloat, Field(ge=0.0)]


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
        else:
            if self.parentBundleId is not None:
                raise ValueError("priced items cannot have parentBundleId")
            if not self.unit or any(value is None for value in (self.qty, self.rate, self.total)):
                raise ValueError("standard and bundle_parent items require unit, qty, rate, and total")
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
