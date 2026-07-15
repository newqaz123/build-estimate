interface ProtoDataTableProps {
  headers: { label: string; className?: string; tooltip?: string }[]
  children: React.ReactNode
  footer?: React.ReactNode
  ariaLabel?: string
  scrollHint?: string
  dataOdId?: string
}

export function ProtoDataTable({
  headers,
  children,
  footer,
  ariaLabel = "Data table",
  scrollHint = "Scroll horizontally for more columns",
  dataOdId,
}: ProtoDataTableProps) {
  return (
    <div className="data-table-wrap" role="region" aria-label={`${ariaLabel} — horizontally scrollable`} tabIndex={0}>
      <div className="table-scroll-hint" aria-hidden="true">{scrollHint}</div>
      <table className="data-table" aria-label={ariaLabel} data-od-id={dataOdId}>
        <thead>
          <tr>
            {headers.map((h, i) => {
              const tooltipId = `${dataOdId ?? "data-table"}-header-help-${i}`
              return (
                <th key={i} className={h.className || ''}>
                  {h.tooltip ? (
                    <>
                      <span
                        className="status-header"
                        tabIndex={0}
                        aria-describedby={tooltipId}
                        data-tooltip={h.tooltip}
                      >
                        {h.label}
                      </span>
                      <span id={tooltipId} className="sr-only">{h.tooltip}</span>
                    </>
                  ) : h.label}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {footer}
    </div>
  )
}
