"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Check, ChevronRight, Loader2, Plus, Search, Sparkles } from "lucide-react"
import type { StandardEntry } from "@/lib/standard-schema"
import { normalizeCatalogText, rankCatalogMatches, type CatalogMatchCandidate } from "@/lib/standard-matching"

interface MatchContext {
  boqId: string
  sectionIndex: number
  itemId?: string
  itemCode?: string
}

interface Props {
  itemDesc: string
  itemUnit: string
  itemCode?: string
  sourceProject?: string
  sourceVendor?: string
  onMatch: (standardId: string, standardDesc: string, standardUnit: string) => Promise<void> | void
  onClose: () => void
  matchContext?: MatchContext
}

function reasonLabel(reason: CatalogMatchCandidate["matchReason"]): string {
  if (reason === "exact") return "Exact description"
  if (reason === "alias") return "Known alias"
  return "Fuzzy text match"
}

function confidenceLabel(candidate: CatalogMatchCandidate): string {
  if (!candidate.unitCompatible) return "Check unit"
  if (candidate.matchReason === "exact") return "High confidence"
  if (candidate.matchReason === "alias") return "Likely match"
  return "Review match"
}

type NormalizeRule = [string, string]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function applyNormalizeRules(value: string, rules: NormalizeRule[]): string {
  return rules.reduce((current, [find, replacement]) => {
    try {
      return current.replace(new RegExp(find, "gi"), replacement)
    } catch {
      return current
    }
  }, value)
}

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown }
    return typeof body.error === "string" ? body.error : fallback
  } catch {
    return fallback
  }
}

export function CatalogMatchModal({ itemDesc, itemUnit, sourceProject, sourceVendor, onMatch, onClose, matchContext }: Props) {
  const [open, setOpen] = useState(true)
  const [standards, setStandards] = useState<StandardEntry[]>([])
  const [search, setSearch] = useState("")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [applying, setApplying] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [aiMessage, setAiMessage] = useState<string | null>(null)
  const [newItemOpen, setNewItemOpen] = useState(false)
  const [unitMap, setUnitMap] = useState<Record<string, string>>({})
  const [normalizeRules, setNormalizeRules] = useState<NormalizeRule[]>([])
  const [newDescription, setNewDescription] = useState(itemDesc)
  const [newUnit, setNewUnit] = useState(itemUnit)
  const [newAliases, setNewAliases] = useState("")
  const aiControllerRef = useRef<AbortController | null>(null)

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError(null)
    try {
      const settingsPromise = fetch("/api/settings", { signal })
        .then(async (response) => response.ok ? await response.json() as unknown : null)
        .catch((settingsError) => {
          if (signal?.aborted || (settingsError instanceof DOMException && settingsError.name === "AbortError")) throw settingsError
          return null
        })
      const [res, settingsData] = await Promise.all([
        fetch("/api/standards", { signal }),
        settingsPromise,
      ])
      if (!res.ok) throw new Error(await readError(res, "The standard catalog could not be loaded."))
      const data: unknown = await res.json()
      if (!Array.isArray(data)) throw new Error("The standard catalog returned an invalid response.")
      setStandards(data as StandardEntry[])

      const fuzzy = isRecord(settingsData) && isRecord(settingsData.fuzzy) ? settingsData.fuzzy : null
      const nextUnitMap = fuzzy && isRecord(fuzzy.unitMap)
        ? Object.fromEntries(Object.entries(fuzzy.unitMap).filter(([, value]) => typeof value === "string")) as Record<string, string>
        : {}
      const nextNormalizeRules = fuzzy && Array.isArray(fuzzy.normalizeRules)
        ? fuzzy.normalizeRules.filter((rule): rule is NormalizeRule =>
            Array.isArray(rule) && rule.length === 2 && typeof rule[0] === "string" && typeof rule[1] === "string",
          )
        : []
      setUnitMap(nextUnitMap)
      setNormalizeRules(nextNormalizeRules)
    } catch (loadError) {
      if (loadError instanceof DOMException && loadError.name === "AbortError") return
      setStandards([])
      setError(loadError instanceof Error ? loadError.message : "The standard catalog could not be loaded.")
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void Promise.resolve().then(() => load(controller.signal))
    return () => {
      controller.abort()
      aiControllerRef.current?.abort()
    }
  }, [load])

  const rankedCandidates = useMemo(() => {
    const query = search.trim() || itemDesc.trim()
    const normalizedQuery = normalizeCatalogText(applyNormalizeRules(query, normalizeRules))
    if (!normalizedQuery) return []

    const rankingCatalog = standards.map((standard) => ({
      ...standard,
      description: applyNormalizeRules(standard.description, normalizeRules),
      aliases: (standard.aliases ?? []).map((alias) => applyNormalizeRules(alias, normalizeRules)),
    }))
    const ranked = rankCatalogMatches(normalizedQuery, itemUnit, rankingCatalog, unitMap)
      .map((candidate) => {
        const original = standards.find((standard) => standard.id === candidate.id)
        return original
          ? { ...candidate, description: original.description, unit: original.unit, aliases: original.aliases ?? [] }
          : candidate
      })

    return ranked
      .filter((candidate) => {
        if (candidate.score > 0) return true
        const searchable = [candidate.description, candidate.unit, ...candidate.aliases].map(normalizeCatalogText)
        return searchable.some((value) => value.includes(normalizedQuery))
      })
      .map((candidate) => candidate.score > 0 ? candidate : { ...candidate, score: 1 })
      .slice(0, 12)
  }, [itemDesc, itemUnit, normalizeRules, search, standards, unitMap])

  const selectedCandidate = selectedId
    ? rankedCandidates.find((candidate) => candidate.id === selectedId) ?? standards.find((standard) => standard.id === selectedId)
    : null
  const selectedMatchReason = selectedId
    ? rankedCandidates.find((candidate) => candidate.id === selectedId)?.matchReason ?? "fuzzy"
    : "fuzzy"
  const secondaryActionLabel = newItemOpen ? "Back to matches" : "Cancel"
  const primaryActionLabel = newItemOpen ? "Create and link item" : "Confirm match"

  const handleClose = () => {
    if (applying || aiLoading) return
    setOpen(false)
    onClose()
  }

  const handleApply = async () => {
    if (!selectedCandidate) return
    setApplying(true)
    setError(null)
    try {
      if (matchContext) {
        const res = await fetch("/api/standards/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...matchContext,
            standardId: selectedCandidate.id,
            confidence: selectedMatchReason === "exact" ? "exact" : "fuzzy",
          }),
        })
        if (!res.ok) throw new Error(await readError(res, "The match could not be applied."))
      }

      await onMatch(selectedCandidate.id, selectedCandidate.description, selectedCandidate.unit)
      setOpen(false)
      onClose()
    } catch (matchError) {
      setError(matchError instanceof Error ? matchError.message : "The match could not be applied. Try again.")
    } finally {
      setApplying(false)
    }
  }

  const suggestWithAi = async () => {
    if (standards.length === 0) return
    aiControllerRef.current?.abort()
    const controller = new AbortController()
    aiControllerRef.current = controller
    setAiLoading(true)
    setAiMessage(null)
    setError(null)
    try {
      const res = await fetch("/api/llm/standardize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          items: [{ key: "item", description: itemDesc, unit: itemUnit }],
        }),
      })
      if (!res.ok) throw new Error("AI suggestions are unavailable")
      const result = await res.json() as { suggestions?: Array<{ standardId: string; reason: string }> }
      const suggestion = result.suggestions?.[0]
      const candidate = suggestion ? standards.find((standard) => standard.id === suggestion.standardId) : undefined
      if (candidate) {
        setSelectedId(candidate.id)
        setAiMessage(`AI suggestion selected · ${suggestion?.reason || "Catalog match"}`)
      } else {
        setAiMessage("No safe catalog suggestion was returned. Fuzzy matching is still available.")
      }
    } catch (aiError) {
      if (controller.signal.aborted || (aiError instanceof DOMException && aiError.name === "AbortError")) return
      setAiMessage("AI suggestions are unavailable. Fuzzy matching is still available.")
    } finally {
      if (aiControllerRef.current === controller) {
        aiControllerRef.current = null
        setAiLoading(false)
      }
    }
  }

  const handleCreateNew = async () => {
    const description = newDescription.trim()
    const unit = newUnit.trim()
    if (!description || !unit) {
      setError("A catalog description and unit are required.")
      return
    }

    setApplying(true)
    setError(null)
    try {
      if (matchContext) {
        const res = await fetch("/api/standards/match", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...matchContext,
            confidence: "manual",
            newStandard: {
              description,
              unit,
              aliases: newAliases.split(",").map((alias) => alias.trim()).filter(Boolean),
            },
          }),
        })
        if (!res.ok) throw new Error(await readError(res, "The new catalog item could not be created."))
        const result = await res.json() as { standard?: { id?: unknown; description?: unknown } }
        const id = result.standard?.id
        const canonicalDescription = result.standard?.description
        if (typeof id !== "string" || typeof canonicalDescription !== "string") {
          throw new Error("The new catalog item response was invalid.")
        }
        await onMatch(id, canonicalDescription, unit)
      } else {
        const res = await fetch("/api/standards", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            description,
            unit,
            aliases: newAliases.split(",").map((alias) => alias.trim()).filter(Boolean),
          }),
        })
        if (!res.ok) throw new Error(await readError(res, "The new catalog item could not be created."))
        const result = await res.json() as { id?: unknown; description?: unknown }
        if (typeof result.id !== "string" || typeof result.description !== "string") {
          throw new Error("The new catalog item response was invalid.")
        }
        await onMatch(result.id, result.description, unit)
      }
      setOpen(false)
      onClose()
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "The new catalog item could not be created.")
    } finally {
      setApplying(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) handleClose() }}>
      <DialogContent className="max-h-[min(760px,calc(100vh-2rem))] overflow-y-auto sm:max-w-2xl" data-od-id="catalog-match-modal">
        <DialogHeader className="pr-8">
          <DialogTitle>Match BOQ item to catalog</DialogTitle>
          <DialogDescription>
            Choose a verified catalog entry so this item can flow into estimating with a consistent description and unit.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border border-border bg-muted/30 px-3 py-2.5 text-sm">
          <span className="text-xs uppercase tracking-[0.08em] text-muted-foreground">Source item</span>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <strong>{itemDesc}</strong>
            <span className="font-mono text-xs text-muted-foreground">{itemUnit || "unit not supplied"}</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">
            {sourceProject || "Current BOQ"}{sourceVendor ? ` · Vendor: ${sourceVendor}` : " · Vendor: —"}
          </div>
        </div>

        {!newItemOpen ? <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor="catalog-match-search" className="text-xs font-medium">Search active catalog</label>
            <div className="flex flex-wrap justify-end gap-2">
              {matchContext ? (
                <Button type="button" size="sm" variant="outline" onClick={() => setNewItemOpen(true)} disabled={applying} data-od-id="catalog-add-new">
                  <Plus /> Add new
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="outline" onClick={() => void suggestWithAi()} disabled={aiLoading || loading || standards.length === 0} data-od-id="catalog-ai-suggest">
                {aiLoading ? <Loader2 className="animate-spin" /> : <Sparkles />}
                {aiLoading ? "Checking…" : "Suggest with AI"}
              </Button>
            </div>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              id="catalog-match-search"
              value={search}
              onChange={(event) => { setSearch(event.target.value); setSelectedId(null); setAiMessage(null) }}
              placeholder="Search names, aliases, or units…"
              className="h-9 pl-8"
              autoFocus
              disabled={loading || applying}
              data-od-id="catalog-match-search"
            />
          </div>
          {aiMessage ? <p className="text-xs text-accent" role="status">{aiMessage}</p> : null}
        </div> : null}

        {error ? (
          <div className="catalog-modal-error" role="alert">
            <span>{error}</span>
            {standards.length === 0 ? <button className="btn btn-secondary btn-xs" onClick={() => void load()} data-od-id="catalog-match-retry">Try again</button> : null}
          </div>
        ) : null}

        {newItemOpen ? null : loading ? (
          <div className="flex h-48 items-center justify-center text-sm text-muted-foreground" aria-live="polite">
            <Loader2 className="mr-2 size-4 animate-spin" /> Loading active catalog…
          </div>
        ) : rankedCandidates.length > 0 ? (
          <div className="space-y-1.5" role="listbox" aria-label="Catalog matches" aria-activedescendant={selectedId ?? undefined}>
            {rankedCandidates.map((candidate) => {
              const selected = selectedId === candidate.id
              return (
                <button
                  key={candidate.id}
                  id={candidate.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => setSelectedId(selected ? null : candidate.id)}
                  className={`w-full rounded-lg border p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selected ? "border-accent bg-accent/8" : "border-border hover:border-accent/50 hover:bg-muted/30"}`}
                  data-od-id={`catalog-match-candidate-${candidate.id}`}
                >
                  <div className="flex items-start gap-3">
                    <span className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border ${selected ? "border-accent bg-accent text-white" : "border-border"}`} aria-hidden="true">
                      {selected ? <Check className="size-3" /> : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1">
                        <span className="font-medium">{candidate.description}</span>
                        <span className="font-mono text-xs text-muted-foreground">{candidate.unit}</span>
                      </span>
                      <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                        <span>{reasonLabel(candidate.matchReason)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{confidenceLabel(candidate)}</span>
                        {candidate.unitCompatible ? null : <span className="text-[#b88a00]">Incoming unit differs</span>}
                      </span>
                      {candidate.aliases.length > 0 ? <span className="mt-1 block truncate text-[11px] text-muted-foreground">Also known as {candidate.aliases.slice(0, 3).join(" · ")}</span> : null}
                    </span>
                    <ChevronRight className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${selected ? "translate-x-0.5 text-accent" : ""}`} aria-hidden="true" />
                  </div>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="space-y-3 rounded-lg border border-dashed border-border bg-muted/20 p-4" data-od-id="catalog-no-match">
            <div>
              <p className="text-sm font-medium">No verified catalog match</p>
              <p className="mt-1 text-xs text-muted-foreground">You can search again for an existing item, or create a new canonical entry from this BOQ item.</p>
            </div>
            {matchContext ? <p className="text-xs font-medium text-accent">Choose “Add new” above to create and link a canonical entry.</p> : null}
          </div>
        )}

        {newItemOpen ? (
          <div className="space-y-3 rounded-lg border border-accent/30 bg-accent/5 p-3" data-od-id="catalog-new-item-form">
            <div>
              <p className="text-sm font-medium">Create a canonical catalog entry</p>
              <p className="mt-1 text-xs text-muted-foreground">This creates the entry and links the source BOQ item in one save.</p>
            </div>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_110px]">
              <div>
                <label htmlFor="catalog-new-description" className="mb-1 block text-xs font-medium">Description</label>
                <Input id="catalog-new-description" value={newDescription} onChange={(event) => setNewDescription(event.target.value)} disabled={applying} data-od-id="catalog-new-description" />
              </div>
              <div>
                <label htmlFor="catalog-new-unit" className="mb-1 block text-xs font-medium">Unit</label>
                <Input id="catalog-new-unit" value={newUnit} onChange={(event) => setNewUnit(event.target.value)} disabled={applying} className="font-mono" data-od-id="catalog-new-unit" />
              </div>
            </div>
            <div>
              <label htmlFor="catalog-new-aliases" className="mb-1 block text-xs font-medium">Aliases <span className="font-normal text-muted-foreground">(optional)</span></label>
              <Input id="catalog-new-aliases" value={newAliases} onChange={(event) => setNewAliases(event.target.value)} disabled={applying} placeholder="Comma-separated source terms" data-od-id="catalog-new-aliases" />
            </div>
          </div>
        ) : null}

        <DialogFooter className="-mx-4 -mb-4 mt-1 flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {newItemOpen ? "The new entry will be linked to this BOQ line." : selectedCandidate ? `Selected: ${selectedCandidate.description}` : `${rankedCandidates.length} catalog ${rankedCandidates.length === 1 ? "candidate" : "candidates"}`}
          </span>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button type="button" variant="outline" onClick={newItemOpen ? () => setNewItemOpen(false) : handleClose} disabled={applying || aiLoading} className="flex-1 sm:flex-none" data-od-id={newItemOpen ? "catalog-new-back" : "catalog-cancel-match"}>{secondaryActionLabel}</Button>
            <Button type="button" onClick={() => void (newItemOpen ? handleCreateNew() : handleApply())} disabled={newItemOpen ? applying || !newDescription.trim() || !newUnit.trim() : !selectedCandidate || applying} data-od-id={newItemOpen ? "catalog-new-create" : "catalog-confirm-match"} className="flex-1 sm:flex-none">
              {applying ? <Loader2 className="animate-spin" /> : <Check />}
              {applying ? (newItemOpen ? "Creating…" : "Applying…") : primaryActionLabel}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
