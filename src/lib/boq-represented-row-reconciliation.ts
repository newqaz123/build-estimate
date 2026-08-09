import type { ExtractionProposalAudit } from './boq-extraction-acceptance'
import type { BoqSourceRowV3, DoclingRawCellV3 } from './boq-extraction-schema'
import {
  fingerprintCanonicalItem,
  type ValidatedProposal,
} from './boq-extraction-proposals'
import type { Boq, BoqItem, BoqPricedItem, BoqSourceRef } from './boq-schema'
import type { RowRoleFinding } from './boq-row-role-classifier'
import {
  equalAtMinorUnit,
  parseDecimalString,
  type DecimalString,
} from './decimal-string'
import { canonicalUnit, normalizeCatalogText } from './standard-matching'

export interface RepresentedRowFinding {
  sourceRowIds: string[]
  boqItemId: string
  reason: 'source_identity' | 'accepted_audit' | 'normalized_identity' | 'continuation'
  sourceRefs: BoqSourceRef[]
}

type RepresentationReason = RepresentedRowFinding['reason']

interface Claim {
  sourceRowId: string
  boqItemId: string
  reason: RepresentationReason
}

interface RowIdentity {
  description: string
  unit: string
  quantity: DecimalString
  rate: DecimalString
  total: DecimalString
  code?: string
}

const STRICT_AMOUNT = /^(?:([A-Z]{3}|[$£¥฿€])\s*)?(\()?((?:0|[1-9]\d*|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)(\))?(?:\s*([A-Z]{3}))?$/

function isPricedItem(item: BoqItem): item is BoqPricedItem {
  return item.pricingRole !== 'bundle_child'
    && typeof (item as BoqPricedItem).unit === 'string'
    && typeof (item as BoqPricedItem).qty === 'number'
    && typeof (item as BoqPricedItem).rate === 'number'
    && typeof (item as BoqPricedItem).total === 'number'
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function itemSourceRowIds(item: BoqItem): string[] {
  if (Array.isArray(item.sourceRowIds) && item.sourceRowIds.length > 0) {
    return item.sourceRowIds.filter(nonBlank)
  }
  if (nonBlank(item.sourceRowId)) return [item.sourceRowId]
  return []
}

function sourceRefOf(row: BoqSourceRowV3): BoqSourceRef {
  return { page: row.page, table: row.table, row: row.row }
}

function normalizeLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/\./g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
}

function parseAmountCell(text: string): DecimalString | null {
  const match = STRICT_AMOUNT.exec(text.trim())
  if (!match) return null
  if ((match[1] !== undefined && match[5] !== undefined) || Boolean(match[2]) !== Boolean(match[4])) {
    return null
  }
  if (match[2]) return null
  try {
    return parseDecimalString(match[3]!.replaceAll(',', ''))
  } catch {
    return null
  }
}

/**
 * Convert a finite non-negative JS number into a canonical DecimalString when
 * the round-trip is exact. Never invents values from free-form text.
 */
function decimalFromNumber(value: number): DecimalString | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  if (Object.is(value, -0) || value === 0) return '0'

  const text = value.toString().toLowerCase()
  if (text.includes('e')) {
    const [mantissaRaw, expRaw] = text.split('e')
    const exp = Number(expRaw)
    if (!Number.isInteger(exp) || mantissaRaw === undefined) return null
    const negativeExp = exp < 0
    const magnitude = Math.abs(exp)
    const mantissa = mantissaRaw
    const sign = mantissa.startsWith('-') ? '-' : ''
    const body = mantissa.replace(/^-/, '')
    const point = body.indexOf('.')
    const digits = body.replace('.', '')
    const frac = point === -1 ? 0 : body.length - point - 1
    if (negativeExp) {
      const scale = frac + magnitude
      const padded = digits.padStart(digits.length + magnitude, '0')
      const whole = padded.slice(0, padded.length - scale) || '0'
      const fraction = padded.slice(padded.length - scale)
      const candidate = fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`
      try {
        return parseDecimalString(candidate)
      } catch {
        return null
      }
    }
    const zeros = '0'.repeat(magnitude)
    const candidate = point === -1
      ? `${sign}${digits}${zeros}`
      : `${sign}${digits}${zeros}`.replace(
        new RegExp(`(\\d{${digits.length - frac + magnitude}})$`),
        '.$1',
      )
    try {
      // Prefer constructing via integer shift for non-fractional cases.
      if (frac === 0) return parseDecimalString(`${sign}${digits}${zeros}`)
      const shifted = `${digits}${zeros}`
      const wholeLen = digits.length - frac + magnitude
      const normalized = `${sign}${shifted.slice(0, wholeLen)}.${shifted.slice(wholeLen)}`
      return parseDecimalString(normalized.replace(/\.$/, ''))
    } catch {
      return null
    }
  }

  try {
    return parseDecimalString(text)
  } catch {
    return null
  }
}

function amountsEqual(left: DecimalString, right: DecimalString): boolean {
  return equalAtMinorUnit(left, right, 2)
}

function itemIdentity(item: BoqPricedItem): RowIdentity | null {
  const quantity = decimalFromNumber(item.qty)
  const rate = decimalFromNumber(item.rate)
  const total = decimalFromNumber(item.total)
  if (quantity === null || rate === null || total === null) return null
  if (!nonBlank(item.desc) || !nonBlank(item.unit)) return null
  return {
    description: item.desc,
    unit: item.unit,
    quantity,
    rate,
    total,
    ...(nonBlank(item.code) ? { code: item.code.trim() } : {}),
  }
}

function anchorCells(row: BoqSourceRowV3): DoclingRawCellV3[] {
  return row.rawCells.filter((cell) => !cell.carried)
}

function textAtColumn(row: BoqSourceRowV3, column: number): string {
  for (const cell of anchorCells(row)) {
    if (cell.column === column || cell.startColumnOffset === column) {
      return cell.rawText.trim()
    }
  }
  return ''
}

function headerIndex(headers: readonly string[], predicate: (normalized: string) => boolean): number {
  return headers.findIndex((header) => predicate(normalizeLabel(header)))
}

/**
 * Structured identity for matching only. Uses header-aligned cells; never emits
 * these values as authoritative BOQ fields.
 */
function extractRowIdentity(row: BoqSourceRowV3): RowIdentity | null {
  const headers = row.headers
  if (headers.length === 0) return null

  const descIdx = headerIndex(headers, (header) => (
    header === 'description'
    || header === 'description of works'
    || header === 'particulars'
    || header === 'item description'
    || header === 'work description'
    || header === 'item'
  ))
  const codeIdx = headerIndex(headers, (header) => (
    header === 'code'
    || header === 'item no'
    || header === 'item number'
    || header === 'ref'
    || header === 'reference'
    || header === 'no'
  ))
  const unitIdx = headerIndex(headers, (header) => (
    header === 'unit'
    || header === 'uom'
    || header === 'unit of measure'
    || header.includes('unit')
  ))
  const qtyIdx = headerIndex(headers, (header) => (
    header === 'qty'
    || header === 'q ty'
    || header === 'quantity'
    || header === 'quant'
  ))
  const rateIdx = headerIndex(headers, (header) => (
    header === 'rate'
    || header === 'unit rate'
    || header === 'price'
    || header === 'unit price'
  ))
  const amountIdx = headerIndex(headers, (header) => (
    header === 'amount'
    || header === 'total'
    || header === 'total amount'
    || header === 'extended amount'
    || header === 'value'
  ))

  const description = (descIdx >= 0 ? textAtColumn(row, descIdx) : textAtColumn(row, 0)).trim()
  if (!description) return null

  const unit = unitIdx >= 0 ? textAtColumn(row, unitIdx).trim() : ''
  if (!unit || parseAmountCell(unit) !== null) return null

  const qtyText = qtyIdx >= 0 ? textAtColumn(row, qtyIdx) : ''
  const rateText = rateIdx >= 0 ? textAtColumn(row, rateIdx) : ''
  const amountText = amountIdx >= 0 ? textAtColumn(row, amountIdx) : ''

  const quantity = parseAmountCell(qtyText)
  const rate = parseAmountCell(rateText)
  const total = parseAmountCell(amountText)
  if (quantity === null || rate === null || total === null) return null

  const code = codeIdx >= 0 ? textAtColumn(row, codeIdx).trim() : ''

  return {
    description,
    unit,
    quantity,
    rate,
    total,
    ...(code ? { code } : {}),
  }
}

function identitiesStrictMatch(
  left: RowIdentity,
  right: RowIdentity,
  unitMap: Record<string, string>,
): boolean {
  if (normalizeCatalogText(left.description) !== normalizeCatalogText(right.description)) {
    return false
  }
  if (left.code && right.code && left.code.trim() !== right.code.trim()) {
    return false
  }
  if (canonicalUnit(left.unit, unitMap) !== canonicalUnit(right.unit, unitMap)) {
    return false
  }
  return amountsEqual(left.quantity, right.quantity)
    && amountsEqual(left.rate, right.rate)
    && amountsEqual(left.total, right.total)
}

function descriptionMatches(left: RowIdentity, right: RowIdentity): boolean {
  return normalizeCatalogText(left.description) === normalizeCatalogText(right.description)
}

function itemStillMatchesFingerprint(
  item: BoqItem,
  fingerprints: Record<string, string> | undefined,
): boolean {
  if (!nonBlank(item.id)) return false
  const expected = fingerprints?.[item.id]
  if (!nonBlank(expected)) return true
  return fingerprintCanonicalItem(item) === expected
}

function collectBoqItems(boq: Boq): BoqItem[] {
  const items: BoqItem[] = []
  for (const section of boq.sections) {
    for (const item of section.items) {
      if (nonBlank(item.id)) items.push(item)
    }
  }
  return items
}

function roleById(roles: readonly RowRoleFinding[]): Map<string, RowRoleFinding> {
  const map = new Map<string, RowRoleFinding>()
  for (const finding of roles) {
    if (!map.has(finding.sourceRowId)) map.set(finding.sourceRowId, finding)
  }
  return map
}

/**
 * Apply claims with conflict detection. A source row claimed by two different
 * BOQ items at the same precedence level becomes unrepresented.
 */
function resolveClaims(claims: readonly Claim[]): Map<string, Claim> {
  const byRow = new Map<string, Claim>()
  const conflicts = new Set<string>()

  for (const claim of claims) {
    if (conflicts.has(claim.sourceRowId)) continue
    const existing = byRow.get(claim.sourceRowId)
    if (!existing) {
      byRow.set(claim.sourceRowId, claim)
      continue
    }
    if (existing.boqItemId !== claim.boqItemId) {
      byRow.delete(claim.sourceRowId)
      conflicts.add(claim.sourceRowId)
    }
  }

  return byRow
}

function groupSourceIdentityClaims(
  items: readonly BoqItem[],
  knownRows: ReadonlySet<string>,
): Claim[] {
  const claims: Claim[] = []
  for (const item of items) {
    if (!nonBlank(item.id)) continue
    const sources = itemSourceRowIds(item).filter((id) => knownRows.has(id))
    for (const sourceRowId of sources) {
      claims.push({
        sourceRowId,
        boqItemId: item.id,
        reason: 'source_identity',
      })
    }
  }
  return claims
}

function groupAcceptedAuditClaims(
  audits: readonly ExtractionProposalAudit[],
  itemsById: ReadonlyMap<string, BoqItem>,
  knownRows: ReadonlySet<string>,
  already: ReadonlySet<string>,
): Claim[] {
  const claims: Claim[] = []

  // Stable chronological order; later audits may refine but conflicts remain unrepresented.
  const ordered = [...audits].sort((left, right) => {
    const leftSeq = typeof left.sequence === 'number' ? left.sequence : Number.MAX_SAFE_INTEGER
    const rightSeq = typeof right.sequence === 'number' ? right.sequence : Number.MAX_SAFE_INTEGER
    if (leftSeq !== rightSeq) return leftSeq - rightSeq
    return left.timestamp.localeCompare(right.timestamp)
  })

  for (const audit of ordered) {
    if (audit.status !== 'accepted') continue

    if (Array.isArray(audit.sourceRowDecisions) && audit.sourceRowDecisions.length > 0) {
      for (const decision of audit.sourceRowDecisions) {
        if (decision.action !== 'add') continue
        if (!knownRows.has(decision.sourceRowId) || already.has(decision.sourceRowId)) continue
        const item = itemsById.get(decision.itemId)
        if (!item || !itemStillMatchesFingerprint(item, audit.affectedItemFingerprints)) continue
        claims.push({
          sourceRowId: decision.sourceRowId,
          boqItemId: decision.itemId,
          reason: 'accepted_audit',
        })
      }
      continue
    }

    const targetIds = audit.targetItemIds.filter((id) => nonBlank(id) && itemsById.has(id))
    if (targetIds.length === 0) continue

    if (targetIds.length === 1) {
      const boqItemId = targetIds[0]!
      const item = itemsById.get(boqItemId)
      if (!item || !itemStillMatchesFingerprint(item, audit.affectedItemFingerprints)) continue
      for (const sourceRowId of audit.sourceRowIds) {
        if (!knownRows.has(sourceRowId) || already.has(sourceRowId)) continue
        claims.push({ sourceRowId, boqItemId, reason: 'accepted_audit' })
      }
      continue
    }

    // Multi-target audits: bind through proposed item provenance when available.
    for (const proposed of audit.proposedItems) {
      const sources = Array.isArray(proposed.sourceRowIds) ? proposed.sourceRowIds : []
      const proposedId = nonBlank(proposed.id) ? proposed.id : null
      const boqItemId = proposedId && targetIds.includes(proposedId)
        ? proposedId
        : null
      if (!boqItemId) continue
      const item = itemsById.get(boqItemId)
      if (!item || !itemStillMatchesFingerprint(item, audit.affectedItemFingerprints)) continue
      for (const sourceRowId of sources) {
        if (!knownRows.has(sourceRowId) || already.has(sourceRowId)) continue
        claims.push({ sourceRowId, boqItemId, reason: 'accepted_audit' })
      }
    }
  }

  return claims
}

function groupNormalizedIdentityClaims(
  sourceRows: readonly BoqSourceRowV3[],
  items: readonly BoqItem[],
  unitMap: Record<string, string>,
  already: ReadonlySet<string>,
): Claim[] {
  const priced = items.filter(isPricedItem)
  const itemIdentities: Array<{ item: BoqPricedItem; identity: RowIdentity }> = []
  for (const item of priced) {
    const identity = itemIdentity(item)
    if (identity) itemIdentities.push({ item, identity })
  }

  const claims: Claim[] = []

  for (const row of sourceRows) {
    if (already.has(row.id)) continue
    const rowIdentity = extractRowIdentity(row)
    if (!rowIdentity) continue

    const strictMatches: BoqPricedItem[] = []
    let descriptionOnlyConflict = false

    for (const candidate of itemIdentities) {
      if (identitiesStrictMatch(rowIdentity, candidate.identity, unitMap)) {
        strictMatches.push(candidate.item)
        continue
      }
      if (descriptionMatches(rowIdentity, candidate.identity)) {
        // Same description but unit/amount/code diverge — never represent on similarity alone.
        descriptionOnlyConflict = true
      }
    }

    if (descriptionOnlyConflict && strictMatches.length === 0) {
      continue
    }
    if (strictMatches.length !== 1) {
      // Zero matches, or ambiguous multi-match — leave actionable/unrepresented.
      continue
    }

    const match = strictMatches[0]!
    if (!nonBlank(match.id)) continue
    claims.push({
      sourceRowId: row.id,
      boqItemId: match.id,
      reason: 'normalized_identity',
    })
  }

  return claims
}

function groupContinuationClaims(
  sourceRows: readonly BoqSourceRowV3[],
  roles: ReadonlyMap<string, RowRoleFinding>,
  represented: ReadonlyMap<string, Claim>,
): Claim[] {
  const claims: Claim[] = []
  const rowById = new Map(sourceRows.map((row) => [row.id, row]))

  // Walk source order so earlier continuations can chain off prior claims in this pass.
  const live = new Map(represented)

  for (const row of sourceRows) {
    if (live.has(row.id)) continue
    const role = roles.get(row.id)
    if (!role || role.role !== 'continuation') continue

    let best: { claim: Claim; row: BoqSourceRowV3 } | null = null
    for (const [sourceRowId, claim] of live) {
      const prior = rowById.get(sourceRowId)
      if (!prior) continue
      if (prior.page !== row.page || prior.table !== row.table) continue
      if (prior.row >= row.row) continue
      if (!best || prior.row > best.row.row) {
        best = { claim, row: prior }
      }
    }

    if (!best) continue
    const continuation: Claim = {
      sourceRowId: row.id,
      boqItemId: best.claim.boqItemId,
      reason: 'continuation',
    }
    claims.push(continuation)
    live.set(row.id, continuation)
  }

  return claims
}

function buildFindings(
  sourceRows: readonly BoqSourceRowV3[],
  claims: ReadonlyMap<string, Claim>,
): RepresentedRowFinding[] {
  const rowById = new Map(sourceRows.map((row) => [row.id, row]))
  const order = new Map(sourceRows.map((row, index) => [row.id, index]))

  // Group adjacent same-reason claims that share a BOQ item and were co-listed
  // under source_identity multi-row provenance, while keeping continuation
  // evidence as its own finding.
  type GroupKey = string
  const groups = new Map<GroupKey, Claim[]>()
  const groupOrder: GroupKey[] = []

  for (const row of sourceRows) {
    const claim = claims.get(row.id)
    if (!claim) continue

    // Continuations always stay as standalone findings (separate evidence).
    if (claim.reason === 'continuation') {
      const key = `continuation:${row.id}`
      groups.set(key, [claim])
      groupOrder.push(key)
      continue
    }

    // source_identity groups all co-claimed rows for the same item into one finding.
    if (claim.reason === 'source_identity') {
      const key = `source_identity:${claim.boqItemId}`
      const existing = groups.get(key)
      if (existing) {
        existing.push(claim)
      } else {
        groups.set(key, [claim])
        groupOrder.push(key)
      }
      continue
    }

    // accepted_audit / normalized_identity: one finding per row (stable, no silent merge).
    const key = `${claim.reason}:${row.id}`
    groups.set(key, [claim])
    groupOrder.push(key)
  }

  const findings: RepresentedRowFinding[] = []
  for (const key of groupOrder) {
    const group = groups.get(key)
    if (!group || group.length === 0) continue
    const sorted = [...group].sort(
      (left, right) => (order.get(left.sourceRowId) ?? 0) - (order.get(right.sourceRowId) ?? 0),
    )
    const sourceRowIds = sorted.map((claim) => claim.sourceRowId)
    const sourceRefs = sourceRowIds.map((id) => sourceRefOf(rowById.get(id)!))
    findings.push({
      sourceRowIds,
      boqItemId: sorted[0]!.boqItemId,
      reason: sorted[0]!.reason,
      sourceRefs,
    })
  }

  findings.sort((left, right) => {
    const leftIndex = Math.min(...left.sourceRowIds.map((id) => order.get(id) ?? Number.MAX_SAFE_INTEGER))
    const rightIndex = Math.min(...right.sourceRowIds.map((id) => order.get(id) ?? Number.MAX_SAFE_INTEGER))
    return leftIndex - rightIndex
  })

  return findings
}

/**
 * Deterministically mark source rows already represented by the current BOQ.
 *
 * Precedence: source identity → accepted audit → strict normalized identity → continuation.
 * Never merges or deletes evidence. Conflicts and description-only similarity stay unrepresented.
 * `proposals` is accepted for contract compatibility; representation never treats raw text or
 * unapplied proposal payloads as authoritative BOQ values.
 */
export function reconcileRepresentedRows(input: {
  boq: Boq
  sourceRows: readonly BoqSourceRowV3[]
  proposals: readonly ValidatedProposal[]
  audits: readonly ExtractionProposalAudit[]
  roles: readonly RowRoleFinding[]
  unitMap: Record<string, string>
}): RepresentedRowFinding[] {
  void input.proposals

  const knownRows = new Set(input.sourceRows.map((row) => row.id))
  const items = collectBoqItems(input.boq)
  const itemsById = new Map(items.map((item) => [item.id!, item]))
  const roles = roleById(input.roles)

  // 1. Source identity
  const sourceClaims = resolveClaims(groupSourceIdentityClaims(items, knownRows))

  // 2. Accepted audit (skip rows already claimed)
  const auditClaims = resolveClaims(
    groupAcceptedAuditClaims(
      input.audits,
      itemsById,
      knownRows,
      new Set(sourceClaims.keys()),
    ),
  )

  // 3. Strict normalized identity
  const claimedAfterAudit = new Set([...sourceClaims.keys(), ...auditClaims.keys()])
  const normalizedClaims = resolveClaims(
    groupNormalizedIdentityClaims(
      input.sourceRows,
      items,
      input.unitMap,
      claimedAfterAudit,
    ),
  )

  // Merge precedence layers (earlier layers already excluded later ones' inputs,
  // but enforce one-row-once if any overlap slipped through).
  const primary = new Map<string, Claim>()
  for (const [id, claim] of sourceClaims) primary.set(id, claim)
  for (const [id, claim] of auditClaims) {
    if (!primary.has(id)) primary.set(id, claim)
  }
  for (const [id, claim] of normalizedClaims) {
    if (!primary.has(id)) primary.set(id, claim)
  }

  // 4. Continuations attach to already-represented neighbors
  const continuationClaims = groupContinuationClaims(
    input.sourceRows,
    roles,
    primary,
  )
  for (const claim of continuationClaims) {
    if (!primary.has(claim.sourceRowId)) primary.set(claim.sourceRowId, claim)
  }

  return buildFindings(input.sourceRows, primary)
}
