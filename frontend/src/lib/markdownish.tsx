import * as React from 'react'

/**
 * The hand-rolled markdown-ish renderer (§24.31 Δ, extracted §24.65) — shared
 * by the simulator output pane and the /kit dossier. Handles the narrow shapes
 * the agent actually emits: `#`–`####` headings, `-` lists, `---` rules,
 * `**bold**` / `` `code` `` inline, blank-line paragraphs. Still no dependency.
 */
export function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  if (parts.length === 1) return text
  return parts.map((p, i) => {
    if (p.startsWith('**') && p.endsWith('**') && p.length > 4) {
      return (
        <strong key={i} className="font-semibold text-foreground">
          {p.slice(2, -2)}
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
    return p
  })
}

const HR_RE = /^(-{3,}|\*{3,}|_{3,})$/

export function renderMarkdownish(text: string): React.ReactNode {
  const lines = text.split('\n')
  const out: React.ReactNode[] = []
  let list: string[] = []

  const flushList = (key: string): void => {
    if (list.length === 0) return
    out.push(
      <ul key={`ul-${key}`} className="my-2 ml-4 list-disc space-y-1 text-sm leading-relaxed text-foreground/90">
        {list.map((li, i) => (
          <li key={i}>{renderInline(li)}</li>
        ))}
      </ul>,
    )
    list = []
  }

  lines.forEach((raw, i) => {
    const line = raw.trimEnd()
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
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
    } else if (line.startsWith('- ')) {
      list.push(line.slice(2))
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
