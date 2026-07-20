import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { InlineCatalogCell } from './inline-catalog-cell'
import {
  buildAcceptMatchRequest,
  buildRowLlmRequest,
  createInlineCatalogMatchingController,
  loadInlineCatalogSources,
  type CatalogRowLocator,
  type InlineCatalogRowState,
} from './use-inline-catalog-matching'
import type { Boq, BoqPricedItem } from '@/lib/boq-schema'
import { isPricedBoqItem } from '@/lib/boq-pricing'
import type { InlineCatalogSuggestion } from '@/lib/inline-catalog-suggestion'
import type { StandardEntry } from '@/lib/standard-schema'

function item(overrides: Partial<BoqPricedItem> = {}): BoqPricedItem {
  return {
    id: 'item-1',
    code: 'A-1',
    desc: 'Source concrete',
    unit: 'm3',
    qty: 2,
    rate: 100,
    total: 200,
    type: 'unit',
    stdStatus: 'unmatched',
    ...overrides,
  }
}

function locator(overrides: Partial<CatalogRowLocator> = {}): CatalogRowLocator {
  return {
    key: '0:item-1',
    sectionIndex: 0,
    itemIndex: 0,
    item: item(),
    ...overrides,
  }
}

function boq(overrides: Partial<Boq> = {}): Boq {
  return {
    id: 'boq-1',
    project: 'Project',
    vendor: 'Vendor',
    workType: 'Structural',
    date: '2026-07-19',
    totalItems: 1,
    grandTotal: 200,
    status: 'parsed',
    stdStatus: 'none',
    sections: [{ header: 'Concrete', items: [item()] }],
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  }
}

function firstPricedItem(value: Boq): BoqPricedItem {
  const candidate = value.sections[0]?.items[0]
  assert.ok(candidate && isPricedBoqItem(candidate))
  return candidate
}

function standard(overrides: Partial<StandardEntry> = {}): StandardEntry {
  return {
    id: 'std-1',
    description: 'Ready-mix concrete C30',
    unit: 'm3',
    aliases: [],
    sourceBoqCount: 0,
    createdAt: '',
    updatedAt: '',
    ...overrides,
  }
}

const suggestion: InlineCatalogSuggestion = {
  standardId: 'std-1',
  description: 'Ready-mix concrete C30',
  unit: 'm3',
  source: 'local',
  confidence: 'fuzzy',
  reason: 'Similar',
}

const idleState: InlineCatalogRowState = { suggestion: null, busy: null, error: null }
const callbacks = {
  onAccept: () => undefined,
  onAiSuggest: () => undefined,
  onDismiss: () => undefined,
  onFindMatch: () => undefined,
  onExclude: () => undefined,
  onClearError: () => undefined,
}

test('suggested cell exposes the canonical match, explicit actions, and live status', () => {
  const html = renderToStaticMarkup(
    createElement(InlineCatalogCell, {
      locator: locator(),
      state: { ...idleState, suggestion },
      readOnly: false,
      disabled: false,
      ...callbacks,
    }),
  )

  assert.match(html, /Ready-mix concrete C30/)
  assert.match(html, /m3/)
  assert.match(html, /Similar/)
  assert.match(html, />Accept</)
  assert.match(html, />Find another</)
  assert.match(html, />Dismiss</)
  assert.match(html, /aria-live="polite"/)
  assert.match(html, /aria-busy="false"/)
})

test('unmatched cell offers only row-local matching actions', () => {
  const html = renderToStaticMarkup(
    createElement(InlineCatalogCell, {
      locator: locator(), state: idleState, readOnly: false, disabled: false, ...callbacks,
    }),
  )

  assert.match(html, />AI suggest</)
  assert.match(html, />Find match</)
  assert.match(html, />Exclude</)
  assert.doesNotMatch(html, />Accept</)
})

test('matched cell shows a blue-dot status and Change only while editable', () => {
  const matched = locator({ item: item({ stdStatus: 'matched', stdMatch: 'Concrete C30 catalog', unit: 'm³' }) })
  const editable = renderToStaticMarkup(
    createElement(InlineCatalogCell, {
      locator: matched, state: idleState, readOnly: false, disabled: false, ...callbacks,
    }),
  )
  const readOnly = renderToStaticMarkup(
    createElement(InlineCatalogCell, {
      locator: matched, state: idleState, readOnly: true, disabled: false, ...callbacks,
    }),
  )

  assert.match(editable, /catalog-status-dot/)
  assert.match(editable, />Matched</)
  assert.match(editable, /Concrete C30 catalog/)
  assert.match(editable, />Change</)
  assert.match(readOnly, />Matched</)
  assert.match(readOnly, /Concrete C30 catalog/)
  assert.doesNotMatch(readOnly, />Change</)
  assert.doesNotMatch(readOnly, /<button/)
})

test('read-only suggested cell retains canonical information but hides every mutation action', () => {
  const html = renderToStaticMarkup(
    createElement(InlineCatalogCell, {
      locator: locator(), state: { ...idleState, suggestion }, readOnly: true, disabled: false, ...callbacks,
    }),
  )

  assert.match(html, /Ready-mix concrete C30/)
  assert.doesNotMatch(html, /<button/)
  assert.doesNotMatch(html, />Accept|>Find another|>Dismiss|>AI suggest|>Find match|>Exclude|>Change/)
})

test('request builders preserve the stable row key, item identity, and confidence', () => {
  const row = locator()
  assert.deepEqual(buildRowLlmRequest(row), {
    items: [{ key: '0:item-1', description: 'Source concrete', unit: 'm3' }],
  })
  assert.deepEqual(buildAcceptMatchRequest('boq-1', row, suggestion), {
    boqId: 'boq-1',
    sectionIndex: 0,
    itemId: 'item-1',
    itemCode: 'A-1',
    standardId: 'std-1',
    confidence: 'fuzzy',
  })
})

test('a second AI request for one row aborts the first and keeps only the latest response', async () => {
  let current = boq()
  const signals: AbortSignal[] = []
  let call = 0
  const fetchImpl: typeof fetch = async (_input, init) => {
    call += 1
    const signal = init?.signal as AbortSignal
    signals.push(signal)
    if (call === 1) {
      return await new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })
    }
    return Response.json({ suggestions: [{ key: '0:item-1', standardId: 'std-2' }] })
  }
  const controller = createInlineCatalogMatchingController({
    getBoq: () => current,
    onBoqChange: (next) => { current = next },
    fetchImpl,
  })
  controller.setCatalog([standard({ id: 'std-2', description: 'Latest AI result' })], {})

  const first = controller.suggestWithAi(locator())
  const second = controller.suggestWithAi(locator())
  await Promise.all([first, second])

  assert.equal(signals[0]?.aborted, true)
  assert.equal(controller.rowState(locator()).suggestion?.description, 'Latest AI result')
  assert.equal(controller.rowState(locator()).busy, null)
})

test('route-changed AI results are ignored', async () => {
  let current = boq()
  let resolveResponse!: (response: Response) => void
  const response = new Promise<Response>((resolve) => { resolveResponse = resolve })
  const controller = createInlineCatalogMatchingController({
    getBoq: () => current,
    onBoqChange: (next) => { current = next },
    fetchImpl: async () => await response,
  })
  controller.setCatalog([standard()], {})

  const request = controller.suggestWithAi(locator())
  current = boq({ id: 'boq-2' })
  resolveResponse(Response.json({ suggestions: [{ key: '0:item-1', standardId: 'std-1' }] }))
  await request

  assert.equal(controller.rowState(locator()).suggestion, null)
})

test('editing a row after AI completes ignores its stale result and restores local matching', async () => {
  let current = boq()
  const requests: Array<{ input: string; body: Record<string, unknown> }> = []
  const controller = createInlineCatalogMatchingController({
    getBoq: () => current,
    onBoqChange: (next) => { current = next },
    fetchImpl: async (input, init) => {
      requests.push({ input: String(input), body: JSON.parse(String(init?.body)) })
      if (String(input) === '/api/llm/standardize') {
        return Response.json({ suggestions: [{ key: '0:item-1', standardId: 'std-ai' }] })
      }
      return Response.json({ boq: current })
    },
  })
  controller.setCatalog([
    standard({ id: 'std-ai', description: 'AI catalog candidate', unit: 'm3' }),
    standard({ id: 'std-local', description: 'Replacement material', unit: 'kg' }),
  ], {})

  const initial = locator({ item: firstPricedItem(current) })
  await controller.suggestWithAi(initial)
  assert.equal(controller.rowState(initial).suggestion?.standardId, 'std-ai')

  current = boq({ sections: [{ header: 'Concrete', items: [item({ desc: 'Replacement material', unit: 'kg' })] }] })
  const edited = locator({ item: firstPricedItem(current) })
  assert.equal(controller.rowState(edited).suggestion?.standardId, 'std-local')

  await controller.acceptSuggestion(edited)

  assert.deepEqual(requests.map((request) => request.input), ['/api/llm/standardize', '/api/standards/match'])
  assert.equal(requests[1]?.body.standardId, 'std-local')
})

test('Accept posts the atomic match payload and consumes the returned BOQ', async () => {
  let current = boq({ sections: [{ header: 'Concrete', items: [item({ desc: 'Ready-mix concrete C30' })] }] })
  const returned = boq({ id: 'boq-1', stdStatus: 'complete', sections: [{ header: 'Concrete', items: [item({ stdStatus: 'matched', stdId: 'std-1', stdMatch: 'Ready-mix concrete C30' })] }] })
  const requests: Array<{ input: string; init?: RequestInit }> = []
  let changed: Boq | null = null
  const controller = createInlineCatalogMatchingController({
    getBoq: () => current,
    onBoqChange: (next) => { changed = next; current = next },
    fetchImpl: async (input, init) => {
      requests.push({ input: String(input), init })
      return Response.json({ boq: returned })
    },
  })
  controller.setCatalog([standard()], {})

  await controller.acceptSuggestion(locator({ item: firstPricedItem(current) }))

  assert.equal(requests[0]?.input, '/api/standards/match')
  assert.equal(requests[0]?.init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    boqId: 'boq-1',
    sectionIndex: 0,
    itemId: 'item-1',
    itemCode: 'A-1',
    standardId: 'std-1',
    confidence: 'exact',
  })
  assert.deepEqual(changed, returned)
})

test('a failed Accept stays row-local and preserves other row suggestions', async () => {
  const firstItem = item({ id: 'item-1', desc: 'Ready-mix concrete C30' })
  const secondItem = item({ id: 'item-2', code: 'A-2', desc: 'Structural steel' })
  let current = boq({ sections: [{ header: 'Items', items: [firstItem, secondItem] }] })
  const controller = createInlineCatalogMatchingController({
    getBoq: () => current,
    onBoqChange: (next) => { current = next },
    fetchImpl: async () => Response.json({ error: 'Match rejected' }, { status: 409 }),
  })
  controller.setCatalog([
    standard({ id: 'std-concrete', description: 'Ready-mix concrete C30' }),
    standard({ id: 'std-steel', description: 'Structural steel' }),
  ], {})
  const first = locator({ key: '0:item-1', itemIndex: 0, item: firstItem })
  const second = locator({ key: '0:item-2', itemIndex: 1, item: secondItem })

  await controller.acceptSuggestion(first)

  assert.equal(controller.rowState(first).error, 'Match rejected')
  assert.equal(controller.rowState(second).error, null)
  assert.equal(controller.rowState(second).suggestion?.standardId, 'std-steel')
})

test('concurrent Accepts are serialized so older BOQ snapshots cannot overwrite newer results', async () => {
  const firstItem = item({ id: 'item-1', code: 'A-1', desc: 'Ready-mix concrete C30' })
  const secondItem = item({ id: 'item-2', code: 'A-2', desc: 'Structural steel' })
  let current = boq({ sections: [{ header: 'Items', items: [firstItem, secondItem] }] })
  const firstReturned = boq({
    updatedAt: '2026-07-19T01:00:00.000Z',
    sections: [{ header: 'Items', items: [item({ ...firstItem, stdStatus: 'matched' }), secondItem] }],
  })
  const secondReturned = boq({
    updatedAt: '2026-07-19T02:00:00.000Z',
    sections: [{
      header: 'Items',
      items: [item({ ...firstItem, stdStatus: 'matched' }), item({ ...secondItem, stdStatus: 'matched' })],
    }],
  })
  let resolveFirst!: (response: Response) => void
  let resolveSecond!: (response: Response) => void
  let markSecondStarted!: () => void
  const firstResponse = new Promise<Response>((resolve) => { resolveFirst = resolve })
  const secondResponse = new Promise<Response>((resolve) => { resolveSecond = resolve })
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve })
  const requests: string[] = []
  const changes: Boq[] = []
  const controller = createInlineCatalogMatchingController({
    getBoq: () => current,
    onBoqChange: (next) => { changes.push(next); current = next },
    fetchImpl: async (_input, init) => {
      const standardId = JSON.parse(String(init?.body)).standardId as string
      requests.push(standardId)
      if (standardId === 'std-steel') markSecondStarted()
      return standardId === 'std-concrete' ? await firstResponse : await secondResponse
    },
  })
  controller.setCatalog([
    standard({ id: 'std-concrete', description: 'Ready-mix concrete C30' }),
    standard({ id: 'std-steel', description: 'Structural steel' }),
  ], {})
  const first = locator({ key: '0:item-1', itemIndex: 0, item: firstItem })
  const second = locator({ key: '0:item-2', itemIndex: 1, item: secondItem })

  const firstAccept = controller.acceptSuggestion(first)
  const secondAccept = controller.acceptSuggestion(second)
  await Promise.resolve()

  assert.deepEqual(requests, ['std-concrete'])
  resolveFirst(Response.json({ boq: firstReturned }))
  await firstAccept
  await secondStarted
  assert.deepEqual(requests, ['std-concrete', 'std-steel'])
  resolveSecond(Response.json({ boq: secondReturned }))
  await secondAccept

  assert.deepEqual(changes, [firstReturned, secondReturned])
  assert.deepEqual(current, secondReturned)
})

test('dispose immediately invalidates an in-flight Accept response', async () => {
  let current = boq({ sections: [{ header: 'Concrete', items: [item({ desc: 'Ready-mix concrete C30' })] }] })
  let changed: Boq | null = null
  let resolveResponse!: (response: Response) => void
  const response = new Promise<Response>((resolve) => { resolveResponse = resolve })
  const controller = createInlineCatalogMatchingController({
    getBoq: () => current,
    onBoqChange: (next) => { changed = next; current = next },
    fetchImpl: async () => await response,
  })
  controller.setCatalog([standard()], {})

  const request = controller.acceptSuggestion(locator({ item: firstPricedItem(current) }))
  controller.dispose()
  resolveResponse(Response.json({ boq: boq({ stdStatus: 'complete' }) }))
  await request

  assert.equal(changed, null)
})

test('the hook synchronizes its latest BOQ context before passive effects', () => {
  const source = readFileSync(new URL('./use-inline-catalog-matching.ts', import.meta.url), 'utf8')
  const hookStart = source.indexOf('export function useInlineCatalogMatching')
  const contextUpdate = source.indexOf('context.update(boq, onBoqChange)', hookStart)
  const firstEffect = source.indexOf('useEffect(', hookStart)

  assert.notEqual(contextUpdate, -1)
  assert.ok(contextUpdate < firstEffect)
})

test('settings failure falls back to an empty unit map without discarding loaded standards', async () => {
  const catalog = [standard()]
  const requests: string[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url === '/api/standards') return Response.json(catalog)
    return Response.json({ error: 'Settings unavailable' }, { status: 503 })
  }

  const result = await loadInlineCatalogSources(fetchImpl)

  assert.deepEqual(requests.sort(), ['/api/settings', '/api/standards'])
  assert.deepEqual(result, { standards: catalog, unitMap: {} })
})

test('an early settings abort remains attached while the standards request is pending', async () => {
  const abortError = new DOMException('Aborted', 'AbortError')
  const fetchImpl: typeof fetch = async (input) => {
    if (String(input) === '/api/settings') throw abortError
    await new Promise((resolve) => setTimeout(resolve, 0))
    return Response.json([standard()])
  }

  await assert.rejects(loadInlineCatalogSources(fetchImpl), abortError)
})

test('the hook loads catalog and fuzzy settings once for each BOQ route', () => {
  const source = readFileSync(new URL('./use-inline-catalog-matching.ts', import.meta.url), 'utf8')
  assert.match(source, /fetchImpl\("\/api\/standards"/)
  assert.match(source, /fetchImpl\("\/api\/settings"/)
  assert.match(source, /loadInlineCatalogSources\(fetch, requestController\.signal\)/)
  assert.match(source, /\[boq\.id, context, controller\]/)
})

test('the cell never renders an unlabeled X action', () => {
  const source = readFileSync(new URL('./inline-catalog-cell.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(source, />\s*[x×] *<|aria-label=["'](?:close|dismiss)["']/i)
})
