import { randomUUID } from 'node:crypto'
import type { Bucket } from '@google-cloud/storage'
import type { Firestore } from 'firebase-admin/firestore'
import type { PreflightStatus, PreflightUpload } from './boq-preflight-schema'

const CLEANUP_LEASE_MS = 5 * 60 * 1000
const MAX_CLEANUP_LIMIT = 200

export interface PreflightCreateInput extends PreflightUpload {
  ownerId: string
  sourceDigest: string
  sourceName?: string
  sourceType?: string
  sourceSize?: number
  expiresAt?: string
}

export interface PreflightRecord extends PreflightUpload {
  ownerId: string
  sourceDigest: string
  sourceName: string
  sourceType: string
  sourceSize: number
  expiresAt: string
  createdAt: string
  updatedAt: string
  cleanupState?: 'deleting'
  cleanupToken?: string
  cleanupLeaseExpiresAt?: string
  importReservationToken?: string | null
  importReservationLeaseExpiresAt?: string | null
}

export type PreflightConsumeOutcome = 'consumed' | 'missing' | 'conflict'

export interface PreflightUpdateConditions {
  expectedStatus?: PreflightStatus
  expectedReservationToken?: string | null
  expectedReservationLeaseExpiresAt?: string | null
}

export interface PreflightStore {
  create(input: PreflightCreateInput): Promise<PreflightRecord>
  getOwned(id: string, ownerId: string): Promise<PreflightRecord | null>
  update(
    id: string,
    ownerId: string,
    patch: Partial<PreflightUpload> & { preserveForRetry?: boolean; importReservationToken?: string | null; importReservationLeaseExpiresAt?: string | null },
    conditions?: PreflightUpdateConditions,
  ): Promise<PreflightRecord | null>
  consume?(id: string, ownerId: string, confirmedPages: number[]): Promise<PreflightConsumeOutcome>
  deleteArtifacts(id: string, ownerId: string): Promise<boolean>
  claimExpired(now: Date, limit: number): Promise<Array<{ id: string; ownerId: string }>>
}

export function preflightDocumentPath(ownerId: string, id: string): string {
  validatePart(ownerId, 'ownerId')
  validatePart(id, 'preflightId')
  return `preflightUploads/${ownerId}/uploads/${id}`
}

export function preflightArtifactPrefix(ownerId: string, id: string): string {
  validatePart(ownerId, 'ownerId')
  validatePart(id, 'preflightId')
  return `preflight/${ownerId}/${id}/`
}

function validateSourceDigest(value: string): void {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new TypeError('sourceDigest must be a full SHA-256 digest')
}

function validatePart(value: string, name: string): void {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('/')) throw new TypeError(`${name} must be one path segment`)
}

function validateLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CLEANUP_LIMIT) throw new TypeError(`Cleanup limit must be between 1 and ${MAX_CLEANUP_LIMIT}`)
}

function iso(value: Date): string { return value.toISOString() }

function artifactPaths(record: Pick<PreflightRecord, 'ownerId' | 'id' | 'pages'>): string[] {
  const prefix = preflightArtifactPrefix(record.ownerId, record.id)
  const paths = new Set([`${prefix}source.pdf`])
  for (const page of record.pages) {
    paths.add(`${prefix}previews/${page.page}.png`)
    paths.add(`${prefix}ocr/${page.page}.json`)
  }
  return [...paths]
}

function transitionAllowed(from: PreflightStatus, to: PreflightStatus): boolean {
  if (from === to) return true
  const transitions: Record<PreflightStatus, PreflightStatus[]> = {
    uploaded: ['analyzing', 'cancelled', 'expired', 'failed'],
    analyzing: ['ready', 'cancelled', 'expired', 'failed'],
    ready: ['analyzing', 'consumed', 'cancelled', 'expired', 'failed'],
    failed: ['analyzing', 'cancelled', 'expired'],
    consumed: [], cancelled: [], expired: [],
  }
  return transitions[from].includes(to)
}

export function createFirestorePreflightStore(db: Firestore, bucket: Bucket, now: () => Date = () => new Date()): PreflightStore {
  const refFor = (ownerId: string, id: string) => db.doc(preflightDocumentPath(ownerId, id))
  return {
    async create(input) {
      validatePart(input.ownerId, 'ownerId'); validatePart(input.id, 'preflightId'); validateSourceDigest(input.sourceDigest)
      if (!Number.isInteger(input.pageCount) || input.pageCount < 0) throw new TypeError('pageCount must be a non-negative integer')
      const timestamp = now()
      const record: PreflightRecord = {
        ...input,
        sourceName: input.sourceName ?? input.fileName,
        sourceType: input.sourceType ?? 'application/pdf',
        sourceSize: input.sourceSize ?? 0,
        expiresAt: input.expiresAt ?? iso(new Date(timestamp.getTime() + 24 * 60 * 60 * 1000)),
        createdAt: iso(timestamp), updatedAt: iso(timestamp),
      }
      const ref = refFor(input.ownerId, input.id)
      await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(ref)
        if (existing.exists) throw new Error('Preflight upload already exists')
        transaction.create(ref, record)
      })
      return record
    },

    async getOwned(id, ownerId) {
      const snapshot = await refFor(ownerId, id).get()
      if (!snapshot.exists) return null
      return { id: snapshot.id, ...snapshot.data() } as PreflightRecord
    },

    async update(id, ownerId, patch, conditions) {
      const ref = refFor(ownerId, id)
      const preserve = patch.preserveForRetry === true
      const changes = { ...patch }
      delete changes.preserveForRetry
      const updated = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref)
        if (!snapshot.exists) return null
        const current = snapshot.data() as PreflightRecord
        if (conditions?.expectedStatus !== undefined && current.status !== conditions.expectedStatus) {
          throw new Error(`Preflight status compare-and-set failed: expected ${conditions.expectedStatus}, got ${current.status}`)
        }
        if (conditions && 'expectedReservationToken' in conditions
          && (current.importReservationToken ?? null) !== conditions.expectedReservationToken) {
          throw new Error('Preflight reservation compare-and-set failed')
        }
        if (conditions && 'expectedReservationLeaseExpiresAt' in conditions
          && (current.importReservationLeaseExpiresAt ?? null) !== conditions.expectedReservationLeaseExpiresAt) {
          throw new Error('Preflight reservation lease compare-and-set failed')
        }
        if (changes.status && !transitionAllowed(current.status, changes.status)) throw new Error(`Invalid preflight transition: ${current.status} -> ${changes.status}`)
        const value = { ...changes, updatedAt: iso(now()) }
        transaction.update(ref, value)
        return { ...current, ...value, id } as PreflightRecord
      })
      if (!updated) return null
      if (['consumed', 'cancelled', 'expired'].includes(updated.status) || (updated.status === 'failed' && !preserve)) {
        await this.deleteArtifacts(id, ownerId)
        return null
      }
      return updated
    },

    async consume(id, ownerId, confirmedPages) {
      const ref = refFor(ownerId, id)
      const outcome = await db.runTransaction(async (transaction): Promise<PreflightConsumeOutcome> => {
        const snapshot = await transaction.get(ref)
        if (!snapshot.exists) return 'missing'
        const current = snapshot.data() as PreflightRecord
        if (current.status !== 'ready' || current.importReservationToken) return 'conflict'
        transaction.update(ref, {
          status: 'consumed',
          confirmedPages,
          updatedAt: iso(now()),
        })
        return 'consumed'
      })
      if (outcome === 'consumed') await this.deleteArtifacts(id, ownerId)
      return outcome
    },

    async deleteArtifacts(id, ownerId) {
      const ref = refFor(ownerId, id)
      const token = randomUUID()
      const claimed = await db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(ref)
        if (!snapshot.exists) return false
        const data = snapshot.data() as PreflightRecord
        const lease = Date.parse(data.cleanupLeaseExpiresAt ?? '')
        if (data.cleanupState === 'deleting' && !['consumed', 'cancelled', 'expired', 'failed'].includes(data.status)
          && Number.isFinite(lease) && lease > now().getTime()) return false
        transaction.update(ref, { cleanupState: 'deleting', cleanupToken: token, cleanupLeaseExpiresAt: iso(new Date(now().getTime() + CLEANUP_LEASE_MS)) })
        return true
      })
      if (!claimed) return false
      const snapshot = await ref.get()
      const data = snapshot.data() as PreflightRecord | undefined
      if (!data) return false
      for (const path of artifactPaths(data)) {
        try { await bucket.file(path).delete() } catch (error) {
          if ((error as { code?: number }).code !== 404) throw error
        }
      }
      await ref.delete()
      return true
    },

    async claimExpired(expiry, limit) {
      validateLimit(limit)
      const [expiryResult, reservationResult] = await Promise.all([
        db.collectionGroup('uploads').where('expiresAt', '<=', iso(expiry)).limit(limit).get(),
        db.collectionGroup('uploads').where('importReservationLeaseExpiresAt', '<=', iso(expiry)).limit(limit).get(),
      ])
      const candidates = new Map<string, typeof expiryResult.docs[number]>()
      for (const snapshot of [...expiryResult.docs, ...reservationResult.docs]) candidates.set(snapshot.ref.path, snapshot)
      const claimed: Array<{ id: string; ownerId: string }> = []
      for (const snapshot of [...candidates.values()].slice(0, limit)) {
        const owner = snapshot.ref.parent.parent?.id
        if (!owner) continue
        const ok = await db.runTransaction(async (transaction) => {
          const current = await transaction.get(snapshot.ref)
          if (!current.exists) return false
          const data = current.data() as PreflightRecord
          const cleanupTime = now()
          const reservationLease = Date.parse(data.importReservationLeaseExpiresAt ?? '')
          if (data.importReservationToken
            && (!Number.isFinite(reservationLease) || reservationLease > cleanupTime.getTime())) return false
          if (['consumed', 'cancelled', 'expired'].includes(data.status)) return false
          const lease = Date.parse(data.cleanupLeaseExpiresAt ?? '')
          if (data.cleanupState === 'deleting' && Number.isFinite(lease) && lease > cleanupTime.getTime()) return false
          transaction.update(snapshot.ref, { status: 'expired', cleanupState: 'deleting', cleanupToken: randomUUID(), cleanupLeaseExpiresAt: iso(new Date(cleanupTime.getTime() + CLEANUP_LEASE_MS)), updatedAt: iso(cleanupTime) })
          return true
        })
        if (ok) claimed.push({ id: snapshot.id, ownerId: owner })
      }
      return claimed
    },
  }
}

export async function cleanupExpiredPreflightUploads(store: PreflightStore, now: Date, limit = 100): Promise<number> {
  validateLimit(limit)
  const claimed = await store.claimExpired(now, limit)
  if (!Array.isArray(claimed) || claimed.length > limit) throw new Error('Preflight cleanup result was malformed')
  let deleted = 0
  for (const item of claimed) if (await store.deleteArtifacts(item.id, item.ownerId)) deleted += 1
  return deleted
}
