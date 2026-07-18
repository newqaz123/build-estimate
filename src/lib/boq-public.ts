import type { Boq } from './boq-schema'

export type PublicBoq = Omit<Boq, 'sourceStoragePath'> & { sourceAvailable: boolean }

export function toPublicBoq(boq: Boq): PublicBoq {
  const { sourceStoragePath, ...safe } = boq
  return {
    ...safe,
    sourceAvailable: Boolean(sourceStoragePath),
  }
}
