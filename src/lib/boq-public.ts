import type { Boq } from './boq-schema'

export type PublicBoq = Omit<Boq, 'sourceStoragePath' | 'sourceDigest'> & { sourceAvailable: boolean }

export function toPublicBoq(boq: Boq): PublicBoq {
  // The file fingerprint stays server-side, like the storage path.
  const { sourceStoragePath, sourceDigest: _sourceDigest, ...safe } = boq
  void _sourceDigest
  return {
    ...safe,
    sourceAvailable: Boolean(sourceStoragePath),
  }
}
