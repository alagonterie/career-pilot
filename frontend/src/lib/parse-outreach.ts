// Split the cold-outreach email out of the agent's run output, so the results
// page can present it as its own "gift" (§24.72) — subject + body — separate
// from the résumé (which is the downloadable PDF). Lenient about the agent's
// formatting: the heading may be "## Cold Outreach Email" or "## Cold outreach —
// {company}", and the subject "**Subject:** …" or "Subject: …". Returns null when
// there's no recognizable outreach section (the caller falls back to raw output).

export interface Outreach {
  subject: string
  body: string
}

export function parseOutreach(text: string): Outreach | null {
  if (!text) return null
  const lines = text.split('\n')

  // The outreach section starts at the first heading mentioning "outreach".
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s.*outreach/i.test(lines[i])) {
      start = i + 1
      break
    }
  }
  if (start < 0) return null

  // Collect until the next heading, or the `---` that precedes a closing note.
  const collected: string[] = []
  for (let i = start; i < lines.length; i++) {
    const l = lines[i]
    if (/^#{1,6}\s/.test(l)) break
    if (/^---+\s*$/.test(l)) {
      let j = i + 1
      while (j < lines.length && lines[j].trim() === '') j++
      if (j < lines.length && /^\**\s*(closing\s+)?note/i.test(lines[j])) break
      continue // a stray separator inside the email — skip it
    }
    collected.push(l)
  }

  const block = collected.join('\n').trim()
  if (!block) return null

  const subjMatch = block.match(/^\**\s*subject\s*\**\s*:\s*\**\s*(.+?)\**\s*$/im)
  const subject = subjMatch ? subjMatch[1].trim() : ''
  const body = (subjMatch ? block.replace(subjMatch[0], '') : block).trim()
  if (!body) return null
  return { subject, body }
}
