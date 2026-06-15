// Mirror of the host-side strip in src/modules/portal/tailored-resume.ts, for the
// LIVE simulator output. The agent's tailored-résumé fenced block streams over the
// SSE `chat` events into `run.output`; unlike the persisted/shared copy (stripped
// server-side at persist time), the live stream is raw — so without this the raw
// JSON shows in the live results pane. We strip the block however the agent framed
// it: a tagged ```tailored-resume-json fence, the tag on the ```json info line, the
// tag on a leading label line inside a ```json fence, or a bare WorkProfile-shaped
// ```json fence — plus an unterminated trailing block while it's still streaming.

const TAILORED_TAG = 'tailored-resume-json'

function firstNonBlankLine(body: string): string {
  for (const line of body.split('\n')) if (line.trim() !== '') return line.trim()
  return ''
}

function stripLeadingTagLine(body: string): string {
  const lines = body.split('\n')
  let i = 0
  while (i < lines.length && lines[i].trim() === '') i++
  if (i < lines.length && lines[i].trim() === TAILORED_TAG) return lines.slice(i + 1).join('\n')
  return body
}

function isWorkProfileShapedJson(s: string): boolean {
  try {
    const v: unknown = JSON.parse(s.trim())
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>
      return 'experience' in o || 'bio' in o || 'skillGroups' in o
    }
  } catch {
    /* not JSON */
  }
  return false
}

/** Remove the tailored-résumé fenced block from the agent's chat output. */
export function stripTailoredResumeBlock(output: string): string {
  if (!output) return output
  const re = /```([^\n\r`]*)\r?\n([\s\S]*?)```/g
  const tagged: string[] = []
  const shaped: string[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(output)) !== null) {
    const lang = m[1].trim()
    const body = m[2]
    const explicitlyTagged = lang.includes(TAILORED_TAG) || firstNonBlankLine(body) === TAILORED_TAG
    const inner = stripLeadingTagLine(body)
    if (explicitlyTagged) tagged.push(m[0])
    else if ((lang === 'json' || lang === '') && isWorkProfileShapedJson(inner)) shaped.push(m[0])
  }
  const toRemove = tagged.length > 0 ? tagged : shaped
  let text = output
  for (const full of toRemove) text = text.split(full).join('')
  // Streaming: an unterminated tailored fence at the very end (no closing ``` yet).
  text = text
    .replace(/```tailored-resume-json[\s\S]*$/, '')
    .replace(/```json\s*\r?\n\s*tailored-resume-json[\s\S]*$/, '')
  return text.replace(/\n{3,}/g, '\n\n').trim()
}
