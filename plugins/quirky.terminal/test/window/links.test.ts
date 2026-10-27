import { describe, expect, test } from 'bun:test'
import { decideLinkClick, describeTarget, findPathCandidates, resolveAgainst } from '../../src/window/pane/links'

const texts = (line: string) => findPathCandidates(line).map((match) => match.text)

describe('findPathCandidates', () => {
  test('SC-40: finds a relative path with line and column', () => {
    const [match] = findPathCandidates('error at src/app.ts:12:4 here')
    expect(match).toEqual({ start: 9, end: 24, text: 'src/app.ts:12:4', path: 'src/app.ts', line: 12, column: 4 })
  })

  test('finds absolute, dot-relative and bare file names', () => {
    expect(texts('/tmp/w/api/src/app.ts ./run.sh ../x/y.md main.go:7')).toEqual(['/tmp/w/api/src/app.ts', './run.sh', '../x/y.md', 'main.go:7'])
  })

  test('a line number without a column leaves the column null', () => {
    const [match] = findPathCandidates('src/a.ts:3')
    expect(match).toMatchObject({ path: 'src/a.ts', line: 3, column: null })
  })

  test('trims trailing punctuation and wrapping brackets', () => {
    expect(texts('see (src/a.ts), then "src/b.ts". Also src/c.ts:9:1: failed')).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts:9:1'])
  })

  test('keeps framework route directories whole', () => {
    expect(texts('app/shop/[id]/page.tsx')).toEqual(['app/shop/[id]/page.tsx'])
  })

  test('skips URLs, emails, versions, numbers and plain words', () => {
    expect(texts('https://example.com/x/y.html user@example.com v1.2 3.14 hello world')).toEqual([])
  })

  test('skips the path part of a URL but still finds a path after it', () => {
    expect(texts('GET http://localhost:3000/api/x then /tmp/out.log')).toEqual(['/tmp/out.log'])
  })

  test('finds nothing in a line without candidates', () => {
    expect(findPathCandidates('')).toEqual([])
    expect(findPathCandidates('   ')).toEqual([])
  })

  test('caps the candidates per line', () => {
    const line = Array.from({ length: 200 }, (_, index) => `a/b${index}.ts`).join(' ')
    expect(findPathCandidates(line).length).toBe(50)
  })
})

describe('resolveAgainst', () => {
  test('SC-40: joins a relative path onto the pane directory', () => {
    expect(resolveAgainst('src/app.ts', '/tmp/w/api')).toBe('/tmp/w/api/src/app.ts')
    expect(resolveAgainst('./src/../lib/x.ts', '/tmp/w/api/')).toBe('/tmp/w/api/lib/x.ts')
    expect(resolveAgainst('../x', '/tmp/w/api')).toBe('/tmp/w/x')
  })

  test('keeps an absolute path and normalizes it', () => {
    expect(resolveAgainst('/a//b/./c', '/tmp')).toBe('/a/b/c')
  })

  test('a relative path with no pane directory cannot be resolved', () => {
    expect(resolveAgainst('src/a.ts', '')).toBeNull()
    expect(resolveAgainst('../../../x', '/a')).toBe('/x')
  })
})

describe('describeTarget', () => {
  test('names the file with its position', () => {
    expect(describeTarget('/tmp/w/api/src/app.ts', 12, 4)).toBe('/tmp/w/api/src/app.ts:12:4')
    expect(describeTarget('/tmp/a', 3, null)).toBe('/tmp/a:3')
    expect(describeTarget('/tmp/a', null, null)).toBe('/tmp/a')
  })
})

describe('decideLinkClick', () => {
  const click = (init: { button?: number; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean } = {}) => ({
    button: 0,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    ...init
  })
  const settings = { 'link-click': 'actions', 'link-middle-click': 'open' } as const

  test('SC-41: a plain click shows the popover under Actions', () => {
    expect(decideLinkClick('url', click(), settings)).toBe('popover')
    expect(decideLinkClick('path', click(), settings)).toBe('popover')
  })

  test('SC-41: Cmd-click opens and Shift-Cmd-click copies a URL or reveals a path', () => {
    expect(decideLinkClick('url', click({ metaKey: true }), settings)).toBe('open')
    expect(decideLinkClick('path', click({ metaKey: true }), settings)).toBe('open')
    expect(decideLinkClick('url', click({ metaKey: true, shiftKey: true }), settings)).toBe('copy')
    expect(decideLinkClick('path', click({ metaKey: true, shiftKey: true }), settings)).toBe('reveal')
  })

  test('SC-41: a middle click follows its own setting', () => {
    expect(decideLinkClick('url', click({ button: 1 }), settings)).toBe('open')
    expect(decideLinkClick('url', click({ button: 1 }), { ...settings, 'link-middle-click': 'actions' })).toBe('popover')
    expect(decideLinkClick('url', click({ button: 1 }), { ...settings, 'link-middle-click': 'terminal' })).toBe('none')
  })

  test('SC-41: Option-click and other buttons do nothing', () => {
    expect(decideLinkClick('url', click({ altKey: true }), settings)).toBe('none')
    expect(decideLinkClick('url', click({ altKey: true, metaKey: true }), settings)).toBe('none')
    expect(decideLinkClick('url', click({ button: 2 }), settings)).toBe('none')
    expect(decideLinkClick('url', click({ ctrlKey: true }), settings)).toBe('none')
    expect(decideLinkClick('url', click({ shiftKey: true }), settings)).toBe('none')
  })

  test('SC-41: the plain click setting Open opens and Leave to terminal does nothing', () => {
    expect(decideLinkClick('path', click(), { ...settings, 'link-click': 'open' })).toBe('open')
    expect(decideLinkClick('path', click(), { ...settings, 'link-click': 'terminal' })).toBe('none')
    expect(decideLinkClick('path', click({ metaKey: true }), { ...settings, 'link-click': 'terminal' })).toBe('open')
  })
})
