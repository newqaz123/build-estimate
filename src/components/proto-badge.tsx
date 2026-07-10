interface ProtoBadgeProps {
  status: 'draft' | 'active' | 'review' | 'approved' | 'rejected' | 'matched' | 'suggested' | 'fuzzy' | 'llm' | 'unmatched'
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
}

export function ProtoBadge({ status, label, className = '', children }: ProtoBadgeProps) {
  const cls = BADGE_CLASS[status] || 'badge-draft'
  return (
    <span className={`inline-flex items-center gap-[5px] px-[10px] py-[2px] rounded-[9999px] text-xs font-medium tracking-[0.02em] whitespace-nowrap ${cls} ${className}`}>
      {children}
      {label || status}
    </span>
  )
}
