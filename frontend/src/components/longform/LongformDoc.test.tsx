import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LongformDoc } from './LongformDoc'

const SECTIONS = [
  { id: 'a', title: 'Alpha' },
  { id: 'b', title: 'Beta' },
]

// The §24.99 → §24.113 active-section highlight had never been unit-tested (the
// @visual harness captures the doc at the top, where no section is active yet),
// which is how the too-subtle first treatment shipped. This pins the contract:
// clicking a TOC entry activates that section and the desktop rail shows the
// unmistakable indicator (brand-primary label + the accent bar).
describe('LongformDoc active-section highlight', () => {
  function renderDoc() {
    return render(
      <LongformDoc sections={SECTIONS} idPrefix="t" navLabel="On this page">
        <section id="a" data-longform-section="a">
          A
        </section>
        <section id="b" data-longform-section="b">
          B
        </section>
      </LongformDoc>,
    )
  }

  it('starts with no active entry', () => {
    const { container } = renderDoc()
    expect(container.querySelectorAll('[data-testid="t-toc-entry"][data-active="true"]')).toHaveLength(0)
  })

  it('activates the clicked section and shows the rail accent bar', () => {
    const { container } = renderDoc()
    fireEvent.click(screen.getAllByText('Beta')[0])
    const active = [...container.querySelectorAll('[data-testid="t-toc-entry"][data-active="true"]')]
    expect(active.length).toBeGreaterThan(0)
    // The desktop rail's active entry turns brand-primary (the visible signal) and
    // overlays a bg-primary accent bar — neither present on the inactive entries.
    const railActive = active.find((el) => el.className.includes('text-primary'))
    expect(railActive).toBeTruthy()
    expect(railActive!.querySelector('.bg-primary')).toBeTruthy()
  })
})
