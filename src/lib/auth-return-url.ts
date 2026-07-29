/**
 * Safe validation for review return URLs after session expiry.
 * Prevents open-redirect vulnerabilities by strictly validating
 * that return paths are internal BOQ review URLs only.
 */

/**
 * Validates and returns a safe return path for post-login redirect.
 * Only accepts internal `/boqs/{opaque-id}` paths with an optional
 * `?reviewRun=...` query parameter. All other inputs return `/dashboard`.
 *
 * Security considerations:
 * - Rejects external URLs (http://, https://, //)
 * - Rejects internal paths outside /boqs/*
 * - Rejects malformed paths (trailing slashes, double slashes, extra segments)
 * - Rejects query strings other than reviewRun
 * - Rejects URL-encoded attacks (including encoded query strings in path segments)
 *
 * @param value - The return path from the query string (may be null or malformed)
 * @returns A safe internal path, or `/dashboard` as fallback
 */
export function safeReviewReturnPath(value: string | null | undefined): string {
  // Handle null/undefined
  if (value == null) {
    return "/dashboard"
  }

  // Must be a string at this point
  if (typeof value !== "string") {
    return "/dashboard"
  }

  const trimmed = value.trim()

  // Reject empty strings
  if (trimmed === "") {
    return "/dashboard"
  }

  // Reject protocol-relative URLs (//example.com)
  if (trimmed.startsWith("//")) {
    return "/dashboard"
  }

  // Reject absolute URLs with protocols
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    return "/dashboard"
  }

  // Must start with exactly /boqs/
  if (!trimmed.startsWith("/boqs/")) {
    return "/dashboard"
  }

  // No trailing slash allowed in the base path
  if (trimmed.endsWith("/")) {
    return "/dashboard"
  }

  // Parse path and query string
  const queryIndex = trimmed.indexOf("?")

  // If there's a "?" but nothing after it, reject (malformed)
  if (queryIndex !== -1 && queryIndex === trimmed.length - 1) {
    return "/dashboard"
  }

  const basePath = queryIndex === -1 ? trimmed : trimmed.slice(0, queryIndex)
  const queryString = queryIndex === -1 ? "" : trimmed.slice(queryIndex + 1)

  // Validate base path format: /boqs/{id} with no trailing segments
  // Format: /boqs/ followed by a non-empty ID, then nothing (no extra slashes)
  const basePathMatch = basePath.match(/^\/boqs\/([^/]+)$/)
  if (!basePathMatch) {
    return "/dashboard"
  }

  const boqId = basePathMatch[1]

  // BOQ ID must not be empty after trimming
  if (boqId.trim() === "") {
    return "/dashboard"
  }

  // Check for URL-encoded attacks in the BOQ ID
  // Decode the ID and verify it doesn't contain path separators or query markers
  try {
    const decodedId = decodeURIComponent(boqId)
    if (decodedId.includes("/") || decodedId.includes("\\") || decodedId.includes("?")) {
      return "/dashboard"
    }
  } catch {
    // If decoding fails, reject the path
    return "/dashboard"
  }

  // If no query string, the path is valid
  // Note: empty query string case (just "?") is already handled above
  if (queryString === "") {
    return trimmed
  }

  // Parse and validate query parameters
  const params = new URLSearchParams(queryString)

  // Must have exactly one parameter: reviewRun
  const keys = Array.from(params.keys())
  if (keys.length !== 1 || keys[0] !== "reviewRun") {
    return "/dashboard"
  }

  const reviewRunValue = params.get("reviewRun")

  // reviewRun must be present and non-empty
  if (!reviewRunValue || reviewRunValue.trim() === "") {
    return "/dashboard"
  }

  // reviewRun must not contain = or & (already handled by URLSearchParams,
  // but double-check for edge cases)
  if (reviewRunValue.includes("=") || reviewRunValue.includes("&")) {
    return "/dashboard"
  }

  // Path is valid
  return trimmed
}
