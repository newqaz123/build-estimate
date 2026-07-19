import logging
import re
from functools import lru_cache
from io import BytesIO
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
from typing import Annotated, Any, List, Literal, Optional
from pydantic import BaseModel, Field, FiniteFloat, PositiveInt

from boq_contract import ParseResponseV3, build_reconciliation
from boq_compound_parser import derive_document
from boq_parser import extract_boq_document
from boq_source_rows import build_source_rows, remap_legacy_warnings

app = FastAPI(title="Docling Sidecar", version="0.1.0")
logger = logging.getLogger("docling_sidecar")

Confidence = Annotated[FiniteFloat, Field(ge=0.0, le=1.0)]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class SourceRef(BaseModel):
    page: PositiveInt
    table: PositiveInt
    row: PositiveInt


class SourceCost(BaseModel):
    present: bool
    qty: FiniteFloat
    unit: str
    rate: FiniteFloat
    total: FiniteFloat


class SourceCosts(BaseModel):
    material: SourceCost
    labour: SourceCost


class Item(BaseModel):
    id: str
    desc: str
    unit: str
    qty: FiniteFloat
    rate: FiniteFloat
    total: FiniteFloat
    type: Literal["unit", "lump_sum"]
    costComponent: Literal["material", "labour", "combined", "lump_sum"]
    sourceRef: SourceRef
    sourceCosts: Optional[SourceCosts] = None


class Section(BaseModel):
    header: str
    items: List[Item]


class MetadataField(BaseModel):
    value: str
    confidence: Confidence
    source: str


class WorkTypeMetadataField(MetadataField):
    value: Literal["MEP", "Structural", "Finishing", "Unclassified"]


class Metadata(BaseModel):
    vendor: MetadataField
    project: MetadataField
    date: MetadataField
    workType: WorkTypeMetadataField


class RawTable(BaseModel):
    page: int
    table: int
    rows: List[List[Any]]


class ExtractionWarning(BaseModel):
    code: str
    message: str
    sourceRef: Optional[SourceRef] = None


class ParseResponse(BaseModel):
    contractVersion: Literal[2] = 2
    documentName: str
    pageCount: int
    documentText: str
    tables: List[RawTable]
    sections: List[Section]
    metadata: Metadata
    warnings: List[ExtractionWarning]
    sourceTotal: Optional[FiniteFloat] = None
    totalItems: int


@app.get("/health")
async def health():
    try:
        import docling  # noqa: F401
        return {"status": "ok", "parser": "docling"}
    except ImportError:
        raise HTTPException(status_code=503, detail="Docling is not installed")


@lru_cache(maxsize=1)
def get_converter():
    from docling.document_converter import DocumentConverter

    return DocumentConverter()


def _table_page(table: Any) -> int:
    provenance = getattr(table, "prov", None)
    if type(provenance) is not list or not provenance:
        raise ValueError("Docling table is missing page provenance")
    page = getattr(provenance[0], "page_no", None)
    if type(page) is not int or page < 1:
        raise ValueError("Docling table page provenance is invalid")
    return page


def _table_data(table: Any) -> Any:
    data = getattr(table, "data", None)
    if data is None:
        raise ValueError("Docling table is missing table data")
    for field in ("table_cells", "num_rows", "num_cols"):
        if not hasattr(data, field):
            raise ValueError(f"Docling table data is missing {field}")
    return data


def build_parse_response(filename: str, document: Any) -> ParseResponseV3:
    document_text = document.export_to_text(page_break_placeholder="\n\f\n")
    tables: list[dict[str, Any]] = []
    raw_tables: list[dict[str, Any]] = []
    for index, table in enumerate(document.tables, start=1):
        page = _table_page(table)
        data = _table_data(table)
        frame = table.export_to_dataframe(doc=document).fillna("")
        tables.append({
            "page": page,
            "table": index,
            "rows": [list(frame.columns), *frame.values.tolist()],
        })
        raw_tables.append({
            "page": page,
            "table": index,
            "cells": list(data.table_cells),
            "num_rows": data.num_rows,
            "num_cols": data.num_cols,
        })
    source_rows = build_source_rows(raw_tables, document=document)
    normalized = extract_boq_document(tables, document_text)
    deterministic = derive_document(source_rows)
    sections = deterministic["sections"]
    extraction_warnings = remap_legacy_warnings(normalized["warnings"], tables, source_rows)
    deterministic_warnings = [
        {key: value for key, value in warning.items() if key != "sourceRowId"}
        for warning in deterministic["warnings"]
    ]
    source_total = deterministic["sourceTotal"]
    if source_total is None:
        source_total = normalized["sourceTotal"]
    total_items, reconciliation = build_reconciliation(sections, source_total)
    return ParseResponseV3(
        contractVersion=3,
        documentName=filename,
        pageCount=len(document.pages),
        documentText=document_text,
        sourceRows=deterministic["sourceRows"],
        sections=sections,
        metadata=normalized["metadata"],
        warnings=[*extraction_warnings, *deterministic_warnings],
        sourceTotal=source_total,
        reconciliation=reconciliation,
        totalItems=total_items,
    )


def convert_pdf(filename: str, content: bytes):
    from docling.datamodel.base_models import DocumentStream

    source = DocumentStream(name=filename, stream=BytesIO(content))
    result = get_converter().convert(source, max_num_pages=500, max_file_size=20 * 1024 * 1024)
    return build_parse_response(filename, result.document)


@app.post("/parse", response_model=ParseResponseV3, response_model_exclude_none=True)
async def parse_pdf(file: UploadFile = File(...)):
    filename = file.filename or "document.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")
    content = await file.read()
    if not content or len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="PDF must be between 1 byte and 20 MB")
    try:
        response = await run_in_threadpool(convert_pdf, filename, content)
    except ImportError as error:
        raise HTTPException(status_code=503, detail="Docling is not installed") from error
    except Exception as error:
        category = "validation_error" if isinstance(error, ValueError) else "conversion_error"
        logger.error(
            "Docling conversion failed category=%s file=%s",
            category,
            _safe_log_filename(filename),
        )
        raise HTTPException(status_code=422, detail="Docling could not parse this PDF") from error
    if response.totalItems == 0:
        raise HTTPException(status_code=422, detail="No BOQ line-item tables were found in this PDF")
    return response


def _safe_log_filename(filename: Any) -> str:
    if type(filename) is not str:
        return "document.pdf"
    path_like = filename.replace("\\", "/")
    path_like = re.sub(r"[\x00-\x1f\x7f]+", "/", path_like)
    basename = path_like.rsplit("/", 1)[-1]
    sanitized = re.sub(r"[^A-Za-z0-9._ -]", "_", basename).strip(" .")
    return (sanitized or "document.pdf")[:128]
