import { parseContributionId } from '@quirky/protocol'
import type { Capture, CaptureKind } from './contract'

const LIMIT = {
  text: 200,
  nearbyText: 200,
  nearbyTextEntries: 10,
  selector: 700,
  path: 900,
  classAttribute: 200,
  attribute: 500,
  computedStyle: 500,
  walkedText: 4096
} as const

const SELECTOR_LEVELS = 10
const PATH_LEVELS = 6
const WALK_DEPTH = 64
const SIBLING_SCAN = 50

const SECRET_MARKER_PATTERN = /access_token|auth_token|api_key|apikey|client_secret|oauth_state|x-amz-|session_id|sessionid|csrf|secret|password|passwd/i
const HTML_ATTRIBUTES: Readonly<Record<string, true>> = {
  id: true, class: true, name: true, type: true, role: true, href: true, src: true, alt: true, title: true, placeholder: true, for: true, action: true, method: true
}
const URL_ATTRIBUTES: Readonly<Record<string, true>> = { href: true, src: true, action: true }
const COMPUTED_STYLE_NAMES = [
  'display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'backgroundColor', 'border', 'borderRadius',
  'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'textAlign', 'zIndex'
]

const OWNER_ATTRIBUTES = ['data-plugin-slot', 'data-plugin-overlay', 'data-tool-panel'] as const
const TERMINAL_PANE = '[data-terminal-pane]'
const BROWSER_PANE = '.qbp[data-browser-pane]'
const BLOCKED_TEXT = '[data-terminal-pane], .terminal-pane-screen, .qbp-native-host'
const SKIPPED_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'noscript', 'textarea', 'select'])
const DESIGN_SYSTEM_SOURCE = 'packages/ui/src/design-system/'

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

function safeString(value: string, max: number): string {
  return hasSecret(value) ? '[redacted]' : truncate(value, max)
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function safely<T>(read: () => T, fallback: T): T {
  try { return read() } catch { return fallback }
}

/** Escapes an identifier for use in a CSS selector; follows the CSSOM `CSS.escape` algorithm. */
export function cssEscape(value: string): string {
  const native = (globalThis as { CSS?: { escape?: (input: string) => string } }).CSS?.escape
  if (typeof native === 'function') return native.call((globalThis as { CSS?: unknown }).CSS, value)
  let result = ''
  const length = value.length
  for (let index = 0; index < length; index++) {
    const code = value.charCodeAt(index)
    const char = value.charAt(index)
    if (code === 0) result += '�'
    else if ((code >= 0x1 && code <= 0x1f) || code === 0x7f) result += `\\${code.toString(16)} `
    else if (index === 0 && code >= 0x30 && code <= 0x39) result += `\\${code.toString(16)} `
    else if (index === 1 && code >= 0x30 && code <= 0x39 && value.charCodeAt(0) === 0x2d) result += `\\${code.toString(16)} `
    else if (index === 0 && length === 1 && code === 0x2d) result += `\\${char}`
    else if (code >= 0x80 || code === 0x2d || code === 0x5f || (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) result += char
    else result += `\\${char}`
  }
  return result
}

/** The text a user can read inside `root`, never entering terminal or native-host content or reading form values. */
function walkText(root: Element): string {
  if (root.closest(BLOCKED_TEXT) !== null || SKIPPED_TAGS.has(root.localName)) return ''
  const parts: string[] = []
  let length = 0
  const visit = (parent: Node, depth: number): void => {
    if (depth > WALK_DEPTH) return
    for (const child of Array.from(parent.childNodes)) {
      if (length >= LIMIT.walkedText) return
      if (child.nodeType === 3) {
        const text = child.nodeValue ?? ''
        parts.push(text)
        length += text.length
      } else if (child.nodeType === 1) {
        const element = child as Element
        if (SKIPPED_TAGS.has(element.localName) || element.matches(BLOCKED_TEXT)) continue
        visit(element, depth + 1)
      }
    }
  }
  visit(root, 0)
  return collapseWhitespace(parts.join(' '))
}

function textField(value: string, max: number): string | null {
  const text = collapseWhitespace(value)
  return text === '' ? null : safeString(text, max)
}

function sanitizedUrl(value: string, base: string): string | null {
  if (value === '' || hasSecret(value)) return null
  if (value === 'about:blank') return value
  let url: URL
  try { url = new URL(value, base) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'file:') return null
  url.username = ''
  url.password = ''
  url.search = ''
  url.hash = ''
  return hasSecret(url.href) ? 'about:blank' : url.href
}

function allowedAttribute(name: string): boolean {
  return Object.hasOwn(HTML_ATTRIBUTES, name) || /^aria-[a-z0-9_-]+$/.test(name)
}

function readAttributes(element: Element): Record<string, string> {
  const result: Record<string, string> = {}
  const base = element.ownerDocument.baseURI
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase()
    if (!allowedAttribute(name)) continue
    if (Object.hasOwn(URL_ATTRIBUTES, name)) {
      const clean = sanitizedUrl(attribute.value, base)
      if (clean !== null) result[name] = clean
    } else {
      result[name] = safeString(attribute.value, name === 'class' ? LIMIT.classAttribute : LIMIT.attribute)
    }
  }
  return result
}

function ownerOf(element: Element): string {
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    for (const name of OWNER_ATTRIBUTES) {
      const value = node.getAttribute(name)
      const namespace = value === null ? undefined : parseContributionId(value)?.namespace
      if (namespace !== undefined) return namespace
    }
  }
  return 'quirky'
}

function resolveTarget(element: Element): { target: Element; kind: CaptureKind } {
  const terminal = element.closest(TERMINAL_PANE)
  if (terminal !== null) return { target: terminal, kind: 'terminal-pane' }
  if (element.matches(BROWSER_PANE) || element.closest('.qbp-native-host') !== null) {
    const browser = element.closest(BROWSER_PANE)
    if (browser !== null) return { target: browser, kind: 'browser-pane' }
  }
  return { target: element, kind: 'element' }
}

function stableToken(token: string): boolean {
  return token !== '' && !hasSecret(token)
}

function stableClass(token: string): boolean {
  return stableToken(token) && token.length <= 64 && /^[A-Za-z_][\w-]*$/.test(token) && !/\d{3,}/.test(token)
}

function classTokens(element: Element): string[] {
  const raw = element.getAttribute('class') ?? ''
  return raw.split(/\s+/).filter(stableClass)
}

function sameTagSiblingIndex(element: Element): { index: number; count: number } {
  const parent = element.parentElement
  if (parent === null) return { index: 1, count: 1 }
  let index = 0
  let count = 0
  for (const child of Array.from(parent.children)) {
    if (child.localName !== element.localName) continue
    count++
    if (child === element) index = count
  }
  return { index, count }
}

function matchesOnly(selector: string, element: Element): boolean {
  try {
    const found = element.ownerDocument.querySelectorAll(selector)
    return found.length === 1 && found[0] === element
  } catch { return false }
}

function buildSelector(element: Element): string {
  const document = element.ownerDocument
  const parts: string[] = []
  let node: Element | null = element
  for (let level = 0; node !== null && level < SELECTOR_LEVELS; level++, node = node.parentElement) {
    const tag = cssEscape(node.localName)
    const id = node.getAttribute('id') ?? ''
    const idUsable = stableToken(id)
    const base = idUsable
      ? `${tag}#${cssEscape(id)}`
      : `${tag}${classTokens(node).slice(0, 2).map((token) => `.${cssEscape(token)}`).join('')}`
    const bare = [base, ...parts].join(' > ')
    if (matchesOnly(bare, element)) return bare.length > LIMIT.selector ? '' : bare
    const idUnique = idUsable && safely(() => document.querySelectorAll(`#${cssEscape(id)}`).length === 1, false)
    const { index, count } = sameTagSiblingIndex(node)
    parts.unshift(count > 1 && !idUnique ? `${base}:nth-of-type(${index})` : base)
    const exact = parts.join(' > ')
    if (matchesOnly(exact, element)) return exact.length > LIMIT.selector ? '' : exact
  }
  return ''
}

function buildPath(element: Element): string {
  const parts: string[] = []
  for (let node: Element | null = element; node !== null && parts.length < PATH_LEVELS; node = node.parentElement) {
    const id = node.getAttribute('id') ?? ''
    const tag = cssEscape(node.localName)
    if (stableToken(id)) parts.unshift(`${tag}#${cssEscape(id)}`)
    else {
      const first = classTokens(node)[0]
      parts.unshift(first === undefined ? tag : `${tag}.${cssEscape(first)}`)
    }
  }
  while (parts.length > 1 && parts.join(' > ').length > LIMIT.path) parts.shift()
  return parts.join(' > ').slice(0, LIMIT.path)
}

function paneSelector(element: Element, kind: CaptureKind): string {
  const attribute = kind === 'terminal-pane' ? 'data-terminal-pane' : 'data-browser-pane'
  const id = element.getAttribute(attribute) ?? ''
  if (hasSecret(id)) return ''
  const prefix = kind === 'terminal-pane' ? '' : '.qbp'
  const selector = `${prefix}[${attribute}="${cssEscape(id)}"]`
  return matchesOnly(selector, element) && selector.length <= LIMIT.selector ? selector : ''
}

function accessibleNameOf(element: Element): string | null {
  const label = textField(element.getAttribute('aria-label') ?? '', LIMIT.text)
  if (label !== null) return label
  const labelledBy = element.getAttribute('aria-labelledby')
  if (labelledBy !== null) {
    const referenced = labelledBy.split(/\s+/)
      .map((id) => (id === '' ? null : element.ownerDocument.getElementById(id)))
      .map((target) => (target === null ? '' : walkText(target)))
      .join(' ')
    const name = textField(referenced, LIMIT.text)
    if (name !== null) return name
  }
  return textField(element.getAttribute('alt') ?? '', LIMIT.text)
    ?? textField(element.getAttribute('title') ?? '', LIMIT.text)
    ?? textField(walkText(element), LIMIT.text)
}

function nearbyTextOf(element: Element): string[] {
  const walk = (start: Element | null, step: (from: Element) => Element | null) => {
    let node = start
    let scanned = 0
    return (): string | null => {
      while (node !== null && scanned < SIBLING_SCAN) {
        const current: Element = node
        node = step(current)
        scanned++
        const text = textField(walkText(current), LIMIT.nearbyText)
        if (text !== null) return text
      }
      return null
    }
  }
  const sides = [
    walk(element.previousElementSibling, (from) => from.previousElementSibling),
    walk(element.nextElementSibling, (from) => from.nextElementSibling)
  ]
  const entries: string[] = []
  const exhausted = [false, false]
  for (let turn = 0; entries.length < LIMIT.nearbyTextEntries && !(exhausted[0] && exhausted[1]); turn++) {
    const side = turn % 2
    if (exhausted[side]) continue
    const text = sides[side]!()
    if (text === null) exhausted[side] = true
    else entries.push(text)
  }
  return entries
}

function rectOf(element: Element): Capture['rect'] {
  const rect = element.getBoundingClientRect()
  const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  return { x: finite(rect.x), y: finite(rect.y), width: finite(rect.width), height: finite(rect.height) }
}

function computedStylesOf(element: Element): Record<string, string> {
  const result: Record<string, string> = {}
  const style = getComputedStyle(element) as unknown as Record<string, unknown>
  for (const name of COMPUTED_STYLE_NAMES) {
    const value = style[name]
    if (typeof value === 'string' && value !== '') result[name] = safeString(value, LIMIT.computedStyle)
  }
  return result
}

function sourceAttribute(element: Element): string {
  return element.getAttribute('data-quirky-source') ?? ''
}

function sourceOf(element: Element): { source: string | null; sourceCaller: string | null } {
  let node: Element | null = element
  while (node !== null && sourceAttribute(node) === '') node = node.parentElement
  if (node === null) return { source: null, sourceCaller: null }
  const source = sourceAttribute(node)
  let sourceCaller: string | null = null
  if (source.startsWith(DESIGN_SYSTEM_SOURCE)) {
    for (let caller = node.parentElement; caller !== null; caller = caller.parentElement) {
      const value = sourceAttribute(caller)
      if (value !== '' && !value.startsWith(DESIGN_SYSTEM_SOURCE)) {
        sourceCaller = safeString(value, LIMIT.attribute)
        break
      }
    }
  }
  return { source: safeString(source, LIMIT.attribute), sourceCaller }
}

function componentOf(element: Element): string | null {
  const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'))
  if (key === undefined) return null
  let fiber = Reflect.get(element, key) as { type?: unknown; return?: unknown } | null | undefined
  for (let steps = 0; fiber !== null && fiber !== undefined && steps < 1000; steps++) {
    const type = fiber.type
    if (typeof type === 'function') {
      const named = (type as { displayName?: unknown }).displayName
      const name = typeof named === 'string' && named !== '' ? named : type.name
      if (name !== '') return safeString(name, LIMIT.text)
    }
    fiber = fiber.return as typeof fiber
  }
  return null
}

function stamped(read: () => string | undefined): string {
  try {
    const value = read()
    return typeof value === 'string' && value !== '' ? value : 'unknown'
  } catch { return 'unknown' }
}

function buildInfo(): Capture['build'] {
  return {
    version: stamped(() => process.env.QUIRKY_BUILD_VERSION),
    commit: stamped(() => process.env.QUIRKY_BUILD_COMMIT),
    channel: stamped(() => process.env.QUIRKY_BUILD_CHANNEL)
  }
}

/**
 * Snapshots what a user sees at `element`, with secrets redacted and no terminal or browser-pane text.
 * Requires an element connected to the host document; never throws for one.
 * `includeReact` enables reading the React component name from the element's fiber.
 */
export function captureElement(element: Element, options: { includeReact: boolean }): Capture {
  const resolved = safely(() => resolveTarget(element), { target: element, kind: 'element' as CaptureKind })
  const target = resolved.target
  const pane = resolved.kind !== 'element'
  const { source, sourceCaller } = safely(() => sourceOf(target), { source: null, sourceCaller: null })
  return {
    kind: resolved.kind,
    owner: safely(() => ownerOf(target), 'quirky'),
    elementPath: safely(() => buildPath(target), ''),
    selector: safely(() => (pane ? paneSelector(target, resolved.kind) : buildSelector(target)), ''),
    role: safely(() => textField(target.getAttribute('role') ?? '', LIMIT.text), null),
    accessibleName: pane ? null : safely(() => accessibleNameOf(target), null),
    visibleText: pane ? null : safely(() => textField(walkText(target), LIMIT.text), null),
    nearbyText: pane ? null : safely(() => nearbyTextOf(target), []),
    attributes: pane ? null : safely(() => readAttributes(target), {}),
    rect: safely(() => rectOf(target), { x: 0, y: 0, width: 0, height: 0 }),
    computedStyles: safely(() => computedStylesOf(target), {}),
    component: options.includeReact ? safely(() => componentOf(target), null) : null,
    source,
    sourceCaller,
    build: buildInfo()
  }
}
