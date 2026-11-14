import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import type { Root, createRoot as createRootFactory } from 'react-dom/client'
import { registerUiDom, unregisterUiDom } from './ui-dom'
import type { UiPluginContext } from '@quirky/protocol'
import type { LoopSnapshot } from '../src/types'
import type { SetupDialogProps, SurfaceHandle } from '../window/contracts'
import type { LoopDraft } from '../window/contracts'
import type { SetupDialog as SetupDialogType } from '../window/SetupDialog'
import type { ConfigFields, draftFromLoop, initialDraft, validateDraft } from '../window/config-form'

type FormSurface = {
  initialDraft: typeof initialDraft
  draftFromLoop: typeof draftFromLoop
  validateDraft: typeof validateDraft
  ConfigFields: typeof ConfigFields
}
type Call = { method: string; params: Record<string, unknown> }
type CommandCall = { id: string; args: unknown }
type DraftView = Pick<LoopDraft, 'prompt' | 'sessionPolicy' | 'preset' | 'queueItems' | 'repeatQueue'> & {
  pacingKind?: 'on-idle' | 'interval'
}
type ReadView = {
  draft: DraftView
  workspaceKind: 'git' | 'folder' | null
  showCost: boolean
  warning: string | null
  loadError: string | null
  alreadyCreated: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isDraftView(value: unknown): value is DraftView {
  return isRecord(value) && typeof value.prompt === 'string' &&
    (value.sessionPolicy === 'fresh' || value.sessionPolicy === 'continue') &&
    (value.preset === 'until-done' || value.preset === 'interval' || value.preset === 'queue') &&
    Array.isArray(value.queueItems) && value.queueItems.every((item) => typeof item === 'string') &&
    (value.pacingKind === undefined || value.pacingKind === 'on-idle' || value.pacingKind === 'interval') &&
    typeof value.repeatQueue === 'boolean'
}

function isReadView(value: unknown): value is ReadView {
  if (!isRecord(value) || !isDraftView(value.draft)) return false
  return (value.workspaceKind === null || value.workspaceKind === 'git' || value.workspaceKind === 'folder') &&
    typeof value.showCost === 'boolean' && (value.warning === null || typeof value.warning === 'string') &&
    (value.loadError === null || typeof value.loadError === 'string') && typeof value.alreadyCreated === 'boolean'
}

function readSetup(handle: SurfaceHandle): ReadView {
  const result = handle.read()
  if (!isReadView(result)) throw new Error('The setup surface returned an invalid read state.')
  return result
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) =>
    candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label
  )
  if (!found) throw new Error(`Button not found: ${label}`)
  return found
}

let SetupDialog: typeof SetupDialogType | undefined
let form: FormSurface | undefined
let host: HTMLElement
let root: Root | null = null
let createRoot: typeof createRootFactory

beforeAll(async () => {
  registerUiDom()
  // React DOM feature-detects the DOM during import; register happy-dom first.
  const reactDom = await import('react-dom/client')
  createRoot = reactDom.createRoot
  const [loadedForm, loadedDialog] = await Promise.all([
    import('../window/config-form').catch(() => null),
    import('../window/SetupDialog').catch(() => null)
  ])
  form = loadedForm ?? undefined
  SetupDialog = loadedDialog?.SetupDialog
})

afterAll(async () => {
  await unmount()
  await unregisterUiDom()
})
afterEach(async () => {
  await unmount()
})

async function unmount() {
  if (root) {
    await act(async () => root?.unmount())
    root = null
  }
  document.body.innerHTML = ''
}

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}
function typeAtCaret(element: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const start = element.selectionStart ?? element.value.length
  const end = element.selectionEnd ?? start
  const next = `${element.value.slice(0, start)}${text}${element.value.slice(end)}`
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, next)
  element.setSelectionRange(start + text.length, start + text.length)
  element.dispatchEvent(new Event('input', { bubbles: true }))
}

function setSelectValue(element: HTMLSelectElement, value: string) {
  element.value = value
  element.dispatchEvent(new Event('change', { bubbles: true }))
}

function requireSurface() {
  if (!form || !SetupDialog) throw new Error('setup surface is unavailable')
  return { form, SetupDialog }
}

function setup(options: {
  failCreate?: boolean
  failHostedTab?: boolean
  failWorkspace?: Error
  failAgents?: Error
  failLoops?: Error
  failCommandAction?: string
  commandGates?: Promise<void>[]
  commandTarget?: { current: SurfaceHandle | null }
  pendingWorkspace?: Promise<unknown>
  pendingAgents?: Promise<unknown>
  noAgents?: boolean
  runningLoops?: unknown[]
  workspaceKind?: 'git' | 'folder'
  onCreated?: (loop: LoopSnapshot) => Promise<void>
} = {}) {
  const commandCalls: CommandCall[] = []
  let handle: SurfaceHandle | null = null
  let commandGateIndex = 0
  let failCommandAction = options.failCommandAction
  const pendingCommands = new Set<{ promise: Promise<void>; gatePending: boolean }>()
  const flushCommands = async () => {
    while (true) {
      const ready = [...pendingCommands].filter((command) => !command.gatePending)
      if (ready.length === 0) return
      await Promise.allSettled(ready.map((command) => command.promise))
    }
  }
  const calls: Call[] = []
  const toasts: { title: string; body: string }[] = []
  const reports: unknown[] = []
  const created = { id: 'loop-1', name: 'Do the work', worktreeId: 'wt-1', state: 'running' }
  const context = {
    executeCommand(id: string, args?: unknown) {
      const pendingCommand = { promise: Promise.resolve(), gatePending: false }
      const commandTask = (async () => {
        commandCalls.push({ id, args })
        const command = isRecord(args) ? args : {}
        if (failCommandAction === command.action) throw new Error('bridge refused')
        if (id !== 'command:quirky.loops/setup-action' || typeof command.action !== 'string') {
          throw new Error(`Unexpected UI command ${id}`)
        }
        const commandHandle = options.commandTarget === undefined ? handle : options.commandTarget.current
        if (commandHandle === null) throw new Error('Setup surface is unavailable.')
        const commandGate = options.commandGates?.[commandGateIndex++]
        if (commandGate) {
          pendingCommand.gatePending = true
          try {
            await commandGate
          } finally {
            pendingCommand.gatePending = false
          }
        }
        await commandHandle.dispatch(command.action, isRecord(command.params) ? command.params : {})
      })()
      pendingCommand.promise = commandTask
      pendingCommands.add(pendingCommand)
      void commandTask.then(
        () => pendingCommands.delete(pendingCommand),
        () => pendingCommands.delete(pendingCommand)
      )
      return commandTask
    },
    pluginId: 'quirky.loops',
    log() {},
    provide() {},
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      switch (method) {
        case 'quirky.agents/list':
          if (options.failAgents) throw options.failAgents
          if (options.pendingAgents) return options.pendingAgents
          return {
            defaultAgent: options.noAgents ? '' : 'codex',
            agents: options.noAgents ? [] : [
              { id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: false },
              { id: 'gemini', label: 'Gemini', installed: true, enabled: true, isDefault: false },
              { id: 'codex', label: 'Codex', installed: true, enabled: true, isDefault: true },
              { id: 'claude-agent-teams', label: 'Claude Agent Teams', installed: true, enabled: true, isDefault: false },
              { id: 'claude-disabled', label: 'Claude disabled', installed: true, enabled: false, isDefault: false }
            ]
          }
        case 'quirky.worktree/show':
          if (options.failWorkspace) throw options.failWorkspace
          if (options.pendingWorkspace) return options.pendingWorkspace
          return { id: 'wt-1', kind: options.workspaceKind ?? 'git', path: '/work/project', name: 'project' }
        case 'quirky.loops/list':
          if (options.failLoops) throw options.failLoops
          return options.runningLoops ?? []
        case 'quirky.loops/create':
          if (options.failCreate) throw new Error('runner refused this loop')
          return created
        default:
          throw new Error(`unexpected API call: ${method}`)
      }
    },
    getSetting: () => undefined,
    toast(title: string, body: string) {
      toasts.push({ title, body })
    }
  } as unknown as UiPluginContext

  let closes = 0
  let createdCalls = 0
  const props: SetupDialogProps = {
    context,
    workspace: 'workspace-selector',
    onClose() {
      closes++
    },
    async onCreated(loop) {
      createdCalls++
      if (options.onCreated) await options.onCreated(loop)
      else if (options.failHostedTab) throw new Error('host tab unavailable')
    },
    onHandle(value) {
      handle = value
      if (options.commandTarget !== undefined) options.commandTarget.current = value
    },
    report(state) {
      reports.push(state)
    }
  }

  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(createElement(SetupDialog!, props)))

  return {
    commandCalls,
    flushCommands,
    calls,
    toasts,
    reports,
    created,
    get handle() {
      return handle!
    },
    setFailCommandAction(action: string | undefined) {
      failCommandAction = action
    },
    get closes() {
      return closes
    },
    get createdCalls() {
      return createdCalls
    },
    async ready() {
      await act(async () => {
        const tick = Promise.withResolvers<void>()
        setTimeout(tick.resolve, 0)
        await tick.promise
      })
    }
  }
}

test('the loop setup exposes its initial draft, validated config, and dialog surface', async () => {
  const [loadedForm, loadedDialog] = await Promise.all([
    import('../window/config-form').catch(() => null),
    import('../window/SetupDialog').catch(() => null)
  ])

  expect(typeof loadedForm?.initialDraft).toBe('function')
  expect(typeof loadedForm?.validateDraft).toBe('function')
  expect(typeof loadedForm?.ConfigFields).toBe('function')
  expect(typeof loadedDialog?.SetupDialog).toBe('function')
})

test('initial draft defaults are visible and empty prompt validation disables starting', () => {
  const { form: helpers } = requireSurface()
  const draft = helpers.initialDraft()
  const validation = helpers.validateDraft(draft, { workspaceKind: 'git', showCost: true })

  expect(draft).toMatchObject({
    preset: 'until-done',
    prompt: '',
    sessionPolicy: 'fresh',
    maxIterations: '10',
    checkTimeout: '300',
    noProgress: true,
    advanced: false
  })
  expect(validation.errors.prompt).toBe('Enter a prompt to start the loop.')
  expect(validation.config).toBeNull()
  expect(validation.input).toBeNull()
})

test('draftFromLoop restores a queue and its advanced settings for editing', () => {
  const { form: helpers } = requireSurface()
  const loop: LoopSnapshot = {
    id: 'loop-current',
    name: 'Review coverage',
    slug: 'review-coverage',
    worktreeId: 'wt-1',
    cwd: '/work/project',
    workspaceKind: 'git',
    agent: 'codex',
    preset: 'queue',
    config: {
      promptSource: { kind: 'queue', repeatQueue: true },
      pacing: { kind: 'on-idle' },
      sessionPolicy: 'continue',
      done: {
        check: { command: 'npm test', timeoutSeconds: 120, runWhen: 'on-claim' },
        evaluator: { condition: 'all checks pass' }
      },
      caps: { maxIterations: 4, maxActiveMinutes: 45, maxCostUsd: 12.5 },
      noProgress: false,
      protectedPaths: ['package.json', 'src/**/*.ts'],
      checkpointCommits: true,
      askBeforeNext: true,
      resumeAtLimitReset: true
    },
    state: 'paused',
    pauseReason: 'user',
    pauseDetail: null,
    sessionId: null,
    iterationsCompleted: 2,
    activeMs: 1000,
    costUsd: 3.25,
    phase: null,
    nextIterationAt: null,
    createdAt: 1,
    updatedAt: 2,
    endedAt: null,
    notesPath: '/work/project/.quirky/loops/review-coverage/notes.md',
    warnings: [],
    recentIterations: [],
    queueItems: [
      { id: 'q1', position: 0, body: 'ONE', state: 'done' },
      { id: 'q2', position: 1, body: 'TWO', state: 'pending' }
    ],
    skippedTicks: 0
  }
  const draft = helpers.draftFromLoop(loop)
  const validation = helpers.validateDraft(draft, { workspaceKind: 'git', showCost: true, editing: true })

  expect(draft).toMatchObject({
    name: 'Review coverage',
    agent: 'codex',
    preset: 'queue',
    pacingKind: 'on-idle',
    queueItems: ['ONE', 'TWO'],
    repeatQueue: true,
    maxIterations: '4',
    checkTimeout: '120',
    checkWhen: 'on-claim',
    maxActiveMinutes: '45',
    maxCostUsd: '12.5',
    protectedPaths: 'package.json\nsrc/**/*.ts',
    noProgress: false,
    checkpointCommits: true,
    askBeforeNext: true,
    resumeAtLimitReset: true
  })
  expect(validation.errors).toEqual({})
  expect(validation.config?.promptSource).toEqual({ kind: 'queue', repeatQueue: true })
  expect(validation.input).toBeNull()
})

test('edit pacing is independent of preset while create pacing follows its preset', () => {
  const { form: helpers } = requireSurface()
  const queueDraft = {
    ...helpers.initialDraft(),
    preset: 'queue' as const,
    pacingKind: 'interval' as const,
    queueItems: ['Queue item'],
    intervalMinutes: '15',
    anchor: 'wall-clock' as const
  }
  const edited = helpers.validateDraft(queueDraft, { workspaceKind: 'git', showCost: true, editing: true })
  expect(edited.errors).toEqual({})
  expect(edited.config?.pacing).toEqual({ kind: 'interval', minutes: 15, anchor: 'wall-clock' })
  expect(edited.input).toBeNull()

  const createdQueue = helpers.validateDraft(queueDraft, { workspaceKind: 'git', showCost: true })
  expect(createdQueue.config?.pacing).toEqual({ kind: 'on-idle' })
  expect(createdQueue.input?.preset).toBe('queue')

  const createdInterval = helpers.validateDraft({
    ...queueDraft,
    preset: 'interval',
    pacingKind: 'on-idle',
    prompt: 'Repeat task'
  }, { workspaceKind: 'git', showCost: true })
  expect(createdInterval.config?.pacing).toEqual({ kind: 'interval', minutes: 15, anchor: 'wall-clock' })
})

test('edit fields expose pacing while keeping the run preset immutable', async () => {
  const { form: helpers } = requireSurface()
  const draft = {
    ...helpers.initialDraft(),
    preset: 'queue' as const,
    pacingKind: 'interval' as const,
    queueItems: ['ONE'],
    intervalMinutes: '15'
  }
  const changes: Partial<LoopDraft>[] = []
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => {
    root?.render(createElement(helpers.ConfigFields, {
      draft,
      onChange: (patch) => changes.push(patch),
      errors: {},
      workspaceKind: 'git',
      showCost: false,
      editing: true
    }))
  })

  expect(host.querySelector('[aria-label="Run"]')).toBeNull()
  const pacing = host.querySelector<HTMLSelectElement>('[aria-label="Pacing"]')
  if (pacing === null) throw new Error('The Pacing selector did not render.')
  expect(pacing.value).toBe('interval')
  expect([...pacing.options].map((option) => option.textContent)).toEqual([
    'As soon as the agent is idle',
    'On an interval'
  ])
  expect(host.querySelector('[aria-label="Run every (minutes)"]')).not.toBeNull()
  await act(async () => {
    pacing.value = 'on-idle'
    pacing.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(changes.at(-1)).toEqual({ pacingKind: 'on-idle' })
})

test('numeric validation retains invalid text and reports exact boundary messages', () => {
  const { form: helpers } = requireSurface()
  const draft = {
    ...helpers.initialDraft(),
    prompt: 'Keep trying',
    preset: 'interval' as const,
    intervalMinutes: '1.5',
    maxIterations: '0',
    maxActiveMinutes: 'Infinity',
    maxCostUsd: 'NaN',
    checkCommand: 'npm test',
    checkTimeout: '601'
  }
  const validation = helpers.validateDraft(draft, { workspaceKind: 'git', showCost: true })

  expect(draft).toMatchObject({ intervalMinutes: '1.5', maxIterations: '0', maxCostUsd: 'NaN' })
  expect(validation.errors).toMatchObject({
    intervalMinutes: 'Enter a whole number of at least 1.',
    maxIterations: 'Enter a whole number of at least 1.',
    maxActiveMinutes: 'Enter a whole number of at least 1.',
    checkTimeout: 'Enter 1 to 600 seconds.',
    maxCostUsd: 'Enter an amount above 0.'
  })
  expect(validation.config).toBeNull()
})

test('folder validation omits stale hidden checkpoint and local cost settings', () => {
  const { form: helpers } = requireSurface()
  const draft = {
    ...helpers.initialDraft(),
    prompt: 'Preserve the tree',
    checkpointCommits: true,
    maxCostUsd: 'broken',
    checkTimeout: 'not-a-number'
  }
  const validation = helpers.validateDraft(draft, { workspaceKind: 'folder', showCost: false })

  expect(validation.errors).toEqual({})
  expect(validation.config).toMatchObject({ checkpointCommits: false, promptSource: { kind: 'repeat', body: 'Preserve the tree' } })
  expect(validation.config?.caps).not.toHaveProperty('maxCostUsd')
  expect(validation.config?.done).not.toHaveProperty('check')
  expect(validation.input?.name).toBe('Preserve the tree')
  const named = helpers.validateDraft({ ...draft, name: '  Chosen name  ' }, { workspaceKind: 'folder', showCost: false })
  expect(named.input?.name).toBe('Chosen name')
  const longPrompt = helpers.validateDraft({ ...draft, prompt: `${'A'.repeat(52)}\nsecond line` }, { workspaceKind: 'folder', showCost: false })
  expect(longPrompt.input?.name).toBe('A'.repeat(48))
})

test('blank queue bodies stay in the draft and show the queue error', () => {
  const { form: helpers } = requireSurface()
  const draft = { ...helpers.initialDraft(), preset: 'queue' as const, queueItems: ['  '] }
  const validation = helpers.validateDraft(draft, { workspaceKind: 'git', showCost: true })

  expect(draft.queueItems).toEqual(['  '])
  expect(validation.errors['queueItems.0']).toBe('Queue prompts cannot be blank.')
  expect(validation.config).toBeNull()
})

test('preserves empty-queue guidance and blank-body field errors', async () => {
  const view = setup()
  await view.ready()
  await act(async () => {
    await view.handle.dispatch('update', { patch: { preset: 'queue' } })
  })

  expect(host.querySelector('.ui-empty-state')?.textContent).toBe('Add at least one prompt to the queue.')
  await act(async () => {
    await view.handle.dispatch('queue-add', { body: '  ' })
  })

  const prompt = host.querySelector<HTMLTextAreaElement>('[aria-label="Queue item 1"]')
  expect(prompt?.value).toBe('  ')
  expect(prompt?.getAttribute('aria-invalid')).toBe('true')
  expect(prompt?.parentElement?.querySelector('.ui-error-text[role="alert"]')?.textContent)
    .toBe('Queue prompts cannot be blank.')
  expect(readSetup(view.handle).draft.queueItems).toEqual(['  '])
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
})

test('setup loads only installed enabled native agents, selects the default, and warns for a running workspace loop', async () => {
  const view = setup({ runningLoops: [{ id: 'existing', worktreeId: 'wt-1', state: 'running' }] })
  await view.ready()
  await act(async () => {
    await view.handle.dispatch('update', { patch: { prompt: 'Start another loop' } })
  })

  const read = readSetup(view.handle)
  const agent = host.querySelector<HTMLSelectElement>('[aria-label="Agent"]')
  if (agent === null) throw new Error('The agent selector did not render.')
  expect(agent.value).toBe('codex')
  expect([...agent.options].map((option) => option.value)).toEqual(['codex', 'claude'])
  expect(read.workspaceKind).toBe('git')
  expect(read.showCost).toBe(true)
  const expectedWarning = 'This workspace already has a running loop. A second loop edits the same files at the same time.'
  expect(read.warning).toBe(expectedWarning)
  expect(host.querySelector('.ui-notice-line')?.textContent).toContain(expectedWarning)
  expect(host.querySelector('.ui-notice-line [role="status"]')?.textContent).toContain(expectedWarning)
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false)
  expect(view.calls).toContainEqual({ method: 'quirky.worktree/show', params: { worktree: 'workspace-selector' } })
  expect(view.calls).toContainEqual({ method: 'quirky.loops/list', params: { worktreeId: 'wt-1' } })
})

test('running loops in other workspaces do not trigger the warning', async () => {
  const view = setup({ runningLoops: [{ id: 'elsewhere', worktreeId: 'wt-elsewhere', state: 'running' }] })
  await view.ready()

  expect(readSetup(view.handle).warning).toBeNull()
  expect(host.textContent).not.toContain('This workspace already has a running loop.')
})

test('shows one shared workspace read error and retains its source in the report', async () => {
  const view = setup({ failWorkspace: new Error('read refused') })
  await view.ready()

  expect([...host.querySelectorAll<HTMLElement>('.ui-inline-error[role="alert"]')].map((item) => item.textContent))
    .toEqual(['Could not load the workspace: read refused'])
  expect(readSetup(view.handle).loadError).toBe('workspace: read refused')
})

test('shows one shared agent read error and retains its source in the report', async () => {
  const view = setup({ failAgents: new Error('read refused') })
  await view.ready()

  expect([...host.querySelectorAll<HTMLElement>('.ui-inline-error[role="alert"]')].map((item) => item.textContent))
    .toEqual(['Could not load agents: read refused'])
  expect(readSetup(view.handle).loadError).toBe('agents: read refused')
})

test('shows one shared existing-loop read error without prohibiting a second loop', async () => {
  const view = setup({ failLoops: new Error('read refused') })
  await view.ready()
  await act(async () => {
    await view.handle.dispatch('update', { patch: { prompt: 'Start another loop' } })
  })

  expect([...host.querySelectorAll<HTMLElement>('.ui-inline-error[role="alert"]')].map((item) => item.textContent))
    .toEqual(['Could not check for existing loops: read refused'])
  expect(readSetup(view.handle).loadError).toBe('loops: read refused')
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(false)
})

test('uses a shared notice while workspace and agent reads are pending', async () => {
  const pendingWorkspace = Promise.withResolvers<unknown>()
  const pendingAgents = Promise.withResolvers<unknown>()
  const view = setup({ pendingWorkspace: pendingWorkspace.promise, pendingAgents: pendingAgents.promise })
  await view.ready()

  const notice = host.querySelector<HTMLElement>('.ui-notice-line')
  expect(notice?.textContent).toContain('Loading workspace and agents…')
  expect(notice?.querySelector('[role="status"]')?.textContent).toBe('Loading workspace and agents…')
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)

  pendingWorkspace.resolve({ id: 'wt-1', kind: 'git', path: '/work/project', name: 'project' })
  pendingAgents.resolve({ defaultAgent: 'codex', agents: [{ id: 'codex', label: 'Codex', installed: true, enabled: true, isDefault: true }] })
  await Promise.all([pendingWorkspace.promise, pendingAgents.promise])
  await view.ready()
})

test('shows an empty state when no installed enabled Claude or Codex agent is available', async () => {
  const view = setup({ noAgents: true })
  await view.ready()

  expect(host.querySelector('.ui-empty-state')?.textContent)
    .toBe('No installed and enabled Claude or Codex agents are available.')
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
})

test('folder setup hides checkpoints and reveals check controls only after a command', async () => {
  const view = setup({ workspaceKind: 'folder' })
  await view.ready()

  expect(readSetup(view.handle).workspaceKind).toBe('folder')
  expect(readSetup(view.handle).showCost).toBe(true)
  const advanced = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Advanced'))
  if (advanced === undefined) throw new Error('The Advanced control did not render.')
  await act(async () => {
    advanced.click()
  })
  expect(host.querySelector('[aria-label="Maximum cost (USD)"]')).not.toBeNull()
  expect(host.textContent).not.toContain('Commit a checkpoint after each iteration')
  expect(host.querySelector('[aria-label="Check timeout (seconds)"]')).toBeNull()

  await act(async () => {
    await view.handle.dispatch('update', { patch: { prompt: 'Do the work', checkCommand: 'npm test', checkTimeout: '601' } })
  })
  expect(host.querySelector('[aria-label="Check timeout (seconds)"]')).not.toBeNull()
  expect(host.textContent).toContain('Enter 1 to 600 seconds.')
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
  expect(view.commandCalls).toEqual([{
    id: 'command:quirky.loops/setup-action',
    args: { action: 'advanced', params: { open: true } }
  }])
})

test('submits setup through the public command once and prevents native navigation', async () => {
  const view = setup()
  await view.ready()
  const name = host.querySelector<HTMLInputElement>('[aria-label="Loop name"]')!
  const prompt = host.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')!
  await act(async () => setValue(name, 'Do it'))
  await view.ready()
  await act(async () => setValue(prompt, 'Do it'))
  await view.ready()

  const form = host.querySelector<HTMLFormElement>('form[aria-label="New loop"]')!
  const submitEvent = new Event('submit', { bubbles: true, cancelable: true })
  await act(async () => {
    form.dispatchEvent(submitEvent)
  })
  await view.ready()

  expect(submitEvent.defaultPrevented).toBe(true)
  expect(view.commandCalls).toEqual([
    { id: 'command:quirky.loops/setup-action', args: { action: 'update', params: { patch: { name: 'Do it' } } } },
    { id: 'command:quirky.loops/setup-action', args: { action: 'update', params: { patch: { prompt: 'Do it' } } } },
    { id: 'command:quirky.loops/setup-action', args: { action: 'start', params: {} } }
  ])
  expect(view.calls.filter((call) => call.method === 'quirky.loops/create')).toHaveLength(1)
  expect(view.calls.find((call) => call.method === 'quirky.loops/create')?.params)
    .toMatchObject({ name: 'Do it', config: { promptSource: { kind: 'repeat', body: 'Do it' } } })
  expect(view.createdCalls).toBe(1)
  expect(view.closes).toBe(1)
})

test('keeps setup prompt caret stable while command acknowledgements are deferred', async () => {
  const firstCommand = Promise.withResolvers<void>()
  const secondCommand = Promise.withResolvers<void>()
  const view = setup({ commandGates: [firstCommand.promise, secondCommand.promise] })
  await view.ready()
  await act(async () => {
    await view.handle.dispatch('update', { patch: { prompt: 'Do it' } })
  })
  const prompt = host.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')!
  prompt.focus()
  prompt.setSelectionRange(2, 2)

  try {
    await act(async () => typeAtCaret(prompt, 'X'))
    await view.ready()
    await act(async () => typeAtCaret(prompt, 'Y'))
    await view.ready()

    expect(prompt.value).toBe('DoXY it')
    expect(prompt.selectionStart).toBe(4)
    expect(view.commandCalls).toEqual([{
      id: 'command:quirky.loops/setup-action',
      args: { action: 'update', params: { patch: { prompt: 'DoX it' } } }
    }])

    await act(async () => {
      firstCommand.resolve()
      await firstCommand.promise
      await Promise.resolve()
      await view.flushCommands()
    })
    await view.ready()
    expect(view.commandCalls).toEqual([
      { id: 'command:quirky.loops/setup-action', args: { action: 'update', params: { patch: { prompt: 'DoX it' } } } },
      { id: 'command:quirky.loops/setup-action', args: { action: 'update', params: { patch: { prompt: 'DoXY it' } } } }
    ])
    expect(prompt.value).toBe('DoXY it')
    expect(prompt.selectionStart).toBe(4)

    await act(async () => {
      secondCommand.resolve()
      await secondCommand.promise
      await Promise.resolve()
      await view.flushCommands()
    })
    await view.ready()
    expect(readSetup(view.handle).draft.prompt).toBe('DoXY it')
    expect(prompt.value).toBe('DoXY it')
    expect(prompt.selectionStart).toBe(4)
  } finally {
    await act(async () => {
      firstCommand.resolve()
      secondCommand.resolve()
      await Promise.resolve()
      await view.flushCommands()
    })
    await view.ready()
  }
})

test('does not run queued setup updates after the dialog unmounts', async () => {
  const firstCommand = Promise.withResolvers<void>()
  const commandTarget: { current: SurfaceHandle | null } = { current: null }
  const view = setup({ commandGates: [firstCommand.promise], commandTarget })
  await view.ready()
  await act(async () => {
    await view.handle.dispatch('update', { patch: { prompt: 'Do it' } })
  })
  const prompt = host.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')!
  prompt.focus()
  prompt.setSelectionRange(2, 2)
  await act(async () => typeAtCaret(prompt, 'X'))
  await view.ready()
  await act(async () => typeAtCaret(prompt, 'Y'))
  await view.ready()
  expect(view.commandCalls).toHaveLength(1)

  await unmount()
  const replacement = setup({ commandTarget })
  await replacement.ready()

  try {
    await act(async () => {
      firstCommand.resolve()
      await firstCommand.promise
      await Promise.resolve()
      await view.flushCommands()
    })
    await replacement.ready()

    expect(view.commandCalls).toHaveLength(1)
    expect(readSetup(replacement.handle).draft.prompt).not.toBe('DoXY it')
  } finally {
    await act(async () => {
      firstCommand.resolve()
      await Promise.resolve()
      await view.flushCommands()
    })
    await replacement.ready()
  }
})

test('reconciles an unsynced queue edit when an earlier item is removed', async () => {
  const view = setup()
  await view.ready()
  await act(async () => {
    await view.handle.dispatch('update', { patch: { preset: 'queue' } })
    await view.handle.dispatch('queue-add', { body: 'first' })
    await view.handle.dispatch('queue-add', { body: 'second' })
  })
  await view.ready()
  view.setFailCommandAction('queue-edit')
  const edited = host.querySelector<HTMLTextAreaElement>('[aria-label="Queue item 2"]')!
  await act(async () => setValue(edited, 'Edited second'))
  await view.ready()
  expect(edited.value).toBe('Edited second')
  expect(readSetup(view.handle).draft.queueItems).toEqual(['first', 'second'])

  view.setFailCommandAction(undefined)
  await act(async () => button(host, 'Remove queue item 1').click())
  await view.ready()

  const remaining = host.querySelectorAll<HTMLTextAreaElement>('textarea[aria-label^="Queue item "]')
  expect(remaining).toHaveLength(1)
  expect(remaining[0]?.value).toBe('Edited second')
  expect(button(host, 'Start loop').disabled).toBe(true)
})

test('a rejected queue-add bridge keeps the local composer draft visible', async () => {
  const view = setup({ failCommandAction: 'queue-add' })
  await view.ready()
  await act(async () => {
    await view.handle.dispatch('update', { patch: { preset: 'queue' } })
  })
  const composer = host.querySelector<HTMLTextAreaElement>('[aria-label="New queue item"]')!
  await act(async () => setValue(composer, 'keep this queue draft'))
  await view.ready()
  await act(async () => button(host, 'Add to queue').click())
  await view.ready()

  expect(view.commandCalls).toEqual([{
    id: 'command:quirky.loops/setup-action',
    args: { action: 'queue-add', params: { body: 'keep this queue draft' } }
  }])
  expect((host.querySelector<HTMLTextAreaElement>('[aria-label="New queue item"]')!).value)
    .toBe('keep this queue draft')
  expect(host.querySelector('.ui-inline-error[role="alert"]')?.textContent).toBe('bridge refused')
  expect(readSetup(view.handle).draft.queueItems).toEqual([])
  expect(view.calls.filter((call) => call.method === 'quirky.loops/create')).toHaveLength(0)
})

test('routes setup queue edits through its public command boundary', async () => {
  const view = setup()
  await view.ready()
  const run = host.querySelector<HTMLSelectElement>('[aria-label="Run"]')!
  await act(async () => setSelectValue(run, 'queue'))
  await view.ready()

  const composer = host.querySelector<HTMLTextAreaElement>('[aria-label="New queue item"]')!
  await act(async () => setValue(composer, 'ONE'))
  await view.ready()
  await act(async () => button(host, 'Add to queue').click())
  await view.ready()
  expect((host.querySelector<HTMLTextAreaElement>('[aria-label="New queue item"]')!).value).toBe('')

  await act(async () => setValue(host.querySelector<HTMLTextAreaElement>('[aria-label="New queue item"]')!, 'TWO'))
  await view.ready()
  await act(async () => button(host, 'Add to queue').click())
  await view.ready()
  await act(async () => setValue(host.querySelector<HTMLTextAreaElement>('[aria-label="Queue item 2"]')!, 'TWO edited'))
  await view.ready()
  await act(async () => button(host, 'Move queue item 2 up').click())
  await view.ready()
  await act(async () => button(host, 'Remove queue item 2').click())
  await view.ready()
  await act(async () => button(host, 'Cancel').click())

  expect(view.commandCalls).toEqual([
    { id: 'command:quirky.loops/setup-action', args: { action: 'update', params: { patch: { preset: 'queue' } } } },
    { id: 'command:quirky.loops/setup-action', args: { action: 'queue-add', params: { body: 'ONE' } } },
    { id: 'command:quirky.loops/setup-action', args: { action: 'queue-add', params: { body: 'TWO' } } },
    { id: 'command:quirky.loops/setup-action', args: { action: 'queue-edit', params: { index: 1, body: 'TWO edited' } } },
    { id: 'command:quirky.loops/setup-action', args: { action: 'queue-move', params: { index: 1, position: 'up' } } },
    { id: 'command:quirky.loops/setup-action', args: { action: 'queue-remove', params: { index: 1 } } },
    { id: 'command:quirky.loops/setup-action', args: { action: 'cancel', params: {} } }
  ])
  expect(readSetup(view.handle).draft.queueItems).toEqual(['TWO edited'])
  expect(view.closes).toBe(1)
})

test('preset changes reset session and the queue editor shares add, edit, move, and remove state', async () => {
  const view = setup()
  await view.ready()

  await act(async () => {
    await view.handle.dispatch('update', { patch: { preset: 'interval' } })
  })
  expect(readSetup(view.handle).draft.sessionPolicy).toBe('continue')
  expect(readSetup(view.handle).draft.pacingKind).toBe('interval')
  const runEvery = host.querySelector<HTMLInputElement>('[aria-label="Run every (minutes)"]')
  expect(runEvery).not.toBeNull()

  await act(async () => {
    await view.handle.dispatch('update', { patch: { sessionPolicy: 'fresh', preset: 'queue' } })
    await view.handle.dispatch('queue-add', { body: 'ONE' })
    await view.handle.dispatch('queue-add', { body: 'TWO' })
    await view.handle.dispatch('queue-edit', { index: 1, body: 'TWO edited' })
    await view.handle.dispatch('queue-move', { index: 1, position: 0 })
    await view.handle.dispatch('queue-move', { index: 0, position: 'down' })
    await view.handle.dispatch('queue-move', { index: 1, position: 'up' })
    await view.handle.dispatch('queue-remove', { index: 1 })
    await view.handle.dispatch('update', { patch: { repeatQueue: true } })
  })

  expect(readSetup(view.handle).draft).toMatchObject({
    preset: 'queue',
    pacingKind: 'on-idle',
    sessionPolicy: 'continue',
    queueItems: ['TWO edited'],
    repeatQueue: true
  })
  expect(host.textContent).toContain('Queue')
  expect(host.querySelector<HTMLTextAreaElement>('[aria-label="Queue item 1"]')?.value).toBe('TWO edited')
})

test('a failed create retains the exact draft, shows and toasts the server message, without closing', async () => {
  const view = setup({ failCreate: true })
  await view.ready()
  await act(async () => {
    await view.handle.dispatch('update', { patch: { prompt: '  preserve this prompt  ' } })
    await view.handle.dispatch('start')
  })

  expect(view.calls.filter((call) => call.method === 'quirky.loops/create')).toHaveLength(1)
  expect(readSetup(view.handle).draft.prompt).toBe('  preserve this prompt  ')
  expect(host.querySelector('.ui-inline-error[role="alert"]')?.textContent).toBe('runner refused this loop')
  expect(host.textContent).toContain('runner refused this loop')
  expect(view.toasts).toContainEqual({ title: 'Could not start the loop.', body: 'runner refused this loop' })
  expect(view.closes).toBe(0)
  const report = view.reports.at(-1)
  if (!isReadView(report)) throw new Error('The setup report did not include the preserved draft.')
  expect(report.draft.prompt).toBe('  preserve this prompt  ')
})

test('a hosted-tab failure after creation cannot resubmit a second loop', async () => {
  const view = setup({ failHostedTab: true })
  await view.ready()
  await act(async () => {
    await view.handle.dispatch('update', { patch: { prompt: 'Start once' } })
    await view.handle.dispatch('start')
  })

  await act(async () => {
    await view.handle.dispatch('start')
  })
  expect(view.calls.filter((call) => call.method === 'quirky.loops/create')).toHaveLength(1)
  expect(view.createdCalls).toBe(1)
  expect(readSetup(view.handle).alreadyCreated).toBe(true)
  expect(host.querySelector('.ui-inline-error[role="alert"]')?.textContent)
    .toBe('Loop started, but its tab could not be opened: host tab unavailable')
  expect(view.closes).toBe(0)
})
test('a successful start waits for the hosted tab before closing', async () => {
  const hostedTab = Promise.withResolvers<void>()
  const view = setup({ onCreated: async () => hostedTab.promise })
  await view.ready()
  await act(async () => {
    await view.handle.dispatch('update', { patch: { prompt: 'Start the loop' } })
  })

  let start: Promise<unknown> | undefined
  await act(async () => {
    start = view.handle.dispatch('start')
    await Promise.resolve()
  })
  expect(view.createdCalls).toBe(1)
  expect(view.closes).toBe(0)
  hostedTab.resolve()
  await act(async () => {
    await start
  })
  expect(view.calls.filter((call) => call.method === 'quirky.loops/create')).toHaveLength(1)
  expect(view.closes).toBe(1)
})


test('cancel closes the dialog without creating a loop and invalid surface actions are rejected', async () => {
  const view = setup()
  await view.ready()
  await expect(view.handle.dispatch('unknown-action')).rejects.toThrow('Unknown setup action')
  await expect(view.handle.dispatch('update', { patch: { unsupportedField: true } })).rejects.toThrow('Unsupported')
  await act(async () => {
    await view.handle.dispatch('cancel')
  })
  expect(view.calls.filter((call) => call.method === 'quirky.loops/create')).toHaveLength(0)
  expect(view.closes).toBe(1)
  expect(view.commandCalls).toEqual([])
})
