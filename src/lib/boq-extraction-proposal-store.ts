import { randomUUID } from 'node:crypto'
import type { Firestore } from 'firebase-admin/firestore'
import type { Boq, BoqSection, BoqSourceCosts } from './boq-schema'
import { extractionRunPath, sourceRowPath, createFirestoreExtractionStore } from './boq-extraction-storage'
import { checksumSourceRows, extractionRunIdentityFingerprint, fingerprintParserConfig, stableCanonicalJson, type BoqExtractionRun } from './boq-extraction-run'
import type { BoqSourceRowV3 } from './boq-extraction-schema'
import { fingerprintCanonicalItem, fingerprintCanonicalSections, isHighConfidenceProposal, isStructurallyValidExtractionProposal, normalizeValidationSummary, type ExtractionProposal, type ProposalValidationSummary, type ValidatedProposal } from './boq-extraction-proposals'
import { reconstructSourceMappedItem } from './boq-extraction-proposal-contract'
import type { SourceBackedResolvedValues } from './boq-extraction-cell-mapping'
import {
  acceptExtractionProposal,
  proposalMatchesAudit,
  rejectExtractionProposal,
  reopenExtractionProposal,
  skipExtractionProposal,
  undoExtractionProposal,
  validateExtractionProposal,
  type ExtractionProposalAudit,
  type ExtractionProposalReopenEvent,
  type ExtractionProposalUndoEvent,
} from './boq-extraction-acceptance'
import { addSourceBackedBoqItem, MissingBoqItemError, type SourceBackedManualAddRequest, type ValidatedSourceMapping } from './boq-user-entry'

export type ProposalStoreResponse =
  | { status: 200; body: Record<string, unknown> }
  | { status: 400 | 404 | 409 | 500; body: { error: string } }

export type ExtractionProposalStatus = 'pending' | 'accepted' | 'rejected' | 'skipped' | 'superseded' | 'undone'
export interface ExtractionProposalStatusSummary {
  status: ExtractionProposalStatus
  canUndo: boolean
  stale?: boolean
  eligible?: boolean
}
export type ExtractionReviewRunStatus = 'queued' | 'running' | 'completed' | 'partial' | 'failed'
export interface ExtractionReviewRunSummary {
  status: ExtractionReviewRunStatus
  requestKey?: string
  leaseId?: string
  leaseExpiresAt?: string
  failureCode?: string
  retryAfter?: string
  updatedAt?: string
  reviewedSourceRowIds?: string[]
  validationSummary?: ProposalValidationSummary
  reviewTargeting?: {
    candidateRowIds: string[]
    ambiguousRowIds?: string[]
    unreconciledRowIds?: string[]
    unreconciled: boolean
  }
}
export interface ExtractionProposalReviewState {
  proposals: ValidatedProposal[]
  proposalStatuses: Record<string, ExtractionProposalStatusSummary>
  auditEvents: Array<ExtractionProposalAudit | ExtractionProposalUndoEvent | ExtractionProposalReopenEvent>
  reviewRun: ExtractionReviewRunSummary
}

function auditPath(boqId: string, runId: string, proposalId: string): string {
  return `${extractionRunPath(boqId, runId)}/proposalAudits/${proposalId}`
}

function proposalPath(boqId: string, runId: string, proposalId: string): string {
  return `${extractionRunPath(boqId, runId)}/proposals/${proposalId}`
}

function storedProposal(value: unknown, expectedId?: string): ValidatedProposal | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const proposal = (value as { proposal?: unknown }).proposal
  if (!isStructurallyValidExtractionProposal(proposal)) return null
  const candidate = proposal as ValidatedProposal
  if (typeof candidate.id !== 'string' || (expectedId !== undefined && candidate.id !== expectedId)
    || candidate.evidenceValid !== true || candidate.reconciled !== true || candidate.stale !== false) return null
  return structuredClone(candidate)
}

function proposalRecordStatus(value: unknown): ExtractionProposalStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'pending'
  const status = (value as { lifecycleStatus?: unknown }).lifecycleStatus
  return status === 'accepted' || status === 'rejected' || status === 'skipped' || status === 'superseded' || status === 'undone' ? status : 'pending'
}

function canonicalProposalId(proposal: ValidatedProposal): string {
  const fingerprint = fingerprintParserConfig({ ...proposal, id: null })
  return `proposal-${fingerprint.slice('sha256:'.length, 'sha256:'.length + 32)}`
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] as string : undefined
}

function optionalStringArrayField(record: Record<string, unknown>, key: string): string[] | undefined {
  return Array.isArray(record[key]) && (record[key] as unknown[]).every((item) => typeof item === 'string') ? record[key] as string[] : undefined
}

/** Reconstructs a review-run summary from an explicit field allowlist so that
 *  unexpected legacy Firestore fields (raw provider payloads, source data, etc.)
 *  never leak through GET/POST responses. */
function reviewRunSummary(value: unknown, fallback: unknown): ExtractionReviewRunSummary {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    const status = record.status
    if (status === 'queued' || status === 'running' || status === 'completed' || status === 'partial' || status === 'failed') {
      const normalized = normalizeValidationSummary(record.validationSummary)
      const targeting = record.reviewTargeting
      const reviewTargeting = targeting && typeof targeting === 'object' && !Array.isArray(targeting)
        ? {
            candidateRowIds: optionalStringArrayField(targeting as Record<string, unknown>, 'candidateRowIds') ?? [],
            ambiguousRowIds: optionalStringArrayField(targeting as Record<string, unknown>, 'ambiguousRowIds'),
            unreconciledRowIds: optionalStringArrayField(targeting as Record<string, unknown>, 'unreconciledRowIds'),
            unreconciled: (targeting as Record<string, unknown>).unreconciled === true,
          }
        : undefined
      const result: ExtractionReviewRunSummary = {
        status,
        requestKey: optionalStringField(record, 'requestKey'),
        leaseId: optionalStringField(record, 'leaseId'),
        leaseExpiresAt: optionalStringField(record, 'leaseExpiresAt'),
        failureCode: optionalStringField(record, 'failureCode'),
        retryAfter: optionalStringField(record, 'retryAfter'),
        updatedAt: optionalStringField(record, 'updatedAt'),
        reviewedSourceRowIds: optionalStringArrayField(record, 'reviewedSourceRowIds'),
        reviewTargeting,
      }
      if (normalized) result.validationSummary = normalized
      return result
    }
  }
  return {
    status: fallback === 'failed' ? 'failed'
      : fallback === 'running' ? 'running'
        : fallback === 'complete' || fallback === 'completed' || fallback === 'not_required' ? 'completed'
          : fallback === 'partial' ? 'partial' : 'queued',
  }
}

function isAudit(value: unknown): value is ExtractionProposalAudit {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as ExtractionProposalAudit).proposalId === 'string'
    && ((value as ExtractionProposalAudit).status === 'accepted' || (value as ExtractionProposalAudit).status === 'rejected' || (value as ExtractionProposalAudit).status === 'skipped')
    && Array.isArray((value as ExtractionProposalAudit).targetItemIds)
    && ((value as ExtractionProposalAudit).status !== 'accepted' || isBoqSnapshot((value as ExtractionProposalAudit).resultBoq))
}

function isReopenEvent(value: unknown): value is ExtractionProposalReopenEvent {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as ExtractionProposalReopenEvent).eventId === 'string'
    && (value as ExtractionProposalReopenEvent).status === 'reopened'
    && ((value as ExtractionProposalReopenEvent).previousStatus === 'rejected' || (value as ExtractionProposalReopenEvent).previousStatus === 'skipped')
}

function isUndoEvent(value: unknown): value is ExtractionProposalUndoEvent {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as ExtractionProposalUndoEvent).eventId === 'string'
    && (value as ExtractionProposalUndoEvent).status === 'undone'
    && Array.isArray((value as ExtractionProposalUndoEvent).afterSections)
    && isBoqSnapshot((value as ExtractionProposalUndoEvent).resultBoq)
}

function isBoqSnapshot(value: unknown): value is Boq {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Array.isArray((value as Boq).sections)
    && typeof (value as Boq).totalItems === 'number'
    && typeof (value as Boq).grandTotal === 'number'
}

type ProposalLifecycle = {
  status: ExtractionProposalStatus
  sequence: number
  currentAudit: ExtractionProposalAudit | null
  events: Array<ExtractionProposalAudit | ExtractionProposalUndoEvent | ExtractionProposalReopenEvent>
}

function lifecycleVersionMatches(snapshot: FirebaseFirestore.DocumentSnapshot, lifecycle: ProposalLifecycle): boolean {
  const version = snapshot.data()?.lifecycleRevision
  return version === undefined || version === lifecycle.sequence
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonBlank(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

function lifecycleEventKind(event: ExtractionProposalAudit | ExtractionProposalUndoEvent | ExtractionProposalReopenEvent): string {
  return isAudit(event) ? event.status : event.status === 'reopened' ? 'reopened' : 'undone'
}

function auditComplete(value: unknown): value is ExtractionProposalAudit {
  if (!isRecord(value) || !isAudit(value)) return false
  const audit = value as ExtractionProposalAudit
  return nonBlank(audit.auditId) && nonBlank(audit.proposalId) && nonBlank(audit.extractionRunId)
    && nonBlank(audit.actorId) && nonBlank(audit.timestamp) && nonBlank(audit.operation)
    && typeof audit.confidence === 'number' && Number.isFinite(audit.confidence)
    && typeof audit.explanation === 'string'
    && Array.isArray(audit.targetItemIds) && Array.isArray(audit.sourceRowIds)
    && Array.isArray(audit.sourceRefs) && Array.isArray(audit.proposedItems)
    && isRecord(audit.affectedItemFingerprints)
    && Array.isArray(audit.beforeSections) && Array.isArray(audit.afterSections)
    && nonBlank(audit.beforeSectionsFingerprint) && nonBlank(audit.afterSectionsFingerprint)
    && (audit.status !== 'accepted' || isBoqSnapshot(audit.resultBoq))
}

function eventComplete(value: unknown): value is ExtractionProposalAudit | ExtractionProposalUndoEvent | ExtractionProposalReopenEvent {
  if (isAudit(value)) return auditComplete(value)
  if (isReopenEvent(value)) {
    return nonBlank(value.eventId) && nonBlank(value.proposalId) && nonBlank(value.extractionRunId)
      && nonBlank(value.actorId) && nonBlank(value.timestamp)
      && (value.previousStatus === 'rejected' || value.previousStatus === 'skipped')
  }
  if (isUndoEvent(value)) {
    return nonBlank(value.eventId) && nonBlank(value.proposalId) && nonBlank(value.extractionRunId)
      && nonBlank(value.actorId) && nonBlank(value.timestamp)
      && Array.isArray(value.sourceRowIds) && Array.isArray(value.sourceRefs)
      && Array.isArray(value.beforeSections) && Array.isArray(value.afterSections)
      && nonBlank(value.beforeSectionsFingerprint) && nonBlank(value.afterSectionsFingerprint)
      && typeof value.resultTotalItems === 'number' && typeof value.resultGrandTotal === 'number'
      && isBoqSnapshot(value.resultBoq)
  }
  return false
}

function reduceProposalLifecycle(
  auditSnap: FirebaseFirestore.DocumentSnapshot,
  eventPage: FirebaseFirestore.QuerySnapshot,
  fallbackStatus: ExtractionProposalStatus,
  expectedProposalId?: string,
  expectedRunId?: string,
): ProposalLifecycle {
  if (eventPage.docs.length > 0 && !auditSnap.exists) throw new Error('Proposal lifecycle root audit is missing')
  const entries: Array<ExtractionProposalAudit | ExtractionProposalUndoEvent | ExtractionProposalReopenEvent> = []
  const keys: Array<string | null> = []
  const add = (value: unknown, key: string | null) => {
    if (!eventComplete(value)) throw new Error('Proposal lifecycle event is malformed')
    const event = value as { proposalId: string; extractionRunId: string }
    if (expectedProposalId !== undefined && event.proposalId !== expectedProposalId) throw new Error('Proposal lifecycle event is bound to another proposal')
    if (expectedRunId !== undefined && event.extractionRunId !== expectedRunId) throw new Error('Proposal lifecycle event is bound to another extraction run')
    entries.push(value)
    keys.push(key)
  }
  if (auditSnap.exists) add(auditSnap.data(), null)
  for (const snapshot of eventPage.docs) add(snapshot.data(), snapshot.id)
  const root = auditSnap.exists ? entries[0] : null
  const childEntries = entries.slice(auditSnap.exists ? 1 : 0).map((event, index) => ({ event, key: keys[(auditSnap.exists ? 1 : 0) + index]! }))
  const seenSequences = new Set<number>()
  for (const { event } of entries.map((event) => ({ event }))) {
    const value = (event as { sequence?: unknown }).sequence
    if (value !== undefined) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || seenSequences.has(value)) throw new Error('Proposal lifecycle sequence is invalid')
      seenSequences.add(value)
    }
  }
  const legacyChildren = childEntries.filter(({ event }) => (event as { sequence?: number }).sequence === undefined)
  const modernChildren = childEntries.filter(({ event }) => (event as { sequence?: number }).sequence !== undefined)
    .sort((left, right) => (left.event as { sequence: number }).sequence - (right.event as { sequence: number }).sequence)
  const ordered: Array<{ event: Array<ExtractionProposalAudit | ExtractionProposalUndoEvent | ExtractionProposalReopenEvent>[number]; key: string | null }> = [
    ...(root ? [{ event: root, key: null as string | null }] : []),
    ...legacyChildren,
    ...modernChildren,
  ]
  for (let index = 0; index < ordered.length; index += 1) {
    const { event, key } = ordered[index]!
    const explicit = (event as { sequence?: number }).sequence
    const expectedSequence = index + 1
    if (explicit !== undefined && explicit !== expectedSequence) throw new Error('Proposal lifecycle sequence has a gap')
    const kind = lifecycleEventKind(event)
    if (key !== null) {
      const legacyKey = explicit === undefined && (key === 'undo' || key === 'reopen' || key === 'accepted')
      if (!legacyKey && (explicit === undefined || key !== `${explicit}-${kind}`)) throw new Error('Proposal lifecycle event key is invalid')
      if (legacyKey && ((key === 'undo' && kind !== 'undone') || (key === 'reopen' && kind !== 'reopened') || (key === 'accepted' && kind !== 'accepted'))) throw new Error('Proposal lifecycle event key is invalid')
    }
  }

  let status = fallbackStatus
  let currentAudit: ExtractionProposalAudit | null = null
  let sequence = 0
  ordered.forEach(({ event }, index) => {
    sequence = Math.max(sequence, (event as { sequence?: number }).sequence ?? sequence + 1)
    if (isAudit(event)) {
      if (index > 0 && ((event.status === 'accepted' && status !== 'pending' && status !== 'undone')
        || ((event.status === 'rejected' || event.status === 'skipped') && status !== 'pending'))) throw new Error('Proposal lifecycle transition is illegal')
      status = event.status
      currentAudit = event
    } else if (isReopenEvent(event)) {
      if ((status !== 'rejected' && status !== 'skipped') || event.previousStatus !== status) throw new Error('Proposal reopen transition is illegal')
      status = 'pending'
    } else {
      if (status !== 'accepted') throw new Error('Proposal undo transition is illegal')
      status = 'undone'
    }
  })
  return { status, sequence, currentAudit, events: ordered.map(({ event }) => event) }
}


function invalidResponse(code: string): ProposalStoreResponse {
  const status = code === 'stale_item' ? 409 : 400
  return { status, body: { error: code } }
}

async function readProposalLifecycle(
  db: Firestore,
  auditDocumentPath: string,
  fallbackStatus: ExtractionProposalStatus = 'pending',
  expectedProposalId?: string,
  expectedRunId?: string,
): Promise<ProposalLifecycle> {
  const auditRef = db.doc(auditDocumentPath)
  const [auditSnap, eventPage] = await Promise.all([auditRef.get(), auditRef.collection('events').get()])
  return reduceProposalLifecycle(auditSnap, eventPage, fallbackStatus, expectedProposalId, expectedRunId)
}

async function readProposalLifecycleInTransaction(
  transaction: FirebaseFirestore.Transaction,
  db: Firestore,
  auditDocumentPath: string,
  fallbackStatus: ExtractionProposalStatus,
  expectedProposalId: string,
  expectedRunId: string,
): Promise<ProposalLifecycle | null> {
  const auditRef = db.doc(auditDocumentPath)
  try {
    const [auditSnap, eventPage] = await Promise.all([
      transaction.get(auditRef),
      transaction.get(auditRef.collection('events')),
    ])
    return reduceProposalLifecycle(auditSnap, eventPage, fallbackStatus, expectedProposalId, expectedRunId)
  } catch {
    return null
  }
}


function rowWithoutFingerprint(snapshot: FirebaseFirestore.DocumentSnapshot): BoqSourceRowV3 {
  const data = { ...snapshot.data() }
  delete data.fingerprint
  return data as unknown as BoqSourceRowV3
}

async function verifyImmutableContext(
  transaction: FirebaseFirestore.Transaction,
  db: Firestore,
  boqId: string,
  runId: string,
  storedRun: FirebaseFirestore.DocumentSnapshot,
  immutable: { run: BoqExtractionRun; sourceRows: BoqSourceRowV3[] },
): Promise<boolean> {
  const data = storedRun.data()
  if (!storedRun.exists || data?.status !== 'ready'
    || data.id !== runId
    || data.boqId !== boqId
    || immutable.run.id !== runId
    || immutable.run.boqId !== boqId) return false
  if (data.identityFingerprint !== extractionRunIdentityFingerprint(immutable.run)
    || data.sourceRowCount !== immutable.run.sourceRowCount
    || data.sourceRowChecksum !== immutable.run.sourceRowChecksum
    || data.deterministicSections?.checksum !== fingerprintParserConfig(immutable.run.sections)) return false
  const refs = immutable.sourceRows.map((row) => db.doc(sourceRowPath(boqId, runId, row.id)))
  const snapshots = refs.length > 0 ? await transaction.getAll(...refs) : []
  if (snapshots.length !== immutable.sourceRows.length || snapshots.some((snapshot) => !snapshot.exists)) return false
  const rows = snapshots.map(rowWithoutFingerprint)
  return rows.length === data.sourceRowCount && checksumSourceRows(rows) === data.sourceRowChecksum
}

function auditIdentityValid(proposal: ExtractionProposal, audit: ExtractionProposalAudit): boolean {
  return isAudit(audit) && proposalMatchesAudit(proposal, audit)
}

function auditSourceRefs(rows: readonly BoqSourceRowV3[], ids: readonly string[]) {
  const known = new Map(rows.map((row) => [row.id, row]))
  return ids.flatMap((id) => {
    const row = known.get(id)
    return row ? [{ sourceRowId: id, page: row.page, table: row.table, row: row.row }] : []
  })
}

/** Reconstructs the source-derived component breakdown (provenance only) from
 *  the immutable cell mapping. Returns null unless every component field was
 *  resolved by `resolveSourceCellMapping` — partial drafts carry no source Costs. */
function sourceCostsFromResolvedValues(resolved: SourceBackedResolvedValues): BoqSourceCosts | null {
  if (resolved.materialRate === undefined || resolved.materialTotal === undefined
    || resolved.labourRate === undefined || resolved.labourTotal === undefined) return null
  const qty = resolved.quantity ?? 0
  const unit = resolved.unit ?? ''
  return {
    material: { present: true, qty, unit, rate: resolved.materialRate, total: resolved.materialTotal },
    labour: { present: true, qty, unit, rate: resolved.labourRate, total: resolved.labourTotal },
  }
}

/** Builds the manual-entry audit mirroring `toAudit`'s shape: the proposal's
 *  source provenance is preserved, `proposedItems` is empty (the user authored
 *  the values), and `reviewDraft` keeps the source-derived resolution distinct
 *  from the user-entered correction now committed in `afterSections`. */
function buildSourceItemAudit(input: {
  proposal: ValidatedProposal
  beforeSections: readonly BoqSection[]
  afterSections: readonly BoqSection[]
  actorId: string
  now: string
  sourceRows: readonly BoqSourceRowV3[]
}): ExtractionProposalAudit {
  const proposal = input.proposal
  const beforeSections = structuredClone(input.beforeSections) as BoqSection[]
  const afterSections = structuredClone(input.afterSections) as BoqSection[]
  return {
    auditId: `${proposal.id}:${input.now}`,
    proposalId: proposal.id,
    extractionRunId: proposal.extractionRunId,
    status: 'accepted',
    actorId: input.actorId,
    timestamp: input.now,
    operation: proposal.operation,
    ...(proposal.candidateItemIds ? { candidateItemIds: [...proposal.candidateItemIds] } : {}),
    ...(proposal.baseSectionsFingerprint ? { baseSectionsFingerprint: proposal.baseSectionsFingerprint } : {}),
    ...(proposal.destinationSectionIndex === undefined ? {} : { destinationSectionIndex: proposal.destinationSectionIndex }),
    ...(proposal.destinationItemIndex === undefined ? {} : { destinationItemIndex: proposal.destinationItemIndex }),
    ...(proposal.candidateSourceOrder === undefined ? {} : { candidateSourceOrder: proposal.candidateSourceOrder }),
    targetItemIds: [...proposal.targetItemIds],
    affectedItemFingerprints: { ...proposal.affectedItemFingerprints },
    confidence: proposal.confidence,
    explanation: proposal.explanation,
    sourceRowIds: [...proposal.sourceRowIds],
    sourceRefs: auditSourceRefs(input.sourceRows, proposal.sourceRowIds),
    proposedItems: [],
    ...(proposal.sourceCellMapping ? { sourceCellMapping: structuredClone(proposal.sourceCellMapping) } : {}),
    ...(proposal.mappedCandidate ? { mappedCandidate: structuredClone(proposal.mappedCandidate) } : {}),
    ...(proposal.reviewDraft ? { reviewDraft: structuredClone(proposal.reviewDraft) } : {}),
    ...(proposal.evidenceValid === undefined ? {} : { evidenceValid: proposal.evidenceValid }),
    ...(proposal.reconciled === undefined ? {} : { reconciled: proposal.reconciled }),
    ...(proposal.stale === undefined ? {} : { stale: proposal.stale }),
    beforeSections,
    beforeSectionsFingerprint: fingerprintCanonicalSections(beforeSections),
    afterSections,
    afterSectionsFingerprint: fingerprintCanonicalSections(afterSections),
  }
}

/**
 * Firestore action store. The canonical BOQ write and audit record write occur
 * in the same transaction. Source rows/run sections are immutable once ready.
 */
export function createFirestoreExtractionProposalStore(db: Firestore, now: () => Date = () => new Date()) {
  const evidence = createFirestoreExtractionStore(db)

  async function loadImmutable(boqId: string, runId: string) {
    const imported = await evidence.getReadyImport(boqId, runId)
    if (!imported) return null
    const sourceRows = await evidence.getSourceRows(boqId, runId)
    return { ...imported, sourceRows }
  }

  async function persistValidatedProposals(
    transaction: FirebaseFirestore.Transaction,
    boqId: string,
    runId: string,
    immutable: NonNullable<Awaited<ReturnType<typeof loadImmutable>>>,
    boqSnap: FirebaseFirestore.DocumentSnapshot,
    runSnap: FirebaseFirestore.DocumentSnapshot,
    proposalPage: FirebaseFirestore.QuerySnapshot,
    auditPage: FirebaseFirestore.QuerySnapshot,
    proposals: readonly ValidatedProposal[],
    refreshedSourceRowIds: readonly string[],
  ): Promise<void> {
    if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready'
      || !await verifyImmutableContext(transaction, db, boqId, runId, runSnap, immutable)) {
      throw new Error('Extraction run not found')
    }
    const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
    const timestamp = now().toISOString()
    const canonical = proposals.map((proposal) => {
      const validation = validateExtractionProposal(boq, immutable.run, immutable.sourceRows, proposal)
      if (!validation.valid) throw new Error(`Invalid proposal: ${validation.code}`)
      const sameId = proposalPage.docs.find((snapshot) => snapshot.id === validation.proposal.id)
      const sameValue = sameId ? storedProposal(sameId.data(), validation.proposal.id) : null
      const safeModelId = validation.proposal.id.trim() !== '' && !validation.proposal.id.includes('/') && validation.proposal.id.length <= 240
      const id = safeModelId && (!sameId || sameValue && stableCanonicalJson(sameValue) === stableCanonicalJson(validation.proposal))
        ? validation.proposal.id
        : canonicalProposalId(validation.proposal)
      return { ...validation.proposal, id }
    })
    const incomingIds = new Set(canonical.map((proposal) => proposal.id))
    const refreshedRows = new Set(refreshedSourceRowIds)
    const auditedProposalIds = new Set(auditPage.docs.map((snapshot) => snapshot.id))
    for (const existing of proposalPage.docs) {
      const current = storedProposal(existing.data(), existing.id)
      if (!current) throw new Error('Stored proposal record is invalid')
      if (proposalRecordStatus(existing.data()) === 'pending' && !auditedProposalIds.has(current.id)
        && current.sourceRowIds.some((sourceRowId) => refreshedRows.has(sourceRowId)) && !incomingIds.has(current.id)) {
        transaction.update(existing.ref, { lifecycleStatus: 'superseded', supersededAt: timestamp, updatedAt: timestamp })
      }
    }
    for (const proposal of canonical) {
      const existing = proposalPage.docs.find((snapshot) => snapshot.id === proposal.id)
      if (existing) {
        const current = storedProposal(existing.data(), proposal.id)
        if (!current || stableCanonicalJson(current) !== stableCanonicalJson(proposal)) throw new Error('Stored proposal identity conflict')
        continue
      }
      transaction.create(db.doc(proposalPath(boqId, runId, proposal.id)), {
        proposal: structuredClone(proposal), lifecycleStatus: 'pending', createdAt: timestamp, updatedAt: timestamp,
      })
    }
  }

  return {
    async saveValidatedProposals(
      boqId: string,
      runId: string,
      proposals: readonly ValidatedProposal[],
      refreshedSourceRowIds: readonly string[] = proposals.flatMap((proposal) => proposal.sourceRowIds),
    ): Promise<void> {
      const immutable = await loadImmutable(boqId, runId)
      if (!immutable) throw new Error('Extraction run not found')
      await db.runTransaction(async (transaction) => {
        const boqRef = db.collection('boqs').doc(boqId)
        const runRef = db.doc(extractionRunPath(boqId, runId))
        const proposalPagePromise = transaction.get(runRef.collection('proposals'))
        const auditPagePromise = transaction.get(runRef.collection('proposalAudits'))
        const [boqSnap, runSnap, proposalPage, auditPage] = await Promise.all([
          transaction.get(boqRef), transaction.get(runRef), proposalPagePromise, auditPagePromise,
        ])
        await persistValidatedProposals(
          transaction, boqId, runId, immutable, boqSnap, runSnap, proposalPage, auditPage, proposals, refreshedSourceRowIds,
        )
      })
    },

    async getReviewState(boqId: string, runId: string): Promise<ExtractionProposalReviewState | null> {
      const immutable = await loadImmutable(boqId, runId)
      if (!immutable) return null
      const runRef = db.doc(extractionRunPath(boqId, runId))
      const [proposalPage, auditPage] = await Promise.all([
        runRef.collection('proposals').orderBy('createdAt').get(),
        runRef.collection('proposalAudits').orderBy('timestamp').get(),
      ])
      const records = proposalPage.docs.map((snapshot) => ({ snapshot, proposal: storedProposal(snapshot.data(), snapshot.id), status: proposalRecordStatus(snapshot.data()) }))
      if (records.some((record) => !record.proposal)) throw new Error('Stored proposal record is invalid')
      const audits = auditPage.docs.map((snapshot) => isAudit(snapshot.data()) ? snapshot.data() as ExtractionProposalAudit : null)
      if (audits.some((audit) => !audit)) throw new Error('Proposal audit record is invalid')
      const activeRecords = records
      const proposals = activeRecords.map((record) => record.proposal!)
      const lifecycles = await Promise.all(activeRecords.map((record) => readProposalLifecycle(
        db, auditPath(boqId, runId, record.proposal!.id), record.status, record.proposal!.id, runId,
      )))
      if (lifecycles.some((lifecycle, index) => !lifecycleVersionMatches(activeRecords[index]!.snapshot, lifecycle))) {
        throw new Error('Proposal lifecycle revision does not match the event sequence')
      }
      const proposalStatuses: Record<string, ExtractionProposalStatusSummary> = {}
      const auditEvents: Array<ExtractionProposalAudit | ExtractionProposalUndoEvent | ExtractionProposalReopenEvent> = lifecycles
        .flatMap((lifecycle) => lifecycle.events)
        .sort((left, right) => ((left as { sequence?: number }).sequence ?? 0) - ((right as { sequence?: number }).sequence ?? 0))
      const currentSectionsFingerprint = fingerprintCanonicalSections(immutable.boq.sections)
      const undoableProposalId = lifecycles
        .map((lifecycle, index) => ({ lifecycle, proposal: proposals[index]! }))
        .filter(({ lifecycle }) => lifecycle.status === 'accepted' && lifecycle.currentAudit
          && lifecycle.currentAudit.afterSectionsFingerprint === currentSectionsFingerprint)
        .sort((left, right) => {
          const leftAudit = left.lifecycle.currentAudit!
          const rightAudit = right.lifecycle.currentAudit!
          const byTime = leftAudit.timestamp.localeCompare(rightAudit.timestamp)
          if (byTime !== 0) return byTime
          const leftBatch = (leftAudit as ExtractionProposalAudit & { batchProposalIds?: string[] }).batchProposalIds
          const rightBatch = (rightAudit as ExtractionProposalAudit & { batchProposalIds?: string[] }).batchProposalIds
          if (leftBatch && rightBatch && stableCanonicalJson(leftBatch) === stableCanonicalJson(rightBatch)) {
            return leftBatch.indexOf(left.proposal.id) - rightBatch.indexOf(right.proposal.id)
          }
          return ((leftAudit as ExtractionProposalAudit & { sequence?: number }).sequence ?? 0)
            - ((rightAudit as ExtractionProposalAudit & { sequence?: number }).sequence ?? 0)
        }).at(-1)?.proposal.id
      proposals.forEach((proposal, index) => {
        const record = activeRecords[index]!
        const lifecycle = lifecycles[index]!
        if (lifecycle.status === 'superseded' || record.status === 'superseded') {
          proposalStatuses[proposal.id] = { status: 'superseded', canUndo: false }
          return
        }
        if (lifecycle.status === 'pending') {
          const stale = proposal.targetItemIds.some((itemId) => {
            const item = immutable.boq.sections.flatMap((section) => section.items).find((candidate) => candidate.id === itemId)
            return !item || proposal.affectedItemFingerprints[itemId] !== fingerprintCanonicalItem(item)
          })
          proposal.stale = stale
          proposalStatuses[proposal.id] = { status: 'pending', canUndo: false, stale, eligible: !stale && isHighConfidenceProposal(proposal) }
          return
        }
        proposalStatuses[proposal.id] = {
          status: lifecycle.status,
          canUndo: lifecycle.status === 'accepted' && proposal.id === undoableProposalId,
        }
      })
      const runData = immutable.run as BoqExtractionRun & { reviewRun?: unknown }
      return {
        proposals, proposalStatuses, auditEvents,
        reviewRun: {
          ...reviewRunSummary(runData.reviewRun, runData.aiReviewStatus),
          reviewTargeting: {
            candidateRowIds: [...runData.reviewTargeting.candidateRowIds],
            ambiguousRowIds: [...(runData.reviewTargeting.ambiguousRowIds ?? [])],
            unreconciledRowIds: [...(runData.reviewTargeting.unreconciledRowIds ?? [])],
            unreconciled: runData.reviewTargeting.unreconciled,
          },
        },
      }
    },

    async acquireReviewLease(
      boqId: string,
      runId: string,
      requestKey: string,
      leaseId: string,
      leaseTtlMs: number,
      force: boolean,
    ): Promise<{ kind: 'acquired' | 'busy' | 'complete' | 'failed'; reviewRun: ExtractionReviewRunSummary }> {
      return db.runTransaction(async (transaction) => {
        const boqRef = db.collection('boqs').doc(boqId)
        const runRef = db.doc(extractionRunPath(boqId, runId))
        const [boqSnap, runSnap] = await Promise.all([transaction.get(boqRef), transaction.get(runRef)])
        if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready') throw new Error('Extraction run not found')
        const current = reviewRunSummary(runSnap.data()?.reviewRun, runSnap.data()?.aiReviewStatus)
        const targeting = runSnap.data()?.reviewTargeting as BoqExtractionRun['reviewTargeting'] | undefined
        const time = now()
        const leaseExpiry = current.leaseExpiresAt ? Date.parse(current.leaseExpiresAt) : Number.NaN
        if (current.status === 'running' && Number.isFinite(leaseExpiry) && leaseExpiry > time.getTime()) {
          return { kind: 'busy', reviewRun: current }
        }
        if (!force && current.requestKey === requestKey && (current.status === 'completed' || current.status === 'partial')) {
          return { kind: 'complete', reviewRun: current }
        }
        const retryAfter = current.retryAfter ? Date.parse(current.retryAfter) : Number.NaN
        if (!force && current.requestKey === requestKey && current.status === 'failed'
          && Number.isFinite(retryAfter) && retryAfter > time.getTime()) {
          return { kind: 'failed', reviewRun: current }
        }
        const reviewRun: ExtractionReviewRunSummary = {
          status: 'running', requestKey, leaseId,
          leaseExpiresAt: new Date(time.getTime() + leaseTtlMs).toISOString(),
          updatedAt: time.toISOString(),
          ...(current.reviewedSourceRowIds?.length ? { reviewedSourceRowIds: [...current.reviewedSourceRowIds] } : {}),
          ...(targeting ? { reviewTargeting: {
            candidateRowIds: [...targeting.candidateRowIds],
            ambiguousRowIds: [...(targeting.ambiguousRowIds ?? [])],
            unreconciledRowIds: [...(targeting.unreconciledRowIds ?? [])],
            unreconciled: targeting.unreconciled,
          } } : {}),
        }
        transaction.update(runRef, { reviewRun, aiReviewStatus: 'running', updatedAt: time.toISOString() })
        return { kind: 'acquired', reviewRun }
      })
    },

    async completeReviewLease(
      boqId: string,
      runId: string,
      leaseId: string,
      status: 'completed' | 'partial',
      proposals: readonly ValidatedProposal[],
      refreshedSourceRowIds: readonly string[] = proposals.flatMap((proposal) => proposal.sourceRowIds),
      validationSummary: ProposalValidationSummary | null = null,
    ): Promise<ExtractionReviewRunSummary> {
      const immutable = await loadImmutable(boqId, runId)
      if (!immutable) throw new Error('Extraction run not found')
      return db.runTransaction(async (transaction) => {
        const boqRef = db.collection('boqs').doc(boqId)
        const runRef = db.doc(extractionRunPath(boqId, runId))
        const [boqSnap, runSnap, proposalPage, auditPage] = await Promise.all([
          transaction.get(boqRef),
          transaction.get(runRef),
          transaction.get(runRef.collection('proposals')),
          transaction.get(runRef.collection('proposalAudits')),
        ])
        const current = reviewRunSummary(runSnap.data()?.reviewRun, runSnap.data()?.aiReviewStatus)
        if (!runSnap.exists || runSnap.data()?.status !== 'ready' || current.status !== 'running' || current.leaseId !== leaseId) {
          throw new Error('Extraction review lease was lost')
        }
        if (proposals.length > 0 || refreshedSourceRowIds.length > 0) {
          await persistValidatedProposals(
            transaction, boqId, runId, immutable, boqSnap, runSnap, proposalPage, auditPage, proposals, refreshedSourceRowIds,
          )
        }
        const timestamp = now().toISOString()
        const reviewedSourceRowIds = [...new Set([...(current.reviewedSourceRowIds ?? []), ...refreshedSourceRowIds])]
        const reviewRun: ExtractionReviewRunSummary = {
          status, requestKey: current.requestKey, updatedAt: timestamp, reviewTargeting: current.reviewTargeting,
          ...(reviewedSourceRowIds.length ? { reviewedSourceRowIds } : {}),
          ...(validationSummary ? { validationSummary } : {}),
        }
        transaction.update(runRef, { reviewRun, aiReviewStatus: status, updatedAt: timestamp })
        return reviewRun
      })
    },

    async failReviewLease(
      boqId: string,
      runId: string,
      leaseId: string,
      failureCode: string,
      retryDelayMs: number,
      preservedProposals: readonly ValidatedProposal[] = [],
      refreshedSourceRowIds: readonly string[] = preservedProposals.flatMap((proposal) => proposal.sourceRowIds),
      validationSummary: ProposalValidationSummary | null = null,
    ): Promise<ExtractionReviewRunSummary> {
      const immutable = preservedProposals.length > 0 ? await loadImmutable(boqId, runId) : null
      return db.runTransaction(async (transaction) => {
        const boqRef = db.collection('boqs').doc(boqId)
        const runRef = db.doc(extractionRunPath(boqId, runId))
        const [boqSnap, runSnap, proposalPage, auditPage] = await Promise.all([
          transaction.get(boqRef),
          transaction.get(runRef),
          transaction.get(runRef.collection('proposals')),
          transaction.get(runRef.collection('proposalAudits')),
        ])
        const current = reviewRunSummary(runSnap.data()?.reviewRun, runSnap.data()?.aiReviewStatus)
        const time = now()
        if (!runSnap.exists || runSnap.data()?.status !== 'ready' || current.status !== 'running' || current.leaseId !== leaseId) {
          throw new Error('Extraction review lease was lost')
        }
        if (preservedProposals.length > 0) {
          if (!immutable) throw new Error('Extraction run not found')
          await persistValidatedProposals(
            transaction, boqId, runId, immutable, boqSnap, runSnap, proposalPage, auditPage, preservedProposals, refreshedSourceRowIds,
          )
        }
        const reviewedSourceRowIds = [...new Set([...(current.reviewedSourceRowIds ?? []), ...refreshedSourceRowIds])]
        const reviewRun: ExtractionReviewRunSummary = {
          status: 'failed', requestKey: current.requestKey, failureCode,
          retryAfter: new Date(time.getTime() + retryDelayMs).toISOString(), updatedAt: time.toISOString(), reviewTargeting: current.reviewTargeting,
          ...(reviewedSourceRowIds.length ? { reviewedSourceRowIds } : {}),
          ...(validationSummary ? { validationSummary } : {}),
        }
        transaction.update(runRef, { reviewRun, aiReviewStatus: 'failed', updatedAt: time.toISOString() })
        return reviewRun
      })
    },

    async accept(boqId: string, runId: string, proposalId: string, actorId: string): Promise<ProposalStoreResponse> {
      let immutable: Awaited<ReturnType<typeof loadImmutable>>
      try { immutable = await loadImmutable(boqId, runId) } catch { return { status: 404, body: { error: 'Extraction run not found' } } }
      if (!immutable) return { status: 404, body: { error: 'Extraction run not found' } }
      try {
        return await db.runTransaction(async (transaction) => {
          const boqRef = db.collection('boqs').doc(boqId)
          const runRef = db.doc(extractionRunPath(boqId, runId))
          const auditRef = db.doc(auditPath(boqId, runId, proposalId))
          const proposalRef = db.doc(proposalPath(boqId, runId, proposalId))
          const [boqSnap, runSnap, proposalSnap, auditSnap] = await Promise.all([
            transaction.get(boqRef), transaction.get(runRef), transaction.get(proposalRef), transaction.get(auditRef),
          ])
          if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready') return { status: 404, body: { error: 'Extraction run not found' } }
          const proposal = proposalSnap.exists ? storedProposal(proposalSnap.data(), proposalId) : null
          if (!proposal) return { status: 404, body: { error: 'Stored proposal not found' } }
          const lifecycle = await readProposalLifecycleInTransaction(
            transaction, db, auditPath(boqId, runId, proposalId), proposalRecordStatus(proposalSnap.data()), proposalId, runId,
          )
          if (!lifecycle || !lifecycleVersionMatches(proposalSnap, lifecycle)) return { status: 409, body: { error: 'Proposal lifecycle record is invalid' } }
          if (!await verifyImmutableContext(transaction, db, boqId, runId, runSnap, immutable)) {
            return { status: 409, body: { error: 'Extraction evidence changed; recheck the proposal' } }
          }
          if (auditSnap.exists && !isAudit(auditSnap.data())) return { status: 409, body: { error: 'Proposal audit record is invalid' } }
          const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
          if (boq.status === 'approved') return { status: 409, body: { error: 'Approved BOQs cannot be changed by extraction proposals' } }
          const existingAudit = lifecycle.status === 'accepted' ? lifecycle.currentAudit : null
          if (lifecycle.status !== 'pending' && lifecycle.status !== 'undone' && lifecycle.status !== 'accepted') {
            return { status: 409, body: { error: 'Proposal is not pending' } }
          }
          if (existingAudit && !auditIdentityValid(proposal, existingAudit)) return invalidResponse('run_identity_mismatch')
          const actionTimestamp = now().toISOString()
          const result = acceptExtractionProposal({ boq, run: immutable.run, sourceRows: immutable.sourceRows, proposal, actorId, now: actionTimestamp, existingAudit })
          if (result.kind === 'invalid') return invalidResponse(result.code)
          if (result.kind === 'rejected') return { status: 409, body: { error: 'proposal_rejected', audit: result.audit } }
          if (result.kind === 'already_accepted') return { status: 200, body: { status: 'accepted', boq: result.boq, audit: result.audit, idempotent: true } }
          const acceptedBoq = { ...result.boq, updatedAt: actionTimestamp }
          const acceptedAudit = { ...result.audit, resultBoq: structuredClone(acceptedBoq), sequence: lifecycle.sequence + 1 }
          transaction.update(boqRef, {
            sections: acceptedBoq.sections,
            totalItems: acceptedBoq.totalItems,
            grandTotal: acceptedBoq.grandTotal,
            updatedAt: actionTimestamp,
          })
          transaction.update(proposalRef, { lifecycleStatus: 'accepted', lifecycleRevision: lifecycle.sequence + 1, updatedAt: actionTimestamp })
          const actionRef = lifecycle.events.length === 0 ? auditRef : auditRef.collection('events').doc(`${lifecycle.sequence + 1}-accepted`)
          transaction.create(actionRef, acceptedAudit)
          return { status: 200, body: { status: 'accepted', boq: acceptedBoq, audit: acceptedAudit } }
        })
      } catch {
        return { status: 500, body: { error: 'Proposal acceptance could not be saved' } }
      }
    },

    async reject(boqId: string, runId: string, proposalId: string, actorId: string): Promise<ProposalStoreResponse> {
      let immutable: Awaited<ReturnType<typeof loadImmutable>>
      try { immutable = await loadImmutable(boqId, runId) } catch { return { status: 404, body: { error: 'Extraction run not found' } } }
      if (!immutable) return { status: 404, body: { error: 'Extraction run not found' } }
      try {
        return await db.runTransaction(async (transaction) => {
          const boqRef = db.collection('boqs').doc(boqId)
          const runRef = db.doc(extractionRunPath(boqId, runId))
          const auditRef = db.doc(auditPath(boqId, runId, proposalId))
          const proposalRef = db.doc(proposalPath(boqId, runId, proposalId))
          const [boqSnap, runSnap, proposalSnap, auditSnap] = await Promise.all([transaction.get(boqRef), transaction.get(runRef), transaction.get(proposalRef), transaction.get(auditRef)])
          if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready') return { status: 404, body: { error: 'Extraction run not found' } }
          const proposal = proposalSnap.exists ? storedProposal(proposalSnap.data(), proposalId) : null
          if (!proposal) return { status: 404, body: { error: 'Stored proposal not found' } }
          const lifecycle = await readProposalLifecycleInTransaction(
            transaction, db, auditPath(boqId, runId, proposalId), proposalRecordStatus(proposalSnap.data()), proposalId, runId,
          )
          if (!lifecycle || !lifecycleVersionMatches(proposalSnap, lifecycle)) return { status: 409, body: { error: 'Proposal lifecycle record is invalid' } }
          if (!await verifyImmutableContext(transaction, db, boqId, runId, runSnap, immutable)) {
            return { status: 409, body: { error: 'Extraction evidence changed; recheck the proposal' } }
          }
          if (auditSnap.exists && !isAudit(auditSnap.data())) return { status: 409, body: { error: 'Proposal audit record is invalid' } }
          const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
          if (boq.status === 'approved') return { status: 409, body: { error: 'Approved BOQs cannot change extraction review state' } }
          const existingAudit = lifecycle.status === 'rejected' ? lifecycle.currentAudit : null
          if (lifecycle.status !== 'pending' && lifecycle.status !== 'rejected') return { status: 409, body: { error: 'Proposal is not pending' } }
          if (existingAudit && !auditIdentityValid(proposal, existingAudit)) return invalidResponse('run_identity_mismatch')
          let validatedProposal = proposal
          if (!existingAudit) {
            const validation = validateExtractionProposal(boq, immutable.run, immutable.sourceRows, proposal)
            if (!validation.valid) return invalidResponse(validation.code)
            if (validation.proposal.operation === 'needs_human_review') return invalidResponse('needs_human_review')
            validatedProposal = validation.proposal
          }
          const result = rejectExtractionProposal({ boq, proposal: validatedProposal, actorId, now: now().toISOString(), existingAudit, sourceRows: immutable.sourceRows })
          if (result.kind === 'invalid') return invalidResponse(result.code)
          if (result.kind === 'already_recorded') return { status: 200, body: { status: result.audit.status, audit: result.audit, idempotent: true } }
          const audit = { ...result.audit, sequence: lifecycle.sequence + 1 }
          transaction.update(proposalRef, { lifecycleStatus: 'rejected', lifecycleRevision: lifecycle.sequence + 1, updatedAt: result.audit.timestamp })
          const actionRef = lifecycle.events.length === 0 ? auditRef : auditRef.collection('events').doc(`${lifecycle.sequence + 1}-rejected`)
          transaction.create(actionRef, audit)
          return { status: 200, body: { status: 'rejected', audit } }
        })
      } catch {
        return { status: 500, body: { error: 'Proposal rejection could not be saved' } }
      }
    },

    async skip(boqId: string, runId: string, proposalId: string, actorId: string): Promise<ProposalStoreResponse> {
      let immutable: Awaited<ReturnType<typeof loadImmutable>>
      try { immutable = await loadImmutable(boqId, runId) } catch { return { status: 404, body: { error: 'Extraction run not found' } } }
      if (!immutable) return { status: 404, body: { error: 'Extraction run not found' } }
      try {
        return await db.runTransaction(async (transaction) => {
          const boqRef = db.collection('boqs').doc(boqId)
          const runRef = db.doc(extractionRunPath(boqId, runId))
          const auditRef = db.doc(auditPath(boqId, runId, proposalId))
          const proposalRef = db.doc(proposalPath(boqId, runId, proposalId))
          const [boqSnap, runSnap, proposalSnap, auditSnap] = await Promise.all([
            transaction.get(boqRef), transaction.get(runRef), transaction.get(proposalRef), transaction.get(auditRef),
          ])
          if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready') return { status: 404, body: { error: 'Extraction run not found' } }
          const proposal = proposalSnap.exists ? storedProposal(proposalSnap.data(), proposalId) : null
          if (!proposal) return { status: 404, body: { error: 'Stored proposal not found' } }
          const lifecycle = await readProposalLifecycleInTransaction(
            transaction, db, auditPath(boqId, runId, proposalId), proposalRecordStatus(proposalSnap.data()), proposalId, runId,
          )
          if (!lifecycle || !lifecycleVersionMatches(proposalSnap, lifecycle)) return { status: 409, body: { error: 'Proposal lifecycle record is invalid' } }
          if (!await verifyImmutableContext(transaction, db, boqId, runId, runSnap, immutable)) return { status: 409, body: { error: 'Extraction evidence changed; recheck the proposal' } }
          if (auditSnap.exists && !isAudit(auditSnap.data())) return { status: 409, body: { error: 'Proposal audit record is invalid' } }
          const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
          if (boq.status === 'approved') return { status: 409, body: { error: 'Approved BOQs cannot change extraction review state' } }
          const existingAudit = lifecycle.status === 'skipped' ? lifecycle.currentAudit : null
          if (lifecycle.status !== 'pending' && lifecycle.status !== 'skipped') return { status: 409, body: { error: 'Proposal is not pending' } }
          let validatedProposal: ValidatedProposal
          if (existingAudit) {
            validatedProposal = proposal
          } else {
            const validation = validateExtractionProposal(boq, immutable.run, immutable.sourceRows, proposal)
            if (!validation.valid) return invalidResponse(validation.code)
            validatedProposal = validation.proposal
          }
          const result = skipExtractionProposal({
            boq, proposal: validatedProposal, actorId, now: now().toISOString(), existingAudit, sourceRows: immutable.sourceRows,
          })
          if (result.kind === 'invalid') return invalidResponse(result.code)
          if (result.kind === 'already_recorded') return { status: 200, body: { status: 'skipped', audit: result.audit, idempotent: true } }
          const audit = { ...result.audit, sequence: lifecycle.sequence + 1 }
          transaction.update(proposalRef, { lifecycleStatus: 'skipped', lifecycleRevision: lifecycle.sequence + 1, updatedAt: result.audit.timestamp })
          const actionRef = lifecycle.events.length === 0 ? auditRef : auditRef.collection('events').doc(`${lifecycle.sequence + 1}-skipped`)
          transaction.create(actionRef, audit)
          return { status: 200, body: { status: 'skipped', audit } }
        })
      } catch {
        return { status: 500, body: { error: 'Proposal skip could not be saved' } }
      }
    },

    async reopen(boqId: string, runId: string, proposalId: string, actorId: string): Promise<ProposalStoreResponse> {
      let immutable: Awaited<ReturnType<typeof loadImmutable>>
      try { immutable = await loadImmutable(boqId, runId) } catch { return { status: 404, body: { error: 'Extraction run not found' } } }
      if (!immutable) return { status: 404, body: { error: 'Extraction run not found' } }
      try {
        return await db.runTransaction(async (transaction) => {
          const boqRef = db.collection('boqs').doc(boqId)
          const runRef = db.doc(extractionRunPath(boqId, runId))
          const auditRef = db.doc(auditPath(boqId, runId, proposalId))
          const proposalRef = db.doc(proposalPath(boqId, runId, proposalId))
          const [boqSnap, runSnap, proposalSnap] = await Promise.all([
            transaction.get(boqRef), transaction.get(runRef), transaction.get(proposalRef),
          ])
          if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready') return { status: 404, body: { error: 'Extraction run not found' } }
          const proposal = proposalSnap.exists ? storedProposal(proposalSnap.data(), proposalId) : null
          if (!proposal) return { status: 404, body: { error: 'Stored proposal not found' } }
          const lifecycle = await readProposalLifecycleInTransaction(
            transaction, db, auditPath(boqId, runId, proposalId), proposalRecordStatus(proposalSnap.data()), proposalId, runId,
          )
          if (!lifecycle || !lifecycleVersionMatches(proposalSnap, lifecycle)) return { status: 409, body: { error: 'Proposal lifecycle record is invalid' } }
          if (!await verifyImmutableContext(transaction, db, boqId, runId, runSnap, immutable)) return { status: 409, body: { error: 'Extraction evidence changed; recheck the proposal' } }
          if (lifecycle.status !== 'rejected' && lifecycle.status !== 'skipped' || !lifecycle.currentAudit) {
            return { status: 409, body: { error: 'Proposal is not reopenable' } }
          }
          const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
          if (boq.status === 'approved') return { status: 409, body: { error: 'Approved BOQs cannot change extraction review state' } }
          const result = reopenExtractionProposal({
            proposal, actorId, now: now().toISOString(), existingAudit: lifecycle.currentAudit,
          })
          if (result.kind !== 'reopened') {
            const error = result.kind === 'invalid' && result.code === 'not_reopenable'
              ? 'Proposal is not reopenable'
              : 'Proposal audit does not match stored evidence'
            return { status: 409, body: { error } }
          }
          const event = { ...result.event, sequence: lifecycle.sequence + 1 }
          transaction.update(proposalRef, { lifecycleStatus: 'pending', lifecycleRevision: lifecycle.sequence + 1, updatedAt: event.timestamp })
          transaction.create(auditRef.collection('events').doc(`${lifecycle.sequence + 1}-reopened`), event)
          return { status: 200, body: { status: 'pending', audit: event } }
        })
      } catch {
        return { status: 500, body: { error: 'Proposal reopen could not be saved' } }
      }
    },

    async undo(boqId: string, runId: string, proposalId: string, actorId: string): Promise<ProposalStoreResponse> {
      let immutable: Awaited<ReturnType<typeof loadImmutable>>
      try { immutable = await loadImmutable(boqId, runId) } catch { return { status: 404, body: { error: 'Extraction run not found' } } }
      if (!immutable) return { status: 404, body: { error: 'Extraction run not found' } }
      try {
        return await db.runTransaction(async (transaction) => {
          const boqRef = db.collection('boqs').doc(boqId)
          const runRef = db.doc(extractionRunPath(boqId, runId))
          const auditRef = db.doc(auditPath(boqId, runId, proposalId))
          const proposalRef = db.doc(proposalPath(boqId, runId, proposalId))
          const [boqSnap, runSnap, proposalSnap] = await Promise.all([
            transaction.get(boqRef), transaction.get(runRef), transaction.get(proposalRef),
          ])
          if (!boqSnap.exists || !runSnap.exists || !proposalSnap.exists || runSnap.data()?.status !== 'ready') {
            return { status: 404, body: { error: 'Accepted proposal not found' } }
          }
          const lifecycle = await readProposalLifecycleInTransaction(
            transaction, db, auditPath(boqId, runId, proposalId), proposalRecordStatus(proposalSnap.data()), proposalId, runId,
          )
          if (!lifecycle || !lifecycleVersionMatches(proposalSnap, lifecycle)) return { status: 409, body: { error: 'Proposal lifecycle record is invalid' } }
          if (!await verifyImmutableContext(transaction, db, boqId, runId, runSnap, immutable)) {
            return { status: 409, body: { error: 'Extraction evidence changed; recheck the proposal' } }
          }
          if (lifecycle.status === 'undone') {
            const previousUndo = lifecycle.events.filter(isUndoEvent).at(-1)
            if (!previousUndo?.resultBoq) return { status: 409, body: { error: 'Proposal undo record is invalid' } }
            return { status: 200, body: { status: 'undone', boq: structuredClone(previousUndo.resultBoq), audit: previousUndo, idempotent: true } }
          }
          if (lifecycle.status !== 'accepted' || !lifecycle.currentAudit) return { status: 409, body: { error: 'Proposal cannot be undone' } }
          const batchProposalIds = (lifecycle.currentAudit as ExtractionProposalAudit & { batchProposalIds?: string[] }).batchProposalIds
          if (batchProposalIds && batchProposalIds.at(-1) !== proposalId) {
            return { status: 409, body: { error: 'Batch proposals must be undone in reverse order' } }
          }
          const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
          if (boq.status === 'approved') return { status: 409, body: { error: 'Approved BOQs cannot be changed by extraction proposals' } }
          const actionTimestamp = now().toISOString()
          const result = undoExtractionProposal({
            boq,
            audit: lifecycle.currentAudit,
            actorId,
            now: actionTimestamp,
            sourceRefs: lifecycle.currentAudit.sourceRefs,
          })
          if (result.kind === 'conflict') return { status: 409, body: { error: 'BOQ changed after proposal acceptance' } }
          if (result.kind === 'not_accepted') return { status: 409, body: { error: 'Proposal cannot be undone' } }
          const undoneBoq = { ...result.boq, updatedAt: actionTimestamp }
          const legacyUndo = lifecycle.events.length === 1 && !(lifecycle.currentAudit as ExtractionProposalAudit & { batchProposalIds?: string[] }).batchProposalIds
          const undoRef = legacyUndo ? auditRef.collection('events').doc('undo') : auditRef.collection('events').doc(`${lifecycle.sequence + 1}-undone`)
          const undoneAudit = {
            ...result.audit,
            resultBoq: structuredClone(undoneBoq),
            ...(legacyUndo ? {} : { sequence: lifecycle.sequence + 1 }),
          }
          transaction.update(boqRef, {
            sections: undoneBoq.sections,
            totalItems: undoneBoq.totalItems,
            grandTotal: undoneBoq.grandTotal,
            updatedAt: actionTimestamp,
          })
          transaction.update(proposalRef, { lifecycleStatus: 'undone', lifecycleRevision: lifecycle.sequence + 1, updatedAt: actionTimestamp })
          transaction.create(undoRef, undoneAudit)
          return { status: 200, body: { status: 'undone', boq: undoneBoq, audit: undoneAudit } }
        })
      } catch {
        return { status: 500, body: { error: 'Proposal undo could not be saved' } }
      }
    },

    async acceptBatch(boqId: string, runId: string, proposalIds: readonly string[], actorId: string): Promise<ProposalStoreResponse> {
      if (proposalIds.length === 0 || proposalIds.length > 100 || new Set(proposalIds).size !== proposalIds.length) {
        return { status: 400, body: { error: 'Invalid proposal batch' } }
      }
      let immutable: Awaited<ReturnType<typeof loadImmutable>>
      try { immutable = await loadImmutable(boqId, runId) } catch { return { status: 404, body: { error: 'Extraction run not found' } } }
      if (!immutable) return { status: 404, body: { error: 'Extraction run not found' } }
      try {
        return await db.runTransaction(async (transaction) => {
          const boqRef = db.collection('boqs').doc(boqId)
          const runRef = db.doc(extractionRunPath(boqId, runId))
          const proposalRefs = proposalIds.map((id) => db.doc(proposalPath(boqId, runId, id)))
          const [boqSnap, runSnap, proposalSnaps] = await Promise.all([
            transaction.get(boqRef), transaction.get(runRef), transaction.getAll(...proposalRefs),
          ])
          if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready') return { status: 404, body: { error: 'Extraction run not found' } }
          if (!await verifyImmutableContext(transaction, db, boqId, runId, runSnap, immutable)) {
            return { status: 409, body: { error: 'Extraction evidence changed; recheck the proposals' } }
          }
          const proposals = proposalSnaps.map((snapshot, index) => snapshot.exists ? storedProposal(snapshot.data(), proposalIds[index]) : null)
          if (proposals.some((proposal) => !proposal)) return { status: 404, body: { error: 'Stored proposal not found' } }
          const lifecycles = await Promise.all(proposalSnaps.map((snapshot, index) => readProposalLifecycleInTransaction(
            transaction, db, auditPath(boqId, runId, proposalIds[index]!), proposalRecordStatus(snapshot.data()), proposalIds[index]!, runId,
          )))
          if (lifecycles.some((lifecycle, index) => !lifecycle || !lifecycleVersionMatches(proposalSnaps[index]!, lifecycle))) {
            return { status: 409, body: { error: 'Proposal lifecycle record is invalid' } }
          }
          const currentLifecycles = lifecycles as ProposalLifecycle[]
          const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
          if (boq.status === 'approved') return { status: 409, body: { error: 'Approved BOQs cannot be changed by extraction proposals' } }
          const allAccepted = currentLifecycles.every((lifecycle, index) => lifecycle.status === 'accepted'
            && lifecycle.currentAudit && auditIdentityValid(proposals[index]!, lifecycle.currentAudit)
            && isBoqSnapshot(lifecycle.currentAudit.resultBoq))
          if (allAccepted) {
            return { status: 200, body: { status: 'accepted', acceptedProposalIds: [...proposalIds], boq: structuredClone(currentLifecycles.at(-1)!.currentAudit!.resultBoq), idempotent: true } }
          }
          if (currentLifecycles.some((lifecycle) => lifecycle.status !== 'pending')) {
            return { status: 409, body: { error: 'Proposal batch is no longer pending' } }
          }
          const seenTargets = new Set<string>()
          const seenRows = new Set<string>()
          const validated: ValidatedProposal[] = []
          for (const proposal of proposals as ValidatedProposal[]) {
            if (proposal.targetItemIds.some((id) => seenTargets.has(id)) || proposal.sourceRowIds.some((id) => seenRows.has(id))) {
              return { status: 409, body: { error: 'Proposal batch contains overlapping changes' } }
            }
            proposal.targetItemIds.forEach((id) => seenTargets.add(id))
            proposal.sourceRowIds.forEach((id) => seenRows.add(id))
            const validation = validateExtractionProposal(boq, immutable.run, immutable.sourceRows, proposal)
            if (!validation.valid) return invalidResponse(validation.code)
            if (validation.proposal.operation === 'separate_components') return { status: 400, body: { error: 'Proposal is not eligible for batch acceptance' } }
            validated.push(validation.proposal)
          }
          const mutationOrder = [...validated].sort((left, right) => {
            const leftInsert = left.operation === 'insert_missing_item' ? 0 : 1
            const rightInsert = right.operation === 'insert_missing_item' ? 0 : 1
            return leftInsert - rightInsert || (right.destinationSectionIndex ?? -1) - (left.destinationSectionIndex ?? -1)
              || (right.destinationItemIndex ?? -1) - (left.destinationItemIndex ?? -1)
              || (right.candidateSourceOrder ?? -1) - (left.candidateSourceOrder ?? -1)
          })
          const actionTimestamp = now().toISOString()
          let currentBoq = boq
          const auditsById = new Map<string, ExtractionProposalAudit>()
          for (const proposal of mutationOrder) {
            const result = acceptExtractionProposal({ boq: currentBoq, run: immutable.run, sourceRows: immutable.sourceRows,
              proposal, validationBoq: boq, skipBaseRevisionCheck: true, actorId, now: actionTimestamp, existingAudit: null })
            if (result.kind !== 'accepted') {
              const error = result.kind === 'invalid' ? result.code : 'Proposal batch is no longer pending'
              return result.kind === 'invalid' ? invalidResponse(error) : { status: 409, body: { error } }
            }
            currentBoq = result.boq
            auditsById.set(proposal.id, result.audit)
          }
          const acceptedBoq = { ...currentBoq, updatedAt: actionTimestamp }
          transaction.update(boqRef, { sections: acceptedBoq.sections, totalItems: acceptedBoq.totalItems, grandTotal: acceptedBoq.grandTotal, updatedAt: actionTimestamp })
          const mutationProposalIds = proposalIds
          proposalRefs.forEach((proposalRef, index) => {
            const lifecycle = currentLifecycles[index]!
            const audit = { ...auditsById.get(proposalIds[index]!)!, resultBoq: structuredClone(acceptedBoq), batchProposalIds: mutationProposalIds, sequence: lifecycle.sequence + 1 }
            const auditRef = db.doc(auditPath(boqId, runId, proposalIds[index]!))
            const actionRef = lifecycle.events.length === 0 ? auditRef : auditRef.collection('events').doc(`${lifecycle.sequence + 1}-accepted`)
            transaction.create(actionRef, audit)
            transaction.update(proposalRef, { lifecycleStatus: 'accepted', lifecycleRevision: lifecycle.sequence + 1, updatedAt: actionTimestamp })
          })
          return { status: 200, body: { status: 'accepted', acceptedProposalIds: [...proposalIds], boq: acceptedBoq, audits: proposalIds.map((id) => auditsById.get(id)!) } }
        })
      } catch {
        return { status: 500, body: { error: 'Proposal batch acceptance could not be saved' } }
      }
    },

    async addSourceItem(
      boqId: string,
      runId: string,
      proposalId: string,
      request: SourceBackedManualAddRequest,
      actorId: string,
    ): Promise<ProposalStoreResponse> {
      let immutable: Awaited<ReturnType<typeof loadImmutable>>
      try { immutable = await loadImmutable(boqId, runId) } catch { return { status: 404, body: { error: 'Extraction run not found' } } }
      if (!immutable) return { status: 404, body: { error: 'Extraction run not found' } }
      const existingProposalSnapshot = await db.doc(proposalPath(boqId, runId, proposalId)).get()
      const existingStatus = proposalRecordStatus(existingProposalSnapshot.data())
      if (existingStatus === 'rejected' || existingStatus === 'skipped' || existingStatus === 'undone') {
        return { status: 409, body: { error: existingStatus === 'rejected' || existingStatus === 'skipped' ? 'proposal_rejected' : 'Proposal is not pending' } }
      }
      const preflightLifecycle = await readProposalLifecycle(db, auditPath(boqId, runId, proposalId), 'pending', proposalId, runId)
      if (preflightLifecycle.status === 'rejected' || preflightLifecycle.status === 'skipped') {
        return { status: 409, body: { error: 'proposal_rejected' } }
      }
      try {
        return await db.runTransaction(async (transaction) => {
          const boqRef = db.collection('boqs').doc(boqId)
          const runRef = db.doc(extractionRunPath(boqId, runId))
          const auditRef = db.doc(auditPath(boqId, runId, proposalId))
          const proposalRef = db.doc(proposalPath(boqId, runId, proposalId))
          const [boqSnap, runSnap, proposalSnap] = await Promise.all([
            transaction.get(boqRef), transaction.get(runRef), transaction.get(proposalRef),
          ])
          if (!boqSnap.exists || !runSnap.exists || runSnap.data()?.status !== 'ready') {
            return { status: 404, body: { error: 'Extraction run not found' } }
          }
          const proposal = proposalSnap.exists ? storedProposal(proposalSnap.data(), proposalId) : null
          if (!proposal) return { status: 404, body: { error: 'Stored proposal not found' } }
          const lifecycle = await readProposalLifecycleInTransaction(
            transaction, db, auditPath(boqId, runId, proposalId), proposalRecordStatus(proposalSnap.data()), proposalId, runId,
          )
          if (!lifecycle || !lifecycleVersionMatches(proposalSnap, lifecycle)) return { status: 409, body: { error: 'Proposal lifecycle record is invalid' } }
          if (!await verifyImmutableContext(transaction, db, boqId, runId, runSnap, immutable)) {
            return { status: 409, body: { error: 'Extraction evidence changed; recheck the proposal' } }
          }
          const boq = { id: boqSnap.id, ...boqSnap.data() } as Boq
          if (boq.status === 'approved') return { status: 409, body: { error: 'Approved BOQs cannot be changed by extraction proposals' } }
          if (lifecycle.status === 'accepted' && lifecycle.currentAudit && auditIdentityValid(proposal, lifecycle.currentAudit)
            && lifecycle.currentAudit.resultBoq) {
            return { status: 200, body: { status: 'accepted', boq: structuredClone(lifecycle.currentAudit.resultBoq), audit: lifecycle.currentAudit, idempotent: true } }
          }
          if (lifecycle.status !== 'pending') {
            return { status: 409, body: { error: lifecycle.currentAudit?.status === 'rejected' ? 'proposal_rejected' : 'Proposal is not pending', ...(lifecycle.currentAudit ? { audit: lifecycle.currentAudit } : {}) } }
          }
          const storedStatus = proposalRecordStatus(proposalSnap.data())
          if (storedStatus === 'rejected' || storedStatus === 'skipped' || storedStatus === 'undone') {
            return { status: 409, body: { error: storedStatus === 'rejected' || storedStatus === 'skipped' ? 'proposal_rejected' : 'Proposal is not pending' } }
          }
          if (proposal.stale === true
            || proposal.baseSectionsFingerprint !== fingerprintCanonicalSections(boq.sections)) {
            return { status: 409, body: { error: 'Canonical BOQ changed; recheck the proposal' } }
          }
          const targetItems = new Map(boq.sections.flatMap((section) => section.items)
            .flatMap((item) => item.id ? [[item.id, item] as const] : []))
          let updatedBoq: Boq = boq
          try {
            if (proposal.reviewDraft) {
              if (request.mode !== 'single') return { status: 409, body: { error: 'single_required' } }
              const reconstruction = reconstructSourceMappedItem({
                mapping: proposal.reviewDraft.mapping,
                targetItemIds: proposal.targetItemIds,
                sourceRows: immutable.sourceRows,
                allowedSourceRowIds: new Set(proposal.sourceRowIds),
                sections: boq.sections,
                targetItems,
              })
              if (reconstruction.kind === 'invalid') {
                return { status: 400, body: { error: reconstruction.code } }
              }
              if (reconstruction.kind === 'candidate') {
                return { status: 409, body: { error: 'Proposal already resolves to a complete mapping' } }
              }
              const draft = reconstruction.draft
              const validatedSourceMapping: ValidatedSourceMapping = {
                sourceRowId: draft.sourceRowIds[0] ?? '',
                sourceRowIds: [...draft.sourceRowIds],
                ...(draft.sourceRefs[0] ? { sourceRef: { ...draft.sourceRefs[0] } } : {}),
              }
              const sourceCosts = sourceCostsFromResolvedValues(draft.resolvedValues)
              if (sourceCosts) validatedSourceMapping.sourceCosts = sourceCosts
              const result = addSourceBackedBoqItem({ boq, validatedSourceMapping, userValues: request.value, itemId: `user-${randomUUID()}` })
              updatedBoq = result.boq
            } else if (proposal.operation === 'needs_human_review' && proposal.targetItemIds.length === 0 && proposal.sourceRowIds.length > 1) {
              // Task 2 transitional guard: decision-batch logic is Task 3's scope.
              return { status: 409, body: { error: 'decision_batch_required' } }
            } else {
              if (proposal.operation !== 'needs_human_review' || proposal.targetItemIds.length !== 0) {
                return { status: 409, body: { error: 'Proposal is not eligible for manual insertion' } }
              }
              if (request.mode !== 'single') return { status: 409, body: { error: 'single_required' } }
              const rowsById = new Map(immutable.sourceRows.map((row) => [row.id, row]))
              const sourceRows = proposal.sourceRowIds.map((id) => rowsById.get(id))
              if (sourceRows.length === 0 || sourceRows.some((row) => row === undefined)) {
                return { status: 409, body: { error: 'Extraction evidence changed; recheck the proposal' } }
              }
              const first = sourceRows[0]!
              const validatedSourceMapping: ValidatedSourceMapping = {
                sourceRowId: first.id,
                sourceRowIds: [...proposal.sourceRowIds],
                sourceRef: { page: first.page, table: first.table, row: first.row },
              }
              const result = addSourceBackedBoqItem({ boq, validatedSourceMapping, userValues: request.value, itemId: `user-${randomUUID()}` })
              updatedBoq = result.boq
            }
          } catch (error) {
            if (error instanceof MissingBoqItemError) return { status: 400, body: { error: error.message } }
            throw error
          }
          const actionTimestamp = now().toISOString()
          const finalBoq = { ...updatedBoq, updatedAt: actionTimestamp }
          const audit = buildSourceItemAudit({
            proposal, beforeSections: boq.sections, afterSections: finalBoq.sections,
            actorId, now: actionTimestamp, sourceRows: immutable.sourceRows,
          })
          const acceptedAudit = { ...audit, resultBoq: structuredClone(finalBoq) }
          transaction.update(boqRef, {
            sections: finalBoq.sections,
            totalItems: finalBoq.totalItems,
            grandTotal: finalBoq.grandTotal,
            stdStatus: finalBoq.stdStatus,
            updatedAt: actionTimestamp,
          })
          const sequence = lifecycle.sequence + 1
          const sequencedAudit = { ...acceptedAudit, sequence }
          transaction.update(proposalRef, { lifecycleStatus: 'accepted', lifecycleRevision: sequence, updatedAt: actionTimestamp })
          const actionRef = lifecycle.events.length === 0 ? db.doc(auditPath(boqId, runId, proposalId)) : auditRef.collection('events').doc(`${sequence}-accepted`)
          transaction.create(actionRef, sequencedAudit)
          return { status: 200, body: { status: 'accepted', boq: finalBoq, audit: sequencedAudit } }
        })
      } catch {
        return { status: 500, body: { error: 'Source-backed item could not be added' } }
      }
    },
  }
}
