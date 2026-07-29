"use client";

import { useCallback, useState } from "react";
import { useDropzone, type FileRejection } from "react-dropzone";
import { toast } from "sonner";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogDescription,
	DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Upload, FileText } from "lucide-react";
import type { Boq } from "@/lib/boq-schema";
import { uploadRejectionMessage } from "@/lib/boq-upload";
import { BoqPreflight } from "@/components/boq-preflight";
import type { PreflightUpload } from "@/lib/boq-preflight-schema";

interface UploadModalProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onUploadComplete: (boq: Boq) => void;
}

async function readError(
	response: Response,
	fallback: string,
): Promise<string> {
	try {
		const body = (await response.json()) as {
			error?: unknown;
			detail?: unknown;
		};
		if (typeof body.error === "string") return body.error;
		if (typeof body.detail === "string") return body.detail;
	} catch {
		// Keep the user-facing fallback when an upstream service returns non-JSON.
	}
	return fallback;
}

export function UploadModal({
	open,
	onOpenChange,
	onUploadComplete,
}: UploadModalProps) {
	const [file, setFile] = useState<File | null>(null);
	const [uploading, setUploading] = useState(false);
	const [preflight, setPreflight] = useState<PreflightUpload | null>(null);
	const [importError, setImportError] = useState<string | null>(null);

	const onDrop = useCallback((acceptedFiles: File[]) => {
		if (acceptedFiles.length > 0) {
			setFile(acceptedFiles[0]);
			setPreflight(null);
			setImportError(null);
		}
	}, []);

	const onDropRejected = useCallback((rejections: FileRejection[]) => {
		const errorCodes = rejections.flatMap((rejection) =>
			rejection.errors.map((error) => error.code),
		);
		toast.error(uploadRejectionMessage(errorCodes));
	}, []);

	const { getRootProps, getInputProps, isDragActive } = useDropzone({
		onDrop,
		onDropRejected,
		accept: { "application/pdf": [".pdf"] },
		maxSize: 20 * 1024 * 1024,
		multiple: false,
	});

	const handlePreflight = async () => {
		if (!file) {
			toast.error("Please select a PDF file");
			return;
		}
		setUploading(true);
		setImportError(null);
		try {
			const formData = new FormData();
			formData.append("file", file);
			const response = await fetch("/api/boqs/preflight", {
				method: "POST",
				body: formData,
			});
			if (!response.ok) {
				throw new Error(
					await readError(response, "Preflight check failed. Try again."),
				);
			}

			const preflightData = (await response.json()) as PreflightUpload;
			setPreflight(preflightData);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Preflight failed");
		} finally {
			setUploading(false);
		}
	};

	const handleExtract = async (pages: number[]) => {
		if (!preflight || !file) {
			toast.error("Missing preflight data");
			return;
		}
		setUploading(true);
		setImportError(null);
		try {
			const formData = new FormData();
			formData.append("preflightId", preflight.id);
			formData.append("pages", JSON.stringify(pages));

			const response = await fetch("/api/boqs/import", {
				method: "POST",
				body: formData,
			});
			if (!response.ok) {
				throw new Error(
					await readError(
						response,
						"The BOQ could not be imported. Try again.",
					),
				);
			}

			const boq = (await response.json()) as Boq;
			toast.success("BOQ imported successfully");
			onUploadComplete(boq);
			onOpenChange(false);
			setFile(null);
			setPreflight(null);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "Import failed";
			setImportError(errorMessage);
			toast.error(errorMessage);
		} finally {
			setUploading(false);
		}
	};

	const handleCancelPreflight = () => {
		setPreflight(null);
		setImportError(null);
	};

	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen && uploading) return;
		onOpenChange(nextOpen);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				className="upload-modal max-w-[720px]"
				data-od-id="upload-modal"
				showCloseButton={!uploading}
			>
				<DialogHeader className="modal-header">
					<DialogTitle>Upload BOQ</DialogTitle>
					<DialogDescription>
						{preflight
							? "Confirm which pages contain BOQ line items for extraction."
							: "Drop a BOQ PDF. Docling extracts all line items — you fill in the metadata (vendor, project, work type) during review."}
					</DialogDescription>
				</DialogHeader>

				<div className="modal-body upload-modal-body">
					{preflight && file ? (
						<BoqPreflight
							key={`${file.name}:${file.size}:${file.lastModified}:${preflight.id}`}
							preflight={preflight}
							sourceFile={file}
							onExtract={handleExtract}
							onCancel={handleCancelPreflight}
						/>
					) : (
						<>
							<div
								{...getRootProps({
									role: "button",
									"aria-label": file
										? `Selected PDF: ${file.name}`
										: "Choose a BOQ PDF to upload",
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
										<p className="drop-zone-meta">
											{(file.size / 1024).toFixed(0)} KB
										</p>
									</>
								) : (
									<>
										<Upload />
										<p className="drop-zone-title">
											Drop your BOQ PDF here, or click to browse
										</p>
										<p className="drop-zone-meta">PDF files only · Max 20 MB</p>
									</>
								)}
							</div>

							{uploading && (
								<div
									className="upload-progress"
									role="status"
									aria-live="polite"
								>
									<div className="proto-spinner" aria-hidden="true" />
									<div>
										<strong>Analyzing PDF…</strong>
										<span>Checking page structure and content.</span>
									</div>
								</div>
							)}

							{importError && (
								<div className="upload-error" role="alert">
									<p className="upload-error-message">{importError}</p>
									<p className="upload-error-hint">
										Your page selection is preserved. Try again or adjust your
										selection.
									</p>
								</div>
							)}
						</>
					)}
				</div>

				{!preflight && (
					<DialogFooter className="modal-footer">
						<Button
							variant="outline"
							onClick={() => handleOpenChange(false)}
							disabled={uploading}
						>
							Cancel
						</Button>
						<Button onClick={handlePreflight} disabled={!file || uploading}>
							{uploading && (
								<span
									className="proto-spinner upload-button-spinner"
									aria-hidden="true"
								/>
							)}
							{uploading ? "Analyzing…" : "Continue"}
						</Button>
					</DialogFooter>
				)}
			</DialogContent>
		</Dialog>
	);
}
