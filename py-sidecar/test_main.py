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
    def __init__(self, page_no):
        self.prov = [FakePage(page_no)]
        self.data = SimpleNamespace(
            table_cells=[],
            num_rows=0,
            num_cols=0,
        )

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
             }):
            response = main.build_parse_response(
                'source.pdf', document, original_page_map=[2, 4], original_page_count=4,
            )
        self.assertEqual(response.pageCount, 4)
        self.assertEqual({(row.page, row.table, row.row) for row in response.sourceRows}, {(2, 1, 4), (4, 1, 8)})
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
             }):
            response = main.build_parse_response('source.pdf', document, original_page_map=[2, 4], original_page_count=4)
        self.assertEqual([(row.page, row.table) for row in response.sourceRows], [(2, 9), (4, 11)])


if __name__ == '__main__':
    unittest.main()
