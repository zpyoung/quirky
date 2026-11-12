const INVISIBLE = /[\u0000-\u0008\u000E-\u001F\u007F-\u0084\u0086-\u009F\p{Cf}\p{Default_Ignorable_Code_Point}]/gu
const FORMAT_OR_IGNORABLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u
const UNICODE_SPACE = /\p{White_Space}/u
const MAX_PASSES = 9

/** Replaces context whose hidden markup cannot be fully removed within the pass limit. */
export const TOO_DEEP = '[removed: hidden markup nested too deeply]'

const VOID_ELEMENTS: Record<string, true> = {
  area: true, base: true, br: true, col: true, embed: true, hr: true, img: true,
  input: true, link: true, meta: true, source: true, track: true, wbr: true
}

type Tag = { end: number; name: string; closing: boolean; selfClosing: boolean; hidden: boolean; alts: Array<[number, number]> }

function space(code: number): boolean {
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) || code === 0x85 || code === 0xa0 ||
    code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 ||
    code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff
}

function parseTag(text: string, start: number): Tag | null {
  let i = start + 1
  const closing = text.charCodeAt(i) === 0x2f
  if (closing) i++
  const first = text.charCodeAt(i)
  if (!((first >= 0x41 && first <= 0x5a) || (first >= 0x61 && first <= 0x7a))) return null
  const nameStart = i
  while (i < text.length) {
    const c = text.charCodeAt(i)
    if (space(c) || c === 0x2f || c === 0x3e || c === 0x3c) break
    i++
  }
  const name = text.slice(nameStart, i).toLowerCase()
  const attributesStart = i
  let quote = 0
  let close = -1
  for (; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (quote !== 0) {
      if (c === quote) quote = 0
    } else if (c === 0x3c) return null
    else if (c === 0x22 || c === 0x27) quote = c
    else if (c === 0x3e) {
      close = i
      break
    }
  }
  if (close < 0) return null

  let selfClosing = false
  for (let p = close - 1; p >= attributesStart; p--) {
    const c = text.charCodeAt(p)
    if (space(c)) continue
    selfClosing = c === 0x2f
    break
  }

  let hidden = false
  const alts: Array<[number, number]> = []
  if (!closing) {
    let p = attributesStart
    while (p < close) {
      const gap = p
      while (p < close && space(text.charCodeAt(p))) p++
      if (p >= close) break
      if (text.charCodeAt(p) === 0x2f) {
        p++
        continue
      }
      const attrStart = p
      while (p < close) {
        const c = text.charCodeAt(p)
        if (space(c) || c === 0x2f || c === 0x3d || c === 0x3e) break
        p++
      }
      if (p === attrStart) {
        p++
        continue
      }
      const attr = text.slice(attrStart, p).toLowerCase()
      let attrEnd = p
      while (p < close && space(text.charCodeAt(p))) p++
      if (text.charCodeAt(p) === 0x3d) {
        p++
        while (p < close && space(text.charCodeAt(p))) p++
        const valueQuote = text.charCodeAt(p)
        if (valueQuote === 0x22 || valueQuote === 0x27) {
          p++
          while (p < close && text.charCodeAt(p) !== valueQuote) p++
          if (p < close) p++
        } else {
          while (p < close && !space(text.charCodeAt(p)) && text.charCodeAt(p) !== 0x3e) p++
        }
        attrEnd = p
      }
      if (attr === 'hidden') hidden = true
      if (name === 'img' && attr === 'alt') alts.push([gap, attrEnd])
      p = attrEnd
    }
  }
  return { end: close + 1, name, closing, selfClosing, hidden, alts }
}

function stripComments(text: string): string {
  let start = text.indexOf('<!--')
  if (start < 0) return text
  const parts: string[] = []
  let copy = 0
  while (start >= 0) {
    parts.push(text.slice(copy, start))
    const end = text.indexOf('-->', start + 4)
    if (end < 0) return parts.join('')
    copy = end + 3
    start = text.indexOf('<!--', copy)
  }
  parts.push(text.slice(copy))
  return parts.join('')
}

function elementEnd(text: string, opening: Tag): number {
  let depth = 1
  let cursor = opening.end
  while (cursor < text.length) {
    const start = text.indexOf('<', cursor)
    if (start < 0) return text.length
    const tag = parseTag(text, start)
    if (tag === null) {
      cursor = start + 1
      continue
    }
    if (tag.name === opening.name) {
      if (tag.closing && --depth === 0) return tag.end
      if (!tag.closing && !tag.selfClosing && VOID_ELEMENTS[tag.name] !== true) depth++
    }
    cursor = tag.end
  }
  return text.length
}

function stripElements(text: string): string {
  const parts: string[] = []
  let copy = 0
  let cursor = 0
  let changed = false
  while (cursor < text.length) {
    const start = text.indexOf('<', cursor)
    if (start < 0) break
    const tag = parseTag(text, start)
    if (tag === null) {
      cursor = start + 1
      continue
    }
    if (!tag.closing && (tag.name === 'details' || tag.hidden)) {
      const end = tag.selfClosing || VOID_ELEMENTS[tag.name] === true ? tag.end : elementEnd(text, tag)
      parts.push(text.slice(copy, start))
      copy = end
      cursor = end
      changed = true
      continue
    }
    for (const [startAlt, endAlt] of tag.alts) {
      parts.push(text.slice(copy, startAlt))
      copy = endAlt
      changed = true
    }
    cursor = tag.end
  }
  if (!changed) return text
  parts.push(text.slice(copy))
  return parts.join('')
}

function stripImageAlts(text: string): string {
  const opens: number[] = []
  const images: boolean[] = []
  const starts: number[] = []
  const ends: number[] = []
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c === 0x5c) {
      if (i + 1 < text.length) {
        i++
        escaped = true
      } else escaped = false
      continue
    }
    if (c === 0x5b) {
      opens.push(i)
      images.push(!escaped && i > 0 && text.charCodeAt(i - 1) === 0x21)
      escaped = false
    } else if (c === 0x5d && opens.length > 0) {
      let start = opens.pop()! + 1
      let end = i
      const image = images.pop()!
      if (image && start < end && (text.charCodeAt(i + 1) === 0x28 || text.charCodeAt(i + 1) === 0x5b)) {
        while (starts.length > 0 && ends[ends.length - 1]! >= start) {
          start = Math.min(start, starts.pop()!)
          end = Math.max(end, ends.pop()!)
        }
        starts.push(start)
        ends.push(end)
      }
      escaped = false
    } else escaped = false
  }
  if (starts.length === 0) return text
  const parts: string[] = []
  let copy = 0
  for (let i = 0; i < starts.length; i++) {
    parts.push(text.slice(copy, starts[i]!))
    copy = ends[i]!
  }
  parts.push(text.slice(copy))
  return parts.join('')
}

function whitespace(text: string, i: number): boolean {
  return space(text.charCodeAt(i))
}

function inlineClosers(text: string): Map<number, number> {
  const ends = new Map<number, number>()
  const opens: number[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '\\') i++
    else if (char === '(') opens.push(i)
    else if (char === ')' && opens.length > 0) ends.set(opens.pop()!, i + 1)
  }
  let greater = -1
  for (let i = text.length - 1; i >= 0; i--) {
    if (text[i] === '>') greater = i
    else if (text[i] === '<' && greater >= 0) ends.set(i, greater + 1)
  }
  return ends
}

function inlineTitle(text: string, marker: number, closers: ReadonlyMap<number, number>): [number, number] | null {
  let i = marker + 2
  while (i < text.length && whitespace(text, i)) i++
  let targetEnd: number
  if (text.charCodeAt(i) === 0x3c) {
    const end = closers.get(i)
    if (end === undefined) return null
    targetEnd = end
    i = end
  } else {
    const start = i
    while (i < text.length && !whitespace(text, i) && text.charCodeAt(i) !== 0x29) i++
    if (i === start) return null
    targetEnd = i
  }
  if (i >= text.length || !whitespace(text, i)) return null
  while (i < text.length && whitespace(text, i)) i++
  const quote = text.charCodeAt(i)
  if (quote === 0x22 || quote === 0x27) {
    i++
    while (i < text.length) {
      const c = text.charCodeAt(i)
      if (c === 0x5c && i + 1 < text.length) i += 2
      else if (c === quote) break
      else i++
    }
    if (i >= text.length) return null
    i++
  } else if (quote === 0x28) {
    const end = closers.get(i)
    if (end === undefined) return null
    i = end
  } else return null
  while (i < text.length && whitespace(text, i)) i++
  return text.charCodeAt(i) === 0x29 ? [targetEnd, i + 1] : null
}

function stripInlineTitles(text: string): string {
  if (!text.includes('](')) return text
  const closers = inlineClosers(text)
  const parts: string[] = []
  let copy = 0
  let cursor = 0
  let changed = false
  while (cursor < text.length) {
    const marker = text.indexOf('](', cursor)
    if (marker < 0) break
    const title = inlineTitle(text, marker, closers)
    if (title === null) {
      let next = marker + 2
      while (next < text.length && !whitespace(text, next) && text.charCodeAt(next) !== 0x29) next++
      cursor = Math.max(next, marker + 2)
      continue
    }
    parts.push(text.slice(copy, title[0]), ')')
    copy = title[1]
    cursor = title[1]
    changed = true
  }
  if (!changed) return text
  parts.push(text.slice(copy))
  return parts.join('')
}

function titleValue(text: string, start: number, end: number): number {
  const quote = text.charCodeAt(start)
  if (quote === 0x22 || quote === 0x27) {
    let i = start + 1
    while (i < end) {
      const c = text.charCodeAt(i)
      if (c === 0x5c && i + 1 < end) i += 2
      else if (c === quote) return i + 1
      else i++
    }
    return -1
  }
  if (quote !== 0x28) return -1
  let depth = 1
  let i = start + 1
  while (i < end && depth > 0) {
    const c = text.charCodeAt(i)
    if (c === 0x5c && i + 1 < end) i += 2
    else {
      if (c === 0x28) depth++
      if (c === 0x29) depth--
      i++
    }
  }
  return depth === 0 ? i : -1
}

function referenceTitle(text: string, start: number, end: number, nextLine: number): [number, number, number] | null {
  let i = start
  while (i < end && whitespace(text, i)) i++
  if (text.charCodeAt(i) !== 0x5b) return null
  let close = i + 1
  while (close < end && text.charCodeAt(close) !== 0x5d) close++
  if (close === i + 1 || close === end || text.charCodeAt(close + 1) !== 0x3a) return null
  i = close + 2
  while (i < end && whitespace(text, i)) i++
  const targetStart = i
  while (i < end && !whitespace(text, i)) i++
  if (i === targetStart) return null
  const targetEnd = i
  while (i < end && whitespace(text, i)) i++
  let titleEnd: number
  let titleLineEnd = end
  let afterLine = nextLine
  if (i < end) {
    titleEnd = titleValue(text, i, end)
    if (titleEnd < 0) return null
  } else {
    if (nextLine >= text.length) return null
    titleLineEnd = text.indexOf('\n', nextLine)
    if (titleLineEnd < 0) titleLineEnd = text.length
    i = nextLine
    while (i < titleLineEnd && whitespace(text, i)) i++
    titleEnd = titleValue(text, i, titleLineEnd)
    if (titleEnd < 0) return null
    afterLine = titleLineEnd < text.length ? titleLineEnd + 1 : text.length
  }
  while (titleEnd < titleLineEnd && (text.charCodeAt(titleEnd) === 0x20 || text.charCodeAt(titleEnd) === 0x09)) titleEnd++
  return titleEnd === titleLineEnd ? [targetEnd, titleLineEnd, afterLine] : null
}

function stripReferenceTitles(text: string): string {
  const parts: string[] = []
  let copy = 0
  let line = 0
  let changed = false
  while (line < text.length) {
    let end = text.indexOf('\n', line)
    if (end < 0) end = text.length
    const next = end < text.length ? end + 1 : text.length
    const title = referenceTitle(text, line, end, next)
    if (title === null) {
      line = next
      continue
    }
    parts.push(text.slice(copy, title[0]))
    copy = title[1]
    line = title[2]
    changed = true
  }
  if (!changed) return text
  parts.push(text.slice(copy))
  return parts.join('')
}

/** Sanitizes context text only; never use it for a call or a diff someone must rule on. */
export function sanitize(text: string): string {
  let current = text.replace(INVISIBLE, '')
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = stripReferenceTitles(stripInlineTitles(stripImageAlts(stripElements(stripComments(current)))))
    if (next === current) return current
    if (pass === MAX_PASSES - 1) return TOO_DEEP
    current = next
  }
  return current
}

/** Copies journal JSON while removing hidden markup from every string and object key. */
export function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitize(value)
  if (Array.isArray(value)) return value.map(sanitizeValue)
  if (value !== null && typeof value === 'object') {
    const copy: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value)) {
      Object.defineProperty(copy, sanitize(key), {
        value: sanitizeValue(nested), enumerable: true, writable: true, configurable: true
      })
    }
    return copy
  }
  return value
}

/** Escapes non-visible characters in a call or a diff someone must rule on without removing text. */
export function escapeInvisible(text: string): string {
  const parts: string[] = []
  let copy = 0
  let offset = 0
  for (const character of text) {
    const code = character.codePointAt(0)!
    const next = offset + character.length
    const control = (code <= 0x1f && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)
    const loneSurrogate = code >= 0xd800 && code <= 0xdfff
    const space = code !== 0x20 && code !== 0x09 && code !== 0x0a && UNICODE_SPACE.test(character)
    if (control || loneSurrogate || code === 0x2028 || code === 0x2029 || space || FORMAT_OR_IGNORABLE.test(character)) {
      parts.push(text.slice(copy, offset), `\\u{${code.toString(16).toUpperCase().padStart(4, '0')}}`)
      copy = next
    }
    offset = next
  }
  if (copy === 0) return text
  parts.push(text.slice(copy))
  return parts.join('')
}

/** Sanitizes context text and wraps it in a labelled `<data>` block; an embedded closing tag cannot end it. */
export function quoteAsData(label: string, text: string): string {
  const safeLabel = escapeInvisible(label.replace(/["<>\r\n]/g, ' '))
  const body = sanitize(text).replace(/<\/data/gi, '<\\/data')
  return `<data source="${safeLabel}">\n${body}\n</data>`
}
