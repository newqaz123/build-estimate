interface ProtoDataTableProps {
  headers: { label: string; className?: string; tooltip?: string }[]
  children: React.ReactNode
}

export function ProtoDataTable({ headers, children }: ProtoDataTableProps) {
  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={i} className={h.className || ''} title={h.tooltip}>
                {h.tooltip ? <span className="cursor-help border-b border-dotted border-[var(--muted)]">{h.label}</span> : h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}
