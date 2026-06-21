import * as React from 'react'

import { Redaction, splitRedactionParts } from '~/components/Redaction'

/**
 * The hand-rolled markdown-ish renderer (§24.31 Δ, extracted §24.65) — shared
 * by the simulator output pane and the /kit dossier. Handles the shapes the
 * agent emits AND the Google Docs→markdown export dialect the backfilled kits
 * arrive in (§24.65 Δ): `#`–`####` headings, `-`/`*`/`+` bullets, `1.`/`1)`
 * ordered lists, pipe tables, `---` rules, `**bold**` / `` `code` `` inline,
 * backslash-escaped punctuation (`\+`, `R\&D`), blank-line paragraphs. Still
 * no dependency.
 */

/** Docs→markdown escapes literal punctuation (`\+`, `\*real\*`, `R\&D`) —
 * show the character, not the backslash. Applied to plain text segments only
 * (code spans stay raw). */
function unescapeMd(text: string): string {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!&>~|"'])/g, '$1')
}

/**
 * Render a plain (non-code) string with its redaction tokens as provenance chips
 * (§24.134d) and the rest as unescaped text. Shared by BOTH the `**bold**` branch
 * and the top-level plain branch so a `[…REDACTED…]` token chips identically
 * whether or not it sits inside bold — a bold token (`**[REDACTED:infra-d] …**`)
 * was previously unescaped straight to raw text, leaking the literal token onto
 * the kit (§24.146 A0).
 */
function renderWithRedactions(text: string, keyPrefix: string): React.ReactNode {
  return splitRedactionParts(text).map((part, j) =>
    part.token ? (
      <Redaction key={`${keyPrefix}-${j}`} token={part.value} />
    ) : (
      <React.Fragment key={`${keyPrefix}-${j}`}>{unescapeMd(part.value)}</React.Fragment>
    ),
  )
}

export function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**') && p.length > 4) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {renderWithRedactions(p.slice(2, -2), String(i))}
        </strong>
      )
    }
    if (p.startsWith('`') && p.endsWith('`') && p.length > 2) {
      return (
        <code key={i} className="rounded bg-muted px-1 font-mono text-[0.85em]">
          {p.slice(1, -1)}
        </code>
      )
    }
    // §24.134d: a plain segment may carry redaction tokens — render each as a
    // provenance-tiered chip, the rest as unescaped text.
    return renderWithRedactions(p, String(i))
  })
}

const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/
const BULLET_RE = /^[-*+]\s+/
const ORDERED_RE = /^\d+[.)]\s+/
// A table separator row (`|---|---|` / `|:--|--:|`), tolerant of spacing.
const TABLE_SEP_RE = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/

/** Split one `| a | b |` row into trimmed cells. */
function tableCells(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
}

function renderTable(lines: string[], key: string): React.ReactNode {
  const hasHeader = lines.length > 1 && TABLE_SEP_RE.test(lines[1])
  const header = hasHeader ? tableCells(lines[0]) : null
  const body = (hasHeader ? lines.slice(2) : lines).map(tableCells)
  return (
    <div key={key} className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        {header ? (
          <thead>
            <tr>
              {header.map((c, i) => (
                <th
                  key={i}
                  className="border border-border bg-muted/40 px-2 py-1.5 text-left font-mono text-[11px] uppercase tracking-wider text-muted-foreground"
                >
                  {renderInline(c)}
                </th>
              ))}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((c, i) => (
                <td key={i} className="border border-border px-2 py-1.5 align-top leading-relaxed text-foreground/90">
                  {renderInline(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function renderMarkdownish(text: string): React.ReactNode {
  const lines = text.split('\n')
  const out: React.ReactNode[] = []
  let list: string[] = []
  let ordered: string[] = []
  let table: string[] = []

  const flushList = (key: string): void => {
    if (list.length > 0) {
      out.push(
        <ul key={`ul-${key}`} className="my-2 ml-4 list-disc space-y-1 text-sm leading-relaxed text-foreground/90">
          {list.map((li, i) => (
            <li key={i}>{renderInline(li)}</li>
          ))}
        </ul>,
      )
      list = []
    }
    if (ordered.length > 0) {
      out.push(
        <ol key={`ol-${key}`} className="my-2 ml-4 list-decimal space-y-1 text-sm leading-relaxed text-foreground/90">
          {ordered.map((li, i) => (
            <li key={i}>{renderInline(li)}</li>
          ))}
        </ol>,
      )
      ordered = []
    }
    if (table.length > 0) {
      out.push(renderTable(table, `tbl-${key}`))
      table = []
    }
  }

  lines.forEach((raw, i) => {
    const line = raw.trimEnd()
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    // Pipe-table rows accumulate until a non-table line flushes the block.
    if (line.trimStart().startsWith('|')) {
      if (list.length > 0 || ordered.length > 0) flushList(String(i))
      table.push(line.trim())
      return
    }
    if (table.length > 0) flushList(String(i))

    if (HR_RE.test(line.trim())) {
      flushList(String(i))
      out.push(<hr key={`hr-${i}`} className="my-4 border-border" />)
    } else if (heading) {
      flushList(String(i))
      const major = heading[1].length <= 2
      out.push(
        major ? (
          <h3
            key={`h-${i}`}
            className="mt-4 font-mono text-xs font-semibold uppercase tracking-widest text-primary first:mt-0"
          >
            {renderInline(heading[2])}
          </h3>
        ) : (
          <h4 key={`h-${i}`} className="mt-3 text-sm font-semibold text-foreground first:mt-0">
            {renderInline(heading[2])}
          </h4>
        ),
      )
    } else if (BULLET_RE.test(line)) {
      if (ordered.length > 0) flushList(String(i))
      list.push(line.replace(BULLET_RE, ''))
    } else if (ORDERED_RE.test(line)) {
      if (list.length > 0) flushList(String(i))
      ordered.push(line.replace(ORDERED_RE, ''))
    } else if (line.length === 0) {
      flushList(String(i))
    } else {
      flushList(String(i))
      out.push(
        <p key={`p-${i}`} className="my-2 text-sm leading-relaxed text-foreground/90 first:mt-0">
          {renderInline(line)}
        </p>,
      )
    }
  })
  flushList('end')
  return out
}
