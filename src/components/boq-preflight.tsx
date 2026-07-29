"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ZoomIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PreflightUpload } from "@/lib/boq-preflight-schema";

interface BoqPreflightProps {
	preflight: PreflightUpload;
	/** Local PDF still held by the upload modal — used for client-side page previews. */
	sourceFile: File;
	onExtract: (pages: number[]) => void;
	onCancel: () => void;
}

type PageImageMap = Record<number, string>;

async function renderPagePreviews(
	sourceUrl: string,
	pageNumbers: readonly number[],
): Promise<PageImageMap> {
	// Same browser entrypoint as the review viewer — worker is bundled for the client.
	const pdfjs = await import("pdfjs-dist/webpack.mjs");
	const document = await pdfjs.getDocument({ url: sourceUrl }).promise;
	const images: PageImageMap = {};

	try {
		for (const pageNumber of pageNumbers) {
			if (pageNumber < 1 || pageNumber > document.numPages) continue;
			const page = await document.getPage(pageNumber);
			// ~1.25 CSS px scale is sharp enough for thumbs + hover magnifier without huge data URLs.
			const viewport = page.getViewport({ scale: 1.25 });
			const canvas = globalThis.document.createElement("canvas");
			canvas.width = Math.max(1, Math.floor(viewport.width));
			canvas.height = Math.max(1, Math.floor(viewport.height));
			const canvasContext = canvas.getContext("2d");
			if (!canvasContext) continue;
			await page.render({
				canvas,
				canvasContext,
				viewport,
			}).promise;
			images[pageNumber] = canvas.toDataURL("image/jpeg", 0.82);
		}
	} finally {
		await document.destroy();
	}

	return images;
}

export function BoqPreflight({
	preflight,
	sourceFile,
	onExtract,
	onCancel,
}: BoqPreflightProps) {
	const [selectedPages, setSelectedPages] = useState<number[]>(() =>
		preflight.pages.filter((p: { suggested: boolean }) => p.suggested).map((p: { page: number }) => p.page),
	);
	const [magnifiedPage, setMagnifiedPage] = useState<number | null>(null);
	const [magnifierPos, setMagnifierPos] = useState<{ x: number; y: number } | null>(null);
	const [pageImages, setPageImages] = useState<PageImageMap>({});
	const [previewsFailed, setPreviewsFailed] = useState(false);

	const pageNumbers = useMemo(
		() => preflight.pages.map((page) => page.page),
		[preflight.pages],
	);

	useEffect(() => {
		let cancelled = false;
		const objectUrl = URL.createObjectURL(sourceFile);

		// Async boundary only — do not reset state synchronously here (cascading render lint).
		// Parent remounts this component when the source File identity changes.
		void renderPagePreviews(objectUrl, pageNumbers)
			.then((images) => {
				if (cancelled) return;
				setPageImages(images);
				setPreviewsFailed(
					Object.keys(images).length === 0 && pageNumbers.length > 0,
				);
			})
			.catch(() => {
				if (!cancelled) {
					setPageImages({});
					setPreviewsFailed(true);
				}
			})
			.finally(() => {
				URL.revokeObjectURL(objectUrl);
			});

		return () => {
			cancelled = true;
			URL.revokeObjectURL(objectUrl);
		};
	}, [sourceFile, pageNumbers]);

	const toggleSelection = useCallback((page: number) => {
		setSelectedPages((prev) =>
			prev.includes(page)
				? prev.filter((p) => p !== page)
				: [...prev, page].sort((a, b) => a - b),
		);
	}, []);

	const handleExtract = () => {
		onExtract(selectedPages);
	};

	const buildAccessibleLabel = (pageInfo: {
		page: number;
		suggested: boolean;
	}): string => {
		const isSelected = selectedPages.includes(pageInfo.page);
		const baseLabel = `Page ${pageInfo.page}`;
		const states: string[] = [];
		if (pageInfo.suggested) states.push("suggested");
		states.push(isSelected ? "selected" : "not selected");
		return `${baseLabel}, ${states.join(", ")}`;
	};

	return (
		<div className="preflight-container">
			<div className="preflight-header">
				<h3>Select pages to extract</h3>
				<p className="preflight-description">
					Confirm which pages from {preflight.fileName} contain BOQ line items.
				</p>
				{previewsFailed && (
					<p className="preflight-preview-fallback" role="status">
						Page previews could not be rendered. You can still select pages by
						number.
					</p>
				)}
			</div>

			<div className="preflight-pages">
				{preflight.pages.map((pageInfo) => {
					const isSelected = selectedPages.includes(pageInfo.page);
					const isMagnified = magnifiedPage === pageInfo.page;
					const accessibleLabel = buildAccessibleLabel(pageInfo);
					const previewSrc = pageImages[pageInfo.page];

					return (
						<div key={pageInfo.page} className="preflight-page-item">
							<button
								type="button"
								role="button"
								aria-label={accessibleLabel}
								aria-pressed={isSelected}
								onClick={() => toggleSelection(pageInfo.page)}
								onMouseEnter={() => setMagnifiedPage(pageInfo.page)}
								onMouseLeave={() => setMagnifiedPage(null)}
								onMouseMove={(e) => setMagnifierPos({ x: e.clientX, y: e.clientY })}
								onFocus={() => setMagnifiedPage(pageInfo.page)}
								onBlur={() => setMagnifiedPage(null)}
								className={`preflight-thumbnail ${isSelected ? "is-selected" : ""} ${
									isMagnified ? "is-magnified" : ""
								}`}
							>
								{previewSrc ? (
									// Decorative page raster; accessible name lives on the button.
									// eslint-disable-next-line @next/next/no-img-element
									<img
										src={previewSrc}
										alt=""
										className="preflight-thumbnail-image"
										draggable={false}
									/>
								) : (
									<span
										className="preflight-thumbnail-placeholder"
										aria-hidden="true"
									/>
								)}
								<span className="preflight-thumbnail-number">
									{pageInfo.page}
								</span>
								{pageInfo.suggested && (
									<span className="preflight-thumbnail-badge">Suggested</span>
								)}
								{isSelected && (
									<span
										className="preflight-thumbnail-check"
										aria-hidden="true"
									>
										✓
									</span>
								)}
							</button>

						{isMagnified && magnifierPos && (
							<div
								role="img"
								aria-label={`Magnified Page ${pageInfo.page}`}
								className="preflight-magnifier"
								style={{
									top: magnifierPos.y,
									left:
										magnifierPos.x > window.innerWidth - 360
											? magnifierPos.x - 340
											: magnifierPos.x + 20,
								}}
							>
									{previewSrc ? (
										// eslint-disable-next-line @next/next/no-img-element
										<img
											src={previewSrc}
											alt={`Magnified preview of page ${pageInfo.page}`}
											className="preflight-magnifier-image"
										/>
									) : (
										<div className="preflight-magnifier-empty">
											Preview unavailable for page {pageInfo.page}
										</div>
									)}
									<div className="preflight-magnifier-info">
										<span className="preflight-magnifier-icon">
											<ZoomIn size={16} />
										</span>
										<span>Page {pageInfo.page}</span>
										{pageInfo.suggested && (
											<span className="preflight-magnifier-badge">
												Suggested
											</span>
										)}
									</div>
								</div>
							)}
						</div>
					);
				})}
			</div>

			<div className="preflight-actions">
				<div className="preflight-status">
					{selectedPages.length === 0 ? (
						<p className="preflight-error">
							Select at least one page to continue.
						</p>
					) : (
						<p className="preflight-count">
							{selectedPages.length} page{selectedPages.length !== 1 ? "s" : ""}{" "}
							selected
						</p>
					)}
				</div>

				<div className="preflight-buttons">
					<Button variant="outline" onClick={onCancel}>
						Cancel
					</Button>
					<Button onClick={handleExtract} disabled={selectedPages.length === 0}>
						Extract {selectedPages.length} selected page
						{selectedPages.length !== 1 ? "s" : ""}
					</Button>
				</div>
			</div>
		</div>
	);
}
