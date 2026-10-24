"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PDFPageProxy, RenderTask } from "pdfjs-dist";
import {
	BoxSelect,
	ChevronLeft,
	ChevronRight,
	ExternalLink,
	Hand,
	Loader2,
	RotateCcw,
	Scan,
	ZoomOut,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	clampPdfPan,
	clipSelectionToPage,
	deriveBoxZoom,
	MIN_PDF_ZOOM,
	normalizeSelection,
	panPdf,
	pdfPageBounds,
	type PdfPoint,
	type PdfRect,
	type PdfSize,
} from "@/lib/pdf-review-geometry";

type PdfTool = "pan" | "box-zoom";

interface EvidenceFocus {
	page: number;
	table: number;
	row: number;
	cells: Array<{ column: number; line: string | undefined }>;
}

interface PdfReviewViewerProps {
	sourceUrl: string;
	sourceFileName: string;
	resetKey: string;
	requestedPage?: number;
	requestedPageKey?: string | number;
	evidenceFocus?: EvidenceFocus;
}

async function loadPdf(sourceUrl: string) {
	const pdfjs = await import("pdfjs-dist/webpack.mjs");
	return pdfjs.getDocument({ url: sourceUrl, withCredentials: true }).promise;
}

const INITIAL_PAN: PdfPoint = { x: 0, y: 0 };

export function PdfReviewViewer({
	sourceUrl,
	sourceFileName,
	resetKey,
	requestedPage,
	requestedPageKey,
	evidenceFocus: propsEvidenceFocus,
}: PdfReviewViewerProps) {
	const viewportRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const dragStartRef = useRef<PdfPoint | null>(null);
	const lastPointerRef = useRef<PdfPoint | null>(null);
	const activePointerIdRef = useRef<number | null>(null);
	const renderGenerationRef = useRef(0);
	const fitPageSizeRef = useRef<PdfSize>({ width: 0, height: 0 });
	const [pdf, setPdf] = useState<Awaited<ReturnType<typeof loadPdf>> | null>(
		null,
	);
	const [pageNumber, setPageNumber] = useState(1);
	const [pageCount, setPageCount] = useState(0);
	const [zoom, setZoom] = useState(1);
	const [pan, setPan] = useState<PdfPoint>(INITIAL_PAN);
	const [tool, setTool] = useState<PdfTool>("pan");
	const [selection, setSelection] = useState<PdfRect | null>(null);
	const [viewportSize, setViewportSize] = useState<PdfSize>({
		width: 0,
		height: 0,
	});
	const [isPanning, setIsPanning] = useState(false);
	const [loading, setLoading] = useState(true);
	const [failed, setFailed] = useState(false);
	const [attempt, setAttempt] = useState(0);
	const [evidenceFocus, setEvidenceFocus] = useState<EvidenceFocus | null>(
		null,
	);
	const previousFocusPageRef = useRef<number | null>(null);

	const clearInteraction = useCallback(() => {
		dragStartRef.current = null;
		lastPointerRef.current = null;
		setSelection(null);
		setIsPanning(false);
	}, []);

	const releaseActivePointerCapture = useCallback(() => {
		const pointerId = activePointerIdRef.current;
		const viewport = viewportRef.current;
		activePointerIdRef.current = null;
		if (pointerId !== null && viewport?.hasPointerCapture(pointerId)) {
			viewport.releasePointerCapture(pointerId);
		}
	}, []);

	useEffect(() => {
		let disposed = false;
		let loadedDocument: Awaited<ReturnType<typeof loadPdf>> | null = null;
		// eslint-disable-next-line react-hooks/set-state-in-effect -- A new source/attempt must synchronously reset the viewer boundary.
		setLoading(true);
		setFailed(false);
		setPdf(null);
		setPageCount(0);
		setPageNumber(1);
		setZoom(1);
		setPan(INITIAL_PAN);
		setTool("pan");
		clearInteraction();
		void loadPdf(sourceUrl)
			.then((document) => {
				if (disposed) return document.destroy();
				loadedDocument = document;
				setPdf(document);
				setPageCount(document.numPages);
				setLoading(false);
			})
			.catch(() => {
				if (!disposed) {
					setFailed(true);
					setLoading(false);
				}
			});
		return () => {
			disposed = true;
			renderGenerationRef.current += 1;
			void loadedDocument?.destroy();
		};
	}, [attempt, clearInteraction, resetKey, sourceUrl]);

	useEffect(() => {
		if (
			typeof requestedPage !== "number" ||
			!Number.isFinite(requestedPage) ||
			pageCount < 1
		)
			return;
		const clampedPage = Math.min(
			pageCount,
			Math.max(1, Math.trunc(requestedPage)),
		);
		let active = true;
		void Promise.resolve().then(() => {
			if (!active) return;
			clearInteraction();
			setPageNumber(clampedPage);
			setZoom(1);
			setPan(INITIAL_PAN);
			setTool("pan");
		});
		return () => {
			active = false;
		};
	}, [clearInteraction, pageCount, requestedPage, requestedPageKey]);

	// Handle evidence focus changes - preserve zoom/pan when on the same page
	useEffect(() => {
		if (!propsEvidenceFocus) return;
		const { page: focusPage } = propsEvidenceFocus;
		if (
			typeof focusPage !== "number" ||
			!Number.isFinite(focusPage) ||
			pageCount < 1
		)
			return;
		const clampedPage = Math.min(pageCount, Math.max(1, Math.trunc(focusPage)));
		let active = true;
		void Promise.resolve().then(() => {
			if (!active) return;
			const pageChanged =
				previousFocusPageRef.current !== null &&
				previousFocusPageRef.current !== clampedPage;
			setEvidenceFocus(propsEvidenceFocus);
			setPageNumber(clampedPage);
			// Only reset zoom/pan when navigating to a different page
			if (pageChanged) {
				setZoom(1);
				setPan(INITIAL_PAN);
				setTool("pan");
			}
			previousFocusPageRef.current = clampedPage;
		});
		return () => {
			active = false;
		};
	}, [propsEvidenceFocus, pageCount]);

	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		const observeSize = () => {
			const bounds = viewport.getBoundingClientRect();
			const nextViewport = { width: bounds.width, height: bounds.height };
			setViewportSize(nextViewport);
			const fitPage = fitPageSizeRef.current;
			setPan((current) =>
				clampPdfPan(
					current,
					{ width: fitPage.width * zoom, height: fitPage.height * zoom },
					nextViewport,
				),
			);
		};
		observeSize();
		const observer = new ResizeObserver(observeSize);
		observer.observe(viewport);
		return () => observer.disconnect();
	}, [failed, loading, zoom]);

	useEffect(() => {
		if (!pdf || viewportSize.width <= 32 || viewportSize.height <= 32) return;
		const canvas = canvasRef.current;
		if (!canvas) return;

		const generation = ++renderGenerationRef.current;
		let disposed = false;
		let page: PDFPageProxy | null = null;
		let renderTask: RenderTask | null = null;

		void pdf
			.getPage(pageNumber)
			.then(async (loadedPage) => {
				page = loadedPage;
				if (disposed || generation !== renderGenerationRef.current) {
					loadedPage.cleanup();
					return;
				}
				const base = loadedPage.getViewport({ scale: 1 });
				const fitScale = Math.min(
					(viewportSize.width - 32) / base.width,
					(viewportSize.height - 32) / base.height,
				);
				const fitPage = {
					width: base.width * fitScale,
					height: base.height * fitScale,
				};
				fitPageSizeRef.current = fitPage;
				setPan((current) =>
					clampPdfPan(
						current,
						{ width: fitPage.width * zoom, height: fitPage.height * zoom },
						viewportSize,
					),
				);
				const viewport = loadedPage.getViewport({ scale: fitScale * zoom });
				const outputScale = window.devicePixelRatio || 1;
				const context = canvas.getContext("2d");
				if (!context) throw new Error("Canvas 2D context unavailable");

				canvas.width = Math.floor(viewport.width * outputScale);
				canvas.height = Math.floor(viewport.height * outputScale);
				canvas.style.width = `${Math.floor(viewport.width)}px`;
				canvas.style.height = `${Math.floor(viewport.height)}px`;
				renderTask = loadedPage.render({
					canvas,
					canvasContext: context,
					transform:
						outputScale === 1
							? undefined
							: [outputScale, 0, 0, outputScale, 0, 0],
					viewport,
				});
				await renderTask.promise;
			})
			.catch((error: unknown) => {
				if (
					!disposed &&
					!(
						error instanceof Error &&
						error.name === "RenderingCancelledException"
					)
				) {
					setFailed(true);
				}
			});

		return () => {
			disposed = true;
			renderGenerationRef.current += 1;
			renderTask?.cancel();
			page?.cleanup();
		};
	}, [pageNumber, pdf, viewportSize, zoom]);

	useEffect(() => {
		const cancelSelection = (event: KeyboardEvent) => {
			if (event.key === "Escape" && selection) {
				event.preventDefault();
				releaseActivePointerCapture();
				clearInteraction();
				setTool("pan");
			}
		};
		window.addEventListener("keydown", cancelSelection, { capture: true });
		return () =>
			window.removeEventListener("keydown", cancelSelection, { capture: true });
	}, [clearInteraction, releaseActivePointerCapture, selection]);

	const pointFromPointer = useCallback(
		(event: React.PointerEvent<HTMLDivElement>): PdfPoint => {
			const bounds = event.currentTarget.getBoundingClientRect();
			return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
		},
		[],
	);

	const clippedSelection = useCallback(
		(start: PdfPoint, end: PdfPoint) => {
			const fitPage = fitPageSizeRef.current;
			if (fitPage.width <= 0 || fitPage.height <= 0) return null;
			const renderedPage = {
				width: fitPage.width * zoom,
				height: fitPage.height * zoom,
			};
			return clipSelectionToPage(
				normalizeSelection(start, end),
				pdfPageBounds(viewportSize, renderedPage, pan),
			);
		},
		[pan, viewportSize, zoom],
	);

	const handlePointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (!pdf || loading || failed || event.button !== 0) return;
			if (tool === "pan" && zoom <= MIN_PDF_ZOOM) return;
			event.currentTarget.setPointerCapture(event.pointerId);
			activePointerIdRef.current = event.pointerId;
			const point = pointFromPointer(event);
			dragStartRef.current = point;
			lastPointerRef.current = point;
			if (tool === "box-zoom") setSelection({ ...point, width: 0, height: 0 });
			else setIsPanning(true);
		},
		[failed, loading, pdf, pointFromPointer, tool, zoom],
	);

	const handlePointerMove = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			const point = pointFromPointer(event);
			if (tool === "box-zoom" && dragStartRef.current) {
				setSelection(clippedSelection(dragStartRef.current, point));
				return;
			}
			if (tool === "pan" && lastPointerRef.current) {
				const last = lastPointerRef.current;
				const fitPage = fitPageSizeRef.current;
				const renderedPage = {
					width: fitPage.width * zoom,
					height: fitPage.height * zoom,
				};
				setPan((current) =>
					clampPdfPan(
						panPdf(current, { x: point.x - last.x, y: point.y - last.y }),
						renderedPage,
						viewportSize,
					),
				);
				lastPointerRef.current = point;
			}
		},
		[clippedSelection, pointFromPointer, tool, viewportSize, zoom],
	);

	const handlePointerEnd = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				activePointerIdRef.current = null;
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
			if (tool === "box-zoom" && dragStartRef.current) {
				const nextSelection = clippedSelection(
					dragStartRef.current,
					pointFromPointer(event),
				);
				const result = nextSelection
					? deriveBoxZoom({
							selection: nextSelection,
							viewport: viewportSize,
							zoom,
							pan,
						})
					: null;
				if (result) {
					const fitPage = fitPageSizeRef.current;
					setZoom(result.zoom);
					setPan(
						clampPdfPan(
							result.pan,
							{
								width: fitPage.width * result.zoom,
								height: fitPage.height * result.zoom,
							},
							viewportSize,
						),
					);
					setTool("pan");
				}
			}
			clearInteraction();
		},
		[
			clearInteraction,
			clippedSelection,
			pan,
			pointFromPointer,
			tool,
			viewportSize,
			zoom,
		],
	);

	const handlePointerCancel = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (event.currentTarget.hasPointerCapture(event.pointerId)) {
				activePointerIdRef.current = null;
				event.currentTarget.releasePointerCapture(event.pointerId);
			}
			clearInteraction();
		},
		[clearInteraction],
	);

	const handleLostPointerCapture = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			if (activePointerIdRef.current !== event.pointerId) return;
			activePointerIdRef.current = null;
			clearInteraction();
		},
		[clearInteraction],
	);

	const chooseTool = (nextTool: PdfTool) => {
		clearInteraction();
		setTool(nextTool);
	};

	const resetView = () => {
		clearInteraction();
		setPageNumber(1);
		setZoom(1);
		setPan(INITIAL_PAN);
		setTool("pan");
	};

	return (
		<div
			className="pdf-review-viewer"
			aria-label={`PDF preview of ${sourceFileName}`}
		>
			<div className="pdf-review-toolbar" aria-label="PDF review controls">
				<Button
					type="button"
					size="sm"
					variant={tool === "box-zoom" ? "default" : "outline"}
					aria-pressed={tool === "box-zoom"}
					onClick={() => chooseTool("box-zoom")}
				>
					<BoxSelect />
					Box Zoom
				</Button>
				<Button
					type="button"
					size="sm"
					variant={tool === "pan" ? "default" : "outline"}
					aria-pressed={tool === "pan"}
					disabled={zoom <= MIN_PDF_ZOOM}
					title={zoom <= MIN_PDF_ZOOM ? "Zoom in to pan the PDF" : undefined}
					onClick={() => chooseTool("pan")}
				>
					<Hand />
					Pan
				</Button>
				<Button
					type="button"
					size="icon-sm"
					variant="outline"
					aria-label="Zoom out"
					onClick={() => {
						clearInteraction();
						setZoom((value) => Math.max(1, value - 0.25));
						setPan(INITIAL_PAN);
					}}
				>
					<ZoomOut />
				</Button>
				<Button
					type="button"
					size="sm"
					variant="outline"
					onClick={() => {
						clearInteraction();
						setZoom(1);
						setPan(INITIAL_PAN);
					}}
				>
					<Scan />
					Fit Page
				</Button>
				<Button type="button" size="sm" variant="ghost" onClick={resetView}>
					<RotateCcw />
					Reset
				</Button>
				<span aria-live="polite">{Math.round(zoom * 100)}%</span>
				<Button
					type="button"
					size="icon-sm"
					variant="ghost"
					aria-label="Previous PDF page"
					disabled={pageNumber <= 1}
					onClick={() => {
						clearInteraction();
						setPageNumber((page) => page - 1);
						setZoom(1);
						setPan(INITIAL_PAN);
					}}
				>
					<ChevronLeft />
				</Button>
				<span>
					Page {pageNumber} of {pageCount}
				</span>
				<Button
					type="button"
					size="icon-sm"
					variant="ghost"
					aria-label="Next PDF page"
					disabled={pageNumber >= pageCount}
					onClick={() => {
						clearInteraction();
						setPageNumber((page) => page + 1);
						setZoom(1);
						setPan(INITIAL_PAN);
					}}
				>
					<ChevronRight />
				</Button>
			</div>
			<div
				ref={viewportRef}
				className={`pdf-review-viewport is-${tool}${tool === "pan" && zoom <= MIN_PDF_ZOOM ? " is-pan-disabled" : ""}${isPanning ? " is-panning" : ""}`}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerEnd}
				onPointerCancel={handlePointerCancel}
				onLostPointerCapture={handleLostPointerCapture}
			>
				<canvas
					ref={canvasRef}
					className="pdf-review-canvas"
					aria-label={`Page ${pageNumber} of ${sourceFileName}`}
					style={{
						transform: `translate(calc(-50% + ${pan.x}px), calc(-50% + ${pan.y}px))`,
					}}
				/>
				{selection ? (
					<div
						className="pdf-review-selection"
						style={{
							left: selection.x,
							top: selection.y,
							width: selection.width,
							height: selection.height,
						}}
					/>
				) : null}
				{evidenceFocus ? (
					<div className="pdf-evidence-focus" role="status">
						{evidenceFocus.page === pageNumber
							? `Source row · table ${evidenceFocus.table} · row ${evidenceFocus.row}`
							: `Source row is on page ${evidenceFocus.page}`}
					</div>
				) : null}
				{loading ? (
					<div
						className="review-pdf-fallback pdf-review-status-overlay"
						role="status"
					>
						<Loader2 className="spin" />
						<strong>Loading source PDF…</strong>
					</div>
				) : null}
				{failed ? (
					<div
						className="review-pdf-fallback pdf-review-status-overlay"
						role="alert"
					>
						<strong>Source PDF preview unavailable</strong>
						<span>{sourceFileName}</span>
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => setAttempt((value) => value + 1)}
						>
							Retry preview
						</Button>
						<a href={sourceUrl} target="_blank" rel="noreferrer">
							Open PDF <ExternalLink />
						</a>
					</div>
				) : null}
			</div>
		</div>
	);
}
