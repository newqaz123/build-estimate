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

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown; detail?: unknown }
    if (typeof body.error === "string") return body.error
    if (typeof body.detail === "string") return body.detail
  } catch {
    // Keep the user-facing fallback when an upstream service returns non-JSON.
  }
  return fallback
}

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
      const formData = new FormData()
      formData.append("file", file)
      const response = await fetch("/api/boqs/import", {
        method: "POST",
        body: formData,
      })
      if (!response.ok) {
        throw new Error(await readError(response, "The BOQ could not be imported. Try again."))
      }

      const boq = await response.json() as Boq
      toast.success("BOQ imported successfully")
      onUploadComplete(boq)
      onOpenChange(false)
      setFile(null)
      setNotes("")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && uploading) return
    onOpenChange(nextOpen)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="modal upload-modal max-w-[520px]"
        data-od-id="upload-modal"
        showCloseButton={!uploading}
      >
        <DialogHeader className="modal-header">
          <DialogTitle>Upload BOQ</DialogTitle>
          <DialogDescription>
            Drop a BOQ PDF. Docling extracts all line items — you fill in the metadata (vendor, project, work type) during review.
          </DialogDescription>
        </DialogHeader>

        <div className="modal-body upload-modal-body">
          <div
            {...getRootProps({
              role: "button",
              "aria-label": file ? `Selected PDF: ${file.name}` : "Choose a BOQ PDF to upload",
              "aria-disabled": uploading,
            })}
            data-od-id="drop-zone"
            className={`drop-zone ${isDragActive ? "dragover" : ""} ${uploading ? "is-disabled" : ""}`}
          >
            <input {...getInputProps()} disabled={uploading} />
            {file ? (
              <>
                <FileText />
                <p className="drop-zone-title">{file.name}</p>
                <p className="drop-zone-meta">{(file.size / 1024).toFixed(0)} KB</p>
              </>
            ) : (
              <>
                <Upload />
                <p className="drop-zone-title">Drop your BOQ PDF here, or click to browse</p>
                <p className="drop-zone-meta">PDF files only · Max 20 MB</p>
              </>
            )}
          </div>

          <div className="upload-notes-field">
            <label htmlFor="boqNotes">Notes (optional)</label>
            <textarea
              id="boqNotes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any notes about this BOQ…"
              className="proto-input"
              disabled={uploading}
            />
          </div>

          {uploading && (
            <div className="upload-progress" role="status" aria-live="polite">
              <div className="proto-spinner" aria-hidden="true" />
              <div><strong>Parsing BOQ…</strong><span>Uploading the PDF and extracting line items with Docling.</span></div>
            </div>
          )}
        </div>

        <DialogFooter className="modal-footer">
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={uploading}>
            Cancel
          </Button>
          <Button onClick={handleUpload} disabled={!file || uploading}>
            {uploading && <span className="proto-spinner upload-button-spinner" aria-hidden="true" />}
            {uploading ? "Parsing…" : "Upload & Parse"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
