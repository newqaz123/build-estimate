import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from boq_parser import extract_boq_document, extract_boq_sections, parse_number


class BoqParserTest(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
