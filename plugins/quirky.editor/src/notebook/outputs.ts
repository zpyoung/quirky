import DOMPurify from 'dompurify'
import type { JsonObject } from './document'

const MIME_PREFERENCE = [
  'text/html', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/jpeg', 'image/jpg',
  'image/svg+xml', 'application/json', 'text/markdown', 'text/plain'
] as const
const MAX_RENDERED_TEXT = 512 * 1024
const ALLOWED_SGR = new Set([0, 1, 3, 4, 22, 23, 24, 39, 49])

type AnsiStyle = { color?: string; backgroundColor?: string; fontWeight?: 'bold'; fontStyle?: 'italic'; textDecoration?: string }
export type AnsiSegment = { text: string; style: AnsiStyle }
export type RenderableOutput = { mime: string; value: unknown }

function palette(index: number): string {
  const base = [
    '#000000', '#aa0000', '#00aa00', '#aa5500', '#0000aa', '#aa00aa', '#00aaaa', '#aaaaaa',
    '#555555', '#ff5555', '#55ff55', '#ffff55', '#5555ff', '#ff55ff', '#55ffff', '#ffffff'
  ]
  return base[index] ?? '#ffffff'
}

function indexedColor(index: number): string {
  if (index < 16) return palette(index)
  if (index >= 232) {
    const shade = Math.min(255, 8 + (index - 232) * 10)
    return `rgb(${shade}, ${shade}, ${shade})`
  }
  const value = index - 16
  const levels = [0, 95, 135, 175, 215, 255]
  return `rgb(${levels[Math.floor(value / 36)] ?? 0}, ${levels[Math.floor(value / 6) % 6] ?? 0}, ${levels[value % 6] ?? 0})`
}

function applySgr(style: AnsiStyle, code: number, next: number[], at: number): number {
  if (code === 0) return -1
  if (code === 1) style.fontWeight = 'bold'
  else if (code === 3) style.fontStyle = 'italic'
  else if (code === 4) style.textDecoration = 'underline'
  else if (code === 22) delete style.fontWeight
  else if (code === 23) delete style.fontStyle
  else if (code === 24) delete style.textDecoration
  else if (code === 39) delete style.color
  else if (code === 49) delete style.backgroundColor
  else if (code >= 30 && code <= 37) style.color = palette(code - 30)
  else if (code >= 90 && code <= 97) style.color = palette(code - 90 + 8)
  else if (code >= 40 && code <= 47) style.backgroundColor = palette(code - 40)
  else if (code >= 100 && code <= 107) style.backgroundColor = palette(code - 100 + 8)
  else if ((code === 38 || code === 48) && next[at] === 5 && Number.isInteger(next[at + 1])) {
    const color = indexedColor(next[at + 1]!)
    if (code === 38) style.color = color
    else style.backgroundColor = color
    return at + 2
  } else if ((code === 38 || code === 48) && next[at] === 2 && next.slice(at + 1, at + 4).every(Number.isInteger)) {
    const color = `rgb(${next[at + 1]}, ${next[at + 2]}, ${next[at + 3]})`
    if (code === 38) style.color = color
    else style.backgroundColor = color
    return at + 4
  } else if (!ALLOWED_SGR.has(code) && !(code >= 30 && code <= 37) && !(code >= 40 && code <= 47) && !(code >= 90 && code <= 97) && !(code >= 100 && code <= 107)) {
    return at
  }
  return at
}

export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = []
  const style: AnsiStyle = {}
  let cursor = 0
  const expression = /\u001b\[([\d;]*)m/g
  let match: RegExpExecArray | null
  while ((match = expression.exec(text)) !== null) {
    if (match.index > cursor) segments.push({ text: text.slice(cursor, match.index), style: { ...style } })
    const codes = (match[1] ?? '').split(';').map((value) => value === '' ? 0 : Number(value))
    for (let index = 0; index < codes.length; index++) {
      const code = codes[index]!
      if (code === 0) {
        for (const key of Object.keys(style) as (keyof AnsiStyle)[]) delete style[key]
      } else {
        index = applySgr(style, code, codes, index)
      }
    }
    cursor = expression.lastIndex
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), style: { ...style } })
  if (segments.length === 0) return [{ text, style: {} }]
  return segments
}

function stringifyOutput(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value.join('')
  try { return JSON.stringify(value, null, 2) ?? '' } catch { return String(value) }
}

export function preferredOutput(output: JsonObject): RenderableOutput | null {
  const data = output.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const mimeData = data as JsonObject
  for (const mime of MIME_PREFERENCE) {
    if (Object.hasOwn(mimeData, mime)) return { mime, value: mimeData[mime] }
  }
  return null
}

export function sanitizeHtml(value: string): string {
  const sanitized = DOMPurify.sanitize(value.slice(0, MAX_RENDERED_TEXT), {
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'meta', 'link'],
    FORBID_ATTR: ['srcset', 'target', 'action', 'formaction']
  })
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'"><body>${sanitized}</body>`
}

export function outputText(output: JsonObject): string {
  const outputType = output.output_type
  if (outputType === 'stream') return stringifyOutput(output.text).slice(0, MAX_RENDERED_TEXT)
  if (outputType === 'error') {
    const traceback = Array.isArray(output.traceback) ? output.traceback.filter((line): line is string => typeof line === 'string').join('\n') : ''
    return `${String(output.ename ?? 'Error')}: ${String(output.evalue ?? '')}\n${traceback}`.slice(0, MAX_RENDERED_TEXT)
  }
  const preferred = preferredOutput(output)
  return preferred?.mime === 'text/plain' || preferred?.mime === 'text/markdown' ? stringifyOutput(preferred.value).slice(0, MAX_RENDERED_TEXT) : ''
}

export function safeSvgDataUrl(value: string): string {
  const sanitized = DOMPurify.sanitize(value.slice(0, MAX_RENDERED_TEXT), { USE_PROFILES: { svg: true, svgFilters: true } })
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(sanitized)}`
}

export function base64ImageDataUrl(mime: string, value: unknown): string | null {
  if (!mime.startsWith('image/') || typeof value !== 'string' || value.length > 8 * 1024 * 1024) return null
  if (mime === 'image/svg+xml') return safeSvgDataUrl(value)
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null
  return `data:${mime};base64,${value}`
}
