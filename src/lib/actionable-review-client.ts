import type { SourceBackedItemRequest } from './boq-user-entry'
import type { ActionableReview } from './actionable-review-projection'
import {
  actionableReviewReducer,
  beginActionableReviewRequest,
  canMutateActionableReview,
  createActionableReviewRequestGeneration,
  invalidateActionableReviewRequests,
  isLatestActionableReviewRequest,
  isSuggestionMutable,
  normalizeActionableReviewResponse,
  type ActionableReviewAction,
  type ActionableReviewState,
  type ActionableReviewVersionScope,
  type ActionableReviewRequestGeneration,
} from './actionable-review-state'

export interface ActionableReviewTransportRequest {
  method: 'GET' | 'POST'
  path: string
  body?: unknown
  signal: AbortSignal
}

export interface ActionableReviewTransportResponse {
  status: number
  json(): Promise<unknown>
}

export interface ActionableReviewTransport {
  call(request: ActionableReviewTransportRequest): Promise<ActionableReviewTransportResponse>
}

export type ActionableReviewClientDecisionRequest =
  | {
      action: 'dismiss'
      expectedFingerprint: string
      note?: string
    }
  | {
      action: 'add_pending_catalog'
      expectedFingerprint: string
      item: SourceBackedItemRequest
      correctionReason?: string
    }

export interface ActionableReviewClient {
  load(boqId: string, runId: string, fingerprint: string): Promise<ActionableReview | null>
  generate(boqId: string, runId: string, mode: 'shadow' | 'focused'): Promise<ActionableReview | null>
  decide(
    boqId: string,
    runId: string,
    suggestionId: string,
    request: ActionableReviewClientDecisionRequest,
  ): Promise<boolean>
  restore(boqId: string, runId: string, suggestionId: string): Promise<boolean>
  cancel(): void
}

export interface CreateActionableReviewClientOptions {
  transport: ActionableReviewTransport
  dispatch: (action: ActionableReviewAction) => void
  getSnapshot: () => ActionableReviewState['snapshot']
  getExpectedVersions: () => ActionableReviewVersionScope | null
  readOnly?: boolean
  onUnauthorized?: () => void
  timeoutMs?: number
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (value && typeof value === 'object' && 'error' in value) {
    const error = (value as { error?: unknown }).error
    if (typeof error === 'string' && error.trim() !== '') return error.trim()
  }
  return fallback
}

async function responseError(response: ActionableReviewTransportResponse, fallback: string): Promise<Error> {
  try {
    return new Error(errorMessage(await response.json(), fallback))
  } catch {
    return new Error(fallback)
  }
}

function encodePath(value: string): string {
  return encodeURIComponent(value)
}

function snapshotPayload(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value) && 'snapshot' in value) {
    return (value as { snapshot?: unknown }).snapshot
  }
  return value
}

function boundedDecisionRequest(request: ActionableReviewClientDecisionRequest): ActionableReviewClientDecisionRequest {
  if (request.action === 'dismiss') {
    const note = request.note?.trim()
    return {
      action: 'dismiss',
      expectedFingerprint: request.expectedFingerprint,
      ...(note ? { note: note.slice(0, 500) } : {}),
    }
  }

  const item = request.item
  return {
    action: 'add_pending_catalog',
    expectedFingerprint: request.expectedFingerprint,
    item: {
      sectionIndex: item.sectionIndex,
      desc: item.desc,
      unit: item.unit,
      qty: item.qty,
      materialCost: item.materialCost,
      labourCost: item.labourCost,
    },
    ...(request.correctionReason?.trim()
      ? { correctionReason: request.correctionReason.trim().slice(0, 500) }
      : {}),
  }
}

function requestFailureMessage(
  cause: unknown,
  signal: AbortSignal,
  cancelledMessage: string,
  fallback: string,
): string {
  if (signal.aborted) return cancelledMessage
  if (cause instanceof Error) return cause.message
  return fallback
}

function createRequestController(
  current: AbortController | null,
  timeoutMs: number,
): { controller: AbortController; timeout: ReturnType<typeof setTimeout> } {
  current?.abort()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  return { controller, timeout }
}

export function createActionableReviewClient(
  options: CreateActionableReviewClientOptions,
): ActionableReviewClient {
  const timeoutMs = options.timeoutMs ?? 30_000
  const generation: ActionableReviewRequestGeneration = createActionableReviewRequestGeneration()
  let currentController: AbortController | null = null

  const failLoad = (requestGeneration: number, message: string): null => {
    if (isLatestActionableReviewRequest(generation, requestGeneration)) {
      options.dispatch({ type: 'load_failed', error: message })
    }
    return null
  }

  const callSnapshot = async (
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    requestGeneration: number,
  ): Promise<ActionableReview | null> => {
    const request = createRequestController(currentController, timeoutMs)
    currentController = request.controller
    try {
      const response = await options.transport.call({
        method,
        path,
        ...(body === undefined ? {} : { body }),
        signal: request.controller.signal,
      })
      if (!isLatestActionableReviewRequest(generation, requestGeneration)) return null
      if (response.status === 401) {
        options.onUnauthorized?.()
        return failLoad(requestGeneration, 'Session expired. Please sign in again.')
      }
      if (response.status < 200 || response.status >= 300) {
        throw await responseError(response, 'Actionable review request failed.')
      }
      const normalized = normalizeActionableReviewResponse(snapshotPayload(await response.json()))
      if (!normalized) throw new Error('Actionable review returned an unsupported snapshot.')
      options.dispatch({ type: 'load_succeeded', snapshot: normalized })
      return normalized
    } catch (cause) {
      if (!isLatestActionableReviewRequest(generation, requestGeneration)) return null
      if (request.controller.signal.aborted) {
        return failLoad(requestGeneration, 'Actionable review request was cancelled.')
      }
      return failLoad(
        requestGeneration,
        cause instanceof Error ? cause.message : 'Actionable review request failed.',
      )
    } finally {
      clearTimeout(request.timeout)
      if (currentController === request.controller) currentController = null
    }
  }

  const ensureWritable = (error: string): boolean => {
    if (!options.readOnly) return true
    options.dispatch({ type: 'load_failed', error })
    return false
  }

  const client: ActionableReviewClient = {
    async load(boqId, runId, fingerprint) {
      const requestGeneration = beginActionableReviewRequest(generation)
      options.dispatch({ type: 'load_started' })
      return callSnapshot(
        'GET',
        `/api/boqs/${encodePath(boqId)}/extraction-runs/${encodePath(runId)}/actionable-review?fingerprint=${encodeURIComponent(fingerprint)}`,
        undefined,
        requestGeneration,
      )
    },

    async generate(boqId, runId, mode) {
      if (!ensureWritable('Actionable review generation is unavailable in read-only mode.')) return null
      const requestGeneration = beginActionableReviewRequest(generation)
      options.dispatch({ type: 'load_started' })
      return callSnapshot(
        'POST',
        `/api/boqs/${encodePath(boqId)}/extraction-runs/${encodePath(runId)}/actionable-review`,
        { mode },
        requestGeneration,
      )
    },

    async decide(boqId, runId, suggestionId, request) {
      if (!ensureWritable('Actionable review decisions are unavailable in read-only mode.')) return false
      const snapshot = options.getSnapshot()
      const expectedVersions = options.getExpectedVersions()
      if (!snapshot || request.expectedFingerprint !== snapshot.id || !isSuggestionMutable(snapshot, suggestionId, expectedVersions, false)) {
        options.dispatch({
          type: 'decision_failed',
          suggestionId,
          error: 'This actionable review is stale or the suggestion is no longer pending.',
        })
        return false
      }
      const requestGeneration = beginActionableReviewRequest(generation)
      options.dispatch({ type: 'decision_started', suggestionId })
      const requestState = createRequestController(currentController, timeoutMs)
      currentController = requestState.controller
      try {
        const response = await options.transport.call({
          method: 'POST',
          path: `/api/boqs/${encodePath(boqId)}/extraction-runs/${encodePath(runId)}/actionable-review/${encodePath(suggestionId)}/decision`,
          body: boundedDecisionRequest(request),
          signal: requestState.controller.signal,
        })
        if (!isLatestActionableReviewRequest(generation, requestGeneration)) return false
        if (response.status === 401) {
          options.onUnauthorized?.()
          throw new Error('Session expired. Please sign in again.')
        }
        if (response.status < 200 || response.status >= 300) {
          throw await responseError(response, 'Actionable review decision failed.')
        }
        options.dispatch({ type: 'decision_succeeded', suggestionId })
        return true
      } catch (cause) {
        if (!isLatestActionableReviewRequest(generation, requestGeneration)) return false
        options.dispatch({
          type: 'decision_failed',
          suggestionId,
          error: requestFailureMessage(
            cause,
            requestState.controller.signal,
            'Actionable review decision was cancelled.',
            'Actionable review decision failed.',
          ),
        })
        return false
      } finally {
        clearTimeout(requestState.timeout)
        if (currentController === requestState.controller) currentController = null
      }
    },

    async restore(boqId, runId, suggestionId) {
      if (!ensureWritable('Actionable review restore is unavailable in read-only mode.')) return false
      const snapshot = options.getSnapshot()
      const expectedVersions = options.getExpectedVersions()
      const suggestion = snapshot?.actionableItemSuggestions.find((entry) => entry.id === suggestionId)
      if (!snapshot || !suggestion || suggestion.status !== 'dismissed' || !canMutateActionableReview(snapshot, expectedVersions, false)) {
        options.dispatch({ type: 'decision_failed', suggestionId, error: 'This actionable review is stale or the suggestion cannot be restored.' })
        return false
      }
      const requestGeneration = beginActionableReviewRequest(generation)
      options.dispatch({ type: 'decision_started', suggestionId })
      const requestState = createRequestController(currentController, timeoutMs)
      currentController = requestState.controller
      try {
        const response = await options.transport.call({
          method: 'POST',
          path: `/api/boqs/${encodePath(boqId)}/extraction-runs/${encodePath(runId)}/actionable-review/${encodePath(suggestionId)}/decision`,
          body: { action: 'restore', expectedFingerprint: snapshot.id },
          signal: requestState.controller.signal,
        })
        if (!isLatestActionableReviewRequest(generation, requestGeneration)) return false
        if (response.status === 401) {
          options.onUnauthorized?.()
          throw new Error('Session expired. Please sign in again.')
        }
        if (response.status < 200 || response.status >= 300) {
          throw await responseError(response, 'Actionable review restore failed.')
        }
        options.dispatch({ type: 'decision_succeeded', suggestionId })
        return true
      } catch (cause) {
        if (!isLatestActionableReviewRequest(generation, requestGeneration)) return false
        options.dispatch({
          type: 'decision_failed',
          suggestionId,
          error: requestFailureMessage(
            cause,
            requestState.controller.signal,
            'Actionable review restore was cancelled.',
            'Actionable review restore failed.',
          ),
        })
        return false
      } finally {
        clearTimeout(requestState.timeout)
        if (currentController === requestState.controller) currentController = null
      }
    },

    cancel() {
      invalidateActionableReviewRequests(generation)
      currentController?.abort()
      currentController = null
      options.dispatch({ type: 'requests_cancelled' })
    },
  }

  return client
}

export { actionableReviewReducer }
