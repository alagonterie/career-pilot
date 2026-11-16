import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

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

/** Passed to every `cell` so a control (e.g. a "Details" button) can drive its
 * row's disclosure when `expandOnRowClick` is off. */
export interface CellContext {
  expanded: boolean
  toggle: () => void
}

export interface Column<Row> {
  id: string
  header: ReactNode
  /** Cell + header alignment. Numeric/score columns use 'right'. */
  align?: 'left' | 'right'
  cell: (row: Row, ctx: CellContext) => ReactNode
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
  /** Rows per page before the pager appears (default 10). */
  pageSize?: number
  /** Tailwind min-width for the inner table (horizontal scroll past it). */
  minWidthClass?: string
  /** Fixed table layout — columns keep their widths regardless of cell content
   * (use with per-column width classes when a cell's controls change width). */
  tableFixed?: boolean
  /** Rendered in place of the table when there are no rows. */
  empty?: ReactNode
  /** A static testid for every body row, or a per-row function. */
  rowTestId?: string | ((row: Row, index: number) => string)
  rowClassName?: (row: Row) => string
  /** Expandable disclosure under each row. One open at a time. */
  renderDetail?: (row: Row) => ReactNode
  /** Whether clicking the row toggles its disclosure (default true when
   * `renderDetail` is set). Turn OFF when the row carries its own controls and
   * a specific cell drives the toggle via the cell context instead. */
  expandOnRowClick?: boolean
  detailTestId?: string
  initialSort?: { columnId: string; dir: SortDir }
  /** When this changes, jump back to page 1 (e.g. a filter-state signature). */
  resetKey?: string | number
  /** Optional row selection (§24.202 D2): a leading checkbox column plus a
   * header checkbox that selects / clears the CURRENT PAGE. Controlled — the
   * caller owns the set (keys are `rowKey` values). A checkbox click never
   * toggles the row's disclosure. */
  selection?: {
    selected: ReadonlySet<string>
    onChange: (next: Set<string>) => void
    /** Accessible label for a row's checkbox (default "Select row"). */
    rowLabel?: (row: Row) => string
  }
  /** Optional keyboard-focus support (§24.202 D3): the focused row's key gets a
   * visible focus style; the table pages to it when it changes. */
  focusedKey?: string | null
  /** Called when a row is clicked, so the caller can move its focus there. */
  onRowFocus?: (key: string, row: Row) => void
  /** Controlled disclosure (omit for the internal one-open-at-a-time state). */
  expandedKey?: string | null
  onExpandedChange?: (key: string | null) => void
  /** Reports the row keys in display (sorted) order whenever that order
   * changes — what a caller's j/k navigation should walk. */
  onOrderChange?: (keys: string[]) => void
}

function compare(x: number | string, y: number | string): number {
  if (typeof x === 'number' && typeof y === 'number') return x - y
  return String(x).localeCompare(String(y))
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  pageSize = 10,
  minWidthClass = 'min-w-[44rem]',
  tableFixed,
  empty,
  rowTestId,
  rowClassName,
  renderDetail,
  expandOnRowClick = true,
  detailTestId,
  initialSort,
  resetKey,
  selection,
  focusedKey,
  onRowFocus,
  expandedKey,
  onExpandedChange,
  onOrderChange,
}: DataTableProps<Row>) {
  const [sort, setSort] = useState<{ columnId: string; dir: SortDir } | null>(initialSort ?? null)
  const [page, setPage] = useState(1)
  const [innerExpanded, setInnerExpanded] = useState<string | null>(null)
  const controlledExpand = expandedKey !== undefined
  const expanded = controlledExpand ? expandedKey : innerExpanded
  const setExpanded = (next: string | null): void => {
    if (!controlledExpand) setInnerExpanded(next)
    onExpandedChange?.(next)
  }

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

  const orderedKeys = useMemo(() => sorted.map((r, i) => rowKey(r, i)), [sorted, rowKey])
  const orderSig = orderedKeys.join('\u0000')
  const orderRef = useRef(orderedKeys)
  orderRef.current = orderedKeys
  const onOrderChangeRef = useRef(onOrderChange)
  onOrderChangeRef.current = onOrderChange
  // Report the display order only when it actually changes (a poll that
  // returns the same rows must not churn the caller's state).
  useEffect(() => {
    onOrderChangeRef.current?.(orderRef.current)
  }, [orderSig])

  // Follow the keyboard focus across pages. Keyed on the focus alone, so a
  // background refresh never yanks the owner off a page they paged to.
  const scrollPending = useRef(false)
  useEffect(() => {
    if (focusedKey == null) return
    scrollPending.current = true
    const idx = orderRef.current.indexOf(focusedKey)
    if (idx >= 0) setPage(Math.floor(idx / pageSize) + 1)
  }, [focusedKey, pageSize])

  const total = sorted.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, pageCount)

  // Bring the focused row into view once per focus move (after any page flip
  // the move caused) — never on a background re-render or a manual page turn.
  const rowEls = useRef(new Map<string, HTMLTableRowElement>())
  useEffect(() => {
    if (!scrollPending.current || focusedKey == null) return
    const el = rowEls.current.get(focusedKey)
    if (!el) return
    scrollPending.current = false
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  }, [focusedKey, safePage])
  const start = (safePage - 1) * pageSize
  const pageRows = sorted.slice(start, start + pageSize)
  const pageKeys = pageRows.map((r, i) => rowKey(r, start + i))
  const pageSelectedCount = selection ? pageKeys.filter((k) => selection.selected.has(k)).length : 0
  const allPageSelected = pageKeys.length > 0 && pageSelectedCount === pageKeys.length

  const togglePage = (): void => {
    if (!selection) return
    const next = new Set(selection.selected)
    if (allPageSelected) for (const k of pageKeys) next.delete(k)
    else for (const k of pageKeys) next.add(k)
    selection.onChange(next)
  }
  const toggleRow = (key: string): void => {
    if (!selection) return
    const next = new Set(selection.selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    selection.onChange(next)
  }
  const colCount = columns.length + (selection ? 1 : 0)

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
        <table className={cn('w-full text-left text-sm', tableFixed && 'table-fixed', minWidthClass)}>
          <thead>
            <tr className="text-[10px] uppercase tracking-widest text-muted-foreground">
              {selection ? (
                <th className="w-8 py-2 pl-4 pr-2 font-mono font-normal">
                  <input
                    type="checkbox"
                    data-testid="datatable-select-page"
                    aria-label="Select all rows on this page"
                    checked={allPageSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = pageSelectedCount > 0 && !allPageSelected
                    }}
                    onChange={togglePage}
                    className="cursor-pointer align-middle"
                  />
                </th>
              ) : null}
              {columns.map((col, i) => {
                const active = sort?.columnId === col.id
                return (
                  <th
                    key={col.id}
                    className={cn(
                      'py-2 pr-4 font-mono font-normal',
                      i === 0 && !selection && 'pl-4',
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
              const key = pageKeys[i] as string
              const isOpen = expanded === key
              const toggle = () => setExpanded(expanded === key ? null : key)
              const ctx: CellContext = { expanded: isOpen, toggle }
              const rowClickable = !!renderDetail && expandOnRowClick
              const isFocused = focusedKey != null && focusedKey === key
              const isSelected = selection?.selected.has(key) ?? false
              const onClick =
                rowClickable || onRowFocus
                  ? () => {
                      onRowFocus?.(key, row)
                      if (rowClickable) toggle()
                    }
                  : undefined
              return (
                <Fragment key={key}>
                  <tr
                    data-testid={typeof rowTestId === 'function' ? rowTestId(row, start + i) : rowTestId}
                    data-focused={isFocused ? 'true' : undefined}
                    aria-selected={selection ? isSelected : undefined}
                    ref={(el) => {
                      if (el) rowEls.current.set(key, el)
                      else rowEls.current.delete(key)
                    }}
                    onClick={onClick}
                    className={cn(
                      'border-t border-border',
                      rowClickable && 'cursor-pointer hover:bg-muted/30',
                      isSelected && 'bg-muted/40',
                      isFocused && 'outline outline-2 -outline-offset-2 outline-ring',
                      rowClassName?.(row),
                    )}
                  >
                    {selection ? (
                      // The checkbox cell swallows its clicks so ticking a row
                      // never opens (or closes) its disclosure.
                      <td className="w-8 py-2 pl-4 pr-2" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          data-testid="datatable-select-row"
                          aria-label={selection.rowLabel?.(row) ?? 'Select row'}
                          checked={isSelected}
                          onChange={() => toggleRow(key)}
                          className="cursor-pointer align-middle"
                        />
                      </td>
                    ) : null}
                    {columns.map((col, ci) => (
                      <td
                        key={col.id}
                        className={cn(
                          'py-2 pr-4',
                          ci === 0 && !selection && 'pl-4',
                          col.align === 'right' && 'text-right',
                          col.cellClassName,
                        )}
                      >
                        {col.cell(row, ctx)}
                      </td>
                    ))}
                  </tr>
                  {renderDetail && isOpen ? (
                    <tr data-testid={detailTestId} className="border-t border-border/60 bg-muted/20">
                      <td colSpan={colCount} className="px-4 py-3">
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
