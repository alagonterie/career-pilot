import { fmtTs } from '~/lib/admin-format'
import type { AdminContact } from '~/lib/use-admin'

import { DataTable, type Column } from './DataTable'

/**
 * The `/admin` Contacts tab (the §24.121 inbound-submissions store; migrated onto
 * the shared DataTable §24.174). Long messages line-clamp to ~3 lines (full text on
 * hover) so one verbose submission can't blow out the row height / table width.
 */

const COLUMNS: Column<AdminContact>[] = [
  {
    id: 'when',
    header: 'When',
    cellClassName: 'font-mono text-xs text-muted-foreground',
    sort: (c) => (c.createdAt ? new Date(c.createdAt).getTime() : 0),
    cell: (c) => fmtTs(c.createdAt),
  },
  {
    id: 'from',
    header: 'From',
    cell: (c) => (
      <>
        <span className="block text-foreground">{c.name ?? '—'}</span>
        <span className="block break-all font-mono text-[11px] text-muted-foreground">{c.email ?? '—'}</span>
      </>
    ),
  },
  {
    id: 'company',
    header: 'Company',
    cellClassName: 'text-muted-foreground',
    cell: (c) => (
      <>
        <span className="block max-w-[12rem] truncate" title={c.company ?? undefined}>
          {c.company ?? '—'}
        </span>
        {c.role ? <span className="block text-[11px]">{c.role}</span> : null}
      </>
    ),
  },
  {
    id: 'message',
    header: 'Message',
    cellClassName: 'text-muted-foreground',
    cell: (c) => (
      // The clamp is an inline style, not `line-clamp-3`: the utility's
      // `display:-webkit-box` lost the cascade here (a sibling utility won
      // `display`), silently killing the clamp — inline style can't be
      // out-specificity'd by a class.
      <span
        data-testid="admin-contact-message"
        className="max-w-md break-words"
        title={c.message}
        style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
      >
        {c.message}
      </span>
    ),
  },
  {
    id: 'sent',
    header: 'Sent',
    cellClassName: 'font-mono text-xs',
    cell: (c) =>
      c.delivered ? <span className="text-accent-cool">✓</span> : <span className="text-destructive">✕</span>,
  },
]

export function ContactsPanel({ contacts }: { contacts: AdminContact[] }) {
  return (
    <DataTable
      columns={COLUMNS}
      rows={contacts}
      rowKey={(c) => c.id}
      rowTestId="admin-contact-row"
      rowClassName={() => 'align-top'}
      minWidthClass="min-w-[44rem]"
      empty={<p className="text-sm text-muted-foreground">No inbound contact submissions yet.</p>}
    />
  )
}
