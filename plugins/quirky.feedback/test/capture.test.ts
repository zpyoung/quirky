import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureElement, cssEscape } from '../src/capture'
import { FeedbackStore } from '../src/store'

const SENTINEL = 'TERMINAL_SENTINEL_71c2'
const BUILD_KEYS = ['QUIRKY_BUILD_VERSION', 'QUIRKY_BUILD_COMMIT', 'QUIRKY_BUILD_CHANNEL'] as const
const savedBuild: Record<string, string | undefined> = {}

beforeAll(() => {
  GlobalRegistrator.register()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  for (const key of BUILD_KEYS) {
    savedBuild[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of BUILD_KEYS) {
    if (savedBuild[key] === undefined) delete process.env[key]
    else process.env[key] = savedBuild[key]
  }
  document.body.innerHTML = ''
})

function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body
}

function find(selector: string): Element {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`missing ${selector}`)
  return element
}

function capture(selector: string, includeReact = false) {
  return captureElement(find(selector), { includeReact })
}

test('owner comes from the nearest slot, overlay or tool panel marker', () => {
  mount(`
    <div data-plugin-slot="slot:quirky.git/status"><button id="a">A</button></div>
    <div data-plugin-overlay="overlay:acme.tools/palette"><button id="b">B</button></div>
    <div data-tool-panel="panel:quirky.git/changes"><span><button id="c">C</button></span></div>
    <div data-tool-panel="panel:quirky.git/changes"><div data-plugin-slot="slot:acme.tools/x"><button id="d">D</button></div></div>
    <button id="e">E</button>
  `)
  expect(capture('#a').owner).toBe('quirky.git')
  expect(capture('#b').owner).toBe('acme.tools')
  expect(capture('#c').owner).toBe('quirky.git')
  expect(capture('#d').owner).toBe('acme.tools')
  expect(capture('#e').owner).toBe('quirky')
})

test('an unparseable marker is skipped and the walk continues upward', () => {
  mount(`<div data-tool-panel="panel:quirky.git/changes"><div data-plugin-slot="garbage"><button id="a">A</button></div></div>`)
  expect(capture('#a').owner).toBe('quirky.git')
})

test('a terminal pane target resolves to the pane with no text fields', () => {
  mount(`<div data-terminal-pane="pane-1"><div class="terminal-pane-screen"><span id="inner">${SENTINEL}</span></div></div>`)
  const result = capture('#inner')
  expect(result.kind).toBe('terminal-pane')
  expect(result.selector).toBe('[data-terminal-pane="pane-1"]')
  expect(result.visibleText).toBeNull()
  expect(result.nearbyText).toBeNull()
  expect(result.attributes).toBeNull()
  expect(result.accessibleName).toBeNull()
  expect(JSON.stringify(result)).not.toContain(SENTINEL)
  expect(capture('[data-terminal-pane]').kind).toBe('terminal-pane')
})

test('a browser pane or its native host resolves to the enclosing pane', () => {
  mount(`
    <div class="qbp" data-browser-pane="b-1" aria-label="${SENTINEL}" title="${SENTINEL}">
      <div class="qbp-address"><input id="address" /></div>
      <div class="qbp-native-host" id="host"><span id="guest">${SENTINEL}</span></div>
    </div>
  `)
  for (const target of ['#host', '#guest', '.qbp']) {
    const result = capture(target)
    expect(result.kind).toBe('browser-pane')
    expect(result.selector).toBe('.qbp[data-browser-pane="b-1"]')
    expect(result.visibleText).toBeNull()
    expect(result.nearbyText).toBeNull()
    expect(result.attributes).toBeNull()
    expect(result.accessibleName).toBeNull()
    expect(JSON.stringify(result)).not.toContain(SENTINEL)
  }
  expect(capture('#address').kind).toBe('element')
})

test('terminal text is not read through a container that holds a terminal', () => {
  mount(`
    <section id="outer">
      Visible words
      <div data-terminal-pane="p"><div class="terminal-pane-screen">${SENTINEL}</div></div>
      <div class="terminal-pane-screen">${SENTINEL}</div>
      <div class="qbp-native-host">${SENTINEL}</div>
    </section>
  `)
  const result = capture('#outer')
  expect(result.kind).toBe('element')
  expect(result.visibleText).toBe('Visible words')
  expect(result.accessibleName).toBe('Visible words')
  expect(JSON.stringify(result)).not.toContain(SENTINEL)
})

test('terminal text is not read through a sibling used for nearby text', () => {
  mount(`
    <div>
      <p id="before">before</p>
      <button id="target">Go</button>
      <div id="next"><div data-terminal-pane="p"><div class="terminal-pane-screen">${SENTINEL}</div></div></div>
      <div class="terminal-pane-screen">${SENTINEL}</div>
    </div>
  `)
  const result = capture('#target')
  expect(result.nearbyText).toEqual(['before'])
  expect(JSON.stringify(result)).not.toContain(SENTINEL)
})

test('terminal text is not read through aria-labelledby', () => {
  mount(`
    <div data-terminal-pane="p"><div class="terminal-pane-screen" id="screen">${SENTINEL}</div></div>
    <div id="host-label" class="qbp-native-host">${SENTINEL}</div>
    <button id="target" aria-labelledby="screen host-label" title="fallback">Go</button>
  `)
  const result = capture('#target')
  expect(result.accessibleName).toBe('fallback')
  expect(JSON.stringify(result)).not.toContain(SENTINEL)
})

test('script, style and form values are never read', () => {
  mount(`<div id="t">Hello<script>SCRIPT_BODY</script><style>STYLE_BODY</style><noscript>NOSCRIPT_BODY</noscript><textarea>TEXTAREA_BODY</textarea><input value="INPUT_VALUE" /></div>`)
  const result = capture('#t')
  expect(result.visibleText).toBe('Hello')
  const input = capture('input')
  expect(input.attributes).not.toHaveProperty('value')
  expect(JSON.stringify(input)).not.toContain('INPUT_VALUE')
})

test('hidden and display none subtrees are not part of visible text or the accessible name', () => {
  mount(`<button id="target">Save<span hidden>OLD LABEL</span><span style="display:none">HIDDEN STATUS</span><span><b style="display:none">DEEP</b>Now</span></button>`)
  const result = capture('#target')
  expect(result.visibleText).toBe('Save Now')
  expect(result.accessibleName).toBe('Save Now')
})

test('text under visibility hidden or collapse is skipped unless a descendant is visible again', () => {
  mount(`<div id="t">Shown<div style="visibility:hidden">GONE<span style="visibility:visible">BACK</span></div><p style="visibility:collapse">COLLAPSED</p></div>`)
  expect(capture('#t').visibleText).toBe('Shown BACK')
})

test('nearby text skips hidden siblings', () => {
  mount(`<div><span style="display:none">HIDDEN SIBLING</span><button id="t">Go</button><span>Next</span></div>`)
  expect(capture('#t').nearbyText).toEqual(['Next'])
})

test('every capture passes the store validation', () => {
  mount(`<div data-plugin-slot="slot:acme.tools/x"><button id="t" class="save" aria-label="Go" data-quirky-source="a.tsx">Save<span hidden>x</span></button><a>link</a></div><div data-terminal-pane="p1"><span>T</span></div>`)
  const dir = mkdtempSync(join(tmpdir(), 'quirky-feedback-capture-'))
  try {
    const store = new FeedbackStore({ dataDir: dir, error: (_kind: string, message: string) => new Error(message) } as unknown as ConstructorParameters<typeof FeedbackStore>[0])
    for (const selector of ['#t', 'a', '[data-terminal-pane] span', 'body']) {
      const added = store.add({ intent: 'change', comment: 'check', capture: capture(selector, true) })
      expect(added.capture).toEqual(capture(selector, true))
    }
    expect(store.list().comments).toHaveLength(4)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('secrets are redacted in text, names and attributes', () => {
  mount(`
    <div>
      <button id="t" title="my password is x" aria-label="client_secret=abc" class="primary" name="ok">token csrf here</button>
      <a id="link" href="https://example.com/a?x=1#top">link</a>
      <a id="leak" href="https://example.com/a?access_token=1">leak</a>
    </div>
  `)
  const result = capture('#t')
  expect(result.visibleText).toBe('[redacted]')
  expect(result.accessibleName).toBe('[redacted]')
  expect(result.attributes).toEqual({ id: 't', title: '[redacted]', 'aria-label': '[redacted]', class: 'primary', name: 'ok' })
  expect(result.nearbyText).toEqual(['link', 'leak'])
  expect(JSON.stringify(result)).not.toContain('password is x')
  expect(capture('#link').attributes).toEqual({ id: 'link', href: 'https://example.com/a' })
  expect(capture('#leak').attributes).toEqual({ id: 'leak' })
})

test('url attributes drop credentials, query and fragment and are dropped on failure or secrets', () => {
  mount(`
    <img id="a" src="https://user:pw@example.com/p.png?x=1#frag" alt="pic" />
    <img id="b" src="" />
    <img id="c" src="https://example.com/session_id/p.png" />
    <img id="d" src="http://" />
    <img id="e" src="javascript:alert(1)" />
  `)
  expect(capture('#a').attributes).toEqual({ id: 'a', src: 'https://example.com/p.png', alt: 'pic' })
  expect(capture('#b').attributes).toEqual({ id: 'b' })
  expect(capture('#c').attributes).toEqual({ id: 'c' })
  expect(capture('#d').attributes).toEqual({ id: 'd' })
  expect(capture('#e').attributes).toEqual({ id: 'e' })
})

test('attributes are allowlisted and capped', () => {
  mount(`<div id="t" class="${'c'.repeat(300)}" title="${'t'.repeat(600)}" data-x="no" style="color:red" aria-pressed="true" onclick="x()"></div>`)
  const attributes = capture('#t').attributes!
  expect(Object.keys(attributes).sort()).toEqual(['aria-pressed', 'class', 'id', 'title'])
  expect(attributes.class!.length).toBe(200)
  expect(attributes.title!.length).toBe(500)
  expect(attributes.title!.endsWith(' (truncated)')).toBe(true)
})

test('text is capped at 200 and nearby text at 10 entries of 200', () => {
  const sibling = (index: number) => `<p>item${index} ${'z'.repeat(250)}</p>`
  const before = Array.from({ length: 15 }, (_, index) => sibling(index)).join('')
  const after = Array.from({ length: 15 }, (_, index) => sibling(index + 15)).join('')
  mount(`<div>${before}<button id="t">${'w'.repeat(500)}</button>${after}</div>`)
  const result = capture('#t')
  expect(result.visibleText!.length).toBe(200)
  expect(result.accessibleName!.length).toBe(200)
  expect(result.nearbyText).toHaveLength(10)
  for (const entry of result.nearbyText!) expect(entry.length).toBeLessThanOrEqual(200)
})

test('nearby text alternates previous and next siblings and skips empties', () => {
  mount(`<div><p>p2</p><p>p1</p><p></p><button id="t">x</button><p>n1</p><p>   </p><p>n2</p><p>n3</p></div>`)
  expect(capture('#t').nearbyText).toEqual(['p1', 'n1', 'p2', 'n2', 'n3'])
})

test('role and accessible name resolution order', () => {
  mount(`
    <span id="label">From label</span>
    <button id="a" role="switch" aria-label="Aria" aria-labelledby="label" alt="Alt" title="Title">Text</button>
    <button id="b" aria-labelledby="label missing" alt="Alt" title="Title">Text</button>
    <img id="c" alt="Alt" title="Title" />
    <button id="d" title="Title">Text</button>
    <button id="e">Text</button>
    <div id="f"></div>
  `)
  expect(capture('#a').role).toBe('switch')
  expect(capture('#a').accessibleName).toBe('Aria')
  expect(capture('#b').role).toBeNull()
  expect(capture('#b').accessibleName).toBe('From label')
  expect(capture('#c').accessibleName).toBe('Alt')
  expect(capture('#d').accessibleName).toBe('Title')
  expect(capture('#e').accessibleName).toBe('Text')
  expect(capture('#f').accessibleName).toBeNull()
  expect(capture('#f').visibleText).toBeNull()
})

test('element path has up to six levels, no text, and skips secret parts', () => {
  mount(`<div id="l1"><div id="l2"><div id="l3"><div id="l4"><div id="l5"><div class="l6"><span id="session_id_x" class="csrf-token">hello</span></div></div></div></div></div></div>`)
  const result = capture('#session_id_x')
  expect(result.elementPath).toBe('div#l2 > div#l3 > div#l4 > div#l5 > div.l6 > span')
  expect(result.elementPath.split(' > ')).toHaveLength(6)
  expect(result.elementPath.endsWith(' > span')).toBe(true)
  expect(result.elementPath).not.toContain('hello')
  expect(result.elementPath).not.toContain('session')
  expect(result.elementPath).not.toContain('csrf')
})

test('element path is capped at 900 characters', () => {
  const longId = 'x'.repeat(400)
  mount(`<div id="${longId}"><div id="${longId}2"><div id="${longId}3"><button id="t"></button></div></div></div>`)
  expect(capture('#t').elementPath.length).toBeLessThanOrEqual(900)
})

test('selector skips a secret id rather than redacting it, and still re-queries', () => {
  mount(`<main><section id="sessionid-42"><button id="t" class="save-btn">Go</button></section><section><button class="save-btn">Other</button></section></main>`)
  const result = capture('#t')
  expect(result.selector).not.toContain('sessionid')
  expect(result.selector).not.toContain('redacted')
  expect(document.querySelectorAll(result.selector)).toHaveLength(1)
  expect(document.querySelector(result.selector)).toBe(find('#t'))
})

test('selector is unique even for identical siblings', () => {
  mount(`<ul><li><span>same</span></li><li><span>same</span></li><li><span>same</span></li></ul>`)
  for (const element of Array.from(document.querySelectorAll('span'))) {
    const result = captureElement(element, { includeReact: false })
    expect(result.selector).not.toBe('')
    const matches = document.querySelectorAll(result.selector)
    expect(matches).toHaveLength(1)
    expect(matches[0]).toBe(element)
  }
})

test('selector prefers a unique id and escapes special characters', () => {
  mount(`<div><button id="a:b.c">x</button></div>`)
  const result = capture('button')
  expect(document.querySelector(result.selector)).toBe(find('button'))
  expect(result.selector).toContain('#a')
})

test('a selector over 700 characters is stored empty rather than truncated', () => {
  function level(depth: number): string {
    const letter = 'abcdefg'[depth]!
    const cls = `class="${letter.repeat(60)} ${'m'.repeat(59)}${letter}"`
    const inner = depth === 0 ? '<span id="deep"></span><span></span>' : level(depth - 1)
    return depth === 6 ? `<div ${cls}>${inner}</div>` : `<div ${cls}>${inner}</div><div ${cls}>${inner}</div>`
  }
  mount(level(6))
  expect(capture('#deep').selector).toBe('')
})

test('source and source caller', () => {
  mount(`
    <div data-quirky-source="plugins/quirky.git/src/Panel.tsx:10">
      <div data-quirky-source="packages/ui/src/design-system/Button.tsx:5">
        <span data-quirky-source="packages/ui/src/design-system/Icon.tsx:9"><i id="a"></i></span>
      </div>
    </div>
    <div data-quirky-source="plugins/quirky.git/src/Row.tsx:3"><b id="b"></b></div>
    <p id="c"></p>
    <div data-quirky-source="packages/ui/src/design-system/Only.tsx:1"><b id="d"></b></div>
  `)
  const nested = capture('#a')
  expect(nested.source).toBe('packages/ui/src/design-system/Icon.tsx:9')
  expect(nested.sourceCaller).toBe('plugins/quirky.git/src/Panel.tsx:10')
  const plain = capture('#b')
  expect(plain.source).toBe('plugins/quirky.git/src/Row.tsx:3')
  expect(plain.sourceCaller).toBeNull()
  expect(capture('#c').source).toBeNull()
  expect(capture('#c').sourceCaller).toBeNull()
  const orphan = capture('#d')
  expect(orphan.source).toBe('packages/ui/src/design-system/Only.tsx:1')
  expect(orphan.sourceCaller).toBeNull()
})

test('component is read only when includeReact is true', () => {
  mount(`<div><button id="t">x</button></div>`)
  const button = find('#t')
  function Save() { return null }
  const Anonymous = (() => () => null)()
  const fiber = { type: 'button', return: { type: 'div', return: { type: Save, return: null } } }
  Reflect.set(button, '__reactFiber$abc123', fiber)
  expect(captureElement(button, { includeReact: false }).component).toBeNull()
  expect(captureElement(button, { includeReact: true }).component).toBe('Save')
  Reflect.set(button, '__reactFiber$abc123', { type: 'button', return: { type: Object.assign(Anonymous, { displayName: 'Shown' }), return: null } })
  expect(captureElement(button, { includeReact: true }).component).toBe('Shown')
  Reflect.set(button, '__reactFiber$abc123', { type: 'button', return: null })
  expect(captureElement(button, { includeReact: true }).component).toBeNull()
  const hostile = {}
  Object.defineProperty(hostile, 'return', { get() { throw new Error('boom') } })
  Reflect.set(button, '__reactFiber$abc123', hostile)
  expect(captureElement(button, { includeReact: true }).component).toBeNull()
  expect(captureElement(find('div'), { includeReact: true }).component).toBeNull()
})

test('build falls back to unknown and reads stamped environment values', () => {
  mount(`<button id="t">x</button>`)
  expect(capture('#t').build).toEqual({ version: 'unknown', commit: 'unknown', channel: 'unknown' })
  process.env.QUIRKY_BUILD_VERSION = '9.9.9'
  process.env.QUIRKY_BUILD_COMMIT = 'deadbee'
  process.env.QUIRKY_BUILD_CHANNEL = 'dev'
  expect(capture('#t').build).toEqual({ version: '9.9.9', commit: 'deadbee', channel: 'dev' })
})

test('rect values are finite and computed styles are strings', () => {
  mount(`<div id="t" style="display:flex">x</div>`)
  const element = find('#t')
  Object.defineProperty(element, 'getBoundingClientRect', {
    value: () => ({ x: Number.NaN, y: 4, width: Number.POSITIVE_INFINITY, height: 6 })
  })
  const result = captureElement(element, { includeReact: false })
  expect(result.rect).toEqual({ x: 0, y: 4, width: 0, height: 6 })
  for (const value of Object.values(result.computedStyles)) expect(typeof value).toBe('string')
  expect(result.computedStyles.display).toBe('flex')
})

test('failures in one field do not throw', () => {
  mount(`<div id="t">x</div>`)
  const element = find('#t')
  Object.defineProperty(element, 'getBoundingClientRect', { value: () => { throw new Error('nope') } })
  const original = window.getComputedStyle
  Reflect.set(window, 'getComputedStyle', () => { throw new Error('nope') })
  Reflect.set(globalThis, 'getComputedStyle', () => { throw new Error('nope') })
  try {
    const result = captureElement(element, { includeReact: true })
    expect(result.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 })
    expect(result.computedStyles).toEqual({})
    expect(result.visibleText).toBe('x')
  } finally {
    Reflect.set(window, 'getComputedStyle', original)
    Reflect.set(globalThis, 'getComputedStyle', original)
  }
})

test('cssEscape matches the CSS.escape algorithm without relying on CSS', () => {
  expect(cssEscape('a b')).toBe('a\\ b')
  expect(cssEscape('1abc')).toBe('\\31 abc')
  expect(cssEscape('-1')).toBe('-\\31 ')
  expect(cssEscape('-')).toBe('\\-')
  expect(cssEscape('a:b.c')).toBe('a\\:b\\.c')
  expect(cssEscape('a\u0000b')).toBe('a�b')
  expect(cssEscape('é_-x')).toBe('é_-x')
  expect(cssEscape('a\nb')).toBe('a\\a b')
})
