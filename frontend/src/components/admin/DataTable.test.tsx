import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { DataTable, type Column } from './DataTable'

interface Row {
  id: string
  name: string
  score: number
}

const COLS: Column<Row>[] = [
  { id: 'name', header: 'Name', cell: (r) => r.name },
  { id: 'score', header: 'Score', align: 'right', cell: (r) => r.score, sort: (r) => r.score },
]

function rows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, name: `Row ${i}`, score: i }))
}

describe('DataTable', () => {
  it('renders the empty slot when there are no rows', () => {
    render(<DataTable columns={COLS} rows={[]} rowKey={(r) => r.id} empty={<p>No rows.</p>} />)
    expect(screen.getByText('No rows.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).not.toBeInTheDocument()
  })

  it('shows no pager when rows fit one page', () => {
    render(<DataTable columns={COLS} rows={rows(3)} rowKey={(r) => r.id} pageSize={25} rowTestId="row" />)
    expect(screen.getAllByTestId('row')).toHaveLength(3)
    expect(screen.queryByTestId('datatable-pager')).not.toBeInTheDocument()
  })

  it('paginates: range label + Prev/Next walk the pages', () => {
    render(<DataTable columns={COLS} rows={rows(7)} rowKey={(r) => r.id} pageSize={3} rowTestId="row" />)
    expect(screen.getAllByTestId('row')).toHaveLength(3)
    expect(screen.getByTestId('datatable-range')).toHaveTextContent('Showing 1–3 of 7')
    expect(screen.getByTestId('datatable-prev')).toBeDisabled()

    fireEvent.click(screen.getByTestId('datatable-next'))
    expect(screen.getByTestId('datatable-range')).toHaveTextContent('Showing 4–6 of 7')

    fireEvent.click(screen.getByTestId('datatable-next'))
    expect(screen.getByTestId('datatable-range')).toHaveTextContent('Showing 7–7 of 7')
    expect(screen.getByTestId('datatable-next')).toBeDisabled()
    expect(screen.getAllByTestId('row')).toHaveLength(1) // last page partial
  })

  it('sorts on a sortable header (desc → asc → off)', () => {
    render(<DataTable columns={COLS} rows={rows(3)} rowKey={(r) => r.id} rowTestId="row" />)
    const order = () => screen.getAllByTestId('row').map((tr) => within(tr).getByText(/Row/).textContent)
    expect(order()).toEqual(['Row 0', 'Row 1', 'Row 2']) // natural

    fireEvent.click(screen.getByTestId('datatable-sort-score')) // desc
    expect(order()).toEqual(['Row 2', 'Row 1', 'Row 0'])

    fireEvent.click(screen.getByTestId('datatable-sort-score')) // asc
    expect(order()).toEqual(['Row 0', 'Row 1', 'Row 2'])

    fireEvent.click(screen.getByTestId('datatable-sort-score')) // off → natural
    expect(order()).toEqual(['Row 0', 'Row 1', 'Row 2'])
  })

  it('expands a row to its detail when renderDetail is provided (one open at a time)', () => {
    render(
      <DataTable
        columns={COLS}
        rows={rows(3)}
        rowKey={(r) => r.id}
        rowTestId="row"
        detailTestId="detail"
        renderDetail={(r) => <span>detail for {r.name}</span>}
      />,
    )
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument()

    fireEvent.click(screen.getAllByTestId('row')[0])
    expect(screen.getByTestId('detail')).toHaveTextContent('detail for Row 0')

    // opening another closes the first
    fireEvent.click(screen.getAllByTestId('row')[1])
    expect(screen.getAllByTestId('detail')).toHaveLength(1)
    expect(screen.getByTestId('detail')).toHaveTextContent('detail for Row 1')

    // clicking the open row again collapses it
    fireEvent.click(screen.getAllByTestId('row')[1])
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument()
  })

  it('with expandOnRowClick off, a cell drives the disclosure (not a row click)', () => {
    const cols: Column<Row>[] = [
      ...COLS,
      {
        id: 'act',
        header: 'Act',
        cell: (_r, ctx) => <button onClick={ctx.toggle}>{ctx.expanded ? 'hide' : 'show'}</button>,
      },
    ]
    render(
      <DataTable
        columns={cols}
        rows={rows(2)}
        rowKey={(r) => r.id}
        rowTestId="row"
        detailTestId="detail"
        expandOnRowClick={false}
        renderDetail={(r) => <span>detail {r.name}</span>}
      />,
    )
    // a row click does NOT expand
    fireEvent.click(screen.getAllByTestId('row')[0])
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument()
    // the cell's button does
    fireEvent.click(screen.getAllByText('show')[0])
    expect(screen.getByTestId('detail')).toHaveTextContent('detail Row 0')
  })

  it('without selection props renders no checkbox column (other tables unaffected)', () => {
    render(<DataTable columns={COLS} rows={rows(2)} rowKey={(r) => r.id} rowTestId="row" />)
    expect(screen.queryByTestId('datatable-select-page')).not.toBeInTheDocument()
    expect(screen.queryAllByTestId('datatable-select-row')).toHaveLength(0)
    expect(within(screen.getAllByTestId('row')[0]).getAllByRole('cell')).toHaveLength(2)
  })

  it('wiring a selection adds a checkbox column whose clicks never toggle the disclosure', () => {
    function Harness() {
      const [sel, setSel] = useState<Set<string>>(new Set())
      return (
        <>
          <span data-testid="sel">{[...sel].sort().join(',')}</span>
          <DataTable
            columns={COLS}
            rows={rows(3)}
            rowKey={(r) => r.id}
            rowTestId="row"
            detailTestId="detail"
            renderDetail={(r) => <span>detail {r.name}</span>}
            selection={{ selected: sel, onChange: setSel, rowLabel: (r) => `Select ${r.name}` }}
          />
        </>
      )
    }
    render(<Harness />)
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Row 1' }))
    expect(screen.getByTestId('sel')).toHaveTextContent('r1')
    expect(screen.queryByTestId('detail')).not.toBeInTheDocument() // no expansion
    expect(screen.getAllByTestId('row')[1]).toHaveAttribute('aria-selected', 'true')
    // the detail row spans the extra column
    fireEvent.click(screen.getAllByTestId('row')[0])
    expect(screen.getByTestId('detail').querySelector('td')).toHaveAttribute('colspan', '3')
    // untick
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Row 1' }))
    expect(screen.getByTestId('sel')).toHaveTextContent('')
  })

  it('the header checkbox selects / clears the CURRENT PAGE only, and is indeterminate when partial', () => {
    function Harness() {
      const [sel, setSel] = useState<Set<string>>(new Set())
      return (
        <>
          <span data-testid="sel">{[...sel].sort().join(',')}</span>
          <DataTable
            columns={COLS}
            rows={rows(5)}
            rowKey={(r) => r.id}
            pageSize={2}
            rowTestId="row"
            selection={{ selected: sel, onChange: setSel }}
          />
        </>
      )
    }
    render(<Harness />)
    const pageBox = () => screen.getByTestId('datatable-select-page') as HTMLInputElement
    fireEvent.click(pageBox())
    expect(screen.getByTestId('sel')).toHaveTextContent('r0,r1')
    expect(pageBox().checked).toBe(true)

    fireEvent.click(screen.getByTestId('datatable-next'))
    expect(pageBox().checked).toBe(false) // page 2 untouched
    fireEvent.click(screen.getAllByTestId('datatable-select-row')[0])
    expect(pageBox().indeterminate).toBe(true)
    fireEvent.click(pageBox()) // partial → select the rest of this page
    expect(screen.getByTestId('sel')).toHaveTextContent('r0,r1,r2,r3')
    fireEvent.click(pageBox()) // all → clear this page only
    expect(screen.getByTestId('sel')).toHaveTextContent('r0,r1')
  })

  it('marks the focused row, pages to it, and reports row clicks + display order', () => {
    const onFocus = vi.fn()
    const onOrder = vi.fn()
    const { rerender } = render(
      <DataTable
        columns={COLS}
        rows={rows(5)}
        rowKey={(r) => r.id}
        pageSize={2}
        rowTestId="row"
        focusedKey={null}
        onRowFocus={onFocus}
        onOrderChange={onOrder}
      />,
    )
    expect(onOrder).toHaveBeenLastCalledWith(['r0', 'r1', 'r2', 'r3', 'r4'])
    fireEvent.click(screen.getAllByTestId('row')[1])
    expect(onFocus).toHaveBeenCalledWith('r1', expect.objectContaining({ id: 'r1' }))

    // focusing a row on page 3 jumps there and styles it
    rerender(
      <DataTable
        columns={COLS}
        rows={rows(5)}
        rowKey={(r) => r.id}
        pageSize={2}
        rowTestId="row"
        focusedKey="r4"
        onRowFocus={onFocus}
        onOrderChange={onOrder}
      />,
    )
    expect(screen.getByTestId('datatable-range')).toHaveTextContent('Showing 5–5 of 5')
    expect(screen.getByTestId('row')).toHaveAttribute('data-focused', 'true')

    // a header sort changes the reported order (what j/k must walk)
    onOrder.mockClear()
    fireEvent.click(screen.getByTestId('datatable-sort-score'))
    expect(onOrder).toHaveBeenLastCalledWith(['r4', 'r3', 'r2', 'r1', 'r0'])
  })

  it('a controlled expandedKey drives the disclosure and row clicks report through onExpandedChange', () => {
    const onExpanded = vi.fn()
    render(
      <DataTable
        columns={COLS}
        rows={rows(2)}
        rowKey={(r) => r.id}
        rowTestId="row"
        detailTestId="detail"
        renderDetail={(r) => <span>detail {r.name}</span>}
        expandedKey="r1"
        onExpandedChange={onExpanded}
      />,
    )
    expect(screen.getByTestId('detail')).toHaveTextContent('detail Row 1')
    fireEvent.click(screen.getAllByTestId('row')[0])
    expect(onExpanded).toHaveBeenCalledWith('r0')
    // controlled: nothing changes until the parent says so
    expect(screen.getByTestId('detail')).toHaveTextContent('detail Row 1')
  })

  it('resets to page 1 when resetKey changes', () => {
    const { rerender } = render(
      <DataTable columns={COLS} rows={rows(7)} rowKey={(r) => r.id} pageSize={3} rowTestId="row" resetKey="a" />,
    )
    fireEvent.click(screen.getByTestId('datatable-next'))
    expect(screen.getByTestId('datatable-range')).toHaveTextContent('Showing 4–6 of 7')

    rerender(<DataTable columns={COLS} rows={rows(7)} rowKey={(r) => r.id} pageSize={3} rowTestId="row" resetKey="b" />)
    expect(screen.getByTestId('datatable-range')).toHaveTextContent('Showing 1–3 of 7')
  })
})
