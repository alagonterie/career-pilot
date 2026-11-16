import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { AdminPipelineRow } from '~/lib/use-admin'

import { PipelinePanel } from './PipelinePanel'

// §24.203: the owner Pipeline tab catches up — read-only detail, attention chip,
// days-in-stage, last email and the stage filter. Every new field is optional.

function row(over: Partial<AdminPipelineRow> & { application_id: string }): AdminPipelineRow {
  return {
    company_name: 'Acme',
    obfuscated_label: 'infra-a',
    role_title: 'Staff Engineer',
    status: 'screening',
    stage: 'screening',
    applied_at: '2026-06-10T00:00:00Z',
    last_activity_at: '2026-06-18T00:00:00Z',
    win_confidence: 50,
    ...over,
  }
}

function richRow(over: Partial<AdminPipelineRow> & { application_id: string }): AdminPipelineRow {
  return row({
    stage_entered_at: '2026-06-08T00:00:00Z',
    days_in_stage: 4,
    ghosting_threshold_days: 10,
    ghosting: false,
    win_confidence_rationale: null,
    lead_ids: [],
    posting_url: null,
    sent_resume_id: null,
    timeline: [],
    narrative: null,
    suggestions: [],
    attention: [],
    attention_top: null,
    last_email: null,
    learnings: [],
    kits: [],
    active_kit_url: null,
    tailored_resumes: [],
    ...over,
  })
}

/** The application ids of the body rows, in display order. */
const order = () =>
  screen
    .getAllByRole('row')
    .map((r) => r.getAttribute('data-testid'))
    .filter((id): id is string => !!id && id.startsWith('pipeline-row-'))
    .map((id) => id.replace('pipeline-row-', ''))

const headers = () => screen.getAllByRole('columnheader').map((h) => (h.textContent ?? '').replace(/[↕▲▼]/g, '').trim())

describe('PipelinePanel — §24.203 read-only catch-up', () => {
  it('an older host (no new fields) renders the original five columns and no detail', () => {
    render(<PipelinePanel rows={[row({ application_id: 'a1' })]} stageCounts={{ screening: 1 }} />)
    expect(headers()).toEqual(['Company', 'Role', 'Stage', 'Win', 'Last activity'])
    expect(screen.queryByTestId('pipeline-attention-filter')).not.toBeInTheDocument()
    expect(screen.queryByTestId('pipeline-scribe')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Acme'))
    expect(screen.queryByTestId('pipeline-detail')).not.toBeInTheDocument()
  })

  it('a current host adds Attention, In stage and Last email columns', () => {
    render(<PipelinePanel rows={[richRow({ application_id: 'a1' })]} stageCounts={{ screening: 1 }} />)
    expect(headers()).toEqual([
      'Company',
      'Role',
      'Stage',
      'Attention',
      'In stage',
      'Win',
      'Last email',
      'Last activity',
    ])
  })

  it('expands a row into the rationale, timeline, narrative, suggestions, learnings and links', () => {
    render(
      <PipelinePanel
        baseUrl="https://api.example.com"
        rows={[
          richRow({
            application_id: 'a1',
            company_name: 'Globex',
            win_confidence: 62,
            win_confidence_rationale: 'Strong match on the platform work; one onsite left.',
            posting_url: 'https://boards.example.com/globex/1',
            active_kit_url: 'https://docs.example.com/kit-1',
            sent_resume_id: 'tr-2',
            timeline: [
              {
                id: 'e1',
                ts: '2026-06-01T00:00:00Z',
                kind: 'status_change',
                from_status: 'applied',
                to_status: 'screening',
                source: 'agent',
                summary: 'Recruiter replied',
              },
            ],
            narrative: {
              current_state: 'Waiting on the hiring manager.',
              last_event_at: '2026-06-01T00:00:00Z',
              timeline_excerpt: ['Applied Jun 1', 'Screen booked Jun 4'],
            },
            suggestions: [{ action: 'draft_followup', rationale: 'Quiet for a week', evidence_msg_id: null }],
            attention: [{ priority: 'action_owed', reason: 'Reply owed to recruiter', hint: 'Send availability' }],
            attention_top: 'action_owed',
            learnings: [
              {
                id: 'l1',
                kind: 'rejection',
                created_at: '2026-06-02T00:00:00Z',
                published: true,
                text: 'Lead with impact',
              },
            ],
            kits: [
              {
                round: 'SCREENING',
                interview_type: 'recruiter',
                title: 'Globex screen kit',
                drive_url: 'https://docs.example.com/kit-1',
                status: 'active',
                interview_at: null,
                created_at: '2026-06-03T00:00:00Z',
              },
            ],
            tailored_resumes: [
              { id: 'tr-2', lead_id: 'L1', created_at: '2026-06-02T00:00:00Z', bio_outcome: null, sent: true },
              { id: 'tr-1', lead_id: 'L1', created_at: '2026-06-01T00:00:00Z', bio_outcome: null, sent: false },
            ],
            last_email: {
              at: '2026-06-05T00:00:00Z',
              subject: 'Next steps',
              from_addr: 'recruiter@globex.example',
              classification: 'interview_invite',
              thread_id: 't1',
              thread_url: 'https://mail.google.com/mail/#all/t1',
            },
          }),
        ]}
        stageCounts={{ screening: 1 }}
      />,
    )
    expect(screen.queryByTestId('pipeline-detail')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Globex'))
    const detail = screen.getByTestId('pipeline-detail')
    const part = (id: string) => within(detail).getByTestId(id)
    expect(part('pipeline-detail-rationale')).toHaveTextContent('Strong match on the platform work')
    expect(part('pipeline-detail-timeline')).toHaveTextContent('applied → screening')
    expect(part('pipeline-detail-timeline')).toHaveTextContent('Recruiter replied')
    expect(part('pipeline-detail-narrative')).toHaveTextContent('Waiting on the hiring manager.')
    expect(part('pipeline-detail-narrative')).toHaveTextContent('Screen booked Jun 4')
    expect(part('pipeline-detail-suggestions')).toHaveTextContent('draft_followup')
    expect(part('pipeline-detail-suggestions')).toHaveTextContent('Quiet for a week')
    expect(part('pipeline-detail-attention')).toHaveTextContent('Send availability')
    expect(part('pipeline-detail-learnings')).toHaveTextContent('Lead with impact')
    expect(part('pipeline-detail-kits')).toHaveTextContent('Globex screen kit')
    expect(part('pipeline-link-posting')).toHaveAttribute('href', 'https://boards.example.com/globex/1')
    expect(part('pipeline-link-kit')).toHaveAttribute('href', 'https://docs.example.com/kit-1')
    expect(part('pipeline-link-thread')).toHaveAttribute('href', 'https://mail.google.com/mail/#all/t1')
    const resumes = within(detail).getAllByTestId('pipeline-resume')
    expect(resumes.map((r) => r.getAttribute('data-sent'))).toEqual(['true', 'false'])
    const sent = resumes[0] as HTMLElement
    expect(within(sent).getByRole('link')).toHaveAttribute(
      'href',
      'https://api.example.com/api/admin/tailored/tr-2/resume.pdf',
    )
    expect(within(sent).getByText('sent')).toBeInTheDocument()
    expect(within(resumes[1] as HTMLElement).queryByText('sent')).toBeNull()
    // No write control of any kind: the detail holds only links.
    expect(within(detail).queryAllByRole('button')).toHaveLength(0)
    expect(within(detail).queryAllByRole('combobox')).toHaveLength(0)
    expect(within(detail).queryAllByRole('textbox')).toHaveLength(0)
  })

  it('marks the sent résumé from sent_resume_id when the per-résumé flag is false', () => {
    render(
      <PipelinePanel
        rows={[
          richRow({
            application_id: 'a1',
            sent_resume_id: 'tr-1',
            tailored_resumes: [
              { id: 'tr-1', lead_id: 'L1', created_at: '2026-06-01T00:00:00Z', bio_outcome: null, sent: false },
            ],
          }),
        ]}
        stageCounts={{}}
      />,
    )
    fireEvent.click(screen.getByText('Acme'))
    expect(screen.getByTestId('pipeline-resume')).toHaveAttribute('data-sent', 'true')
  })

  it('a detail with nothing recorded says so', () => {
    render(<PipelinePanel rows={[richRow({ application_id: 'a1' })]} stageCounts={{}} />)
    fireEvent.click(screen.getByText('Acme'))
    expect(screen.getByTestId('pipeline-detail')).toHaveTextContent('Nothing more recorded')
  })

  it('shows the attention chip (priority, reason + hint), sorts by priority and filters', () => {
    render(
      <PipelinePanel
        rows={[
          richRow({ application_id: 'none' }),
          richRow({
            application_id: 'fyi',
            attention: [{ priority: 'fyi', reason: 'Posting closed', hint: null }],
            attention_top: 'fyi',
          }),
          richRow({
            application_id: 'urgent',
            attention: [
              { priority: 'same_day', reason: 'Interview today', hint: 'Open the kit' },
              { priority: 'fyi', reason: 'New email', hint: null },
            ],
            attention_top: 'same_day',
          }),
        ]}
        stageCounts={{ screening: 3 }}
      />,
    )
    const chip = within(screen.getByTestId('pipeline-row-urgent')).getByTestId('pipeline-attention-chip')
    expect(chip).toHaveAttribute('data-priority', 'same_day')
    expect(chip).toHaveTextContent('same day')
    expect(chip).toHaveTextContent('+1')
    expect(chip).toHaveAttribute('title', 'Interview today — Open the kit')
    expect(within(screen.getByTestId('pipeline-row-none')).queryByTestId('pipeline-attention-chip')).toBeNull()

    fireEvent.click(screen.getByTestId('datatable-sort-attention')) // desc: most urgent first
    expect(order()).toEqual(['urgent', 'fyi', 'none'])

    const filter = screen.getByTestId('pipeline-attention-filter')
    expect(within(filter).getByRole('option', { name: 'Needs attention (2)' })).toBeInTheDocument()
    fireEvent.change(filter, { target: { value: 'any' } })
    expect(order()).toEqual(['urgent', 'fyi'])
    fireEvent.change(filter, { target: { value: 'same_day' } })
    expect(order()).toEqual(['urgent'])
    // Any item at that priority counts, not only the top one.
    fireEvent.change(filter, { target: { value: 'fyi' } })
    expect(order()).toEqual(['urgent', 'fyi'])
  })

  it('tints days-in-stage past the host threshold and sorts on it', () => {
    render(
      <PipelinePanel
        rows={[
          richRow({ application_id: 'fresh', days_in_stage: 3, ghosting_threshold_days: 10, ghosting: false }),
          richRow({ application_id: 'stale', days_in_stage: 14, ghosting_threshold_days: 10, ghosting: true }),
          richRow({
            application_id: 'offer',
            stage: 'offer',
            days_in_stage: 30,
            ghosting_threshold_days: null,
            ghosting: false,
          }),
          richRow({ application_id: 'unknown', days_in_stage: null }),
        ]}
        stageCounts={{}}
      />,
    )
    const days = (id: string) => within(screen.getByTestId(`pipeline-row-${id}`)).queryByTestId('pipeline-days')
    expect(days('stale')).toHaveAttribute('data-ghosting', 'true')
    expect(days('stale')).toHaveTextContent('14d')
    expect(days('stale')).toHaveAttribute('title', 'Past the 10-day ghosting threshold for this stage')
    expect(days('stale')).toHaveClass('text-amber-400')
    expect(days('fresh')).toHaveAttribute('data-ghosting', 'false')
    expect(days('fresh')).not.toHaveClass('text-amber-400')
    expect(days('offer')).toHaveAttribute('data-ghosting', 'false') // no threshold → never tinted
    expect(days('unknown')).toBeNull()

    fireEvent.click(screen.getByTestId('datatable-sort-days'))
    expect(order()).toEqual(['offer', 'stale', 'fresh', 'unknown'])
    fireEvent.click(screen.getByTestId('datatable-sort-days'))
    expect(order()).toEqual(['unknown', 'fresh', 'stale', 'offer'])
  })

  it('derives the tint from the numbers when the host sends no ghosting flag', () => {
    const r = richRow({ application_id: 'x', days_in_stage: 10, ghosting_threshold_days: 10 })
    delete r.ghosting
    render(<PipelinePanel rows={[r]} stageCounts={{}} />)
    expect(screen.getByTestId('pipeline-days')).toHaveAttribute('data-ghosting', 'true')
  })

  it('shows the last email (time + subject) and sorts on it', () => {
    const email = (at: string, subject: string) => ({
      at,
      subject,
      from_addr: null,
      classification: 'reply',
      thread_id: 't',
      thread_url: 'https://mail.google.com/mail/#all/t',
    })
    render(
      <PipelinePanel
        rows={[
          richRow({ application_id: 'old', last_email: email('2026-06-01T00:00:00Z', 'Thanks for applying') }),
          richRow({ application_id: 'new', last_email: email('2026-06-09T00:00:00Z', 'Schedule a call') }),
          richRow({ application_id: 'none' }),
        ]}
        stageCounts={{}}
      />,
    )
    expect(within(screen.getByTestId('pipeline-row-new')).getByTestId('pipeline-last-email')).toHaveTextContent(
      'Schedule a call',
    )
    fireEvent.click(screen.getByTestId('datatable-sort-email'))
    expect(order()).toEqual(['new', 'old', 'none'])
  })

  it('stage chips toggle a stage filter (on an older host too)', () => {
    render(
      <PipelinePanel
        rows={[
          row({ application_id: 'a', stage: 'applied' }),
          row({ application_id: 's', stage: 'screening' }),
          row({ application_id: 't', stage: 'tech' }),
        ]}
        stageCounts={{ applied: 1, screening: 1, tech: 1 }}
      />,
    )
    const chip = screen.getByTestId('pipeline-stage-chip-screening')
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(chip)
    expect(chip).toHaveAttribute('aria-pressed', 'true')
    expect(order()).toEqual(['s'])
    fireEvent.click(screen.getByTestId('pipeline-stage-chip-tech')) // switch stage
    expect(order()).toEqual(['t'])
    expect(chip).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(screen.getByTestId('pipeline-stage-chip-tech')) // toggle off → every stage
    expect(order()).toEqual(['a', 's', 't'])
  })

  it('a filter that matches nothing says so instead of the empty-pipeline note', () => {
    render(
      <PipelinePanel rows={[row({ application_id: 'a', stage: 'applied' })]} stageCounts={{ applied: 1, offer: 0 }} />,
    )
    fireEvent.click(screen.getByTestId('pipeline-stage-chip-offer'))
    expect(screen.getByTestId('pipeline-filter-empty')).toBeInTheDocument()
    expect(screen.queryByText('No applications in the pipeline yet.')).not.toBeInTheDocument()
  })

  it('a poll that empties the filtered stage drops the filter instead of stranding the tab', () => {
    const { rerender } = render(
      <PipelinePanel
        rows={[row({ application_id: 'a', stage: 'applied' }), row({ application_id: 's', stage: 'screening' })]}
        stageCounts={{ applied: 1, screening: 1 }}
      />,
    )
    fireEvent.click(screen.getByTestId('pipeline-stage-chip-screening'))
    expect(order()).toEqual(['s'])
    // the scribe moved the only screening application to tech; its chip is gone
    rerender(
      <PipelinePanel
        rows={[row({ application_id: 'a', stage: 'applied' }), row({ application_id: 's', stage: 'tech' })]}
        stageCounts={{ applied: 1, tech: 1 }}
      />,
    )
    expect(screen.queryByTestId('pipeline-stage-chip-screening')).not.toBeInTheDocument()
    expect(screen.queryByTestId('pipeline-filter-empty')).not.toBeInTheDocument()
    expect(order()).toEqual(['a', 's'])
    // and the stage coming back later does not silently re-apply the old filter
    rerender(
      <PipelinePanel
        rows={[row({ application_id: 'a', stage: 'applied' }), row({ application_id: 's', stage: 'screening' })]}
        stageCounts={{ applied: 1, screening: 1 }}
      />,
    )
    expect(screen.getByTestId('pipeline-stage-chip-screening')).toHaveAttribute('aria-pressed', 'false')
    expect(order()).toEqual(['a', 's'])
  })

  it('the no-match note has a Clear filters button that brings every row back', () => {
    render(
      <PipelinePanel rows={[row({ application_id: 'a', stage: 'applied' })]} stageCounts={{ applied: 1, offer: 0 }} />,
    )
    fireEvent.click(screen.getByTestId('pipeline-stage-chip-offer'))
    fireEvent.click(screen.getByTestId('pipeline-filter-clear'))
    expect(screen.queryByTestId('pipeline-filter-empty')).not.toBeInTheDocument()
    expect(order()).toEqual(['a'])
    expect(screen.getByTestId('pipeline-stage-chip-offer')).toHaveAttribute('aria-pressed', 'false')
  })

  it('shows the scribe run time and its company-only attention items above the table', () => {
    render(
      <PipelinePanel
        rows={[richRow({ application_id: 'a1' })]}
        stageCounts={{}}
        scribe={{
          run_at: '2026-06-10T12:00:00Z',
          attention_unlinked: [
            { priority: 'action_owed', reason: 'Recruiter wrote in', hint: 'Reply', company: 'Initech' },
          ],
        }}
      />,
    )
    expect(screen.getByTestId('pipeline-scribe')).toHaveTextContent('Pipeline scribe last ran')
    const item = screen.getByTestId('pipeline-unlinked-attention')
    expect(item).toHaveTextContent('Initech')
    expect(item).toHaveTextContent('Recruiter wrote in')
  })
})
