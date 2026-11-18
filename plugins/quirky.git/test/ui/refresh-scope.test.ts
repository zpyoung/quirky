import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { GitDiff, ReviewFile } from '@quirky/protocol'
import { registerDom } from './register-dom'
import { worktreeIdOf } from '../../src/view/data'

registerDom()
const s = await import('./support')
afterAll(() => GlobalRegistrator.unregister())

const { fakeContext, layoutFor, mountView, settle } = s

const A = 'wt_aaaaaaaaaaaa'
const B = 'wt_bbbbbbbbbbbb'
const other = { type: 'quirky.git/changed', data: { worktreeId: B }, worktreeId: B }
const own = { type: 'quirky.git/changed', data: { worktreeId: A }, worktreeId: A }
const untagged = { type: 'quirky.git/changed', data: { worktreeId: B } }
const twoBlocks = [
  'a',
  '<<<<<<< HEAD',
  'ours',
  '=======',
  'theirs',
  '>>>>>>> topic',
  ''
].join('\n')

const conflictFile = () => ({
  path: 'math.ts',
  kind: 'both_modified',
  state: 'unresolved',
  content: twoBlocks,
  hash: 'h1',
  operation: 'merge'
})

const initialFiles = (): ReviewFile[] => [
  s.reviewFile('README.md', { mark: 'reviewed' }),
  s.reviewFile('src/app.ts'),
  s.reviewFile('src/feature/enabled.ts', { notes: 2 }),
  s.reviewFile('src/feature/flags.ts', { mark: 'changed' })
]

const makeFake = () => {
  const fake = fakeContext(layoutFor(A))
  fake.handlers['quirky.git/conflictFile'] = () => conflictFile()

  let model = s.reviewModel(initialFiles())
  const diffBody = (path: string, against: string) => ({
    original: `${against}\n${s.numbered(10, 'line')}`,
    modified: `${against}\n${s.numbered(10, 'line').replace('line 5', 'five')}`
  })
  fake.handlers['quirky.git/review'] = () => model
  fake.handlers['quirky.git/diff'] = (params) =>
    s.textDiff({
      path: params.path as string,
      source: params.source as GitDiff['source'],
      modifiedHash: `hash:${params.path}`,
      ...diffBody(params.path as string, String(params.against ?? params.source))
    })
  fake.handlers['quirky.git/setReviewMark'] = (params) => {
    const reviewed = params.reviewed === true
    model = s.reviewModel(model.files.map((file) =>
      file.path === params.path ? { ...file, mark: reviewed ? 'reviewed' : 'none' } : file
    ))
    return {}
  }
  fake.handlers['quirky.git/commitFiles'] = (params) => ({
    commit: String(params.commit),
    entries: [
      { path: 'a.ts', status: 'modified', added: 1, removed: 1, binary: false },
      { path: 'b.ts', status: 'added', added: 4, removed: 0, binary: false }
    ]
  })
  return fake
}

let fake: ReturnType<typeof fakeContext>
let mounted: ReturnType<typeof mountView> | null = null
let intersection: ReturnType<typeof s.stubIntersectionObserver>
let resize: ReturnType<typeof s.stubResizeObserver>
let originalScroll: typeof Element.prototype.scrollIntoView

const open = async (input: object) => {
  mounted = mountView(fake, input)
  await settle()
  return mounted
}

const emit = async (event: object) => {
  await s.act(async () => fake.emit(event as never))
  await settle()
}

beforeEach(() => {
  document.body.innerHTML = ''
  fake = makeFake()
  intersection = s.stubIntersectionObserver()
  resize = s.stubResizeObserver()
  originalScroll = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function () {}
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
  intersection.restore()
  resize.restore()
  Element.prototype.scrollIntoView = originalScroll
})

describe('quirky.git refresh scopes', () => {
  test('scenario 15: worktreeIdOf recognizes only selectors that state an ID', () => {
    const cases: Array<[string, string | null]> = [
      [A, A],
      [` ${A} `, A],
      [`id:${A}`, A],
      ['id:anything', 'anything'],
      ['feat', null],
      ['w1', null],
      ['name:feat', null],
      ['branch:main', null],
      ['path:/repo', null],
      ['current', null],
      ['active', null],
      ['id:', null],
      ['WT_AAAAAAAAAAAA', null],
      ['wt_aaaaaaaaaaa', null],
      ['wt_aaaaaaaaaaaaa', null],
      ['', null]
    ]
    for (const [selector, expected] of cases) expect(worktreeIdOf(selector)).toBe(expected)
  })

  test('scenario 16: a conflict file view refreshes only for its tagged worktree and untagged events', async () => {
    await open({ worktree: A, mode: 'conflict-file', path: 'math.ts' })
    const calls = () => fake.callsTo('quirky.git/conflictFile').length
    const initial = calls()

    await emit(other)
    expect(calls()).toBe(initial)
    await emit(own)
    expect(calls()).toBe(initial + 1)
    await emit(untagged)
    expect(calls()).toBe(initial + 2)
    expect(fake.scopes()).toEqual([A])
  })

  test('scenario 17: an id: selector scopes a conflict file view by worktree ID', async () => {
    await open({ worktree: `id:${A}`, mode: 'conflict-file', path: 'math.ts' })
    const calls = () => fake.callsTo('quirky.git/conflictFile').length
    const initial = calls()

    await emit(other)
    expect(calls()).toBe(initial)
    await emit(own)
    expect(calls()).toBe(initial + 1)
    await emit(untagged)
    expect(calls()).toBe(initial + 2)
    expect(fake.scopes()).toEqual([A])
  })

  test('scenario 18: a non-ID selector keeps the conflict file view unscoped', async () => {
    await open({ worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    const calls = () => fake.callsTo('quirky.git/conflictFile').length
    const initial = calls()

    await emit(other)
    expect(calls()).toBe(initial + 1)
    expect(fake.scopes()).toEqual([])
  })

  test('scenario 19: conflicts and review views scope only selectors that state an ID', async () => {
    for (const mode of ['conflicts', 'review'] as const) {
      fake = makeFake()
      const scoped = await open({ worktree: A, mode })
      expect(fake.scopes()).toEqual([A])
      scoped.unmount()
      mounted = null

      fake = makeFake()
      const unscoped = await open({ worktree: 'w1', mode })
      expect(fake.scopes()).toEqual([])
      unscoped.unmount()
      mounted = null
    }
  })
})
