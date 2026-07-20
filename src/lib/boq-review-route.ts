export function boqDetailHref(id: string): string {
  return `/boqs/${encodeURIComponent(id)}`
}

export function boqReviewHref(id: string): string {
  return boqDetailHref(id)
}

export function isBoqReviewMode(
  searchParams: Pick<URLSearchParams, "get">,
): boolean {
  return searchParams.get("mode") === "review"
}
