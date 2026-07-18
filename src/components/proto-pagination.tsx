interface ProtoPaginationProps {
  page: number
  totalPages: number
  total: number
  limit: number
  onPageChange: (page: number) => void
}

export function ProtoPagination({ page, totalPages, total, limit, onPageChange }: ProtoPaginationProps) {
  const start = Math.min((page - 1) * limit + 1, total)
  const end = Math.min(page * limit, total)

  const pages: number[] = []
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pages.push(i)
  } else if (page <= 4) {
    for (let i = 1; i <= 7; i++) pages.push(i)
  } else if (page >= totalPages - 3) {
    for (let i = totalPages - 6; i <= totalPages; i++) pages.push(i)
  } else {
    for (let i = page - 3; i <= page + 3; i++) pages.push(i)
  }

  return (
    <nav className="proto-pagination" aria-label="BOQ pagination">
      <span>Showing {start}–{end} of {total}</span>
      <div className="pp-btns">
        <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => onPageChange(page - 1)}>‹</button>
        {pages.map(p => (
          <button
            type="button"
            key={p}
            className={p === page ? 'active' : ''}
            aria-label={`Page ${p}`}
            aria-current={p === page ? "page" : undefined}
            onClick={() => onPageChange(p)}
          >
            {p}
          </button>
        ))}
        <button type="button" aria-label="Next page" disabled={page >= totalPages} onClick={() => onPageChange(page + 1)}>›</button>
      </div>
    </nav>
  )
}
