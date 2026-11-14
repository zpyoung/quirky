import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { clearDeferredReview, takeDeferredReview } from '../../src/view/registry'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcErrorCode, type QuirkyEvent, type ReviewModel, type UiPluginContext } from '@quirky/protocol'
import { registerDom } from './register-dom'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { fakeContext, layoutFor, failure, act } = await import('./panel-support')
const { openReview, registerReviewView, reviewViewFor } = await import('../../src/review/open')
const { setReviewMark, useReview } = await import('../../src/review/useReview')
const { onSelectedPath, selectPath, selectedPath } = await import('../../src/review/selection')

afterAll(() => GlobalRegistrator.unregister())

const unregisters: Array<() => void> = []
afterEach(() => {
  for (const off of unregisters.splice(0)) off()
  clearDeferredReview('feat')
})

function handleFor(
  worktree: string,
  options: {
    includeApplyScope?: boolean
    outcome?: 'applied' | 'unchanged' | 'dirty' | 'busy' | 'cancelled' | (() => Promise<'applied' | 'unchanged' | 'dirty' | 'busy' | 'cancelled'>)
    order?: string[]
  } = {}
) {
  const reveals: Array<[string, string | undefined]> = []
  const scopes: Array<string | null> = []
  const appliedScopes: Array<[unknown, 'ask' | 'refuse']> = []
  const tops = { count: 0 }
  const handle = {
    worktree,
    reveal: (path: string, noteId?: string) => {
      options.order?.push('reveal')
      reveals.push([path, noteId])
    },
    scrollToTop: () => {
      options.order?.push('scrollToTop')
      tops.count++
    },
    setScope: (commit: string | null) => void scopes.push(commit),
    ...(options.includeApplyScope === false ? {} : {
      applyScope: async (scope: unknown, ifDirty: 'ask' | 'refuse') => {
        options.order?.push('applyScope')
        appliedScopes.push([scope, ifDirty])
        return typeof options.outcome === 'function' ? options.outcome() : options.outcome ?? 'applied'
      }
    })
  }
  unregisters.push(registerReviewView(handle))
  return { handle, reveals, scopes, tops, appliedScopes }
}

describe('openReview without a mounted view', () => {
  test('opens one Review tab per worktree through the hosted-tab API', async () => {
    const fake = fakeContext(layoutFor('feat'))
    await openReview(fake.context, { worktree: 'feat', reveal: 'src/a.ts' })
    const opens = fake.called('quirky.terminal/openViewTab')
    expect(opens).toHaveLength(1)
    expect(opens[0]!.params).toMatchObject({ key: 'git-diff:["feat","review"]', title: 'Review' })
    expect(opens[0]!.params.input).toMatchObject({ worktree: 'feat', mode: 'review', reveal: 'src/a.ts' })
  })

  test('a commit scope and a reveal share the tab key', async () => {
    const fake = fakeContext(layoutFor('feat'))
    await openReview(fake.context, { worktree: 'feat' })
    await openReview(fake.context, { worktree: 'feat', commit: 'f5429a1', reveal: 'x.ts' })
    const keys = new Set(fake.called('quirky.terminal/openViewTab').map((c) => c.params.key))
    expect([...keys]).toEqual(['git-diff:["feat","review"]'])
  })
})

describe('openReview with a mounted view', () => {
  test('activates its tab and reveals the path without opening another', async () => {
    const fake = fakeContext(layoutFor('feat'))
    await openReview(fake.context, { worktree: 'feat' })
    const tab = (await fake.context.call('quirky.terminal/workspace', { workspace: 'id:feat' })) as {
      workspace: { root: { tabs: Array<{ id: string }> } }
    }
    fake.on('quirky.terminal/activateTab', () => ({ workspace: tab.workspace }))
    const { handle, reveals, scopes, tops } = handleFor('feat')
    expect(reviewViewFor('feat')).toBe(handle)
    const opensBefore = fake.called('quirky.terminal/openViewTab').length

    await openReview(fake.context, { worktree: 'feat', reveal: 'src/a.ts', noteId: 'n1' })

    expect(fake.called('quirky.terminal/activateTab')).toHaveLength(1)
    expect(fake.called('quirky.terminal/activateTab')[0]!.params).toMatchObject({ tab: tab.workspace.root.tabs[0]!.id })
    expect(fake.called('quirky.terminal/openViewTab')).toHaveLength(opensBefore)
    expect(reveals).toEqual([['src/a.ts', 'n1']])
    expect(scopes).toEqual([null])
    expect(tops.count).toBe(0)
  })

  test('without a path it scrolls to the top and reveals nothing', async () => {
    const fake = fakeContext(layoutFor('feat'))
    await openReview(fake.context, { worktree: 'feat' })
    fake.on('quirky.terminal/activateTab', () => ({}))
    const { reveals, scopes, tops } = handleFor('feat')

    await openReview(fake.context, { worktree: 'feat' })

    expect(tops.count).toBe(1)
    expect(reveals).toEqual([])
    expect(scopes).toEqual([null])
  })

  test('sets the scope when a commit is given', async () => {
    const fake = fakeContext(layoutFor('feat'))
    await openReview(fake.context, { worktree: 'feat' })
    fake.on('quirky.terminal/activateTab', () => ({}))
    const { reveals, scopes, tops } = handleFor('feat')

    await openReview(fake.context, { worktree: 'feat', commit: 'f5429a1' })

    expect(scopes).toEqual(['f5429a1'])
    expect(reveals).toEqual([])
    expect(tops.count).toBe(1)
  })

  test('a handle for another worktree is ignored', async () => {
    const fake = fakeContext(layoutFor('feat'))
    const { reveals } = handleFor('other')
    await openReview(fake.context, { worktree: 'feat', reveal: 'a.ts' })
    expect(fake.called('quirky.terminal/openViewTab')).toHaveLength(1)
    expect(reveals).toEqual([])
  })

  test('unregistering removes the handle', () => {
    const { handle } = handleFor('feat')
    unregisters.pop()!()
    expect(reviewViewFor('feat')).not.toBe(handle)
    expect(reviewViewFor('feat')).toBeNull()
  })
})


describe('openReview background routing and acknowledgment', () => {
  test('opens a background Review without activating it or showing its worktree', async () => {
    const fake = fakeContext(layoutFor('other'))

    const result = await openReview(fake.context, {
      worktree: 'feat',
      reveal: 'src/a.ts',
      focus: false,
      acknowledge: true
    })

    expect(result).toEqual({
      worktree: 'feat',
      tabId: 'view-tab-1',
      created: true,
      focused: false,
      source: null,
      reveal: 'src/a.ts',
      statusComplete: null
    })
    expect(fake.called('quirky.terminal/openViewTab')[0]!.params).toMatchObject({
      activate: false,
      input: { worktree: 'feat', mode: 'review', reveal: 'src/a.ts' }
    })
    expect(fake.called('quirky.terminal/activateTab')).toHaveLength(0)
    expect(fake.views.filter((view) => view.id === 'view:quirky.session/worktree')).toHaveLength(0)
  })

  test('defers a background request for an existing unmounted tab without rewriting it', async () => {
    const fake = fakeContext(layoutFor('feat'))
    await openReview(fake.context, { worktree: 'feat' })
    fake.calls.length = 0
    const before = fake.views.length

    const result = await openReview(fake.context, {
      worktree: 'feat',
      reveal: 'b.ts',
      source: 'staged',
      focus: false,
      acknowledge: true
    })

    expect(result).toMatchObject({ created: false, focused: false, source: 'staged', reveal: 'b.ts' })
    expect(fake.called('quirky.terminal/openViewTab')).toHaveLength(0)
    expect(fake.called('quirky.terminal/rekeyViewTabs')).toHaveLength(0)
    expect(fake.called('quirky.terminal/activateTab')).toHaveLength(0)
    expect(fake.views).toHaveLength(before)
    expect(takeDeferredReview('feat')).toEqual({ reveal: 'b.ts', source: 'staged' })
    expect(takeDeferredReview('feat')).toBeUndefined()
  })

  test('does not call a mounted handle for a background request', async () => {
    const fake = fakeContext(layoutFor('feat'))
    await openReview(fake.context, { worktree: 'feat' })
    fake.calls.length = 0
    const { reveals, scopes, tops, appliedScopes } = handleFor('feat')

    await openReview(fake.context, {
      worktree: 'feat',
      reveal: 'b.ts',
      source: 'staged',
      focus: false,
      acknowledge: true
    })

    expect(reveals).toEqual([])
    expect(scopes).toEqual([])
    expect(tops.count).toBe(0)
    expect(appliedScopes).toEqual([])
    expect(fake.called('quirky.terminal/openViewTab')).toHaveLength(0)
    expect(fake.called('quirky.terminal/rekeyViewTabs')).toHaveLength(0)
    expect(fake.called('quirky.terminal/activateTab')).toHaveLength(0)
    expect(takeDeferredReview('feat')).toEqual({ reveal: 'b.ts', source: 'staged' })
  })

  test('carries a source in a new Review input and reports capped status as incomplete', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.status = { ...fake.status, capped: true }

    const result = await openReview(fake.context, {
      worktree: 'feat',
      source: 'staged',
      focus: false,
      acknowledge: true
    })

    expect(result).toMatchObject({ source: 'staged', statusComplete: false })
    expect(fake.called('quirky.terminal/openViewTab')[0]!.params.input).toMatchObject({ source: 'staged' })
  })

  test('a commit wins over a source and has no scoped status metadata', async () => {
    const fake = fakeContext(layoutFor('feat'))

    const result = await openReview(fake.context, {
      worktree: 'feat',
      commit: 'f5429a1',
      source: 'staged',
      focus: false,
      acknowledge: true
    })

    expect(result).toMatchObject({ source: null, statusComplete: null })
    expect(fake.called('quirky.git/status')).toHaveLength(0)
    expect(fake.called('quirky.terminal/openViewTab')[0]!.params.input).toMatchObject({ commit: 'f5429a1' })
    expect(fake.called('quirky.terminal/openViewTab')[0]!.params.input).not.toHaveProperty('source')
  })

  test('looks up its own window before opening and awaits acknowledged navigation', async () => {
    const fake = fakeContext(layoutFor('other'))
    fake.on('ui.window.self', () => ({ connId: 7 }))
    fake.on('quirky.worktree/navigate', () => ({}))
    const result = await openReview(fake.context, {
      worktree: 'feat',
      reveal: 'a.ts',
      acknowledge: true
    })

    expect(result).toMatchObject({ created: true, focused: true, reveal: 'a.ts' })
    const methods = fake.calls.map((call) => call.method)
    expect(methods.indexOf('ui.window.self')).toBeLessThan(methods.indexOf('quirky.terminal/openViewTab'))
    expect(fake.called('quirky.terminal/openViewTab')[0]!.params).toMatchObject({ activate: true })
    expect(fake.called('quirky.worktree/navigate')).toHaveLength(1)
    expect(fake.called('quirky.worktree/navigate')[0]!.params).toEqual({
      worktree: 'id:feat',
      target: 'terminal',
      window: 7
    })
    expect(fake.views.filter((view) => view.id === 'view:quirky.session/worktree')).toHaveLength(0)
  })

  test('rejects a self lookup before opening any tab', async () => {
    const fake = fakeContext(layoutFor('other'))
    fake.on('ui.window.self', () => {
      throw new Error('window lookup failed')
    })

    await expect(openReview(fake.context, { worktree: 'feat', acknowledge: true })).rejects.toThrow('window lookup failed')

    expect(fake.called('quirky.terminal/openViewTab')).toHaveLength(0)
    expect(fake.called('quirky.worktree/navigate')).toHaveLength(0)
    expect(fake.views.filter((view) => view.id === 'view:quirky.session/worktree')).toHaveLength(0)
  })

  test('preserves a navigation error after opening and selecting the Review tab', async () => {
    const fake = fakeContext(layoutFor('other'))
    fake.on('ui.window.self', () => ({ connId: 7 }))
    const error = Object.assign(new Error('UI window connection 7 is not open'), { code: RpcErrorCode.Conflict })
    fake.on('quirky.worktree/navigate', () => {
      throw error
    })

    await expect(openReview(fake.context, { worktree: 'feat', reveal: 'a.ts', acknowledge: true }))
      .rejects.toBe(error)

    expect(fake.called('quirky.terminal/openViewTab')).toHaveLength(1)
    expect(fake.called('quirky.terminal/openViewTab')[0]!.params).toMatchObject({ activate: true })
    expect(fake.called('quirky.worktree/navigate')).toHaveLength(1)
    expect(fake.views.filter((view) => view.id === 'view:quirky.session/worktree')).toHaveLength(0)
    const result = await fake.context.call('quirky.terminal/workspace', { workspace: 'id:feat' }) as {
      workspace: { root: { activeTab?: string | null; tabs: Array<{ id: string }> } }
    }
    expect(result.workspace.root.activeTab).toBe(result.workspace.root.tabs[0]!.id)
  })

  test('applies scope, activates, navigates and reveals in order, clearing deferred work', async () => {
    const fake = fakeContext(layoutFor('feat'))
    await openReview(fake.context, { worktree: 'feat' })
    const order: string[] = []
    fake.on('ui.window.self', () => ({ connId: 7 }))
    fake.on('quirky.terminal/activateTab', () => {
      order.push('activateTab')
      return {}
    })
    fake.on('quirky.worktree/navigate', () => {
      order.push('navigate')
      return {}
    })
    const { reveals, appliedScopes } = handleFor('feat', { order })

    await openReview(fake.context, {
      worktree: 'feat',
      source: 'staged',
      reveal: 'a.ts',
      acknowledge: true,
      focus: false
    })
    expect(takeDeferredReview('feat')).toEqual({ reveal: 'a.ts', source: 'staged' })

    const result = await openReview(fake.context, {
      worktree: 'feat',
      source: 'staged',
      reveal: 'a.ts',
      acknowledge: true
    })

    expect(result).toMatchObject({ source: 'staged', focused: true })
    expect(appliedScopes).toEqual([[{ source: 'staged' }, 'refuse']])
    expect(order).toEqual(['applyScope', 'activateTab', 'navigate', 'reveal'])
    expect(reveals).toEqual([['a.ts', undefined]])
    expect(takeDeferredReview('feat')).toBeUndefined()
  })

  for (const [outcome, message] of [
    ['dirty', 'The Review has unsaved edits; save or discard them before showing another scope.'],
    ['busy', 'The Review is already asking about unsaved edits.'],
    ['cancelled', "The unsaved edits were kept, so the Review's scope did not change."]
  ] as const) {
    test(`refuses an acknowledged scope change when applyScope returns ${outcome}`, async () => {
      const fake = fakeContext(layoutFor('feat'))
      fake.on('ui.window.self', () => ({ connId: 7 }))
      await openReview(fake.context, { worktree: 'feat' })
      fake.calls.length = 0
      const { reveals, appliedScopes } = handleFor('feat', { outcome })

      await expect(openReview(fake.context, {
        worktree: 'feat',
        source: 'staged',
        reveal: 'a.ts',
        acknowledge: true
      })).rejects.toThrow(message)

      expect(appliedScopes).toEqual([[{ source: 'staged' }, 'refuse']])
      expect(fake.called('quirky.terminal/activateTab')).toHaveLength(0)
      expect(fake.called('quirky.worktree/navigate')).toHaveLength(0)
      expect(reveals).toEqual([])
    })
  }

  test('preserves an applyScope error without activating, navigating or revealing', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('ui.window.self', () => ({ connId: 7 }))
    await openReview(fake.context, { worktree: 'feat' })
    fake.calls.length = 0
    const { reveals, appliedScopes } = handleFor('feat', {
      outcome: () => Promise.reject(new Error('confirm failed'))
    })

    await expect(openReview(fake.context, {
      worktree: 'feat',
      source: 'staged',
      reveal: 'a.ts',
      acknowledge: true
    })).rejects.toThrow('confirm failed')

    expect(appliedScopes).toEqual([[{ source: 'staged' }, 'refuse']])
    expect(fake.called('quirky.terminal/activateTab')).toHaveLength(0)
    expect(fake.called('quirky.worktree/navigate')).toHaveLength(0)
    expect(reveals).toEqual([])
  })

  test('treats a handle without applyScope as unmounted', async () => {
    const fake = fakeContext(layoutFor('feat'))
    await openReview(fake.context, { worktree: 'feat' })
    const { reveals, scopes } = handleFor('feat', { includeApplyScope: false })
    fake.on('ui.window.self', () => ({ connId: 7 }))
    fake.on('quirky.worktree/navigate', () => ({}))

    await openReview(fake.context, {
      worktree: 'feat',
      source: 'staged',
      reveal: 'a.ts',
      acknowledge: true
    })

    expect(reveals).toEqual([])
    expect(scopes).toEqual([])
    expect(fake.called('quirky.terminal/openViewTab')).toHaveLength(2)
    expect(fake.called('quirky.terminal/openViewTab').at(-1)!.params.input).toMatchObject({ source: 'staged', reveal: 'a.ts' })
  })
})


describe('openReview scope outcome acknowledgment', () => {
  for (const outcome of ['applied', 'unchanged'] as const) {
    test(`continues after applyScope returns ${outcome}`, async () => {
      const fake = fakeContext(layoutFor('feat'))
      await openReview(fake.context, { worktree: 'feat' })
      const order: string[] = []
      fake.on('ui.window.self', () => ({ connId: 7 }))
      fake.on('quirky.terminal/activateTab', () => {
        order.push('activateTab')
        return {}
      })
      fake.on('quirky.worktree/navigate', () => {
        order.push('navigate')
        return {}
      })
      const { reveals, appliedScopes } = handleFor('feat', { outcome, order })

      const result = await openReview(fake.context, {
        worktree: 'feat',
        source: 'staged',
        reveal: 'a.ts',
        acknowledge: true
      })

      expect(result).toMatchObject({ source: 'staged', focused: true })
      expect(appliedScopes).toEqual([[{ source: 'staged' }, 'refuse']])
      expect(order).toEqual(['applyScope', 'activateTab', 'navigate', 'reveal'])
      expect(reveals).toEqual([['a.ts', undefined]])
    })
  }
})
describe('selection store', () => {
  test('notifies listeners with the origin and stops after unsubscribe', () => {
    const seen: Array<[string | null, string]> = []
    const off = onSelectedPath('wt-sel', (path, origin) => void seen.push([path, origin]))
    expect(selectedPath('wt-sel')).toBeNull()

    selectPath('wt-sel', 'a.ts', 'panel')
    selectPath('wt-sel', 'b.ts', 'review')
    expect(selectedPath('wt-sel')).toBe('b.ts')
    off()
    selectPath('wt-sel', null, 'panel')

    expect(seen).toEqual([['a.ts', 'panel'], ['b.ts', 'review']])
    expect(selectedPath('wt-sel')).toBeNull()
  })

  test('is per worktree', () => {
    const seen: string[] = []
    const off = onSelectedPath('wt-one', (path) => void seen.push(path ?? ''))
    selectPath('wt-two', 'x.ts', 'panel')
    off()
    expect(seen).toEqual([])
    expect(selectedPath('wt-one')).toBeNull()
  })
})

describe('setReviewMark', () => {
  test('returns ok on success and passes the expected hash', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/setReviewMark', () => ({ mark: 'reviewed' }))
    await expect(setReviewMark(fake.context, { worktree: 'feat', path: 'a.ts', reviewed: true, expected: 'h1' })).resolves.toBe('ok')
    expect(fake.called('quirky.git/setReviewMark')[0]!.params).toEqual({ worktree: 'feat', path: 'a.ts', reviewed: true, expected: 'h1' })
  })

  test('maps a changed-on-disk conflict to conflict', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/setReviewMark', () => {
      throw Object.assign(failure('changed since you looked', { reason: 'changed-on-disk' }), { code: RpcErrorCode.Conflict })
    })
    await expect(setReviewMark(fake.context, { worktree: 'feat', path: 'a.ts', reviewed: true, expected: 'h1' })).resolves.toBe('conflict')
  })

  test('rethrows a conflict for any other reason', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/setReviewMark', () => {
      throw Object.assign(failure('busy', { reason: 'busy' }), { code: RpcErrorCode.Conflict })
    })
    await expect(setReviewMark(fake.context, { worktree: 'feat', path: 'a.ts', reviewed: true })).rejects.toThrow('busy')
  })

  test('rethrows any other error', async () => {
    const fake = fakeContext(layoutFor('feat'))
    fake.on('quirky.git/setReviewMark', () => {
      throw Object.assign(failure('nope'), { code: RpcErrorCode.NotFound })
    })
    await expect(setReviewMark(fake.context, { worktree: 'feat', path: 'a.ts', reviewed: false })).rejects.toThrow('nope')
  })
})

describe('useReview polling', () => {
  type Deferred = { worktree: string; resolve(model: unknown): void }

  function harness(worktree = 'feat') {
    const requests: Deferred[] = []
    const listeners = new Set<(event: QuirkyEvent) => void>()
    const context = {
      call: (_method: string, params: { worktree: string }) => new Promise((resolve) => requests.push({ worktree: params.worktree, resolve })),
      subscribe: (listener: (event: QuirkyEvent) => void) => {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      }
    } as unknown as UiPluginContext
    let tick: () => void = () => {}
    const realSetInterval = globalThis.setInterval
    const realClearInterval = globalThis.clearInterval
    globalThis.setInterval = ((fn: () => void) => {
      tick = fn
      return 1
    }) as unknown as typeof setInterval
    globalThis.clearInterval = (() => {}) as unknown as typeof clearInterval
    const seen: { model: ReviewModel | null } = { model: null }
    function Probe({ worktree: wt }: { worktree: string }) {
      seen.model = useReview(context, wt).model
      return null
    }
    const root = createRoot(document.createElement('div'))
    return {
      requests,
      seen,
      poll: () => act(async () => tick()),
      emit: (event: QuirkyEvent) => act(async () => void listeners.forEach((l) => l(event))),
      render: (wt: string = worktree) => act(async () => root.render(createElement(Probe, { worktree: wt }))),
      land: (index: number, model: unknown) => act(async () => requests[index]!.resolve(model)),
      done: async () => {
        await act(async () => root.unmount())
        globalThis.setInterval = realSetInterval
        globalThis.clearInterval = realClearInterval
      }
    }
  }
  const model = (version: number) => ({ worktreeId: 'feat', version }) as unknown as ReviewModel

  test('a response slower than the poll interval still lands, and polls meanwhile start no new request', async () => {
    const h = harness()
    await h.render()
    await h.poll()
    await h.poll()
    expect(h.requests).toHaveLength(1)

    await h.land(0, model(1))
    expect(h.seen.model).toEqual(model(1))
    await h.done()
  })

  test('the next poll after a response starts a new request', async () => {
    const h = harness()
    await h.render()
    await h.land(0, model(1))
    await h.poll()
    expect(h.requests).toHaveLength(2)
    await h.land(1, model(2))
    expect(h.seen.model).toEqual(model(2))
    await h.done()
  })

  test('an event during an in-flight request becomes exactly one follow-up request', async () => {
    const h = harness()
    await h.render()
    await h.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } })
    await h.emit({ type: 'quirky.git/reviewChanged', data: { worktreeId: 'feat' } })
    expect(h.requests).toHaveLength(1)

    await h.land(0, model(1))
    expect(h.seen.model).toEqual(model(1))
    expect(h.requests).toHaveLength(2)
    await h.land(1, model(2))
    expect(h.seen.model).toEqual(model(2))
    expect(h.requests).toHaveLength(2)
    await h.done()
  })

  test('a response that lands after a worktree switch is dropped', async () => {
    const h = harness('feat')
    await h.render('feat')
    await h.render('other')
    expect(h.requests.map((r) => r.worktree)).toEqual(['feat', 'other'])

    await h.land(0, model(1))
    expect(h.seen.model).toBeNull()
    await h.land(1, { worktreeId: 'other', version: 9 })
    expect(h.seen.model).toEqual({ worktreeId: 'other', version: 9 } as unknown as ReviewModel)
    await h.done()
  })
})
