import json
import logging
import re
from functools import lru_cache
from io import BytesIO
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
from typing import Any, List, Literal, Optional, cast
from pydantic import BaseModel, Field, FiniteFloat, PositiveInt

from boq_contract import ParseResponseV3, build_reconciliation
from boq_compound_parser import derive_document
from boq_parser import extract_boq_document
from boq_source_rows import build_source_rows, remap_legacy_warnings

app = FastAPI(title="Docling Sidecar", version="0.1.0")
logger = logging.getLogger("docling_sidecar")

# FiniteFloat + Field keeps Pydantic runtime bounds; avoid Annotated alias for pyright.
Confidence = FiniteFloat

app.add_middleware(
    CORSMiddleware,
    # Local Next.js app only — never wildcard with credentials.
    allow_origins=[
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    ],
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
    confidence: Confidence = Field(ge=0.0, le=1.0)
    source: str


class WorkTypeMetadataField(BaseModel):
    # Own model (not a narrowing subclass) so pyright accepts the Literal value type.
    value: Literal["MEP", "Structural", "Finishing", "Unclassified"]
    confidence: Confidence = Field(ge=0.0, le=1.0)
    source: str


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


def _is_ocr_dependency_error(error: BaseException) -> bool:
    message = str(error).lower()
    return any(token in message for token in ('tesserocr', 'tesseract', 'ocr engine', 'ocr'))


@lru_cache(maxsize=2)
def get_converter(do_ocr: bool = True):
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions, TesseractOcrOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption

    if do_ocr:
        pipeline_options = PdfPipelineOptions(
            do_ocr=True,
            ocr_options=TesseractOcrOptions(lang=['eng', 'tha']),
        )
    else:
        # Local dev often has Docling without system Tesseract/tesserocr. Embedded PDF
        # text + table extraction still works for digital BOQs.
        pipeline_options = PdfPipelineOptions(do_ocr=False)

    return DocumentConverter(
        format_options={
            InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options),
        },
    )


def _parse_page_selection(value: str | None, page_count: int) -> list[int] | None:
    if value is None:
        return None
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError('pages must be a JSON array') from error
    if type(parsed) is not list or not parsed:
        raise ValueError('pages must be a non-empty JSON array')
    if any(type(page) is not int or page < 1 for page in parsed):
        raise ValueError('pages must contain positive integer page numbers')
    if len(set(parsed)) != len(parsed):
        raise ValueError('pages must not contain duplicate page numbers')
    if any(page > page_count for page in parsed):
        raise ValueError(f'pages must be between 1 and {page_count}')
    return sorted(parsed)


def _selected_pdf(content: bytes, pages: list[int]) -> tuple[bytes, list[int], int]:
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(BytesIO(content))
    original_page_count = len(reader.pages)
    validated_pages = _parse_page_selection(json.dumps(pages), original_page_count)
    if validated_pages is None:
        raise ValueError('selected pages are required')
    writer = PdfWriter()
    for page in validated_pages:
        writer.add_page(reader.pages[page - 1])
    output = BytesIO()
    writer.write(output)
    return output.getvalue(), validated_pages, original_page_count


def _table_page(table: Any) -> int:
    provenance = getattr(table, "prov", None)
    if type(provenance) is not list or not provenance:
        raise ValueError("Docling table is missing page provenance")
    page = getattr(provenance[0], "page_no", None)
    if type(page) is not int or page < 1:
        raise ValueError("Docling table page provenance is invalid")
    return page


def _table_number(
    table: Any,
    fallback: int,
    local_index: int,
    selected_page_map: bool,
) -> int:
    for candidate in (
        getattr(table, "table_no", None),
        getattr(table, "table_number", None),
        getattr(table, "global_table_no", None),
    ):
        if type(candidate) is int and candidate >= 1:
            return candidate
    self_ref = getattr(table, "self_ref", None)
    if type(self_ref) is str:
        match = re.search(r"/tables/(\d+)$", self_ref)
        if match:
            return int(match.group(1)) + 1
    # Reduced PDFs cannot recover the full-document ordinal when Docling does
    # not expose one. Keep the source reference page-local instead of claiming
    # that selected-document enumeration is a global original table number.
    return local_index if selected_page_map else fallback


def _table_data(table: Any) -> Any:
    data = getattr(table, "data", None)
    if data is None:
        raise ValueError("Docling table is missing table data")
    for field in ("table_cells", "num_rows", "num_cols"):
        if not hasattr(data, field):
            raise ValueError(f"Docling table data is missing {field}")
    return data


def build_parse_response(
    filename: str,
    document: Any,
    *,
    original_page_map: list[int] | None = None,
    original_page_count: int | None = None,
) -> ParseResponseV3:
    document_text = document.export_to_text(page_break_placeholder="\n\f\n")
    tables: list[dict[str, Any]] = []
    raw_tables: list[dict[str, Any]] = []
    table_indices_by_page: dict[int, int] = {}
    selected_page_map = original_page_map is not None
    for index, table in enumerate(document.tables, start=1):
        filtered_page = _table_page(table)
        if original_page_map is None:
            page = filtered_page
        elif filtered_page < 1 or filtered_page > len(original_page_map):
            raise ValueError("Docling table page provenance is outside the selected page map")
        else:
            page = original_page_map[filtered_page - 1]
        data = _table_data(table)
        local_index = table_indices_by_page.get(page, 0) + 1
        table_indices_by_page[page] = local_index
        table_number = _table_number(table, index, local_index, selected_page_map)
        frame = table.export_to_dataframe(doc=document).fillna("")
        tables.append({
            "page": page,
            "table": table_number,
            "rows": [list(frame.columns), *frame.values.tolist()],
        })
        raw_tables.append({
            "page": page,
            "table": table_number,
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
    source_quote_summary = deterministic.get("sourceQuoteSummary")
    total_items, reconciliation = build_reconciliation(
        sections, source_total, source_quote_summary
    )
    return ParseResponseV3(
        contractVersion=3,
        documentName=filename,
        pageCount=(original_page_count if original_page_count is not None else len(document.pages)),
        documentText=document_text,
        sourceRows=deterministic["sourceRows"],
        sections=sections,
        metadata=normalized["metadata"],
        # Helpers return dict-shaped payloads; cast keeps pyright aligned without runtime change.
        warnings=cast(Any, [*extraction_warnings, *deterministic_warnings]),
        sourceTotal=source_total,
        sourceQuoteSummary=cast(Any, source_quote_summary),
        reconciliation=cast(Any, reconciliation),
        totalItems=total_items,
    )


def convert_pdf(filename: str, content: bytes, pages: list[int] | None = None):
    from docling.datamodel.base_models import DocumentStream

    original_page_map: list[int] | None = None
    original_page_count: int | None = None
    source_content = content
    if pages is not None:
        source_content, original_page_map, original_page_count = _selected_pdf(content, pages)
    source = DocumentStream(name=filename, stream=BytesIO(source_content))

    try:
        result = get_converter(True).convert(source, max_num_pages=500, max_file_size=20 * 1024 * 1024)
    except ImportError as error:
        # Docling raises ImportError during pipeline init when OCR engines are missing.
        # That used to surface as a misleading HTTP 503 "Docling is not installed".
        if not _is_ocr_dependency_error(error):
            raise
        logger.warning(
            "OCR unavailable (%s); converting with embedded-text pipeline",
            error,
        )
        source = DocumentStream(name=filename, stream=BytesIO(source_content))
        result = get_converter(False).convert(source, max_num_pages=500, max_file_size=20 * 1024 * 1024)

    return build_parse_response(
        filename,
        result.document,
        original_page_map=original_page_map,
        original_page_count=original_page_count,
    )


@app.post("/parse", response_model=ParseResponseV3, response_model_exclude_none=True)
async def parse_pdf(file: UploadFile = File(...), pages: str | None = Form(default=None)):
    filename = file.filename or "document.pdf"
    if not filename.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are supported")
    content = await file.read()
    if not content or len(content) > 20 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="PDF must be between 1 byte and 20 MB")
    selected_pages: list[int] | None = None
    pages_value = pages if isinstance(pages, str) else None
    if pages_value is not None:
        try:
            from pypdf import PdfReader

            page_count = len(PdfReader(BytesIO(content)).pages)
            selected_pages = _parse_page_selection(pages_value, page_count)
        except ValueError as error:
            raise HTTPException(status_code=400, detail="Invalid selected PDF pages") from error
        except Exception as error:
            raise HTTPException(status_code=422, detail="Docling could not parse this PDF") from error
    try:
        response = await run_in_threadpool(convert_pdf, filename, content, selected_pages)
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
    return response


def _safe_log_filename(filename: Any) -> str:
    if type(filename) is not str:
        return "document.pdf"
    path_like = filename.replace("\\", "/")
    path_like = re.sub(r"[\x00-\x1f\x7f]+", "/", path_like)
    basename = path_like.rsplit("/", 1)[-1]
    sanitized = re.sub(r"[^A-Za-z0-9._ -]", "_", basename).strip(" .")
    return (sanitized or "document.pdf")[:128]
