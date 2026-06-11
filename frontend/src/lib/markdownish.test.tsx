import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderInline, renderMarkdownish } from './markdownish'

function md(text: string) {
  return render(<div data-testid="md">{renderMarkdownish(text)}</div>).getByTestId('md')
}

describe('markdownish — the Docs→markdown export dialect (§24.65 Δ)', () => {
  it('renders pipe tables (the export ships the scoring rubric as one)', () => {
    const out = md(
      [
        '| Dimension | Strong | Weak |',
        '|-----------|--------|------|',
        '| **Reasoning** | failure modes first | recites tools |',
        '| Communication | thinks aloud | silent leaps |',
      ].join('\n'),
    )
    const table = out.querySelector('table')!
    expect(table).not.toBeNull()
    expect(table.querySelectorAll('th')).toHaveLength(3)
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(screen.getByText('Reasoning').tagName).toBe('STRONG')
    expect(screen.getByText('recites tools')).toBeInTheDocument()
  })

  it('renders * and + bullets like - bullets', () => {
    const out = md('* starred\n+ plussed\n- dashed')
    expect(out.querySelectorAll('li')).toHaveLength(3)
    expect(out.textContent).not.toContain('*')
  })

  it('renders ordered lists, renumbering the export’s repeated 1. markers', () => {
    const out = md('1. first theme\n1. second theme\n2) third theme')
    const ol = out.querySelector('ol')!
    expect(ol).not.toBeNull()
    expect(ol.querySelectorAll('li')).toHaveLength(3)
    expect(out.querySelector('ul')).toBeNull()
  })

  it('unescapes backslash-escaped punctuation in text, bold, and table cells', () => {
    const out = md('revenue \\+38% YoY and R\\&D spend\n\n| a \\+ b |\n| c |')
    expect(out.textContent).toContain('+38% YoY')
    expect(out.textContent).toContain('R&D')
    expect(out.textContent).toContain('a + b')
    expect(out.textContent).not.toContain('\\')
  })

  it('keeps code spans raw (no unescaping inside backticks)', () => {
    const { container } = render(<p>{renderInline('use `a \\+ b` verbatim')}</p>)
    expect(container.querySelector('code')!.textContent).toBe('a \\+ b')
    expect(container.textContent).toContain('use')
  })

  it('still renders the original shapes: headings, rules, paragraphs, bold', () => {
    const out = md('### Heading\n\nplain **bold** text\n\n---\n\nafter')
    expect(out.querySelector('h4')!.textContent).toBe('Heading')
    expect(out.querySelector('hr')).not.toBeNull()
    expect(screen.getByText('bold').tagName).toBe('STRONG')
  })

  it('a table block flushes an open list and vice versa', () => {
    const out = md('- item one\n| cell |\n- item two')
    expect(out.querySelectorAll('ul')).toHaveLength(2)
    expect(out.querySelector('table')).not.toBeNull()
  })
})
