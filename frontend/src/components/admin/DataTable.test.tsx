import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

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
