import * as React from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { Redaction } from '~/components/Redaction'
import { cn } from '~/lib/utils'

/**
 * The kit + simulator markdown renderer (§24.182, replacing the hand-rolled
 * §24.31/§24.65 renderer). Real CommonMark + GFM via react-markdown + remark-gfm
 * — italics, correctly-numbered ordered lists, nested lists, links, tables,
 * blockquotes — styled to the app's design tokens. The `[…REDACTED…]` provenance
 * tokens the sanitizer leaves in public-bound prose become <Redaction> chips.
 *
 * Safe by default: react-markdown renders NO raw HTML (we never add rehype-raw),
 * so a sanitized section body can't inject markup.
 *
 * The chip splitting is a REHYPE pass (over the resolved HTML tree, not mdast) so
 * a token is caught wherever it lands — inside bold, a table cell, a list item,
 * or an undefined shortcut-reference `[label]`. The token grammar excludes both
 * brackets in the label, so a malformed nested `[REDACTED:[AI_REDACTED]]` never
 * mis-splits — the inner `[AI_REDACTED]` chips on its own instead of a broken
 * half-token (§24.182 defense behind the server-side fix).
 */

// [AI_REDACTED] | [<TYPE>_REDACTED] | [REDACTED:<label>] | [REDACTED]
const REDACTION_TOKEN = /\[(?:[A-Z]+_)?REDACTED(?::[^[\]]+)?\]/g

interface HastNode {
  type: string
  value?: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

/** Split one text value on redaction tokens; null when it carries none. */
function splitTextOnTokens(value: string): HastNode[] | null {
  REDACTION_TOKEN.lastIndex = 0
  if (!REDACTION_TOKEN.test(value)) return null
  REDACTION_TOKEN.lastIndex = 0
  const out: HastNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = REDACTION_TOKEN.exec(value)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
    out.push({ type: 'element', tagName: 'redaction', properties: { token: m[0] }, children: [] })
    last = m.index + m[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

/** Walk the hast tree, turning `[…REDACTED…]` text into `<redaction>` elements. */
function splitRedactionsInTree(node: HastNode): void {
  const children = node.children
  if (!children) return
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.type === 'text' && typeof child.value === 'string') {
      const parts = splitTextOnTokens(child.value)
      if (parts) {
        children.splice(i, 1, ...parts)
        i += parts.length - 1
      }
    } else {
      splitRedactionsInTree(child)
    }
  }
}

function rehypeRedaction() {
  return (tree: HastNode): void => splitRedactionsInTree(tree)
}

const REMARK_PLUGINS = [remarkGfm]
const REHYPE_PLUGINS = [rehypeRedaction]

// Style react-markdown's output to the app's tokens, preserving the look the
// hand-rolled renderer produced. Headings collapse to two tiers (the kit renders
// section bodies, so `#`/`##` are the "major" tier, `###`+ the "minor" tier).
const H_MAJOR = 'mt-4 font-mono text-xs font-semibold uppercase tracking-widest text-primary first:mt-0'
const H_MINOR = 'mt-3 text-sm font-semibold text-foreground first:mt-0'

const COMPONENTS: Components = {
  h1: ({ children }) => <h3 className={H_MAJOR}>{children}</h3>,
  h2: ({ children }) => <h3 className={H_MAJOR}>{children}</h3>,
  h3: ({ children }) => <h4 className={H_MINOR}>{children}</h4>,
  h4: ({ children }) => <h4 className={H_MINOR}>{children}</h4>,
  h5: ({ children }) => <h4 className={H_MINOR}>{children}</h4>,
  h6: ({ children }) => <h4 className={H_MINOR}>{children}</h4>,
  p: ({ children }) => <p className="my-2 text-sm leading-relaxed text-foreground/90 first:mt-0">{children}</p>,
  ul: ({ children }) => (
    <ul className="my-2 ml-4 list-disc space-y-1 text-sm leading-relaxed text-foreground/90 [&_ol]:my-1 [&_ul]:my-1">
      {children}
    </ul>
  ),
  ol: ({ children, start }) => (
    <ol
      start={start}
      className="my-2 ml-4 list-decimal space-y-1 text-sm leading-relaxed text-foreground/90 [&_ol]:my-1 [&_ul]:my-1"
    >
      {children}
    </ol>
  ),
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-primary underline underline-offset-2 hover:no-underline"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-border" />,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-border pl-3 text-sm italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  code: ({ className, children }) =>
    className ? (
      <code className={cn('font-mono text-[0.85em]', className)}>{children}</code>
    ) : (
      <code className="rounded bg-muted px-1 font-mono text-[0.85em]">{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 text-[0.8em] leading-relaxed">{children}</pre>
  ),
  table: ({ children }) => (
    <div className="my-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-border bg-muted/40 px-2 py-1.5 text-left font-mono text-[11px] uppercase tracking-wider text-muted-foreground">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-border px-2 py-1.5 align-top leading-relaxed text-foreground/90">{children}</td>
  ),
}

/** The custom `<redaction>` element rehypeRedaction emits → provenance chip. */
const RedactionChip = ({ token }: { token?: string }) => <Redaction token={token ?? ''} />

// react-markdown renders a custom hast element through a matching `components`
// key at runtime; `redaction` isn't an HTML tag, so it lives past the typed set.
const BLOCK_COMPONENTS = { ...COMPONENTS, redaction: RedactionChip } as Components

// Inline variant: unwrap the block <p> so bold/tokens render inline (the /live
// summary + the redaction integration). Everything else is shared.
const INLINE_COMPONENTS = {
  ...COMPONENTS,
  redaction: RedactionChip,
  p: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
} as Components

/** Render a markdown string to styled React (block-level). */
export function renderMarkdownish(text: string): React.ReactNode {
  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={BLOCK_COMPONENTS}>
      {text}
    </Markdown>
  )
}

/** Render a markdown string inline (no wrapping block), tokens as chips. */
export function renderInline(text: string): React.ReactNode {
  return (
    <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={INLINE_COMPONENTS}>
      {text}
    </Markdown>
  )
}
