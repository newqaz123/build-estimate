import asyncio
import math
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from boq_parser import extract_boq_document, extract_boq_sections, extract_metadata, parse_number


class BoqParserTest(unittest.TestCase):
    def test_extracts_eastern_group_metadata(self):
        text = """EASTERN GROUP E.T.G. CO., LTD
QUOTATION NO.: ETG.2026/AYT074
DATE: 4 June 2026
ON-OFF VALVE INSTALLATION WORK FOR BDN PROCESS"""

        metadata = extract_metadata(text, ["ON-OFF VALVE INSTALLATION WORK FOR BDN PROCESS"])

        self.assertEqual(metadata["vendor"]["value"], "EASTERN GROUP E.T.G. CO., LTD")
        self.assertEqual(metadata["project"]["value"], "ON-OFF VALVE INSTALLATION WORK FOR BDN PROCESS")
        self.assertEqual(metadata["date"]["value"], "2026-06-04")
        self.assertEqual(metadata["workType"]["value"], "MEP")
        for field in ("vendor", "project", "date", "workType"):
            self.assertEqual(set(metadata[field]), {"value", "confidence", "source"})

    def test_prefers_labeled_contractor_project_and_doc_date(self):
        text = """TO: SIAM SUGAR COMPANY LIMITED
CONTRACTOR: SURASAK ENGINEERING CO., LTD.
Project: Sugar Dissolving Building
Doc. Date: 18/06/2026
Install submersible pump"""

        metadata = extract_metadata(text, ["Install submersible pump"])

        self.assertEqual(metadata["vendor"]["value"], "SURASAK ENGINEERING CO., LTD.")
        self.assertEqual(metadata["project"]["value"], "Sugar Dissolving Building")
        self.assertEqual(metadata["date"]["value"], "2026-06-18")
        self.assertEqual(metadata["workType"]["value"], "MEP")

    def test_extracts_subject_and_two_digit_date_without_using_customer_as_vendor(self):
        text = """N.P. CIVIL CONSTRUCTION CO., LTD.
Customer: Eastern Industrial Estate
Subject: Slab concrete and steel grating works
DATE: 7/6/26"""

        metadata = extract_metadata(text, [])

        self.assertEqual(metadata["vendor"]["value"], "N.P. CIVIL CONSTRUCTION CO., LTD.")
        self.assertEqual(metadata["project"]["value"], "Slab concrete and steel grating works")
        self.assertEqual(metadata["date"]["value"], "2026-06-07")
        self.assertEqual(metadata["workType"]["value"], "Structural")

    def test_unlabeled_seller_header_skips_to_line_without_colon(self):
        text = """TO SIAM SUGAR COMPANY LIMITED
EASTERN GROUP E.T.G. CO., LTD
Subject: Electrical installation"""

        metadata = extract_metadata(text, [])

        self.assertEqual(metadata["vendor"]["value"], "EASTERN GROUP E.T.G. CO., LTD")

    def test_unknown_work_type_is_unclassified_with_low_confidence(self):
        metadata = extract_metadata("CONTRACTOR: Example Co.\nProject: General preliminaries", [])

        self.assertEqual(metadata["workType"]["value"], "Unclassified")
        self.assertLess(metadata["workType"]["confidence"], 0.5)

    def test_work_type_uses_subject_instead_of_contractor_boilerplate(self):
        metadata = extract_metadata(
            "CONTRACTOR: N.P. CIVIL CONSTRUCTION CO., LTD.\nSubject: Interior painting",
            [],
        )

        self.assertEqual(metadata["workType"]["value"], "Finishing")

    def test_document_result_includes_metadata_warnings_and_pre_vat_source_total(self):
        rows = [
            ["ITEM", "DESCRIPTION", "UNIT", "Q'TY", "RATE", "AMOUNT"],
            ["A", "A. Piping Works", "", "", "", ""],
            ["1", "Install valve", "set", "2", "100", "200"],
            ["2", "Provisional electrical allowance", "", "", "TBC", ""],
            ["", "SUB TOTAL", "", "", "", "200"],
            ["", "VAT 7%", "", "", "", "14"],
            ["", "GRAND TOTAL", "", "", "", "214"],
        ]
        text = "CONTRACTOR: Example MEP Co., Ltd.\nProject: Valve installation\nDATE: 04/06/2026"

        result = extract_boq_document([{"page": 3, "rows": rows}], text)

        self.assertTrue({"metadata", "sourceTotal", "warnings"}.issubset(result))
        self.assertEqual(result["metadata"]["project"]["value"], "Valve installation")
        self.assertEqual(result["sourceTotal"], 200.0)
        self.assertEqual(result["warnings"][0]["code"], "unparsed_row")
        self.assertEqual(result["warnings"][0]["sourceRef"], {"page": 3, "table": 1, "row": 4})

    def test_uses_etg_total_before_vat_as_source_total(self):
        rows = [
            ["ITEM", "DESCRIPTION", "UNIT", "Q'TY", "RATE", "AMOUNT"],
            ["1", "Install on-off valve", "set", "2", "1,500", "3,000"],
            ["", "TOTAL BEFORE VAT", "", "", "", "3,000"],
            ["", "VAT 7%", "", "", "", "210"],
            ["", "GRAND TOTAL", "", "", "", "3,210"],
        ]

        result = extract_boq_document([{"page": 1, "rows": rows}], "EASTERN GROUP E.T.G. CO., LTD")

        self.assertEqual(result["sourceTotal"], 3000.0)

    def test_aggregates_multiple_section_subtotals(self):
        tables = [
            {
                "page": 1,
                "rows": [
                    ["DESCRIPTION", "AMOUNT"],
                    ["Concrete work", "100.00"],
                    ["SUB TOTAL", "100.00"],
                ],
            },
            {
                "page": 2,
                "rows": [
                    ["DESCRIPTION", "AMOUNT"],
                    ["Steel work", "200.00"],
                    ["SUB TOTAL", "200.00"],
                ],
            },
        ]

        result = extract_boq_document(tables, "")

        self.assertEqual(result["sourceTotal"], 300.0)

    def test_source_total_preserves_subtotals_when_one_section_item_is_unparsed(self):
        tables = [
            {
                "page": 1,
                "rows": [
                    ["ITEM", "DESCRIPTION", "UNIT", "Q'TY", "MATERIAL", "TOTAL", "LABOUR", "TOTAL", "AMOUNT"],
                    ["1", "Unparsed priced concrete work", "", "", "100.00", "", "", "", ""],
                    ["", "SUB TOTAL", "", "", "", "", "", "", "100.00"],
                ],
            },
            {
                "page": 2,
                "rows": [
                    ["DESCRIPTION", "AMOUNT"],
                    ["Steel work", "200.00"],
                    ["SUB TOTAL", "200.00"],
                ],
            },
        ]

        result = extract_boq_document(tables, "")

        self.assertEqual(
            sum(item["total"] for section in result["sections"] for item in section["items"]),
            200.0,
        )
        self.assertEqual(result["sourceTotal"], 300.0)

    def test_final_overall_subtotal_is_not_double_counted(self):
        tables = [
            {
                "page": 1,
                "rows": [
                    ["ITEM", "DESCRIPTION", "UNIT", "Q'TY", "MATERIAL", "TOTAL", "LABOUR", "TOTAL", "AMOUNT"],
                    ["1", "Unparsed priced concrete work", "", "", "100.00", "", "", "", ""],
                    ["", "SUB TOTAL", "", "", "", "", "", "", "100.00"],
                ],
            },
            {
                "page": 2,
                "rows": [
                    ["DESCRIPTION", "AMOUNT"],
                    ["Steel work", "200.00"],
                    ["SUB TOTAL", "200.00"],
                    ["SUB TOTAL", "300.00"],
                ],
            },
        ]

        result = extract_boq_document(tables, "")

        self.assertEqual(result["sourceTotal"], 300.0)

    def test_equal_independent_section_subtotals_are_aggregated(self):
        rows = [
            ["ITEM", "DESCRIPTION", "UNIT", "Q'TY", "RATE", "AMOUNT"],
            ["A", "SECTION A", "", "", "", ""],
            ["1", "Concrete work", "L/S", "1", "100.00", "100.00"],
            ["", "SUB TOTAL", "", "", "", "100.00"],
            ["B", "SECTION B", "", "", "", ""],
            ["2", "Steel work", "L/S", "1", "100.00", "100.00"],
            ["", "SUB TOTAL", "", "", "", "100.00"],
        ]

        result = extract_boq_document([{"page": 1, "rows": rows}], "")

        self.assertEqual(result["sourceTotal"], 200.0)

    def test_splits_distinct_material_and_labour_components(self):
        rows = [
            ["NO.", "DESCRIPTION", "MATERIAL COST", "", "", "LABOUR COST", "", "", "AMOUNT"],
            ["", "", "Q'TY", "UNIT", "TOTAL", "Q'TY", "UNIT", "TOTAL", ""],
            ["2", "90 ELBOW 1B BS1", "36 Pcs.", "41.00", "1,476.00", "72 Db.", "260.00", "18,720.00", "20,196.00"],
        ]

        result = extract_boq_document([{"page": 1, "rows": rows}], "")
        items = result["sections"][0]["items"]

        self.assertEqual(
            [(item["costComponent"], item["unit"], item["qty"], item["rate"], item["total"]) for item in items],
            [
                ("material", "Pcs.", 36.0, 41.0, 1476.0),
                ("labour", "Db.", 72.0, 260.0, 18720.0),
            ],
        )

    def test_combines_shared_quantity_material_and_labour_rates(self):
        rows = [
            ["ITEM", "DESCRIPTION", "UNIT", "Q'TY", "MATERIAL", "TOTAL", "LABOUR", "TOTAL", "AMOUNT"],
            ["", "Slab concrete T =150 mm", "m2", "61.00", "1,080.00", "65,880.00", "520.00", "31,720.00", "97,600.00"],
        ]

        item = extract_boq_document([{"page": 2, "rows": rows}], "")["sections"][0]["items"][0]

        self.assertEqual(
            (item["unit"], item["qty"], item["rate"], item["total"], item["costComponent"]),
            ("m2", 61.0, 1600.0, 97600.0, "combined"),
        )
        self.assertRegex(item["id"], re.compile(r"^[0-9a-f]{32}$"))
        self.assertEqual(item["sourceRef"], {"page": 2, "table": 1, "row": 2})
        self.assertNotIn("code", item)

    def test_section_headings_label_items_and_summary_rows_are_excluded(self):
        rows = [
            ["ITEM", "DESCRIPTION", "UNIT", "Q'TY", "RATE", "AMOUNT"],
            ["A", "A. Piping Works", "", "", "", ""],
            ["", "Detail", "", "", "", ""],
            ["1", "Install valve", "set", "2", "100", "200"],
            ["", "SUB TOTAL", "", "", "", "200"],
            ["", "VAT 7%", "", "", "", "14"],
            ["", "DISCOUNT", "", "", "", "5"],
            ["", "GRAND TOTAL", "", "", "", "209"],
            ["", "BAHT: TWO HUNDRED AND NINE ONLY", "", "", "", ""],
        ]

        sections = extract_boq_document([{"page": 4, "rows": rows}], "")["sections"]

        self.assertEqual([section["header"] for section in sections], ["A. Piping Works"])
        self.assertEqual([item["desc"] for item in sections[0]["items"]], ["Install valve"])

    def test_emits_a_single_present_component(self):
        rows = [
            ["ITEM", "DESCRIPTION", "UNIT", "Q'TY", "MATERIAL", "TOTAL", "LABOUR", "TOTAL", "AMOUNT"],
            ["", "Concrete topping", "m2", "10", "50", "500", "", "", "500"],
        ]

        items = extract_boq_document([{"page": 1, "rows": rows}], "")["sections"][0]["items"]

        self.assertEqual(len(items), 1)
        self.assertEqual(
            (items[0]["costComponent"], items[0]["unit"], items[0]["qty"], items[0]["rate"], items[0]["total"]),
            ("material", "m2", 10.0, 50.0, 500.0),
        )

    def test_amount_only_rows_become_lump_sums(self):
        rows = [
            ["DESCRIPTION", "AMOUNT"],
            ["Mobilization", "25,000.00"],
        ]

        item = extract_boq_document([{"page": 3, "rows": rows}], "")["sections"][0]["items"][0]

        self.assertEqual(
            (item["unit"], item["qty"], item["rate"], item["total"], item["type"], item["costComponent"]),
            ("L/S", 1.0, 25000.0, 25000.0, "lump_sum", "lump_sum"),
        )

    def test_surasak_amount_only_quote_becomes_lump_sum(self):
        rows = [
            ["No.", "Description", "Amount"],
            ["1", "Install submersible pump at sugar dissolving building.", "258,000.00"],
        ]

        item = extract_boq_document([{"page": 1, "rows": rows}], "")["sections"][0]["items"][0]

        self.assertEqual(
            (item["unit"], item["qty"], item["rate"], item["total"], item["type"]),
            ("L/S", 1.0, 258000.0, 258000.0, "lump_sum"),
        )

    def test_sole_lump_sum_description_is_used_as_project_fallback(self):
        rows = [
            ["No.", "Description", "Amount"],
            ["1", "Install submersible pump at sugar dissolving building.", "258,000.00"],
        ]

        metadata = extract_boq_document([{"page": 1, "rows": rows}], "SURASAK ENGINEERING")["metadata"]

        self.assertEqual(
            metadata["project"]["value"],
            "Install submersible pump at sugar dissolving building.",
        )

    def test_ambiguous_unpriced_rows_do_not_become_items(self):
        rows = [
            ["ITEM", "DESCRIPTION", "UNIT", "Q'TY", "RATE", "AMOUNT"],
            ["1", "Awaiting quotation", "", "", "", ""],
        ]

        self.assertEqual(extract_boq_document([{"page": 1, "rows": rows}], "")["sections"], [])

    def test_component_prices_without_quantity_and_unit_are_ambiguous(self):
        rows = [
            ["ITEM", "DESCRIPTION", "UNIT", "Q'TY", "MATERIAL", "TOTAL", "LABOUR", "TOTAL", "AMOUNT"],
            ["1", "Incomplete component split", "", "", "100", "", "200", "", ""],
        ]

        self.assertEqual(extract_boq_document([{"page": 1, "rows": rows}], "")["sections"], [])

    def test_compact_vat_summary_row_is_excluded(self):
        rows = [
            ["DESCRIPTION", "AMOUNT"],
            ["VAT7%", "7,000.00"],
        ]

        self.assertEqual(extract_boq_document([{"page": 1, "rows": rows}], "")["sections"], [])

    def test_common_summary_label_variants_are_excluded(self):
        for label in ("SUB-TOTAL", "LESS DISCOUNT", "ADD VAT 7%"):
            with self.subTest(label=label):
                rows = [
                    ["DESCRIPTION", "AMOUNT"],
                    [label, "7,000.00"],
                ]

                self.assertEqual(extract_boq_document([{"page": 1, "rows": rows}], "")["sections"], [])

    def test_detects_header_after_three_title_and_scope_rows(self):
        rows = [
            ["EASTERN GROUP E.T.G. CO., LTD"],
            ["QUOTATION NO.: ETG.2026/AYT074"],
            ["ON-OFF VALVE INSTALLATION WORK FOR BDN PROCESS"],
            ["ITEM", "DESCRIPTION", "UNIT", "Q'TY", "RATE", "AMOUNT"],
            ["1", "Install on-off valve", "set", "2", "1,500", "3,000"],
        ]

        sections = extract_boq_document([{"page": 1, "rows": rows}], "")["sections"]
        self.assertTrue(sections)
        item = sections[0]["items"][0]

        self.assertEqual((item["desc"], item["unit"], item["qty"], item["rate"], item["total"]),
                         ("Install on-off valve", "set", 2.0, 1500.0, 3000.0))
        self.assertEqual(item["sourceRef"]["row"], 5)

    def test_parse_number_handles_currency_and_parenthesized_negatives(self):
        self.assertEqual(parse_number("฿ 1,234.50"), 1234.5)
        self.assertEqual(parse_number("(250.00)"), -250.0)
        self.assertEqual(parse_number("-"), 0.0)

    def test_extracts_real_boq_rows_from_common_headers(self):
        tables = [[
            ["Item No.", "Description of Works", "Unit", "Quantity", "Unit Rate", "Amount"],
            ["A.1", "Ready-mix concrete C30", "m3", "12.5", "4,000", "50,000"],
            ["A.2", "Reinforcement steel", "kg", "1,200", "85", "102,000"],
        ]]

        sections = extract_boq_sections(tables)

        self.assertEqual(len(sections), 1)
        self.assertEqual(sections[0]["items"][0]["code"], "A.1")
        self.assertEqual(sections[0]["items"][0]["desc"], "Ready-mix concrete C30")
        self.assertEqual(sections[0]["items"][0]["qty"], 12.5)
        self.assertEqual(sections[0]["items"][0]["rate"], 4000.0)
        self.assertEqual(sections[0]["items"][1]["total"], 102000.0)

    def test_skips_totals_and_rejects_documents_without_boq_rows(self):
        tables = [[
            ["Description", "Unit", "Qty", "Rate", "Total"],
            ["GRAND TOTAL", "", "", "", "152,000"],
        ]]

        self.assertEqual(extract_boq_sections(tables), [])


class SidecarContractTest(unittest.TestCase):
    def _import_main(self):
        try:
            import main
        except ModuleNotFoundError as error:
            if error.name in {"fastapi", "pydantic", "multipart"}:
                self.skipTest(f"optional sidecar dependency is unavailable: {error.name}")
            raise
        return main

    def test_builds_versioned_response_from_docling_v2_exports(self):
        main = self._import_main()
        build_parse_response = getattr(main, "build_parse_response", None)
        self.assertIsNotNone(build_parse_response, "build_parse_response must be implemented")

        class Values:
            def __init__(self, rows):
                self._rows = rows

            def tolist(self):
                return self._rows

        class Frame:
            columns = ["Description", "Amount"]
            values = Values([["Install valve", "2,500.00"]])

            def fillna(self, _value):
                return self

        class Provenance:
            page_no = 2

        class Table:
            prov = [Provenance()]

            def __init__(self):
                self.exported_with = None

            def export_to_dataframe(self, doc):
                self.exported_with = doc
                return Frame()

        class Document:
            def __init__(self):
                self.tables = [Table()]
                self.pages = {1: object(), 2: object()}
                self.placeholder = None

            def export_to_text(self, page_break_placeholder):
                self.placeholder = page_break_placeholder
                return "CONTRACTOR: Example Co., Ltd.\nProject: Valve work\nDATE: 4 June 2026\n\f\nPage 2"

        document = Document()
        response = build_parse_response("quote.pdf", document)
        payload = response.model_dump() if hasattr(response, "model_dump") else response.dict()

        self.assertEqual(document.placeholder, "\n\f\n")
        self.assertIs(document.tables[0].exported_with, document)
        self.assertEqual(payload["contractVersion"], 2)
        self.assertEqual(payload["documentName"], "quote.pdf")
        self.assertEqual(payload["pageCount"], 2)
        self.assertEqual(payload["tables"][0]["page"], 2)
        self.assertEqual(payload["tables"][0]["table"], 1)
        self.assertEqual(payload["tables"][0]["rows"][1], ["Install valve", "2,500.00"])
        self.assertEqual(payload["metadata"]["workType"]["value"], "MEP")
        self.assertEqual(payload["totalItems"], 1)

    def test_models_reject_non_finite_numbers_and_invalid_confidence(self):
        main = self._import_main()
        item_fields = {
            "id": "item-1",
            "desc": "Concrete",
            "unit": "m3",
            "rate": 1.0,
            "total": 1.0,
            "type": "unit",
            "costComponent": "combined",
            "sourceRef": {"page": 1, "table": 1, "row": 2},
        }

        for invalid in (math.nan, math.inf, -math.inf):
            with self.subTest(number=invalid):
                with self.assertRaises(Exception):
                    main.Item(qty=invalid, **item_fields)
        for invalid in (-0.1, 1.1, math.inf):
            with self.subTest(confidence=invalid):
                with self.assertRaises(Exception):
                    main.MetadataField(value="value", confidence=invalid, source="test")

    def test_models_reject_unknown_work_type_and_incomplete_source_reference(self):
        main = self._import_main()

        with self.assertRaises(Exception):
            main.Metadata(
                vendor={"value": "Vendor", "confidence": 1, "source": "test"},
                project={"value": "Project", "confidence": 1, "source": "test"},
                date={"value": "2026-06-04", "confidence": 1, "source": "test"},
                workType={"value": "Roofing", "confidence": 1, "source": "test"},
            )
        with self.assertRaises(Exception):
            main.Item(
                id="item-1",
                desc="Concrete",
                unit="m3",
                qty=1,
                rate=1,
                total=1,
                type="unit",
                costComponent="combined",
                sourceRef={"page": 1, "table": 1},
            )

    def test_parse_error_is_logged_but_not_leaked_to_client(self):
        main = self._import_main()

        class Upload:
            filename = "quote.pdf"

            async def read(self):
                return b"%PDF-1.7"

        async def fail_conversion(*_args):
            raise RuntimeError("sensitive converter detail")

        with self.assertLogs("docling_sidecar", level="ERROR") as captured:
            with patch.object(main, "run_in_threadpool", fail_conversion):
                with self.assertRaises(main.HTTPException) as raised:
                    asyncio.run(main.parse_pdf(Upload()))

        self.assertEqual(raised.exception.detail, "Docling could not parse this PDF")
        self.assertIn("sensitive converter detail", "\n".join(captured.output))


if __name__ == "__main__":
    unittest.main()
