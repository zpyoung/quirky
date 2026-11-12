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
function controlsForLabel(root: ParentNode, label: string): HTMLElement[] {
  return [...root.querySelectorAll('label')]
    .filter((entry) => entry.textContent?.trim() === label)
    .flatMap((entry) => {
      const control = [...root.querySelectorAll<HTMLElement>('[id]')].find((candidate) => candidate.id === entry.htmlFor)
      return control === undefined ? [] : [control]
    })
}

async function setControlValue(field: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = field instanceof HTMLInputElement
      ? window.HTMLInputElement.prototype
      : field instanceof HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLSelectElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
    if (!setter) throw new Error('Control has no value setter')
    setter.call(field, value)
    field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }))
  })
  await settle()
}

async function setCheckbox(field: HTMLInputElement, checked: boolean): Promise<void> {
  await act(async () => {
    if (field.checked !== checked) field.click()
  })
  await settle()
}

function fieldForLabel<T extends HTMLElement>(root: ParentNode, label: string, index = 0): T {
  const field = controlsForLabel(root, label)[index]
  if (!field) throw new Error(`Control not found: ${label}`)
  return field as T
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
  test('shows a guess choice and mandate-edit before/after across loading, loaded, null and failed mandate fetches', async () => {
    const pendingMandate = Promise.withResolvers<unknown>()
    const guess = need({
      id: 'need-guess',
      kind: 'guess',
      title: 'Confirm a guess: Keep v1?',
      detail: { guessId: 'g1', question: 'Keep v1?', choice: 'Keep v1 payload shape' },
      actions: ['confirm', 'redo']
    })
    const edit = need({
      id: 'need-edit',
      kind: 'mandate-edit',
      title: 'Update the mandate?',
      detail: {
        patch: {
          goal: 'Ship v2 badges',
          doneWhen: '',
          guidelines: ['Keep commits small', 'Allow snapshot updates'],
          notes: 'No credentials'
        },
        why: 'Layout changed'
      },
      actions: ['review-accept', 'review-reject']
    })
    const emptyGuidelinesEdit = need({
      id: 'need-empty-guidelines',
      worktreeId: 'wt-2',
      kind: 'mandate-edit',
      title: 'Clear guidelines?',
      detail: { patch: { guidelines: [] }, why: 'Remove old guidance' },
      actions: ['review-accept', 'review-reject']
    })
    const currentMandate = {
      worktreeId: 'wt-1',
      goal: 'Ship v1 badges',
      doneWhen: 'bun test',
      doneWhenKind: 'command',
      guidelines: ['Keep commits small'],
      level: 'full',
      switches: { messaging: false, historyRewrite: false, deploys: false },
      agent: null,
      sharedGoalId: null,
      notes: '',
      allowSplit: false,
      updatedAt: 1
    }
    const fake = makeContext({
      status: status(two, 3),
      report: () => report({ needsYou: [guess, edit, emptyGuidelinesEdit] }),
      log: () => [],
      mandate: (params) => params.worktreeId === 'wt-2'
        ? { ...currentMandate, worktreeId: 'wt-2', guidelines: [] }
        : pendingMandate.promise
    })
    const root = await mount(AvatarView, fake, { tab: 'report' })
    const textWhileLoading = root.textContent ?? ''

    expect(textWhileLoading).toContain('Chose: Keep v1 payload shape')
    expect(textWhileLoading.match(/Keep v1\?/g)).toHaveLength(1)
    expect(textWhileLoading).toContain('Layout changed')
    expect(textWhileLoading).toContain('Goal: loading… → Ship v2 badges')
    expect(textWhileLoading).toContain('Done when: loading… → none')
    expect(textWhileLoading).toContain('Guidelines: loading… → Keep commits small; Allow snapshot updates')
    expect(textWhileLoading).toContain('Notes: loading… → No credentials')
    expect(textWhileLoading).toContain('Guidelines: none → none')
    const emptyGuidelinesRow = [...root.querySelectorAll('.ui-list-row')].find((row) => row.textContent?.includes('Clear guidelines?'))
    expect(emptyGuidelinesRow?.textContent).not.toContain('Goal:')
    expect(emptyGuidelinesRow?.textContent).not.toContain('Done when:')
    expect(emptyGuidelinesRow?.textContent).not.toContain('Notes:')

    await act(async () => pendingMandate.resolve(currentMandate))
    await settle()
    const loadedText = root.textContent ?? ''
    expect(loadedText).toContain('Goal: Ship v1 badges → Ship v2 badges')
    expect(loadedText).toContain('Done when: bun test → none')
    expect(loadedText).toContain('Guidelines: Keep commits small → Keep commits small; Allow snapshot updates')
    expect(loadedText).toContain('Notes: none → No credentials')

    const noMandateNeed = need({
      id: 'need-no-mandate',
      kind: 'mandate-edit',
      title: 'Set a goal?',
      detail: { patch: { goal: 'Start here' }, why: 'No mandate exists yet' },
      actions: ['review-accept']
    })
    const noMandateRoot = await mount(AvatarView, makeContext({
      status: status(two, 1),
      report: () => report({ needsYou: [noMandateNeed] }),
      log: () => [],
      mandate: () => null
    }), { tab: 'report' })
    expect(noMandateRoot.textContent).toContain('Goal: no mandate → Start here')

    const unavailableRoot = await mount(AvatarView, makeContext({
      status: status(two, 1),
      report: () => report({ needsYou: [noMandateNeed] }),
      log: () => [],
      mandate: () => { throw new Error('offline') }
    }), { tab: 'report' })
    expect(unavailableRoot.textContent).toContain('Goal: unavailable → Start here')
  })

  test('renders typed ask controls and sends exact answers for every question type', async () => {
    const question = need({
      id: 'need-q',
      kind: 'question',
      title: 'A few decisions',
      detail: {
        askId: 'ask-1',
        blocks: 'the schema',
        questions: [
          { id: 'q_select', type: 'select', question: 'Version?', required: true, options: [{ value: 'v1', label: 'Keep v1' }, { value: 'v2', label: 'Add v2', description: 'Adds version field' }] },
          { id: 'q_multi', type: 'multiselect', question: 'OS?', required: true, options: [{ value: 'mac', label: 'macOS' }, { value: 'linux', label: 'Linux' }] },
          { id: 'q_text', type: 'text', question: 'Prefix?', pattern: '^[a-z]+$', format: 'email', required: true },
          { id: 'q_area', type: 'text', question: 'Body?', multiline: true, required: true },
          { id: 'q_num', type: 'number', question: 'Retries?', integer: true, min: 1, max: 5, required: true },
          { id: 'q_date', type: 'date', question: 'Freeze?', required: true },
          { id: 'q_confirm', type: 'confirm', question: 'Drop table?', required: true },
          { id: 'q_opt', type: 'text', question: 'Extra note?', required: false }
        ]
      },
      actions: ['answer']
    })
    const fake = makeContext({
      status: status(two, 1),
      report: () => report({ needsYou: [question] }),
      log: () => [],
      resolveNeed: () => ({ ok: true })
    })
    const root = await mount(AvatarView, fake, { tab: 'report' })
    const select = fieldForLabel<HTMLSelectElement>(root, 'Version?')
    expect(button(root, 'Answer').disabled).toBe(true)
    expect([...select.options].map((option) => option.textContent)).toEqual(['Choose…', 'Keep v1', 'Add v2 — Adds version field'])
    expect(root.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
    expect(fieldForLabel<HTMLInputElement>(root, 'Retries?').type).toBe('number')
    expect(fieldForLabel<HTMLInputElement>(root, 'Retries?').step).toBe('1')
    expect(fieldForLabel<HTMLInputElement>(root, 'Retries?').min).toBe('1')
    expect(fieldForLabel<HTMLInputElement>(root, 'Retries?').max).toBe('5')
    expect(fieldForLabel<HTMLInputElement>(root, 'Freeze?').type).toBe('date')
    expect(fieldForLabel<HTMLInputElement>(root, 'Freeze?').parentElement?.textContent).toContain('YYYY-MM-DD')
    expect(fieldForLabel<HTMLInputElement>(root, 'Prefix?').parentElement?.textContent).toContain('Format: email · Pattern: ^[a-z]+$')
    expect(fieldForLabel<HTMLTextAreaElement>(root, 'Body?').getAttribute('rows')).toBe('3')
    expect(root.querySelector('[role="radiogroup"][aria-label="Drop table?"]')).not.toBeNull()
    expect(root.textContent).toContain('(optional)')
    expect(root.textContent).toContain('Blocks: the schema')

    await setControlValue(select, 'v2')
    const ownAnswers = controlsForLabel(root, 'Add your own answer')
    await setControlValue(ownAnswers[0] as HTMLInputElement, '  soon  ')
    const linux = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((entry) => entry.closest('label')?.textContent?.trim() === 'Linux')
    const mac = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((entry) => entry.closest('label')?.textContent?.trim() === 'macOS')
    if (!linux || !mac) throw new Error('Multi-select options not found')
    await setCheckbox(linux, true)
    await setCheckbox(mac, true)
    await setControlValue(ownAnswers[1] as HTMLInputElement, ' win ')
    await setControlValue(fieldForLabel<HTMLInputElement>(root, 'Prefix?'), 'feat')
    await setControlValue(fieldForLabel<HTMLTextAreaElement>(root, 'Body?'), 'line 1\nline 2')
    await setControlValue(fieldForLabel<HTMLInputElement>(root, 'Freeze?'), '2026-11-15')
    await setControlValue(fieldForLabel<HTMLInputElement>(root, 'Retries?'), 'Infinity')
    await click(root, 'No')
    expect(button(root, 'Answer').disabled).toBe(true)
    await setControlValue(fieldForLabel<HTMLInputElement>(root, 'Retries?'), '3')
    expect(button(root, 'Answer').disabled).toBe(false)
    await click(root, 'Answer')

    expect(fake.calls.filter((call) => call.method.endsWith('resolveNeed'))).toEqual([{
      method: 'quirky.avatar/resolveNeed',
      params: {
        needId: 'need-q',
        action: 'answer',
        answers: {
          q_select: { value: 'v2', label: 'Add v2', note: 'soon', source: 'option' },
          q_multi: { values: ['mac', 'linux'], labels: ['macOS', 'Linux'], other: 'win', source: 'options' },
          q_text: { value: 'feat', source: 'input' },
          q_area: { value: 'line 1\nline 2', source: 'input' },
          q_num: { value: 3, source: 'input' },
          q_date: { value: '2026-11-15', source: 'input' },
          q_confirm: { value: false, source: 'input' }
        }
      }
    }])
  })

  test('fails closed on unreadable questions and malformed options', async () => {
    const unreadable: unknown[] = [
      null,
      { type: 'text', question: 'Missing ID?' },
      { id: '', type: 'text', question: 'Empty ID?' },
      { id: '   ', type: 'text', question: 'Blank ID?' },
      { id: 'missing-question', type: 'text' },
      { id: 'empty-question', type: 'text', question: '' },
      { id: 'missing-type', question: 'Missing type?' },
      { id: 'unknown-type', type: 'password', question: 'Unknown type?' },
      { id: 'select-empty', type: 'select', question: 'No options?', options: [] },
      { id: 'select-malformed', type: 'select', question: 'Bad option?', options: [{ value: 'v1' }] },
      { id: 'multiselect-missing', type: 'multiselect', question: 'Missing options?' },
      { id: 'multiselect-empty', type: 'multiselect', question: 'No targets?', options: [] },
      { id: 'multiselect-malformed', type: 'multiselect', question: 'Bad labels?', options: [{ value: 'linux', label: 42 }] }
    ]

    for (const [index, raw] of unreadable.entries()) {
      const badNeed = need({
        id: `need-bad-${index}`,
        kind: 'question',
        title: 'Unreadable question',
        detail: { questions: [raw] },
        actions: ['answer']
      })
      const root = await mount(AvatarView, makeContext({
        status: status(two, 1),
        report: () => report({ needsYou: [badNeed] }),
        log: () => []
      }), { tab: 'report' })
      expect(root.textContent).toContain('Question cannot be read')
      expect(button(root, 'Answer').disabled).toBe(true)
    }
  })

  test('keeps legacy question needs as a trimmed free-text answer with or without an empty questions array', async () => {
    for (const questions of [undefined, []]) {
      const legacyNeed = need({
        id: `legacy-${questions === undefined ? 'missing' : 'empty'}`,
        kind: 'question',
        title: 'Legacy question',
        detail: questions === undefined ? { askId: 'ask-legacy' } : { askId: 'ask-legacy', questions },
        actions: ['answer']
      })
      const fake = makeContext({
        status: status(two, 1),
        report: () => report({ needsYou: [legacyNeed] }),
        log: () => [],
        resolveNeed: () => ({ ok: true })
      })
      const root = await mount(AvatarView, fake, { tab: 'report' })
      expect(controlsForLabel(root, 'Your answer')).toHaveLength(1)
      await setControlValue(fieldForLabel<HTMLInputElement>(root, 'Your answer'), '  proceed  ')
      await click(root, 'Answer')
      expect(fake.calls.filter((call) => call.method.endsWith('resolveNeed'))[0]?.params).toEqual({
        needId: legacyNeed.id,
        action: 'answer',
        text: 'proceed'
      })
    }
  })

  test('keeps each resolving need and its typed controls disabled until that call settles', async () => {
    const question = need({
      id: 'need-a',
      kind: 'question',
      title: 'Answer these',
      detail: {
        questions: [
          { id: 'q-select', type: 'select', question: 'Choice?', required: true, options: [{ value: 'one', label: 'One' }] },
          { id: 'q-text', type: 'text', question: 'Text?', required: true },
          { id: 'q-area', type: 'text', question: 'Details?', multiline: true, required: true }
        ]
      },
      actions: ['answer', 'deny']
    })
    const approval = need({
      id: 'need-b',
      kind: 'held-call',
      title: 'Confirm this call?',
      actions: ['confirm', 'redo']
    })
    const first = Promise.withResolvers<{ ok: boolean }>()
    const second = Promise.withResolvers<{ ok: boolean }>()
    const pending = { 'need-a': first, 'need-b': second }
    const fake = makeContext({
      status: status(two, 2),
      report: () => report({ needsYou: [question, approval] }),
      log: () => [],
      resolveNeed: (params) => pending[params.needId as keyof typeof pending].promise
    })
    const root = await mount(AvatarView, fake, { tab: 'report' })

    await setControlValue(fieldForLabel<HTMLSelectElement>(root, 'Choice?'), 'one')
    await setControlValue(fieldForLabel<HTMLInputElement>(root, 'Text?'), 'ready')
    await setControlValue(fieldForLabel<HTMLTextAreaElement>(root, 'Details?'), 'details')
    await act(async () => {
      button(root, 'Answer').click()
      button(root, 'Answer').click()
      await Promise.resolve()
    })
    await settle()
    expect(fake.calls.filter((call) => call.method.endsWith('resolveNeed'))).toHaveLength(1)
    expect(button(root, 'Answer').disabled).toBe(true)
    expect(button(root, 'Deny').disabled).toBe(true)
    expect(fieldForLabel<HTMLSelectElement>(root, 'Choice?').disabled).toBe(true)
    expect(fieldForLabel<HTMLInputElement>(root, 'Add your own answer').disabled).toBe(true)
    expect(fieldForLabel<HTMLInputElement>(root, 'Text?').disabled).toBe(true)
    expect(fieldForLabel<HTMLTextAreaElement>(root, 'Details?').disabled).toBe(true)

    await click(root, 'Confirm')
    expect(button(root, 'Answer').disabled).toBe(true)
    expect(button(root, 'Confirm').disabled).toBe(true)
    expect(button(root, 'Redo').disabled).toBe(true)
    await act(async () => second.resolve({ ok: true }))
    await settle()
    expect(button(root, 'Answer').disabled).toBe(true)
    expect(button(root, 'Confirm').disabled).toBe(false)
    expect(button(root, 'Redo').disabled).toBe(false)

    await act(async () => first.resolve({ ok: true }))
    await settle()
    expect(button(root, 'Answer').disabled).toBe(false)
    expect(button(root, 'Deny').disabled).toBe(false)
  })

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

  test('keeps the current mandate visible while a report refresh loads its replacement', async () => {
    const edit = need({
      id: 'need-edit',
      kind: 'mandate-edit',
      title: 'Update the mandate?',
      detail: { patch: { goal: 'Ship v2 badges' }, why: 'Layout changed' },
      actions: ['review-accept', 'review-reject']
    })
    const currentMandate = {
      worktreeId: 'wt-1', goal: 'Ship v1 badges', doneWhen: 'CI green', doneWhenKind: 'prose',
      guidelines: [], level: 'full', switches: { messaging: false, historyRewrite: false, deploys: false },
      agent: null, sharedGoalId: null, notes: '', allowSplit: false, updatedAt: 1
    }
    const fake = makeContext({
      status: status(two, 1),
      report: () => report({ needsYou: [edit] }),
      mandate: () => currentMandate
    })
    const root = await mount(AvatarView, fake, { tab: 'report' })
    expect(root.textContent).toContain('Goal: Ship v1 badges → Ship v2 badges')

    const replacement = Promise.withResolvers<unknown>()
    fake.replies.mandate = () => replacement.promise
    await fake.deliverChanged()
    expect(root.textContent).toContain('Goal: Ship v1 badges → Ship v2 badges')
    expect(root.textContent).not.toContain('loading…')
    await act(async () => replacement.resolve({ ...currentMandate, goal: 'Ship v1.1 badges' }))
    await settle()
    expect(root.textContent).toContain('Goal: Ship v1.1 badges → Ship v2 badges')

    const removed = Promise.withResolvers<unknown>()
    fake.replies.mandate = () => removed.promise
    await fake.deliverChanged()
    expect(root.textContent).toContain('Goal: Ship v1.1 badges → Ship v2 badges')
    expect(root.textContent).not.toContain('loading…')
    await act(async () => removed.resolve(null))
    await settle()
    expect(root.textContent).toContain('Goal: no mandate → Ship v2 badges')

    const failed = Promise.withResolvers<unknown>()
    fake.replies.mandate = () => failed.promise
    await fake.deliverChanged()
    expect(root.textContent).toContain('Goal: no mandate → Ship v2 badges')
    expect(root.textContent).not.toContain('loading…')
    await act(async () => failed.reject(new Error('offline')))
    await settle()
    expect(root.textContent).toContain('Goal: unavailable → Ship v2 badges')
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

  test('shows resolve failures and refreshes report after each outcome', async () => {
    let reports = 0
    let reject = false
    const fake = makeContext({
      status: status(two, 2),
      report: () => {
        reports += 1
        return report()
      },
      log: () => [],
      resolveNeed: () => {
        if (reject) throw new Error('offline')
        return { ok: false, error: 'already resolved' }
      }
    })
    const root = await mount(AvatarView, fake, { tab: 'report' })
    expect(reports).toBe(1)

    await click(root, 'Deny')
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('already resolved')
    expect(reports).toBe(2)

    reject = true
    await click(root, 'Allow once')
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('offline')
    expect(reports).toBe(3)
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

describe('AvatarView log paging', () => {
  function makeJournal(newest: number) {
    let latest = newest
    let olderPage: Reply | null = null
    const page = (params: Record<string, unknown> = {}): JournalEntry[] => {
      const limit = typeof params.limit === 'number' ? params.limit : 100
      const before = typeof params.before === 'number' ? params.before : latest + 1
      const last = Math.min(latest, before - 1)
      const first = Math.max(1, last - limit + 1)
      return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => {
        const seq = last - index
        return entry({ seq, kind: 'event', data: { summary: `entry ${seq}.` } })
      })
    }
    const fake = makeContext({
      status: status(two),
      log: (params) => typeof params.before === 'number' && olderPage !== null ? olderPage(params) : page(params)
    })
    return {
      fake,
      page,
      setNewest(seq: number) {
        latest = seq
      },
      setOlderPage(reply: Reply | null) {
        olderPage = reply
      }
    }
  }

  function rows(root: ParentNode): number[] {
    return [...root.querySelectorAll('[role="tabpanel"][aria-label="Log"] ul > li')].map((row) => {
      const match = row.textContent?.match(/entry (\d+)\./)
      if (!match) throw new Error(`Could not read journal seq from row: ${row.textContent}`)
      return Number(match[1])
    })
  }

  function sequence(newest: number, oldest = 1): number[] {
    return Array.from({ length: Math.max(0, newest - oldest + 1) }, (_, index) => newest - index)
  }

  function loadOlderButton(root: ParentNode): HTMLButtonElement | undefined {
    return [...root.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Load older entries') as HTMLButtonElement | undefined
  }

  function logCalls(fake: Fake) {
    return fake.calls.filter((call) => call.method === `${PREFIX}log`)
  }

  test('loads the page before the oldest entry shown, and stops offering once a page comes back short', async () => {
    const journal = makeJournal(240)
    const root = await mount(AvatarView, journal.fake, { tab: 'log' })

    expect(rows(root)).toEqual(sequence(240, 141))
    expect(logCalls(journal.fake).map((call) => call.params)).toEqual([{ limit: 100 }])

    await click(root, 'Load older entries')
    expect(rows(root)).toEqual(sequence(240, 41))
    expect(logCalls(journal.fake).at(-1)?.params).toEqual({ limit: 100, before: 141 })
    expect(loadOlderButton(root)).toBeDefined()

    await click(root, 'Load older entries')
    expect(rows(root)).toEqual(sequence(240))
    expect(logCalls(journal.fake).at(-1)?.params).toEqual({ limit: 100, before: 41 })
    expect(loadOlderButton(root)).toBeUndefined()

    journal.setNewest(243)
    await journal.fake.deliverChanged()
    expect(rows(root)).toEqual(sequence(243))
    expect(loadOlderButton(root)).toBeUndefined()
  })

  test('offers nothing older when the first page is short', async () => {
    const journal = makeJournal(99)
    const root = await mount(AvatarView, journal.fake, { tab: 'log' })

    expect(rows(root)).toEqual(sequence(99))
    expect(loadOlderButton(root)).toBeUndefined()
  })

  test('with exactly one full page, the offer loads nothing and goes away', async () => {
    const journal = makeJournal(100)
    const root = await mount(AvatarView, journal.fake, { tab: 'log' })

    expect(rows(root)).toEqual(sequence(100))
    await click(root, 'Load older entries')
    expect(rows(root)).toEqual(sequence(100))
    expect(logCalls(journal.fake).at(-1)?.params).toEqual({ limit: 100, before: 1 })
    expect(loadOlderButton(root)).toBeUndefined()
  })

  test('puts new entries on top on a change event and keeps the older ones it loaded', async () => {
    const journal = makeJournal(240)
    const root = await mount(AvatarView, journal.fake, { tab: 'log' })
    await click(root, 'Load older entries')
    expect(rows(root)).toEqual(sequence(240, 41))

    journal.setNewest(245)
    await journal.fake.deliverChanged()
    expect(rows(root)).toEqual(sequence(245, 41))
    expect(logCalls(journal.fake).at(-1)?.params).toEqual({ limit: 100 })
    expect(loadOlderButton(root)).toBeDefined()
  })

  test('shows only the newest page when more than a page arrived since the last reload', async () => {
    const journal = makeJournal(240)
    const root = await mount(AvatarView, journal.fake, { tab: 'log' })
    await click(root, 'Load older entries')

    journal.setNewest(500)
    await journal.fake.deliverChanged()
    expect(rows(root)).toEqual(sequence(500, 401))

    await click(root, 'Load older entries')
    expect(logCalls(journal.fake).at(-1)?.params).toEqual({ limit: 100, before: 401 })
    expect(rows(root)).toEqual(sequence(500, 301))
  })

  test('joins a full page of new entries that still reaches the newest one shown', async () => {
    const journal = makeJournal(240)
    const root = await mount(AvatarView, journal.fake, { tab: 'log' })

    journal.setNewest(339)
    await journal.fake.deliverChanged()
    expect(rows(root)).toEqual(sequence(339, 141))
  })

  test('keeps the list, shows the error and offers again when an older page fails', async () => {
    const journal = makeJournal(240)
    const root = await mount(AvatarView, journal.fake, { tab: 'log' })
    journal.setOlderPage(() => {
      throw new Error('daemon went away')
    })

    await click(root, 'Load older entries')
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('daemon went away')
    expect(rows(root)).toEqual(sequence(240, 141))
    expect(button(root, 'Load older entries').disabled).toBe(false)

    journal.setOlderPage(null)
    await click(root, 'Load older entries')
    expect(rows(root)).toEqual(sequence(240, 41))
    expect(root.querySelector('[role="alert"]')).toBeNull()
  })

  test('asks once while an older page loads, and says it is loading', async () => {
    const journal = makeJournal(240)
    const pending = Promise.withResolvers<unknown>()
    journal.setOlderPage(() => pending.promise)
    const root = await mount(AvatarView, journal.fake, { tab: 'log' })

    await click(root, 'Load older entries')
    expect(button(root, 'Loading…').disabled).toBe(true)
    expect(logCalls(journal.fake).filter((call) => typeof call.params.before === 'number').map((call) => call.params)).toEqual([{ limit: 100, before: 141 }])

    await act(async () => pending.resolve(journal.page({ limit: 100, before: 141 })))
    await settle()
    expect(rows(root)).toEqual(sequence(240, 41))
    expect(button(root, 'Load older entries').disabled).toBe(false)
  })

  test('drops an older page that answers after the list was replaced', async () => {
    const journal = makeJournal(240)
    const pending = Promise.withResolvers<unknown>()
    journal.setOlderPage((params) => params.before === 141 ? pending.promise : journal.page(params))
    const root = await mount(AvatarView, journal.fake, { tab: 'log' })

    await click(root, 'Load older entries')
    journal.setNewest(500)
    await journal.fake.deliverChanged()
    expect(rows(root)).toEqual(sequence(500, 401))

    await act(async () => pending.resolve(journal.page({ limit: 100, before: 141 })))
    await settle()
    expect(rows(root)).toEqual(sequence(500, 401))
    expect(loadOlderButton(root)).toBeDefined()
  })

  test('keeps the list and shows the error when a reload fails', async () => {
    const journal = makeJournal(240)
    const root = await mount(AvatarView, journal.fake, { tab: 'log' })
    journal.fake.replies.log = () => {
      throw new Error('daemon went away')
    }

    await journal.fake.deliverChanged()
    expect(rows(root)).toEqual(sequence(240, 141))
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('daemon went away')
  })

  test('a full final older page offers one empty probe before hiding the button', async () => {
    const journal = makeJournal(200)
    const root = await mount(AvatarView, journal.fake, { tab: 'log' })

    expect(rows(root)).toEqual(sequence(200, 101))
    await click(root, 'Load older entries')
    expect(logCalls(journal.fake).at(-1)?.params).toEqual({ limit: 100, before: 101 })
    expect(rows(root)).toEqual(sequence(200))
    expect(loadOlderButton(root)?.disabled).toBe(false)

    await click(root, 'Load older entries')
    expect(logCalls(journal.fake).at(-1)?.params).toEqual({ limit: 100, before: 1 })
    expect(rows(root)).toEqual(sequence(200))
    expect(loadOlderButton(root)).toBeUndefined()
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
