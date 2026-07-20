"use client"

import { Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import type {
  CatalogRowLocator,
  InlineCatalogRowState,
} from "@/components/use-inline-catalog-matching"

interface InlineCatalogCellProps {
  locator: CatalogRowLocator
  state: InlineCatalogRowState
  readOnly: boolean
  disabled: boolean
  onAccept: (locator: CatalogRowLocator) => Promise<void> | void
  onAiSuggest: (locator: CatalogRowLocator) => Promise<void> | void
  onDismiss: (locator: CatalogRowLocator) => void
  onFindMatch: (locator: CatalogRowLocator) => void
  onExclude: (locator: CatalogRowLocator) => void
  onClearError: (key: string) => void
}

function ActionButton({ children, disabled, onClick }: {
  children: React.ReactNode
  disabled: boolean
  onClick: () => void
}) {
  return (
    <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={onClick}>
      {children}
    </Button>
  )
}

export function InlineCatalogCell({
  locator,
  state,
  readOnly,
  disabled,
  onAccept,
  onAiSuggest,
  onDismiss,
  onFindMatch,
  onExclude,
  onClearError,
}: InlineCatalogCellProps) {
  const isBusy = state.busy !== null
  const actionsDisabled = disabled || isBusy
  const matched = locator.item.stdStatus === "matched"
  const excluded = locator.item.stdStatus === "excluded"

  return (
    <div
      className="inline-catalog-cell"
      data-od-id={`inline-catalog-${locator.key}`}
      aria-live="polite"
      aria-busy={isBusy}
    >
      {matched ? (
        <>
          <div className="inline-catalog-status catalog-status-matched">
            <span className="catalog-status-dot" aria-hidden="true" />
            <span>Matched</span>
          </div>
          <div className="inline-catalog-description">{locator.item.stdMatch ?? locator.item.desc}</div>
          <div className="inline-catalog-unit">{locator.item.unit}</div>
          {!readOnly && (
            <div className="inline-catalog-actions">
              <ActionButton disabled={actionsDisabled} onClick={() => onFindMatch(locator)}>Change</ActionButton>
            </div>
          )}
        </>
      ) : excluded ? (
        <>
          <div className="inline-catalog-status">Excluded</div>
          {locator.item.stdExclusionReason && (
            <div className="inline-catalog-reason">{locator.item.stdExclusionReason}</div>
          )}
          {!readOnly && (
            <div className="inline-catalog-actions">
              <ActionButton disabled={actionsDisabled} onClick={() => onFindMatch(locator)}>Find match</ActionButton>
            </div>
          )}
        </>
      ) : state.suggestion ? (
        <>
          <div className="inline-catalog-status">Suggested</div>
          <div className="inline-catalog-description">{state.suggestion.description}</div>
          <div className="inline-catalog-meta">
            <span>{state.suggestion.unit}</span>
            <span>{state.suggestion.reason}</span>
          </div>
          {!readOnly && (
            <div className="inline-catalog-actions">
              <ActionButton disabled={actionsDisabled} onClick={() => { void onAccept(locator) }}>Accept</ActionButton>
              <ActionButton disabled={actionsDisabled} onClick={() => onFindMatch(locator)}>Find another</ActionButton>
              <ActionButton disabled={actionsDisabled} onClick={() => onDismiss(locator)}>Dismiss</ActionButton>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="inline-catalog-status">Unmatched</div>
          {!readOnly && (
            <div className="inline-catalog-actions">
              <ActionButton disabled={actionsDisabled} onClick={() => { void onAiSuggest(locator) }}>AI suggest</ActionButton>
              <ActionButton disabled={actionsDisabled} onClick={() => onFindMatch(locator)}>Find match</ActionButton>
              <ActionButton disabled={actionsDisabled} onClick={() => onExclude(locator)}>Exclude</ActionButton>
            </div>
          )}
        </>
      )}

      {isBusy && (
        <div className="inline-catalog-progress">
          <Loader2 className="size-3 animate-spin" aria-hidden="true" />
          {state.busy === "ai" ? "Finding a suggestion…" : "Applying…"}
        </div>
      )}
      {state.error && (
        <div className="inline-catalog-error" role="alert">
          <span>{state.error}</span>
          {!readOnly && (
            <ActionButton disabled={false} onClick={() => onClearError(locator.key)}>Clear message</ActionButton>
          )}
        </div>
      )}
    </div>
  )
}
