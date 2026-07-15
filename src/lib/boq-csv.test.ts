import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBoqCsv } from './boq-csv'
import type { Boq, BoqItem } from './boq-schema'

function boqWith(items: Array<Partial<BoqItem>>): Boq {
  return {
    id: 'boq-1',
    project: 'Test',
    vendor: 'Vendor',
    workType: 'Structural',
    date: '2026-07-15',
    totalItems: items.length,
    grandTotal: 10,
    status: 'draft',
    stdStatus: 'none',
    sections: [{
      header: 'Items',
      items: items.map((item) => ({
        desc: 'Concrete', unit: 'm3', qty: 1, rate: 10, total: 10,
        type: 'unit', stdStatus: 'unmatched', ...item,
      } as BoqItem)),
    }],
    createdAt: '',
    updatedAt: '',
  }
}

test('code-less runtime items export without a Code column or exception', () => {
  const csv = buildBoqCsv(boqWith([{}]))
  assert.equal(csv.split('\n')[0], '"Description","Unit","Qty","Rate","Total"')
  assert.doesNotMatch(csv, /Code/)
})

test('legacy codes add the Code column and preserve blank sibling cells', () => {
  const csv = buildBoqCsv(boqWith([{ code: 'A-1' }, { desc: 'Labour' }]))
  const lines = csv.split('\n')
  assert.equal(lines[0], '"Code","Description","Unit","Qty","Rate","Total"')
  assert.match(lines[1], /^"A-1",/)
  assert.match(lines[2], /^"",/)
})

test('text cells that could execute as spreadsheet formulas are neutralized before quoting', () => {
  const csv = buildBoqCsv(boqWith([
    { code: '=cmd', desc: '+SUM(A1:A2)', unit: '-1', },
    { code: '@legacy', desc: '\tformula', unit: '\rformula' },
  ]))
  const lines = csv.split('\n')
  assert.match(lines[1], /^"'=cmd","'\+SUM\(A1:A2\)","'-1",/)
  assert.match(lines[2], /^"'@legacy","'\tformula","'\rformula",/)
})

test('CSV still escapes embedded quotes after formula neutralization', () => {
  const csv = buildBoqCsv(boqWith([{ desc: '=say "hello"' }]))
  assert.match(csv, /"'=say ""hello"""/)
})
