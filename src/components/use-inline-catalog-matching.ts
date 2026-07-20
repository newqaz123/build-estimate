"use client"

import { useEffect, useReducer, useState } from "react"
import type { Boq, BoqPricedItem } from "@/lib/boq-schema"
import {
  qualifyingLocalSuggestions,
  suggestionFromLlmResponse,
  type InlineCatalogSuggestion,
} from "@/lib/inline-catalog-suggestion"
import type { StandardEntry } from "@/lib/standard-schema"

export interface CatalogRowLocator {
  key: string
  sectionIndex: number
  itemIndex: number
  item: BoqPricedItem
}

export interface InlineCatalogRowState {
  suggestion: InlineCatalogSuggestion | null
  busy: "ai" | "accept" | "exclude" | null
  error: string | null
}

interface ControllerOptions {
  getBoq: () => Boq
  onBoqChange: (boq: Boq) => void
  fetchImpl?: typeof fetch
  onStateChange?: () => void
}

function createLatestHookContext(initialBoq: Boq, initialOnBoqChange: (boq: Boq) => void) {
  let currentBoq = initialBoq
  let currentOnBoqChange = initialOnBoqChange
  return {
    getBoq: () => currentBoq,
    applyBoqChange: (nextBoq: Boq) => currentOnBoqChange(nextBoq),
    update: (nextBoq: Boq, nextOnBoqChange: (boq: Boq) => void) => {
      currentBoq = nextBoq
      currentOnBoqChange = nextOnBoqChange
    },
  }
}

type RowBusy = InlineCatalogRowState["busy"]

interface AiSuggestionSnapshot {
  suggestion: InlineCatalogSuggestion
  desc: string
  unit: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body: unknown = await response.json()
    return isRecord(body) && typeof body.error === "string" ? body.error : fallback
  } catch {
    return fallback
  }
}

function safeUnitMap(settings: unknown): Record<string, string> {
  if (!isRecord(settings) || !isRecord(settings.fuzzy) || !isRecord(settings.fuzzy.unitMap)) return {}
  return Object.fromEntries(
    Object.entries(settings.fuzzy.unitMap).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

export async function loadInlineCatalogSources(
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<{ standards: StandardEntry[]; unitMap: Record<string, string> }> {
  const settingsPromise = fetchImpl("/api/settings", { signal })
    .then(async (response) => response.ok ? await response.json() as unknown : null)
    .catch((error: unknown) => {
      if (signal?.aborted || isAbortError(error)) throw error
      return null
    })
  const standardsResponse = await fetchImpl("/api/standards", { signal })
  if (!standardsResponse.ok) throw new Error("The standard catalog could not be loaded.")
  const standardsResult: unknown = await standardsResponse.json()
  if (!Array.isArray(standardsResult)) throw new Error("The standard catalog returned an invalid response.")
  const settingsResult = await settingsPromise
  return {
    standards: standardsResult as StandardEntry[],
    unitMap: safeUnitMap(settingsResult),
  }
}

export function buildRowLlmRequest(locator: CatalogRowLocator): {
  items: [{ key: string; description: string; unit: string }]
} {
  return {
    items: [{ key: locator.key, description: locator.item.desc, unit: locator.item.unit }],
  }
}

export function buildAcceptMatchRequest(
  boqId: string,
  locator: CatalogRowLocator,
  suggestion: InlineCatalogSuggestion,
): {
  boqId: string
  sectionIndex: number
  itemId?: string
  itemCode?: string
  standardId: string
  confidence: "exact" | "fuzzy" | "llm"
} {
  return {
    boqId,
    sectionIndex: locator.sectionIndex,
    ...(locator.item.id ? { itemId: locator.item.id } : {}),
    ...(locator.item.code ? { itemCode: locator.item.code } : {}),
    standardId: suggestion.standardId,
    confidence: suggestion.confidence,
  }
}

export interface InlineCatalogMatchingController {
  setCatalog: (standards: StandardEntry[], unitMap: Record<string, string>) => void
  resetForBoq: (boqId: string) => void
  rowState: (locator: CatalogRowLocator) => InlineCatalogRowState
  acceptSuggestion: (locator: CatalogRowLocator) => Promise<void>
  suggestWithAi: (locator: CatalogRowLocator) => Promise<void>
  dismissSuggestion: (locator: CatalogRowLocator) => void
  clearRowError: (key: string) => void
  dispose: () => void
}

export function createInlineCatalogMatchingController({
  getBoq,
  onBoqChange,
  fetchImpl = fetch,
  onStateChange = () => undefined,
}: ControllerOptions): InlineCatalogMatchingController {
  let standards: StandardEntry[] = []
  let unitMap: Record<string, string> = {}
  let activeBoqId = getBoq().id
  let lifecycleGeneration = 0
  let disposed = false
  let acceptQueue: Promise<void> = Promise.resolve()
  const aiSuggestions = new Map<string, AiSuggestionSnapshot>()
  const dismissedIds = new Map<string, Set<string>>()
  const busy = new Map<string, RowBusy>()
  const errors = new Map<string, string>()
  const aiControllers = new Map<string, AbortController>()
  const acceptControllers = new Set<AbortController>()

  const notify = () => onStateChange()
  const setBusy = (key: string, value: RowBusy) => {
    if (value) busy.set(key, value)
    else busy.delete(key)
  }

  const suggestionFor = (locator: CatalogRowLocator): InlineCatalogSuggestion | null => {
    if (locator.item.stdStatus === "matched" || locator.item.stdStatus === "excluded") return null
    const aiSuggestion = aiSuggestions.get(locator.key)
    if (aiSuggestion && aiSuggestion.desc === locator.item.desc && aiSuggestion.unit === locator.item.unit) {
      return aiSuggestion.suggestion
    }
    if (aiSuggestion) aiSuggestions.delete(locator.key)
    return qualifyingLocalSuggestions(
      locator.item,
      standards,
      unitMap,
      dismissedIds.get(locator.key) ?? new Set<string>(),
    )[0] ?? null
  }

  const resetForBoq = (boqId: string) => {
    lifecycleGeneration += 1
    disposed = false
    for (const controller of aiControllers.values()) controller.abort()
    for (const controller of acceptControllers) controller.abort()
    aiControllers.clear()
    acceptControllers.clear()
    acceptQueue = Promise.resolve()
    aiSuggestions.clear()
    dismissedIds.clear()
    busy.clear()
    errors.clear()
    standards = []
    unitMap = {}
    activeBoqId = boqId
    notify()
  }

  return {
    setCatalog(nextStandards, nextUnitMap) {
      if (disposed) return
      standards = nextStandards
      unitMap = nextUnitMap
      notify()
    },

    resetForBoq,

    rowState(locator) {
      return {
        suggestion: suggestionFor(locator),
        busy: busy.get(locator.key) ?? null,
        error: errors.get(locator.key) ?? null,
      }
    },

    async acceptSuggestion(locator) {
      const suggestion = suggestionFor(locator)
      if (!suggestion || disposed) return
      const boqId = getBoq().id
      const requestGeneration = lifecycleGeneration
      setBusy(locator.key, "accept")
      errors.delete(locator.key)
      notify()

      const task = acceptQueue.then(async () => {
        if (
          disposed
          || lifecycleGeneration !== requestGeneration
          || getBoq().id !== boqId
          || activeBoqId !== boqId
        ) return

        const requestController = new AbortController()
        acceptControllers.add(requestController)
        try {
          const response = await fetchImpl("/api/standards/match", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: requestController.signal,
            body: JSON.stringify(buildAcceptMatchRequest(boqId, locator, suggestion)),
          })
          if (!response.ok) throw new Error(await responseError(response, "The catalog match could not be applied."))
          const result: unknown = await response.json()
          if (!isRecord(result) || !isRecord(result.boq)) {
            throw new Error("The catalog match returned an invalid BOQ.")
          }
          if (
            requestController.signal.aborted
            || disposed
            || lifecycleGeneration !== requestGeneration
            || getBoq().id !== boqId
            || activeBoqId !== boqId
          ) return
          aiSuggestions.delete(locator.key)
          dismissedIds.delete(locator.key)
          onBoqChange(result.boq as unknown as Boq)
        } catch (error) {
          if (requestController.signal.aborted || isAbortError(error)) return
          if (
            disposed
            || lifecycleGeneration !== requestGeneration
            || getBoq().id !== boqId
            || activeBoqId !== boqId
          ) return
          errors.set(locator.key, error instanceof Error ? error.message : "The catalog match could not be applied.")
        } finally {
          acceptControllers.delete(requestController)
          if (
            !disposed
            && lifecycleGeneration === requestGeneration
            && getBoq().id === boqId
            && activeBoqId === boqId
          ) {
            setBusy(locator.key, null)
            notify()
          }
        }
      })
      acceptQueue = task.catch(() => undefined)
      await task
    },

    async suggestWithAi(locator) {
      if (disposed) return
      aiControllers.get(locator.key)?.abort()
      const controller = new AbortController()
      aiControllers.set(locator.key, controller)
      const boqId = getBoq().id
      const requestGeneration = lifecycleGeneration
      setBusy(locator.key, "ai")
      errors.delete(locator.key)
      notify()

      try {
        const response = await fetchImpl("/api/llm/standardize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify(buildRowLlmRequest(locator)),
        })
        if (!response.ok) throw new Error(await responseError(response, "AI suggestions are unavailable for this row."))
        const result: unknown = await response.json()
        if (
          controller.signal.aborted
          || disposed
          || lifecycleGeneration !== requestGeneration
          || aiControllers.get(locator.key) !== controller
          || getBoq().id !== boqId
          || activeBoqId !== boqId
        ) return

        const suggestion = suggestionFromLlmResponse(result, standards, locator.key)
        if (suggestion) {
          aiSuggestions.set(locator.key, {
            suggestion,
            desc: locator.item.desc,
            unit: locator.item.unit,
          })
        } else {
          aiSuggestions.delete(locator.key)
          errors.set(locator.key, "No safe catalog suggestion was found for this row.")
        }
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return
        if (
          disposed
          || lifecycleGeneration !== requestGeneration
          || getBoq().id !== boqId
          || activeBoqId !== boqId
        ) return
        errors.set(locator.key, error instanceof Error ? error.message : "AI suggestions are unavailable for this row.")
      } finally {
        if (aiControllers.get(locator.key) === controller) {
          aiControllers.delete(locator.key)
          if (
            !disposed
            && lifecycleGeneration === requestGeneration
            && getBoq().id === boqId
            && activeBoqId === boqId
          ) {
            setBusy(locator.key, null)
            notify()
          }
        }
      }
    },

    dismissSuggestion(locator) {
      const suggestion = suggestionFor(locator)
      if (!suggestion) return
      const rowDismissed = dismissedIds.get(locator.key) ?? new Set<string>()
      rowDismissed.add(suggestion.standardId)
      dismissedIds.set(locator.key, rowDismissed)
      aiSuggestions.delete(locator.key)
      errors.delete(locator.key)
      notify()
    },

    clearRowError(key) {
      if (!errors.delete(key)) return
      notify()
    },

    dispose() {
      lifecycleGeneration += 1
      disposed = true
      for (const controller of aiControllers.values()) controller.abort()
      for (const controller of acceptControllers) controller.abort()
      aiControllers.clear()
      acceptControllers.clear()
      acceptQueue = Promise.resolve()
      busy.clear()
    },
  }
}

export function useInlineCatalogMatching({
  boq,
  onBoqChange,
  disabled,
}: {
  boq: Boq
  onBoqChange: (boq: Boq) => void
  disabled: boolean
}): {
  rowState: (locator: CatalogRowLocator) => InlineCatalogRowState
  acceptSuggestion: (locator: CatalogRowLocator) => Promise<void>
  suggestWithAi: (locator: CatalogRowLocator) => Promise<void>
  dismissSuggestion: (locator: CatalogRowLocator) => void
  clearRowError: (key: string) => void
} {
  const [, render] = useReducer((value: number) => value + 1, 0)
  const [{ context, controller }] = useState(() => {
    const context = createLatestHookContext(boq, onBoqChange)
    return {
      context,
      controller: createInlineCatalogMatchingController({
        getBoq: context.getBoq,
        onBoqChange: context.applyBoqChange,
        onStateChange: () => render(),
      }),
    }
  })
  context.update(boq, onBoqChange)

  useEffect(() => {
    const requestController = new AbortController()
    controller.resetForBoq(boq.id)

    void loadInlineCatalogSources(fetch, requestController.signal).then(({ standards, unitMap }) => {
      if (!requestController.signal.aborted && context.getBoq().id === boq.id) {
        controller.setCatalog(standards, unitMap)
      }
    }).catch((error: unknown) => {
      if (requestController.signal.aborted || isAbortError(error)) return
      controller.setCatalog([], {})
    })

    return () => requestController.abort()
  }, [boq.id, context, controller])

  useEffect(() => () => controller.dispose(), [controller])

  return {
    rowState: (locator) => controller.rowState(locator),
    acceptSuggestion: async (locator) => {
      if (disabled) return
      await controller.acceptSuggestion(locator)
    },
    suggestWithAi: async (locator) => {
      if (disabled) return
      await controller.suggestWithAi(locator)
    },
    dismissSuggestion: (locator) => {
      if (disabled) return
      controller.dismissSuggestion(locator)
    },
    clearRowError: (key) => controller.clearRowError(key),
  }
}
