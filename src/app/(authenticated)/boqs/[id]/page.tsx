"use client";

import {
	Suspense,
	useCallback,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
	AlertCircle,
	Check,
	FileDown,
	FileSearch,
	Loader2,
	Lock,
	MoreHorizontal,
	Plus,
	Printer,
	Save,
	Search,
	Sparkles,
	Trash2,
} from "lucide-react";
import { toast } from "sonner";

import {
  BoqCatalogComparisonPanel,
  type BoqComparisonPanelState,
} from "@/components/boq-catalog-comparison-panel";
import { ActionableExtractionReview } from "@/components/actionable-extraction-review";
import { BoqWorkspaceTabs } from "@/components/boq-workspace-tabs";
import {
  createActionableReviewClient,
  type ActionableReviewTransport,
} from "@/lib/actionable-review-client";
import {
  actionableReviewReducer,
  initialActionableReviewState,
} from "@/lib/actionable-review-state";
import { CatalogMatchModal } from "@/components/catalog-match-modal";
import { ExtractionReview } from "@/components/extraction-review";
import { ExtractionWarnings } from "@/components/extraction-warnings";
import { SourceQuoteSummary } from "@/components/source-quote-summary";
import { ProtoBadge } from "@/components/proto-badge";
import { ReviewWorkspace } from "@/components/review-workspace";
import { SimpleBoqReview } from "@/components/simple-review/simple-boq-review";
import dynamic from "next/dynamic";
// pdfjs-dist references browser-only APIs (DOMMatrix) at module evaluation, so the
// viewer must never be server-rendered; load it client-side only.
const PdfReviewViewer = dynamic(
	() => import("@/components/pdf-review-viewer").then((m) => m.PdfReviewViewer),
	{
		ssr: false,
		loading: () => (
			<div
				className="pdf-review-loading"
				role="status"
				aria-label="Loading PDF viewer"
			>
				…
			</div>
		),
	},
);
import { UnifiedBoqItemsTable } from "@/components/unified-boq-items-table";
import { useInlineCatalogMatching } from "@/components/use-inline-catalog-matching";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { buildBoqCsv } from "@/lib/boq-csv";
import { getBoqCatalogReadiness } from "@/lib/boq-catalog-readiness";
import { catalogPendingItems } from "@/lib/catalog-pending-items";
import {
	applyManualCostAllocation,
	deriveSourceCostAllocation,
} from "@/lib/boq-cost-allocation";
import {
	documentTotalMismatchMessage,
	reconcileBoqMutation,
	selectTotalMismatchMessage,
	type BoqDetailEdits,
} from "@/lib/boq-detail-state";
import { getBoqItemRequestIdentity } from "@/lib/boq-item-identity";
import {
	calculateBoqTotals,
	isPricedBoqItem,
	parseNonNegativeBoqEditValue,
} from "@/lib/boq-pricing";
import type { BoqCatalogComparisonRow } from "@/lib/boq-catalog-comparison";
import {
  boqWorkspaceHref,
  isBoqReviewMode,
  safeBoqWorkspaceView,
  safeCompareReturnPath,
  type BoqWorkspaceView,
} from "@/lib/boq-review-route";
import {
	buildCanonicalRevisionKey,
	buildReviewVerification,
} from "@/lib/boq-review-state";
import type { Boq, BoqItem, BoqPricedItem, WorkType } from "@/lib/boq-schema";
import {
	buildUnifiedBoqSections,
	type UnifiedBoqPricedRow,
} from "@/lib/boq-unified-rows";
import type { ActionableReviewStage } from "@/lib/settings-schema";
import { STANDARD_UNITS } from "@/lib/units";
import {
	addWorkspaceUnit,
	loadWorkspaceCustomUnits,
} from "@/lib/workspace-units-client";

type ItemEdit = Record<string, string | number | undefined>;
type EditsMap = BoqDetailEdits;
type LoadState = "loading" | "loaded" | "not-found" | "error";
type MetadataField = "vendor" | "project" | "workType" | "date";
type MetadataEdits = Partial<Pick<Boq, MetadataField>>;
type RightPaneMode = "items" | "extraction";

const requireCatalogReadiness = true;

function rowEditKey(
	row: Pick<UnifiedBoqPricedRow, "sectionIndex" | "itemIndex">,
): string {
	return `${row.sectionIndex}-${row.itemIndex}`;
}

function mergeItemEdits(item: BoqItem, edited: ItemEdit = {}): BoqItem {
	const { materialCost, labourCost, ...directEdits } = edited;
	if (!isPricedBoqItem(item)) {
		return typeof directEdits.desc === "string"
			? { ...item, desc: directEdits.desc }
			: item;
	}
	let merged = { ...item, ...directEdits } as BoqPricedItem;
	if (materialCost !== undefined || labourCost !== undefined) {
		const allocation = deriveSourceCostAllocation(item);
		merged = applyManualCostAllocation(
			merged,
			Number(materialCost ?? allocation?.material ?? 0),
			Number(labourCost ?? allocation?.labour ?? 0),
		);
	}
	if (directEdits.qty !== undefined || directEdits.rate !== undefined)
		merged.total = merged.qty * merged.rate;
	return merged;
}

function confidenceLabel(value: number | undefined): string | null {
	if (!Number.isFinite(value)) return null;
	return `${Math.round((value ?? 0) * 100)}% confidence`;
}

async function readError(
	response: Response,
	fallback: string,
): Promise<string> {
	try {
		const body = (await response.json()) as { error?: unknown };
		return typeof body.error === "string" ? body.error : fallback;
	} catch {
		return fallback;
	}
}

export default function BoqDetailPage() {
	return (
		<Suspense
			fallback={
				<div className="proto-loading-state">
					<div>
						<Loader2 className="animate-spin" />
						Loading BOQ…
					</div>
				</div>
			}
		>
			<BoqDetailContent />
		</Suspense>
	);
}

function BoqDetailContent() {
	const params = useParams();
	const router = useRouter();
	const searchParams = useSearchParams();
	const id = params.id as string;
  const rawView = searchParams.get("view");
  const view = safeBoqWorkspaceView(rawView);
  const rawReturnTo = searchParams.get("returnTo");
  const returnTo = safeCompareReturnPath(rawReturnTo);
	const legacyReviewMode = isBoqReviewMode(searchParams);
	// The simple review page is the default; the older tabbed workspace stays reachable via ?classic=1.
	const classicView = searchParams.get("classic") === "1";
  const shouldCanonicalizeUrl =
    legacyReviewMode ||
    (rawReturnTo !== null && returnTo === null) ||
    (rawView !== null && rawView !== view);
	const [boq, setBoq] = useState<Boq | null>(null);
	const [loadState, setLoadState] = useState<LoadState>("loading");
	const fetchControllerRef = useRef<AbortController | null>(null);

  const handleViewChange = useCallback(
    (nextView: BoqWorkspaceView) => {
      router.replace(boqWorkspaceHref(id, nextView, returnTo) + (classicView ? "&classic=1" : ""), { scroll: false });
    },
    [classicView, id, returnTo, router],
  );

	const fetchBoq = useCallback(async () => {
		fetchControllerRef.current?.abort();
		const controller = new AbortController();
		fetchControllerRef.current = controller;
		setLoadState("loading");
		try {
			const response = await fetch(`/api/boqs/${encodeURIComponent(id)}`, {
				signal: controller.signal,
			});
			if (
				controller.signal.aborted ||
				fetchControllerRef.current !== controller
			)
				return;
			if (response.status === 404) {
				setBoq(null);
				setLoadState("not-found");
				return;
			}
			if (!response.ok) throw new Error("Failed to fetch");
			const result = (await response.json()) as Boq;
			if (
				controller.signal.aborted ||
				fetchControllerRef.current !== controller
			)
				return;
			setBoq(result);
			setLoadState("loaded");
		} catch (error) {
			if (
				controller.signal.aborted ||
				(error instanceof DOMException && error.name === "AbortError")
			)
				return;
			setBoq(null);
			setLoadState("error");
		}
	}, [id]);

	useEffect(() => {
    if (!shouldCanonicalizeUrl) return;
    router.replace(boqWorkspaceHref(id, view, returnTo) + (classicView ? "&classic=1" : ""), { scroll: false });
  }, [classicView, id, returnTo, router, shouldCanonicalizeUrl, view]);

	useEffect(() => {
		let active = true;
		void Promise.resolve().then(() => {
			if (active) void fetchBoq();
		});
		return () => {
			active = false;
			fetchControllerRef.current?.abort();
		};
	}, [fetchBoq]);

	if (loadState === "loading") {
		return (
			<div
				className="proto-empty-state boq-detail-state"
				data-od-id="loading-state"
				role="status"
			>
				<div className="flex items-center gap-2">
					<span className="proto-spinner" aria-hidden="true" />
					Loading BOQ…
				</div>
			</div>
		);
	}

	if (loadState === "error") {
		return (
			<div
				className="proto-empty-state boq-detail-state"
				data-od-id="error-state"
				role="alert"
			>
				<AlertCircle aria-hidden="true" />
				<h3>Couldn’t load this BOQ</h3>
				<p>
					The server did not return the BOQ. Your data has not been changed.
				</p>
				<button className="btn btn-primary" onClick={() => void fetchBoq()}>
					Retry
				</button>
			</div>
		);
	}

	if (loadState === "not-found" || !boq) {
		return (
			<div
				className="proto-empty-state boq-detail-state"
				data-od-id="not-found-state"
			>
				<AlertCircle aria-hidden="true" />
				<h3>BOQ not found</h3>
				<p>It may have been removed, or the link may be incorrect.</p>
        <Link href={returnTo ?? "/boqs"} className="btn btn-secondary">
          {returnTo ? "Back to comparison" : "Back to BOQs"}
				</Link>
			</div>
		);
	}

	if (!classicView) {
		return <SimpleBoqReview key={boq.id} boq={boq} onBoqChange={setBoq} />;
	}

	return (
    <CanonicalBoqWorkspace
      key={boq.id}
      boq={boq}
      onBoqChange={setBoq}
      view={view}
      onViewChange={handleViewChange}
    />
  );
}

type StashedDelete = {
	sectionIndex: number;
	itemIndex: number;
	item: BoqPricedItem;
};

function CanonicalBoqWorkspace({
	boq,
	onBoqChange,
  view,
  onViewChange,
}: {
	boq: Boq;
	onBoqChange: (next: Boq) => void;
  view: BoqWorkspaceView;
  onViewChange: (nextView: BoqWorkspaceView) => void;
}) {
	const [edits, setEdits] = useState<EditsMap>({});
	const editsRef = useRef<EditsMap>({});
	const [metadataEdits, setMetadataEdits] = useState<MetadataEdits>({});
	const metadataEditsRef = useRef<MetadataEdits>({});
	const [search, setSearch] = useState("");
	const [catalogMatchTarget, setCatalogMatchTarget] =
		useState<UnifiedBoqPricedRow | null>(null);
	const [excludeTarget, setExcludeTarget] =
		useState<UnifiedBoqPricedRow | null>(null);
	const [excludeReason, setExcludeReason] = useState("");
	const [saving, setSaving] = useState(false);
	const [approving, setApproving] = useState(false);
	const [matching, setMatching] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const [addingItem, setAddingItem] = useState(false);
	const [rightPaneMode, setRightPaneMode] = useState<RightPaneMode>("items");
	const [missedRowCount, setMissedRowCount] = useState(0);
	const [pdfEvidenceFocus, setPdfEvidenceFocus] = useState<{
		page: number;
		table: number;
		row: number;
		key: number;
	}>({ page: 1, table: 0, row: 0, key: 0 });
	const [invalidDraftKeys, setInvalidDraftKeys] = useState<Set<string>>(
		new Set(),
	);
	const invalidDraftRef = useRef<Set<string>>(new Set());
	const [customUnits, setCustomUnits] = useState<string[]>([]);
	const [workspaceUnitsError, setWorkspaceUnitsError] = useState<
		string | null
	>(null);
	const [pendingDeletes, setPendingDeletes] = useState<StashedDelete[]>([]);
  const [comparisonState, setComparisonState] =
    useState<BoqComparisonPanelState>({
      status: "idle",
      rows: [],
    });
  const [comparisonRevisionKey, setComparisonRevisionKey] = useState<
    string | null
  >(null);
  const comparisonRequestRef = useRef<AbortController | null>(null);
  const [actionableReviewStage, setActionableReviewStage] =
    useState<ActionableReviewStage>("off");
  const [actionableReviewState, dispatchActionableReview] = useReducer(
    actionableReviewReducer,
    undefined,
    initialActionableReviewState,
  );
  const actionableReviewStateRef = useRef(actionableReviewState);
  actionableReviewStateRef.current = actionableReviewState;
	const units = useMemo(
		() => [...STANDARD_UNITS, ...customUnits],
		[customUnits],
	);
	useEffect(() => {
		let active = true;
		void loadWorkspaceCustomUnits()
			.then((loaded) => {
				if (!active) return;
				setWorkspaceUnitsError(null);
				setCustomUnits(loaded);
			})
			.catch((error) => {
				if (!active) return;
				setWorkspaceUnitsError(
					error instanceof Error && error.message
						? error.message
						: "Workspace units could not be loaded.",
				);
			});
		return () => {
			active = false;
		};
	}, []);
	useEffect(() => {
		let active = true;
		const controller = new AbortController();
		void fetch("/api/settings", { signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) return null;
				return (await response.json()) as {
					actionableReview?: { stage?: ActionableReviewStage };
				};
			})
			.then((settings) => {
				if (!active || !settings) return;
				const stage = settings.actionableReview?.stage;
				if (
					stage === "off" ||
					stage === "shadow" ||
					stage === "focused" ||
					stage === "add_and_match" ||
					stage === "default"
				) {
					setActionableReviewStage(stage);
				}
			})
			.catch(() => {
				/* Keep default off stage when settings are unavailable. */
			});
		return () => {
			active = false;
			controller.abort();
		};
	}, []);
	const isReadOnly = boq.status === "approved";
	const useActionableFocusedReview =
		actionableReviewStage === "focused" ||
		actionableReviewStage === "add_and_match" ||
		actionableReviewStage === "default";
  const actionableReviewTransport = useMemo<ActionableReviewTransport>(
    () => ({
      async call(request) {
        // Client DI transport only allows same-origin relative actionable-review API paths.
        if (
          !request.path.startsWith("/api/boqs/") ||
          request.path.includes("://") ||
          request.path.includes("..")
        ) {
          throw new Error("Invalid actionable review request path.");
        }
        const response = await fetch(request.path, {
          method: request.method,
          headers:
            request.body === undefined
              ? undefined
              : { "Content-Type": "application/json" },
          body:
            request.body === undefined
              ? undefined
              : JSON.stringify(request.body),
          signal: request.signal,
        });
        return {
          status: response.status,
          json: () => response.json(),
        };
      },
    }),
    [],
  );
  const actionableReviewClient = useMemo(
    () =>
      createActionableReviewClient({
        transport: actionableReviewTransport,
        dispatch: dispatchActionableReview,
        getSnapshot: () => actionableReviewStateRef.current.snapshot,
        getExpectedVersions: () => {
          const versions = actionableReviewStateRef.current.snapshot?.versions;
          if (!versions) return null;
          return {
            extractionFingerprint: versions.extractionFingerprint,
            boqSectionsFingerprint: versions.boqSectionsFingerprint,
            catalogFingerprint: versions.catalogFingerprint,
            conversionFingerprint: versions.conversionFingerprint,
          };
        },
        readOnly: isReadOnly,
      }),
    [actionableReviewTransport, isReadOnly],
  );
  useEffect(() => {
    if (!useActionableFocusedReview) return;
    const runId = boq.activeExtractionRunId;
    if (!runId || isReadOnly) return;
    void actionableReviewClient.generate(boq.id, runId, "focused");
    return () => {
      actionableReviewClient.cancel();
    };
  }, [
    actionableReviewClient,
    boq.activeExtractionRunId,
    boq.id,
    isReadOnly,
    useActionableFocusedReview,
  ]);
	const mutationBusy =
		saving ||
		approving ||
		matching ||
		deleting ||
		addingItem ||
		pendingDeletes.length > 0;
	const canonicalRevisionKey = useMemo(
		() => buildCanonicalRevisionKey(boq),
		[boq],
	);

  const loadComparison = useCallback(async () => {
    comparisonRequestRef.current?.abort();
    const controller = new AbortController();
    comparisonRequestRef.current = controller;

    setComparisonState((prev) => ({
      status: "loading",
      rows: prev.rows,
    }));

    try {
      const response = await fetch(
        `/api/boqs/${encodeURIComponent(boq.id)}/comparison`,
        { signal: controller.signal },
      );
      if (!response.ok) {
        throw new Error(
          await readError(response, "Comparison could not be loaded"),
        );
      }

      const next = (await response.json()) as {
        boqId?: string;
        rows?: BoqCatalogComparisonRow[];
      };
      if (
        controller.signal.aborted ||
        comparisonRequestRef.current !== controller
      ) {
        return;
      }

      setComparisonState({
        status: "loaded",
        rows: Array.isArray(next.rows) ? next.rows : [],
      });
      setComparisonRevisionKey(canonicalRevisionKey);
    } catch (error) {
      if (
        controller.signal.aborted ||
        comparisonRequestRef.current !== controller ||
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        return;
      }

      setComparisonState((prev) => ({
        status: "error",
        rows: prev.rows,
        message:
          error instanceof Error
            ? error.message
            : "Comparison could not be loaded",
      }));
    }
  }, [boq.id, canonicalRevisionKey]);

  useEffect(() => {
    if (view !== "compare") return;
    if (comparisonRevisionKey === canonicalRevisionKey) return;

    void Promise.resolve().then(() => {
      void loadComparison();
    });

    return () => {
      comparisonRequestRef.current?.abort();
    };
  }, [view, canonicalRevisionKey, comparisonRevisionKey, loadComparison]);

  useEffect(() => {
    return () => {
      comparisonRequestRef.current?.abort();
    };
  }, [boq.id]);

	const replaceEdits = useCallback((next: EditsMap) => {
		editsRef.current = next;
		setEdits(next);
	}, []);

	const replaceMetadataEdits = useCallback((next: MetadataEdits) => {
		metadataEditsRef.current = next;
		setMetadataEdits(next);
	}, []);

	const applyMutationBoq = useCallback(
		(updated: Boq) => {
			const reconciled = reconcileBoqMutation(boq, updated, editsRef.current);
			replaceEdits(reconciled.edits);
			onBoqChange(reconciled.boq);
		},
		[boq, onBoqChange, replaceEdits],
	);

	const commitDeleteRef = useRef<(stash: StashedDelete) => Promise<void>>(
		async () => {},
	);
	useEffect(() => {
		commitDeleteRef.current = async (stash) => {
			if (Object.keys(editsRef.current).length > 0) {
				setPendingDeletes((prev) =>
					prev.filter(
						(pending) =>
							!(
								pending.sectionIndex === stash.sectionIndex &&
								pending.itemIndex === stash.itemIndex
							),
					),
				);
				toast.error("Save pending changes before deleting an item");
				return;
			}
			setDeleting(true);
			try {
				const response = await fetch(
					`/api/boqs/${encodeURIComponent(boq.id)}/items`,
					{
						method: "DELETE",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							sectionIndex: stash.sectionIndex,
							...getBoqItemRequestIdentity(stash.item),
						}),
					},
				);
				if (!response.ok)
					throw new Error(
						await readError(response, "The item could not be deleted."),
					);
				applyMutationBoq((await response.json()) as Boq);
				const editKey = `${stash.sectionIndex}-${stash.itemIndex}`;
				if (editsRef.current[editKey]) {
					const nextEdits = { ...editsRef.current };
					delete nextEdits[editKey];
					replaceEdits(nextEdits);
				}
			} catch (error) {
				toast.error(
					error instanceof Error
						? error.message
						: "The item could not be deleted.",
				);
			} finally {
				setPendingDeletes((prev) =>
					prev.filter(
						(pending) =>
							!(
								pending.sectionIndex === stash.sectionIndex &&
								pending.itemIndex === stash.itemIndex
							),
					),
				);
				setDeleting(false);
			}
		};
	}, [boq, applyMutationBoq, replaceEdits]);

	const displayBoq = useMemo<Boq>(
		() => ({
			...boq,
			...metadataEdits,
			sections: boq.sections.map((section, sectionIndex) => ({
				...section,
				items: section.items.map((item, itemIndex) =>
					mergeItemEdits(item, edits[`${sectionIndex}-${itemIndex}`]),
				),
			})),
		}),
		[boq, edits, metadataEdits],
	);

	const allUnifiedSections = useMemo(() => {
		const built = buildUnifiedBoqSections(displayBoq.sections);
		if (pendingDeletes.length === 0) return built;
		return built.map((section) => ({
			...section,
			rows: section.rows.filter(
				(row) =>
					!pendingDeletes.some(
						(pending) =>
							pending.sectionIndex === row.sectionIndex &&
							pending.itemIndex === row.itemIndex,
					),
			),
		}));
	}, [displayBoq.sections, pendingDeletes]);
	const unifiedSections = useMemo(() => {
		const query = search.trim().toLowerCase();
		return allUnifiedSections
			.map((section) => ({
				...section,
				rows: section.rows.filter((row) => {
					if (!query) return true;
					return (
						row.item.desc.toLowerCase().includes(query) ||
						(row.item.code ?? "").toLowerCase().includes(query)
					);
				}),
			}))
			.filter((section) => section.rows.length > 0);
	}, [allUnifiedSections, search]);

	const items = useMemo(
		() => displayBoq.sections.flatMap((section) => section.items),
		[displayBoq.sections],
	);
	const grandTotal = useMemo(
		() => calculateBoqTotals(displayBoq.sections).grandTotal,
		[displayBoq.sections],
	);
	const catalogReadiness = useMemo(
		() => getBoqCatalogReadiness(displayBoq),
		[displayBoq],
	);
	const catalogPending = useMemo(
		() => catalogPendingItems(displayBoq),
		[displayBoq],
	);
	const [catalogPendingFocus, setCatalogPendingFocus] = useState(false);
	// Row-level PDF focus derived from the last source navigation. Source refs are
	// 1-based, so the initial table 0 / row 0 state means "no navigation yet" and
	// no focus marker is claimed before the operator asks for one.
	const pdfEvidenceFocusTarget = useMemo(
		() =>
			pdfEvidenceFocus.key > 0
				? {
						page: pdfEvidenceFocus.page,
						table: pdfEvidenceFocus.table,
						row: pdfEvidenceFocus.row,
						cells: [],
					}
				: undefined,
		[pdfEvidenceFocus],
	);
	const verification = useMemo(
		() =>
			buildReviewVerification(displayBoq, {
				vendor: displayBoq.vendor,
				project: displayBoq.project,
				workType: displayBoq.workType,
				date: displayBoq.date,
				items,
			}),
		[displayBoq, items],
	);
	const blockingIssues = verification.issues.filter(
		(issue) => issue.severity === "blocking",
	);
	const localWarnings = verification.issues.filter(
		(issue) => issue.severity === "warning",
	);
	const editsCount = Object.keys(edits).length;
	const metadataEditCount = Object.keys(metadataEdits).length;
	const pendingChanges = editsCount + metadataEditCount;
	const documentMismatchReason = displayBoq.sourceQuoteSummary
		? // Summary-backed BOQs surface the layered quote issue messages verbatim.
			selectTotalMismatchMessage(
				displayBoq.sourceTotal,
				grandTotal,
				blockingIssues,
			)
		: verification.issues.some(
				(issue) => issue.code === "document_total_mismatch",
			)
			? documentTotalMismatchMessage(displayBoq.sourceTotal, grandTotal)
			: null;
	const approvalDisabledReason = mutationBusy
		? approving
			? "Approving BOQ…"
			: "Finish the current BOQ update before approving."
		: invalidDraftKeys.size > 0
			? "Fix invalid component costs before approving."
			: pendingChanges > 0
				? "Save pending BOQ changes before approving."
				: verification.hasBlockingIssues
					? documentMismatchReason ?? "Resolve the review blockers below before approving."
					: requireCatalogReadiness && catalogReadiness.blocking > 0
						? `Resolve ${catalogReadiness.blocking} catalog line${catalogReadiness.blocking === 1 ? "" : "s"} before approving.`
						: null;
	const approvalDisabled = approvalDisabledReason !== null;
	const hasSource = boq.sourceAvailable ?? Boolean(boq.sourceFileName);

	const handleCatalogBoqChange = useCallback(
		(updated: Boq) => {
			applyMutationBoq(updated);
		},
		[applyMutationBoq],
	);

	const catalogMatching = useInlineCatalogMatching({
		boq: displayBoq,
		onBoqChange: handleCatalogBoqChange,
		disabled: isReadOnly || mutationBusy,
	});

	const handleAcceptCatalogSuggestion = async (row: UnifiedBoqPricedRow) => {
		if (isReadOnly || mutationBusy) return;
		setMatching(true);
		try {
			await catalogMatching.acceptSuggestion(row);
		} finally {
			setMatching(false);
		}
	};

	const handleEdit = useCallback(
		(
			row: UnifiedBoqPricedRow,
			field: string,
			value: string | number | undefined,
		) => {
			if (isReadOnly || mutationBusy) return;
			const key = rowEditKey(row);
			const current = editsRef.current;
			replaceEdits({ ...current, [key]: { ...current[key], [field]: value } });
		},
		[isReadOnly, mutationBusy, replaceEdits],
	);

	const handleFieldChange = useCallback(
		(
			row: UnifiedBoqPricedRow,
			field:
				| "code"
				| "desc"
				| "unit"
				| "qty"
				| "rate"
				| "type"
				| "materialCost"
				| "labourCost",
			value: string | number | undefined,
		) => {
			if (
				field === "qty" ||
				field === "rate" ||
				field === "materialCost" ||
				field === "labourCost"
			) {
				const parsed = parseNonNegativeBoqEditValue(String(value));
				if (parsed === undefined) return;
				handleEdit(row, field, parsed);
				return;
			}
			handleEdit(row, field, value);
		},
		[handleEdit],
	);

	const handleAddMissingItem = async () => {
		if (isReadOnly || mutationBusy || boq.sections.length === 0) return;
		setAddingItem(true);
		try {
			const response = await fetch(
				`/api/boqs/${encodeURIComponent(boq.id)}/items`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						sectionIndex: boq.sections.length - 1,
						desc: "New missing item",
					}),
				},
			);
			if (!response.ok)
				throw new Error(
					await readError(response, "The missing item could not be added."),
				);
			applyMutationBoq((await response.json()) as Boq);
			toast.success("Missing item added as a user-entered unpriced row");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "The missing item could not be added.",
			);
		} finally {
			setAddingItem(false);
		}
	};

	const handleAddWorkspaceUnit = async (unit: string): Promise<string> => {
		const result = await addWorkspaceUnit(unit);
		setCustomUnits(result.customUnits);
		setWorkspaceUnitsError(null);
		return result.unit;
	};

	const handleIncludeOptional = async (row: UnifiedBoqPricedRow) => {
		if (
			isReadOnly ||
			mutationBusy ||
			!row.item.optional ||
			!row.item.excludedFromTotal
		)
			return;
		setMatching(true);
		try {
			const response = await fetch(
				`/api/boqs/${encodeURIComponent(boq.id)}/items`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						updates: [
							{
								sectionIndex: row.sectionIndex,
								items: [
									{
										...getBoqItemRequestIdentity(row.item),
										excludedFromTotal: false,
									},
								],
							},
						],
					}),
				},
			);
			if (!response.ok)
				throw new Error(
					await readError(response, "The optional item could not be included."),
				);
			applyMutationBoq((await response.json()) as Boq);
			toast.success("Optional item included in the BOQ total");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "The optional item could not be included.",
			);
		} finally {
			setMatching(false);
		}
	};

	const handleDelete = useCallback(
		(row: UnifiedBoqPricedRow) => {
			if (isReadOnly || mutationBusy) return;
			if (Object.keys(editsRef.current).length > 0) {
				return void toast.error("Save pending changes before deleting an item");
			}
			const stash: StashedDelete = {
				sectionIndex: row.sectionIndex,
				itemIndex: row.itemIndex,
				item: row.item,
			};
			setPendingDeletes((prev) => [...prev, stash]);
			const toastId = `delete-${row.sectionIndex}-${row.itemIndex}`;
			let undone = false;
			let committed = false;
			const finalize = () => {
				if (undone || committed) return;
				committed = true;
				void commitDeleteRef.current(stash);
			};
			toast("Line item deleted", {
				id: toastId,
				duration: 6000,
				action: {
					label: "Undo",
					onClick: () => {
						undone = true;
						setPendingDeletes((prev) =>
							prev.filter(
								(pending) =>
									!(
										pending.sectionIndex === stash.sectionIndex &&
										pending.itemIndex === stash.itemIndex
									),
							),
						);
						toast.dismiss(toastId);
					},
				},
				onAutoClose: finalize,
				onDismiss: finalize,
			});
		},
		[isReadOnly, mutationBusy],
	);

	const handleMetadataChange = useCallback(
		(field: MetadataField, value: string) => {
			if (isReadOnly || mutationBusy) return;
			const current = metadataEditsRef.current;
			if (value === boq[field]) {
				const remaining = { ...current };
				delete remaining[field];
				replaceMetadataEdits(remaining);
				return;
			}
			replaceMetadataEdits({
				...current,
				[field]: field === "workType" ? (value as WorkType) : value,
			});
		},
		[boq, isReadOnly, mutationBusy, replaceMetadataEdits],
	);

	const handleComponentDraftValidityChange = useCallback(
		(key: string, isInvalid: boolean) => {
			const next = new Set(invalidDraftRef.current);
			if (isInvalid) {
				next.add(key);
			} else {
				next.delete(key);
			}
			invalidDraftRef.current = next;
			setInvalidDraftKeys(next);
		},
		[],
	);

	const handleSaveAll = async () => {
		if (isReadOnly || mutationBusy) return;
		if (invalidDraftRef.current.size > 0) {
			toast.error(
				"Component costs contain invalid drafts. Fix them before saving.",
			);
			return;
		}
		const editSnapshot = editsRef.current;
		const metadataSnapshot = metadataEditsRef.current;
		const keys = Object.keys(editSnapshot);
		if (keys.length === 0 && Object.keys(metadataSnapshot).length === 0) {
			toast.info("No changes to save");
			return;
		}

		const updates = new Map<
			number,
			{
				sectionIndex: number;
				items: Array<Record<string, string | number | undefined>>;
			}
		>();
		const linkedCanonicalEdits: Array<{ item: BoqItem; standardId: string }> =
			[];
		for (const key of keys) {
			const [sectionIndex, itemIndex] = key.split("-").map(Number);
			const item = boq.sections[sectionIndex]?.items[itemIndex];
			const edit = editSnapshot[key];
			if (!item || !edit) continue;
			const group = updates.get(sectionIndex) ?? { sectionIndex, items: [] };
			group.items.push({ ...getBoqItemRequestIdentity(item), ...edit });
			updates.set(sectionIndex, group);
			if (
				isPricedBoqItem(item) &&
				item.stdId &&
				((edit.desc !== undefined && edit.desc !== item.desc) ||
					(edit.unit !== undefined && edit.unit !== item.unit))
			) {
				linkedCanonicalEdits.push({ item, standardId: item.stdId });
			}
		}

		if (linkedCanonicalEdits.length > 0) {
			const labels = linkedCanonicalEdits
				.map(({ item }) => `• ${item.stdMatch || item.desc}`)
				.join("\n");
			const confirmed = window.confirm(
				`This edit changes a shared catalog item and will update its canonical description or unit on linked BOQ rows. Quantities, rates, and source provenance stay unchanged.\n\n${labels}\n\nContinue?`,
			);
			if (!confirmed) return;
		}

		setSaving(true);
		try {
			if (Object.keys(metadataSnapshot).length > 0) {
				const response = await fetch(
					`/api/boqs/${encodeURIComponent(boq.id)}`,
					{
						method: "PUT",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(metadataSnapshot),
					},
				);
				if (!response.ok)
					throw new Error(
						await readError(response, "Failed to save BOQ details"),
					);
				applyMutationBoq((await response.json()) as Boq);
				replaceMetadataEdits({});
			}

			let synced = 0;
			if (keys.length > 0) {
				const response = await fetch(
					`/api/boqs/${encodeURIComponent(boq.id)}/items`,
					{
						method: "PATCH",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ updates: Array.from(updates.values()) }),
					},
				);
				if (!response.ok)
					throw new Error(await readError(response, "Failed to save changes"));
				const result = (await response.json()) as {
					boq?: Boq;
					sync?: { affectedItems?: number };
				} & Boq;
				applyMutationBoq(result.boq ?? result);
				replaceEdits({});
				synced = result.sync?.affectedItems ?? 0;
			}
			toast.success(
				synced > 0
					? `All changes saved · synced ${synced} linked item${synced === 1 ? "" : "s"}`
					: "All changes saved",
			);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to save changes",
			);
		} finally {
			setSaving(false);
		}
	};

	const handleApprove = async () => {
		if (isReadOnly || mutationBusy) return;
		if (invalidDraftRef.current.size > 0)
			return void toast.error(
				"Component costs contain invalid drafts. Fix them before approving.",
			);
		if (pendingChanges > 0)
			return void toast.error("Save pending changes before approving");
		if (verification.hasBlockingIssues)
			return void toast.error("Resolve the review blockers before approving");
		if (requireCatalogReadiness && catalogReadiness.blocking > 0)
			return void toast.error("Resolve catalog matching before approving");
		setApproving(true);
		try {
			const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ status: "approved" }),
			});
			if (!response.ok) {
        throw new Error(await readError(response, "Failed to approve BOQ"));
      }
      const approved = (await response.json()) as Boq;
      applyMutationBoq(approved);
      toast.success("BOQ approved");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to approve BOQ",
			);
		} finally {
			setApproving(false);
		}
	};

	const reloadAfterManualMatch = async (
		_standardId: string,
		standardDescription: string,
	) => {
		setMatching(true);
		try {
			const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}`);
			if (!response.ok)
				throw new Error(
					await readError(response, "The updated BOQ could not be loaded"),
				);
			applyMutationBoq((await response.json()) as Boq);
			setCatalogMatchTarget(null);
			toast.success(`Matched to: “${standardDescription}”`);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "The catalog match could not be applied",
			);
			throw error;
		} finally {
			setMatching(false);
		}
	};

	const handleExclude = async () => {
		if (!excludeTarget || isReadOnly || mutationBusy) return;
		setMatching(true);
		try {
			const response = await fetch(
				`/api/boqs/${encodeURIComponent(boq.id)}/items`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						updates: [
							{
								sectionIndex: excludeTarget.sectionIndex,
								items: [
									{
										...getBoqItemRequestIdentity(excludeTarget.item),
										stdStatus: "excluded",
										...(excludeReason.trim()
											? { stdExclusionReason: excludeReason.trim() }
											: {}),
									},
								],
							},
						],
					}),
				},
			);
			if (!response.ok)
				throw new Error(
					await readError(response, "The item could not be excluded"),
				);
			const result = (await response.json()) as { boq?: Boq } & Boq;
			applyMutationBoq(result.boq ?? result);
			setExcludeTarget(null);
			setExcludeReason("");
			toast.success("Item excluded from catalog matching");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "The item could not be excluded",
			);
		} finally {
			setMatching(false);
		}
	};

	const handleExportCsv = () => {
		const csv = buildBoqCsv(displayBoq);
		const blob = new Blob([csv], { type: "text/csv" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `${boq.project || "boq"}-detail.csv`;
		anchor.click();
		URL.revokeObjectURL(url);
		toast.success("CSV exported");
	};

	const handleDeleteBoq = async () => {
		if (mutationBusy) return;
		const confirmed = window.confirm(
			`Delete the entire BOQ “${boq.project}” and its source PDF? This cannot be undone.`,
		);
		if (!confirmed) return;
		setDeleting(true);
		try {
			const response = await fetch(`/api/boqs/${encodeURIComponent(boq.id)}`, {
				method: "DELETE",
			});
			if (!response.ok)
				throw new Error(
					await readError(response, "The BOQ could not be deleted"),
				);
			window.location.assign("/boqs");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "The BOQ could not be deleted",
			);
			setDeleting(false);
		}
	};

	return (
		<div
			className="review-embedded boq-unified-workspace"
			data-od-id="boq-detail"
		>
			<div className="review-panel">
				<header
					className="review-header boq-unified-header"
					data-od-id="detail-header"
				>
					<div className="review-header-title">
						<div className="boq-unified-title">
							<strong>{boq.project || "Untitled BOQ"}</strong>
							<span>{boq.vendor}</span>
						</div>
						<ProtoBadge status={boq.status} />
						{isReadOnly ? (
							<span className="boq-readonly-note">
								<Lock aria-hidden="true" />
								Approved · read only
							</span>
						) : null}
					</div>
					<div className="review-header-actions boq-unified-actions">
						<BoqWorkspaceTabs
							view={view}
							reviewIssueCount={blockingIssues.length}
							unmatchedCount={catalogReadiness.blocking}
							onViewChange={onViewChange}
						/>
						{view === "review" && (hasSource || boq.activeExtractionRunId) ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								onClick={() =>
									setRightPaneMode(
										rightPaneMode === "items" ? "extraction" : "items",
									)
								}
								disabled={mutationBusy}
								aria-controls={
									rightPaneMode === "items"
										? "boq-extraction-panel"
										: "boq-items-panel"
								}
							>
								{rightPaneMode === "items" ? (
									<>
										<Sparkles aria-hidden="true" />
										{missedRowCount > 0
											? `Missed rows · ${missedRowCount}`
											: "Missed rows"}
									</>
								) : (
									<>
										<FileSearch aria-hidden="true" />
										BOQ items
									</>
								)}
							</Button>
						) : null}
						{!isReadOnly ? (
							<>
								<Button
									type="button"
									variant="outline"
									size="sm"
									onClick={() => void handleSaveAll()}
									disabled={mutationBusy || invalidDraftKeys.size > 0}
								>
									{saving ? (
										<Loader2 className="animate-spin" />
									) : (
										<Save aria-hidden="true" />
									)}
									Save draft
								</Button>
								<Button
									type="button"
									size="sm"
                  aria-busy={approving}
									aria-describedby={
										approvalDisabledReason ? "approve-boq-blocker" : undefined
									}
									onClick={() => void handleApprove()}
									disabled={approvalDisabled}
								>
									{approving ? (
										<Loader2 className="animate-spin" />
									) : (
										<Check aria-hidden="true" />
									)}
                  {approving ? "Approving…" : "Approve BOQ"}
								</Button>
								{approvalDisabledReason ? (
									<span
										id="approve-boq-blocker"
										data-od-id="approval-blocker"
										className="text-xs text-muted-foreground"
										role="status"
									>
										{approvalDisabledReason}
									</span>
								) : null}
							</>
						) : null}
						<details className="boq-overflow-menu">
							<summary
								className="btn btn-ghost btn-sm"
								aria-label="More BOQ actions"
							>
								<MoreHorizontal aria-hidden="true" />
								<span className="sr-only">More BOQ actions</span>
							</summary>
							<div className="boq-overflow-menu-content" role="menu">
								<button type="button" role="menuitem" onClick={handleExportCsv}>
									<FileDown aria-hidden="true" />
									Export CSV
								</button>
								<button
									type="button"
									role="menuitem"
									onClick={() => window.print()}
								>
									<Printer aria-hidden="true" />
									Print / download
								</button>
								<button
									type="button"
									role="menuitem"
									className="text-destructive"
									disabled={mutationBusy}
									onClick={() => void handleDeleteBoq()}
								>
									<Trash2 aria-hidden="true" />
									Delete BOQ
								</button>
							</div>
						</details>
					</div>
				</header>

				<ReviewWorkspace
					hasSource={hasSource}
					sourceFileName={boq.sourceFileName || "source.pdf"}
					pdf={
						hasSource ? (
							<PdfReviewViewer
								sourceUrl={`/api/boqs/${encodeURIComponent(boq.id)}/source`}
								sourceFileName={boq.sourceFileName || "source.pdf"}
								resetKey={boq.id}
								requestedPage={pdfEvidenceFocus.page}
								requestedPageKey={pdfEvidenceFocus.key}
								evidenceFocus={pdfEvidenceFocusTarget}
							/>
						) : null
					}
				>
          <div
            id="boq-review-panel"
            role="tabpanel"
            aria-labelledby="boq-review-tab"
            hidden={view !== "review"}
          >
					<div
						className="boq-items-mode"
						id="boq-items-panel"
						hidden={rightPaneMode !== "items"}
					>
						<div className="review-metadata">
							<h2 className="text-sm font-medium mb-3">BOQ Details</h2>
							<div className="grid grid-cols-2 gap-3">
								<MetaField
									label="Vendor"
									value={displayBoq.vendor}
									field="vendor"
									disabled={isReadOnly || mutationBusy}
									confidence={confidenceLabel(boq.metadataConfidence?.vendor)}
									onChange={handleMetadataChange}
								/>
								<MetaField
									label="Project"
									value={displayBoq.project}
									field="project"
									disabled={isReadOnly || mutationBusy}
									confidence={confidenceLabel(boq.metadataConfidence?.project)}
									onChange={handleMetadataChange}
								/>
								<MetaField
									label="Work Type"
									value={displayBoq.workType}
									field="workType"
									type="select"
									options={["Unclassified", "Structural", "MEP", "Finishing"]}
									disabled={isReadOnly || mutationBusy}
									confidence={confidenceLabel(boq.metadataConfidence?.workType)}
									onChange={handleMetadataChange}
								/>
								<MetaField
									label="Document Date"
									value={displayBoq.date}
									field="date"
									type="date"
									disabled={isReadOnly || mutationBusy}
									confidence={confidenceLabel(boq.metadataConfidence?.date)}
									onChange={handleMetadataChange}
								/>
							</div>
						</div>

						{displayBoq.sourceQuoteSummary ? (
							<SourceQuoteSummary
								summary={displayBoq.sourceQuoteSummary}
								onNavigateToSource={(sourceRef) =>
									setPdfEvidenceFocus((current) => ({
										page: sourceRef.page,
										table: sourceRef.table,
										row: sourceRef.row,
										key: current.key + 1,
									}))
								}
							/>
						) : null}

						<div className="boq-detail-toolbar" data-od-id="toolbar">
							<div className="search-wrap">
								<Search aria-hidden="true" />
								<Input
									placeholder="Search items…"
									value={search}
									onChange={(event) => setSearch(event.target.value)}
									className="proto-input"
								/>
							</div>
						</div>

						<div className="review-items-heading">
							<span className="text-sm font-medium">
								Parsed Items · {items.length} line items
							</span>
							<div className="review-items-heading-actions">
								<span className="font-mono text-sm">
									Grand Total: ฿{grandTotal.toLocaleString()}
								</span>
								{!isReadOnly ? (
									<Button
										type="button"
										variant="outline"
										size="sm"
										onClick={() => void handleAddMissingItem()}
										disabled={mutationBusy || boq.sections.length === 0}
										data-od-id="add-missing-item"
									>
										{addingItem ? (
											<Loader2 className="animate-spin" />
										) : (
											<Plus aria-hidden="true" />
										)}
										Add missing item
									</Button>
								) : null}
							</div>
						</div>
						{unifiedSections.length > 0 ? (
							<UnifiedBoqItemsTable
								sections={unifiedSections}
								pendingRows={
									catalogPendingFocus && catalogPending.length > 0
										? catalogPending
										: undefined
								}
								readOnly={isReadOnly}
								disabled={isReadOnly || mutationBusy}
								catalogState={catalogMatching.rowState}
								onFieldChange={handleFieldChange}
								onAcceptSuggestion={(row) => {
									void handleAcceptCatalogSuggestion(row);
								}}
								onAiSuggest={(row) => {
									void catalogMatching.suggestWithAi(row);
								}}
								onDismissSuggestion={catalogMatching.dismissSuggestion}
								onFindMatch={setCatalogMatchTarget}
								onExclude={(row) => {
									setExcludeTarget(row);
									setExcludeReason("");
								}}
								onIncludeOptional={(row) => {
									void handleIncludeOptional(row);
								}}
								onClearCatalogError={catalogMatching.clearRowError}
								onComponentDraftValidityChange={
									handleComponentDraftValidityChange
								}
								units={units}
								workspaceUnitsError={workspaceUnitsError}
								onAddUnit={handleAddWorkspaceUnit}
								onDelete={handleDelete}
							/>
						) : (
							<div className="proto-empty-state boq-filter-empty">
								<p>No items match your search</p>
							</div>
						)}

						{requireCatalogReadiness ? (
							<div
								className="rounded-lg border border-accent/25 bg-accent/5 p-3 mt-3"
								data-od-id="catalog-readiness"
							>
								<div className="flex items-center justify-between gap-3 text-sm">
									<strong>Catalog readiness</strong>
									<span className="font-mono">
										{catalogReadiness.resolved}/{catalogReadiness.total}{" "}
										resolved
									</span>
								</div>
								<div
									className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted"
									aria-hidden="true"
								>
									<div
										className="h-full bg-accent"
										style={{
											width: `${catalogReadiness.total ? (catalogReadiness.resolved / catalogReadiness.total) * 100 : 100}%`,
										}}
									/>
								</div>
								<p className="mt-2 text-xs text-muted-foreground">
									Match an existing item, create a catalog entry, or exclude a
									one-off line with a reason before approval.
								</p>
								{catalogReadiness.blocking > 0 ? (
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="mt-2"
										data-od-id="catalog-pending-focus"
										aria-pressed={catalogPendingFocus}
										onClick={() => setCatalogPendingFocus((focus) => !focus)}
									>
										{catalogPendingFocus
											? "Show all items"
											: `Focus on ${catalogPending.length} catalog-pending item${catalogPending.length === 1 ? "" : "s"}`}
									</Button>
								) : null}
							</div>
						) : null}

						{localWarnings.length ? (
							<div
								className="review-warning-list review-local-warnings mt-3"
								role="status"
							>
								<strong>Review recommended</strong>
								{localWarnings.map((warning, index) => (
									<span key={`${warning.code}-${index}`}>
										{warning.message}
									</span>
								))}
							</div>
						) : null}
						{blockingIssues.length ? (
							<div className="review-blockers mt-3" role="alert">
								<strong>Resolve before approval</strong>
								<ul>
									{blockingIssues.map((issue, index) => (
										<li key={`${issue.code}-${index}`}>{issue.message}</li>
									))}
								</ul>
							</div>
						) : null}

						{boq.extractionWarnings?.length ? (
							<ExtractionWarnings
								warnings={boq.extractionWarnings}
								title="Parser details"
								compact
							/>
						) : null}
					</div>
					<div
						className="boq-extraction-mode"
						id="boq-extraction-panel"
						hidden={rightPaneMode !== "extraction"}
					>
						{useActionableFocusedReview ? (
							<ActionableExtractionReview
								snapshot={actionableReviewState.snapshot}
								rolloutStage={actionableReviewStage}
								readOnly={isReadOnly}
								loading={actionableReviewState.loading}
								busy={actionableReviewState.loading}
								submittingSuggestionId={
									actionableReviewState.submittingSuggestionId
								}
								error={actionableReviewState.error}
								selectedSuggestionId={actionableReviewState.selectedSuggestionId}
								auditOpen={actionableReviewState.auditOpen}
								sectionLabels={boq.sections.map((section) => section.header)}
								onSelectSuggestion={(suggestionId) =>
									dispatchActionableReview({
										type: "select_suggestion",
										suggestionId,
									})
								}
								onToggleAudit={() =>
									dispatchActionableReview({ type: "toggle_audit" })
								}
								onNavigateToEvidence={(focus) =>
									setPdfEvidenceFocus((current) => ({
										page: focus.page,
										table: focus.table,
										row: focus.row,
										key: current.key + 1,
									}))
								}
								callbacks={{
									onAddAndMatch: (suggestionId, payload) => {
										const snap = actionableReviewStateRef.current.snapshot;
										const runId = boq.activeExtractionRunId;
										if (!snap || !runId) return;
										void actionableReviewClient.decide(
											boq.id,
											runId,
											suggestionId,
											{
												action: "add_and_match",
												expectedFingerprint: snap.id,
												catalogId: payload.catalogId,
												item: payload.item,
												...(payload.conversionRuleId
													? { conversionRuleId: payload.conversionRuleId }
													: {}),
												...(payload.correctionReason
													? { correctionReason: payload.correctionReason }
													: {}),
											},
										);
									},
									onAddToBoq: (suggestionId, payload) => {
										const snap = actionableReviewStateRef.current.snapshot;
										const runId = boq.activeExtractionRunId;
										if (!snap || !runId) return;
										void actionableReviewClient.decide(
											boq.id,
											runId,
											suggestionId,
											{
												action: "add_pending_catalog",
												expectedFingerprint: snap.id,
												item: payload.item,
												...(payload.correctionReason
													? { correctionReason: payload.correctionReason }
													: {}),
											},
										);
									},
									onFindAnother: (_suggestionId) => {
										const runId = boq.activeExtractionRunId;
										if (!runId) return;
										// Server refresh/generation — never invent client candidates.
										void actionableReviewClient.generate(
											boq.id,
											runId,
											"focused",
										);
									},
									onDoNotAdd: (suggestionId) => {
										const snap = actionableReviewStateRef.current.snapshot;
										const runId = boq.activeExtractionRunId;
										if (!snap || !runId) return;
										void actionableReviewClient.decide(
											boq.id,
											runId,
											suggestionId,
											{
												action: "dismiss",
												expectedFingerprint: snap.id,
											},
										);
									},
									onRestore: (suggestionId) => {
										const runId = boq.activeExtractionRunId;
										if (!runId) return;
										void actionableReviewClient.restore(
											boq.id,
											runId,
											suggestionId,
										);
									},
								}}
							/>
						) : (
						<ExtractionReview
							boq={boq}
							canonicalRevisionKey={canonicalRevisionKey}
							readOnly={isReadOnly}
							mutationBlockedReason={
								invalidDraftKeys.size > 0
									? "Component costs contain invalid drafts. Fix them before applying extraction corrections."
									: pendingChanges > 0
										? "You have unsaved BOQ item or detail edits. Use Save draft before applying extraction corrections."
										: undefined
							}
							sourceAvailable={hasSource}
							onBoqChange={applyMutationBoq}
							onInboxCountChange={setMissedRowCount}
							onNavigateToEvidence={(focus) =>
								setPdfEvidenceFocus((current) => ({
									page: focus.page,
									table: focus.table,
									row: focus.row,
									key: current.key + 1,
								}))
							}
						/>
						)}
					</div>
          </div>
          <div
            id="boq-compare-panel"
            role="tabpanel"
            aria-labelledby="boq-compare-tab"
            hidden={view !== "compare"}
          >
            <BoqCatalogComparisonPanel
              boq={boq}
              state={comparisonState}
              hasUnsavedChanges={
                pendingChanges > 0 || invalidDraftKeys.size > 0
              }
              onRetry={() => {
                void loadComparison();
              }}
              onOpenReview={() => onViewChange("review")}
            />
          </div>
				</ReviewWorkspace>
			</div>

			{catalogMatchTarget ? (
				<CatalogMatchModal
					itemDesc={catalogMatchTarget.item.desc}
					itemUnit={catalogMatchTarget.item.unit}
					itemCode={catalogMatchTarget.item.code}
					sourceProject={boq.project}
					sourceVendor={boq.vendor}
					matchContext={{
						boqId: boq.id,
						sectionIndex: catalogMatchTarget.sectionIndex,
						...getBoqItemRequestIdentity(catalogMatchTarget.item),
					}}
					onMatch={reloadAfterManualMatch}
					onClose={() => setCatalogMatchTarget(null)}
				/>
			) : null}

			<Dialog
				open={Boolean(excludeTarget)}
				onOpenChange={(open) => {
					if (!open && !matching) {
						setExcludeTarget(null);
						setExcludeReason("");
					}
				}}
			>
				<DialogContent showCloseButton={!matching}>
					<DialogHeader>
						<DialogTitle>Exclude from catalog matching</DialogTitle>
						<DialogDescription>
							Add a reason so reviewers understand why{" "}
							{excludeTarget?.item.desc ?? "this item"} should not use catalog
							pricing. (optional)
						</DialogDescription>
					</DialogHeader>
					<Input
						value={excludeReason}
						onChange={(event) => setExcludeReason(event.target.value)}
						placeholder="Optional — reason this line should not use catalog pricing"
						aria-label={`Exclusion reason for ${excludeTarget?.item.desc ?? "item"}`}
						disabled={matching}
						autoFocus
					/>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={matching}
							onClick={() => {
								setExcludeTarget(null);
								setExcludeReason("");
							}}
						>
							Cancel
						</Button>
						<Button
							type="button"
							disabled={matching}
							onClick={() => void handleExclude()}
						>
							{matching ? <Loader2 className="animate-spin" /> : null}Exclude
							item
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function MetaField({
	label,
	value,
	field,
	onChange,
	disabled,
	confidence,
	type = "text",
	options,
}: {
	label: string;
	value: string;
	field: MetadataField;
	onChange: (field: MetadataField, value: string) => void;
	disabled: boolean;
	confidence: string | null;
	type?: "text" | "select" | "date";
	options?: WorkType[];
}) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(value);

	const commit = () => {
		if (draft !== value) onChange(field, draft);
		setEditing(false);
	};

	return (
		<div className="space-y-1" data-meta={field}>
			<div className="review-field-label">
				<span>{label}</span>
				<span className="flex items-center gap-2">
					{confidence ? <small>{confidence}</small> : null}
					{!disabled && !editing ? (
						<button
							type="button"
							className="boq-meta-edit"
							onClick={() => {
								setDraft(value);
								setEditing(true);
							}}
						>
							Edit
						</button>
					) : null}
				</span>
			</div>
			{editing ? (
				type === "select" ? (
					<select
						value={draft}
						disabled={disabled}
						onChange={(event) => setDraft(event.target.value)}
						onBlur={commit}
						className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
						autoFocus
					>
						{options?.map((option) => (
							<option key={option} value={option}>
								{option}
							</option>
						))}
					</select>
				) : (
					<Input
						type={type === "date" ? "date" : "text"}
						value={draft}
						disabled={disabled}
						onChange={(event) => setDraft(event.target.value)}
						onBlur={commit}
						onKeyDown={(event) => {
							if (event.key === "Enter") commit();
							if (event.key === "Escape") setEditing(false);
						}}
						autoFocus
					/>
				)
			) : (
				<div className="boq-meta-readonly-value">{value || "—"}</div>
			)}
		</div>
	);
}
