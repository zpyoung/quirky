import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { activate } from '../src/ui'
import type { MountFunction, UiPluginContext } from '@quirky/protocol'
import { ORCHESTRATION_EXAMPLES, createLatestRequestGuard, dismissSetup, isSetupDismissed } from '../src/window/setup-state'

type Status = {
  state: 'missing' | 'stale' | 'ready' | 'partial' | 'error'
  agents: { id: string; label: string; state: 'ready' | 'missing' | 'stale' | 'unsupported' | 'error'; path: string | null; detail: string | null }[]
  installCommand: string
  text: string
}

type FakeUi = {
  context: UiPluginContext
  provided: Map<string, unknown>
  calls: { method: string; params: Record<string, unknown> }[]
  toasts: string[]
  openedViews: string[]
  status: Status
  policy: { nestedWorkerMaxDepth: number; canChange: boolean }
  floating: { enabled: boolean; open: boolean }
  installResult: Status
  dispose(): void
  emit(event: unknown): void
  listenerCount(): number
}

let mounted: (() => void)[] = []
let fake: FakeUi | null = null

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
afterEach(async () => {
  await act(async () => { for (const unmount of mounted.splice(0)) unmount() })
  document.body.innerHTML = ''
  fake?.dispose()
  fake = null
  localStorage.clear()
})

const missing: Status = {
  state: 'missing',
  agents: [{ id: 'claude', label: 'Claude Code', state: 'missing', path: '/private/home/.claude/skills/orchestration/SKILL.md', detail: null }],
  installCommand: 'quirky orchestration skill-install',
  text: 'Install the orchestration skill, then re-check.'
}
const ready: Status = {
  state: 'ready',
  agents: [{ id: 'claude', label: 'Claude Code', state: 'ready', path: '/private/home/.claude/skills/orchestration/SKILL.md', detail: null }],
  installCommand: missing.installCommand,
  text: 'All detected agents have the current orchestration skill.'
}

function makeFake(options: { canChange?: boolean; status?: Status; floating?: { enabled: boolean; open: boolean } } = {}): FakeUi {
  const provided = new Map<string, unknown>()
  const calls: FakeUi['calls'] = []
  const toasts: string[] = []
  const openedViews: string[] = []
  const listeners = new Set<(event: unknown) => void>()
  const result: FakeUi = {
    provided,
    calls,
    toasts,
    openedViews,
    status: options.status ?? missing,
    installResult: ready,
    policy: { nestedWorkerMaxDepth: 1, canChange: options.canChange ?? true },
    floating: options.floating ?? { enabled: true, open: true },
    context: null as unknown as UiPluginContext,
    dispose() { listeners.clear() },
    emit(event: unknown) { for (const listener of listeners) listener(event) },
    listenerCount() { return listeners.size }
  }
  result.context = {
    pluginId: 'quirky.orchestration',
    provide(id: string, implementation: unknown) { provided.set(id, implementation) },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'quirky.orchestration/skillStatus') return result.status
      if (method === 'quirky.orchestration/skillShow') return { skill: '---\nname: orchestration\n---\n' }
      if (method === 'quirky.orchestration/skillInstall') {
        result.status = result.installResult
        return result.installResult
      }
      if (method === 'quirky.orchestration/policyShow') return result.policy
      if (method === 'quirky.orchestration/policySet') {
        result.policy = { nestedWorkerMaxDepth: params.nestedWorkerMaxDepth as number, canChange: result.policy.canChange }
        return result.policy
      }
      if (method === 'quirky.terminal/floating') return result.floating
      throw new Error(`unexpected method ${method}`)
    },
    subscribe(listener: (event: never) => void) {
      listeners.add(listener as (event: unknown) => void)
      return () => listeners.delete(listener as (event: unknown) => void)
    },
    toast(title: string, body: string) { toasts.push(`${title}${body ? `: ${body}` : ''}`) },
    openView(id: string) { openedViews.push(id) },
    async executeCommand(id: string, args?: unknown) {
      const command = provided.get(id)
      if (typeof command !== 'function') throw new Error(`no command ${id}`)
      return (command as (args?: unknown) => unknown)(args)
    },
    log() {}
  } as unknown as UiPluginContext
  fake = result
  activate(result.context)
  return result
}
async function mountSlot(fakeUi: FakeUi, slotId: string): Promise<HTMLElement> {
  const mount = fakeUi.provided.get(slotId) as MountFunction | undefined
  if (!mount) throw new Error(`UI module did not provide ${slotId}`)
  const element = document.createElement('div')
  document.body.append(element)
  let unmount: (() => void) | void = undefined
  await act(async () => { unmount = mount(element, {}) })
  if (typeof unmount === 'function') mounted.push(unmount)
  await act(async () => { await Promise.resolve() })
  return element
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label)
  if (!match) throw new Error(`button not found: ${label}`)
  return match as HTMLButtonElement
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('orchestration setup UI', () => {
  test('settings shows detected coverage and examples, installs only after explicit click, and validates depth', async () => {
    const ui = makeFake()
    const root = await mountSlot(ui, 'view:quirky.orchestration/settings')
    expect(root.textContent).toContain('Claude Code')
    expect(root.textContent).toContain('Missing')
    expect(ui.calls.some((call) => call.method === 'quirky.orchestration/skillInstall')).toBe(false)
    for (const example of ORCHESTRATION_EXAMPLES) {
      expect(root.textContent).toContain(example.title)
      expect(example.prompt).toContain('/orchestration')
    }
    expect(ORCHESTRATION_EXAMPLES).toHaveLength(5)

    await act(async () => { button(root, 'Install').click() })
    expect(ui.calls.some((call) => call.method === 'quirky.orchestration/skillInstall')).toBe(true)
    expect(root.textContent).toContain('Ready')
    const statusReads = ui.calls.filter((call) => call.method === 'quirky.orchestration/skillStatus').length
    await act(async () => { button(root, 'Re-check').click() })
    expect(ui.calls.filter((call) => call.method === 'quirky.orchestration/skillStatus')).toHaveLength(statusReads + 1)

    const depth = root.querySelector('input[aria-label="Nested worker depth"]') as HTMLInputElement | null
    expect(depth).not.toBeNull()
    setInput(depth!, '1.5')
    await act(async () => { button(root, 'Save depth').click() })
    expect(ui.calls.some((call) => call.method === 'quirky.orchestration/policySet')).toBe(false)
    setInput(depth!, '2')
    await act(async () => { button(root, 'Save depth').click() })
    expect(ui.calls.find((call) => call.method === 'quirky.orchestration/policySet')?.params).toEqual({ nestedWorkerMaxDepth: 2 })
  })

  test('stale coverage offers Update and per-agent errors offer Retry', async () => {
    const staleStatus: Status = {
      state: 'stale',
      agents: [{ id: 'claude', label: 'Claude Code', state: 'stale', path: '/private/home/.claude/skills/orchestration/SKILL.md', detail: null }],
      installCommand: 'quirky orchestration skill-install',
      text: 'The installed skill is stale.'
    }
    const staleUi = makeFake({ status: staleStatus })
    const staleRoot = await mountSlot(staleUi, 'view:quirky.orchestration/settings')
    expect(button(staleRoot, 'Update').disabled).toBe(false)
    expect(staleUi.calls.some((call) => call.method === 'quirky.orchestration/skillInstall')).toBe(false)
    await act(async () => { button(staleRoot, 'Update').click() })
    expect(staleUi.calls.some((call) => call.method === 'quirky.orchestration/skillInstall')).toBe(true)

    const errorStatus: Status = {
      state: 'error',
      agents: [{ id: 'codex', label: 'Codex', state: 'error', path: '/private/home/.agents/skills/orchestration/SKILL.md', detail: 'permission denied' }],
      installCommand: 'quirky orchestration skill-install',
      text: 'One target needs attention.'
    }
    const errorUi = makeFake({ status: errorStatus })
    const errorRoot = await mountSlot(errorUi, 'view:quirky.orchestration/settings')
    expect(button(errorRoot, 'Retry').disabled).toBe(false)
    await act(async () => { button(errorRoot, 'Retry').click() })
    expect(errorUi.calls.some((call) => call.method === 'quirky.orchestration/skillInstall')).toBe(true)
  })

  test('empty agent detection explains setup without claiming coverage', async () => {
    const noAgents: Status = {
      state: 'missing',
      agents: [],
      installCommand: 'quirky orchestration skill-install',
      text: 'No agent CLIs detected on PATH. Install agents in Settings → Agents, then re-check.'
    }
    const ui = makeFake({ status: noAgents })
    const root = await mountSlot(ui, 'view:quirky.orchestration/settings')
    expect(root.textContent).toContain('No agent CLIs detected on PATH')
    expect(root.textContent).not.toContain('Ready')
    expect(button(root, 'No installable targets').disabled).toBe(true)
  })

  test('detected agents without a native skill loader stay visibly unsupported', async () => {
    const unsupported: Status = {
      state: 'partial',
      agents: [{ id: 'muse', label: 'Muse', state: 'unsupported', path: null, detail: 'No documented native global skill target exists for this agent.' }],
      installCommand: 'quirky orchestration skill-install',
      text: 'Detected agents have no documented native global skill target.'
    }
    const ui = makeFake({ status: unsupported })
    const root = await mountSlot(ui, 'view:quirky.orchestration/settings')
    expect(root.textContent).toContain('Muse · Unsupported')
    expect(root.textContent).toContain('No documented native global skill target')
    expect(button(root, 'No installable targets').disabled).toBe(true)
  })

  test('each usage example copies its exact /orchestration prompt', async () => {
    const ui = makeFake()
    const root = await mountSlot(ui, 'view:quirky.orchestration/settings')
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied.push(value) } } })
    try {
      for (const example of ORCHESTRATION_EXAMPLES) {
        const copyButton = root.querySelector(`[aria-label="Copy prompt: ${example.title}"]`) as HTMLButtonElement | null
        if (!copyButton) throw new Error(`copy prompt button missing for ${example.title}`)
        await act(async () => { copyButton.click() })
        expect(copied.at(-1)).toBe(example.prompt)
        expect(root.textContent).toContain(`Copied prompt: ${example.title}`)
      }
    } finally {
      if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  test('copy command dialog exposes clipboard success and failure and Done closes it', async () => {
    const ui = makeFake()
    const root = await mountSlot(ui, 'view:quirky.orchestration/settings')
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied.push(value) } } })
    try {
      await act(async () => { button(root, 'Copy command').click() })
      expect(root.textContent).toContain('Install orchestration skill')
      await act(async () => { button(root, 'Copy command to clipboard').click() })
      expect(copied).toEqual(['quirky orchestration skill-install'])
      expect(root.textContent).toContain('Copied install command.')
      await act(async () => { button(root, 'Done').click() })
      expect(root.querySelector('[role="dialog"]')).toBeNull()

      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied') } } })
      await act(async () => { button(root, 'Copy command').click() })
      await act(async () => { button(root, 'Copy command to clipboard').click() })
      expect(root.textContent).toContain('Failed to copy install command.')
    } finally {
      if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  })

  test('paired UI hides mutable depth and async generations reject stale status responses', async () => {
    const ui = makeFake({ canChange: false })
    const root = await mountSlot(ui, 'view:quirky.orchestration/settings')
    expect(root.querySelector('input[aria-label="Nested worker depth"]')).toBeNull()

    const gate = createLatestRequestGuard()
    const older = gate.next()
    const newer = gate.next()
    expect(gate.isCurrent(newer)).toBe(true)
    expect(gate.isCurrent(older)).toBe(false)
    gate.stop()
    expect(gate.isCurrent(newer)).toBe(false)
  })

  test('settings serializes install, recheck, and policy operations until each request settles', async () => {
    const ui = makeFake()
    const root = await mountSlot(ui, 'view:quirky.orchestration/settings')
    const originalCall = ui.context.call.bind(ui.context)
    const deferred = new Map<string, Promise<unknown>>()
    Object.defineProperty(ui.context, 'call', {
      configurable: true,
      value: async (method: string, params: Record<string, unknown> = {}) => {
        const response = deferred.get(method)
        if (response) {
          deferred.delete(method)
          ui.calls.push({ method, params })
          return response
        }
        return originalCall(method, params)
      }
    })

    const depth = root.querySelector('input[aria-label="Nested worker depth"]') as HTMLInputElement | null
    expect(depth).not.toBeNull()

    const installResponse = Promise.withResolvers<Status>()
    deferred.set('quirky.orchestration/skillInstall', installResponse.promise)
    await act(async () => { button(root, 'Install').click() })
    expect(button(root, 'Installing…').disabled).toBe(true)
    expect(button(root, 'Re-check').disabled).toBe(true)
    expect(depth!.disabled).toBe(true)
    expect(button(root, 'Save depth').disabled).toBe(true)
    await act(async () => { button(root, 'Save depth').click() })
    expect(ui.calls.some((call) => call.method === 'quirky.orchestration/policySet')).toBe(false)
    await act(async () => { installResponse.resolve(missing); await installResponse.promise })

    const statusResponse = Promise.withResolvers<Status>()
    deferred.set('quirky.orchestration/skillStatus', statusResponse.promise)
    await act(async () => { button(root, 'Re-check').click() })
    expect(button(root, 'Install').disabled).toBe(true)
    expect(depth!.disabled).toBe(true)
    expect(button(root, 'Save depth').disabled).toBe(true)
    await act(async () => { button(root, 'Save depth').click() })
    expect(ui.calls.some((call) => call.method === 'quirky.orchestration/policySet')).toBe(false)
    await act(async () => { statusResponse.resolve(missing); await statusResponse.promise })

    const policyResponse = Promise.withResolvers<FakeUi['policy']>()
    deferred.set('quirky.orchestration/policySet', policyResponse.promise)
    setInput(depth!, '2')
    await act(async () => { button(root, 'Save depth').click() })
    expect(button(root, 'Install').disabled).toBe(true)
    expect(button(root, 'Re-check').disabled).toBe(true)
    expect(depth!.disabled).toBe(true)
    await act(async () => { policyResponse.resolve({ nestedWorkerMaxDepth: 2, canChange: true }); await policyResponse.promise })
    expect(button(root, 'Save depth').disabled).toBe(false)
    expect(button(root, 'Re-check').disabled).toBe(false)
    expect(depth!.disabled).toBe(false)
  })

  test('floating overlay ignores stale status responses after a newer refresh', async () => {
    const ui = makeFake({ floating: { enabled: true, open: true } })
    const older = Promise.withResolvers<Status>()
    const newer = Promise.withResolvers<Status>()
    const originalCall = ui.context.call.bind(ui.context)
    let statusReads = 0
    Object.defineProperty(ui.context, 'call', {
      configurable: true,
      value: async (method: string, params: Record<string, unknown> = {}) => {
        if (method === 'quirky.orchestration/skillStatus') {
          statusReads += 1
          return statusReads === 1 ? older.promise : newer.promise
        }
        return originalCall(method, params)
      }
    })
    const root = await mountSlot(ui, 'overlay:quirky.orchestration/floating-setup')
    ui.emit({ type: 'quirky.terminal/floating' })
    expect(statusReads).toBe(2)
    await act(async () => { newer.resolve(missing); await newer.promise })
    expect(root.textContent).toContain('Enable orchestration')
    await act(async () => { older.resolve(ready); await older.promise })
    expect(root.textContent).toContain('Enable orchestration')
  })

  test('floating setup dismiss persists and actual Ready coverage suppresses the affordance', async () => {
    localStorage.removeItem('quirky.orchestration.setupDismissed')
    let ui = makeFake({ floating: { enabled: true, open: true } })
    let root = await mountSlot(ui, 'overlay:quirky.orchestration/floating-setup')
    expect(root.textContent).toContain('Enable orchestration')
    expect(ui.listenerCount()).toBe(1)
    ui.floating = { enabled: true, open: false }
    await act(async () => { ui.emit({ type: 'quirky.terminal/floating' }); await Promise.resolve() })
    expect(root.textContent).not.toContain('Enable orchestration')
    ui.floating = { enabled: true, open: true }
    await act(async () => { ui.emit({ type: 'quirky.terminal/floating' }); await Promise.resolve() })
    expect(root.textContent).toContain('Enable orchestration')
    await act(async () => { button(root, 'Enable').click() })
    expect(ui.openedViews).toEqual(['view:quirky.orchestration/settings'])
    await act(async () => { button(root, 'Dismiss').click() })
    expect(isSetupDismissed()).toBe(true)
    await act(async () => { for (const unmount of mounted.splice(0)) unmount() })
    expect(ui.listenerCount()).toBe(0)
    ui.dispose()
    document.body.innerHTML = ''

    ui = makeFake({ floating: { enabled: true, open: true } })
    root = await mountSlot(ui, 'overlay:quirky.orchestration/floating-setup')
    expect(root.textContent).not.toContain('Enable orchestration')
    await act(async () => { for (const unmount of mounted.splice(0)) unmount() })
    expect(ui.listenerCount()).toBe(0)
    ui.dispose()
    document.body.innerHTML = ''
    localStorage.removeItem('quirky.orchestration.setupDismissed')
    ui = makeFake({ status: ready, floating: { enabled: true, open: true } })
    root = await mountSlot(ui, 'overlay:quirky.orchestration/floating-setup')
    expect(root.textContent).not.toContain('Enable orchestration')
    expect(ui.calls.some((call) => call.method === 'quirky.orchestration/skillStatus')).toBe(true)
  })


  test('scriptable dismissal command persists and hides the mounted setup overlay', async () => {
    localStorage.removeItem('quirky.orchestration.setupDismissed')
    const ui = makeFake({ floating: { enabled: true, open: true } })
    const root = await mountSlot(ui, 'overlay:quirky.orchestration/floating-setup')
    expect(root.textContent).toContain('Enable orchestration')

    await act(async () => {
      await ui.context.executeCommand('command:quirky.orchestration/dismiss-setup')
    })

    expect(isSetupDismissed()).toBe(true)
    expect(root.textContent).not.toContain('Enable orchestration')
  })

  test('partial coverage hides the overlay when any detected skill is ready', async () => {
    localStorage.removeItem('quirky.orchestration.setupDismissed')
    const partialReady: Status = {
      state: 'partial',
      agents: [
        ...ready.agents,
        { id: 'muse', label: 'Muse', state: 'unsupported', path: null, detail: 'No native skill loader.' }
      ],
      installCommand: ready.installCommand,
      text: 'One agent is ready; another has no native skill loader.'
    }
    const ui = makeFake({ status: partialReady, floating: { enabled: true, open: true } })
    const root = await mountSlot(ui, 'overlay:quirky.orchestration/floating-setup')
    expect(root.textContent).not.toContain('Enable orchestration')
  })

  test('floating affordance rechecks actual coverage after explicit install', async () => {
    localStorage.removeItem('quirky.orchestration.setupDismissed')
    const ui = makeFake({ floating: { enabled: true, open: true } })
    const overlay = await mountSlot(ui, 'overlay:quirky.orchestration/floating-setup')
    expect(overlay.textContent).toContain('Enable orchestration')
    const settings = await mountSlot(ui, 'view:quirky.orchestration/settings')
    await act(async () => { button(settings, 'Install').click() })
    await act(async () => { await Promise.resolve() })
    expect(overlay.textContent).not.toContain('Enable orchestration')
  })

  test('dismissal storage is durable and UI affordance does not mutate it on installation attempts', () => {
    localStorage.removeItem('quirky.orchestration.setupDismissed')
    expect(isSetupDismissed()).toBe(false)
    dismissSetup()
    expect(localStorage.getItem('quirky.orchestration.setupDismissed')).toBe('1')
    expect(isSetupDismissed()).toBe(true)
  })
})
