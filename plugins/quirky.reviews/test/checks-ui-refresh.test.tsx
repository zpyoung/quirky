import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { CHECKS_PANEL, type ReviewsState } from '../src/contracts'
import { activate } from '../src/ui'

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Array<() => void> = []
const WORKTREE_A = '/work/tree-a'
const WORKTREE_B = '/work/tree-b'

afterEach(async () => {
  await act(async () => {
    for (const unmount of roots.splice(0)) unmount()
  })
  document.body.innerHTML = ''
})

afterAll(() => GlobalRegistrator.unregister())

function stateFor(worktree: string, fetchedAt = Date.now()): ReviewsState {
  const review = {
    provider: 'github', number: 12, url: 'https://github.com/test-owner/test-repo/pull/12', title: `Review ${worktree}`, body: '',
    state: 'open', headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40), baseRefOid: 'b'.repeat(40),
    mergeable: 'MERGEABLE', checksStatus: 'passing', reviewDecision: 'APPROVED', mergeStateStatus: 'CLEAN',
    autoMergeRequest: null, stack: null, mergeMethods: null
  }
  const detail = {
    target: null, tab: 'conversation', audience: 'all', generation: 0, loading: false, error: null, review: null, details: null,
    checks: null, comments: null, files: null, expandedChecks: [], queuedComments: [], checksCollapsed: false, commentDraft: '',
    fetchedAt: 0, pending: [], collapsedFiles: [], fileFilter: '', fileTreeVisible: true
  }
  const checks = {
    worktree, generation: 1, loading: false, error: null, lookup: { kind: 'found', gitStatus: { branch: 'feature', head: 'a'.repeat(40) } }, eligibility: null, review,
    checks: { number: 12, headSha: 'a'.repeat(40), rollup: 'success', partial: false, partialFailures: [], checks: [] }, comments: null, conflicts: null, audience: 'all', grouping: 'grouped', expandedChecks: [], queuedComments: [],
    checksCollapsed: false, commentDraft: '', titleDraft: null, height: 320, fetchedAt, agentDialog: null
  }
  const creation = { worktree, generation: 0, loading: false, error: null, bases: [], title: '', body: '', base: '', head: '', generating: false, submitting: false }
  const settings = { generation: 0, loading: false, error: null }
  return {
    revision: 1, detail, checks, creation, settings,
    defaults: { draft: false, useTemplate: false, generateDetailsOnOpen: false, openAfterCreate: false },
    repoDefaults: {}, botOverrides: [], links: {}, suppressed: {}
  } as unknown as ReviewsState
}

type Call = { method: string; params: Record<string, unknown> }
interface SurfaceOptions {
  cachedAOnRevisit?: boolean
}

async function mountSurface({ cachedAOnRevisit = false }: SurfaceOptions = {}) {
  const calls: Call[] = []
  const layoutListeners = new Set<(layout: UiLayout) => void>()
  let layout = {
    worktree: WORKTREE_A, view: null, panel: null, sidebar: true, focus: null,
    tools: { open: cachedAOnRevisit ? { right: CHECKS_PANEL } : {} }
  } as unknown as UiLayout
  let resolveChecksRefresh: ((result: unknown) => void) | null = null
  let resolveCachedEntryRefresh: ((result: unknown) => void) | null = null
  let worktreeAStateReads = 0
  let worktreeARefreshCalls = 0
  const provided = new Map<string, unknown>()
  const context = {
    pluginId: 'quirky.reviews',
    provide: (id: string, implementation: unknown) => provided.set(id, implementation),
    call: (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'quirky.reviews/state') {
        const worktree = String(params.worktree)
        if (cachedAOnRevisit && worktree === WORKTREE_A) {
          worktreeAStateReads += 1
          return Promise.resolve(stateFor(worktree, worktreeAStateReads === 1 ? Date.now() : 0))
        }
        return Promise.resolve(stateFor(worktree))
      }
      if (method === 'quirky.hosting/refresh') return Promise.resolve({ ok: true })
      if (method === 'quirky.hosting/visibleRefreshCandidates') return Promise.resolve({ accepted: true })
      if (method === 'quirky.reviews/checksRefresh') {
        const worktree = String(params.worktree)
        if (cachedAOnRevisit) {
          if (worktree === WORKTREE_A) {
            worktreeARefreshCalls += 1
            if (worktreeARefreshCalls === 1) {
              const pending = Promise.withResolvers<unknown>()
              resolveCachedEntryRefresh = pending.resolve
              return pending.promise
            }
            if (worktreeARefreshCalls === 2) {
              resolveCachedEntryRefresh?.({ ok: false, stale: true })
            }
          }
          return Promise.resolve({ ok: true })
        }
        const pending = Promise.withResolvers<unknown>()
        resolveChecksRefresh = pending.resolve
        return pending.promise
      }
      return Promise.resolve({ ok: true })
    },
    getLayout: () => layout,
    onLayout: (listener: (next: UiLayout) => void) => { layoutListeners.add(listener); return () => layoutListeners.delete(listener) },
    onConnection: () => () => {},
    subscribe: () => () => {},
    getSetting: () => undefined,
    toast() {},
    confirm: async () => false,
    log() {}
  } as unknown as UiPluginContext
  activate(context)
  const mount = provided.get(CHECKS_PANEL) as ((element: HTMLElement, props: Record<string, never>) => () => void) | undefined
  if (!mount) throw new Error(`activate did not provide ${CHECKS_PANEL}`)
  const element = document.createElement('div')
  document.body.appendChild(element)
  let unmount = () => {}
  await act(async () => { unmount = mount(element, {}) })
  roots.push(() => unmount())
  return {
    element, calls,
    resolveCachedEntryRefresh(result: unknown) {
      if (!resolveCachedEntryRefresh) throw new Error('No cached-entry checks refresh is pending.')
      resolveCachedEntryRefresh(result)
    },
    resolveChecksRefresh(result: unknown) {
      if (!resolveChecksRefresh) throw new Error('No checks refresh is pending.')
      resolveChecksRefresh(result)
    },
    async switchWorktree(worktree: string) {
      await act(async () => {
        layout = { ...layout, worktree }
        for (const listener of [...layoutListeners]) listener(layout)
      })
    }
  }
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => {})
}

async function beginRefresh(element: HTMLElement) {
  await settle()
  const button = element.querySelector<HTMLButtonElement>('button[aria-label="Refresh checks"]')
  expect(button).not.toBeNull()
  await act(async () => { button!.click() })
  await settle()
}

test('a late checks refresh cannot replace the selected worktree state', async () => {
  const surface = await mountSurface()
  await settle()
  expect(surface.element.textContent).toContain(`Review ${WORKTREE_A}`)

  await beginRefresh(surface.element)
  const refreshCalls = surface.calls.filter((call) => call.method === 'quirky.reviews/checksRefresh')
  expect(refreshCalls).toHaveLength(1)
  expect(refreshCalls[0]?.params).toEqual({ worktree: WORKTREE_A, force: true })

  await surface.switchWorktree(WORKTREE_B)
  await settle()
  expect(surface.element.textContent).toContain(`Review ${WORKTREE_B}`)

  await act(async () => surface.resolveChecksRefresh({ ok: true }))
  await settle()
  expect(surface.element.textContent).toContain(`Review ${WORKTREE_B}`)
  expect(surface.element.textContent).not.toContain('Checking pull request status…')
  const stateCalls = surface.calls.filter((call) => call.method === 'quirky.reviews/state')
  expect(stateCalls.slice(1).every((call) => call.params.worktree === WORKTREE_B)).toBe(true)
})

test('a late checks refresh error is not shown for a different selected worktree', async () => {
  const surface = await mountSurface()
  await beginRefresh(surface.element)

  await surface.switchWorktree(WORKTREE_B)
  await settle()
  expect(surface.element.textContent).toContain(`Review ${WORKTREE_B}`)

  await act(async () => surface.resolveChecksRefresh({ ok: false, error: 'old worktree failed' }))
  await settle()
  expect(surface.element.textContent).toContain(`Review ${WORKTREE_B}`)
  expect(surface.element.textContent).not.toContain('old worktree failed')
})

test('revisiting a cached old Checks entry force-refreshes once without an action error', async () => {
  const surface = await mountSurface({ cachedAOnRevisit: true })
  await settle()

  await surface.switchWorktree(WORKTREE_B)
  await settle()
  await surface.switchWorktree(WORKTREE_A)
  await settle()
  const revisitRefreshes = surface.calls.filter((call) => call.method === 'quirky.reviews/checksRefresh' && call.params.worktree === WORKTREE_A)
  if (revisitRefreshes.length === 1) {
    await act(async () => surface.resolveCachedEntryRefresh({ ok: true }))
    await settle()
  }

  expect(revisitRefreshes).toHaveLength(1)
  expect(revisitRefreshes[0]?.params).toEqual({ worktree: WORKTREE_A, force: true })
  expect(surface.element.querySelector('[role="alert"]')).toBeNull()
})

test('a superseded checks refresh is not an action error', async () => {
  const surface = await mountSurface()
  await beginRefresh(surface.element)

  await act(async () => surface.resolveChecksRefresh({ ok: false, stale: true }))
  await settle()

  expect(surface.element.textContent).toContain(`Review ${WORKTREE_A}`)
  expect(surface.element.querySelector('[role="alert"]')).toBeNull()
})
