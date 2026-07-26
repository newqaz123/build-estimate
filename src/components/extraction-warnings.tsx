"use client"

import { useMemo } from "react"

import {
  extractionWarningSourceLabel,
  groupExtractionWarnings,
  type ExtractionWarningGroup,
} from "@/lib/boq-extraction-warnings"
import type { BoqExtractionWarning } from "@/lib/boq-schema"

function SourceLabel({ group }: { group: ExtractionWarningGroup }) {
  const locations = group.details
    .map((detail) => extractionWarningSourceLabel(detail.sourceRef))
    .filter((label): label is string => label !== null)
  if (locations.length === 0) return null
  const unique = [...new Set(locations)]
  return <small className="extraction-warning-group-locations">Source: {unique.join("; ")}</small>
}

/** Concise grouped summary of document extraction notes, with an accessible
 *  native disclosure that preserves the exact original warning messages and
 *  source locations. Replaces the flat repetitive list. */
export function ExtractionWarnings({ warnings, title = "Extraction notes" }: {
  warnings: ReadonlyArray<BoqExtractionWarning>
  title?: string
}) {
  const groups = useMemo(() => groupExtractionWarnings(warnings), [warnings])
  const occurrenceCount = warnings.length
  if (groups.length === 0) return null

  return (
    <div className="review-warning-list extraction-warnings" role="status" aria-label={title}>
      <strong>{title}</strong>
      <p className="extraction-warnings-summary">
        {occurrenceCount} extraction {occurrenceCount === 1 ? "note" : "notes"} {occurrenceCount === 1 ? "needs" : "need"} review.
      </p>
      <ul className="extraction-warning-groups">
        {groups.map((group) => (
          <li key={group.code} className="extraction-warning-group">
            <span className="extraction-warning-group-count">{group.count}</span>
            <span className="extraction-warning-group-label">{group.label}</span>
            <SourceLabel group={group} />
          </li>
        ))}
      </ul>
      <details className="extraction-warning-details">
        <summary className="extraction-warning-details-summary">Technical details</summary>
        <ul>
          {groups.flatMap((group) =>
            group.details.map((detail, index) => {
              const location = extractionWarningSourceLabel(detail.sourceRef)
              return (
                <li key={`${group.code}-${index}`} className="extraction-warning-detail">
                  <code>{group.code}</code>
                  <span>{detail.message}</span>
                  {location ? <small>{location}</small> : null}
                </li>
              )
            }),
          )}
        </ul>
      </details>
    </div>
  )
}
