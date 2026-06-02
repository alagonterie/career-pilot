import { describe, expect, it } from 'vitest'

import { parseFrame, SseParser, type SseEvent } from './sse'

describe('parseFrame', () => {
  it('parses an id + data frame (matching the host broadcaster wire format)', () => {
    expect(parseFrame('id: 42\ndata: {"seq":42}')).toEqual<SseEvent>({
      id: '42',
      event: undefined,
      data: '{"seq":42}',
    })
  })

  it('strips exactly one leading space after the colon', () => {
    expect(parseFrame('data:  two-spaces')?.data).toBe(' two-spaces')
  })

  it('joins multi-line data with newlines', () => {
    expect(parseFrame('data: line1\ndata: line2')?.data).toBe('line1\nline2')
  })

  it('reads an explicit event name', () => {
    expect(parseFrame('event: trace\ndata: {}')).toMatchObject({ event: 'trace', data: '{}' })
  })

  it('returns null for a comment-only frame (keepalive `: ka`)', () => {
    expect(parseFrame(': ka')).toBeNull()
  })
})

describe('SseParser', () => {
  it('emits one event per complete frame', () => {
    const p = new SseParser()
    const events = p.push('id: 1\ndata: a\n\nid: 2\ndata: b\n\n')
    expect(events.map((e) => e.id)).toEqual(['1', '2'])
    expect(events.map((e) => e.data)).toEqual(['a', 'b'])
  })

  it('reassembles a frame split across chunks', () => {
    const p = new SseParser()
    expect(p.push('id: 7\nda')).toEqual([])
    expect(p.push('ta: partial\n')).toEqual([])
    const events = p.push('\n') // completes the frame
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ id: '7', data: 'partial' })
  })

  it('skips keepalive frames but still surfaces real events interleaved with them', () => {
    const p = new SseParser()
    const events = p.push(': ka\n\nid: 9\ndata: live\n\n: ka\n\n')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ id: '9', data: 'live' })
  })

  it('normalizes CRLF line endings (proxy-rewritten streams)', () => {
    const p = new SseParser()
    const events = p.push('id: 3\r\ndata: crlf\r\n\r\n')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ id: '3', data: 'crlf' })
  })

  it('holds a trailing partial frame until its terminator arrives', () => {
    const p = new SseParser()
    expect(p.push('id: 5\ndata: waiting')).toEqual([]) // no blank line yet
    expect(p.push('\n\n')).toHaveLength(1)
  })
})
