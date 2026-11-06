import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act, type ComponentType } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { AvatarUiProps, JournalEntry, ReportModel, ReportNeed } from '../src/contracts'

type Reply = (params: Record<string, unknown>) => unknown
type Fake = {
  context: UiPluginContext
  replies: Record<string, Reply>
  calls: { method: string; params: Record<string, unknown> }[]
  commands: string[]
  confirms: { title: string; body?: string; confirmLabel?: string }[]
  deliverChanged(): Promise<void>
}

const PREFIX = 'quirky.avatar/'
const OPEN_REPORT = 'command:quirky.avatar/open-report'
const HANDOFF = 'command:quirky.avatar/handoff'

let Pill: ComponentType<AvatarUiProps>
let Panel: ComponentType<AvatarUiProps>
let AvatarView: ComponentType<AvatarUiProps>
let DecisionTrace: ComponentType<{ entry: JournalEntry }>
let createRoot: typeof import('react-dom/client').createRoot
const unmounts: (() => void)[] = []
let previousActEnvironment: unknown
let hadActEnvironment = false

function makeContext(replies: Record<string, Reply>, options: { confirm?: boolean } = {}): Fake {
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const fake: Fake = {
    replies,
    calls: [],
    commands: [],
    confirms: [],
    deliverChanged: async () => {
      await act(async () => {
        for (const listener of [...listeners]) await listener({ type: 'quirky.avatar/changed' } as unknown as QuirkyEvent)
      })
      await settle()
    },
    context: {
      pluginId: 'quirky.avatar',
      log() {},
      async call(method: string, params: Record<string, unknown> = {}) {
        fake.calls.push({ method, params })
        const reply = fake.replies[method.replace(PREFIX, '')]
        if (reply === undefined) throw new Error(`no fake for ${method}`)
        return reply(params)
      },
      subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
      async executeCommand(id: string) {
        fake.commands.push(id)
      },
      async confirm(request: { title: string; body?: string; confirmLabel?: string }) {
        fake.confirms.push(request)
        return options.confirm ?? true
      }
    } as unknown as UiPluginContext
  }
  return fake
}

async function settle(): Promise<void> {
  await act(async () => {
    const { promise, resolve } = Promise.withResolvers<void>()
    window.setTimeout(resolve, 0)
    await promise
  })
}

async function mount(Component: ComponentType<AvatarUiProps>, fake: Fake, input?: unknown): Promise<HTMLElement> {
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  await act(async () => root.render(<Component context={fake.context} input={input} />))
  await settle()
  unmounts.push(() => root.unmount())
  return element
}

function button(root: ParentNode, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll('button')].find((entry) => (entry.getAttribute('aria-label') ?? entry.textContent?.trim()) === label)
  if (!match) throw new Error(`Button not found: ${label}`)
  return match as HTMLButtonElement
}

async function click(root: ParentNode, label: string): Promise<void> {
  await act(async () => button(root, label).click())
  await settle()
}

function tab(root: ParentNode, label: string): HTMLButtonElement {
  const match = [...root.querySelectorAll('[role="tab"]')].find((entry) => entry.textContent?.startsWith(label))
  if (!match) throw new Error(`Tab not found: ${label}`)
  return match as HTMLButtonElement
}

const status = (handoffs: { worktreeId: string; name: string; state: string; level: string }[], needsYouCount = 0) => (_params?: Record<string, unknown>) => ({ handoffs, needsYouCount })

const need = (overrides: Partial<ReportNeed> = {}): ReportNeed => ({
  id: 'need-1',
  worktreeId: 'wt-1',
  kind: 'held-call',
  title: 'Allow a force-push?',
  detail: { reason: 'Held by floor switch: rewrite history.' },
  actions: ['allow-once', 'deny'],
  createdAt: 1,
  resolvedAt: null,
  resolution: null,
  worktreeName: 'provider-host',
  projectName: 'harbor-api',
  ...overrides
})

const entry = (overrides: Partial<JournalEntry> = {}): JournalEntry => ({ seq: 1, at: Date.UTC(2026, 10, 4, 23, 4), worktreeId: 'wt-1', kind: 'gate', data: {}, ...overrides })

const gateEntry = entry({
  seq: 7,
  data: {
    outcome: 'deny',
    agent: 'Claude',
    toolName: 'Bash',
    toolInput: { command: 'bunx playwright test -u' },
    trace: [
      { step: 'floor-core', result: 'pass', note: '' },
      { step: 'level', result: 'pass', note: '' },
      { step: 'judgment', result: 'deny', note: '' }
    ],
    reliedOn: 'Mandate, guideline 1: "Don\'t update snapshots."',
    sawWorkerExplanation: false
  }
})

function report(overrides: Partial<ReportModel> = {}): ReportModel {
  return {
    needsYou: [need(), need({ id: 'need-2', kind: 'guess', title: 'Confirm a guess?', detail: {}, actions: ['confirm', 'redo'] })],
    stories: [
      { worktreeId: 'wt-1', name: 'provider-host', projectName: 'harbor-api', switchesOn: ['historyRewrite'], story: 'Fix restart. Parked.', handedBackWith: [] },
      { worktreeId: 'wt-2', name: 'sa-browser', projectName: 'harbor-api', switchesOn: [], story: 'Fix the checks. Handed back to you.', handedBackWith: ['1 held force-push'] }
    ],
    summary: { decisions: 186, allowed: 171, denied: 9, held: 3, guesses: 3, sleeps: [], keptAwake: true },
    topSkippedCalls: [],
    ...overrides
  }
}

beforeAll(async () => {
  GlobalRegistrator.register()
  const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  hadActEnvironment = Object.prototype.hasOwnProperty.call(reactGlobal, 'IS_REACT_ACT_ENVIRONMENT')
  previousActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
  reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
  // React DOM binds its scheduler to the DOM globals available at import.
  ;({ createRoot } = await import('react-dom/client'))
  Pill = (await import('../src/ui/Pill')).default
  Panel = (await import('../src/ui/Panel')).default
  AvatarView = (await import('../src/ui/AvatarView')).default
  DecisionTrace = (await import('../src/ui/DecisionTrace')).default
})

afterEach(async () => {
  await act(async () => {
    for (const unmount of unmounts.splice(0)) unmount()
    await new Promise<void>((resolve) => queueMicrotask(resolve))
  })
  document.body.innerHTML = ''
})

afterAll(async () => {
  const reactGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  if (hadActEnvironment) reactGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment as boolean
  else delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
  await GlobalRegistrator.unregister()
})

const two = [
  { worktreeId: 'wt-1', name: 'provider-host', projectName: 'harbor-api', state: 'parked', level: 'full' },
  { worktreeId: 'wt-2', name: 'sa-browser', state: 'working', level: 'own-branch' }
]

describe('Pill', () => {
  test('renders nothing when nothing is handed off and nothing needs you', async () => {
    const root = await mount(Pill, makeContext({ status: status([]) }))
    expect(root.textContent).toBe('')
    expect(root.querySelector('button')).toBeNull()
  })

  test('counts handed-off worktrees and opens the sheet on click', async () => {
    const fake = makeContext({ status: status(two) })
    const root = await mount(Pill, fake)

    expect(root.textContent).toBe('Avatar · 2 handed off')
    expect(root.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('handed-off')
    expect(fake.commands).toEqual([])
    await click(root, 'Avatar · 2 handed off')
    expect(fake.commands).toEqual([HANDOFF])
  })

  test('turns amber with the needs count and opens the report on click', async () => {
    const fake = makeContext({ status: status(two, 3) })
    const root = await mount(Pill, fake)

    expect(root.textContent).toBe('Avatar · 3 need you')
    expect(root.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('needs-you')
    expect(fake.commands).toEqual([])
    await click(root, 'Avatar · 3 need you')
    expect(fake.commands).toEqual([OPEN_REPORT])
  })

  test('shows up and updates when the avatar announces a change', async () => {
    let current = status([])
    const fake = makeContext({ status: (params) => current(params) })
    const root = await mount(Pill, fake)
    expect(root.textContent).toBe('')

    current = status(two, 1)
    await fake.deliverChanged()
    expect(root.textContent).toBe('Avatar · 1 need you')
  })
})

describe('Panel', () => {
  test('lists each handed-off worktree with its state and level', async () => {
    const root = await mount(Panel, makeContext({ status: status(two) }))
    expect(root.textContent).toContain('provider-host')
    expect(root.textContent).toContain('Parked · Full')
    expect(root.textContent).toContain('sa-browser')
    expect(root.textContent).toContain('Working · Own branch')
  })

  test('says so when nothing is handed off', async () => {
    const root = await mount(Panel, makeContext({ status: status([]) }))
    expect(root.textContent).toContain('Nothing handed off.')
    expect(button(root, 'Take back all').disabled).toBe(true)
  })

  test('opens the sheet from Hand off…', async () => {
    const fake = makeContext({ status: status(two) })
    const root = await mount(Panel, fake)
    await click(root, 'Hand off…')
    expect(fake.commands).toEqual([HANDOFF])
  })

  test('takes everything back only after the person confirms', async () => {
    const declined = makeContext({ status: status(two), takeBack: () => ({ results: [] }) }, { confirm: false })
    const declinedRoot = await mount(Panel, declined)
    await click(declinedRoot, 'Take back all')
    expect(declined.confirms).toHaveLength(1)
    expect(declined.calls.filter((call) => call.method.endsWith('takeBack'))).toEqual([])

    const accepted = makeContext({ status: status(two), takeBack: () => ({ results: [] }) })
    const acceptedRoot = await mount(Panel, accepted)
    await click(acceptedRoot, 'Take back all')
    expect(accepted.calls.filter((call) => call.method.endsWith('takeBack'))).toEqual([{ method: 'quirky.avatar/takeBack', params: { all: true } }])
  })

  test('takes back one worktree from its row', async () => {
    const fake = makeContext({ status: status(two), takeBack: () => ({ results: [] }) })
    const root = await mount(Panel, fake)
    await click(root, 'Take back sa-browser')
    expect(fake.calls.filter((call) => call.method.endsWith('takeBack'))).toEqual([{ method: 'quirky.avatar/takeBack', params: { worktreeIds: ['wt-2'] } }])
  })

  test('offers the report when something needs you', async () => {
    const fake = makeContext({ status: status(two, 2) })
    const root = await mount(Panel, fake)
    await click(root, 'Open report · 2 need you')
    expect(fake.commands).toEqual([OPEN_REPORT])
  })

  test('refreshes its rows on a change event', async () => {
    let current = status(two)
    const fake = makeContext({ status: (params) => current(params) })
    const root = await mount(Panel, fake)
    current = status([two[1]!])
    await fake.deliverChanged()
    expect(root.textContent).not.toContain('provider-host')
    expect(root.textContent).toContain('sa-browser')
  })

  test('names each worktree with its project and pads the header and buttons', async () => {
    const root = await mount(Panel, makeContext({ status: status(two, 1) }))
    expect(root.textContent).toContain('harbor-api / provider-host')
    const header = root.querySelector('.ui-section-header')!.parentElement as HTMLElement
    expect(header.getAttribute('style')).toContain('padding-inline: var(--ui-space-8)')
    expect(header.contains(button(root, 'Hand off…'))).toBe(true)
    expect(header.contains(button(root, 'Open report · 1 need you'))).toBe(true)
  })
})

describe('AvatarView', () => {
  test('opens on Live and shows each worktree with its latest decision', async () => {
    const fake = makeContext({ status: status(two), log: () => [gateEntry], report: () => report(), takeBack: () => ({ results: [] }) })
    const root = await mount(AvatarView, fake)

    expect(tab(root, 'Live').getAttribute('aria-selected')).toBe('true')
    expect(root.textContent).toContain('provider-host')
    expect(root.textContent).toContain('Denied Bash: bunx playwright test -u')
    await click(root, 'Take back provider-host')
    expect(fake.calls.filter((call) => call.method.endsWith('takeBack'))).toEqual([{ method: 'quirky.avatar/takeBack', params: { worktreeIds: ['wt-1'] } }])
  })

  test('opens on the tab named by its input', async () => {
    const root = await mount(AvatarView, makeContext({ status: status(two, 2), report: () => report(), log: () => [] }), { tab: 'report' })
    expect(tab(root, 'Report').getAttribute('aria-selected')).toBe('true')
    expect(root.querySelector('[role="tabpanel"]')?.getAttribute('aria-label')).toBe('Report')
  })

  test('reads needs-you first, then stories, then the summary line', async () => {
    const fake = makeContext({ status: status(two, 2), report: () => report(), log: () => [] })
    const root = await mount(AvatarView, fake, { tab: 'report' })
    const text = root.textContent ?? ''

    const needs = text.indexOf('2 things need you')
    const allow = text.indexOf('Allow a force-push?')
    const stories = text.indexOf('While you were away')
    const handedBack = text.indexOf('Handed back with: 1 held force-push')
    const summary = text.indexOf('186 decisions: 171 allowed, 9 denied, 3 held, 3 guesses.')
    expect(needs).toBeGreaterThanOrEqual(0)
    expect(allow).toBeGreaterThan(needs)
    expect(stories).toBeGreaterThan(allow)
    expect(handedBack).toBeGreaterThan(stories)
    expect(summary).toBeGreaterThan(handedBack)
    expect(text).toContain('History rewrites on')
    expect(text).toContain('Mac kept awake.')
  })

  test('names worktrees with their project and keeps the story and handed-back sentences apart', async () => {
    const root = await mount(AvatarView, makeContext({ status: status(two, 2), report: () => report(), log: () => [] }), { tab: 'report' })
    const text = root.textContent ?? ''
    expect(text).toContain('harbor-api / provider-host')
    expect(text).toContain('Fix the checks. Handed back to you. Handed back with: 1 held force-push')
  })

  test('puts skipped calls that ran without the gate above the needs-you items', async () => {
    const skipped = entry({ seq: 9, kind: 'skipped-call', data: { toolName: 'Bash', toolInput: { command: 'git push origin main' }, outcome: 'deny' } })
    const root = await mount(AvatarView, makeContext({ status: status(two, 2), report: () => report({ topSkippedCalls: [skipped] }), log: () => [] }), { tab: 'report' })
    const text = root.textContent ?? ''
    expect(text.indexOf('A call ran without the gate')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('git push origin main')).toBeLessThan(text.indexOf('Allow a force-push?'))
  })

  test('answers a need with one click and then refreshes', async () => {
    let reports = 0
    const fake = makeContext({
      status: status(two, 2),
      report: () => (++reports === 1 ? report() : report({ needsYou: [] })),
      log: () => [],
      resolveNeed: () => ({ ok: true })
    })
    const root = await mount(AvatarView, fake, { tab: 'report' })

    await click(root, 'Allow once')

    expect(fake.calls.filter((call) => call.method.endsWith('resolveNeed'))).toEqual([
      { method: 'quirky.avatar/resolveNeed', params: { needId: 'need-1', action: 'allow-once' } }
    ])
    expect(root.textContent).toContain('Nothing needs you')
  })

  test('sends the typed text with an Answer action', async () => {
    const question = need({ id: 'need-q', kind: 'question', title: 'Keep v1?', detail: {}, actions: ['answer'] })
    const fake = makeContext({ status: status(two, 1), report: () => report({ needsYou: [question] }), log: () => [], resolveNeed: () => ({ ok: true }) })
    const root = await mount(AvatarView, fake, { tab: 'report' })
    expect(button(root, 'Answer').disabled).toBe(true)

    const field = root.querySelector('input') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(field, 'Keep v1')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(root, 'Answer')

    expect(fake.calls.find((call) => call.method.endsWith('resolveNeed'))?.params).toEqual({ needId: 'need-q', action: 'answer', text: 'Keep v1' })
  })

  test('shows why a one-click answer was refused', async () => {
    const fake = makeContext({ status: status(two, 2), report: () => report(), log: () => [], resolveNeed: () => ({ ok: false, error: 'already resolved' }) })
    const root = await mount(AvatarView, fake, { tab: 'report' })
    await click(root, 'Deny')
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('already resolved')
  })

  test('links the report to the log', async () => {
    const fake = makeContext({ status: status(two, 2), report: () => report(), log: () => [gateEntry] })
    const root = await mount(AvatarView, fake, { tab: 'report' })

    await click(root, 'Open decision log →')

    expect(tab(root, 'Log').getAttribute('aria-selected')).toBe('true')
    expect(root.textContent).toContain('Denied Bash: bunx playwright test -u')
  })

  test('shows a gate decision trace from the log on demand', async () => {
    const root = await mount(AvatarView, makeContext({ status: status(two), report: () => report(), log: () => [gateEntry, entry({ seq: 8, kind: 'event', data: { summary: 'Stuck: same assertion failing 3 times.' } })] }), { tab: 'log' })

    expect(root.textContent).not.toContain('Judgment saw')
    expect(root.textContent).toContain('Event: Stuck: same assertion failing 3 times.')
    await click(root, 'Show trace')

    expect(root.textContent).toContain('Request')
    expect(root.textContent).toContain('Claude wants to run Bash: bunx playwright test -u')
    expect(root.textContent).toContain('Floor core: pass → Level: pass → Judgment: deny')
    expect(root.textContent).toContain('Relied onMandate, guideline 1')
    expect(root.textContent).toContain("Judgment sawThe mandate and the command. Not the worker's explanation.")
    expect(button(root, 'Hide trace').getAttribute('aria-expanded')).toBe('true')
  })

  test('labels log kinds in words, fills a bare event and drops the list bullets', async () => {
    const entries = [
      entry({ seq: 1, kind: 'brain-error', data: { reason: 'session-start-failed' } }),
      entry({ seq: 2, kind: 'notify', data: { title: 'Avatar needs you' } }),
      entry({ seq: 3, kind: 'event', data: {} }),
      entry({ seq: 4, kind: 'event', data: { type: 'state', from: 'working', state: 'gate-failed' } }),
      entry({ seq: 5, kind: 'event', data: { type: 'gate-check', ok: true, agent: 'rovo' } })
    ]
    const root = await mount(AvatarView, makeContext({ status: status(two), log: () => entries }), { tab: 'log' })
    const text = root.textContent ?? ''
    expect(text).toContain('Avatar error: session start failed')
    expect(text).toContain('Notification: Avatar needs you')
    expect(text).toContain('State changed: Working → Gate failed')
    expect(text).toContain('Gate check passed')
    expect(text).not.toContain('brain-error')
    expect(text).not.toContain('notify:')
    const list = root.querySelector('ul') as HTMLElement
    expect(list.style.listStyle).toBe('none')
    expect(list.style.padding).toBe('0px')
  })

  test('shows the project and no raw event token in the live row', async () => {
    const root = await mount(AvatarView, makeContext({ status: status(two), log: () => [entry({ seq: 2, kind: 'event', data: { type: 'state', from: 'briefing', state: 'working' } })] }), { tab: 'live' })
    expect(root.textContent).toContain('harbor-api / provider-host')
    expect(root.textContent).toContain('State changed: Briefing → Working')
    expect((root.querySelector('ul') as HTMLElement).style.listStyle).toBe('none')
  })

  test('keeps the last data and shows the error when a refresh fails', async () => {
    let failing = false
    const fake = makeContext({
      status: status(two),
      log: () => {
        if (failing) throw new Error('log offline')
        return [gateEntry]
      }
    })
    const root = await mount(AvatarView, fake, { tab: 'log' })
    failing = true
    await fake.deliverChanged()
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('log offline')
    expect(root.textContent).toContain('Denied Bash')
  })
})

describe('DecisionTrace', () => {
  test('calls the agent by its display name', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    await act(async () => root.render(<DecisionTrace entry={entry({ data: { agent: 'rovo', toolName: 'Bash', trace: [] } })} />))
    unmounts.push(() => root.unmount())
    expect(element.textContent).toContain('Rovo Dev wants to run Bash')
  })

  test('notes when the judgment saw the worker explanation and what was recorded', async () => {
    const element = document.createElement('div')
    document.body.append(element)
    const root = createRoot(element)
    await act(async () => root.render(<DecisionTrace entry={entry({ data: { toolName: 'Edit', toolInput: { file_path: '/tmp/a.ts' }, trace: [], sawWorkerExplanation: true, reason: 'outside the worktree' } })} />))
    unmounts.push(() => root.unmount())

    expect(element.textContent).toContain('The worker wants to run Edit: /tmp/a.ts')
    expect(element.textContent).toContain('No steps recorded')
    expect(element.textContent).toContain('Nothing recorded')
    expect(element.textContent).toContain("The mandate, the command and the worker's explanation.")
    expect(element.textContent).toContain('outside the worktree')
  })
})
