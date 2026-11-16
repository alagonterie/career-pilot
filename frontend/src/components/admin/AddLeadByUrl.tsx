import { useState, type FormEvent } from 'react'

import { postAddLeadByUrl, postWatchlistAddByUrl, type AddLeadByUrlResult } from '~/lib/use-admin'

/**
 * §24.201 D7 — "Add lead by URL" in the Leads header. One input: a Greenhouse,
 * Lever or Ashby posting link. The host parses it and reads the posting through
 * that ATS's own API (the pasted page is never fetched), bypassing the title
 * filter and clearing a matching "not interested" — the owner chose this
 * posting. The posting's board is only PROPOSED: when it is not on the
 * watchlist, a "Watch <company>'s board" button adds it.
 */

/** The success sentence for an added (or already present) lead. */
export function addLeadNote(r: AddLeadByUrlResult): string {
  if (r.outcome === 'already_present') return `Already in the pool — ${r.lead_status}.`
  return r.tombstone_cleared ? 'Lead added. Your earlier “not interested” on this posting was cleared.' : 'Lead added.'
}

/** The board half of the success note, or null when the board is not watched. */
export function boardNote(b: AddLeadByUrlResult['board_proposed']): string | null {
  if (!b.already_listed) return null
  return `${b.company}'s board is already on the watchlist${b.state ? ` (${b.state})` : ''}.`
}

/** Offer "watch this board" when no row exists — or when the row is `absent`,
 *  which the same add revives. */
export function offerWatch(b: AddLeadByUrlResult['board_proposed']): boolean {
  return !b.already_listed || b.state === 'absent'
}

export function AddLeadByUrl({ baseUrl, onSaved }: { baseUrl: string; onSaved: () => void }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState<'add' | 'watch' | null>(null)
  const [result, setResult] = useState<{ url: string; r: AddLeadByUrlResult } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [watchNote, setWatchNote] = useState<string | null>(null)
  const [watchError, setWatchError] = useState<string | null>(null)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const u = url.trim()
    if (u === '' || busy) return
    setBusy('add')
    setError(null)
    setResult(null)
    setWatchNote(null)
    setWatchError(null)
    const out = await postAddLeadByUrl(baseUrl, u)
    setBusy(null)
    if (out.kind === 'ok') {
      setResult({ url: u, r: out.result })
      setUrl('')
      onSaved()
    } else setError(out.message)
  }

  const watch = async (): Promise<void> => {
    if (!result || busy) return
    const b = result.r.board_proposed
    setBusy('watch')
    setWatchError(null)
    const out = await postWatchlistAddByUrl(baseUrl, { url: result.url, company: b.company })
    setBusy(null)
    if (out.kind === 'ok') setWatchNote(`Now watching ${out.board.company}'s board.`)
    else setWatchError(out.message)
  }

  const board = result?.r.board_proposed
  const listedNote = board ? boardNote(board) : null
  return (
    <form
      data-testid="leads-add-url-form"
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-1 border-t border-border/60 pt-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor="leads-add-url-input"
          className="font-mono text-[10px] uppercase tracking-widest text-foreground"
        >
          Add lead by link
        </label>
        <input
          id="leads-add-url-input"
          type="url"
          data-testid="leads-add-url-input"
          placeholder="https://job-boards.greenhouse.io/acme/jobs/123"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className="min-w-0 flex-1 basis-64 rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
        <button
          type="submit"
          data-testid="leads-add-url-submit"
          disabled={busy != null || url.trim() === ''}
          className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          title="Greenhouse, Lever or Ashby job links only — other career sites are not fetched"
        >
          {busy === 'add' ? 'Adding…' : 'Add'}
        </button>
      </div>
      {error ? (
        <p data-testid="leads-add-url-error" role="alert" className="font-mono text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
      {result && board ? (
        <div data-testid="leads-add-url-result" className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
          <span data-testid="leads-add-url-note" className="text-primary">
            {addLeadNote(result.r)}
          </span>
          {listedNote ? (
            <span data-testid="leads-add-url-board" className="text-muted-foreground">
              {listedNote}
            </span>
          ) : null}
          {offerWatch(board) && !watchNote ? (
            <button
              type="button"
              data-testid="leads-add-url-watch"
              disabled={busy != null}
              onClick={() => void watch()}
              className="rounded-md border border-border px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              {busy === 'watch' ? 'Adding board…' : `Watch ${board.company}'s board`}
            </button>
          ) : null}
          {watchNote ? (
            <span data-testid="leads-add-url-watch-note" className="text-primary">
              {watchNote}
            </span>
          ) : null}
          {watchError ? (
            <span data-testid="leads-add-url-watch-error" role="alert" className="text-destructive">
              {watchError}
            </span>
          ) : null}
        </div>
      ) : null}
    </form>
  )
}
