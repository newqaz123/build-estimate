"use client"

import { useEffect, useId, useRef, useState } from "react"
import { Check, ChevronDown, Plus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { filterUnits, normalizeNewUnit } from "@/lib/units"

export interface UnitComboboxProps {
  value: string
  units: string[]
  onChange: (unit: string) => void
  onAddUnit: (unit: string) => void
  disabled?: boolean
  readOnly?: boolean
  ariaLabel?: string
}

export function UnitCombobox({
  value,
  units,
  onChange,
  onAddUnit,
  disabled,
  readOnly,
  ariaLabel = "Unit",
}: UnitComboboxProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState("")
  const rootRef = useRef<HTMLDivElement>(null)
  const listId = useId()

  useEffect(() => {
    if (!open) return
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false) }
    document.addEventListener("mousedown", onPointer)
    document.addEventListener("keydown", onKey)
    return () => {
      document.removeEventListener("mousedown", onPointer)
      document.removeEventListener("keydown", onKey)
    }
  }, [open])

  if (readOnly) {
    return <span className="unit-combobox-readonly">{value || "—"}</span>
  }

  const filtered = filterUnits(units, query)

  const commitAdd = () => {
    const created = normalizeNewUnit(draft, units)
    if (!created) { setAdding(false); setDraft(""); return }
    onAddUnit(created)
    onChange(created)
    setAdding(false); setDraft(""); setQuery(""); setOpen(false)
  }

  return (
    <div className="unit-combobox" ref={rootRef} data-od-id="unit-combobox">
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="unit-combobox-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={ariaLabel}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="unit-combobox-value">{value || "Unit…"}</span>
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </Button>
      {open ? (
        <div className="unit-combobox-popover" role="dialog" aria-label={ariaLabel}>
          <div className="unit-combobox-search">
            <Input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search units…"
              aria-label={`Search ${ariaLabel}`}
              className="h-7 text-xs"
              autoFocus
            />
          </div>
          <ul id={listId} role="listbox" className="unit-combobox-list">
            {filtered.length === 0 ? (
              <li className="unit-combobox-empty">No units match</li>
            ) : filtered.map((unit) => (
              <li key={unit} role="option" aria-selected={unit === value}>
                <button
                  type="button"
                  className="unit-combobox-option"
                  onClick={() => { onChange(unit); setOpen(false); setQuery("") }}
                >
                  <span>{unit}</span>
                  {unit === value ? <Check className="size-3" aria-hidden="true" /> : null}
                </button>
              </li>
            ))}
          </ul>
          <div className="unit-combobox-add">
            {adding ? (
              <div className="unit-combobox-add-form">
                <Input
                  type="text"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="New unit"
                  aria-label={`New ${ariaLabel} name`}
                  className="h-7 text-xs"
                  autoFocus
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); commitAdd() }
                    if (event.key === "Escape") { setAdding(false); setDraft("") }
                  }}
                />
                <Button type="button" size="icon-xs" variant="ghost" aria-label="Save new unit" onClick={commitAdd}><Check className="size-3" /></Button>
                <Button type="button" size="icon-xs" variant="ghost" aria-label="Cancel add unit" onClick={() => { setAdding(false); setDraft("") }}><X className="size-3" /></Button>
              </div>
            ) : (
              <button type="button" className="unit-combobox-add-toggle" onClick={() => setAdding(true)}>
                <Plus className="size-3" aria-hidden="true" /> Add new unit
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
