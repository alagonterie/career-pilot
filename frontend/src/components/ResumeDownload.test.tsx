import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ResumeDownload } from './ResumeDownload'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ResumeDownload (§24.81)', () => {
  it('renders a real <a href download> (works JS-disabled) with the download label', () => {
    render(<ResumeDownload pdfUrl="/api/resume.pdf" downloadTestId="dl" />)
    const a = screen.getByTestId('dl')
    expect(a.tagName).toBe('A')
    expect(a).toHaveAttribute('href', '/api/resume.pdf')
    expect(a).toHaveAttribute('download', 'resume.pdf')
    expect(a).toHaveTextContent(/Download résumé \(PDF\)/)
  })

  it('stacks the idle + Preparing labels so the control never resizes (D3)', () => {
    render(<ResumeDownload pdfUrl="/api/resume.pdf" downloadTestId="dl" />)
    // BOTH labels are in the DOM at rest (the grid-stack) → constant width; the
    // loading one is present-but-invisible until a download is in flight.
    expect(screen.getByText(/Download résumé/)).toBeInTheDocument()
    const preparing = screen.getByText(/Preparing/)
    expect(preparing).toBeInTheDocument()
    expect(preparing).toHaveClass('invisible')
  })

  it('shows the Preview affordance + dialog only when `preview` is set', () => {
    const { rerender } = render(<ResumeDownload pdfUrl="/api/r.pdf" />)
    expect(screen.queryByTestId('sim-resume-preview')).not.toBeInTheDocument()
    expect(screen.queryByText('Preview')).not.toBeInTheDocument()

    rerender(<ResumeDownload pdfUrl="/api/r.pdf" preview previewTitle="Tailored résumé preview" />)
    expect(screen.getByTestId('sim-resume-preview')).toBeInTheDocument()
    // Two Preview controls: desktop modal-opener + mobile new-tab anchor.
    expect(screen.getAllByText('Preview').length).toBe(2)
    expect(screen.getByText('Tailored résumé preview')).toBeInTheDocument()
  })

  it('hijacks the click with JS: fetches the PDF + toggles the Preparing state (D2)', async () => {
    const blob = new Blob(['%PDF'], { type: 'application/pdf' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => blob,
      headers: { get: () => 'attachment; filename="custom.pdf"' },
    })
    vi.stubGlobal('fetch', fetchMock)
    ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:x')
    ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn()
    render(<ResumeDownload pdfUrl="/api/resume.pdf" downloadTestId="dl" />)
    // Neutralize the temp anchor's navigation (post-render so React's own nodes
    // are untouched); jsdom can't navigate a blob: URL.
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    fireEvent.click(screen.getByTestId('dl'))
    // The click is hijacked (preventDefault → fetch), and the busy state shows.
    expect(screen.getByTestId('dl')).toHaveAttribute('aria-busy', 'true')
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/resume.pdf'))
    await waitFor(() => expect(screen.getByTestId('dl')).toHaveAttribute('aria-busy', 'false'))
    expect((URL as unknown as { createObjectURL: ReturnType<typeof vi.fn> }).createObjectURL).toHaveBeenCalled()
  })

  it('falls back to window.open when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')))
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    render(<ResumeDownload pdfUrl="/api/resume.pdf" downloadTestId="dl" />)
    fireEvent.click(screen.getByTestId('dl'))
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('/api/resume.pdf', '_blank', 'noopener'))
  })
})
