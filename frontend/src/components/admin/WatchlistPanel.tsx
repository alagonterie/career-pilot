import { useMemo, useState, type FormEvent } from 'react'

import { fmtTs } from '~/lib/admin-format'
import type { DevKnob } from '~/lib/use-dev-inspector'
import {
  adminRefusalMessage,
  postAdminWatchlist,
  postWatchlistAddByUrl,
  type AdminWatchlistBoard,
  type AdminWatchlistView,
  type WatchlistState,
  type WatchlistTier,
} from '~/lib/use-admin'
import { cn } from '~/lib/utils'

import { DataTable, type Column } from './DataTable'
import { SweepFilterEditor } from './SweepFilterEditor'

/**
 * §24.202 D6 — the Watchlist tab: the employer boards the direct-board sweep
 * reads. Each board shows where it came from, whether the sweep reads it, when
 * it last answered, and what it has produced. Pause / resume / remove act on
 * one board; "add company by URL" adds a Greenhouse, Lever or Ashby board (the
 * host parses the link and asks the ATS's own API whether the board exists —
 * the pasted page itself is never fetched). The sweep-filter editor sits below.
 */

const STATE_FILTERS = ['all', 'active', 'paused', 'absent'] as const
type StateFilter = (typeof STATE_FILTERS)[number]

/** "3h ago" / "2d ago" / "just now" / "never". */
export function agoLabel(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const h = Math.max(0, Math.floor((now - t) / 3_600_000))
  if (h < 1) return 'just now'
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** The success sentence for "add company by URL". */
export function addBoardNote(board: AdminWatchlistBoard, inserted: boolean, reactivated: boolean): string {
  if (reactivated) return `${board.company} was marked absent and is back on the watchlist.`
  if (inserted) return `Now watching ${board.company} (${board.ats}). The next sweep reads its postings.`
  return `${board.company} is on the watchlist.`
}

function StateChip({ state }: { state: WatchlistState }) {
  return (
    <span
      data-testid="watchlist-state"
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[10px] uppercase',
        state === 'active' && 'bg-primary/15 text-primary',
        state === 'paused' && 'bg-muted text-muted-foreground',
        state === 'absent' && 'bg-amber-400/15 text-amber-400',
      )}
    >
      {state}
    </span>
  )
}

const DATA_COLUMNS: Column<AdminWatchlistBoard>[] = [
  {
    id: 'company',
    header: 'Company',
    sort: (b) => b.company.toLowerCase(),
    cell: (b) => (
      <span className="flex min-w-0 flex-col">
        <a
          href={b.board_url}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="watchlist-board-link"
          className="truncate text-foreground hover:underline"
          title={b.board_url}
        >
          {b.company}
        </a>
        <span className="font-mono text-[10px] text-muted-foreground">
          {b.ats} · {b.token} · tier {b.tier}
        </span>
      </span>
    ),
  },
  {
    id: 'origin',
    header: 'Origin',
    headerClassName: 'w-20',
    cellClassName: 'font-mono text-[11px] text-muted-foreground',
    sort: (b) => b.origin,
    cell: (b) => b.origin,
  },
  {
    id: 'state',
    header: 'State',
    headerClassName: 'w-20',
    sort: (b) => b.state,
    cell: (b) => <StateChip state={b.state} />,
  },
  {
    id: 'last_ok',
    header: 'Last fetch',
    headerClassName: 'w-24',
    cellClassName: 'font-mono text-[11px] text-muted-foreground',
    sort: (b) => (b.last_ok_at ? new Date(b.last_ok_at).getTime() : 0),
    cell: (b) => <span title={b.last_ok_at ? fmtTs(b.last_ok_at) : undefined}>{agoLabel(b.last_ok_at)}</span>,
  },
  {
    id: 'last_error',
    header: 'Last error',
    cellClassName: 'text-[11px]',
    cell: (b) =>
      b.last_error ? (
        <span data-testid="watchlist-last-error" className="block truncate text-amber-400" title={b.last_error}>
          {b.last_error}
          {b.consecutive_failures > 1 ? ` ×${b.consecutive_failures}` : ''}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  },
  {
    id: 'leads',
    header: 'Leads',
    align: 'right',
    headerClassName: 'w-20',
    cellClassName: 'font-mono text-xs tabular-nums text-foreground',
    sort: (b) => b.leads_found,
    cell: (b) => (
      <span
        data-testid="watchlist-leads"
        title={`${b.leads_found} found in total · ${b.open_leads} open now${b.last_hit_at ? ` · last new ${agoLabel(b.last_hit_at)}` : ''}`}
      >
        {b.leads_found}
        <span className="text-muted-foreground"> / {b.open_leads} open</span>
      </span>
    ),
  },
]

export function WatchlistPanel({
  data,
  knobs,
  baseUrl,
  onSaved,
  onKnobsSaved,
}: {
  data: AdminWatchlistView | null
  knobs: DevKnob[] | null
  baseUrl: string
  onSaved: () => void
  onKnobsSaved: () => void
}) {
  const [stateFilter, setStateFilter] = useState<StateFilter>('all')
  const boards = useMemo(() => data?.boards ?? [], [data])
  const rows = useMemo(
    () => (stateFilter === 'all' ? boards : boards.filter((b) => b.state === stateFilter)),
    [boards, stateFilter],
  )

  const columns = useMemo<Column<AdminWatchlistBoard>[]>(
    () => [
      ...DATA_COLUMNS,
      {
        id: 'actions',
        header: 'Actions',
        headerClassName: 'w-[11rem]',
        cell: (b) => <BoardActions board={b} baseUrl={baseUrl} onSaved={onSaved} />,
      },
    ],
    [baseUrl, onSaved],
  )

  if (!data) return <p className="text-sm text-muted-foreground">No watchlist data yet.</p>
  const { counts, caps } = data

  return (
    <section data-testid="watchlist-panel" className="flex flex-col gap-4">
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">Employer boards</h2>
        {counts ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="watchlist-counts">
            <Stat label="Active" value={counts.active} />
            <Stat label="Paused" value={counts.paused} />
            <Stat label="Absent" value={counts.absent} />
            <Stat label="Board cap" value={caps ? `${caps.counted} / ${caps.max_boards}` : String(counts.total)} />
          </div>
        ) : null}
        {counts && Object.keys(counts.by_origin).length > 0 ? (
          <p data-testid="watchlist-by-origin" className="font-mono text-[11px] text-muted-foreground">
            by origin:{' '}
            {Object.entries(counts.by_origin)
              .map(([o, n]) => `${o} ${n}`)
              .join(' · ')}
          </p>
        ) : null}
        <p className="text-[11px] leading-snug text-muted-foreground">
          The sweep reads every <strong>active</strong> board on its schedule. A <strong>paused</strong> board is
          skipped and is not re-added automatically. An <strong>absent</strong> board is one its ATS says no longer
          exists. The cap counts every board that is not absent
          {caps ? `; search results add at most ${caps.max_auto_adds_per_run} boards per run` : ''}.
        </p>
        <AddBoardForm baseUrl={baseUrl} onSaved={onSaved} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          State
          <select
            value={stateFilter}
            data-testid="watchlist-filter-state"
            onChange={(e) => setStateFilter(e.target.value as StateFilter)}
            className="rounded-md border border-border bg-background px-2 py-1 text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {STATE_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <span className="font-mono text-[11px] text-muted-foreground" data-testid="watchlist-shown">
          {rows.length} shown
        </span>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(b) => String(b.id)}
        rowTestId="watchlist-row"
        tableFixed
        minWidthClass="min-w-[52rem]"
        pageSize={25}
        resetKey={stateFilter}
        empty={
          <p className="rounded-lg border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">
            {boards.length === 0 ? 'No boards on the watchlist yet.' : 'No boards in that state.'}
          </p>
        }
      />

      {knobs ? <SweepFilterEditor knobs={knobs} baseUrl={baseUrl} onSaved={onKnobsSaved} /> : null}
    </section>
  )
}

function AddBoardForm({ baseUrl, onSaved }: { baseUrl: string; onSaved: () => void }) {
  const [url, setUrl] = useState('')
  const [company, setCompany] = useState('')
  const [tier, setTier] = useState<'' | WatchlistTier>('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    if (url.trim() === '' || busy) return
    setBusy(true)
    setNote(null)
    setError(null)
    const out = await postWatchlistAddByUrl(baseUrl, {
      url: url.trim(),
      ...(company.trim() ? { company: company.trim() } : {}),
      ...(tier ? { tier } : {}),
    })
    setBusy(false)
    if (out.kind === 'ok') {
      setNote(addBoardNote(out.board, out.inserted, out.reactivated))
      setUrl('')
      setCompany('')
      setTier('')
      onSaved()
    } else setError(out.message)
  }

  const input =
    'rounded-md border border-border bg-background px-2 py-1 font-mono text-[11px] text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring'
  return (
    <form
      data-testid="watchlist-add-form"
      onSubmit={(e) => void submit(e)}
      className="flex flex-col gap-1.5 border-t border-border/60 pt-3"
    >
      <span className="font-mono text-[10px] uppercase tracking-widest text-foreground">Add company by URL</span>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="url"
          data-testid="watchlist-add-url"
          aria-label="Board or job link"
          placeholder="https://jobs.lever.co/acme"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          className={cn(input, 'min-w-0 flex-1 basis-64')}
        />
        <input
          type="text"
          data-testid="watchlist-add-company"
          aria-label="Company name (optional)"
          placeholder="Company (optional)"
          value={company}
          onChange={(e) => setCompany(e.target.value)}
          className={cn(input, 'w-40')}
        />
        <select
          data-testid="watchlist-add-tier"
          aria-label="Tier"
          value={tier}
          onChange={(e) => setTier(e.target.value as '' | WatchlistTier)}
          className={input}
        >
          <option value="">tier B (default)</option>
          <option value="A">tier A</option>
          <option value="B">tier B</option>
          <option value="C">tier C</option>
        </select>
        <button
          type="submit"
          data-testid="watchlist-add-submit"
          disabled={busy || url.trim() === ''}
          className="rounded-md border border-border px-2.5 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Add board'}
        </button>
      </div>
      <span className="text-[11px] leading-snug text-muted-foreground">
        A Greenhouse, Lever or Ashby board or job link. The link is read, not opened: the board is checked through the
        ATS&apos;s own listing API before it is added.
      </span>
      {note ? (
        <p data-testid="watchlist-add-note" className="font-mono text-[11px] text-primary">
          {note}
        </p>
      ) : null}
      {error ? (
        <p data-testid="watchlist-add-error" role="alert" className="font-mono text-[11px] text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  )
}

function BoardActions({
  board,
  baseUrl,
  onSaved,
}: {
  board: AdminWatchlistBoard
  baseUrl: string
  onSaved: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (
    body: { action: 'set_state'; id: number; state: 'active' | 'paused' } | { action: 'remove'; id: number },
  ) => {
    setBusy(true)
    setError(null)
    const res = await postAdminWatchlist(baseUrl, body)
    setBusy(false)
    setConfirming(false)
    if (res.ok) onSaved()
    else setError(adminRefusalMessage(res))
  }

  const btn =
    'rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40'
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {board.state === 'active' ? (
          <button
            type="button"
            data-testid="watchlist-pause"
            disabled={busy}
            onClick={() => void run({ action: 'set_state', id: board.id, state: 'paused' })}
            className={btn}
          >
            Pause
          </button>
        ) : (
          <button
            type="button"
            data-testid="watchlist-resume"
            disabled={busy}
            onClick={() => void run({ action: 'set_state', id: board.id, state: 'active' })}
            className={btn}
          >
            Resume
          </button>
        )}
        {confirming ? (
          <span className="flex items-center gap-1" data-testid="watchlist-remove-confirm">
            <button
              type="button"
              data-testid="watchlist-remove-yes"
              disabled={busy}
              onClick={() => void run({ action: 'remove', id: board.id })}
              className="rounded bg-destructive px-1.5 py-0.5 font-mono text-[10px] font-semibold text-white hover:bg-destructive/90 disabled:opacity-40"
            >
              Remove
            </button>
            <button
              type="button"
              data-testid="watchlist-remove-cancel"
              disabled={busy}
              onClick={() => setConfirming(false)}
              className={btn}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            data-testid="watchlist-remove"
            disabled={busy}
            onClick={() => {
              setError(null)
              setConfirming(true)
            }}
            className={cn(btn, 'hover:border-destructive/60 hover:text-destructive')}
          >
            Remove
          </button>
        )}
      </div>
      {error ? (
        <span data-testid="watchlist-row-error" role="alert" className="text-[11px] leading-snug text-destructive">
          {error}
        </span>
      ) : null}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-border bg-background px-3 py-2">
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className="font-mono text-lg font-semibold tabular-nums text-foreground">{value}</span>
    </div>
  )
}
