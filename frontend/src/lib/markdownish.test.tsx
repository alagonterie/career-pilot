import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderInline, renderMarkdownish } from './markdownish'

function md(text: string) {
  return render(<div data-testid="md">{renderMarkdownish(text)}</div>).getByTestId('md')
}

describe('markdownish — real markdown via react-markdown (§24.182)', () => {
  it('numbers an ordered list 1..N even when nested sub-bullets interrupt each item', () => {
    // The headline bug: the rubric rendered every item as "1." because nested
    // bullets flushed the list. One <ol>, three items, nesting preserved.
    const out = md(
      [
        '1. First criterion',
        '   - strong: does X',
        '   - weak: does Y',
        '2. Second criterion',
        '   - strong: does Z',
        '3. Third criterion',
      ].join('\n'),
    )
    const ols = out.querySelectorAll('ol')
    expect(ols).toHaveLength(1)
    const items = ols[0].querySelectorAll(':scope > li')
    expect(items).toHaveLength(3)
    expect(items[0].querySelector('ul')).not.toBeNull() // nested list preserved
  })

  it('renders single-asterisk italics as <em>, not literal asterisks', () => {
    const out = md('weight *pragmatism* over breadth')
    expect(out.querySelector('em')?.textContent).toBe('pragmatism')
    expect(out.textContent).not.toContain('*')
  })

  it('renders markdown links as anchors (no literal link syntax)', () => {
    const out = md('see [the JD](https://x.test/jd) for detail')
    const a = out.querySelector('a')!
    expect(a.getAttribute('href')).toBe('https://x.test/jd')
    expect(a.textContent).toBe('the JD')
    expect(out.textContent).not.toContain('](')
  })

  it('renders GFM pipe tables with bold cells', () => {
    const out = md(['| Dimension | Strong |', '| --- | --- |', '| **Reasoning** | failure modes first |'].join('\n'))
    const table = out.querySelector('table')!
    expect(table).not.toBeNull()
    expect(table.querySelectorAll('th')).toHaveLength(2)
    expect(screen.getByText('Reasoning').tagName).toBe('STRONG')
  })

  it('renders *, +, and - bullets alike', () => {
    const out = md('* starred\n+ plussed\n- dashed')
    expect(out.querySelectorAll('li')).toHaveLength(3)
    expect(out.textContent).not.toContain('*')
  })

  it('unescapes backslash-escaped punctuation (CommonMark)', () => {
    const out = md('revenue \\+38% YoY and R\\&D spend')
    expect(out.textContent).toContain('+38% YoY')
    expect(out.textContent).toContain('R&D')
    expect(out.textContent).not.toContain('\\')
  })

  it('renders headings, a rule, and bold', () => {
    const out = md('### Heading\n\nplain **bold** text\n\n---\n\nafter')
    expect(out.querySelector('h4')?.textContent).toBe('Heading') // ### → minor tier
    expect(out.querySelector('hr')).not.toBeNull()
    expect(screen.getByText('bold').tagName).toBe('STRONG')
  })
})

describe('markdownish — redaction chips (§24.182 / §24.134d)', () => {
  it('turns a standalone token into a chip, not literal text', () => {
    const out = md('they just closed a [AMOUNT_REDACTED] round')
    const chip = out.querySelector('[data-testid="redaction-chip"]')
    expect(chip?.getAttribute('data-tier')).toBe('pii')
    expect(out.textContent).not.toContain('[AMOUNT_REDACTED]')
  })

  it('chips a token that sits inside bold (rehype pass reaches nested text)', () => {
    const out = md('**[REDACTED:infra-d] Intelligence** is the roadmap')
    const strong = out.querySelector('strong')!
    const chip = strong.querySelector('[data-testid="redaction-chip"]')
    expect(chip?.getAttribute('data-tier')).toBe('company')
    expect(chip?.textContent).toContain('infra-d')
    expect(out.textContent).not.toContain('[REDACTED:infra-d]')
  })

  it('degrades gracefully on a malformed nested token — the inner chips, nothing crashes', () => {
    // Pre-fix data could carry [REDACTED:[AI_REDACTED]]; the inner token chips
    // and the render never throws (the server fix + re-projection remove these).
    const out = md('the [REDACTED:[AI_REDACTED]] suite')
    expect(out.querySelectorAll('[data-testid="redaction-chip"]').length).toBeGreaterThanOrEqual(1)
    expect(out.textContent).toContain('suite')
  })
})

describe('renderInline (§24.182)', () => {
  it('renders inline without a wrapping paragraph, tokens as chips', () => {
    const { container } = render(<span data-testid="ri">{renderInline('**Lean in** to [AI_REDACTED] work')}</span>)
    const host = container.querySelector('[data-testid="ri"]')!
    expect(host.querySelector('p')).toBeNull() // unwrapped
    expect(host.querySelector('strong')?.textContent).toBe('Lean in')
    expect(host.querySelector('[data-testid="redaction-chip"]')?.getAttribute('data-tier')).toBe('ai')
  })
})
