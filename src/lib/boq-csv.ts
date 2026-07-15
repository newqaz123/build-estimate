import type { Boq } from './boq-schema'

function csvCell(value: string | number): string {
  return `"${String(value).replace(/"/g, '""')}"`
}

export function buildBoqCsv(boq: Pick<Boq, 'sections'>): string {
  const items = boq.sections.flatMap((section) => section.items)
  const includeCode = items.some((item) => (item.code ?? '').trim().length > 0)
  const headers = [...(includeCode ? ['Code'] : []), 'Description', 'Unit', 'Qty', 'Rate', 'Total']
  const rows = items.map((item) => [
    ...(includeCode ? [item.code ?? ''] : []),
    item.desc,
    item.unit,
    item.qty,
    item.rate,
    item.total,
  ])
  return [headers, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')
}
