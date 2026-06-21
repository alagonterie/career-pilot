import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { parseRedaction, Redaction, RedactedText, RedactionLegend, splitRedactionParts } from './Redaction'
import { renderInline } from '~/lib/markdownish'

describe('parseRedaction — provenance from token shape (§24.134d)', () => {
  it('maps the AI belt token to the violet ai tier with a ✦', () => {
    const r = parseRedaction('[AI_REDACTED]')
    expect(r.tier).toBe('ai')
    expect(r.glyph).toBe('✦')
    expect(r.title).toMatch(/agent/i)
  })
  it('maps the Pass-2 company token to the company tier and shows the pseudonym', () => {
    const r = parseRedaction('[REDACTED:infra-d]')
    expect(r.tier).toBe('company')
    expect(r.display).toBe('infra-d')
  })
  it('maps typed Pass-1 PII tokens to the pii tier', () => {
    expect(parseRedaction('[EMAIL_REDACTED]').tier).toBe('pii')
    expect(parseRedaction('[AMOUNT_REDACTED]').glyph).toBe('$')
  })
  it('maps the bare token to the generic deterministic tier', () => {
    expect(parseRedaction('[REDACTED]').tier).toBe('generic')
  })
})

describe('splitRedactionParts', () => {
  it('interleaves text and tokens in order, dropping empties', () => {
    expect(splitRedactionParts('led [AI_REDACTED] at [REDACTED:infra-d].')).toEqual([
      { token: false, value: 'led ' },
      { token: true, value: '[AI_REDACTED]' },
      { token: false, value: ' at ' },
      { token: true, value: '[REDACTED:infra-d]' },
      { token: false, value: '.' },
    ])
  })
  it('returns a single text part when there are no tokens', () => {
    expect(splitRedactionParts('plain prose')).toEqual([{ token: false, value: 'plain prose' }])
  })
})

describe('Redaction chip', () => {
  it('renders the ai tier in violet with the ✦ + tooltip', () => {
    render(<Redaction token="[AI_REDACTED]" />)
    const chip = screen.getByTestId('redaction-chip')
    expect(chip.dataset.tier).toBe('ai')
    expect(chip.className).toContain('text-ai')
    expect(chip).toHaveAttribute('title', expect.stringMatching(/agent/i))
    expect(chip.textContent).toContain('✦')
  })
  it('renders deterministic tiers muted (no violet)', () => {
    render(<Redaction token="[EMAIL_REDACTED]" />)
    const chip = screen.getByTestId('redaction-chip')
    expect(chip.dataset.tier).toBe('pii')
    expect(chip.className).toContain('text-muted-foreground')
    expect(chip.className).not.toContain('text-ai')
  })
})

describe('RedactedText + renderInline integration', () => {
  it('RedactedText renders chips for tokens and keeps surrounding text', () => {
    render(
      <div data-testid="rt">
        <RedactedText text="reach me at [EMAIL_REDACTED] today" />
      </div>,
    )
    const host = screen.getByTestId('rt')
    expect(host.querySelectorAll('[data-testid="redaction-chip"]')).toHaveLength(1)
    expect(host.textContent).toContain('reach me at')
    expect(host.textContent).toContain('today')
  })

  it('renderInline turns inline tokens into chips alongside bold text', () => {
    render(<div data-testid="ri">{renderInline('**Lean into** the [AI_REDACTED] proxy work')}</div>)
    const host = screen.getByTestId('ri')
    expect(host.querySelector('strong')?.textContent).toBe('Lean into')
    const chip = host.querySelector('[data-testid="redaction-chip"]')
    expect(chip?.getAttribute('data-tier')).toBe('ai')
    // the literal token never reaches the DOM as text
    expect(host.textContent).not.toContain('[AI_REDACTED]')
  })

  it('chips a redaction token that sits INSIDE bold (§24.146 A0 — was leaking as raw text)', () => {
    // The exact kit shape: a bold heading whose subject is a sealed company.
    render(<div data-testid="bold">{renderInline('**[REDACTED:infra-d] alignment & vision clarity**')}</div>)
    const host = screen.getByTestId('bold')
    const strong = host.querySelector('strong')
    // The chip renders inside the <strong>, not as a sibling.
    const chip = strong?.querySelector('[data-testid="redaction-chip"]')
    expect(chip?.getAttribute('data-tier')).toBe('company')
    expect(chip?.textContent).toContain('infra-d')
    // The literal token never reaches the DOM; the rest of the bold text stays.
    expect(host.textContent).not.toContain('[REDACTED:infra-d]')
    expect(strong?.textContent).toContain('alignment & vision clarity')
  })
})

describe('RedactionLegend — a real titled component (§24.146 A0)', () => {
  it('renders a bordered, titled key with both honest tiers as chips', () => {
    render(<RedactionLegend />)
    const legend = screen.getByTestId('redaction-legend')
    // A deliberate box (border), not a loose run of text.
    expect(legend.className).toContain('border')
    expect(legend.textContent).toMatch(/redaction key/i)
    // Both tiers present as chips, with their plain-English glosses.
    const chips = legend.querySelectorAll('[data-testid="redaction-chip"]')
    expect(chips).toHaveLength(2)
    expect(legend.textContent).toMatch(/the agent.s judgment/i)
    expect(legend.textContent).toMatch(/a deterministic scrub/i)
  })
})
