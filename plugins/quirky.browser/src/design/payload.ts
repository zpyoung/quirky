import type { DesignAnnotation, DesignPayload, DesignRect, DesignScreenshot } from '../design-contract'

export const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024

const LIMIT = {
  text: 200,
  nearbyText: 200,
  nearbyTextEntries: 10,
  html: 4096,
  ancestorPathEntries: 10,
  nearbyElements: 6,
  nearbyElement: 160,
  selector: 700,
  path: 900,
  cssClasses: 500,
  classAttribute: 200,
  selectedText: 500,
  reactComponents: 500,
  sourceFile: 500,
  comment: 2000,
  generic: 2048
} as const

const SECRET_MARKER_PATTERN = /access_token|auth_token|api_key|apikey|client_secret|oauth_state|x-amz-|session_id|sessionid|csrf|secret|password|passwd/i
const HTML_ATTRIBUTES: Readonly<Record<string, true>> = {
  id: true, class: true, name: true, type: true, role: true, href: true, src: true, alt: true, title: true, placeholder: true, for: true, action: true, method: true
}
const URL_ATTRIBUTES: Readonly<Record<string, true>> = { href: true, src: true, action: true }
const VOID_TAGS: Readonly<Record<string, true>> = {
  area: true, base: true, br: true, col: true, embed: true, hr: true, img: true, input: true,
  link: true, meta: true, param: true, source: true, track: true, wbr: true
}
const MAX_RECT_ABS = 10_000_000
const COMPUTED_STYLE_NAMES = [
  'display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'backgroundColor', 'border', 'borderRadius',
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'textAlign', 'zIndex'
]

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function hasSecret(value: string): boolean {
  return SECRET_MARKER_PATTERN.test(value)
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  const suffix = ' (truncated)'
  if (max <= suffix.length) return suffix.slice(0, max)
  let end = max - suffix.length
  const last = value.charCodeAt(end - 1)
  const next = value.charCodeAt(end)
  if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--
  return `${value.slice(0, end)}${suffix}`
}

function safeString(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const bounded = truncate(value, max)
  return hasSecret(bounded) ? '[redacted]' : bounded
}

function sanitizedUrl(value: unknown, base?: string): string {
  if (typeof value !== 'string' || value === '') throw new TypeError('browser design payload has no valid page URL')
  if (value === 'about:blank') return value
  let url: URL
  try { url = base === undefined ? new URL(value) : new URL(value, base) }
  catch { throw new TypeError('browser design payload has no valid page URL') }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') {
    throw new TypeError('browser design payload has an unsupported page URL')
  }
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return hasSecret(url.href) ? 'about:blank' : url.href
}

function boundedNumber(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(-MAX_RECT_ABS, Math.min(MAX_RECT_ABS, value))
}

function rect(value: unknown): DesignRect {
  const source = object(value)
  return {
    x: boundedNumber(source?.x),
    y: boundedNumber(source?.y),
    width: Math.max(0, boundedNumber(source?.width)),
    height: Math.max(0, boundedNumber(source?.height))
  }
}


function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(-MAX_RECT_ABS, Math.min(MAX_RECT_ABS, value)) : fallback
}
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64ByteAt(value: string, byteIndex: number): number {
  const group = Math.floor(byteIndex / 3) * 4
  const position = byteIndex % 3
  const a = BASE64.indexOf(value[group] ?? '')
  const b = BASE64.indexOf(value[group + 1] ?? '')
  const c = BASE64.indexOf(value[group + 2] ?? '')
  const d = BASE64.indexOf(value[group + 3] ?? '')
  if (a < 0 || b < 0 || c < 0 || d < 0) return -1
  if (position === 0) return (a << 2) | (b >> 4)
  if (position === 1) return ((b & 15) << 4) | (c >> 2)
  return ((c & 3) << 6) | d
}

function pngDimensions(value: string): { width: number; height: number } | null {
  if (!value.startsWith('iVBORw0KGgoAAAANSUhEUg')) return null
  let width = 0
  let height = 0
  for (let index = 0; index < 4; index++) {
    const widthByte = base64ByteAt(value, 16 + index)
    const heightByte = base64ByteAt(value, 20 + index)
    if (widthByte < 0 || heightByte < 0) return null
    width = width * 256 + widthByte
    height = height * 256 + heightByte
  }
  return width > 0 && height > 0 ? { width, height } : null
}
function validBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  const contentLength = value.length - padding
  for (let index = 0; index < contentLength; index++) if (!BASE64.includes(value[index]!)) return false
  for (let index = contentLength; index < value.length; index++) if (value[index] !== '=') return false
  return true
}

function attributeAllowed(name: string): boolean {
  const lower = name.toLowerCase()
  return Object.hasOwn(HTML_ATTRIBUTES, lower) || /^aria-[a-zA-Z0-9_-]+$/i.test(name)
}


function closeTagEnd(html: string, start: number): number {
  let quote = ''
  const limit = Math.min(html.length, start + 8192)
  for (let index = start; index < limit; index++) {
    const char = html[index]!
    if (quote !== '') {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") quote = char
    else if (char === '>') return index
  }
  return -1
}

function htmlAttributes(raw: string, base: string): string {
  const attributes = raw.match(/[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g) ?? []
  const output: string[] = []
  for (const part of attributes) {
    const match = /^([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?$/.exec(part)
    if (!match) continue
    const name = match[1]!
    const lower = name.toLowerCase()
    if (!attributeAllowed(name) || lower === 'value' || lower === 'checked' || lower === 'selected') continue
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    let clean: string
    if (Object.hasOwn(URL_ATTRIBUTES, lower)) {
      if (value === '' || hasSecret(value)) continue
      try { clean = sanitizedUrl(value, base) } catch { continue }
    } else {
      clean = hasSecret(value) ? '[redacted]' : truncate(value, lower === 'class' ? LIMIT.classAttribute : 500)
    }
    const escaped = clean.replaceAll('&', '&amp;').replaceAll('\"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    output.push(`${lower}=\"${escaped}\"`)
  }
  return output.length > 0 ? ` ${output.join(' ')}` : ''
}

function sanitizeHtml(value: unknown, base: string): string {
  if (typeof value !== 'string' || value === '') return ''
  const html = value.slice(0, LIMIT.html * 8)
  const lowerHtml = html.toLowerCase()
  let output = ''
  let index = 0
  const append = (part: string) => {
    if (output.length <= LIMIT.html) output += part.slice(0, LIMIT.html + 1 - output.length)
  }
  while (index < html.length && output.length <= LIMIT.html) {
    const open = html.indexOf('<', index)
    if (open < 0) {
      const text = html.slice(index, Math.min(html.length, index + LIMIT.html + 1))
      append(hasSecret(text) ? '[redacted]' : text)
      break
    }
    if (open > index) {
      const text = html.slice(index, Math.min(open, index + LIMIT.html + 1))
      append(hasSecret(text) ? '[redacted]' : text)
      if (output.length > LIMIT.html) break
    }
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4)
      index = end < 0 ? html.length : end + 3
      continue
    }
    const end = closeTagEnd(html, open + 1)
    if (end < 0) break
    const source = html.slice(open + 1, end)
    const tag = /^\s*(\/)?\s*([a-z][a-z\d:_-]*)\b([\s\S]*?)\s*(\/)?\s*$/i.exec(source)
    if (!tag) {
      append('&lt;')
      index = open + 1
      continue
    }
    const closing = tag[1] === '/'
    const name = tag[2]!.toLowerCase()
    index = end + 1
    if (name === 'script' || name === 'style' || name === 'noscript') {
      if (!closing) {
        const closeStart = lowerHtml.indexOf(`</${name}`, index)
        if (closeStart < 0) break
        const closeEnd = closeTagEnd(html, closeStart + 2 + name.length)
        index = closeEnd < 0 ? html.length : closeEnd + 1
      }
      continue
    }
    if (name === 'textarea' && !closing) {
      append('<textarea></textarea>')
      const closeStart = lowerHtml.indexOf('</textarea', index)
      if (closeStart < 0) break
      const closeEnd = closeTagEnd(html, closeStart + 2 + name.length)
      index = closeEnd < 0 ? html.length : closeEnd + 1
      continue
    }
    if (closing) {
      if (!Object.hasOwn(VOID_TAGS, name)) append(`</${name}>`)
      continue
    }
    const attrs = htmlAttributes(tag[3] ?? '', base)
    append(`<${name}${attrs}${tag[4] === '/' ? '/' : ''}>`)
  }
  return truncate(output, LIMIT.html)
}

function attributes(value: unknown, base: string): Record<string, string> {
  const source = object(value)
  const result: Record<string, string> = Object.create(null) as Record<string, string>
  if (!source) return result
  for (const name in source) {
    if (!Object.hasOwn(source, name)) continue
    const raw = source[name]
    const lower = name.toLowerCase()
    if (!attributeAllowed(name) || typeof raw !== 'string') continue
    if (Object.hasOwn(URL_ATTRIBUTES, lower)) {
      if (raw === '' || hasSecret(raw)) continue
      try { result[lower] = sanitizedUrl(raw, base) } catch { continue }
      continue
    }
    const max = lower === 'class' ? LIMIT.classAttribute : 500
    result[lower] = safeString(raw, max)
  }
  return result
}

function screenshot(value: unknown): DesignScreenshot | null {
  const source = object(value)
  if (!source || source.mimeType !== 'image/png' || typeof source.dataUrl !== 'string') return null
  const prefix = 'data:image/png;base64,'
  if (!source.dataUrl.startsWith(prefix)) return null
  const data = source.dataUrl.slice(prefix.length)
  const maxEncodedLength = Math.ceil(MAX_SCREENSHOT_BYTES * 4 / 3) + 4
  if (data.length === 0 || data.length > maxEncodedLength || !validBase64(data)) return null
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  const byteLength = data.length * 3 / 4 - padding
  if (byteLength > MAX_SCREENSHOT_BYTES) return null
  const dimensions = pngDimensions(data)
  if (!dimensions) return null
  return { mimeType: 'image/png', dataUrl: source.dataUrl, ...dimensions }
}
export function clampPayload(raw: unknown): DesignPayload {
  const source = object(raw)
  const page = object(source?.page)
  const target = object(source?.target)
  if (!page || !target || typeof target.tagName !== 'string' || target.tagName.length > 100 ||
      !/^[a-z][a-z0-9:-]*$/i.test(target.tagName) || typeof target.selector !== 'string' || target.selector === '') {
    throw new TypeError('browser design payload requires page and target objects')
  }
  const url = sanitizedUrl(page.sanitizedUrl)
  const viewportWidth = Math.max(0, boundedNumber(page.viewportWidth))
  const viewportHeight = Math.max(0, boundedNumber(page.viewportHeight))
  const nearbyText = Array.isArray(source?.nearbyText)
    ? source.nearbyText.slice(0, LIMIT.nearbyTextEntries).map((entry) => safeString(entry, LIMIT.nearbyText))
    : []
  const ancestorPath = Array.isArray(source?.ancestorPath)
    ? source.ancestorPath.slice(0, LIMIT.ancestorPathEntries).map((entry) => safeString(entry, LIMIT.path))
    : []
  const nearbyElements = Array.isArray(target.nearbyElements)
    ? target.nearbyElements.slice(0, LIMIT.nearbyElements).map((entry) => safeString(entry, LIMIT.nearbyElement))
    : []
  const accessibility = object(target.accessibility)
  const styles = object(target.computedStyles)
  const computedStyles: Record<string, string> = Object.create(null) as Record<string, string>
  if (styles) {
    for (const name of COMPUTED_STYLE_NAMES) {
      const value = styles[name]
      if (typeof value === 'string') computedStyles[name] = safeString(value, 500)
    }
  }
  const reactComponents = target.reactComponents === null || target.reactComponents === undefined ? null : safeString(target.reactComponents, LIMIT.reactComponents)
  const sourceFile = target.sourceFile === null || target.sourceFile === undefined ? null : safeString(target.sourceFile, LIMIT.sourceFile)
  return {
    page: {
      sanitizedUrl: url,
      title: safeString(page.title, 500),
      viewportWidth,
      viewportHeight,
      scrollX: finiteOr(page.scrollX, 0),
      scrollY: finiteOr(page.scrollY, 0),
      devicePixelRatio: Math.max(0.1, Math.min(16, finiteOr(page.devicePixelRatio, 1))),
      capturedAt: safeString(page.capturedAt, 100)
    },
    target: {
      tagName: target.tagName.toLowerCase(),
      selector: safeString(target.selector, LIMIT.selector),
      elementPath: safeString(target.elementPath, LIMIT.path),
      fullPath: safeString(target.fullPath, LIMIT.path),
      cssClasses: safeString(target.cssClasses, LIMIT.cssClasses),
      nearbyElements,
      selectedText: target.selectedText === null || target.selectedText === undefined ? null : safeString(target.selectedText, LIMIT.selectedText),
      isFixed: target.isFixed === true,
      reactComponents,
      sourceFile,
      textSnippet: safeString(target.textSnippet, LIMIT.text),
      htmlSnippet: sanitizeHtml(target.htmlSnippet, url),
      attributes: attributes(target.attributes, url),
      accessibility: {
        role: safeString(accessibility?.role, LIMIT.generic),
        accessibleName: safeString(accessibility?.accessibleName, LIMIT.generic),
        ariaLabel: safeString(accessibility?.ariaLabel, LIMIT.generic),
        ariaLabelledBy: safeString(accessibility?.ariaLabelledBy, LIMIT.generic)
      },
      rectViewport: rect(target.rectViewport),
      rectPage: rect(target.rectPage),
      computedStyles
    },
    nearbyText,
    ancestorPath,
    screenshot: screenshot(source?.screenshot)
  }
}

export function clampAnnotation(raw: unknown): DesignAnnotation {
  const source = object(raw)
  if (!source || typeof source.id !== 'string' || source.id === '' || typeof source.browserPageId !== 'string' || source.browserPageId === '') {
    throw new TypeError('browser design annotation requires an id and page id')
  }
  if (source.intent !== 'change' && source.intent !== 'question') throw new TypeError('browser design annotation has an invalid intent')
  if (typeof source.comment !== 'string') throw new TypeError('browser design annotation comment must be a string')
  const payload = clampPayload(source.payload)
  payload.screenshot = null
  return {
    id: safeString(source.id, 200),
    revision,
    browserPageId: safeString(source.browserPageId, 200),
    payload,
    intent: source.intent,
    comment: truncate(source.comment, LIMIT.comment)
}

export function clampAnnotations(raw: unknown): DesignAnnotation[] {
  if (!Array.isArray(raw)) throw new TypeError('browser design annotations must be an array')
  const counts = new Map<string, number>()
  const retained: unknown[] = []
  for (let index = raw.length - 1; index >= 0; index--) {
    const source = object(raw[index])
    const page = safeString(source?.browserPageId, 200)
    const count = counts.get(page) ?? 0
    if (count >= 20) continue
    counts.set(page, count + 1)
    retained.push(raw[index])
  }
  return retained.reverse().map(clampAnnotation)
}
