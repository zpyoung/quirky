import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'
import type { GitUiControl } from '../../src/ui-control'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// React-bound modules are imported after the DOM is installed so their initialization sees it.
const { act, fakeContext, layoutFor } = await import('./panel-support')
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
