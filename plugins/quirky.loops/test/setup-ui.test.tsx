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
type DraftView = Pick<LoopDraft, 'prompt' | 'sessionPolicy' | 'preset' | 'queueItems' | 'repeatQueue'> & {
  pacingKind?: 'on-idle' | 'interval'
}
type ReadView = {
  draft: DraftView
  workspaceKind: 'git' | 'folder' | null
  showCost: boolean
  warning: string | null
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
    typeof value.alreadyCreated === 'boolean'
}

function readSetup(handle: SurfaceHandle): ReadView {
  const result = handle.read()
  if (!isReadView(result)) throw new Error('The setup surface returned an invalid read state.')
  return result
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

function requireSurface() {
  if (!form || !SetupDialog) throw new Error('setup surface is unavailable')
  return { form, SetupDialog }
}

function setup(options: {
  failCreate?: boolean
  failHostedTab?: boolean
  runningLoops?: unknown[]
  workspaceKind?: 'git' | 'folder'
  onCreated?: (loop: LoopSnapshot) => Promise<void>
} = {}) {
  const calls: Call[] = []
  const toasts: { title: string; body: string }[] = []
  const reports: unknown[] = []
  const created = { id: 'loop-1', name: 'Do the work', worktreeId: 'wt-1', state: 'running' }
  const context = {
    pluginId: 'quirky.loops',
    log() {},
    provide() {},
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      switch (method) {
        case 'quirky.agents/list':
          return {
            defaultAgent: 'codex',
            agents: [
              { id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: false },
              { id: 'gemini', label: 'Gemini', installed: true, enabled: true, isDefault: false },
              { id: 'codex', label: 'Codex', installed: true, enabled: true, isDefault: true },
              { id: 'claude-agent-teams', label: 'Claude Agent Teams', installed: true, enabled: true, isDefault: false },
              { id: 'claude-disabled', label: 'Claude disabled', installed: true, enabled: false, isDefault: false }
            ]
          }
        case 'quirky.worktree/show':
          return { id: 'wt-1', kind: options.workspaceKind ?? 'git', path: '/work/project', name: 'project' }
        case 'quirky.loops/list':
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

  let handle: SurfaceHandle | null = null
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
    calls,
    toasts,
    reports,
    created,
    get handle() {
      return handle!
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

test('setup loads only installed enabled native agents, selects the default, and warns for a running workspace loop', async () => {
  const view = setup({ runningLoops: [{ id: 'existing', worktreeId: 'wt-1', state: 'running' }] })
  await view.ready()

  const read = readSetup(view.handle)
  const agent = host.querySelector<HTMLSelectElement>('[aria-label="Agent"]')
  if (agent === null) throw new Error('The agent selector did not render.')
  expect(agent.value).toBe('codex')
  expect([...agent.options].map((option) => option.value)).toEqual(['codex', 'claude'])
  expect(read.workspaceKind).toBe('git')
  expect(read.showCost).toBe(true)
  expect(read.warning).toBe('This workspace already has a running loop. A second loop edits the same files at the same time.')
  expect(host.textContent).toContain('Enter a prompt to start the loop.')
  expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true)
  expect(view.calls).toContainEqual({ method: 'quirky.worktree/show', params: { worktree: 'workspace-selector' } })
  expect(view.calls).toContainEqual({ method: 'quirky.loops/list', params: { worktreeId: 'wt-1' } })
})

test('running loops in other workspaces do not trigger the warning', async () => {
  const view = setup({ runningLoops: [{ id: 'elsewhere', worktreeId: 'wt-elsewhere', state: 'running' }] })
  await view.ready()

  expect(readSetup(view.handle).warning).toBeNull()
  expect(host.textContent).not.toContain('This workspace already has a running loop.')
})

test('folder setup hides checkpoints and reveals check controls only after a command', async () => {
  const view = setup({ workspaceKind: 'folder' })
  await view.ready()

  expect(readSetup(view.handle).workspaceKind).toBe('folder')
  expect(readSetup(view.handle).showCost).toBe(true)
  const advanced = host.querySelector<HTMLButtonElement>('.loop-advanced-toggle')
  if (advanced === null) throw new Error('The Advanced control did not render.')
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
  expect(host.textContent).toContain('host tab unavailable')
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
})
