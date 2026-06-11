import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { KitPayload, KitSection } from '~/lib/use-kit'
import { kitDate, roundLabel } from '~/lib/use-kit'

import { KitDossier } from './KitDossier'

function payload(sections: KitSection[]): KitPayload {
  return {
    application_ref: 'ai-infra-a',
    public_state: 'obfuscated',
    role_title: 'Senior AI Specialist',
    round: 'TECH_SCREEN',
    interview_type: 'technical_screen',
    interview_at: '2026-06-18T16:00:00Z',
    status: 'active',
    sections,
  }
}

const SECTIONS: KitSection[] = [
  {
    id: 'your-role',
    title: 'Your role',
    part: 1,
    kind: 'content',
    body: 'Conduct a realistic technical screen.\n\n- ask **one question** at a time',
    item_count: 1,
  },
  {
    id: 'grounding',
    title: 'Grounding + caveats',
    part: 1,
    kind: 'withheld',
    item_count: 4,
    withheld_reason: "4 grounding facts · sealed while this process is live — they'd identify the company",
  },
  {
    id: 'lean-into',
    title: 'Lean into',
    part: 2,
    kind: 'content',
    body: '- the 38% p99 latency win',
    item_count: 1,
  },
]

describe('KitDossier (§24.65 / PORTAL §5.9)', () => {
  it('renders content sections through the markdownish renderer', () => {
    render(<KitDossier kit={payload(SECTIONS)} />)
    const role = screen.getByTestId('kit-section-your-role')
    expect(within(role).getByText(/realistic technical screen/)).toBeInTheDocument()
    expect(within(role).getByText('one question')).toBeInTheDocument() // **bold** rendered
  })

  it('renders sealed sections as redaction bars + the honest caption — never text', () => {
    render(<KitDossier kit={payload(SECTIONS)} />)
    const sealedBlock = screen.getByTestId('kit-sealed-grounding')
    const bars = within(sealedBlock).getByTestId('kit-redaction-bars')
    expect(bars.children).toHaveLength(4) // one bar per withheld item
    expect(within(sealedBlock).getByText(/sealed while this process is live/)).toBeInTheDocument()
    // The sealed section ships no body by construction; nothing content-like renders.
    expect(sealedBlock.textContent).not.toMatch(/Series B|\$40M/)
  })

  it('keeps sealed sections IN the TOC with the ⊘ glyph (provable structure)', () => {
    render(<KitDossier kit={payload(SECTIONS)} />)
    // Two TOCs render (mobile chips + desktop rail) → entries appear twice.
    const sealedEntries = screen
      .getAllByTestId('kit-toc-entry')
      .filter((el) => el.getAttribute('data-sealed') === 'true')
    expect(sealedEntries).toHaveLength(2)
    expect(sealedEntries[0]).toHaveTextContent('⊘ Grounding + caveats')
  })

  it('frames Part 1 and Part 2 with their honest captions', () => {
    render(<KitDossier kit={payload(SECTIONS)} />)
    expect(screen.getByText('Part 1 — Interviewer operating manual')).toBeInTheDocument()
    expect(screen.getByText(/read by the interviewer Claude during the voice mock/)).toBeInTheDocument()
    expect(screen.getByText('Part 2 — Candidate quick-reference')).toBeInTheDocument()
    expect(screen.getByText(/phone cheat-sheet/)).toBeInTheDocument()
  })

  it('caps the redaction bars while keeping the true count in the caption', () => {
    render(
      <KitDossier
        kit={payload([
          {
            id: 'question-themes',
            title: 'Question themes',
            part: 1,
            kind: 'withheld',
            item_count: 23,
            withheld_reason: '23 question themes · sealed while this process is live — they quote the job description',
          },
        ])}
      />,
    )
    expect(screen.getByTestId('kit-redaction-bars').children.length).toBeLessThanOrEqual(8)
    expect(screen.getByText(/^23 question themes/)).toBeInTheDocument()
  })
})

describe('kit display helpers', () => {
  it('roundLabel maps the canonical rounds and degrades gracefully', () => {
    expect(roundLabel('TECH_SCREEN')).toBe('Technical screen')
    expect(roundLabel('SCREENING')).toBe('Recruiter screen')
    expect(roundLabel('SOMETHING_NEW')).toBe('something new')
  })

  it('kitDate renders a short UTC date and tolerates null/garbage', () => {
    expect(kitDate('2026-06-18T16:00:00Z')).toBe('Jun 18')
    expect(kitDate(null)).toBe('')
    expect(kitDate('not-a-date')).toBe('')
  })
})
