interface ProtoBadgeProps {
  status: 'draft' | 'active' | 'review' | 'approved' | 'rejected' | 'matched' | 'suggested' | 'fuzzy' | 'llm' | 'unmatched' | 'excluded' | 'parsed' | 'pending'
  label?: string
  className?: string
  children?: React.ReactNode
}

const BADGE_CLASS: Record<string, string> = {
  draft: 'badge-draft',
  active: 'badge-active',
  review: 'badge-review',
  approved: 'badge-approved',
  rejected: 'badge-rejected',
  matched: 'badge-matched',
  suggested: 'badge-suggested',
  fuzzy: 'badge-fuzzy',
  llm: 'badge-llm',
  unmatched: 'badge-unmatched',
  excluded: 'badge-excluded',
  parsed: 'badge-draft',
  pending: 'badge-suggested',
}

const LABEL_MAP: Record<string, string> = {
  draft: 'Draft',
  active: 'Active',
  review: 'Review',
  approved: 'Approved',
  rejected: 'Rejected',
  matched: 'Matched',
  suggested: 'Suggested',
  fuzzy: 'Fuzzy',
  llm: 'LLM',
  unmatched: 'Unmatched',
  excluded: 'Excluded',
  parsed: 'Parsed',
  pending: 'Pending',
}

export function ProtoBadge({ status, label, className = '', children }: ProtoBadgeProps) {
  const cls = BADGE_CLASS[status] || 'badge-draft'
  const text = label || LABEL_MAP[status] || status
  return (
    <span className={`inline-flex items-center gap-[5px] px-[10px] py-[2px] rounded-[9999px] text-xs font-medium tracking-[0.02em] whitespace-nowrap ${cls} ${className}`}>
      {children}
      {text}
    </span>
  )
}
