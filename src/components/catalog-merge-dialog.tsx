"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import type { CatalogMergePreview } from "@/lib/catalog-merge"
import type { HistoricalPriceSummary } from "@/lib/catalog-historical-pricing"
import type { StandardEntry } from "@/lib/standard-schema"

export interface CatalogMergeResultSummary {
  keptId: string
  archivedIds: string[]
  quoteRows: number
  estimateRows: number
  conversions: number
}

function money(value: number): string {
  return `฿${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function priceLine(history: HistoricalPriceSummary | null | undefined, unit: string): string {
  if (!history || history.count === 0) return "No approved prices yet"
  const range = history.min === history.max ? "" : ` (${money(history.min)}–${money(history.max)})`
  return `${money(history.average)} / ${unit} from ${history.count} approved ${history.count === 1 ? "price" : "prices"}${range}`
}

/**
 * Pick which entry to keep, its final name/unit/aliases, see the combined
 * price history, then merge. Nothing is deleted: the others are archived and
 * the merge can be undone from the catalog row.
 */
export function CatalogMergeDialog({
  entries,
  initialKeepId,
  initialDescription,
  initialUnit,
  intro,
  onClose,
  onMerged,
}: {
  entries: StandardEntry[]
  initialKeepId?: string
  initialDescription?: string
  initialUnit?: string
  intro?: string
  onClose: () => void
  onMerged: (result: CatalogMergeResultSummary) => void
}) {
  const [keepId, setKeepId] = useState(initialKeepId ?? entries[0]?.id ?? "")
  const startEntry = entries.find((entry) => entry.id === keepId)
  const [description, setDescription] = useState(initialDescription ?? startEntry?.description ?? "")
  const [unit, setUnit] = useState(initialUnit ?? startEntry?.unit ?? "")
  const [fieldsEdited, setFieldsEdited] = useState(initialDescription !== undefined || initialUnit !== undefined)
  const [aliases, setAliases] = useState("")
  const [preview, setPreview] = useState<CatalogMergePreview | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState<string | null>(null)
  const ids = entries.map((entry) => entry.id)
  const idsKey = ids.join("|")

  useEffect(() => {
    const controller = new AbortController()
    void (async () => {
      setPreviewError(null)
      try {
        const response = await fetch("/api/standards/merge?preview=1", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keepId, mergeIds: ids.filter((id) => id !== keepId) }),
          signal: controller.signal,
        })
        const body = await response.json().catch(() => ({})) as { preview?: CatalogMergePreview; error?: string }
        if (!response.ok || !body.preview) throw new Error(body.error || "The preview could not be loaded.")
        setPreview(body.preview)
        setAliases(body.preview.suggested.aliases.join(", "))
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return
        setPreviewError(error instanceof Error ? error.message : "The preview could not be loaded.")
      }
    })()
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keepId, idsKey])

  const chooseKeep = (entry: StandardEntry) => {
    setKeepId(entry.id)
    if (!fieldsEdited) {
      setDescription(entry.description)
      setUnit(entry.unit)
    }
  }

  const merge = async () => {
    if (!description.trim() || !unit.trim()) {
      setMergeError("Name and unit are required.")
      return
    }
    setMerging(true)
    setMergeError(null)
    try {
      const response = await fetch("/api/standards/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          keepId,
          mergeIds: ids.filter((id) => id !== keepId),
          description: description.trim(),
          unit: unit.trim(),
          aliases: aliases.split(",").map((alias) => alias.trim()).filter(Boolean),
        }),
      })
      const body = await response.json().catch(() => ({})) as CatalogMergeResultSummary & { error?: string }
      if (!response.ok) throw new Error(body.error || "The items could not be merged.")
      onMerged(body)
    } catch (error) {
      setMergeError(error instanceof Error ? error.message : "The items could not be merged.")
    } finally {
      setMerging(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !merging) onClose() }}>
      <DialogContent className="sm:max-w-2xl" data-od-id="catalog-merge-dialog">
        <DialogHeader>
          <DialogTitle>Merge into one item</DialogTitle>
          <DialogDescription>
            {intro ?? "Prices, quote rows and unit conversions of all picked items move to the one you keep. The others are archived, not deleted, and you can undo this."}
          </DialogDescription>
        </DialogHeader>

        <fieldset className="space-y-2">
          <legend className="text-xs font-medium mb-1">Keep</legend>
          {entries.map((entry) => {
            const row = preview?.entries.find((candidate) => candidate.id === entry.id)
            return (
              <label key={entry.id} className="flex items-start gap-2 rounded-md border p-2 text-sm" data-od-id={`merge-keep-${entry.id}`}>
                <input type="radio" name="merge-keep" checked={keepId === entry.id} onChange={() => chooseKeep(entry)} disabled={merging} className="mt-1" />
                <span>
                  <span className="block font-medium">{entry.description} <span className="font-mono text-xs text-muted-foreground">({entry.unit})</span></span>
                  <span className="block text-xs text-muted-foreground">
                    {row ? `${priceLine(row.history, entry.unit)} · used in ${row.linkedRows} quote ${row.linkedRows === 1 ? "row" : "rows"}` : "Loading…"}
                  </span>
                </span>
              </label>
            )
          })}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-[1fr_6rem]">
          <div>
            <label htmlFor="merge-description" className="text-xs font-medium mb-1 block">Name to keep</label>
            <Input id="merge-description" value={description} onChange={(event) => { setDescription(event.target.value); setFieldsEdited(true) }} disabled={merging} data-od-id="merge-description" />
          </div>
          <div>
            <label htmlFor="merge-unit" className="text-xs font-medium mb-1 block">Unit</label>
            <Input id="merge-unit" value={unit} onChange={(event) => { setUnit(event.target.value); setFieldsEdited(true) }} disabled={merging} className="font-mono" data-od-id="merge-unit" />
          </div>
        </div>
        <div>
          <label htmlFor="merge-aliases" className="text-xs font-medium mb-1 block">Other names (aliases)</label>
          <Input id="merge-aliases" value={aliases} onChange={(event) => setAliases(event.target.value)} disabled={merging} data-od-id="merge-aliases" />
          <p className="text-[10px] text-muted-foreground mt-1">Separate with commas. The other items&apos; names are added so future quotes still match.</p>
        </div>

        <div className="rounded-lg border bg-muted/30 p-3 text-sm" data-od-id="merge-combined" aria-live="polite">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Price history after merging</p>
          {previewError ? (
            <p className="text-destructive">{previewError}</p>
          ) : preview ? (
            <>
              <p className="mt-1 font-medium">{priceLine(preview.combined, unit || "unit")}</p>
              <p className="text-xs text-muted-foreground">
                {preview.linkedRows} quote {preview.linkedRows === 1 ? "row" : "rows"} will point to the kept item
                {preview.conversions > 0 ? ` · ${preview.conversions} unit ${preview.conversions === 1 ? "conversion" : "conversions"} will move too` : ""}.
              </p>
              {preview.unitsDiffer ? (
                <p className="mt-1 text-xs text-amber-700" data-od-id="merge-units-differ">
                  These items use different units. Prices in another unit are left out of the average unless a unit conversion exists.
                </p>
              ) : null}
            </>
          ) : (
            <p className="mt-1 text-muted-foreground"><Loader2 className="inline w-3 h-3 animate-spin mr-1" />Loading…</p>
          )}
        </div>

        {mergeError ? <p className="text-sm text-destructive" role="alert">{mergeError}</p> : null}

        <DialogFooter>
          <button className="btn btn-ghost" onClick={onClose} disabled={merging} data-od-id="merge-cancel">Cancel</button>
          <button className="btn btn-primary" onClick={() => void merge()} disabled={merging || !preview} data-od-id="merge-confirm">
            {merging ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
            Merge {entries.length} items into one
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
