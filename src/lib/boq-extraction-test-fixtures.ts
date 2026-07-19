export function v3Fixture(): Record<string, unknown> {
  const sourceRows = [
    sourceRow('row-1', 1, 1, 1, 'Pump package | 95200'),
    sourceRow('row-2', 1, 1, 2, 'Pump body'),
    sourceRow('row-3', 1, 1, 3, 'Optional controls | 10000', 'option'),
    sourceRow('row-4', 1, 1, 4, 'Combined work | 100'),
  ]
  return {
    contractVersion: 3,
    documentName: 'compound.pdf',
    pageCount: 1,
    documentText: 'quotation evidence',
    sourceRows,
    sections: [{
      header: 'Pump Works',
      items: [
        pricedItem('bundle', ['row-1'], { pricingRole: 'bundle_parent', total: 95_200, rate: 95_200 }),
        {
          id: 'pump-body', desc: 'Pump body', pricingRole: 'bundle_child',
          sourceRowIds: ['row-2'], parentBundleId: 'bundle', entryOrigin: 'docling',
        },
        pricedItem('option', ['row-3'], {
          desc: 'Optional controls', total: 10_000, rate: 10_000,
          optional: true, excludedFromTotal: true, exclusionReason: 'Source option',
        }),
        pricedItem('combined', ['row-4'], {
          desc: 'Combined work', total: 100, rate: 100, sourceCosts: {
            material: { qty: 1, unit: 'set', rate: 40, total: 40 },
            labour: { qty: 1, unit: 'set', rate: 60, total: 60 },
          },
        }),
      ],
    }],
    metadata: {
      vendor: { value: 'Vendor', confidence: 0.9, source: 'header' },
      project: { value: 'Project', confidence: 0.8, source: 'header' },
      date: { value: '2026-07-19', confidence: 0.7, source: 'header' },
      workType: { value: 'MEP', confidence: 0.95, source: 'keywords' },
    },
    warnings: [{
      code: 'review_option', message: 'Review optional row',
      sourceRef: { page: 1, table: 1, row: 3 },
    }],
    sourceTotal: 95_300,
    reconciliation: { itemTotal: 95_300, sourceTotal: 95_300, reconciled: true, difference: 0 },
    totalItems: 3,
  }
}

function sourceRow(
  id: string,
  page: number,
  table: number,
  row: number,
  rawText: string,
  classification = 'item',
) {
  return {
    id, page, table, row, section: 'Pump Works', headers: ['Description'],
    rawCells: [{
      column: 0, rawText, lines: rawText.split('\n'), rowSpan: 1, columnSpan: 1,
      startRowOffset: row - 1, endRowOffset: row,
      startColumnOffset: 0, endColumnOffset: 1,
      columnHeader: false, rowHeader: false, rowSection: false, carried: false,
    }],
    rawText, classification, confidence: 0.95, warnings: [],
  }
}

function pricedItem(id: string, sourceRowIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    id, desc: 'Pump package', pricingRole: 'standard', sourceRowIds,
    parentBundleId: null, optional: false, excludedFromTotal: false,
    exclusionReason: null, entryOrigin: 'docling', costComponent: 'combined',
    sourceCosts: null, unit: 'set', qty: 1, rate: 95_200, total: 95_200,
    ...overrides,
  }
}
