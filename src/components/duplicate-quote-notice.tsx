"use client"

import Link from "next/link"
import { Copy } from "lucide-react"
import type { ReactNode } from "react"

import type { DuplicateMatch } from "@/lib/boq-duplicates"

const REASON_TEXT: Record<DuplicateMatch["reason"], string> = {
  same_file: "same PDF file",
  same_quote: "same vendor, date, total and rows",
}

function label(match: DuplicateMatch): string {
  const parts = [match.project || "Untitled quote", match.vendor, match.date].filter(Boolean)
  return parts.join(" · ")
}

/** Plain list of quotes that look like this one, each linking to its page. */
export function DuplicateQuoteNotice({ title, matches, children, testId }: { title: string; matches: DuplicateMatch[]; children?: ReactNode; testId?: string }) {
  if (!matches.length) return null
  return (
    <div className="duplicate-quote-notice" role="alert" data-testid={testId}>
      <Copy aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <ul>
          {matches.map((match) => (
            <li key={match.id}>
              <Link href={`/boqs/${encodeURIComponent(match.id)}`} target="_blank" rel="noreferrer">{label(match)}</Link>
              {" "}
              <span className="duplicate-quote-muted">({match.status === "approved" ? "approved" : "not approved yet"}, {REASON_TEXT[match.reason]})</span>
            </li>
          ))}
        </ul>
        {children ? <div className="duplicate-quote-actions">{children}</div> : null}
      </div>
    </div>
  )
}
