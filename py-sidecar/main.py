import logging
from functools import lru_cache
from io import BytesIO
from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
from typing import Annotated, Any, List, Literal, Optional
from pydantic import BaseModel, Field, FiniteFloat, PositiveInt

from boq_parser import extract_boq_document

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
    code: Optional[str] = None
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


def build_parse_response(filename: str, document: Any) -> ParseResponse:
    document_text = document.export_to_text(page_break_placeholder="\n\f\n")
    tables: list[dict[str, Any]] = []
    for index, table in enumerate(document.tables, start=1):
        frame = table.export_to_dataframe(doc=document).fillna("")
        page = table.prov[0].page_no if table.prov else 1
        tables.append({
            "page": page,
            "table": index,
            "rows": [list(frame.columns), *frame.values.tolist()],
        })
    normalized = extract_boq_document(tables, document_text)
    total_items = sum(len(section["items"]) for section in normalized["sections"])
    return ParseResponse(
        contractVersion=2,
        documentName=filename,
        pageCount=len(document.pages),
        documentText=document_text,
        tables=tables,
        totalItems=total_items,
        **normalized,
    )


def convert_pdf(filename: str, content: bytes):
    from docling.datamodel.base_models import DocumentStream

    source = DocumentStream(name=filename, stream=BytesIO(content))
    result = get_converter().convert(source, max_num_pages=500, max_file_size=20 * 1024 * 1024)
    return build_parse_response(filename, result.document)


@app.post("/parse", response_model=ParseResponse)
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
        logger.exception("Docling conversion failed for %s", filename)
        raise HTTPException(status_code=422, detail="Docling could not parse this PDF") from error
    if not response.sections:
        raise HTTPException(status_code=422, detail="No BOQ line-item tables were found in this PDF")
    return response
