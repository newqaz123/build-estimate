"use client"

import { useMemo } from "react"

import {
  compactExtractionWarningLocations,
  extractionWarningSourceLabel,
  summarizeExtractionWarnings,
  type ExtractionWarningGroup,
} from "@/lib/boq-extraction-warnings"
import type { BoqExtractionWarning, BoqSourceRef } from "@/lib/boq-schema"

function GroupLocations({ group }: { group: ExtractionWarningGroup }) {
  const refs = group.details
    .map((detail) => detail.sourceRef)
    .filter((ref): ref is BoqSourceRef => ref !== undefined)
  if (refs.length === 0) return null
  const { label, hiddenCount } = compactExtractionWarningLocations(refs)
  return (
    <small className="extraction-warning-group-locations">
      Source: {label}
      {hiddenCount > 0 ? <span className="extraction-warning-group-more"> + {hiddenCount} more</span> : null}
    </small>
  )
}

function WarningGroups({ groups }: { groups: ReadonlyArray<ExtractionWarningGroup> }) {
  return (
    <ul className="extraction-warning-groups">
      {groups.map((group) => (
        <li key={group.code} className="extraction-warning-group">
          <span className="extraction-warning-group-count">{group.count}</span>
          <span className="extraction-warning-group-label">{group.label}</span>
          <GroupLocations group={group} />
        </li>
      ))}
    </ul>
  )
}

/** Concise task summary of document extraction notes: unique affected rows that
 *  need review, document information the operator merely needs to know, and a
 *  single native disclosure preserving the exact original warning codes,
 *  messages, and source locations. */
export function ExtractionWarnings({ warnings, title = "Extraction notes", compact = false }: {
  warnings: ReadonlyArray<BoqExtractionWarning>
  title?: string
  compact?: boolean
}) {
  const summary = useMemo(() => summarizeExtractionWarnings(warnings), [warnings])
  if (summary.needsReview.length === 0 && summary.documentInformation.length === 0) return null

  // Review warnings without a source row are document-level issues, not rows.
  // Counted per raw occurrence so duplicate failures pluralize correctly.
  const documentReviewIssues = summary.needsReview.reduce(
    (total, group) => total + group.occurrences.filter((occurrence) => !occurrence.sourceRef).length,
    0,
  )
  let needsReviewLine: string
  if (summary.affectedRowCount > 0) {
    needsReviewLine =
      summary.affectedRowCount === 1
        ? "1 source row needs review."
        : `${summary.affectedRowCount} source rows need review.`
  } else if (documentReviewIssues === 1) {
    needsReviewLine = "1 document-level issue needs review."
  } else {
    needsReviewLine = `${documentReviewIssues} document-level issues need review.`
  }

  const technicalDetails = (
    <details className="extraction-warning-details">
      <summary className="extraction-warning-details-summary">Technical details · {summary.rawOccurrenceCount} raw notes</summary>
      <ul>
        {[...summary.needsReview, ...summary.documentInformation].flatMap((group) =>
          group.occurrences.map((detail, index) => {
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
  )

  if (compact) {
    return (
      <details className="extraction-warnings extraction-warnings-compact" aria-label={title}>
        <summary>{title}</summary>
        {technicalDetails}
      </details>
    )
  }

  return (
    <div className="review-warning-list extraction-warnings" role="status" aria-label={title}>
      <strong>{title}</strong>
      {summary.needsReview.length > 0 ? (
        <p className="extraction-warnings-summary">{needsReviewLine}</p>
      ) : null}
      {summary.needsReview.length > 0 ? (
        <section aria-label="Needs review" className="extraction-warning-section">
          <WarningGroups groups={summary.needsReview} />
        </section>
      ) : null}
      {summary.documentInformation.length > 0 ? (
        <section aria-label="Document information" className="extraction-warning-section extraction-warning-section-info">
          <WarningGroups groups={summary.documentInformation} />
        </section>
      ) : null}
      {technicalDetails}
    </div>
  )
}
