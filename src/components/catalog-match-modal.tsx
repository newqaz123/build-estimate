"use client"

import { useEffect, useState } from "react"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Search } from "lucide-react"
import type { StandardEntry } from "@/lib/standard-schema"

interface MatchContext {
  boqId: string
  sectionIndex: number
  itemId?: string
  itemCode?: string
}

interface Props {
  itemDesc: string
  itemUnit: string
  onMatch: (standardId: string, standardDesc: string) => void
  onClose: () => void
  matchContext?: MatchContext
}

export function CatalogMatchModal({ itemDesc, itemUnit, onMatch, onClose, matchContext }: Props) {
  const [open, setOpen] = useState(true)
  const [standards, setStandards] = useState<StandardEntry[]>([])
  const [filtered, setFiltered] = useState<StandardEntry[]>([])
  const [search, setSearch] = useState("")
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/standards")
        if (!res.ok) throw new Error("Failed to load")
        const data = await res.json()
        setStandards(data)
        setFiltered(data)
      } catch {
        setStandards([])
        setFiltered([])
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  useEffect(() => {
    const q = search.toLowerCase()
    setFiltered(
      standards.filter(
        (s) =>
          s.description.toLowerCase().includes(q) ||
          s.aliases?.some((a) => a.toLowerCase().includes(q))
      )
    )
    setSelected(null)
  }, [search, standards])

  const handleConfirm = async () => {
    if (!selected) return
    const entry = standards.find((s) => s.id === selected)
    if (!entry) return
    if (matchContext) {
      const response = await fetch('/api/standards/match', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...matchContext, standardId: entry.id, confidence: 'manual' }),
      })
      if (!response.ok) return
    }
    onMatch(entry.id, entry.description)
    setOpen(false)
  }

  const handleClose = () => {
    setOpen(false)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Match to Standard Catalog</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Select a standard entry for: <strong>{itemDesc}</strong>
            {itemUnit && (
              <span className="ml-1 text-xs font-mono text-muted-foreground">
                ({itemUnit})
              </span>
            )}
          </p>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search catalog…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8"
              autoFocus
            />
          </div>
          {loading ? (
            <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
              No matching entries
            </div>
          ) : (
            <div className="max-h-64 overflow-y-auto space-y-1">
              {filtered.map((entry) => (
                <button
                  key={entry.id}
                  onClick={() => setSelected(selected === entry.id ? null : entry.id)}
                  className={`w-full text-left p-2.5 rounded-lg border text-sm transition-colors ${
                    selected === entry.id
                      ? "border-accent bg-accent/6"
                      : "border-border hover:border-accent/50 hover:bg-muted/30"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{entry.description}</span>
                    <span className="text-xs font-mono text-muted-foreground shrink-0">
                      {entry.unit}
                    </span>
                  </div>
                  {entry.aliases && entry.aliases.length > 0 && (
                    <div className="text-xs text-muted-foreground mt-1 truncate">
                      {entry.aliases.slice(0, 3).join(" · ")}
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-3 pt-1">
            <span className="text-xs text-muted-foreground">
              {filtered.length} entries
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={handleClose}>
                Cancel
              </Button>
              <Button onClick={() => void handleConfirm()} disabled={!selected}>
                Apply Match
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
