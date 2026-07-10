"use client"

import { useCallback, useState } from "react"
import { useDropzone } from "react-dropzone"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Upload, FileText } from "lucide-react"
import type { Boq } from "@/lib/boq-schema"

interface UploadModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onUploadComplete: (boq: Boq) => void
}

const MOCK_PARSED_ITEMS = [
  { code: "B.1.1", desc: "Structural concrete C32/40 (columns)", unit: "m³", qty: 120, rate: 3850, total: 462000, type: "unit" as const },
  { code: "B.1.2", desc: "Structural concrete C25/30 (slabs)", unit: "m³", qty: 240, rate: 3450, total: 828000, type: "unit" as const },
  { code: "B.1.3", desc: "Reinforcement bar SD40 — 16mm", unit: "ton", qty: 18.5, rate: 28500, total: 527250, type: "unit" as const },
  { code: "B.1.4", desc: "Reinforcement bar SD40 — 12mm", unit: "ton", qty: 12.2, rate: 29000, total: 353800, type: "unit" as const },
  { code: "B.1.5", desc: "Formwork — column", unit: "m²", qty: 520, rate: 680, total: 353600, type: "unit" as const },
  { code: "B.1.6", desc: "Formwork — slab", unit: "m²", qty: 980, rate: 590, total: 578200, type: "unit" as const },
  { code: "B.2.1", desc: "Structural steel frame — main beams", unit: "ton", qty: 8.4, rate: 42000, total: 352800, type: "unit" as const },
]

export function UploadModal({ open, onOpenChange, onUploadComplete }: UploadModalProps) {
  const [file, setFile] = useState<File | null>(null)
  const [notes, setNotes] = useState("")
  const [uploading, setUploading] = useState(false)

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setFile(acceptedFiles[0])
    }
  }, [])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { "application/pdf": [".pdf"] },
    maxSize: 20 * 1024 * 1024,
    multiple: false,
  })

  const handleUpload = async () => {
    if (!file) {
      toast.error("Please select a PDF file")
      return
    }
    setUploading(true)
    try {
      const items = MOCK_PARSED_ITEMS.map((item) => ({
        ...item,
        stdStatus: "unmatched" as const,
      }))

      const body = {
        project: "Untitled BOQ",
        vendor: "Unknown Vendor",
        workType: "Structural" as const,
        date: new Date().toISOString().slice(0, 10),
        sections: [{ header: "Parsed Items", items }],
      }

      const res = await fetch("/api/boqs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!res.ok) throw new Error("Failed to create BOQ")

      const boq = await res.json()
      toast.success("BOQ parsed successfully")
      onUploadComplete(boq)
      onOpenChange(false)
      setFile(null)
      setNotes("")
    } catch {
      toast.error("Upload failed")
    } finally {
      setUploading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px]" data-od-id="upload-modal">
        <DialogHeader>
          <DialogTitle>Upload BOQ</DialogTitle>
          <DialogDescription>
            Drop a BOQ PDF. Docling extracts all line items — you fill in the metadata (vendor, project, work type) during review.
          </DialogDescription>
        </DialogHeader>

        <div
          {...getRootProps()}
          data-od-id="drop-zone"
          className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
            isDragActive ? "border-accent bg-accent/5" : "border-border hover:border-muted-foreground"
          }`}
        >
          <input {...getInputProps()} />
          {file ? (
            <>
              <FileText className="w-8 h-8 mx-auto mb-2 text-accent" />
              <p className="text-sm font-medium">{file.name}</p>
              <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(0)} KB</p>
            </>
          ) : (
            <>
              <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
              <p className="text-sm">Drop your BOQ PDF here, or click to browse</p>
              <p className="text-xs text-muted-foreground mt-1">PDF files only · Max 20 MB</p>
            </>
          )}
        </div>

        <div className="space-y-1">
          <label htmlFor="boqNotes" className="text-xs text-muted-foreground">
            Notes (optional)
          </label>
          <textarea
            id="boqNotes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any notes about this BOQ…"
            className="w-full min-h-[48px] rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={!file || uploading}>
            {uploading ? "Parsing..." : "Upload & Parse"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
