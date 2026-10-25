"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { HumanApprovedCatalogConversionRule } from "@/lib/catalog-conversion"
import type { StandardEntry } from "@/lib/standard-schema"

type Rule = HumanApprovedCatalogConversionRule

const money = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export interface ConversionEffect {
  standardId: string
  description: string
  unit: string
  convertedCount: number
  totalCount: number
  average: number
}

/** Which catalog items a rule changes, read from the price history the server already converted. */
export function conversionEffects(rule: Pick<Rule, "id">, standards: StandardEntry[]): ConversionEffect[] {
  const effects: ConversionEffect[] = []
  for (const standard of standards) {
    const pricing = standard.historicalPricing
    if (!pricing) continue
    const convertedCount = pricing.sources.filter((source) => source.converted?.ruleId === rule.id).length
    if (convertedCount === 0) continue
    effects.push({
      standardId: standard.id,
      description: standard.description,
      unit: standard.unit,
      convertedCount,
      totalCount: pricing.count,
      average: pricing.average,
    })
  }
  return effects
}

export function describeRule(rule: Pick<Rule, "sourceUnit" | "catalogUnit" | "catalogUnitsPerSourceUnit">): string {
  return `1 ${rule.sourceUnit} = ${rule.catalogUnitsPerSourceUnit} ${rule.catalogUnit}`
}

export function CatalogConversionsPanel({
  standards,
  onChanged,
}: {
  standards: StandardEntry[]
  onChanged: () => void | Promise<void>
}) {
  const [rules, setRules] = useState<Rule[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sourceUnit, setSourceUnit] = useState("")
  const [factor, setFactor] = useState("")
  const [catalogUnit, setCatalogUnit] = useState("")
  const [catalogId, setCatalogId] = useState("")
  const [saving, setSaving] = useState(false)
  const [removingId, setRemovingId] = useState<string | null>(null)

  const loadRules = useCallback(async () => {
    try {
      const res = await fetch("/api/catalog-conversions")
      if (!res.ok) throw new Error("Could not load unit conversions.")
      const body = await res.json() as { rules: Rule[] }
      setRules(body.rules.filter((rule) => !rule.archivedAt))
      setError(null)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Could not load unit conversions.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => { void loadRules() }, 0)
    return () => clearTimeout(timer)
  }, [loadRules])

  const activeStandards = standards.filter((standard) => !standard.archivedAt)
  const chosenItem = activeStandards.find((standard) => standard.id === catalogId)

  const pickItem = (id: string) => {
    setCatalogId(id)
    const item = activeStandards.find((standard) => standard.id === id)
    if (item && !catalogUnit.trim()) setCatalogUnit(item.unit)
  }

  const addRule = async () => {
    const payload: Record<string, string> = {
      sourceUnit: sourceUnit.trim(),
      catalogUnit: catalogUnit.trim(),
      catalogUnitsPerSourceUnit: factor.trim(),
      scope: catalogId ? "catalog_item" : "global",
    }
    if (catalogId) payload.catalogId = catalogId
    if (!payload.sourceUnit || !payload.catalogUnit || !payload.catalogUnitsPerSourceUnit) {
      toast.error("Fill in both units and the number.")
      return
    }
    setSaving(true)
    try {
      const res = await fetch("/api/catalog-conversions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({})) as { error?: string }
      if (!res.ok) throw new Error(body.error ?? "Could not save the conversion.")
      toast.success(`Saved: ${describeRule(payload as unknown as Rule)}`)
      setSourceUnit("")
      setFactor("")
      setCatalogUnit("")
      setCatalogId("")
      await loadRules()
      await onChanged()
    } catch (saveError) {
      toast.error(saveError instanceof Error ? saveError.message : "Could not save the conversion.")
    } finally {
      setSaving(false)
    }
  }

  const removeRule = async (rule: Rule) => {
    if (!confirm(`Stop using ${describeRule(rule)}? Prices in ${rule.sourceUnit} will no longer be compared with ${rule.catalogUnit}.`)) return
    setRemovingId(rule.id)
    try {
      const res = await fetch("/api/catalog-conversions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rule.id }),
      })
      if (!res.ok) throw new Error("Could not remove the conversion.")
      toast.success("Conversion removed")
      await loadRules()
      await onChanged()
    } catch (removeError) {
      toast.error(removeError instanceof Error ? removeError.message : "Could not remove the conversion.")
    } finally {
      setRemovingId(null)
    }
  }

  return (
    <div className="space-y-4" data-od-id="catalog-conversions">
      <p className="text-sm text-muted-foreground">
        Some quotes price an item in a different unit, for example per เส้น (length) instead of per metre.
        Tell the app how the units relate and those prices are counted in price history and compared fairly.
      </p>

      <div className="rounded-md border p-3 space-y-3" data-od-id="conversion-form">
        <div className="text-sm font-medium">Add a conversion</div>
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Quoted unit</span>
            <input className="input w-28" value={sourceUnit} onChange={(event) => setSourceUnit(event.target.value)} placeholder="เส้น" data-od-id="conversion-source-unit" />
          </label>
          <span className="pb-2">1 of these =</span>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">How many</span>
            <input className="input w-24" inputMode="decimal" value={factor} onChange={(event) => setFactor(event.target.value)} placeholder="4" data-od-id="conversion-factor" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Catalog unit</span>
            <input className="input w-28" value={catalogUnit} onChange={(event) => setCatalogUnit(event.target.value)} placeholder="m" data-od-id="conversion-catalog-unit" />
          </label>
          <label className="flex flex-col gap-1 min-w-56">
            <span className="text-xs text-muted-foreground">Use for</span>
            <select className="input" value={catalogId} onChange={(event) => pickItem(event.target.value)} data-od-id="conversion-scope">
              <option value="">All catalog items</option>
              {activeStandards.map((standard) => (
                <option key={standard.id} value={standard.id}>Only: {standard.description} ({standard.unit})</option>
              ))}
            </select>
          </label>
          <button className="btn btn-primary btn-sm" onClick={() => void addRule()} disabled={saving} data-od-id="conversion-add">
            {saving && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
            Save conversion
          </button>
        </div>
        {sourceUnit.trim() && factor.trim() && catalogUnit.trim() ? (
          <p className="text-xs text-muted-foreground" data-od-id="conversion-example">
            Example: a price of 100.00 per {sourceUnit.trim()} counts as{" "}
            {Number(factor) > 0 ? money.format(100 / Number(factor)) : "—"} per {catalogUnit.trim()}
            {chosenItem ? ` for “${chosenItem.description}” only` : " for every catalog item in " + catalogUnit.trim()}.
          </p>
        ) : null}
      </div>

      {loading ? (
        <div className="flex items-center text-sm text-muted-foreground"><Loader2 className="w-4 h-4 animate-spin mr-2" />Loading…</div>
      ) : error ? (
        <div className="text-sm text-destructive" role="alert">{error}</div>
      ) : rules.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-od-id="conversions-empty">No unit conversions yet.</p>
      ) : (
        <ul className="divide-y rounded-md border" data-od-id="conversion-list">
          {rules.map((rule) => {
            const item = rule.catalogId ? standards.find((standard) => standard.id === rule.catalogId) : undefined
            const effects = conversionEffects(rule, standards)
            return (
              <li key={rule.id} className="p-3 text-sm space-y-1" data-od-id="conversion-row">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <strong>{describeRule(rule)}</strong>{" "}
                    <span className="text-muted-foreground">
                      · {rule.scope === "global" ? "All catalog items" : `Only “${item?.description ?? "a removed item"}”`}
                    </span>
                  </div>
                  <button className="btn btn-ghost btn-xs" onClick={() => void removeRule(rule)} disabled={removingId === rule.id} data-od-id="conversion-remove">
                    Remove
                  </button>
                </div>
                {effects.length === 0 ? (
                  <div className="text-xs text-muted-foreground">No approved quote prices use this yet.</div>
                ) : (
                  <ul className="text-xs text-muted-foreground space-y-0.5" data-od-id="conversion-effect">
                    {effects.map((effect) => (
                      <li key={effect.standardId}>
                        {effect.description}: {effect.convertedCount} {effect.convertedCount === 1 ? "price" : "prices"} in {rule.sourceUnit} now counted · average {money.format(effect.average)} per {effect.unit} from {effect.totalCount} {effect.totalCount === 1 ? "price" : "prices"}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
