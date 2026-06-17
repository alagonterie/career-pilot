import { Loader2 } from 'lucide-react'
import * as React from 'react'

import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'

/**
 * The shared résumé download control (§24.81) — one source of truth for the
 * polished download behavior used by BOTH the `/watch` results gift (`SimResult`)
 * and the `/experience` page.
 *
 * Progressive enhancement (D2): the control is a real `<a href={pdfUrl} download>`
 * so it works JS-disabled (the SSR Experience page needs that — PORTAL §10). With
 * JS, the click is hijacked to fetch the PDF ourselves so we can (a) show a
 * "Preparing…" state for the real server-render beat (the PDF is rendered per
 * request, no cache by design), (b) honor the server's `Content-Disposition`
 * filename, and (c) fall back to a plain open on any network/CORS hiccup.
 *
 * No resize (D3): the idle and "Preparing…" labels stack in one CSS-grid cell, so
 * the control's width is the wider idle label's and never jumps when state flips.
 */
interface ResumeDownloadProps {
  /** The PDF endpoint (already composed by the caller). */
  pdfUrl: string
  /** Download filename when the server sends no `Content-Disposition`. */
  fallbackFilename?: string
  /** Show the Preview affordance (desktop modal + mobile new-tab open). */
  preview?: boolean
  /** Header label for the preview modal. */
  previewTitle?: string
  size?: 'sm' | 'lg' | 'default'
  variant?: 'default' | 'outline'
  /** testid for the download control (kept stable for existing specs). */
  downloadTestId?: string
  className?: string
}

export function ResumeDownload({
  pdfUrl,
  fallbackFilename = 'resume.pdf',
  preview = false,
  previewTitle = 'Résumé preview',
  size = 'lg',
  variant = 'default',
  downloadTestId,
  className,
}: ResumeDownloadProps) {
  const dialogRef = React.useRef<HTMLDialogElement>(null)
  const [downloading, setDownloading] = React.useState(false)

  async function handleDownload(e: React.MouseEvent<HTMLAnchorElement>) {
    // With JS we own the flow (Preparing state + filename) — suppress the native
    // navigation. Without JS this handler never runs and the anchor downloads.
    e.preventDefault()
    if (downloading) return
    setDownloading(true)
    try {
      const res = await fetch(pdfUrl)
      if (!res.ok) throw new Error(`status ${res.status}`)
      const blob = await res.blob()
      const cd = res.headers.get('content-disposition') ?? ''
      const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)
      const filename = m ? decodeURIComponent(m[1]) : fallbackFilename
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      // Network/headers issue (e.g. cross-origin local dev) — let the browser handle it.
      window.open(pdfUrl, '_blank', 'noopener')
    } finally {
      setDownloading(false)
    }
  }

  return (
    <div className={cn('flex flex-col gap-3 sm:flex-row', className)}>
      <Button
        asChild
        size={size}
        variant={variant}
        // D4: Download is primary — it fills the row when paired with Preview
        // (sm:flex-1); alone it stays content-width (sm:w-auto). Full-width on mobile.
        className={cn('w-full', preview ? 'sm:flex-1' : 'sm:w-auto')}
      >
        <a
          href={pdfUrl}
          download={fallbackFilename}
          onClick={handleDownload}
          aria-busy={downloading}
          aria-disabled={downloading}
          data-testid={downloadTestId}
          className={cn(downloading && 'pointer-events-none')}
        >
          {/* D3: both labels in one grid cell → the control's width is the wider
              idle label's and never resizes when the state flips. */}
          <span className="grid">
            <span
              className={cn(
                'col-start-1 row-start-1 inline-flex items-center justify-center',
                downloading && 'invisible',
              )}
            >
              Download résumé (PDF) ↓
            </span>
            <span
              aria-hidden={!downloading}
              className={cn(
                'col-start-1 row-start-1 inline-flex items-center justify-center gap-2',
                !downloading && 'invisible',
              )}
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Preparing…
            </span>
          </span>
        </a>
      </Button>

      {preview ? (
        <>
          {/* Desktop: inline modal preview (browsers render the PDF in the iframe). */}
          <Button
            variant="outline"
            size={size}
            className="hidden w-full sm:inline-flex sm:w-auto"
            data-testid="sim-resume-preview-open"
            onClick={() => dialogRef.current?.showModal()}
          >
            Preview
          </Button>
          {/* Mobile: mobile browsers won't render a PDF inside an iframe (dead-end
              "open" affordance), so open it directly in a new tab — one tap. */}
          <Button asChild variant="outline" size={size} className="w-full sm:hidden">
            <a href={pdfUrl} target="_blank" rel="noopener noreferrer">
              Preview
            </a>
          </Button>
          <dialog
            ref={dialogRef}
            data-testid="sim-resume-preview"
            className="m-auto w-[92vw] max-w-3xl rounded-xl border border-border bg-background p-0 shadow-xl backdrop:bg-black/60"
          >
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">{previewTitle}</span>
              <button
                type="button"
                aria-label="Close preview"
                onClick={() => dialogRef.current?.close()}
                className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
              >
                ✕
              </button>
            </div>
            <iframe src={pdfUrl} title={previewTitle} className="h-[78vh] w-full" />
          </dialog>
        </>
      ) : null}
    </div>
  )
}
