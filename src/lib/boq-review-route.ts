const INTERNAL_ORIGIN = "https://buildestimate.local"
const COMPARE_PATH = "/compare"

export function boqDetailHref(id: string): string {
  return `/boqs/${encodeURIComponent(id)}`
}

export function boqReviewHref(id: string): string {
  return boqDetailHref(id)
}

export function compareBoqHref(id: string): string {
  return `${COMPARE_PATH}?${new URLSearchParams({ boq: id }).toString()}`
}

export function safeCompareReturnPath(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") return null

  const trimmed = value.trim()
  if (trimmed === COMPARE_PATH) return COMPARE_PATH
  if (!trimmed.startsWith(`${COMPARE_PATH}?`)) return null

  try {
    decodeURIComponent(trimmed)
  } catch {
    return null
  }

  let parsed: URL
  try {
    parsed = new URL(trimmed, INTERNAL_ORIGIN)
  } catch {
    return null
  }

  if (
    parsed.origin !== INTERNAL_ORIGIN
    || parsed.pathname !== COMPARE_PATH
    || parsed.hash
  ) {
    return null
  }

  if (!parsed.search) return null

  const keys = Array.from(parsed.searchParams.keys())
  const boqValues = parsed.searchParams.getAll("boq")
  if (
    keys.length !== 1
    || keys[0] !== "boq"
    || boqValues.length !== 1
  ) {
    return null
  }

  const boqId = boqValues[0]
  if (!boqId || !boqId.trim()) return null

  return compareBoqHref(boqId)
}

export function boqDetailReturnHref(
  id: string,
  returnTo: string | null | undefined,
): string {
  const safeReturnTo = safeCompareReturnPath(returnTo)
  if (!safeReturnTo) return boqDetailHref(id)

  const query = new URLSearchParams({ returnTo: safeReturnTo })
  return `${boqDetailHref(id)}?${query.toString()}`
}

export function boqComparisonReviewHref(id: string): string {
  return boqDetailReturnHref(id, compareBoqHref(id))
}

export function isBoqReviewMode(
  searchParams: Pick<URLSearchParams, "get">,
): boolean {
  return searchParams.get("mode") === "review"
}

export type BoqWorkspaceView = "review" | "compare"

export function safeBoqWorkspaceView(
  value: string | null | undefined,
): BoqWorkspaceView {
  return value === "compare" ? "compare" : "review"
}

export function boqWorkspaceHref(
  id: string,
  view: BoqWorkspaceView,
  returnTo?: string | null,
): string {
  const query = new URLSearchParams({ view })
  const safeReturnTo = safeCompareReturnPath(returnTo)
  if (safeReturnTo) query.set("returnTo", safeReturnTo)
  return `${boqDetailHref(id)}?${query.toString()}`
}

/**
 * The simple review page is the default BOQ page. The tabbed workspace is used
 * for ?classic=1 and for links that ask for the comparison view (the Compare
 * inbox "Open comparison" button), which only the tabbed workspace renders.
 */
export function wantsClassicBoqWorkspace(params: { get(name: string): string | null }): boolean {
  return params.get('classic') === '1' || params.get('view') === 'compare'
}
