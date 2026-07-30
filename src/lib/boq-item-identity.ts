import type { BoqItem, BoqSection } from './boq-schema'

export interface BoqItemRequestIdentity {
  itemId?: string
  itemCode?: string
}

export type BoqItemIdentity =
  | { kind: 'id'; value: string }
  | { kind: 'code'; value: string }

export type BoqItemIdentityResolution =
  | { status: 'found'; index: number }
  | { status: 'missing' | 'not-found' | 'ambiguous' }

export interface BoqItemLocation {
  identityKey: string
  sectionIndex: number
  itemIndex: number
  item: BoqItem
}

export type BoqItemLocationResolution =
  | { status: 'found'; location: BoqItemLocation }
  | { status: 'not-found' | 'ambiguous' }

function cleanIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim()
  return cleaned || undefined
}

export function getBoqItemIdentity(item: Pick<BoqItem, 'id' | 'code'>): BoqItemIdentity | undefined {
  const itemId = cleanIdentity(item.id)
  if (itemId) return { kind: 'id', value: itemId }

  const itemCode = cleanIdentity(item.code)
  return itemCode ? { kind: 'code', value: itemCode } : undefined
}

export function getBoqItemRequestIdentity(item: Pick<BoqItem, 'id' | 'code'>): BoqItemRequestIdentity {
  const identity = getBoqItemIdentity(item)
  if (!identity) return {}
  return identity.kind === 'id' ? { itemId: identity.value } : { itemCode: identity.value }
}

export function getBoqItemIdentityKey(item: Pick<BoqItem, 'id' | 'code'>): string | undefined {
  const identity = getBoqItemIdentity(item)
  return identity ? `${identity.kind}:${identity.value}` : undefined
}

export function parseBoqItemRequestIdentity(input: Record<string, unknown>): BoqItemRequestIdentity | undefined {
  if ('itemId' in input && typeof input.itemId !== 'string') return undefined
  if ('itemCode' in input && typeof input.itemCode !== 'string') return undefined

  const itemId = cleanIdentity(input.itemId)
  const itemCode = cleanIdentity(input.itemCode)
  if ((!itemId && !itemCode) || (itemId?.length ?? 0) > 200 || (itemCode?.length ?? 0) > 200) return undefined
  return { ...(itemId ? { itemId } : {}), ...(itemCode ? { itemCode } : {}) }
}

export function resolveBoqItemIdentity(
  items: Array<Pick<BoqItem, 'id' | 'code'>>,
  request: BoqItemRequestIdentity,
): BoqItemIdentityResolution {
  const itemId = cleanIdentity(request.itemId)
  const itemCode = cleanIdentity(request.itemCode)
  const identity = itemId
    ? { kind: 'id' as const, value: itemId }
    : itemCode
      ? { kind: 'code' as const, value: itemCode }
      : undefined
  if (!identity) return { status: 'missing' }

  const matches: number[] = []
  items.forEach((item, index) => {
    const candidate = identity.kind === 'id' ? cleanIdentity(item.id) : cleanIdentity(item.code)
    if (candidate === identity.value) matches.push(index)
  })
  if (matches.length === 0) return { status: 'not-found' }
  if (matches.length > 1) return { status: 'ambiguous' }
  return { status: 'found', index: matches[0]! }
}

export function resolveBoqItemIdentityKey(
  sections: BoqSection[],
  identityKey: string,
): BoqItemLocationResolution {
  const matches: Array<{ sectionIndex: number; itemIndex: number; item: BoqItem }> = []
  sections.forEach((section, sectionIndex) => {
    section.items.forEach((item, itemIndex) => {
      if (getBoqItemIdentityKey(item) === identityKey) {
        matches.push({ sectionIndex, itemIndex, item })
      }
    })
  })

  if (matches.length === 0) return { status: 'not-found' }
  if (matches.length > 1) return { status: 'ambiguous' }
  const match = matches[0]!
  return {
    status: 'found',
    location: {
      identityKey,
      sectionIndex: match.sectionIndex,
      itemIndex: match.itemIndex,
      item: match.item,
    },
  }
}
