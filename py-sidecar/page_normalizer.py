"""Scanned-page normalisation ahead of Docling.

Image-only pages (scans, print-to-PDF vector output) are analysed at low
resolution, then turned upright (/Rotate) and deskewed (content transform)
before Docling's layout/table/OCR pipeline sees them. Nothing is rasterised,
so Docling still renders the original vectors/images at its own resolution.
Pages that carry an embedded text layer are passed through untouched so their
digital text (including Thai) is never replaced by OCR.

Orientation uses the RapidOCR models Docling already ships with:
  1. text-line detection decides the text axis (wide boxes = horizontal lines);
  2. recognition confidence without the 180° line classifier picks the upright
     direction on that axis (upside-down text scores markedly lower).
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from io import BytesIO
from typing import Any, Callable, Protocol, Sequence

logger = logging.getLogger("docling_sidecar")

# Pages with fewer embedded characters than this are treated as image-only.
MIN_EMBEDDED_TEXT_CHARS = 20
DETECTION_DPI = 100
# Mean recognition confidence that accepts an orientation without comparing.
ACCEPT_ORIENTATION_SCORE = 0.9
MIN_SKEW_DEGREES = 0.3
MAX_SKEW_DEGREES = 5.0


class OcrEngine(Protocol):
    def detect(self, image: Any) -> list[list[tuple[float, float]]]: ...

    def recognise_score(self, image: Any) -> tuple[int, float]: ...


@dataclass
class PageNormalisation:
    page: int
    has_text_layer: bool
    rotation: int = 0
    skew: float = 0.0
    ocr_checked: bool = False


@dataclass
class NormalisationResult:
    content: bytes
    pages: list[PageNormalisation] = field(default_factory=list)
    warnings: list[dict[str, Any]] = field(default_factory=list)

    @property
    def scanned_pages(self) -> list[int]:
        return [page.page for page in self.pages if not page.has_text_layer]


def page_text_lengths(content: bytes) -> list[int]:
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(content)
    try:
        lengths: list[int] = []
        for index in range(len(pdf)):
            page = pdf[index]
            text = page.get_textpage().get_text_range()
            lengths.append(sum(1 for char in text if not char.isspace()))
        return lengths
    finally:
        pdf.close()


def page_texts(content: bytes) -> list[str]:
    """Embedded text per page via pdfium (keeps Thai combining marks intact)."""
    import pypdfium2 as pdfium

    pdf = pdfium.PdfDocument(content)
    try:
        return [pdf[index].get_textpage().get_text_range() for index in range(len(pdf))]
    finally:
        pdf.close()


def line_box_geometry(box: Sequence[Sequence[float]]) -> tuple[float, float, float]:
    """Width, height and baseline angle (degrees) of a detected text quad."""
    (x0, y0), (x1, y1), _, (x3, y3) = box[:4]
    width = math.hypot(x1 - x0, y1 - y0)
    height = math.hypot(x3 - x0, y3 - y0)
    angle = math.degrees(math.atan2(y1 - y0, x1 - x0))
    return width, height, angle


def text_axis_and_skew(boxes: Sequence[Sequence[Sequence[float]]]) -> tuple[str | None, float]:
    """Return ('horizontal'|'vertical'|None, median skew of horizontal lines)."""
    wide = tall = 0
    angles: list[float] = []
    for box in boxes:
        width, height, angle = line_box_geometry(box)
        if width >= 2 * height:
            wide += 1
            # Normalise to (-45, 45] so reversed quads do not flip the sign.
            while angle > 45:
                angle -= 180
            while angle <= -45:
                angle += 180
            angles.append(angle)
        elif height >= 2 * width:
            tall += 1
    if wide == 0 and tall == 0:
        return None, 0.0
    axis = "horizontal" if wide >= tall else "vertical"
    if axis == "vertical" or not angles:
        return axis, 0.0
    angles.sort()
    middle = len(angles) // 2
    skew = angles[middle] if len(angles) % 2 else (angles[middle - 1] + angles[middle]) / 2
    return axis, skew


def choose_rotation(
    axis: str | None,
    score_for: Callable[[int], float],
) -> int:
    """Counter-clockwise rotation (PIL convention) that makes text upright."""
    if axis is None:
        return 0
    candidates = (0, 180) if axis == "horizontal" else (270, 90)
    first = score_for(candidates[0])
    if first >= ACCEPT_ORIENTATION_SCORE:
        return candidates[0]
    second = score_for(candidates[1])
    return candidates[1] if second > first else candidates[0]


class RapidOcrEngine:
    """Thin wrapper over RapidOCR using the torch backend Docling installs."""

    def __init__(self) -> None:
        from rapidocr import RapidOCR
        from rapidocr.utils.typings import EngineType

        self._engine = RapidOCR(params={
            "Det.engine_type": EngineType.TORCH,
            "Cls.engine_type": EngineType.TORCH,
            "Rec.engine_type": EngineType.TORCH,
            "Global.log_level": "warning",
        })

    def detect(self, image: Any) -> list[list[tuple[float, float]]]:
        import numpy as np

        result = self._engine(np.array(image), use_det=True, use_cls=False, use_rec=False)
        boxes = getattr(result, "boxes", None)
        return [] if boxes is None else [[(float(x), float(y)) for x, y in box] for box in boxes]

    def recognise_score(self, image: Any) -> tuple[int, float]:
        import numpy as np

        result = self._engine(np.array(image), use_det=True, use_cls=False, use_rec=True)
        scores = list(getattr(result, "scores", None) or [])
        if not scores:
            return 0, 0.0
        return len(scores), float(sum(scores) / len(scores))


_ENGINE: RapidOcrEngine | None = None


def get_ocr_engine() -> RapidOcrEngine:
    global _ENGINE
    if _ENGINE is None:
        _ENGINE = RapidOcrEngine()
    return _ENGINE


def ocr_available() -> tuple[bool, str | None]:
    try:
        import rapidocr  # noqa: F401
        import torch  # noqa: F401
    except ImportError as error:
        return False, f"{type(error).__name__}: {error}"
    return True, None


def _render(pdf: Any, index: int, dpi: int) -> Any:
    return pdf[index].render(scale=dpi / 72).to_pil().convert("RGB")


def analyse_page_image(image: Any, engine: OcrEngine) -> tuple[int, float]:
    """Rotation (CCW degrees) and residual skew for a low-resolution render."""
    axis, _ = text_axis_and_skew(engine.detect(image))

    def score_for(rotation: int) -> float:
        rotated = image.rotate(rotation, expand=True) if rotation else image
        return engine.recognise_score(rotated)[1]

    rotation = choose_rotation(axis, score_for)
    if axis is None:
        return rotation, 0.0
    upright = image.rotate(rotation, expand=True) if rotation else image
    skew = estimate_skew(upright)
    if abs(skew) < MIN_SKEW_DEGREES:
        skew = 0.0
    return rotation, skew


def _profile_score(gray: Any, angle: float) -> float:
    import numpy as np

    rotated = gray.rotate(angle, fillcolor=255) if angle else gray
    ink = 255.0 - np.asarray(rotated, dtype=float)
    return float(np.var(ink.sum(axis=1)))


def estimate_skew(image: Any) -> float:
    """CCW correction angle (PIL convention) that maximises row-profile sharpness.

    Text baselines and ruled table lines give the sharpest horizontal
    projection profile when level. Coarse-to-fine search keeps it cheap.
    """
    gray = image.convert("L")
    best = 0.0
    best_score = _profile_score(gray, 0.0)
    for step, span in ((0.5, MAX_SKEW_DEGREES), (0.1, 0.5)):
        centre = best
        steps = int(round(span / step))
        for offset in range(-steps, steps + 1):
            angle = round(centre + offset * step, 2)
            if angle == centre or abs(angle) > MAX_SKEW_DEGREES:
                continue
            score = _profile_score(gray, angle)
            if score > best_score * 1.0001:
                best, best_score = angle, score
    return best


def normalise_pdf(
    content: bytes,
    *,
    engine_factory: Callable[[], OcrEngine] | None = None,
) -> NormalisationResult:
    """Return a PDF whose image-only pages are upright and deskewed.

    Orientation is applied with /Rotate and skew with a content transform, so
    nothing is rasterised and Docling still renders at its own resolution.

    Pages with an embedded text layer are copied unchanged. When OCR is not
    available the original bytes are returned with an ``ocr_unavailable``
    warning naming the image-only pages that cannot be read.
    """
    import pypdfium2 as pdfium
    from pypdf import PdfReader, PdfWriter

    lengths = page_text_lengths(content)
    pages = [
        PageNormalisation(page=index + 1, has_text_layer=length >= MIN_EMBEDDED_TEXT_CHARS)
        for index, length in enumerate(lengths)
    ]
    result = NormalisationResult(content=content, pages=pages)
    scanned = result.scanned_pages
    if not scanned:
        return result

    available, reason = (True, None) if engine_factory is not None else ocr_available()
    engine: OcrEngine | None = None
    if available:
        try:
            engine = (engine_factory or get_ocr_engine)()
        except Exception as error:  # model download/initialisation failure
            available, reason = False, f"{type(error).__name__}: {error}"
    if not available or engine is None:
        result.warnings.append({
            "code": "ocr_unavailable",
            "message": (
                "OCR is not available, so scanned page(s) "
                f"{', '.join(str(page) for page in scanned)} could not be read. "
                "Install the sidecar requirements (RapidOCR + torch) and retry. "
                f"Detail: {reason}"
            ),
        })
        return result

    pdf = pdfium.PdfDocument(content)
    try:
        for info in pages:
            if info.has_text_layer:
                continue
            preview = _render(pdf, info.page - 1, DETECTION_DPI)
            info.rotation, info.skew = analyse_page_image(preview, engine)
            info.ocr_checked = True
    finally:
        pdf.close()

    if not any(info.rotation or info.skew for info in pages):
        return result
    reader = PdfReader(BytesIO(content))
    writer = PdfWriter()
    for info, page in zip(pages, reader.pages):
        if info.skew:
            _deskew_page(page, info.skew)
        if info.rotation:
            # PIL angles are counter-clockwise; PDF /Rotate is clockwise.
            page.rotate((360 - info.rotation) % 360)
        writer.add_page(page)
        if info.rotation or info.skew:
            logger.info("normalised page %s rotation=%s skew=%.2f", info.page, info.rotation, info.skew)
    output = BytesIO()
    writer.write(output)
    result.content = output.getvalue()
    return result


def _deskew_page(page: Any, angle: float) -> None:
    """Rotate page content by a small angle about its centre (lossless).

    The angle uses the rendered (visual) counter-clockwise convention. A
    rotation is a rotation in any page frame, so /Rotate does not change its
    visual direction.
    """
    from pypdf import Transformation

    box = page.mediabox
    cx = (float(box.left) + float(box.right)) / 2
    cy = (float(box.bottom) + float(box.top)) / 2
    page.add_transformation(
        Transformation().translate(-cx, -cy).rotate(angle).translate(cx, cy)
    )

