from fastapi import FastAPI, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from typing import List, Optional
from pydantic import BaseModel

app = FastAPI(title="Docling Sidecar", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

MOCK_SECTIONS = [
    {
        "header": "B.1 Concrete Works",
        "items": [
            {"code": "B.1.1", "desc": "Structural concrete grade 30", "unit": "m3", "qty": 120.0, "rate": 4500.0, "total": 540000.0, "type": "qty"},
            {"code": "B.1.2", "desc": "Reinforcement steel bar", "unit": "kg", "qty": 8500.0, "rate": 85.0, "total": 722500.0, "type": "qty"},
            {"code": "B.1.3", "desc": "Formwork to slab", "unit": "m2", "qty": 450.0, "rate": 320.0, "total": 144000.0, "type": "qty"},
        ],
    },
    {
        "header": "B.2 Rebar Works",
        "items": [
            {"code": "B.2.1", "desc": "Rebar grade 40", "unit": "kg", "qty": 12000.0, "rate": 78.0, "total": 936000.0, "type": "qty"},
            {"code": "B.2.2", "desc": "Rebar grade 60", "unit": "kg", "qty": 5400.0, "rate": 92.0, "total": 496800.0, "type": "qty"},
            {"code": "B.2.3", "desc": "Stirrups fabrication", "unit": "pcs", "qty": 2800.0, "rate": 45.0, "total": 126000.0, "type": "qty"},
        ],
    },
    {
        "header": "B.3 Formwork",
        "items": [
            {"code": "B.3.1", "desc": "Formwork to column", "unit": "m2", "qty": 180.0, "rate": 380.0, "total": 68400.0, "type": "qty"},
            {"code": "B.3.2", "desc": "Formwork to beam", "unit": "m2", "qty": 320.0, "rate": 350.0, "total": 112000.0, "type": "qty"},
            {"code": "B.3.3", "desc": "Formwork to wall", "unit": "m2", "qty": 260.0, "rate": 360.0, "total": 93600.0, "type": "qty"},
        ],
    },
]


class Item(BaseModel):
    code: str
    desc: str
    unit: str
    qty: float
    rate: float
    total: float
    type: str


class Section(BaseModel):
    header: str
    items: List[Item]


class ParseResponse(BaseModel):
    sections: List[Section]
    totalItems: int
    documentName: str


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/parse", response_model=ParseResponse)
async def parse_pdf(file: UploadFile = File(...)):
    total_items = sum(len(s["items"]) for s in MOCK_SECTIONS)
    return ParseResponse(
        sections=[Section(**s) for s in MOCK_SECTIONS],
        totalItems=total_items,
        documentName=file.filename or "document.pdf",
    )
