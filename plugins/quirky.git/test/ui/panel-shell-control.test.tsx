import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'
import type { GitUiControl, GitUiControlAddress as ControlAddress, GitUiControlResult } from '../../src/ui-control'
import type { Fake } from './panel-support'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// React-bound modules are imported after the DOM is installed so their initialization sees it.
const { act, byLabel, buttonText, click, compareOf, entry, failure, fakeContext, layoutFor, mountPanel, noticeOf, press, q, settle, statusOf, type } = await import('./panel-support')
const { createElement } = await import('react')
const { createRoot } = await import('react-dom/client')
const { activate } = await import('../../src/ui')
const {
  GIT_UI_CONTROL_COMMAND,
  dispatchGitUiControl,
  mountGitUiControls,
  newGitUiGeneration,
  registerGitUiControl,
  requestGitUiControl,
  useGitUiControl
} = await import('../../src/ui-control')

afterAll(() => GlobalRegistrator.unregister())
const mountedPanels = new Set<() => void>()
beforeEach(() => { document.body.innerHTML = '' })
afterEach(() => { for (const unmount of mountedPanels) unmount() })

const primary = (element: HTMLElement) => q(element, '.ui-split-button__primary') as HTMLButtonElement
const errorLine = (element: HTMLElement) => q(element, '.ui-inline-error')
const message = (element: HTMLElement) => byLabel(element, 'Commit message') as HTMLTextAreaElement
const dialog = () => q(document.body, '[role="dialog"]')
const upstream = (ahead: number, behind: number, behindPatchEquivalent: boolean | null = null) => ({
  hasUpstream: true, name: 'origin/zoe/feat', sha: 'b'.repeat(40), ahead, behind, behindPatchEquivalent
})
const SOMETHING_TO_SHIP = compareOf({ entries: [{ path: 'util.ts', status: 'modified', added: 1, removed: 0, binary: false }], added: 1, ahead: 1 })

type Control = GitUiControl
type Address = Parameters<typeof registerGitUiControl>[1]
type Mounted = (() => void) & { updateInput?: (input: unknown) => boolean }

const address = (generation = 'mount-1'): Address => ({
  surface: 'extension:test',
  target: 'controller:primary',
  generation,
  actions: ['run']
})
const control: Control = {
  surface: 'extension:test',
  target: 'controller:primary',
  generation: 'mount-1',
  action: 'run'
}

test('activation provides and dispatches the actual hidden exact-window command without daemon reads', async () => {
  const fake = fakeContext(layoutFor(null), 22)
  activate(fake.context)
  const command = fake.provided.get(GIT_UI_CONTROL_COMMAND)
  expect(typeof command).toBe('function')
  expect(fake.calls).toEqual([])

  let handled = 0
  const dispose = registerGitUiControl(fake.context, address(), () => {
    handled++
    return true
  })
  const result = await requestGitUiControl(fake.context, control)
  expect(result).toEqual({ delivered: true })
  expect(handled).toBe(1)
  expect(fake.called('ui.window.self')).toHaveLength(1)
  expect(fake.called('ui.window.command.run').at(-1)?.params).toEqual({
    connId: 22,
    id: GIT_UI_CONTROL_COMMAND,
    args: control
  })
  dispose()
})

test('exact-window delivery changes only the auxiliary activation context', async () => {
  const owner = fakeContext(layoutFor(null), 11)
  const auxiliary = fakeContext(layoutFor(null), 22)
  activate(owner.context)
  activate(auxiliary.context)
  let ownerCalls = 0
  let auxiliaryCalls = 0
  const ownerDispose = registerGitUiControl(owner.context, address(), () => {
    ownerCalls++
    return true
  })
  const auxiliaryDispose = registerGitUiControl(auxiliary.context, address(), () => {
    auxiliaryCalls++
    return true
  })

  expect(await requestGitUiControl(auxiliary.context, control)).toEqual({ delivered: true })
  expect(ownerCalls).toBe(0)
  expect(auxiliaryCalls).toBe(1)
  expect(owner.calls).toEqual([])
  expect(auxiliary.called('ui.window.command.run').at(-1)?.params.connId).toBe(22)
  ownerDispose()
  auxiliaryDispose()
})

test('generic registrations refuse unknown and ambiguous addresses without fan-out', () => {
  const fake = fakeContext(layoutFor(null))
  let handled = 0
  const first = registerGitUiControl(fake.context, address(), () => {
    handled++
    return true
  })
  const unknown = dispatchGitUiControl(fake.context, { ...control, action: 'missing' })
  expect(unknown).toEqual({ delivered: false })

  const overlap = registerGitUiControl(fake.context, { ...address(), actions: ['run', 'also-run'] }, () => {
    handled++
    return true
  })
  expect(dispatchGitUiControl(fake.context, control)).toEqual({ delivered: false })
  expect(handled).toBe(0)
  overlap()
  expect(dispatchGitUiControl(fake.context, control)).toEqual({ delivered: true })
  expect(handled).toBe(1)
  first()
})

test('replacement-safe registration cleanup leaves the replacement active', () => {
  const fake = fakeContext(layoutFor(null))
  let oldCalls = 0
  let newCalls = 0
  const staleCleanup = registerGitUiControl(fake.context, address(), () => {
    oldCalls++
    return true
  })
  const currentCleanup = registerGitUiControl(fake.context, address(), () => {
    newCalls++
    return true
  })

  staleCleanup()
  expect(dispatchGitUiControl(fake.context, control)).toEqual({ delivered: true })
  expect(oldCalls).toBe(0)
  expect(newCalls).toBe(1)
  currentCleanup()
  expect(dispatchGitUiControl(fake.context, control)).toEqual({ delivered: false })
})

test('mount reports merge scoped controls with raw state', () => {
  const fake = fakeContext(layoutFor(null))
  const reports: unknown[] = []
  let mountCleanup: Mounted | undefined
  const mount = mountGitUiControls(fake.context, 'extension:test', (scopedContext) =>
    (_element, props) => {
      registerGitUiControl(scopedContext, address(), () => true)
      props.report?.({ worktree: 'feat', branch: 'zoe/feat', uiControls: ['raw report cannot replace controls'] })
      mountCleanup = (() => {}) as Mounted
      mountCleanup.updateInput = (input) => input === 'accepted'
      return mountCleanup
    }
  )
  const cleanup = mount(document.createElement('div'), {
    report: (state) => reports.push(state)
  }) as Mounted

  expect(reports.at(-1)).toEqual({
    worktree: 'feat',
    branch: 'zoe/feat',
    uiControls: [address()]
  })
  expect(cleanup.updateInput?.('accepted')).toBe(true)
  expect(cleanup.updateInput?.('rejected')).toBe(false)
  cleanup()
  expect(cleanup.updateInput?.('accepted')).toBe(true)
})

test('mount emits an empty control report without a raw report', () => {
  const fake = fakeContext(layoutFor(null))
  const reports: unknown[] = []
  const mount = mountGitUiControls(fake.context, 'extension:empty', () =>
    (_element) => (() => {}) as Mounted
  )
  const cleanup = mount(document.createElement('div'), {
    report: (state) => reports.push(state)
  }) as Mounted
  expect(reports.at(-1)).toEqual({ uiControls: [] })
  cleanup()
})

test('mount reports controls without a raw report and stale cleanup preserves a replacement mount', () => {
  const fake = fakeContext(layoutFor(null))
  const firstReports: unknown[] = []
  const secondReports: unknown[] = []
  const makeMount = () => mountGitUiControls(fake.context, 'extension:test', (scopedContext) =>
    (_element) => {
      registerGitUiControl(scopedContext, address(), () => true)
      return (() => {}) as Mounted
    }
  )
  const first = makeMount()(document.createElement('div'), {
    report: (state) => firstReports.push(state)
  }) as Mounted
  const second = makeMount()(document.createElement('div'), {
    report: (state) => secondReports.push(state)
  }) as Mounted

  expect(firstReports.at(-1)).toEqual({ uiControls: [] })
  expect(secondReports.at(-1)).toEqual({ uiControls: [address()] })
  first()
  expect(dispatchGitUiControl(fake.context, control)).toEqual({ delivered: true })
  expect(secondReports.at(-1)).toEqual({ uiControls: [address()] })
  second()
  expect(dispatchGitUiControl(fake.context, control)).toEqual({ delivered: false })
})

test('request rejects invalid self identities and malformed bridge replies with the unavailable message', async () => {
  const fake = fakeContext(layoutFor(null))
  fake.on('ui.window.self', () => ({ connId: Number.MAX_SAFE_INTEGER + 1 }))
  await expect(requestGitUiControl(fake.context, control)).rejects.toThrow('The source control action is no longer available.')

  fake.on('ui.window.self', () => ({ connId: 7 }))
  fake.on('ui.window.command.run', () => ({ result: { result: { delivered: 'yes' } } }))
  await expect(requestGitUiControl(fake.context, control)).rejects.toThrow('The source control action is no longer available.')

  fake.on('ui.window.command.run', () => ({ result: { result: { delivered: true } } }))
  expect(await requestGitUiControl(fake.context, control)).toEqual({ delivered: true })
})

test('dispatch refuses malformed addresses and non-record action data', () => {
  const fake = fakeContext(layoutFor(null))
  expect(dispatchGitUiControl(fake.context, null)).toEqual({ delivered: false })
  expect(dispatchGitUiControl(fake.context, { ...control, surface: ' ' })).toEqual({ delivered: false })
  expect(dispatchGitUiControl(fake.context, { ...control, data: [] })).toEqual({ delivered: false })
})

test('registration hook is effect-scoped and dispatches through the latest handler', async () => {
  const fake = fakeContext(layoutFor(null))
  const mountedAddress = address('hook-session')
  const mountedControl = { ...control, generation: 'hook-session' }
  let firstCalls = 0
  let latestCalls = 0
  const component = (props: { active: boolean; handler: (value: Control) => boolean }) => {
    useGitUiControl(fake.context, props.active ? mountedAddress : null, props.handler)
    return null
  }
  const root = createRoot(document.createElement('div'))

  await act(async () => {
    root.render(createElement(component, { active: true, handler: () => { firstCalls++; return true } }))
  })
  expect(dispatchGitUiControl(fake.context, mountedControl)).toEqual({ delivered: true })
  await act(async () => {
    root.render(createElement(component, { active: true, handler: () => { latestCalls++; return true } }))
  })
  expect(dispatchGitUiControl(fake.context, mountedControl)).toEqual({ delivered: true })
  expect(firstCalls).toBe(1)
  expect(latestCalls).toBe(1)
  await act(async () => {
    root.render(createElement(component, { active: false, handler: () => true }))
  })
  expect(dispatchGitUiControl(fake.context, mountedControl)).toEqual({ delivered: false })
  await act(async () => root.unmount())
})

test('new Git UI generations are distinct opaque session identifiers', () => {
  const first = newGitUiGeneration()
  const second = newGitUiGeneration()
  expect(first.trim()).not.toBe('')
  expect(second.trim()).not.toBe('')
  expect(second).not.toBe(first)
})

test('mount scopes retain the initiating context clipboard reader without touching a system clipboard', async () => {
  const fake = fakeContext(layoutFor(null))
  let reads = 0
  fake.context.readClipboardText = function () {
    expect(this).toBe(fake.context)
    reads++
    return Promise.resolve('fixture clipboard text')
  }
  let read!: () => Promise<string>
  const mount = mountGitUiControls(fake.context, 'extension:clipboard', (scoped) => {
    read = () => scoped.readClipboardText()
    return () => () => {}
  })
  const cleanup = mount(document.createElement('div'), {})
  try {
    expect(await read()).toBe('fixture clipboard text')
    expect(reads).toBe(1)
  } finally { cleanup?.() }
})

type ControlHandler = (args: unknown) => GitUiControlResult

async function controlled(configure: (fake: Fake) => void = () => {}) {
  const fake = fakeContext(layoutFor('feat'), 22)
  fake.status = statusOf([entry('a.ts', 'staged'), entry('dir/b.ts')])
  configure(fake)
  let handler: ControlHandler | undefined
  const provide = fake.context.provide
  fake.context.provide = (id, value) => {
    provide(id, value)
    if (id === 'command:quirky.git/ui-control') handler = value as ControlHandler
  }
  const mounted = mountPanel(fake)
  const unmount = () => {
    if (!mountedPanels.delete(unmount)) return
    mounted.unmount()
  }
  mountedPanels.add(unmount)
  await settle()
  const controls = (): ControlAddress[] => fake.reports.at(-1)?.uiControls ?? []
  const address = (action: string) => {
    const found = controls().find((control) => control.actions.includes(action))
    expect(found).toBeDefined()
    return found!
  }
  const send = async (control: ControlAddress, action: string, data?: Record<string, unknown>) => {
    let result: { delivered: boolean } | undefined
    await act(async () => { result = handler!({ surface: control.surface, target: control.target, generation: control.generation, action, ...(data === undefined ? {} : { data }) }) })
    await settle()
    return result!
  }
  return { fake, ...mounted, unmount, controls, address, send, dispatch: handler! }
}

describe('exact-window parent controllers', () => {
  test('reported controls fit the host limit with 1,000 rows without publishing row addresses', async () => {
    const panel = await controlled((fake) => { fake.status = statusOf(Array.from({ length: 1000 }, (_, i) => entry(`row-${i}.ts`)), { capped: true }) })
    try {
      expect(panel.controls().length).toBeGreaterThan(0)
      expect(panel.controls().length).toBeLessThan(20)
      expect(new TextEncoder().encode(JSON.stringify(panel.fake.reports.at(-1))).byteLength).toBeLessThanOrEqual(65_536)
      expect(panel.fake.reports.at(-1)).toMatchObject({ worktree: 'feat', branch: 'zoe/feat', capped: true, sections: [{ id: 'unstaged', count: 1000 }] })
    } finally { panel.unmount() }
  })

  test('pointer filter opening uses the captured report address through self and the exact-window bridge', async () => {
    const panel = await controlled()
    try {
      panel.fake.on('ui.window.self', () => ({ connId: 22 }))
      const address = panel.address('filter-open')
      await click(byLabel(panel.element, 'Filter files by name'))
      expect(byLabel(panel.element, 'Filter files…')).not.toBeNull()
      expect(panel.fake.called('ui.window.command.run').at(-1)?.params).toMatchObject({
        connId: 22, id: 'command:quirky.git/ui-control',
        args: { surface: address.surface, target: address.target, generation: address.generation, action: 'filter-open' }
      })
      await type(byLabel(panel.element, 'Filter files…') as HTMLInputElement, 'a')
      expect(panel.address('filter-close').generation).toBe(address.generation)
      await press(byLabel(panel.element, 'Filter files…')!, 'Escape')
      expect(byLabel(panel.element, 'Filter files…')).toBeNull()
      expect(panel.fake.reports.at(-1).filter).toBe('')
    } finally { panel.unmount() }
  })

  test('malformed, stale and unknown controls refuse without changes or delegated effects', async () => {
    const panel = await controlled()
    try {
      const main = panel.address('row-open')
      const before = panel.fake.calls.length
      const report = structuredClone(panel.fake.reports.at(-1))
      expect(await panel.send(main, 'unknown')).toEqual({ delivered: false })
      expect(await panel.send({ ...main, generation: 'stale' }, 'row-open', { path: 'a.ts' })).toEqual({ delivered: false })
      expect(await panel.send(main, 'row-open', { path: 17 })).toEqual({ delivered: false })
      expect(await panel.send(main, 'row-open', { path: 'not-a-current-file' })).toEqual({ delivered: false })
      expect(await panel.send(main, 'view-mode', { mode: 'grid' })).toEqual({ delivered: false })
      expect(panel.fake.calls).toHaveLength(before)
      expect(panel.fake.views).toEqual([])
      expect(panel.fake.toasts).toEqual([])
      expect(panel.fake.reports.at(-1)).toEqual(report)
      expect(errorLine(panel.element)).toBeNull()
      expect(byLabel(panel.element, 'Filter files…')).toBeNull()
      expect(dialog()).toBeNull()
    } finally { panel.unmount() }
  })

  test('A to B to A and remount do not resurrect an old controller generation', async () => {
    const panel = await controlled()
    const old = panel.address('filter-open')
    await act(async () => panel.fake.setLayout(layoutFor('other')))
    await settle()
    await act(async () => panel.fake.setLayout(layoutFor('feat')))
    await settle()
    expect(panel.address('filter-open').generation).not.toBe(old.generation)
    expect(await panel.send(old, 'filter-open')).toEqual({ delivered: false })
    panel.unmount()
    expect(await panel.send(old, 'filter-open')).toEqual({ delivered: false })
    const remount = mountPanel(panel.fake)
    try {
      await settle()
      expect(await panel.send(old, 'filter-open')).toEqual({ delivered: false })
      expect(byLabel(remount.element, 'Filter files…')).toBeNull()
    } finally { remount.unmount() }
  })

  test('a replaced row menu cannot stage a changed row or close its successor', async () => {
    const panel = await controlled()
    try {
      const main = panel.address('row-menu-open')
      await panel.send(main, 'row-menu-open', { path: 'dir/b.ts' })
      const first = panel.address('stage')
      await panel.send(first, 'close')
      await panel.send(main, 'row-menu-open', { path: 'dir/b.ts' })
      const second = panel.address('stage')
      expect(second.generation).not.toBe(first.generation)
      expect(await panel.send(first, 'close')).toEqual({ delivered: false })
      expect(q(document.body, '[role="menu"]')).not.toBeNull()
      panel.fake.status = statusOf([entry('a.ts', 'staged')])
      await act(async () => panel.fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
      await settle()
      expect(await panel.send(second, 'stage')).toEqual({ delivered: false })
      expect(panel.fake.called('quirky.git/stage')).toEqual([])
    } finally { panel.unmount() }
  })

  test('same-kind replacement confirmations cannot be confirmed or closed by the old session', async () => {
    const panel = await controlled()
    try {
      const main = panel.address('row-revert')
      await panel.send(main, 'row-revert', { path: 'a.ts' })
      const first = panel.address('confirm')
      await panel.send(first, 'cancel')
      await panel.send(main, 'row-revert', { path: 'a.ts' })
      const second = panel.address('confirm')
      expect(second.generation).not.toBe(first.generation)
      expect(await panel.send(first, 'confirm')).toEqual({ delivered: false })
      expect(await panel.send(first, 'cancel')).toEqual({ delivered: false })
      expect(dialog()).not.toBeNull()
      expect(panel.fake.called('quirky.git/discard')).toEqual([])
      panel.fake.status = statusOf([entry('dir/b.ts')])
      await act(async () => panel.fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
      await settle()
      expect(await panel.send(second, 'confirm')).toEqual({ delivered: false })
      expect(panel.fake.called('quirky.git/unstage')).toEqual([])
    } finally { panel.unmount() }
  })

  for (const failureMode of ['self', 'rejected', 'refused', 'malformed']) {
    test(`failed ${failureMode} delivery retains the draft and reports an initiating-window error without fallback`, async () => {
      const panel = await controlled()
      try {
        await type(message(panel.element), 'keep this draft')
        if (failureMode === 'self') panel.fake.on('ui.window.self', () => ({ connId: 0 }))
        else panel.fake.on('ui.window.command.run', () => {
          if (failureMode === 'rejected') throw new Error('fixture bridge refused')
          return failureMode === 'refused' ? { result: { delivered: false } } : { result: { delivered: 'yes' } }
        })
        await click(primary(panel.element))
        expect(message(panel.element).value).toBe('keep this draft')
        expect(panel.fake.called('quirky.git/commit')).toEqual([])
        expect(panel.fake.toastOptions.at(-1)).toMatchObject({ kind: 'error' })
        expect(panel.fake.toasts.at(-1)?.[1]).toBe(failureMode === 'rejected' ? 'fixture bridge refused' : 'The source control action is no longer available.')
      } finally { panel.unmount() }
    })
  }

  test('same-turn ship requests reserve one commit and late success retains an edited draft', async () => {
    const pending = Promise.withResolvers<unknown>()
    const panel = await controlled((fake) => fake.on('quirky.git/commit', () => pending.promise))
    try {
      await type(message(panel.element), 'first draft')
      const address = panel.address('ship-step')
      let first: { delivered: boolean } | undefined
      let second: { delivered: boolean } | undefined
      await act(async () => {
        const handler = panel.fake.context
        const args = { surface: address.surface, target: address.target, generation: address.generation, action: 'ship-step', data: { kind: 'commit-staged' } }
        const results = await Promise.all([
          handler.call('ui.window.command.run', { connId: 22, id: 'command:quirky.git/ui-control', args }),
          handler.call('ui.window.command.run', { connId: 22, id: 'command:quirky.git/ui-control', args })
        ])
        const firstReply = results[0] as { result: { delivered: boolean } }
        const secondReply = results[1] as { result: { delivered: boolean } }
        first = firstReply.result
        second = secondReply.result
      })
      await settle()
      expect(first).toEqual({ delivered: true })
      expect(second).toEqual({ delivered: false })
      expect(panel.fake.called('quirky.git/commit')).toHaveLength(1)
      await act(async () => panel.fake.setLayout(layoutFor('other')))
      await settle()
      await act(async () => panel.fake.setLayout(layoutFor('feat')))
      await settle()
      await type(message(panel.element), 'newer draft')
      await act(async () => pending.resolve({ sha: 'd'.repeat(40) }))
      await settle()
      expect(message(panel.element).value).toBe('newer draft')
    } finally { panel.unmount() }
  })

  test('owner and auxiliary input deliver through their actual activated handlers to only the initiating window', async () => {
    const owner = await controlled()
    const auxiliary = await controlled()
    try {
      owner.fake.on('ui.window.self', () => ({ connId: 11 }))
      auxiliary.fake.on('ui.window.self', () => ({ connId: 22 }))
      const destinations: Record<number, ControlHandler> = { 11: owner.dispatch, 22: auxiliary.dispatch }
      for (const panel of [owner, auxiliary]) panel.fake.on('ui.window.command.run', (params) => {
        if (typeof params.connId !== 'number') throw new Error('Missing connection')
        return { result: destinations[params.connId]!(params.args) }
      })
      await click(byLabel(auxiliary.element, 'Filter files by name'))
      expect(byLabel(auxiliary.element, 'Filter files…')).not.toBeNull()
      expect(byLabel(owner.element, 'Filter files…')).toBeNull()
      expect(auxiliary.fake.called('ui.window.command.run').at(-1)?.params.connId).toBe(22)
      expect(owner.fake.called('ui.window.command.run')).toEqual([])
    } finally { auxiliary.unmount(); owner.unmount() }
  })

  test('delivery acknowledges one unresolved remote operation before 30,001 ms of virtual time', async () => {
    const pending = Promise.withResolvers<unknown>()
    const panel = await controlled((fake) => {
      fake.status = statusOf([], { upstreamStatus: upstream(1, 0) })
      fake.compare = SOMETHING_TO_SHIP
      fake.on('quirky.git/push', () => pending.promise)
    })
    const now = Date.now
    try {
      const address = panel.address('ship-step')
      let reply: unknown
      let request!: Promise<void>
      await act(async () => {
        request = panel.fake.context.call('ui.window.command.run', {
          connId: 22, id: 'command:quirky.git/ui-control',
          args: { surface: address.surface, target: address.target, generation: address.generation, action: 'ship-step', data: { kind: 'push' } }
        }).then((value) => { reply = value })
      })
      await settle()
      expect(reply).toEqual({ result: { delivered: true } })
      expect(panel.fake.called('quirky.git/push')).toHaveLength(1)
      const began = now()
      Date.now = () => began + 30_001
      await settle()
      expect(reply).toEqual({ result: { delivered: true } })
      expect(await panel.send(address, 'ship-step', { kind: 'push' })).toEqual({ delivered: false })
      expect(panel.fake.called('quirky.git/push')).toHaveLength(1)
      await request
      await act(async () => pending.reject(new Error('fixture push failed')))
      await settle()
      expect(errorLine(panel.element)?.textContent).toContain('fixture push failed')
    } finally { Date.now = now; panel.unmount() }
  })

  test('a delivery error that returns after a worktree switch cannot write into the replacement', async () => {
    const delivery = Promise.withResolvers<unknown>()
    const panel = await controlled((fake) => fake.on('ui.window.command.run', () => delivery.promise))
    try {
      await click(byLabel(panel.element, 'Filter files by name'))
      await act(async () => panel.fake.setLayout(layoutFor('other')))
      await settle()
      await act(async () => delivery.reject(new Error('old delivery refused')))
      await settle()
      expect(panel.fake.toasts).toEqual([])
      expect(byLabel(panel.element, 'Filter files…')).toBeNull()
    } finally { panel.unmount() }
  })
})

describe('parent callbacks that carry operation completion', () => {
  for (const refused of [false, true]) {
    test(`customized launch retains its edited payload and pending dialog until ${refused ? 'refusal' : 'success'}`, async () => {
      const pending = Promise.withResolvers<unknown>()
      const panel = await controlled((fake) => {
        fake.settings['ai-enabled'] = true
        fake.on('quirky.agents/list', () => ({ defaultAgent: 'claude', agents: ['claude', 'codex'].map((id) => ({ id, label: id, installed: true, enabled: true, canGenerate: true, isDefault: id === 'claude' })) }))
        fake.on('quirky.session/list', () => [])
        fake.on('quirky.agents/options', (params) => ({
          agent: params.agent, label: params.agent, supported: false, models: [], unlisted: 'accept', unlistedOptions: [], structured: false,
          extraArgs: { supported: true, allowed: '--model', placeholder: '--model', message: null }
        }))
        fake.on('quirky.git/aiFixPreview', () => ({
          prompt: 'Fix prompt',
          recipe: { action: 'fixCommitFailure', agent: null, args: '', template: '{basePrompt}', launchOptions: {}, sources: { agent: 'default', args: 'default', template: 'default', launchOptions: 'default' } }
        }))
        fake.on('quirky.git/commit', () => { throw failure('Commit fixture failed.', { reason: 'hook', summary: 'Commit fixture failed.', output: 'fixture output' }) })
        fake.on('quirky.git/aiFix', () => pending.promise)
      })
      try {
        await type(message(panel.element), 'commit before customizing')
        await click(primary(panel.element))
        expect(await panel.send(panel.address('ai-customize'), 'ai-customize', { action: 'fixCommitFailure' })).toEqual({ delivered: true })
        const launch = dialog()!
        expect(launch).not.toBeNull()
        const agent = byLabel(launch, 'Agent') as HTMLSelectElement
        await act(async () => { agent.value = 'codex'; agent.dispatchEvent(new Event('change', { bubbles: true })) })
        await settle()
        await type(byLabel(launch, 'CLI arguments') as HTMLInputElement, '--model gpt-5.4')
        await type(byLabel(launch, 'Prompt template') as HTMLTextAreaElement, 'Fix prompt\nKeep the change small.')
        const start = buttonText(launch, 'Save & start agent') as HTMLButtonElement
        const bridges = panel.fake.called('ui.window.command.run').length
        await click(start)
        expect(panel.fake.called('quirky.git/aiFix').map((call) => call.params)).toEqual([{
          worktree: 'feat', action: 'fixCommitFailure', agent: 'codex', args: '--model gpt-5.4', template: '{basePrompt}\nKeep the change small.', launchOptions: null, save: 'repo'
        }])
        expect(panel.fake.called('ui.window.command.run')).toHaveLength(bridges + 1)
        expect(panel.fake.called('ui.window.command.run')[bridges]).toEqual({
          method: 'ui.window.command.run',
          params: {
            connId: 22,
            id: 'command:quirky.git/ui-control',
            args: {
              surface: 'panel:quirky.git/source-control',
              target: 'ai-launch:feat:fixCommitFailure',
              generation: expect.stringMatching(/^ai-\d+$/),
              action: 'start'
            }
          }
        })
        expect(dialog()).toBe(launch)
        expect(start.textContent).toBe('Save & start agent')
        expect(start.disabled).toBe(true)
        if (refused) await act(async () => pending.reject(new Error('fixture launch refused')))
        else await act(async () => pending.resolve({ session: 'fixture', agent: 'codex' }))
        await settle()
        if (refused) {
          expect(dialog()).toBe(launch)
          expect(launch.textContent).toContain('fixture launch refused')
          expect(start.disabled).toBe(false)
          expect((byLabel(launch, 'Prompt template') as HTMLTextAreaElement).value).toBe('Fix prompt\nKeep the change small.')
        } else expect(dialog()).toBeNull()
      } finally { panel.unmount() }
    })
  }

  for (const failed of [false, true]) {
    test(`capped status Retry awaits its single read through pending and slow states on ${failed ? 'failure' : 'success'}`, async () => {
      const panel = await controlled((fake) => { fake.status = statusOf([entry('a.ts')], { capped: true }) })
      const pending = Promise.withResolvers<unknown>()
      const originalTimeout = globalThis.setTimeout
      let showSlow: (() => void) | undefined
      try {
        const retry = buttonText(panel.element, 'Retry') as HTMLButtonElement
        const before = panel.fake.called('quirky.git/status').length
        const bridges = panel.fake.called('ui.window.command.run').length
        panel.fake.on('quirky.git/status', () => pending.promise)
        globalThis.setTimeout = ((handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
          if (delay === 1000) showSlow = () => handler(...args)
          return originalTimeout(handler, delay, ...args)
        }) as typeof setTimeout
        await click(retry)
        expect(retry.disabled).toBe(true)
        expect(panel.fake.called('quirky.git/status')).toHaveLength(before + 1)
        await click(retry)
        expect(panel.fake.called('quirky.git/status')).toHaveLength(before + 1)
        expect(panel.fake.called('ui.window.command.run')).toHaveLength(bridges)
        expect(showSlow).toBeDefined()
        await act(async () => showSlow!())
        expect(byLabel(panel.element, 'Refreshing')).not.toBeNull()
        expect(retry.disabled).toBe(true)
        if (failed) await act(async () => pending.reject(new Error('fixture status refused')))
        else await act(async () => pending.resolve(panel.fake.status))
        await settle()
        expect(byLabel(panel.element, 'Refreshing')).toBeNull()
        expect(retry.disabled).toBe(false)
        if (failed) {
          expect(panel.fake.toasts.at(-1)).toEqual(['Could not refresh Source Control', 'Try again.'])
          expect(panel.fake.toastOptions.at(-1)).toMatchObject({ kind: 'error' })
        }
      } finally { globalThis.setTimeout = originalTimeout; panel.unmount() }
    })
  }
})

describe('notice command leases', () => {
  async function failedStageNotice() {
    const panel = await controlled((fake) => fake.on('quirky.git/stage', () => { throw failure('fixture stage failed') }))
    await panel.send(panel.address('row-menu-open'), 'row-menu-open', { path: 'dir/b.ts' })
    await panel.send(panel.address('stage'), 'stage')
    expect(noticeOf(panel.element)?.getAttribute('role')).toBe('alert')
    expect(noticeOf(panel.element)?.classList.contains('ui-toast--failing')).toBe(true)
    return panel
  }

  test('refused Retry delivery retains the notice and posts no automatic second dismissal', async () => {
    const panel = await failedStageNotice()
    try {
      const bridges = panel.fake.called('ui.window.command.run').length
      const stageCalls = panel.fake.called('quirky.git/stage').length
      const toasts = panel.fake.toasts.length
      panel.fake.on('ui.window.command.run', () => ({ result: { delivered: false } }))
      await click(buttonText(noticeOf(panel.element)!, 'Retry'))
      expect(panel.fake.called('ui.window.command.run')).toHaveLength(bridges + 1)
      expect(panel.fake.called('quirky.git/stage')).toHaveLength(stageCalls)
      expect(noticeOf(panel.element)).not.toBeNull()
      expect(panel.fake.toasts).toHaveLength(toasts + 1)
      expect(panel.fake.toastOptions.at(-1)).toMatchObject({ kind: 'error' })
    } finally { panel.unmount() }
  })

  test('replaced notices refuse an old Retry and expiry is checked before timer rendering', async () => {
    const panel = await failedStageNotice()
    const now = Date.now
    try {
      const old = panel.address('run')
      expect(await panel.send(old, 'run', { label: 'Retry' })).toEqual({ delivered: true })
      const current = panel.address('run')
      expect(current.generation).not.toBe(old.generation)
      const before = panel.fake.called('quirky.git/stage').length
      expect(await panel.send(old, 'run', { label: 'Retry' })).toEqual({ delivered: false })
      const began = now()
      Date.now = () => began + 10_001
      expect(await panel.send(current, 'run', { label: 'Retry' })).toEqual({ delivered: false })
      expect(panel.fake.called('quirky.git/stage')).toHaveLength(before)
    } finally { Date.now = now; panel.unmount() }
  })

  test('away and disposed panel notices cannot delegate a saved Retry even after returning', async () => {
    const panel = await failedStageNotice()
    try {
      const old = panel.address('run')
      const before = panel.fake.called('quirky.git/stage').length
      await act(async () => panel.fake.setLayout(layoutFor('other')))
      await settle()
      expect(await panel.send(old, 'run', { label: 'Retry' })).toEqual({ delivered: false })
      await act(async () => panel.fake.setLayout(layoutFor('feat')))
      await settle()
      expect(await panel.send(old, 'run', { label: 'Retry' })).toEqual({ delivered: false })
      expect(panel.fake.called('quirky.git/stage')).toHaveLength(before)
    } finally { panel.unmount() }
  })

  test('bulk revert failure is a failing shared notice even without a Failed title prefix', async () => {
    const panel = await controlled((fake) => fake.on('quirky.git/discard', () => { throw failure('fixture revert failed') }))
    try {
      await panel.send(panel.address('revert-all'), 'revert-all')
      await panel.send(panel.address('confirm'), 'confirm')
      expect(noticeOf(panel.element)?.textContent).toContain('Revert all stopped')
      expect(noticeOf(panel.element)?.getAttribute('role')).toBe('alert')
      expect(noticeOf(panel.element)?.classList.contains('ui-toast--failing')).toBe(true)
      const retry = panel.address('run')
      panel.fake.status = statusOf([entry('new.ts')])
      await act(async () => panel.fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
      await settle()
      const before = panel.fake.called('quirky.git/discard').length
      expect(await panel.send(retry, 'run', { label: 'Retry' })).toEqual({ delivered: false })
      expect(panel.fake.called('quirky.git/discard')).toHaveLength(before)
    } finally { panel.unmount() }
  })
})

test('base changes await the real status/compare refresh before review refresh and close', async () => {
  const panel = await controlled()
  const pending = Promise.withResolvers<unknown>()
  try {
    await panel.send(panel.address('change-base'), 'change-base')
    const base = dialog()!
    const usePrimary = buttonText(base, 'Use Primary') as HTMLButtonElement
    const reviewReads = panel.fake.called('quirky.git/review').length
    const bridges = panel.fake.called('ui.window.command.run').length
    panel.fake.on('quirky.git/status', () => pending.promise)
    await click(usePrimary)
    expect(panel.fake.called('quirky.git/setBase').at(-1)?.params).toEqual({ worktree: 'feat', clear: true })
    expect(dialog()).toBe(base)
    expect(usePrimary.disabled).toBe(true)
    expect(panel.fake.called('quirky.git/review')).toHaveLength(reviewReads)
    expect(panel.fake.called('ui.window.command.run')).toHaveLength(bridges)
    await act(async () => pending.resolve(panel.fake.status))
    await settle()
    expect(panel.fake.called('quirky.git/review')).toHaveLength(reviewReads + 1)
    expect(dialog()).toBeNull()
  } finally { panel.unmount() }
})

test('a review hash read cannot mark a replacement worktree session after A to B to A', async () => {
  const hash = Promise.withResolvers<unknown>()
  const panel = await controlled((fake) => fake.on('quirky.git/diff', () => hash.promise))
  try {
    expect(await panel.send(panel.address('row-toggle-mark'), 'row-toggle-mark', { path: 'a.ts' })).toEqual({ delivered: true })
    expect(panel.fake.called('quirky.git/diff')).toHaveLength(1)
    await act(async () => panel.fake.setLayout(layoutFor('other')))
    await settle()
    await act(async () => panel.fake.setLayout(layoutFor('feat')))
    await settle()
    await act(async () => hash.resolve({ modifiedHash: 'fixture-hash' }))
    await settle()
    expect(panel.fake.called('quirky.git/setReviewMark')).toEqual([])
    expect(panel.fake.toasts).toEqual([])
  } finally { panel.unmount() }
})

test('ship-step validates its captured kind and busy state rather than substituting the new step', async () => {
  const panel = await controlled()
  try {
    const address = panel.address('ship-step')
    panel.fake.status = statusOf([], { upstreamStatus: upstream(1, 0) })
    panel.fake.compare = SOMETHING_TO_SHIP
    await act(async () => panel.fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    expect(await panel.send(address, 'ship-step', { kind: 'commit-staged', message: 'stale commit' })).toEqual({ delivered: false })
    expect(panel.fake.called('quirky.git/commit')).toEqual([])
    expect(panel.fake.called('quirky.git/push')).toEqual([])
    panel.fake.status = { ...panel.fake.status, busy: 'fetch' }
    await act(async () => panel.fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
    await settle()
    expect(await panel.send(address, 'ship-step', { kind: 'push' })).toEqual({ delivered: false })
    expect(panel.fake.called('quirky.git/push')).toEqual([])
  } finally { panel.unmount() }
})

test('a force-push confirmation never substitutes a changed pull-request lease', async () => {
  let target = {
    ready: true, remote: 'fork', branch: 'zoe/feat', localBranch: 'zoe/feat', localHead: 'a'.repeat(40),
    headOid: 'c'.repeat(40), number: 7, fork: true, repository: { host: 'github.com', owner: 'zoe', repo: 'project' }
  }
  const panel = await controlled((fake) => {
    fake.status = statusOf([], { upstreamStatus: upstream(2, 2, true) })
    fake.compare = SOMETHING_TO_SHIP
    fake.on('quirky.hosting/forBranch', () => ({ kind: 'found', review: { number: 7, url: 'https://github.com/zoe/project/pull/7', state: 'open' } }))
    fake.on('quirky.git/pushTarget', () => target)
  })
  try {
    await panel.send(panel.address('ship-step'), 'ship-step', { kind: 'push' })
    const confirm = panel.address('confirm')
    expect(dialog()?.textContent).toContain('c'.repeat(40))
    target = { ...target, headOid: 'd'.repeat(40) }
    await panel.send(confirm, 'confirm')
    expect(panel.fake.called('quirky.git/forcePush')).toEqual([])
    expect(panel.fake.called('quirky.git/pushTarget').length).toBeGreaterThanOrEqual(3)
    expect(dialog() !== null || errorLine(panel.element) !== null).toBe(true)
  } finally { panel.unmount() }
})

test('branch A to B to A replaces ownership without resurrecting the original address', async () => {
  const panel = await controlled()
  try {
    const first = panel.address('filter-open')
    for (const branch of ['zoe/other', 'zoe/feat']) {
      panel.fake.status = { ...panel.fake.status, branch }
      await act(async () => panel.fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
      await settle()
      expect(panel.address('filter-open').generation).not.toBe(first.generation)
    }
    expect(await panel.send(first, 'filter-open')).toEqual({ delivered: false })
    expect(byLabel(panel.element, 'Filter files…')).toBeNull()
  } finally { panel.unmount() }
})

test('commanded ship messages are trimmed, validated and never coerced', async () => {
  const panel = await controlled()
  try {
    const address = panel.address('ship-step')
    expect(await panel.send(address, 'ship-step', { kind: 'commit-staged', message: 17 })).toEqual({ delivered: false })
    expect(panel.fake.called('quirky.git/commit')).toEqual([])
    expect(await panel.send(address, 'ship-step', { kind: 'commit-staged', message: '  Commanded commit  ' })).toEqual({ delivered: true })
    expect(panel.fake.called('quirky.git/commit').map((call) => call.params)).toEqual([{ worktree: 'feat', message: 'Commanded commit' }])
    await panel.send(address, 'ship-step', { kind: 'commit-staged', message: '   ' })
    expect(panel.fake.called('quirky.git/commit')).toHaveLength(1)
    expect(errorLine(panel.element)?.textContent).toContain('Write a commit message, or click ✦')
    expect(document.activeElement).toBe(message(panel.element))
  } finally { panel.unmount() }
})

test('same-turn default AI requests reserve one launch without customized launch parameters', async () => {
  const pending = Promise.withResolvers<unknown>()
  const panel = await controlled((fake) => {
    fake.settings['ai-enabled'] = true
    fake.status = statusOf([entry('conflict.ts', 'conflicts', 'modified', { conflict: { kind: 'both_modified', state: 'unresolved' } })], { operation: 'merge' })
    fake.on('quirky.git/aiFix', () => pending.promise)
  })
  try {
    const address = panel.address('ai-fix')
    const args = { surface: address.surface, target: address.target, generation: address.generation, action: 'ai-fix', data: { action: 'resolveConflicts' } }
    let results: GitUiControlResult[] = []
    await act(async () => { results = [panel.dispatch(args), panel.dispatch(args)] })
    await settle()
    expect(results).toEqual([{ delivered: true }, { delivered: false }])
    expect(panel.fake.called('quirky.git/aiFix').map((call) => call.params)).toEqual([{ worktree: 'feat', action: 'resolveConflicts' }])
    await act(async () => pending.resolve({ session: 'fixture', agent: 'codex' }))
    await settle()
  } finally { panel.unmount() }
})

test('reported ship-error addresses support commands without private state and reject replaced errors', async () => {
  const panel = await controlled((fake) => fake.on('quirky.git/commit', () => {
    throw failure('fixture commit failed', { reason: 'hook', summary: 'fixture commit failed', output: 'fixture hook output' })
  }))
  try {
    await type(message(panel.element), 'keep the draft')
    await click(primary(panel.element))
    const first = panel.address('ship-error-dismiss')
    expect(await panel.send(first, 'ship-error-dismiss')).toEqual({ delivered: true })
    expect(errorLine(panel.element)).toBeNull()
    await click(primary(panel.element))
    const current = panel.address('ship-error-dismiss')
    expect([current.target, current.generation]).not.toEqual([first.target, first.generation])
    expect(await panel.send(first, 'ship-error-dismiss')).toEqual({ delivered: false })
    expect(errorLine(panel.element)?.textContent).toContain('fixture commit failed')
    expect(await panel.send(current, 'ship-error-dismiss')).toEqual({ delivered: true })
    expect(errorLine(panel.element)).toBeNull()
  } finally { panel.unmount() }
})

test('refused base-dialog Close retains its draft and leaves the original completion callback usable', async () => {
  const panel = await controlled()
  try {
    await panel.send(panel.address('change-base'), 'change-base')
    const base = dialog()!
    await type(byLabel(base, 'Search branches') as HTMLInputElement, 'keep this search')
    panel.fake.on('ui.window.command.run', () => { throw new Error('fixture close refused') })
    await click(buttonText(base, 'Close'))
    expect(dialog()).toBe(base)
    expect((byLabel(base, 'Search branches') as HTMLInputElement).value).toBe('keep this search')
    expect(panel.fake.toastOptions.at(-1)).toMatchObject({ kind: 'error' })
    panel.fake.on('ui.window.command.run', (params) => ({ result: panel.dispatch(params.args) }))
    await click(buttonText(base, 'Use Primary'))
    expect(panel.fake.called('quirky.git/setBase')).toHaveLength(1)
    expect(dialog()).toBeNull()
  } finally { panel.unmount() }
})

type ControlledPanel = {
  fake: Fake
  element: HTMLElement
  unmount: () => void
  controls: () => ControlAddress[]
  address: (action: string) => ControlAddress
  send: (control: ControlAddress, action: string, data?: Record<string, unknown>) => Promise<{ delivered: boolean }>
}

const refreshControlled = async (panel: ControlledPanel) => {
  await act(async () => panel.fake.emit({ type: 'quirky.git/changed', data: { worktreeId: 'feat' } }))
  await settle()
}

const failedReviewMarkRetry = async () => {
  const panel = await controlled((fake) => {
    fake.on('quirky.git/diff', () => ({ modifiedHash: 'fixture-hash' }))
    fake.on('quirky.git/setReviewMark', () => { throw failure('fixture mark failed') })
  })
  expect(await panel.send(panel.address('row-toggle-mark'), 'row-toggle-mark', { path: 'a.ts' })).toEqual({ delivered: true })
  expect(noticeOf(panel.element)?.getAttribute('role')).toBe('alert')
  return { panel, retry: panel.address('run') }
}

const cancelConfirmationIfOpen = async (panel: ControlledPanel) => {
  if (panel.controls().some((control) => control.actions.includes('cancel'))) {
    await panel.send(panel.address('confirm'), 'cancel')
  }
}

const readyPushTarget = {
  ready: true,
  remote: 'fork',
  branch: 'zoe/feat',
  localBranch: 'zoe/feat',
  localHead: 'a'.repeat(40),
  headOid: 'c'.repeat(40),
  number: 7,
  fork: true,
  repository: { host: 'github.com', owner: 'zoe', repo: 'project' }
}

const configureForcePush = (fake: Fake, pushTarget: () => unknown, forcePush?: () => unknown) => {
  fake.status = statusOf([], { upstreamStatus: upstream(2, 2, true) })
  fake.compare = SOMETHING_TO_SHIP
  fake.on('quirky.hosting/forBranch', () => ({
    kind: 'found',
    review: { number: 7, url: 'https://github.com/zoe/project/pull/7', state: 'open' }
  }))
  fake.on('quirky.git/pushTarget', pushTarget)
  if (forcePush !== undefined) fake.on('quirky.git/forcePush', forcePush)
}

test('a held review hash cannot mark a row removed by a same-worktree refresh', async () => {
  const hash = Promise.withResolvers<unknown>()
  const panel = await controlled((fake) => fake.on('quirky.git/diff', () => hash.promise))
  try {
    expect(q(panel.element, '[data-row-path="a.ts"]')).not.toBeNull()
    expect(await panel.send(panel.address('row-toggle-mark'), 'row-toggle-mark', { path: 'a.ts' })).toEqual({ delivered: true })
    panel.fake.status = statusOf([entry('dir/b.ts')])
    await refreshControlled(panel)
    expect(q(panel.element, '[data-row-path="a.ts"]')).toBeNull()
    await act(async () => hash.resolve({ modifiedHash: 'fixture-hash' }))
    await settle()
    expect(panel.fake.called('quirky.git/setReviewMark')).toEqual([])
  } finally {
    await act(async () => hash.resolve({ modifiedHash: 'fixture-hash' }))
    await settle()
    panel.unmount()
  }
})

test('a held review hash cannot mark a row whose review mark changed while it was loading', async () => {
  const hash = Promise.withResolvers<unknown>()
  const panel = await controlled((fake) => fake.on('quirky.git/diff', () => hash.promise))
  try {
    expect(await panel.send(panel.address('row-toggle-mark'), 'row-toggle-mark', { path: 'a.ts' })).toEqual({ delivered: true })
    panel.fake.marks['a.ts'] = 'reviewed'
    await refreshControlled(panel)
    const row = q(panel.element, '[data-row-path="a.ts"]')
    expect(row).not.toBeNull()
    expect(q(row!, '.git-row__mark [role="img"]')?.getAttribute('aria-label')).toBe('Reviewed')
    await act(async () => hash.resolve({ modifiedHash: 'fixture-hash' }))
    await settle()
    expect(panel.fake.called('quirky.git/setReviewMark')).toEqual([])
  } finally {
    await act(async () => hash.resolve({ modifiedHash: 'fixture-hash' }))
    await settle()
    panel.unmount()
  }
})

test('a held review hash cannot mark a row that becomes conflicted while it was loading', async () => {
  const hash = Promise.withResolvers<unknown>()
  const panel = await controlled((fake) => fake.on('quirky.git/diff', () => hash.promise))
  try {
    expect(await panel.send(panel.address('row-toggle-mark'), 'row-toggle-mark', { path: 'a.ts' })).toEqual({ delivered: true })
    panel.fake.status = statusOf([
      entry('a.ts', 'conflicts', 'modified', { conflict: { kind: 'both_modified', state: 'unresolved' } }),
      entry('dir/b.ts')
    ], { operation: 'merge' })
    await refreshControlled(panel)
    const row = q(panel.element, '[data-row-path="a.ts"]')
    expect(row).not.toBeNull()
    expect(q(row!, '[aria-label="Unresolved conflict (Both modified)"]')).not.toBeNull()
    await act(async () => hash.resolve({ modifiedHash: 'fixture-hash' }))
    await settle()
    expect(panel.fake.called('quirky.git/setReviewMark')).toEqual([])
  } finally {
    await act(async () => hash.resolve({ modifiedHash: 'fixture-hash' }))
    await settle()
    panel.unmount()
  }
})

test('a failed review-mark Retry refuses a row removed in the same worktree', async () => {
  const { panel, retry } = await failedReviewMarkRetry()
  try {
    const calls = panel.fake.called('quirky.git/setReviewMark').length
    panel.fake.status = statusOf([entry('dir/b.ts')])
    await refreshControlled(panel)
    expect(q(panel.element, '[data-row-path="a.ts"]')).toBeNull()
    expect(await panel.send(retry, 'run', { label: 'Retry' })).toEqual({ delivered: false })
    expect(panel.fake.called('quirky.git/setReviewMark')).toHaveLength(calls)
  } finally { panel.unmount() }
})

test('a failed review-mark Retry refuses a row that is already reviewed', async () => {
  const { panel, retry } = await failedReviewMarkRetry()
  try {
    const calls = panel.fake.called('quirky.git/setReviewMark').length
    panel.fake.marks['a.ts'] = 'reviewed'
    await refreshControlled(panel)
    const row = q(panel.element, '[data-row-path="a.ts"]')
    expect(row).not.toBeNull()
    expect(q(row!, '.git-row__mark [role="img"]')?.getAttribute('aria-label')).toBe('Reviewed')
    expect(await panel.send(retry, 'run', { label: 'Retry' })).toEqual({ delivered: false })
    expect(panel.fake.called('quirky.git/setReviewMark')).toHaveLength(calls)
  } finally { panel.unmount() }
})

test('a failed Stage Retry refuses a row removed in the same worktree', async () => {
  const panel = await controlled((fake) => fake.on('quirky.git/stage', () => { throw failure('fixture stage failed') }))
  try {
    await panel.send(panel.address('row-menu-open'), 'row-menu-open', { path: 'dir/b.ts' })
    await panel.send(panel.address('stage'), 'stage')
    const retry = panel.address('run')
    const calls = panel.fake.called('quirky.git/stage').length
    panel.fake.status = statusOf([entry('a.ts', 'staged')])
    await refreshControlled(panel)
    expect(q(panel.element, '[data-row-path="dir/b.ts"]')).toBeNull()
    expect(q(panel.element, '[data-row-path="a.ts"]')).not.toBeNull()
    expect(await panel.send(retry, 'run', { label: 'Retry' })).toEqual({ delivered: false })
    expect(panel.fake.called('quirky.git/stage')).toHaveLength(calls)
  } finally { panel.unmount() }
})

test('a failed Unstage Retry refuses a visible row while the worktree is busy fetching', async () => {
  const panel = await controlled((fake) => fake.on('quirky.git/unstage', () => { throw failure('fixture unstage failed') }))
  try {
    await panel.send(panel.address('row-menu-open'), 'row-menu-open', { path: 'a.ts' })
    await panel.send(panel.address('unstage'), 'unstage')
    const retry = panel.address('run')
    const calls = panel.fake.called('quirky.git/unstage').length
    panel.fake.status = { ...panel.fake.status, busy: 'fetch' }
    await refreshControlled(panel)
    expect(q(panel.element, '[data-row-path="a.ts"]')).not.toBeNull()
    expect(primary(panel.element).getAttribute('aria-busy')).toBe('true')
    expect(await panel.send(retry, 'run', { label: 'Retry' })).toEqual({ delivered: false })
    expect(panel.fake.called('quirky.git/unstage')).toHaveLength(calls)
  } finally { panel.unmount() }
})

test('a delayed submodule read cannot populate a replacement submodule at the same path', async () => {
  const oldRead = Promise.withResolvers<unknown>()
  const oldSubmodule = { commitChanged: false, trackedChanges: true, untrackedChanges: false }
  const newSubmodule = { commitChanged: true, trackedChanges: false, untrackedChanges: false }
  let reads = 0
  const panel = await controlled((fake) => {
    fake.status = statusOf([entry('vendor/lib', 'unstaged', 'modified', { submodule: oldSubmodule })])
    fake.on('quirky.git/submoduleStatus', () => {
      reads++
      return reads === 1 ? oldRead.promise : { entries: [entry('current-child.ts')] }
    })
  })
  try {
    await click(byLabel(panel.element, 'Expand vendor/lib'))
    expect(panel.fake.called('quirky.git/submoduleStatus')).toHaveLength(1)
    panel.fake.status = statusOf([])
    await refreshControlled(panel)
    expect(q(panel.element, '[data-row-path="vendor/lib"]')).toBeNull()
    panel.fake.status = statusOf([entry('vendor/lib', 'unstaged', 'modified', { submodule: newSubmodule })])
    await refreshControlled(panel)
    expect(q(panel.element, '[data-row-path="vendor/lib"]')).not.toBeNull()
    const collapse = byLabel(panel.element, 'Collapse vendor/lib')
    if (collapse) await click(collapse)
    await click(byLabel(panel.element, 'Expand vendor/lib'))
    await settle()
    expect(panel.fake.called('quirky.git/submoduleStatus')).toHaveLength(2)
    const names = () => [...panel.element.querySelectorAll<HTMLElement>('[data-submodule-entry] [data-row-name]')].map((node) => node.textContent)
    expect(names()).toEqual(['current-child.ts'])
    await act(async () => oldRead.resolve({ entries: [entry('stale-child.ts')] }))
    await settle()
    expect(names()).toEqual(['current-child.ts'])
  } finally {
    await act(async () => oldRead.resolve({ entries: [entry('stale-child.ts')] }))
    await settle()
    panel.unmount()
  }
})

test('force-push reservation survives a held target read and confirmation, then releases on cancellation', async () => {
  const heldTarget = Promise.withResolvers<unknown>()
  let targetReads = 0
  const panel = await controlled((fake) => configureForcePush(fake, () => {
    targetReads++
    return targetReads === 2 ? heldTarget.promise : readyPushTarget
  }))
  try {
    expect(targetReads).toBe(1)
    const step = panel.address('ship-step')
    expect(await panel.send(step, 'ship-step', { kind: 'push' })).toEqual({ delivered: true })
    expect(targetReads).toBe(2)
    expect(await panel.send(step, 'ship-step', { kind: 'push' })).toEqual({ delivered: false })
    expect(targetReads).toBe(2)
    expect(panel.fake.called('quirky.git/forcePush')).toEqual([])
    expect(panel.controls().some((control) => control.actions.includes('confirm'))).toBe(false)

    await act(async () => heldTarget.resolve(readyPushTarget))
    await settle()
    const confirm = panel.address('confirm')
    const generation = confirm.generation
    expect(dialog()?.textContent).toContain('c'.repeat(40))
    expect(await panel.send(step, 'ship-step', { kind: 'push' })).toEqual({ delivered: false })
    expect(targetReads).toBe(2)
    expect(panel.fake.called('quirky.git/forcePush')).toEqual([])
    expect(panel.address('confirm').generation).toBe(generation)

    expect(await panel.send(confirm, 'cancel')).toEqual({ delivered: true })
    await settle()
    expect(dialog()).toBeNull()
    expect(await panel.send(step, 'ship-step', { kind: 'push' })).toEqual({ delivered: true })
    expect(targetReads).toBe(3)
    const nextConfirm = panel.address('confirm')
    expect(nextConfirm.generation).not.toBe(generation)
    await panel.send(nextConfirm, 'cancel')
  } finally {
    await act(async () => heldTarget.resolve(readyPushTarget))
    await settle()
    await cancelConfirmationIfOpen(panel)
    panel.unmount()
  }
})

test('force-push reservation releases after prerequisite failure, operation failure and success', async () => {
  const heldPush = Promise.withResolvers<unknown>()
  let targetReads = 0
  let pushes = 0
  const panel = await controlled((fake) => configureForcePush(fake, () => {
    targetReads++
    if (targetReads === 2) throw failure('fixture target read failed')
    return readyPushTarget
  }, () => {
    pushes++
    return pushes === 1 ? heldPush.promise : { ok: true }
  }))
  try {
    const step = panel.address('ship-step')
    expect(await panel.send(step, 'ship-step', { kind: 'push' })).toEqual({ delivered: true })
    expect(targetReads).toBe(2)
    expect(dialog()).toBeNull()

    expect(await panel.send(step, 'ship-step', { kind: 'push' })).toEqual({ delivered: true })
    expect(targetReads).toBe(3)
    await panel.send(panel.address('confirm'), 'cancel')
    await settle()
    expect(dialog()).toBeNull()

    expect(await panel.send(step, 'ship-step', { kind: 'push' })).toEqual({ delivered: true })
    expect(targetReads).toBe(4)
    expect(await panel.send(panel.address('confirm'), 'confirm')).toEqual({ delivered: true })
    await settle()
    expect(targetReads).toBe(5)
    expect(pushes).toBe(1)
    expect(await panel.send(step, 'ship-step', { kind: 'push' })).toEqual({ delivered: false })
    expect(targetReads).toBe(5)
    expect(pushes).toBe(1)

    await act(async () => heldPush.reject(failure('fixture force push failed')))
    await settle()
    expect(dialog()).toBeNull()
    expect(await panel.send(step, 'ship-step', { kind: 'push' })).toEqual({ delivered: true })
    expect(targetReads).toBe(6)
    expect(await panel.send(panel.address('confirm'), 'confirm')).toEqual({ delivered: true })
    await settle()
    expect(targetReads).toBe(7)
    expect(pushes).toBe(2)
    expect(dialog()).toBeNull()

    expect(await panel.send(step, 'ship-step', { kind: 'push' })).toEqual({ delivered: true })
    expect(targetReads).toBe(8)
    await panel.send(panel.address('confirm'), 'cancel')
    await settle()
    expect(dialog()).toBeNull()
  } finally {
    await act(async () => heldPush.resolve({ ok: true }))
    await settle()
    await cancelConfirmationIfOpen(panel)
    panel.unmount()
  }
})

for (const verb of ['stage', 'unstage'] as const) {
  test(`a failed ${verb} Retry refuses a visible row whose staging eligibility changed`, async () => {
    const path = verb === 'stage' ? 'dir/b.ts' : 'a.ts'
    const panel = await controlled((fake) => fake.on(`quirky.git/${verb}`, () => { throw failure('fixture mutation failed') }))
    try {
      await panel.send(panel.address('row-menu-open'), 'row-menu-open', { path })
      await panel.send(panel.address(verb), verb)
      const retry = panel.address('run')
      const calls = panel.fake.called(`quirky.git/${verb}`).length
      panel.fake.status = statusOf([entry(path, verb === 'stage' ? 'staged' : 'unstaged')])
      await refreshControlled(panel)
      expect(q(panel.element, `[data-row-path="${path}"]`)).not.toBeNull()
      expect(await panel.send(retry, 'run', { label: 'Retry' })).toEqual({ delivered: false })
      expect(panel.fake.called(`quirky.git/${verb}`)).toHaveLength(calls)
    } finally { panel.unmount() }
  })
}

test('a valid review-mark Retry retains its reviewed intent and delegates once', async () => {
  const { panel, retry } = await failedReviewMarkRetry()
  try {
    panel.fake.on('quirky.git/setReviewMark', (params) => {
      expect(params).toMatchObject({ worktree: 'feat', path: 'a.ts', reviewed: true, expected: 'fixture-hash' })
      panel.fake.marks['a.ts'] = 'reviewed'
      return { mark: 'reviewed' }
    })
    expect(await panel.send(retry, 'run', { label: 'Retry' })).toEqual({ delivered: true })
    expect(panel.fake.called('quirky.git/setReviewMark')).toHaveLength(2)
    expect(q(q(panel.element, '[data-row-path="a.ts"]')!, '.git-row__mark [role="img"]')?.getAttribute('aria-label')).toBe('Reviewed')
  } finally { panel.unmount() }
})

test('an identical submodule recreated after removal does not inherit the old read or expansion', async () => {
  const oldRead = Promise.withResolvers<unknown>()
  const submodule = { commitChanged: false, trackedChanges: true, untrackedChanges: false }
  let reads = 0
  const panel = await controlled((fake) => {
    fake.status = statusOf([entry('vendor/lib', 'unstaged', 'modified', { submodule })])
    fake.on('quirky.git/submoduleStatus', () => ++reads === 1 ? oldRead.promise : { entries: [entry('current-child.ts')] })
  })
  try {
    await click(byLabel(panel.element, 'Expand vendor/lib'))
    panel.fake.status = statusOf([])
    await refreshControlled(panel)
    panel.fake.status = statusOf([entry('vendor/lib', 'unstaged', 'modified', { submodule })])
    await refreshControlled(panel)
    expect(byLabel(panel.element, 'Expand vendor/lib')).not.toBeNull()
    await click(byLabel(panel.element, 'Expand vendor/lib'))
    expect(panel.fake.called('quirky.git/submoduleStatus')).toHaveLength(2)
    await act(async () => oldRead.resolve({ entries: [entry('stale-child.ts')] }))
    await settle()
    expect([...panel.element.querySelectorAll('[data-submodule-entry] [data-row-name]')].map(node => node.textContent)).toEqual(['current-child.ts'])
  } finally {
    await act(async () => oldRead.resolve({ entries: [] }))
    panel.unmount()
  }
})
const heldRowOpenSpace = async (priorSelection: 'b.ts' | null) => {
  const panel = await controlled((fake) => {
    fake.status = statusOf([entry('a.ts'), entry('b.ts')])
    fake.marks['a.ts'] = 'reviewed'
  })
  const heldSelf = Promise.withResolvers<unknown>()
  try {
    if (priorSelection !== null) {
      await click(q(panel.element, `[data-row-path="${priorSelection}"]`))
      expect(q(panel.element, `[data-row-path="${priorSelection}"]`)?.getAttribute('aria-selected')).toBe('true')
    }

    const rowOpenAddress = panel.address('row-open')
    const bridgeStart = panel.fake.called('ui.window.command.run')
      .filter(({ params }) => params.id === GIT_UI_CONTROL_COMMAND).length
    let holdingRowOpen = true
    let heldCalls = 0
    panel.fake.on('ui.window.self', () => {
      if (!holdingRowOpen) return { connId: panel.fake.connId }
      holdingRowOpen = false
      heldCalls++
      return heldSelf.promise
    })

    await click(q(panel.element, '[data-row-path="a.ts"]'))
    expect(heldCalls).toBe(1)
    expect(panel.fake.called('ui.window.command.run').filter(({ params }) => params.id === GIT_UI_CONTROL_COMMAND))
      .toHaveLength(bridgeStart)

    expect([...panel.element.querySelectorAll('[data-row-path][aria-selected="true"]')]
      .map((row) => row.getAttribute('data-row-path'))).toEqual(priorSelection === null ? [] : ['b.ts'])


    await press(q(panel.element, '[role="listbox"]')!, ' ')
    expect(panel.fake.called('quirky.git/setReviewMark')).toEqual([])
    await act(async () => heldSelf.resolve({ connId: panel.fake.connId }))
    await settle()

    expect(panel.fake.called('quirky.git/setReviewMark').map(({ params }) => ({
      path: params.path,
      reviewed: params.reviewed
    }))).toEqual([{ path: 'a.ts', reviewed: false }])
    expect(panel.fake.marks['a.ts']).toBe('none')
    expect(panel.fake.marks['b.ts'] ?? 'none').toBe('none')
    expect(q(panel.element, '[data-row-path="a.ts"]')?.getAttribute('aria-selected')).toBe('true')
    expect(q(panel.element, '[data-row-path="b.ts"]')?.getAttribute('aria-selected')).not.toBe('true')

    const routed = panel.fake.called('ui.window.command.run')
      .filter(({ params }) => params.id === GIT_UI_CONTROL_COMMAND)
      .slice(bridgeStart)
    const mainControlAddress = {
      surface: rowOpenAddress.surface,
      target: rowOpenAddress.target,
      generation: rowOpenAddress.generation
    }
    expect(routed.map(({ params }) => ({
      connId: params.connId,
      id: params.id,
      args: params.args
    }))).toEqual([
      {
        connId: panel.fake.connId,
        id: GIT_UI_CONTROL_COMMAND,
        args: { ...mainControlAddress, action: 'row-open', data: { path: 'a.ts' } }
      },
      {
        connId: panel.fake.connId,
        id: GIT_UI_CONTROL_COMMAND,
        args: { ...mainControlAddress, action: 'row-toggle-mark', data: { path: 'a.ts' } }
      }
    ])
  } finally {
    await act(async () => heldSelf.resolve({ connId: panel.fake.connId }))
    await settle()
    panel.unmount()
  }
}

test('Space queued during a held row-open targets the accepted row, not the previous selection', async () => {
  await heldRowOpenSpace('b.ts')
})

test('Space queued during a held row-open targets the accepted row when nothing was selected', async () => {
  await heldRowOpenSpace(null)
})

for (const outcome of ['refused', 'owner-replaced'] as const) {
  test(`queued Space does not act on another row after row-open is ${outcome}`, async () => {
    const panel = await controlled((fake) => {
      fake.status = statusOf([entry('a.ts'), entry('b.ts')])
      fake.marks['a.ts'] = 'reviewed'
    })
    const heldSelf = Promise.withResolvers<unknown>()
    try {
      await click(q(panel.element, '[data-row-path="b.ts"]'))
      const oldGeneration = panel.address('row-open').generation
      let hold = true
      panel.fake.on('ui.window.self', () => {
        if (!hold) return { connId: panel.fake.connId }
        hold = false
        return heldSelf.promise
      })
      if (outcome === 'refused') {
        panel.fake.on('ui.window.command.run', (params) => ({
          result: (params.args as Control).action === 'row-open'
            ? { delivered: false }
            : panel.dispatch(params.args)
        }))
      }
      await click(q(panel.element, '[data-row-path="a.ts"]'))
      await press(q(panel.element, '[role="listbox"]')!, ' ')
      expect(panel.fake.called('quirky.git/setReviewMark')).toEqual([])
      if (outcome === 'owner-replaced') {
        await act(async () => panel.fake.setLayout(layoutFor('other')))
        await settle()
        await act(async () => panel.fake.setLayout(layoutFor('feat')))
        await settle()
        expect(panel.address('row-open').generation).not.toBe(oldGeneration)
        await click(q(panel.element, '[data-row-path="b.ts"]'))
        expect(q(panel.element, '[data-row-path="b.ts"]')?.getAttribute('aria-selected')).toBe('true')
      }
      await act(async () => heldSelf.resolve({ connId: panel.fake.connId }))
      await settle()
      expect(panel.fake.called('quirky.git/setReviewMark')).toEqual([])
      expect(panel.fake.marks['a.ts']).toBe('reviewed')
      expect(panel.fake.marks['b.ts'] ?? 'none').toBe('none')
      expect(q(panel.element, '[data-row-path="b.ts"]')?.getAttribute('aria-selected')).toBe('true')
      expect(panel.fake.called('ui.window.command.run')
        .some(({ params }) => (params.args as Control).action === 'row-toggle-mark')).toBe(false)
      if (outcome === 'refused') {
        expect(panel.fake.toastOptions.at(-1)).toMatchObject({ kind: 'error' })
      } else {
        expect(panel.fake.toasts).toEqual([])
      }
    } finally {
      await act(async () => heldSelf.resolve({ connId: panel.fake.connId }))
      await settle()
      panel.unmount()
    }
  })
}
