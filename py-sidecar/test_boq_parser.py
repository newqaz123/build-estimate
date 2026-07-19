import asyncio
import math
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from boq_parser import extract_boq_document, extract_boq_sections, extract_metadata, parse_number
from boq_contract import DerivedItemV3, ParseResponseV3, RawCell, SourceRow
from boq_source_rows import build_source_rows


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

    def test_normalizes_actual_eastern_four_column_cost_groups_and_header_metadata(self):
        rows = [
            [
                "TO.", "Mr. Somboon AJINOMOTO CO., (THAILAND) LTD.", "", "", "", "",
                "QUOTATION NO. DATE DELIVERY TO", "", "", "",
                ": ETG.2026/AYT001_1 : 11 June 2026 : AJINOMOTO E&M",
            ],
            [
                "NO.", "DESCRIPTION", "MATERIAL COST", "MATERIAL COST", "MATERIAL COST",
                "MATERIAL COST", "LABOUR COST", "LABOUR COST", "LABOUR COST", "LABOUR COST",
                "AMOUNT",
            ],
            [
                "NO.", "DESCRIPTION", "Q'TY", "Q'TY", "UNIT", "TOTAL", "Q'TY", "Q'TY",
                "UNIT", "TOTAL", "AMOUNT",
            ],
            [
                "", "PUMPS, POTS AND PIPE INSTALLATION WORK FOR TOC 4200 (MAT' FOR 3 SETs)",
                "PUMPS, POTS AND PIPE INSTALLATION WORK FOR TOC 4200 (MAT' FOR 3 SETs)",
                "PUMPS, POTS AND PIPE INSTALLATION WORK FOR TOC 4200 (MAT' FOR 3 SETs)",
                "PUMPS, POTS AND PIPE INSTALLATION WORK FOR TOC 4200 (MAT' FOR 3 SETs)",
                "PUMPS, POTS AND PIPE INSTALLATION WORK FOR TOC 4200 (MAT' FOR 3 SETs)",
                "PUMPS, POTS AND PIPE INSTALLATION WORK FOR TOC 4200 (MAT' FOR 3 SETs)",
                "PUMPS, POTS AND PIPE INSTALLATION WORK FOR TOC 4200 (MAT' FOR 3 SETs)",
                "", "", "",
            ],
            ["1", "PIPE 1B BS1 L=6000", "3", "Pcs.", "1,781.00", "5,343.00", "", "", "", "", "5,343.00"],
            ["2", "90 ELBOW 1B BS1", "36", "Pcs.", "41.00", "1,476.00", "72", "Db.", "260.00", "18,720.00", "20,196.00"],
            ["", "", "", "", "", "", "", "", "SUB TOTAL", "SUB TOTAL", "25,539.00"],
        ]
        text = """EASTERN GROUP E.T.G. CO., LTD
| QUOTATION NO. DATE DELIVERY TO | : ETG.2026/AYT001_1 : 11 June 2026 : AJINOMOTO E&M |
PUMPS, POTS AND PIPE INSTALLATION WORK FOR TOC 4200 (MAT' FOR 3 SETs)"""

        result = extract_boq_document([{"page": 1, "rows": rows}], text)
        items = [item for section in result["sections"] for item in section["items"]]

        self.assertEqual(
            [(item["costComponent"], item["unit"], item["qty"], item["rate"], item["total"]) for item in items],
            [
                ("material", "Pcs.", 3.0, 1781.0, 5343.0),
                ("material", "Pcs.", 36.0, 41.0, 1476.0),
                ("labour", "Db.", 72.0, 260.0, 18720.0),
            ],
        )
        self.assertEqual(result["metadata"]["project"]["value"], "PUMPS, POTS AND PIPE INSTALLATION WORK FOR TOC 4200 (MAT' FOR 3 SETs)")
        self.assertEqual(result["metadata"]["date"]["value"], "2026-06-11")
        self.assertEqual(result["sourceTotal"], 25539.0)

    def test_normalizes_actual_surasak_single_row_cost_header(self):
        rows = [
            [
                "No. Description", "Jeds.Material", "Q'ty.", "Unit.",
                "Material cost.Unit/Price", "Material cost.Total/Price",
                "Labour cost.Unit/Price", "Labour cost.Total/Price", "Total Price.",
            ],
            ["Modify stage floor", "", "", "", "", "", "", "", ""],
            ["L-50x50x5t x6000L", "SS400", "1.0", "pcs.", "730.00", "730.00", "", "", "730.00"],
            ["Fabrication&Installation", "SS400", "1.0", "lot.", "1,500.00", "1,500.00", "12,000.00", "12,000.00", "13,500.00"],
            ["BallValve 2Bx 10K(Existing)", "", "1.0", "pcs.", "", "", "500.00", "500.00", "500.00"],
            ["GRAND TOTAL", "", "", "", "", "", "", "", "47,000.00"],
        ]
        text = """SURASAK ENGINEERING CO.,LTD.
Subject : MODIFY STAGE FLOOR & PIPE 4% NaOH FOR GH DISS TANK AT H4 PROCESS.
Date :15 Jan 2026
This price excluded vat 7%"""

        result = extract_boq_document([{"page": 2, "rows": rows}], text)
        items = [item for section in result["sections"] for item in section["items"]]

        self.assertEqual(
            [(item["desc"], item["unit"], item["qty"], item["rate"], item["total"], item["costComponent"]) for item in items],
            [
                ("L-50x50x5t x6000L", "pcs.", 1.0, 730.0, 730.0, "material"),
                ("Fabrication&Installation", "lot.", 1.0, 13500.0, 13500.0, "combined"),
                ("BallValve 2Bx 10K(Existing)", "pcs.", 1.0, 500.0, 500.0, "labour"),
            ],
        )
        self.assertEqual(result["metadata"]["project"]["value"], "MODIFY STAGE FLOOR & PIPE 4% NaOH FOR GH DISS TANK AT H4 PROCESS.")
        self.assertEqual(result["metadata"]["date"]["value"], "2026-01-15")
        self.assertEqual(result["sourceTotal"], 47000.0)

    def test_infers_blank_shared_unit_header_from_populated_surasak_unit_column(self):
        rows = [
            [
                "Description", "Spac.Material", "Q'ty", "",
                "Material cost.Unit/Price", "Material cost.Total/Price",
                "Labour cost.Unit/Price", "Labour cost.Total/Price", "Total Price.",
            ],
            ["Pipe3BxSch10", "SUS316L", "1.0", "m.", "1,650.00", "1,650.00", "", "-", "1,650.00"],
            ["Short PipeNpple 3Bx Sch10", "SUS316L", "1.0", "pcs.", "400.00", "400.00", "300.00", "300.00", "700.00"],
        ]

        items = extract_boq_document([{"page": 2, "rows": rows}], "")["sections"][0]["items"]

        self.assertEqual(
            [(item["desc"], item["unit"], item["qty"], item["rate"], item["total"], item["costComponent"]) for item in items],
            [
                ("Pipe3BxSch10", "m.", 1.0, 1650.0, 1650.0, "material"),
                ("Short PipeNpple 3Bx Sch10", "pcs.", 1.0, 700.0, 700.0, "combined"),
            ],
        )

    def test_bare_material_specification_column_does_not_override_shared_quantity(self):
        rows = [
            ["Description", "Qty", "Unit", "Material", "Material Unit Price", "Material Total"],
            ["Concrete", "10", "m2", "C30", "100", "1,000"],
        ]

        item = extract_boq_document([{"page": 1, "rows": rows}], "")["sections"][0]["items"][0]

        self.assertEqual(
            (item["desc"], item["unit"], item["qty"], item["rate"], item["total"], item["costComponent"]),
            ("Concrete", "m2", 10.0, 100.0, 1000.0, "material"),
        )

    def test_repeated_description_with_distinct_pricing_is_not_a_section(self):
        rows = [
            ["NO.", "DESCRIPTION", "MATERIAL COST", "MATERIAL COST", "MATERIAL COST", "MATERIAL COST", "LABOUR COST", "LABOUR COST", "LABOUR COST", "AMOUNT"],
            ["NO.", "DESCRIPTION", "Q'TY", "Q'TY", "UNIT", "TOTAL", "Q'TY", "UNIT", "TOTAL", "AMOUNT"],
            ["", "ON-OFF VALVE INSTALLATION WORK FOR BDN PROCESS", "ON-OFF VALVE INSTALLATION WORK FOR BDN PROCESS", "ON-OFF VALVE INSTALLATION WORK FOR BDN PROCESS", "ON-OFF VALVE INSTALLATION WORK FOR BDN PROCESS", "ON-OFF VALVE INSTALLATION WORK FOR BDN PROCESS", "", "", "", ""],
            ["6", "MANUAL VALVE RELOCATION WORK", "MANUAL VALVE RELOCATION WORK", "MANUAL VALVE RELOCATION WORK", "", "", "4 Lot", "1,500.00", "6,000.00", "6,000.00"],
        ]

        result = extract_boq_document([{"page": 1, "rows": rows}], "")
        items = [item for section in result["sections"] for item in section["items"]]

        self.assertEqual(
            [(item["desc"], item["unit"], item["qty"], item["rate"], item["total"], item["costComponent"]) for item in items],
            [("MANUAL VALVE RELOCATION WORK", "Lot", 4.0, 1500.0, 6000.0, "labour")],
        )

    def test_normalizes_actual_np_civil_headers_and_uses_pre_discount_total_for_reconciliation(self):
        rows = [
            [
                "ITEM.ITEM", "DESCRIPTION.DESCRIPTION", "UNIT.UNIT", "Q'TY.Q'TY",
                "UNIT COST.MATERIAL", "UNIT COST.TOTAL", "UNIT COST.LABOUR",
                "UNIT COST.TOTAL", "AMOUNT.AMOUNT", "Remark.Remark",
            ],
            ["A.1", "Concrete Biomass", "", "", "", "", "", "", "", "Slab"],
            ["", "Clearing Scarp & Adjust Leveling", "m2.", "61.00", "-", "-", "350.00", "21,350.00", "21,350.00", ""],
            ["", "Crushed stone & Compaction ( 150 mm )", "m2.", "61.00", "192.00", "11,712.00", "98.00", "5,978.00", "17,690.00", ""],
            ["SUB TOTAL", "SUB TOTAL", "SUB TOTAL", "SUB TOTAL", "", "", "", "", "231,440.00", ""],
            ["OVERHEAD & PROFIT", "OVERHEAD & PROFIT", "OVERHEAD & PROFIT", "OVERHEAD & PROFIT", "", "", "", "", "46,288.00", ""],
            ["TOTAL", "TOTAL", "TOTAL", "TOTAL", "", "", "", "", "277,728.00", ""],
            ["DISCOUNT", "DISCOUNT", "DISCOUNT", "DISCOUNT", "", "", "", "", "(728.00)", ""],
            ["GRAND TOTAL ( Exclude Vat. )", "GRAND TOTAL ( Exclude Vat. )", "GRAND TOTAL ( Exclude Vat. )", "GRAND TOTAL ( Exclude Vat. )", "", "", "", "", "277,000.00", ""],
        ]
        text = """No. : NP2C/AJI-AYT/GENERAL/202607003
CONTRACTOR : N.P.CIVIL AND CONSTRUCTION CO.,LTD.
PROJECT : Slab Concrete Biomass
10/7/26"""

        result = extract_boq_document([{"page": 2, "rows": rows}], text)
        items = [item for section in result["sections"] for item in section["items"]]

        self.assertEqual(
            [(item["desc"], item["unit"], item["qty"], item["rate"], item["total"], item["costComponent"]) for item in items],
            [
                ("Clearing Scarp & Adjust Leveling", "m2.", 61.0, 350.0, 21350.0, "labour"),
                ("Crushed stone & Compaction ( 150 mm )", "m2.", 61.0, 290.0, 17690.0, "combined"),
                ("OVERHEAD & PROFIT", "L/S", 1.0, 46288.0, 46288.0, "lump_sum"),
            ],
        )
        self.assertEqual(result["metadata"]["vendor"]["value"], "N.P.CIVIL AND CONSTRUCTION CO.,LTD.")
        self.assertEqual(result["metadata"]["project"]["value"], "Slab Concrete Biomass")
        self.assertEqual(result["metadata"]["date"]["value"], "2026-07-10")
        self.assertEqual(result["sourceTotal"], 277728.0)
        discount_warnings = [warning for warning in result["warnings"] if warning["code"] == "source_discount"]
        self.assertEqual(len(discount_warnings), 1)
        self.assertIn("728.00", discount_warnings[0]["message"])
        self.assertIn("277,000.00", discount_warnings[0]["message"])

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
        self.assertNotIn("code", sections[0]["items"][0])
        self.assertEqual(sections[0]["items"][0]["desc"], "Ready-mix concrete C30")
        self.assertEqual(sections[0]["items"][0]["qty"], 12.5)
        self.assertEqual(sections[0]["items"][0]["rate"], 4000.0)
        self.assertEqual(sections[0]["items"][1]["total"], 102000.0)

    def test_ayt001_style_source_numbers_are_provenance_only(self):
        rows = [
            ["ITEM", "DESCRIPTION", "MATERIAL", "", "", "LABOUR", "", "", "AMOUNT"],
            ["", "", "UNIT", "Q'TY", "RATE", "UNIT", "Q'TY", "RATE", ""],
            ["1", "PIPE 1B BS1 L=6000", "Pcs.", "3", "1,781", "Pcs.", "3", "250", "6,093"],
        ]

        item = extract_boq_document([{"page": 1, "rows": rows}], "")["sections"][0]["items"][0]

        self.assertNotIn("code", item)
        self.assertEqual(item["sourceRef"], {"page": 1, "table": 1, "row": 3})

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

        class Cell:
            def __init__(self, text, row, column, *, column_header=False):
                self.text = text
                self.start_row_offset_idx = row
                self.end_row_offset_idx = row + 1
                self.start_col_offset_idx = column
                self.end_col_offset_idx = column + 1
                self.row_span = 1
                self.col_span = 1
                self.column_header = column_header
                self.row_header = False
                self.row_section = False

        class Data:
            table_cells = [
                Cell("Description", 0, 0, column_header=True),
                Cell("Amount", 0, 1, column_header=True),
                Cell("Install valve", 1, 0),
                Cell("2,500.00", 1, 1),
            ]

        class Table:
            prov = [Provenance()]
            data = Data()

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
        self.assertEqual(payload["contractVersion"], 3)
        self.assertEqual(payload["documentName"], "quote.pdf")
        self.assertEqual(payload["pageCount"], 2)
        self.assertEqual(payload["sourceRows"][0]["page"], 2)
        self.assertEqual(payload["sourceRows"][0]["table"], 1)
        self.assertEqual(payload["sourceRows"][1]["rawText"], "Install valve | 2,500.00")
        self.assertEqual(payload["metadata"]["workType"]["value"], "MEP")
        self.assertEqual(payload["totalItems"], 1)
        self.assertTrue(all("code" not in item for section in payload["sections"] for item in section["items"]))

    def test_parse_endpoint_declares_v3_response_model(self):
        main = self._import_main()

        route = next(route for route in main.app.routes if getattr(route, "path", None) == "/parse")

        self.assertIs(route.response_model, ParseResponseV3)

    def test_versioned_item_contract_drops_legacy_source_code(self):
        main = self._import_main()
        item = main.Item(
            id="item-1",
            code="A.1",
            desc="Concrete",
            unit="m3",
            qty=1,
            rate=100,
            total=100,
            type="unit",
            costComponent="combined",
            sourceRef={"page": 1, "table": 1, "row": 2},
        )
        payload = item.model_dump() if hasattr(item, "model_dump") else item.dict()

        self.assertNotIn("code", payload)

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


class LosslessContractV3Test(unittest.TestCase):
    @staticmethod
    def _table(page=3, table=1, cells=None):
        return {"page": page, "table": table, "cells": cells or []}

    @staticmethod
    def _cell(text, row, column, **overrides):
        cell = {
            "text": text,
            "start_row_offset_idx": row,
            "end_row_offset_idx": row + 1,
            "start_col_offset_idx": column,
            "end_col_offset_idx": column + 1,
            "row_span": 1,
            "col_span": 1,
            "column_header": False,
            "row_header": False,
            "row_section": False,
        }
        cell.update(overrides)
        return cell

    def test_v3_preserves_multiline_spans_offsets_flags_and_location(self):
        rows = build_source_rows([self._table(cells=[
            self._cell("Description", 0, 0, column_header=True),
            self._cell(
                "Pump body\nLabour",
                1,
                0,
                row_span=2,
                col_span=3,
                end_row_offset_idx=3,
                end_col_offset_idx=3,
                row_header=True,
                row_section=True,
            ),
        ])])

        raw = rows[1]["rawCells"][0]
        self.assertEqual(raw["rawText"], "Pump body\nLabour")
        self.assertEqual(raw["lines"], ["Pump body", "Labour"])
        self.assertEqual((raw["rowSpan"], raw["columnSpan"]), (2, 3))
        self.assertEqual(
            (
                raw["startRowOffset"], raw["endRowOffset"],
                raw["startColumnOffset"], raw["endColumnOffset"],
            ),
            (1, 3, 0, 3),
        )
        self.assertEqual(
            (raw["columnHeader"], raw["rowHeader"], raw["rowSection"]),
            (False, True, True),
        )
        self.assertEqual((rows[1]["page"], rows[1]["table"], rows[1]["row"]), (3, 1, 2))
        self.assertEqual(rows[1]["confidence"], 1.0)

    def test_every_logical_row_is_retained_with_headers_and_current_section(self):
        rows = build_source_rows([self._table(cells=[
            self._cell("Description", 0, 0, column_header=True),
            self._cell("Amount", 0, 1, column_header=True),
            self._cell("Mechanical", 1, 0, row_section=True),
            self._cell("Pump", 2, 0),
            self._cell("100", 2, 1),
            self._cell("Unsupported note", 3, 0),
        ])])

        self.assertEqual([row["row"] for row in rows], [1, 2, 3, 4])
        self.assertEqual(rows[2]["headers"], ["Description", "Amount"])
        self.assertEqual(rows[2]["section"], "Mechanical")
        self.assertEqual(rows[0]["classification"], "header")
        self.assertEqual(rows[1]["classification"], "section")

    def test_source_row_ids_are_stable_and_duplicate_provenance_does_not_collide(self):
        table = self._table(cells=[
            self._cell("Description", 0, 0, column_header=True),
            self._cell("Pump", 1, 0),
        ])
        duplicate_location = self._table(cells=[
            self._cell("Description", 0, 0, column_header=True),
            self._cell("Valve", 1, 0),
        ])

        first = build_source_rows([table, duplicate_location])
        second = build_source_rows([table, duplicate_location])

        self.assertEqual([row["id"] for row in first], [row["id"] for row in second])
        self.assertEqual(len({row["id"] for row in first}), len(first))
        pump = next(row for row in first if row["rawText"] == "Pump")
        valve = next(row for row in first if row["rawText"] == "Valve")
        self.assertNotEqual(pump["id"], valve["id"])

    def test_duplicate_provenance_does_not_leak_header_context_between_tables(self):
        first_table = self._table(cells=[
            self._cell("Description", 0, 0, column_header=True),
            self._cell("Pump", 1, 0),
        ])
        duplicate_location = self._table(cells=[self._cell("Standalone note", 0, 0)])

        rows = build_source_rows([first_table, duplicate_location])

        self.assertEqual(rows[-1]["headers"], [])
        self.assertIsNone(rows[-1]["section"])

    def test_v3_models_reject_negative_nonfinite_and_invalid_confidence_or_enums(self):
        priced = {
            "id": "item-1",
            "desc": "Pump",
            "pricingRole": "standard",
            "sourceRowIds": ["row-1"],
            "unit": "set",
            "qty": 1.0,
            "rate": 100.0,
            "total": 100.0,
        }
        for field in ("qty", "rate", "total"):
            for invalid in (-1.0, math.nan, math.inf, -math.inf):
                with self.subTest(field=field, invalid=invalid):
                    with self.assertRaises(Exception):
                        DerivedItemV3(**{**priced, field: invalid})
        for invalid in (-0.1, 1.1, math.inf):
            with self.subTest(confidence=invalid):
                with self.assertRaises(Exception):
                    SourceRow(
                        id="row-1", page=1, table=1, row=1, headers=[], rawCells=[],
                        rawText="", classification="unknown", confidence=invalid, warnings=[],
                    )
        with self.assertRaises(Exception):
            SourceRow(
                id="row-1", page=1, table=1, row=1, headers=[], rawCells=[],
                rawText="", classification="invented", confidence=1.0, warnings=[],
            )
        with self.assertRaises(Exception):
            DerivedItemV3(**{**priced, "pricingRole": "invented"})

    def test_bundle_child_carries_no_priced_fields_and_priced_roles_are_complete(self):
        child = DerivedItemV3(
            id="child-1", desc="Pump body", pricingRole="bundle_child",
            sourceRowIds=["row-1"], parentBundleId="bundle-1",
        )
        self.assertIsNone(child.total)

        with self.assertRaises(Exception):
            DerivedItemV3(
                id="child-1", desc="Pump body", pricingRole="bundle_child",
                sourceRowIds=["row-1"], parentBundleId="bundle-1", total=0,
            )
        with self.assertRaises(Exception):
            DerivedItemV3(
                id="item-1", desc="Pump", pricingRole="standard", sourceRowIds=["row-1"],
            )

    def test_raw_cell_contract_rejects_invalid_spans_and_extra_fields(self):
        fields = {
            "column": 0,
            "rawText": "Pump",
            "lines": ["Pump"],
            "rowSpan": 1,
            "columnSpan": 1,
            "startRowOffset": 0,
            "endRowOffset": 1,
            "startColumnOffset": 0,
            "endColumnOffset": 1,
            "columnHeader": False,
            "rowHeader": False,
            "rowSection": False,
        }
        with self.assertRaises(Exception):
            RawCell(**{**fields, "rowSpan": 0})
        with self.assertRaises(Exception):
            RawCell(**{**fields, "unexpected": True})


if __name__ == "__main__":
    unittest.main()
