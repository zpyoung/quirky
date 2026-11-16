import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcErrorCode, type GitDiff, type GitStatus, type GitStatusEntry, type ReviewModel } from '@quirky/protocol'
import { freshCard, reconcileCards } from '../../src/view/review-layout'
import { registerDom } from './register-dom'

registerDom()
// The support module imports the plugin's UI entry point, so it must load after happy-dom registration.
const s = await import('./support')
afterAll(() => GlobalRegistrator.unregister())

const { act, byLabel, byText, click, fakeContext, layoutFor, mountView, modifiedEditor, reviewFile, reviewModel, settle, status, textDiff } = s

const A = 'a.ts'
const GUIDE = 'guide.md'
const files = () => [reviewFile(A), reviewFile(GUIDE)]
const model = () => reviewModel(files())
const unresolvedConflicts = () =>
  [{ path: 'a.ts', area: 'conflicts', status: 'modified', conflict: { kind: 'both_modified', state: 'unresolved' } }] satisfies GitStatusEntry[]
const conflictFileResult = (overrides: Record<string, unknown> = {}) => ({
  path: 'math.ts',
  kind: 'both_modified',
  state: 'unresolved',
  content: '<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n',
  hash: 'h1',
  operation: 'merge',
  ...overrides
})
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
  test('an empty review stays visible under a stale reread error', async () => {
    let reads = 0
    fake.handlers['quirky.git/review'] = () => {
      reads++
      if (reads > 1) throw new Error('repository unavailable')
      return reviewModel([])
    }
    mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    expect(mounted.element.querySelector('.ui-empty-state')).not.toBeNull()

    await act(async () => fake.emit({ type: 'quirky.git/reviewChanged', data: { worktreeId: 'w1' } } as never))
    await settle()
    expect(readError(mounted.element)?.textContent).toContain('Review may be out of date: repository unavailable')
    expect(mounted.element.querySelector('.ui-empty-state')).not.toBeNull()
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
  test('conflicts show loading, then retry a failed status read exactly once', async () => {
    const pending = Promise.withResolvers<GitStatus>()
    let reads = 0
    fake.handlers['quirky.git/status'] = () => {
      reads++
      return reads === 1 ? pending.promise : status(unresolvedConflicts())
    }
    mounted = mountView(fake, { worktree: 'w1', mode: 'conflicts' })
    await settle()
    expect(mounted.element.querySelector('[role="status"] .ui-notice-line')?.textContent).toBe('Loading conflicts...')

    await act(async () => pending.reject(new Error('not a repository')))
    await settle()
    const error = readError(mounted.element)
    expect(error?.querySelector('.ui-inline-error__message')?.textContent).toBe('Error loading conflicts: not a repository')
    expect(byText(error!, 'Retry')).not.toBeNull()
    const callsBeforeRetry = fake.callsTo('quirky.git/status').length

    await click(byText(error!, 'Retry'))
    expect(fake.callsTo('quirky.git/status')).toHaveLength(callsBeforeRetry + 1)
    expect(fake.callsTo('quirky.git/status').at(-1)?.params).toEqual({ worktree: 'w1' })
    expect(readError(mounted.element)).toBeNull()
    expect(mounted.element.querySelector('[data-path="a.ts"]')?.textContent).toContain('Unresolved')
  })

  test('conflict file loading and errors retry its read, then keep a failed reread above the editor', async () => {
    const pending = Promise.withResolvers<unknown>()
    let reads = 0
    fake.handlers['quirky.git/conflictFile'] = () => {
      reads++
      return reads === 1 ? pending.promise : conflictFileResult()
    }
    mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    await settle()
    expect(mounted.element.querySelector('[role="status"] .ui-notice-line')?.textContent).toBe('Loading diff...')
    expect(fake.callsTo('quirky.git/conflictFile')).toHaveLength(1)

    await act(async () => pending.reject(new Error('math.ts is not in conflict.')))
    await settle()
    const error = readError(mounted.element)
    expect(error?.querySelector('.ui-inline-error__message')?.textContent).toBe(
      'Error loading conflict file: math.ts is not in conflict.'
    )
    expect(byText(error!, 'Retry')).not.toBeNull()
    const callsBeforeRetry = fake.callsTo('quirky.git/conflictFile').length

    await click(byText(error!, 'Retry'))
    expect(fake.callsTo('quirky.git/conflictFile')).toHaveLength(callsBeforeRetry + 1)
    expect(fake.callsTo('quirky.git/conflictFile').at(-1)?.params).toEqual({ worktree: 'w1', path: 'math.ts' })
    const editor = mounted.element.querySelector('[data-diff-editor]')
    expect(editor).not.toBeNull()
    const editorView = modifiedEditor(mounted.element)

    fake.handlers['quirky.git/conflictFile'] = () => {
      throw new Error('fixture read failed')
    }
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    const staleError = readError(mounted.element)
    const retainedEditor = mounted.element.querySelector('[data-diff-editor]')
    expect(staleError?.querySelector('.ui-inline-error__message')?.textContent).toBe(
      'Error loading conflict file: fixture read failed'
    )
    expect(retainedEditor).toBe(editor)
    expect(modifiedEditor(mounted.element)).toBe(editorView)
    expect(staleError!.compareDocumentPosition(retainedEditor!) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  test('a conflict file error does not coexist with the unavailable-file empty state', async () => {
    fake.handlers['quirky.git/conflictFile'] = () => {
      throw Object.assign(new Error('math.ts is not in conflict.'), { code: RpcErrorCode.NotFound })
    }
    fake.handlers['quirky.git/status'] = () => status()
    mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    await settle()
    expect(mounted.element.querySelector('.ui-empty-state')?.textContent).toBe('No working-tree file is available.')

    fake.handlers['quirky.git/conflictFile'] = () => {
      throw new Error('fixture read failed')
    }
    await act(async () => fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'w1' } }))
    await settle()
    expect(readError(mounted.element)?.textContent).toContain('Error loading conflict file: fixture read failed')
    expect(mounted.element.querySelector('.ui-empty-state')).toBeNull()
  })

  test('a conflict-open failure still toasts after its view unmounts', async () => {
    const pendingWorkspace = Promise.withResolvers<unknown>()
    const toastOptions: unknown[] = []
    fake.context.toast = (title, message, options) => {
      fake.toasts.push([title, message])
      toastOptions.push(options)
    }
    fake.handlers['quirky.git/status'] = () => status(unresolvedConflicts())
    fake.handlers['quirky.terminal/workspace'] = () => pendingWorkspace.promise
    mounted = mountView(fake, { worktree: 'w1', mode: 'conflicts' })
    await settle()
    await click(byText(mounted.element, 'Open'))
    mounted.unmount()
    mounted = null

    await act(async () => pendingWorkspace.reject(new Error('terminal unavailable')))
    await settle()
    expect(fake.toasts.at(-1)).toEqual(['Could not open diff', 'terminal unavailable'])
    expect(toastOptions.at(-1)).toEqual({ kind: 'error' })
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
  test('setting failures toast as errors at runtime', async () => {
    const toastOptions: unknown[] = []
    const call = fake.context.call.bind(fake.context)
    fake.context.call = ((method: string, params?: Record<string, unknown>) => {
      if (method === 'setting.set') {
        fake.calls.push({ method, params: params ?? {} })
        return Promise.reject(new Error('setting refused'))
      }
      return call(method, params)
    }) as typeof fake.context.call
    fake.context.toast = (title, message, options) => {
      fake.toasts.push([title, message])
      toastOptions.push(options)
    }
    mounted = mountView(fake, { worktree: 'w1', mode: 'review' })
    await settle()
    await click(byLabel(mounted.element, 'More actions'))
    const wordWrap = [...mounted.element.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find((item) =>
      item.textContent?.includes('Word wrap')
    )
    await click(wordWrap)

    expect(fake.toasts.at(-1)).toEqual(['Setting failed', 'setting refused'])
    expect(toastOptions.at(-1)).toEqual({ kind: 'error' })
  })

  test('Keep file unavailable remains an advisory toast without options', async () => {
    let reads = 0
    const toastOptions: unknown[] = []
    fake.handlers['quirky.git/conflictFile'] = () => {
      reads++
      return conflictFileResult({ kind: 'deleted_by_them', content: reads === 1 ? 'working tree content\n' : null })
    }
    fake.context.toast = (title, message, options) => {
      fake.toasts.push([title, message])
      toastOptions.push(options)
    }
    mounted = mountView(fake, { worktree: 'w1', mode: 'conflict-file', path: 'math.ts' })
    await settle()
    await click(byText(mounted.element, 'Keep file'))

    expect(fake.toasts.at(-1)).toEqual(['Keep file unavailable', 'The working-tree file no longer exists.'])
    expect(toastOptions.at(-1)).toBeUndefined()
  })
})
