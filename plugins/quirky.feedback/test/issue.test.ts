import { expect, test } from 'bun:test'
import type { Capture, Comment } from '../src/contract'
import { buildIssueDrafts, builtinRepository } from '../src/issue'

const URL_CAP = 7500
const REPO = 'https://github.com/zpyoung/quirky'

function capture(overrides: Partial<Capture> = {}): Capture {
  return {
    kind: 'element',
    owner: 'quirky',
    elementPath: 'main > button.save',
    selector: 'main > button.save',
    role: null,
    accessibleName: null,
    visibleText: null,
    nearbyText: null,
    attributes: null,
    rect: { x: 1, y: 2, width: 3, height: 4 },
    computedStyles: {},
    component: null,
    source: null,
    sourceCaller: null,
    build: { version: '1.2.3', commit: 'abc123', channel: 'dev' },
    ...overrides
  }
}

function comment(id: string, text: string, overrides: Partial<Capture> = {}, intent: Comment['intent'] = 'change'): Comment {
  return { id, createdAt: 1, intent, comment: text, capture: capture(overrides) }
}

function bodyOf(url: string): string {
  return new URL(url).searchParams.get('body') ?? ''
}

function titleOf(url: string): string {
  return new URL(url).searchParams.get('title') ?? ''
}

test('builtinRepository owns quirky and quirky.* ids only', () => {
  expect(builtinRepository('quirky')).toBe(REPO)
  expect(builtinRepository('quirky.git')).toBe(REPO)
  expect(builtinRepository('quirkyx')).toBeNull()
  expect(builtinRepository('acme.tools')).toBeNull()
  expect(builtinRepository('')).toBeNull()
})

test('draft bodies carry only the permitted fields and exclude on-screen data', () => {
  const sentinel = (name: string) => `SENTINEL_${name}_9f3a`
  const sentinels = ['selector', 'visible', 'nearby', 'attr', 'name', 'role', 'style']
  const subject = comment('1', 'make the button blue', {
    owner: 'quirky.git',
    elementPath: 'main > button.save',
    component: 'SaveButton',
    source: 'plugins/quirky.git/src/Save.tsx',
    sourceCaller: 'plugins/quirky.git/src/Panel.tsx',
    selector: sentinel('selector'),
    visibleText: sentinel('visible'),
    nearbyText: [sentinel('nearby')],
    attributes: { title: sentinel('attr') },
    accessibleName: sentinel('name'),
    role: sentinel('role'),
    computedStyles: { color: sentinel('style') },
    rect: { x: 777.5, y: 888.5, width: 11, height: 22 }
  })
  const { drafts } = buildIssueDrafts([subject], builtinRepository)
  expect(drafts).toHaveLength(1)
  const decoded = decodeURIComponent(drafts[0]!.url)
  for (const name of sentinels) expect(decoded).not.toContain(sentinel(name))
  expect(decoded).not.toContain('777.5')
  const body = bodyOf(drafts[0]!.url)
  expect(body).toContain('make the button blue')
  expect(body).toContain('quirky.git')
  expect(body).toContain('main > button.save')
  expect(body).toContain('SaveButton')
  expect(body).toContain('plugins/quirky.git/src/Save.tsx')
  expect(body).toContain('plugins/quirky.git/src/Panel.tsx')
  expect(body).toContain('1.2.3')
  expect(body).toContain('abc123')
  expect(body).toContain('dev')
  expect(body).toContain('change')
})

test('routes by repository across built-in, third-party and unrouted owners', () => {
  const repositoryOf = (owner: string) => {
    if (owner === 'acme.tools') return 'https://github.com/acme/tools'
    if (owner === 'mystery') return null
    return builtinRepository(owner)
  }
  const comments = [
    comment('1', 'one', { owner: 'quirky.git' }),
    comment('2', 'two', { owner: 'acme.tools' }),
    comment('3', 'three', { owner: 'mystery' }),
    comment('4', 'four', { owner: 'quirky' }),
    comment('5', 'five', { owner: 'acme.tools' })
  ]
  const { drafts, unrouted } = buildIssueDrafts(comments, repositoryOf)
  expect(drafts.map((draft) => draft.repository)).toEqual([REPO, 'https://github.com/acme/tools'])
  expect(drafts.map((draft) => [draft.included, draft.remaining])).toEqual([[2, 0], [2, 0]])
  expect(unrouted.map((entry) => entry.id)).toEqual(['3'])
  expect(drafts[0]!.url.startsWith(`${REPO}/issues/new?title=`)).toBe(true)
  expect(titleOf(drafts[0]!.url)).toBe('UI feedback: 2 comments')
  const first = bodyOf(drafts[0]!.url)
  expect(first.indexOf('one')).toBeLessThan(first.indexOf('four'))
  expect(first).not.toContain('two')
})

test('the title names the owner when the draft has a single owner', () => {
  const { drafts } = buildIssueDrafts([comment('1', 'a', { owner: 'quirky.git' }), comment('2', 'b', { owner: 'quirky.git' })], builtinRepository)
  expect(titleOf(drafts[0]!.url)).toBe('UI feedback: quirky.git')
})

test('repository values are re-validated and invalid ones leave the comment unrouted', () => {
  const bad = [
    'http://github.com/a/b',
    'https://github.com/a/b/',
    'https://github.com/a/b/issues',
    'https://github.com/a',
    'https://github.com/./b',
    'https://github.com/a/..',
    'https://github.com/a/b?x=1',
    'https://evil.example/a/b',
    'https://github.com/a/b c',
    `https://github.com/a/${'x'.repeat(500)}`,
    ''
  ]
  for (const value of bad) {
    const { drafts, unrouted } = buildIssueDrafts([comment('1', 'x')], () => value)
    expect(drafts).toEqual([])
    expect(unrouted.map((entry) => entry.id)).toEqual(['1'])
  }
  const thrown = buildIssueDrafts([comment('1', 'x')], () => { throw new Error('boom') })
  expect(thrown.unrouted).toHaveLength(1)
  const ok = buildIssueDrafts([comment('1', 'x')], () => 'https://github.com/a_b/c.d-e')
  expect(ok.drafts).toHaveLength(1)
})

test('the 7500 character cap includes whole comments in order and reports the rest', () => {
  const comments = Array.from({ length: 20 }, (_, index) => comment(String(index), `MARK${index}X ${'word '.repeat(60)}`))
  const { drafts, unrouted } = buildIssueDrafts(comments, builtinRepository)
  expect(unrouted).toEqual([])
  expect(drafts).toHaveLength(1)
  const draft = drafts[0]!
  expect(draft.url.length).toBeLessThanOrEqual(URL_CAP)
  expect(draft.included).toBeGreaterThan(0)
  expect(draft.included).toBeLessThan(20)
  expect(draft.included + draft.remaining).toBe(20)
  const body = bodyOf(draft.url)
  expect(body).toContain(`MARK${draft.included - 1}X `)
  expect(body).not.toContain(`MARK${draft.included}X `)
  expect(body).not.toContain('(truncated)')
  const next = buildIssueDrafts(comments.slice(0, draft.included + 1), builtinRepository).drafts[0]!
  expect(next.included).toBe(draft.included)
  expect(next.remaining).toBe(1)
})

test('a single oversized comment is truncated with a visible marker and stays within the cap', () => {
  const huge = comment('1', 'x'.repeat(40_000))
  const { drafts } = buildIssueDrafts([huge, comment('2', 'second')], builtinRepository)
  const draft = drafts[0]!
  expect(draft.included).toBe(1)
  expect(draft.remaining).toBe(1)
  expect(draft.url.length).toBeLessThanOrEqual(URL_CAP)
  expect(draft.url.length).toBeGreaterThan(URL_CAP - 50)
  expect(bodyOf(draft.url)).toContain('… (truncated)')
})

test('truncation keeps code points whole and normalizes lone surrogates', () => {
  const emoji = '😀'
  const text = `${emoji.repeat(5000)}\uD800 tail \uDC00`
  const { drafts } = buildIssueDrafts([comment('1', text)], builtinRepository)
  const draft = drafts[0]!
  expect(draft.url.length).toBeLessThanOrEqual(URL_CAP)
  const body = bodyOf(draft.url)
  expect(body).toContain('… (truncated)')
  expect(body.endsWith('… (truncated)')).toBe(true)
  const kept = body.slice(0, body.indexOf('… (truncated)'))
  expect(kept).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
})

test('a lone surrogate in a short comment does not throw and becomes the replacement character', () => {
  const { drafts } = buildIssueDrafts([comment('1', `bad \uD83D end`, { elementPath: 'div\uDE00' })], builtinRepository)
  expect(drafts).toHaveLength(1)
  expect(drafts[0]!.included).toBe(1)
  expect(bodyOf(drafts[0]!.url)).toContain('bad � end')
})

test('a comment with oversized metadata still yields a draft within the cap', () => {
  const heavy = comment('1', 'text', {
    elementPath: 'a'.repeat(900),
    component: 'C'.repeat(2000),
    source: 'p/'.repeat(1000),
    sourceCaller: 'q/'.repeat(1000)
  })
  const { drafts } = buildIssueDrafts([heavy], builtinRepository)
  expect(drafts).toHaveLength(1)
  expect(drafts[0]!.included).toBe(1)
  expect(drafts[0]!.url.length).toBeLessThanOrEqual(URL_CAP)
})

test('no comments yields no drafts', () => {
  expect(buildIssueDrafts([], builtinRepository)).toEqual({ drafts: [], unrouted: [] })
})
