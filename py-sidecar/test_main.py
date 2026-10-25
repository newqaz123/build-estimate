import asyncio
import io
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import UploadFile

from boq_contract import SourceRow

import main


class FakePage:
    def __init__(self, page_no):
        self.page_no = page_no


class FakeTable:
    table_no: int | None
    self_ref: str | None

    def __init__(self, page_no):
        self.prov = [FakePage(page_no)]
        self.data = SimpleNamespace(
            table_cells=[],
            num_rows=0,
            num_cols=0,
        )
        # Optional Docling identity fields assigned by tests.
        self.table_no = None
        self.self_ref = None

    def export_to_dataframe(self, doc):
        import pandas as pd

        return pd.DataFrame(columns=['Description'])


class FakeDocument:
    def __init__(self, pages):
        self.pages = [object() for _ in pages]
        self.tables = [FakeTable(page) for page in pages]

    def export_to_text(self, page_break_placeholder):
        return ''


class SelectedPageTests(unittest.TestCase):
    def test_parse_pdf_rejects_duplicate_and_unavailable_pages_before_conversion(self):
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            main._parse_page_selection('[2, 2]', page_count=4)
        with self.assertRaisesRegex(ValueError, 'between 1 and 4'):
            main._parse_page_selection('[5]', page_count=4)

    def test_parse_endpoint_passes_confirmed_pages_to_conversion(self):
        from pypdf import PdfWriter

        pdf = io.BytesIO()
        writer = PdfWriter()
        for _ in range(4):
            writer.add_blank_page(width=100, height=100)
        writer.write(pdf)
        converted = SimpleNamespace(sourceRows=[SimpleNamespace(page=2), SimpleNamespace(page=4)])
        with patch.object(main, 'convert_pdf', return_value=converted) as convert:
            result = asyncio.run(main.parse_pdf(
                UploadFile(filename='source.pdf', file=io.BytesIO(pdf.getvalue())),
                pages='[2,4]',
            ))
        convert.assert_called_once()
        self.assertEqual(convert.call_args.args[2], [2, 4])
        self.assertEqual({row.page for row in result.sourceRows}, {2, 4})

    def test_build_parse_response_maps_filtered_pages_to_original_numbers(self):
        document = FakeDocument([1, 2])
        with patch.object(main, 'build_source_rows', side_effect=lambda tables, document: [
            SourceRow(
                id=f"row-{table['page']}", page=table['page'], table=table['table'], row=(4 if table['page'] == 2 else 8),
                section=None, headers=[], rawCells=[], rawText='', classification='unknown',
                confidence=1.0, warnings=[],
            ).model_dump()
            for table in tables
        ]), \
             patch.object(main, 'extract_boq_document', return_value={
                 'metadata': {
                     'vendor': {'value': '', 'confidence': 0, 'source': ''},
                     'project': {'value': '', 'confidence': 0, 'source': ''},
                     'date': {'value': '', 'confidence': 0, 'source': ''},
                     'workType': {'value': 'Unclassified', 'confidence': 0, 'source': ''},
                 },
                 'warnings': [],
                 'sourceTotal': None,
             }), \
             patch.object(main, 'derive_document', side_effect=lambda rows: {
                 'sourceRows': rows, 'sections': [], 'warnings': [], 'sourceTotal': None,
                 'sourceQuoteSummary': None,
             }):
            response = main.build_parse_response(
                'source.pdf', document, original_page_map=[2, 4], original_page_count=4,
            )
        self.assertEqual(response.pageCount, 4)
        self.assertEqual({(row.page, row.table, row.row) for row in response.sourceRows}, {(2, 1, 4), (4, 1, 8)})

    def test_build_parse_response_preserves_deterministic_source_quote_summary(self):
        document = FakeDocument([])
        source_row = SourceRow(
            id="row-1", page=1, table=1, row=1,
            section=None, headers=[], rawCells=[], rawText="",
            classification="unknown", confidence=1.0, warnings=[],
        ).model_dump()
        summary = {
            "directWorkTotal": "100",
            "overheadProfitAmount": "20",
            "quotedSubtotal": "120",
            "overheadProfitSourceRef": {"page": 1, "table": 1, "row": 1},
            "subtotalSourceRef": {"page": 1, "table": 1, "row": 1},
        }
        item = {
            "id": "item-1", "desc": "Direct work", "pricingRole": "standard",
            "sourceRowIds": ["row-1"], "entryOrigin": "docling",
            "costComponent": "lump_sum", "unit": "L/S",
            "qty": 1.0, "rate": 100.0, "total": 100.0,
        }
        with patch.object(main, 'build_source_rows', return_value=[source_row]), \
             patch.object(main, 'extract_boq_document', return_value={
                 'metadata': {
                     'vendor': {'value': '', 'confidence': 0, 'source': ''},
                     'project': {'value': '', 'confidence': 0, 'source': ''},
                     'date': {'value': '', 'confidence': 0, 'source': ''},
                     'workType': {'value': 'Unclassified', 'confidence': 0, 'source': ''},
                 },
                 'warnings': [], 'sourceTotal': None,
             }), \
             patch.object(main, 'derive_document', return_value={
                 'sourceRows': [source_row],
                 'sections': [{'header': 'Works', 'items': [item]}],
                 'warnings': [], 'sourceTotal': 120.0,
                 'sourceQuoteSummary': summary,
             }):
            response = main.build_parse_response('source.pdf', document)

        self.assertIsNotNone(response.sourceQuoteSummary)
        source_quote_summary = response.sourceQuoteSummary
        if source_quote_summary is None:
            self.fail("sourceQuoteSummary was not preserved")
        self.assertEqual(
            source_quote_summary.model_dump(exclude_none=True), summary
        )
        self.assertEqual(response.reconciliation.itemTotal, 100.0)
        self.assertTrue(response.reconciliation.reconciled)

    def test_build_parse_response_preserves_exact_summary_across_rounded_legacy_total(self):
        document = FakeDocument([])
        source_row = SourceRow(
            id="row-1", page=1, table=1, row=1,
            section=None, headers=[], rawCells=[], rawText="",
            classification="unknown", confidence=1.0, warnings=[],
        ).model_dump()
        direct = 9007199254740992.0
        quoted = "9007199254740993"
        legacy_source_total = float(quoted)
        summary = {
            "directWorkTotal": "9007199254740992",
            "overheadProfitAmount": "1",
            "quotedSubtotal": quoted,
            "overheadProfitSourceRef": {"page": 1, "table": 1, "row": 1},
            "subtotalSourceRef": {"page": 1, "table": 1, "row": 1},
        }
        item = {
            "id": "item-1", "desc": "Direct work", "pricingRole": "standard",
            "sourceRowIds": ["row-1"], "entryOrigin": "docling",
            "costComponent": "lump_sum", "unit": "L/S",
            "qty": 1.0, "rate": direct, "total": direct,
        }
        with patch.object(main, 'build_source_rows', return_value=[source_row]), \
             patch.object(main, 'extract_boq_document', return_value={
                 'metadata': {
                     'vendor': {'value': '', 'confidence': 0, 'source': ''},
                     'project': {'value': '', 'confidence': 0, 'source': ''},
                     'date': {'value': '', 'confidence': 0, 'source': ''},
                     'workType': {'value': 'Unclassified', 'confidence': 0, 'source': ''},
                 },
                 'warnings': [], 'sourceTotal': None,
             }), \
             patch.object(main, 'derive_document', return_value={
                 'sourceRows': [source_row],
                 'sections': [{'header': 'Works', 'items': [item]}],
                 'warnings': [], 'sourceTotal': legacy_source_total,
                 'sourceQuoteSummary': summary,
             }):
            response = main.build_parse_response('source.pdf', document)

        self.assertEqual(response.sourceTotal, legacy_source_total)
        self.assertIsNotNone(response.sourceQuoteSummary)
        source_quote_summary = response.sourceQuoteSummary
        if source_quote_summary is None:
            self.fail("sourceQuoteSummary was not preserved")
        self.assertEqual(source_quote_summary.quotedSubtotal, quoted)
        self.assertTrue(response.reconciliation.reconciled)

    def test_build_parse_response_keeps_docling_table_identity_when_exposed(self):
        document = FakeDocument([1, 2])
        document.tables[0].table_no = 9
        document.tables[1].self_ref = '#/tables/10'
        with patch.object(main, 'build_source_rows', side_effect=lambda tables, document: [
            SourceRow(
                id=f"row-{table['page']}", page=table['page'], table=table['table'], row=1,
                section=None, headers=[], rawCells=[], rawText='', classification='unknown',
                confidence=1.0, warnings=[],
            ).model_dump()
            for table in tables
        ]), \
             patch.object(main, 'extract_boq_document', return_value={
                 'metadata': {
                     'vendor': {'value': '', 'confidence': 0, 'source': ''},
                     'project': {'value': '', 'confidence': 0, 'source': ''},
                     'date': {'value': '', 'confidence': 0, 'source': ''},
                     'workType': {'value': 'Unclassified', 'confidence': 0, 'source': ''},
                 },
                 'warnings': [], 'sourceTotal': None,
             }), \
             patch.object(main, 'derive_document', side_effect=lambda rows: {
                 'sourceRows': rows, 'sections': [], 'warnings': [], 'sourceTotal': None,
                 'sourceQuoteSummary': None,
             }):
            response = main.build_parse_response('source.pdf', document, original_page_map=[2, 4], original_page_count=4)
        self.assertEqual([(row.page, row.table) for row in response.sourceRows], [(2, 9), (4, 11)])


class ConverterFallbackTests(unittest.TestCase):
    def test_ocr_dependency_errors_are_detected(self):
        self.assertTrue(main._is_ocr_dependency_error(ImportError('tesserocr is not correctly installed')))
        self.assertTrue(main._is_ocr_dependency_error(ImportError('Please install Tesseract OCR engine')))
        self.assertFalse(main._is_ocr_dependency_error(ImportError('docling is missing')))

    def test_convert_pdf_falls_back_to_no_ocr_when_tesseract_missing(self):
        from pypdf import PdfWriter

        pdf = io.BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        writer.write(pdf)
        content = pdf.getvalue()

        class FakeConverter:
            def __init__(self, do_ocr):
                self.do_ocr = do_ocr
                self.calls = 0

            def convert(self, source, max_num_pages=500, max_file_size=20 * 1024 * 1024):
                self.calls += 1
                if self.do_ocr:
                    raise ImportError('tesserocr is not correctly installed. Please install it via `pip install tesserocr`')
                return SimpleNamespace(document=FakeDocument([1]))

        ocr_converter = FakeConverter(True)
        plain_converter = FakeConverter(False)

        def fake_get_converter(do_ocr=True):
            return ocr_converter if do_ocr else plain_converter

        with patch.object(main, 'get_converter', side_effect=fake_get_converter), \
             patch.object(main, 'normalise_pdf', side_effect=lambda data: SimpleNamespace(
                 content=data, warnings=[], scanned_pages=[1], pages=[])), \
             patch.object(main, 'build_parse_response', return_value={'ok': True}) as build:
            result = main.convert_pdf('blank.pdf', content, None)

        self.assertEqual(result, {'ok': True})
        self.assertEqual(ocr_converter.calls, 1)
        self.assertEqual(plain_converter.calls, 1)
        build.assert_called_once()
        warnings = build.call_args.kwargs['extra_warnings']
        self.assertEqual([warning['code'] for warning in warnings], ['ocr_unavailable'])
        self.assertIn('RapidOCR', warnings[0]['message'])

    def test_convert_pdf_forwards_normaliser_warning_and_skips_ocr(self):
        from pypdf import PdfWriter

        pdf = io.BytesIO()
        writer = PdfWriter()
        writer.add_blank_page(width=100, height=100)
        writer.write(pdf)
        content = pdf.getvalue()
        requested: list[bool] = []

        class FakeConverter:
            def convert(self, source, max_num_pages=500, max_file_size=20 * 1024 * 1024):
                return SimpleNamespace(document=FakeDocument([1]))

        def fake_get_converter(do_ocr=True):
            requested.append(do_ocr)
            return FakeConverter()

        warning = {'code': 'ocr_unavailable', 'message': 'OCR is not available, so scanned page(s) 1 could not be read.'}
        with patch.object(main, 'get_converter', side_effect=fake_get_converter), \
             patch.object(main, 'normalise_pdf', side_effect=lambda data: SimpleNamespace(
                 content=data, warnings=[warning], scanned_pages=[1], pages=[])), \
             patch.object(main, 'build_parse_response', return_value={'ok': True}) as build:
            main.convert_pdf('scan.pdf', content, None)
        self.assertEqual(requested, [False])
        self.assertEqual(build.call_args.kwargs['extra_warnings'], [warning])

    def test_ocr_unavailable_warning_reaches_parse_response(self):
        document = FakeDocument([])
        warning = {'code': 'ocr_unavailable', 'message': 'OCR is not available.'}
        response = main.build_parse_response('scan.pdf', document, extra_warnings=[warning])
        self.assertEqual([item.code for item in response.warnings][:1], ['ocr_unavailable'])

    def test_document_text_prefers_embedded_text_layer_per_page(self):
        class TextDocument(FakeDocument):
            def export_to_text(self, page_break_placeholder):
                return page_break_placeholder.join(['ล ำ ดั บ split', 'OCR page two'])

        text = main._document_text(TextDocument([]), ['ลำดับ รายการ จำนวนเงิน 12,550.00', ''])
        self.assertEqual(text.split('\n\f\n'), ['ลำดับ รายการ จำนวนเงิน 12,550.00', 'OCR page two'])


if __name__ == '__main__':
    unittest.main()
