interface ProtoFilterChipProps {
  active: boolean
  label: string
  onClick: () => void
}

export function ProtoFilterChip({ active, label, onClick }: ProtoFilterChipProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`filter-chip ${active ? 'active' : ''}`}
    >
      {label}
    </button>
  )
}
