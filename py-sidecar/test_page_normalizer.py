import io
import unittest

from PIL import Image, ImageDraw
from pypdf import PdfReader

import page_normalizer as pn


def blank_pdf(pages: int = 1) -> bytes:
    """Image-only PDF (like a scan): one bitmap per page, no text layer."""
    images = []
    for _ in range(pages):
        image = Image.new("RGB", (200, 300), "white")
        ImageDraw.Draw(image).rectangle([20, 40, 180, 44], fill="black")
        images.append(image)
    output = io.BytesIO()
    images[0].save(output, format="PDF", save_all=True, append_images=images[1:], resolution=72)
    return output.getvalue()


class FakeEngine:
    """Tall boxes (text running vertically) that read best after a 270° turn."""

    def __init__(self, best_rotation_size=None):
        self.best_rotation_size = best_rotation_size

    def detect(self, image):
        return [[(10, 10), (20, 10), (20, 120), (10, 120)] for _ in range(5)]

    def recognise_score(self, image):
        # The rendered page is portrait (200x300 pt); after a 90° turn either
        # way it becomes landscape. Score the landscape image upright only when
        # the caller rotated by 270 (PIL CCW), which we detect via a marker.
        return (5, 0.98) if getattr(image, "_marker", None) == 270 else (5, 0.7)


class RotationLogicTests(unittest.TestCase):
    def test_text_axis_from_box_shapes(self):
        wide = [[(0, 0), (100, 0), (100, 10), (0, 10)]] * 4
        tall = [[(0, 0), (10, 0), (10, 100), (0, 100)]] * 4
        self.assertEqual(pn.text_axis_and_skew(wide)[0], "horizontal")
        self.assertEqual(pn.text_axis_and_skew(tall)[0], "vertical")
        self.assertIsNone(pn.text_axis_and_skew([])[0])

    def test_choose_rotation_accepts_confident_first_candidate(self):
        self.assertEqual(pn.choose_rotation("horizontal", lambda r: 0.97 if r == 0 else 0.99), 0)

    def test_choose_rotation_compares_when_first_is_weak(self):
        self.assertEqual(pn.choose_rotation("horizontal", lambda r: 0.6 if r == 0 else 0.95), 180)
        self.assertEqual(pn.choose_rotation("vertical", lambda r: 0.7 if r == 270 else 0.96), 90)

    def test_estimate_skew_recovers_synthetic_ruled_page(self):
        image = Image.new("L", (800, 600), 255)
        draw = ImageDraw.Draw(image)
        for y in range(60, 560, 40):
            draw.rectangle([40, y, 760, y + 3], fill=0)
        tilted = image.rotate(1.5, fillcolor=255)
        correction = pn.estimate_skew(tilted)
        self.assertAlmostEqual(correction, -1.5, delta=0.25)
        self.assertEqual(pn.estimate_skew(image), 0.0)


class NormalisePdfTests(unittest.TestCase):
    def test_ocr_unavailable_returns_original_bytes_with_warning(self):
        content = blank_pdf(2)

        def broken():
            raise ImportError("No module named 'rapidocr'")

        result = pn.normalise_pdf(content, engine_factory=broken)
        self.assertEqual(result.content, content)
        self.assertEqual(result.scanned_pages, [1, 2])
        self.assertEqual([w["code"] for w in result.warnings], ["ocr_unavailable"])
        self.assertIn("1, 2", result.warnings[0]["message"])
        self.assertIn("rapidocr", result.warnings[0]["message"])

    def test_rotated_scan_gets_page_rotation_without_rasterising(self):
        content = blank_pdf(1)
        original = pn.analyse_page_image
        try:
            pn.analyse_page_image = lambda image, engine: (270, 0.0)
            result = pn.normalise_pdf(content, engine_factory=FakeEngine)
        finally:
            pn.analyse_page_image = original
        self.assertEqual(result.warnings, [])
        page = PdfReader(io.BytesIO(result.content)).pages[0]
        # PIL 270° counter-clockwise == PDF /Rotate 90 (clockwise).
        self.assertEqual(page.rotation, 90)
        self.assertEqual(result.pages[0].rotation, 270)

    def test_skewed_scan_gets_content_transform(self):
        content = blank_pdf(1)
        original = pn.analyse_page_image
        try:
            pn.analyse_page_image = lambda image, engine: (0, -0.7)
            result = pn.normalise_pdf(content, engine_factory=FakeEngine)
        finally:
            pn.analyse_page_image = original
        page = PdfReader(io.BytesIO(result.content)).pages[0]
        self.assertEqual(page.rotation, 0)
        self.assertIn(b" cm", page.get_contents().get_data())

    def test_upright_scan_is_returned_unchanged(self):
        content = blank_pdf(1)
        original = pn.analyse_page_image
        try:
            pn.analyse_page_image = lambda image, engine: (0, 0.0)
            result = pn.normalise_pdf(content, engine_factory=FakeEngine)
        finally:
            pn.analyse_page_image = original
        self.assertEqual(result.content, content)
        self.assertTrue(result.pages[0].ocr_checked)

    def test_analyse_page_image_uses_detection_axis_and_scores(self):
        engine = FakeEngine()
        image = Image.new("RGB", (200, 300), "white")

        class Marked:
            pass

        original_rotate = Image.Image.rotate

        def marking_rotate(self, angle, *args, **kwargs):
            rotated = original_rotate(self, angle, *args, **kwargs)
            rotated._marker = angle
            return rotated

        Image.Image.rotate = marking_rotate
        try:
            rotation, skew = pn.analyse_page_image(image, engine)
        finally:
            Image.Image.rotate = original_rotate
        self.assertEqual(rotation, 270)
        self.assertEqual(skew, 0.0)


if __name__ == "__main__":
    unittest.main()
