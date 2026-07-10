interface ProtoFilterChipProps {
  active: boolean
  label: string
  onClick: () => void
}

export function ProtoFilterChip({ active, label, onClick }: ProtoFilterChipProps) {
  return (
    <button
      onClick={onClick}
      className={`filter-chip ${active ? 'active' : ''}`}
    >
      {label}
    </button>
  )
}
