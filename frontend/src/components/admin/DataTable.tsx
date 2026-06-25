import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react'

import { cn } from '~/lib/utils'

/**
 * The shared `/admin` table (§24.174). One column-configured, client-paginated
 * table that every admin tab rides — Pipeline / Contacts / Visitors / Leads —
 * replacing five hand-rolled `<table>`s. Read-mostly and styled to the existing
 * admin language exactly, so the migration is no-visual-change + pagination.
 *
 * `cell` owns all rendering (truncation, clamps, mono/tabular, nested testids) —
 * `DataTable` adds no magic formatting. A column with a `sort` accessor gets a
 * click-to-sort header; `renderDetail` turns rows into expandable disclosures
 * (the Leads case: per-row controls live in the detail).
 */

export type SortDir = 'asc' | 'desc'

export interface Column<Row> {
  id: string
  header: ReactNode
  /** Cell + header alignment. Numeric/score columns use 'right'. */
  align?: 'left' | 'right'
  cell: (row: Row) => ReactNode
  /** Provide to make this column's header a click-to-sort toggle (desc → asc → off). */
  sort?: (row: Row) => number | string
  headerClassName?: string
  cellClassName?: string
}

export interface DataTableProps<Row> {
  columns: Column<Row>[]
  rows: Row[]
  /** Stable React key; `index` is the absolute position in the (sorted) row set. */
  rowKey: (row: Row, index: number) => string
  /** Rows per page before the pager appears (default 25). */
  pageSize?: number
  /** Tailwind min-width for the inner table (horizontal scroll past it). */
  minWidthClass?: string
  /** Rendered in place of the table when there are no rows. */
  empty?: ReactNode
  rowTestId?: string
  rowClassName?: (row: Row) => string
  /** Expandable disclosure under each row (makes the row clickable). One open at a time. */
  renderDetail?: (row: Row) => ReactNode
  detailTestId?: string
  initialSort?: { columnId: string; dir: SortDir }
  /** When this changes, jump back to page 1 (e.g. a filter-state signature). */
  resetKey?: string | number
}

function compare(x: number | string, y: number | string): number {
  if (typeof x === 'number' && typeof y === 'number') return x - y
  return String(x).localeCompare(String(y))
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  pageSize = 25,
  minWidthClass = 'min-w-[44rem]',
  empty,
  rowTestId,
  rowClassName,
  renderDetail,
  detailTestId,
  initialSort,
  resetKey,
}: DataTableProps<Row>) {
  const [sort, setSort] = useState<{ columnId: string; dir: SortDir } | null>(initialSort ?? null)
  const [page, setPage] = useState(1)
  const [expanded, setExpanded] = useState<string | null>(null)

  // Reset to the first page when the caller's filter signature changes.
  useEffect(() => setPage(1), [resetKey])

  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.id === sort.columnId)
    if (!col?.sort) return rows
    const accessor = col.sort
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => dir * compare(accessor(a), accessor(b)))
  }, [rows, sort, columns])

  const total = sorted.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, pageCount)
  const start = (safePage - 1) * pageSize
  const pageRows = sorted.slice(start, start + pageSize)

  // Click a sortable header: desc (most-first) → asc → off (natural order).
  const onSort = (id: string) =>
    setSort((cur) => {
      if (cur?.columnId !== id) return { columnId: id, dir: 'desc' }
      if (cur.dir === 'desc') return { columnId: id, dir: 'asc' }
      return null
    })

  if (rows.length === 0) return <>{empty ?? <p className="text-sm text-muted-foreground">Nothing here yet.</p>}</>

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className={cn('w-full text-left text-sm', minWidthClass)}>
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {columns.map((col, i) => {
                const active = sort?.columnId === col.id
                return (
                  <th
                    key={col.id}
                    className={cn(
                      'py-2 pr-4 font-mono font-normal',
                      i === 0 && 'pl-4',
                      col.align === 'right' && 'text-right',
                      col.headerClassName,
                    )}
                  >
                    {col.sort ? (
                      <button
                        type="button"
                        data-testid={`datatable-sort-${col.id}`}
                        onClick={() => onSort(col.id)}
                        className={cn(
                          'inline-flex items-center gap-1 uppercase tracking-widest transition-colors hover:text-foreground',
                          active && 'text-foreground',
                        )}
                      >
                        {col.header}
                        <span aria-hidden="true" className="text-[8px]">
                          {active ? (sort?.dir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      </button>
                    ) : (
                      col.header
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, i) => {
              const key = rowKey(row, start + i)
              const isOpen = expanded === key
              return (
                <Fragment key={key}>
                  <tr
                    data-testid={rowTestId}
                    onClick={renderDetail ? () => setExpanded((k) => (k === key ? null : key)) : undefined}
                    className={cn(
                      'border-t border-border',
                      renderDetail && 'cursor-pointer hover:bg-muted/30',
                      rowClassName?.(row),
                    )}
                  >
                    {columns.map((col, i) => (
                      <td
                        key={col.id}
                        className={cn(
                          'py-2 pr-4',
                          i === 0 && 'pl-4',
                          col.align === 'right' && 'text-right',
                          col.cellClassName,
                        )}
                      >
                        {col.cell(row)}
                      </td>
                    ))}
                  </tr>
                  {renderDetail && isOpen ? (
                    <tr data-testid={detailTestId} className="border-t border-border/60 bg-muted/20">
                      <td colSpan={columns.length} className="px-4 py-3">
                        {renderDetail(row)}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      {total > pageSize ? (
        <div data-testid="datatable-pager" className="flex items-center justify-between gap-3 px-1">
          <span data-testid="datatable-range" className="font-mono text-[11px] text-muted-foreground">
            Showing {start + 1}–{Math.min(start + pageSize, total)} of {total}
          </span>
          <div className="flex items-center gap-2">
            <PagerButton testId="datatable-prev" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
              ‹ Prev
            </PagerButton>
            <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
              {safePage} / {pageCount}
            </span>
            <PagerButton testId="datatable-next" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>
              Next ›
            </PagerButton>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function PagerButton({
  testId,
  disabled,
  onClick,
  children,
}: {
  testId: string
  disabled: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
    >
      {children}
    </button>
  )
}
