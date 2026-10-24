import assert from 'node:assert/strict'
import test from 'node:test'

import type { Boq } from './boq-schema'
import { summarizeBoqWorkspace } from './boq-workspace-summary'

type SummaryInput = Pick<Boq, 'totalItems' | 'vendor' | 'status'>

test('workspace summary counts every quote line, not just the newest quotes', () => {
  const boqs: SummaryInput[] = [
    { totalItems: 7, vendor: 'N.P.CIVIL AND CONSTRUCTION CO.,LTD.', status: 'draft' },
    { totalItems: 13, vendor: 'EASTERN GROUP E.T.G. CO., LTD', status: 'draft' },
    { totalItems: 5, vendor: '  eastern group  e.t.g. co., ltd ', status: 'approved' },
    { totalItems: 0, vendor: '', status: 'draft' },
    { totalItems: 2, vendor: 'Unknown Vendor', status: 'approved' },
    { totalItems: 1, vendor: 'QA Synth Vendor', status: 'approved' },
  ]

  assert.deepEqual(summarizeBoqWorkspace(boqs), {
    totalItems: 28,
    vendorCount: 3,
    unapprovedCount: 3,
  })
})

test('missing or invalid item counts never inflate or break the total', () => {
  const boqs: SummaryInput[] = [
    { totalItems: Number.NaN, vendor: 'A', status: 'draft' },
    { totalItems: -3, vendor: 'B', status: 'draft' },
    { totalItems: undefined as unknown as number, vendor: 'C', status: 'approved' },
    { totalItems: 4, vendor: 'D', status: 'parsed' },
  ]

  assert.deepEqual(summarizeBoqWorkspace(boqs), {
    totalItems: 4,
    vendorCount: 4,
    unapprovedCount: 3,
  })
})

test('an empty workspace has zero of everything', () => {
  assert.deepEqual(summarizeBoqWorkspace([]), { totalItems: 0, vendorCount: 0, unapprovedCount: 0 })
})
