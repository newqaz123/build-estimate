"use client"

import { useEffect, useState, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Search, Plus, Check, X, Pencil, Trash2, Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { Boq } from "@/lib/boq-schema"
import type { StandardEntry } from "@/lib/standard-schema"

interface ReviewItem {
  boqId: string
  boqProject: string
  sectionIndex: number
  code: string
  desc: string
  unit: string
  stdStatus: string
  stdMatch?: string
}

export default function CatalogPage() {
  const [tab, setTab] = useState("review")
  const [standards, setStandards] = useState<StandardEntry[]>([])
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([])
  const [loading, setLoading] = useState(true)
  const [catalogSearch, setCatalogSearch] = useState("")

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDesc, setEditDesc] = useState("")
  const [editUnit, setEditUnit] = useState("")
  const [editAliases, setEditAliases] = useState("")

  const [addOpen, setAddOpen] = useState(false)
  const [addDesc, setAddDesc] = useState("")
  const [addUnit, setAddUnit] = useState("")
  const [addAliases, setAddAliases] = useState("")

  const [acceptingIds, setAcceptingIds] = useState<Set<string>>(new Set())
  const [suggestingAll, setSuggestingAll] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    try {
      const [standardsRes, boqsRes] = await Promise.all([
        fetch("/api/standards"),
        fetch("/api/boqs?limit=1000"),
      ])

      const standardsData: StandardEntry[] = await standardsRes.json()
      const boqsData = await boqsRes.json()
      const boqs: Boq[] = boqsData.boqs || []

      setStandards(Array.isArray(standardsData) ? standardsData : [])

      const items: ReviewItem[] = []
      for (const boq of boqs) {
        for (let si = 0; si < boq.sections.length; si++) {
          for (const item of boq.sections[si].items) {
            if (item.stdStatus !== "matched") {
              items.push({
                boqId: boq.id,
                boqProject: boq.project,
                sectionIndex: si,
                code: item.code,
                desc: item.desc,
                unit: item.unit,
                stdStatus: item.stdStatus,
                stdMatch: item.stdMatch,
              })
            }
          }
        }
      }
      setReviewItems(items)
    } catch {
      toast.error("Failed to load catalog data")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  const suggestions = reviewItems.filter((i) => i.stdStatus === "pending").length
  const unmatched = reviewItems.filter((i) => i.stdStatus === "unmatched").length

  const statusBadge = (status: string) => {
    const map: Record<string, "default" | "secondary" | "outline" | "destructive"> = {
      matched: "default",
      pending: "secondary",
      unmatched: "outline",
    }
    return (
      <Badge variant={map[status] || "outline"}>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Badge>
    )
  }

  const handleAccept = async (item: ReviewItem) => {
    const key = `${item.boqId}-${item.sectionIndex}-${item.code}`
    setAcceptingIds((prev) => new Set(prev).add(key))
    try {
      const res = await fetch(`/api/boqs/${item.boqId}/items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sectionIndex: item.sectionIndex,
          items: [{ code: item.code, stdStatus: "matched" }],
        }),
      })
      if (!res.ok) throw new Error("Failed to accept")
      toast.success(`Accepted: "${item.desc}"`)
      await fetchData()
    } catch {
      toast.error("Failed to accept item")
    } finally {
      setAcceptingIds((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const handleReject = async (item: ReviewItem) => {
    const key = `${item.boqId}-${item.sectionIndex}-${item.code}`
    setAcceptingIds((prev) => new Set(prev).add(key))
    try {
      const res = await fetch(`/api/boqs/${item.boqId}/items`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sectionIndex: item.sectionIndex,
          items: [{ code: item.code, stdStatus: "unmatched" }],
        }),
      })
      if (!res.ok) throw new Error("Failed to reject")
      toast.success(`Skipped: "${item.desc}"`)
      await fetchData()
    } catch {
      toast.error("Failed to skip item")
    } finally {
      setAcceptingIds((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  const handleSuggestAll = async () => {
    setSuggestingAll(true)
    const pending = reviewItems.filter((i) => i.stdStatus === "pending")

    const groups = new Map<string, ReviewItem[]>()
    for (const item of pending) {
      const key = `${item.boqId}-${item.sectionIndex}`
      const g = groups.get(key) || []
      g.push(item)
      groups.set(key, g)
    }

    let success = 0
    let fail = 0
    for (const [, group] of groups) {
      try {
        const res = await fetch(`/api/boqs/${group[0].boqId}/items`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sectionIndex: group[0].sectionIndex,
            items: group.map((i) => ({ code: i.code, stdStatus: "matched" })),
          }),
        })
        if (res.ok) success += group.length
        else fail += group.length
      } catch {
        fail += group.length
      }
    }

    if (fail === 0) {
      toast.success(`Accepted all ${success} suggestions`)
    } else {
      toast.error(`Accepted ${success}, failed ${fail}`)
    }
    await fetchData()
    setSuggestingAll(false)
  }

  const startEditing = (std: StandardEntry) => {
    setEditingId(std.id)
    setEditDesc(std.description)
    setEditUnit(std.unit)
    setEditAliases((std.aliases || []).join(", "))
  }

  const saveEditing = async (id: string) => {
    try {
      const res = await fetch(`/api/standards/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: editDesc,
          unit: editUnit,
          aliases: editAliases.split(",").map((a) => a.trim()).filter(Boolean),
        }),
      })
      if (!res.ok) throw new Error("Failed to update")
      toast.success("Standard updated")
      setEditingId(null)
      await fetchData()
    } catch {
      toast.error("Failed to update standard")
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm("Delete this standard entry?")) return
    try {
      const res = await fetch(`/api/standards/${id}`, { method: "DELETE" })
      if (!res.ok) throw new Error("Failed to delete")
      toast.success("Standard deleted")
      await fetchData()
    } catch {
      toast.error("Failed to delete standard")
    }
  }

  const handleAddEntry = async () => {
    if (!addDesc.trim() || !addUnit.trim()) {
      toast.error("Description and unit are required")
      return
    }
    try {
      const res = await fetch("/api/standards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          description: addDesc.trim(),
          unit: addUnit.trim(),
          aliases: addAliases.split(",").map((a) => a.trim()).filter(Boolean),
        }),
      })
      if (!res.ok) throw new Error("Failed to create")
      toast.success("Standard entry created")
      setAddOpen(false)
      setAddDesc("")
      setAddUnit("")
      setAddAliases("")
      await fetchData()
    } catch {
      toast.error("Failed to create standard entry")
    }
  }

  const filteredStandards = standards.filter((s) => {
    if (!catalogSearch) return true
    const q = catalogSearch.toLowerCase()
    return (
      s.description.toLowerCase().includes(q) ||
      s.aliases?.some((a) => a.toLowerCase().includes(q))
    )
  })

  return (
    <div data-od-id="catalog-page">
      <div data-od-id="page-heading" className="mb-4">
        <p className="text-sm text-muted-foreground">
          Standard descriptions across all BOQs. Review unmatched items, approve suggestions, and maintain the master
          standard catalog.
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-6" data-od-id="stats-bar">
        <Card size="sm">
          <div className="px-4 pt-4">
            <div className="font-mono text-[32px] font-semibold leading-none tracking-tight text-accent mb-1">
              {suggestions}
            </div>
            <div className="text-sm text-muted-foreground">Suggestions</div>
          </div>
        </Card>
        <Card size="sm">
          <div className="px-4 pt-4">
            <div className="font-mono text-[32px] font-semibold leading-none tracking-tight text-[#eab308] mb-1">
              {unmatched}
            </div>
            <div className="text-sm text-muted-foreground">Unmatched items</div>
          </div>
        </Card>
        <Card size="sm">
          <div className="px-4 pt-4">
            <div className="font-mono text-[32px] font-semibold leading-none tracking-tight text-[#b88a00] mb-1">
              {reviewItems.length}
            </div>
            <div className="text-sm text-muted-foreground">Awaiting review</div>
          </div>
        </Card>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v)} data-od-id="catalog-tabs">
        <TabsList variant="line">
          <TabsTrigger value="review" data-od-id="tab-review-trigger">Items to Review</TabsTrigger>
          <TabsTrigger value="catalog" data-od-id="tab-catalog-trigger">Standard Catalog</TabsTrigger>
        </TabsList>

        <TabsContent value="review" data-od-id="tab-review">
          {loading ? (
            <div className="flex items-center justify-center h-64 text-sm text-muted-foreground" data-od-id="loading-state">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Loading&hellip;
            </div>
          ) : reviewItems.length === 0 ? (
            <div
              className="flex flex-col items-center justify-center h-64 gap-2 text-muted-foreground"
              data-od-id="empty-state"
            >
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="w-10 h-10 opacity-40"
              >
                <path d="M22 11.08V12a10 10 0 11-5.93-9.14" />
                <polyline points="22 4 12 14.01 9 11.01" />
              </svg>
              <p className="text-sm">All items are matched. Nothing to review.</p>
            </div>
          ) : (
            <>
              <div className="flex items-center justify-end mb-3">
                {suggestions > 0 && (
                  <Button size="sm" onClick={handleSuggestAll} disabled={suggestingAll} data-od-id="suggest-all-btn">
                    {suggestingAll && <Loader2 className="w-3 h-3 animate-spin mr-1" />}
                    Suggest All
                  </Button>
                )}
              </div>
              <div className="border border-border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Source BOQ</TableHead>
                      <TableHead>Original Description</TableHead>
                      <TableHead>Unit</TableHead>
                      <TableHead>Match Status</TableHead>
                      <TableHead>Suggested Standard</TableHead>
                      <TableHead className="w-[100px]">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {reviewItems.map((item, i) => {
                      const key = `${item.boqId}-${item.sectionIndex}-${item.code}`
                      const isAccepting = acceptingIds.has(key)
                      return (
                        <TableRow key={key} data-od-id={`review-item-${i}`}>
                          <TableCell className="font-medium">{item.boqProject}</TableCell>
                          <TableCell>{item.desc}</TableCell>
                          <TableCell className="font-mono text-xs">{item.unit}</TableCell>
                          <TableCell>{statusBadge(item.stdStatus)}</TableCell>
                          <TableCell>{item.stdMatch || "\u2014"}</TableCell>
                          <TableCell>
                            {isAccepting ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : item.stdStatus === "pending" ? (
                              <div className="flex items-center gap-1">
                                <Button
                                  size="xs"
                                  variant="default"
                                  onClick={() => handleAccept(item)}
                                  data-od-id={`accept-${i}`}
                                >
                                  <Check className="w-3 h-3" />
                                </Button>
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  onClick={() => handleReject(item)}
                                  data-od-id={`reject-${i}`}
                                >
                                  <X className="w-3 h-3" />
                                </Button>
                              </div>
                            ) : (
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() => handleAccept(item)}
                                data-od-id={`match-${i}`}
                              >
                                Match&hellip;
                              </Button>
                            )}
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="catalog" data-od-id="tab-catalog">
          {loading ? (
            <div className="flex items-center justify-center h-64 text-sm text-muted-foreground" data-od-id="loading-state">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Loading&hellip;
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3" data-od-id="catalog-toolbar">
                <div className="relative max-w-xs">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input
                    placeholder="Search catalog&hellip;"
                    value={catalogSearch}
                    onChange={(e) => setCatalogSearch(e.target.value)}
                    className="pl-8"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-muted-foreground">{filteredStandards.length} entries</span>
                  <Button size="sm" onClick={() => setAddOpen(true)} data-od-id="add-entry-btn">
                    <Plus className="w-3 h-3" />
                    Add Entry
                  </Button>
                </div>
              </div>
              <div className="border border-border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Standard Description</TableHead>
                      <TableHead>Unit</TableHead>
                      <TableHead>Aliases</TableHead>
                      <TableHead>Source BOQ Count</TableHead>
                      <TableHead>Last Updated</TableHead>
                      <TableHead className="w-[80px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredStandards.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                          No catalog entries found
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredStandards.map((std) => {
                        const isEditing = editingId === std.id
                        return (
                          <TableRow key={std.id} data-od-id={`catalog-row-${std.id}`}>
                            {isEditing ? (
                              <>
                                <TableCell>
                                  <Input
                                    value={editDesc}
                                    onChange={(e) => setEditDesc(e.target.value)}
                                    className="h-7 text-xs"
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    value={editUnit}
                                    onChange={(e) => setEditUnit(e.target.value)}
                                    className="h-7 text-xs font-mono w-16"
                                  />
                                </TableCell>
                                <TableCell>
                                  <Input
                                    value={editAliases}
                                    onChange={(e) => setEditAliases(e.target.value)}
                                    className="h-7 text-xs"
                                    placeholder="Comma-separated"
                                  />
                                </TableCell>
                                <TableCell>{std.sourceBoqCount}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {std.updatedAt ? new Date(std.updatedAt).toLocaleDateString() : "\u2014"}
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-1">
                                    <Button size="xs" variant="default" onClick={() => saveEditing(std.id)}>
                                      <Check className="w-3 h-3" />
                                    </Button>
                                    <Button size="xs" variant="ghost" onClick={() => setEditingId(null)}>
                                      <X className="w-3 h-3" />
                                    </Button>
                                  </div>
                                </TableCell>
                              </>
                            ) : (
                              <>
                                <TableCell className="font-medium">{std.description}</TableCell>
                                <TableCell className="font-mono text-xs">{std.unit}</TableCell>
                                <TableCell>
                                  <div className="flex flex-wrap gap-1">
                                    {(std.aliases || []).slice(0, 3).map((alias, ai) => (
                                      <Badge key={ai} variant="outline" className="text-[10px]">
                                        {alias}
                                      </Badge>
                                    ))}
                                    {(std.aliases || []).length > 3 && (
                                      <span className="text-[10px] text-muted-foreground">
                                        +{std.aliases.length - 3} more
                                      </span>
                                    )}
                                  </div>
                                </TableCell>
                                <TableCell>{std.sourceBoqCount}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">
                                  {std.updatedAt ? new Date(std.updatedAt).toLocaleDateString() : "\u2014"}
                                </TableCell>
                                <TableCell>
                                  <div className="flex items-center gap-1">
                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      onClick={() => startEditing(std)}
                                      data-od-id={`edit-${std.id}`}
                                    >
                                      <Pencil className="w-3 h-3" />
                                    </Button>
                                    <Button
                                      size="xs"
                                      variant="ghost"
                                      onClick={() => handleDelete(std.id)}
                                      data-od-id={`delete-${std.id}`}
                                    >
                                      <Trash2 className="w-3 h-3 text-destructive" />
                                    </Button>
                                  </div>
                                </TableCell>
                              </>
                            )}
                          </TableRow>
                        )
                      })
                    )}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Standard Entry</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <label className="text-xs font-medium mb-1 block">Description *</label>
              <Input
                value={addDesc}
                onChange={(e) => setAddDesc(e.target.value)}
                placeholder="e.g. Concrete C32/40 — columns"
              />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Unit *</label>
              <Input
                value={addUnit}
                onChange={(e) => setAddUnit(e.target.value)}
                placeholder="e.g. m³"
                className="font-mono w-24"
              />
            </div>
            <div>
              <label className="text-xs font-medium mb-1 block">Aliases</label>
              <Input
                value={addAliases}
                onChange={(e) => setAddAliases(e.target.value)}
                placeholder="Comma-separated aliases"
              />
              <p className="text-[10px] text-muted-foreground mt-1">Optional. Separate with commas.</p>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={handleAddEntry}>Create Entry</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
