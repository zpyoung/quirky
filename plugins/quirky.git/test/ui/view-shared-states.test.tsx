import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { GitDiff, GitStatusEntry, ReviewModel } from '@quirky/protocol'
import { freshCard, reconcileCards } from '../../src/view/review-layout'
import { registerDom } from './register-dom'

registerDom()
// The support module imports the plugin's UI entry point, so it must load after happy-dom registration.
const s = await import('./support')
afterAll(() => GlobalRegistrator.unregister())

const { act, byText, click, fakeContext, layoutFor, mountView, modifiedEditor, reviewFile, reviewModel, settle, status, textDiff } = s

const A = 'a.ts'
const GUIDE = 'guide.md'
const files = () => [reviewFile(A), reviewFile(GUIDE)]
const model = () => reviewModel(files())
const card = (root: ParentNode, path: string) => root.querySelector<HTMLElement>(`section[data-path="${path}"]`)!
const body = (root: ParentNode, path: string) => card(root, path).querySelector<HTMLElement>('[data-review-body]')!
const readError = (root: ParentNode) => root.querySelector<HTMLElement>('.ui-inline-error')

let fake: ReturnType<typeof fakeContext>
let mounted: ReturnType<typeof mountView> | null = null

function freshFake() {
  fake = fakeContext(layoutFor('w1'))
  fake.handlers['quirky.git/review'] = () => model()
  fake.handlers['quirky.git/diff'] = (params) => textDiff({ path: params.path as string, source: params.source as GitDiff['source'] })
  fake.handlers['quirky.git/commitFiles'] = (params) => ({
    commit: String(params.commit),
    entries: [
      { path: A, status: 'modified', added: 1, removed: 0, binary: false },
      { path: GUIDE, status: 'modified', added: 1, removed: 0, binary: false }
    ]
  })
  fake.handlers['quirky.git/status'] = () =>
    status([
      { path: A, area: 'staged', status: 'modified', added: 1, removed: 0, binary: false },
      { path: GUIDE, area: 'staged', status: 'modified', added: 1, removed: 0, binary: false }
    ] satisfies GitStatusEntry[])
  fake.handlers['quirky.git/acceptConflictDeletion'] = () => ({})
  fake.handlers['quirky.git/setReviewMark'] = () => ({})
}

beforeEach(() => {
  document.body.innerHTML = ''
  freshFake()
})

afterEach(() => {
  mounted?.unmount()
  mounted = null
})

describe('shared diff-view states', () => {
  test('review loading uses NoticeLine without an empty state', async () => {
    fake.handlers['quirky.git/review'] = () => Promise.withResolvers<ReviewModel>().promise
    mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()

    expect(mounted.element.querySelector('[data-review-scroll] [role="status"] .ui-notice-line')?.textContent).toBe('Loading diff...')
    expect(mounted.element.querySelector('.ui-empty-state')).toBeNull()
  })

  test('review, commit, and staged read errors can each retry their own read', async () => {
    const commit = 'f'.repeat(40)
    const cases = [
      {
        input: { worktree: 'w1', mode: 'review' },
        method: 'quirky.git/review',
        fail: (attempt: number) => attempt === 1,
        expected: { worktree: 'w1' }
      },
      {
        input: { worktree: 'w1', mode: 'review', commit },
        method: 'quirky.git/commitFiles',
        fail: (attempt: number) => attempt === 1,
        expected: { worktree: 'w1', commit }
      },
      {
        input: { worktree: 'w1', mode: 'review', source: 'staged' },
        method: 'quirky.git/status',
        fail: (attempt: number) => attempt === 1,
        expected: { worktree: 'w1' }
      }
    ] as const

    for (const scenario of cases) {
      mounted?.unmount()
      mounted = null
      document.body.innerHTML = ''
      freshFake()
      const calls = new Map<string, number>()
      const method = scenario.method
      const defaultHandler = fake.handlers[method]!
      fake.handlers[method] = (params) => {
        const count = (calls.get(method) ?? 0) + 1
        calls.set(method, count)
        if (scenario.fail(count)) throw new Error('fixture read failed')
        if (method === 'quirky.git/review') return model()
        return defaultHandler(params)
      }
      mounted = mountView(fake, scenario.input)
      await settle()

      expect(readError(mounted.element)?.querySelector('.ui-inline-error__message')?.textContent).toBe('Error loading review: fixture read failed')
      expect(mounted.element.querySelectorAll('.ui-inline-error')).toHaveLength(1)
      expect(mounted.element.querySelectorAll('[role="alert"]')).toHaveLength(1)
      expect(mounted.element.querySelector('.ui-empty-state')).toBeNull()
      expect(fake.callsTo(method)).toHaveLength(1)
      expect(byText(readError(mounted.element)!, 'Retry')).not.toBeNull()

      await click(byText(readError(mounted.element)!, 'Retry'))
      expect(fake.callsTo(method)).toHaveLength(2)
      expect(fake.callsTo(method).at(-1)?.params).toEqual(scenario.expected)
      expect(readError(mounted.element)).toBeNull()
      expect(mounted.element.querySelector('[role="alert"]')).toBeNull()
      expect(mounted.element.querySelectorAll('section[data-path]')).toHaveLength(2)
    }
  })

  test('a failed review reread keeps both cards and Retry clears its stale alert', async () => {
    let reads = 0
    fake.handlers['quirky.git/review'] = () => {
      reads++
      if (reads === 2) throw new Error('repository unavailable')
      return model()
    }
    mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    expect(mounted.element.querySelectorAll('section[data-path]')).toHaveLength(2)

    await act(async () => fake.emit({ type: 'quirky.git/reviewChanged', data: { worktreeId: 'w1' } } as never))
    await settle()
    expect(readError(mounted.element)?.textContent).toContain('Review may be out of date: repository unavailable')
    expect(byText(readError(mounted.element)!, 'Retry')).not.toBeNull()
    expect(mounted.element.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(mounted.element.querySelectorAll('section[data-path]')).toHaveLength(2)

    await click(byText(readError(mounted.element)!, 'Retry'))
    expect(reads).toBe(3)
    expect(readError(mounted.element)).toBeNull()
    expect(mounted.element.querySelector('[role="alert"]')).toBeNull()
    expect(mounted.element.querySelectorAll('section[data-path]')).toHaveLength(2)
  })

  test('card loading and read errors render shared states, then Retry loads the diff', async () => {
    let rejectDiff!: (reason: Error) => void
    let attempts = 0
    fake.handlers['quirky.git/diff'] = (params) => {
      if (params.path === A) {
        attempts++
        if (attempts === 1) {
          const deferred = Promise.withResolvers<GitDiff>()
          rejectDiff = deferred.reject
          return deferred.promise
        }
      }
      return textDiff({ path: params.path as string, source: params.source as GitDiff['source'] })
    }
    mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    expect(body(mounted.element, A).querySelector('[role="status"] .ui-notice-line')?.textContent).toBe('Loading diff...')

    await act(async () => rejectDiff(new Error('git exploded')))
    await settle()
    expect(body(mounted.element, A).querySelector('.ui-inline-error')?.textContent).toBe('Error loading diff: git explodedRetry')
    expect(body(mounted.element, A).querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(body(mounted.element, A).querySelector('.ui-empty-state')).toBeNull()
    expect(fake.callsTo('quirky.git/diff').filter((call) => call.params.path === A)).toHaveLength(1)

    await click(byText(body(mounted.element, A), 'Retry'))
    expect(fake.callsTo('quirky.git/diff').filter((call) => call.params.path === A)).toHaveLength(2)
    expect(body(mounted.element, A).querySelector('[data-diff-editor]')).not.toBeNull()
    expect(body(mounted.element, A).querySelector('.ui-inline-error')).toBeNull()
  })

  test('Markdown preview uses NoticeLine while rendering and InlineError on renderer failure', async () => {
    let rejectRender!: (reason: Error) => void
    fake.handlers['quirky.editor/markdownPreview'] = (params) => {
      if (params.action === 'release') return {}
      const deferred = Promise.withResolvers<unknown>()
      rejectRender = deferred.reject
      return deferred.promise
    }
    mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    await click(byText(card(mounted.element, GUIDE).querySelector('header')!, 'Preview'))

    expect(card(mounted.element, GUIDE).querySelector('[role="status"] .ui-notice-line')?.textContent).toBe('Rendering Markdown...')
    await act(async () => rejectRender(new Error('renderer is down')))
    await settle()
    expect(card(mounted.element, GUIDE).querySelector('.ui-inline-error')?.textContent).toBe('Markdown preview unavailable: renderer is down')
    expect(card(mounted.element, GUIDE).querySelector('.ui-empty-state')).toBeNull()
    expect(card(mounted.element, GUIDE).querySelectorAll('[role="alert"]')).toHaveLength(1)
  })

  test('reconciliation preserves identity unless a stored card mark changes', () => {
    const unchanged = { a: { ...freshCard('none'), collapsed: true }, b: freshCard('reviewed') }
    expect(reconcileCards(unchanged, [{ key: 'a', mark: 'none' }, { key: 'b', mark: 'reviewed' }])).toBe(unchanged)

    const changed = reconcileCards(unchanged, [{ key: 'a', mark: 'changed' }, { key: 'b', mark: 'reviewed' }])
    expect(changed).not.toBe(unchanged)
    expect(changed.a).toEqual(freshCard('changed'))
    expect(changed.b).toBe(unchanged.b)
  })

  test('save failures keep their text and toast as errors at runtime', async () => {
    const toastOptions: unknown[] = []
    fake.context.toast = (title, message, options) => {
      fake.toasts.push([title, message])
      toastOptions.push(options)
    }
    fake.handlers['quirky.git/save'] = () => {
      throw new Error('disk full')
    }
    mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    const editor = modifiedEditor(card(mounted.element, A))
    act(() => editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'draft\n' } }))
    await settle()
    const shortcut = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }
    await act(async () => void editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ...shortcut, bubbles: true })))
    await settle()

    expect(fake.toasts.at(-1)).toEqual(['Save failed', 'disk full'])
    expect(toastOptions.at(-1)).toEqual({ kind: 'error' })
  })
})
