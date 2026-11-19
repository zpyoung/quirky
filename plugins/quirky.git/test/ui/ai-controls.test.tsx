import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { registerDom } from './register-dom'
import type { GitUiControl, GitUiControlAddress } from '../../src/ui-control'
import type { Fake } from './panel-support'

registerDom()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
// ReactDOM, the activated plugin and portal-backed components load after Happy DOM is installed.
const s = await import('./panel-support')
const {
  act,
  byLabel,
  buttonText,
  click,
  entry,
  failure,
  fakeContext,
  layoutFor,
  mountPanel,
  press,
  q,
  qa,
  settle,
  statusOf,
  type
} = s

const PANEL = 'panel:quirky.git/source-control'
const AI_SURFACE = PANEL
const UI_CONTROL_COMMAND = 'command:quirky.git/ui-control'
const AGENTS = {
  defaultAgent: 'claude',
  agents: [
    { id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: true, canGenerate: true },
    { id: 'codex', label: 'Codex', installed: true, enabled: true, isDefault: false, canGenerate: true }
  ]
}
const EFFORT_CHOICES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max' }
]
const OPTION = { id: 'effort', label: 'Effort', type: 'select', choices: EFFORT_CHOICES }

afterAll(() => GlobalRegistrator.unregister())
beforeEach(() => { document.body.innerHTML = '' })
const mountedPanels = new Set<() => void>()
afterEach(() => {
  for (const unmount of [...mountedPanels]) unmount()
  jest.useRealTimers()
  document.body.innerHTML = ''
})

function deferred<T = unknown>() {
  return Promise.withResolvers<T>()
}

function recipe(action: string, extra: Record<string, unknown> = {}) {
  const { sources, ...fields } = extra
  return {
    action,
    agent: null,
    args: '',
    template: '{basePrompt}',
    launchOptions: {},
    ...fields,
    sources: { agent: 'default', args: 'default', template: 'default', launchOptions: 'default', ...(sources as Record<string, string> | undefined) }
  }
}

function aiFake(configure: (fake: Fake) => void = () => {}, connId?: number): Fake {
  const fake = fakeContext(layoutFor('feat'), connId)
  fake.settings['ai-enabled'] = true
  fake.status = statusOf([entry('util.ts', 'staged')])
  fake.on('quirky.agents/list', () => AGENTS)
  fake.on('quirky.session/list', () => [])
  fake.on('quirky.agents/options', (params) => ({
    agent: params.agent,
    label: params.agent === 'codex' ? 'Codex' : 'Claude',
    supported: true,
    models: (params.agent === 'codex'
      ? [{ id: 'gpt-5.5', label: 'GPT-5.5' }, { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' }]
      : [{ id: 'fable', label: 'Fable' }, { id: 'opus', label: 'Opus' }, { id: 'haiku', label: 'Haiku', noEffort: true }])
      .map((model) => ({ id: model.id, label: model.label, description: null, options: 'noEffort' in model ? [] : [OPTION] })),
    unlisted: 'accept',
    unlistedOptions: [OPTION],
    structured: false,
    extraArgs: { supported: true, allowed: '--model, --effort', placeholder: '--model opus --effort high', message: null }
  }))
  fake.on('quirky.git/aiRecipe', (params) => recipe(params.action as string))
  fake.on('quirky.git/generateCommitMessage', () => ({ message: 'Rename x to count\n\nClearer name.', subject: 'Rename x to count', body: 'Clearer name.', agent: 'claude' }))
  fake.on('quirky.git/cancelGenerate', () => ({ cancelled: true }))
  fake.on('quirky.git/aiFix', (params) => ({ session: 's1', agent: (params.agent as string | undefined) ?? 'claude', prompt: 'p', saved: params.save !== undefined }))
  fake.on('quirky.git/aiFixPreview', (params) => ({ prompt: `Fix prompt for ${params.action}`, recipe: recipe(params.action as string) }))
  configure(fake)
  return fake
}

function mount(fake: Fake) {
  const mounted = mountPanel(fake)
  let active = true
  const unmount = () => {
    if (!active) return
    active = false
    mountedPanels.delete(unmount)
    mounted.unmount()
  }
  mountedPanels.add(unmount)
  return { ...mounted, unmount }
}

async function open(configure?: (fake: Fake) => void, connId?: number) {
  const fake = aiFake(configure, connId)
  const mounted = mount(fake)
  await settle()
  return { fake, ...mounted }
}

const sparkle = (element: HTMLElement) => byLabel(element, 'Generate commit message with AI') as HTMLButtonElement | null
const stop = (element: HTMLElement) => byLabel(element, 'Stop generating commit message') as HTMLButtonElement | null
const message = (element: HTMLElement) => byLabel(element, 'Commit message') as HTMLTextAreaElement
const dialog = () => q(document.body, '[role="dialog"]')
const dialogTitle = () => dialog()?.querySelector('h2')?.textContent ?? dialog()?.getAttribute('aria-label')
const menuFor = (root: ParentNode, label: string) =>
  qa(root, 'button[aria-haspopup="menu"]').find((button) => button.getAttribute('aria-label') === label) ?? null
const primary = (element: HTMLElement) => q(element, '.ui-split-button__primary') as HTMLButtonElement
const menuEntry = (label: string) =>
  qa(document.body, '[role="menuitem"]').find((item) => q(item, '.qt-menu-label')?.firstChild?.textContent === label) as HTMLButtonElement | undefined
const launchField = (label: string) => byLabel(dialog()!, label) as HTMLInputElement & HTMLTextAreaElement & HTMLSelectElement

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

const commitBlocked = (fake: Fake) => fake.on('quirky.git/commit', () => {
  throw failure('Lint failed during commit.', { reason: 'lint', summary: 'Lint failed during commit.', output: 'eslint found 2 problems' })
})

async function openLaunch(configure: (fake: Fake) => void = () => {}) {
  const mounted = await open((fake) => {
    commitBlocked(fake)
    configure(fake)
  })
  await type(message(mounted.element), 'Rename x')
  await click(primary(mounted.element))
  await click(menuFor(mounted.element, 'Choose an agent for this commit failure'))
  await click(buttonText(document.body, 'Customize launch...'))
  return mounted
}

type Address = GitUiControlAddress

function uiControls(fake: Fake): Address[] {
  for (const report of [...fake.reports].reverse()) {
    if (typeof report !== 'object' || report === null || !('uiControls' in report)) continue
    if (Array.isArray(report.uiControls)) return report.uiControls as Address[]
  }
  return []
}

function aiControls(fake: Fake): Address[] {
  return uiControls(fake).filter((address) => address.surface === AI_SURFACE && address.target.startsWith('ai-'))
}

function address(fake: Fake, target: string): Address | undefined {
  return aiControls(fake).find((candidate) => candidate.target === target)
}

function requiredAddress(fake: Fake, target: string): Address {
  const found = address(fake, target)
  expect(found, `missing ${target} control address`).toBeDefined()
  return found!
}

function control(address: Address, action: string, data?: Record<string, unknown>): GitUiControl {
  return {
    surface: address.surface,
    target: address.target,
    generation: address.generation,
    action,
    ...(data === undefined ? {} : { data })
  }
}

function invoke(fake: Fake, args: unknown): Promise<unknown> {
  return fake.context.call('ui.window.command.run', {
    connId: fake.connId,
    id: UI_CONTROL_COMMAND,
    args
  })
}

async function dispatch(fake: Fake, args: unknown): Promise<unknown> {
  let reply: unknown
  await act(async () => { reply = await invoke(fake, args) })
  await settle()
  return reply
}

async function dispatchSameTurn(fake: Fake, args: unknown[]): Promise<unknown[]> {
  let replies: unknown[] = []
  await act(async () => { replies = await Promise.all(args.map((item) => invoke(fake, item))) })
  await settle()
  return replies
}

function commandCalls(fake: Fake) {
  return fake.called('ui.window.command.run').map(({ params }) => params)
}
function controlArgs(params: Record<string, unknown>): Record<string, unknown> {
  const args = params.args
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : {}
}

function delivered(reply: unknown, value: boolean) {
  expect(reply).toEqual({ result: { delivered: value } })
}

const AI_ACTION_METHODS: Record<string, true> = {
  'quirky.git/generateCommitMessage': true,
  'quirky.git/cancelGenerate': true,
  'quirky.git/aiFix': true
}

function aiActionCalls(fake: Fake) {
  return fake.calls.filter(({ method }) => AI_ACTION_METHODS[method] === true)
}

async function refusedWithoutChange(fake: Fake, args: unknown) {
  const before = document.body.innerHTML
  const beforeActions = aiActionCalls(fake)
  delivered(await dispatch(fake, args), false)
  expect(document.body.innerHTML).toBe(before)
  expect(aiActionCalls(fake)).toEqual(beforeActions)
}

function lastRoutedControl(fake: Fake): GitUiControl | undefined {
  const args = commandCalls(fake).at(-1)?.args
  return typeof args === 'object' && args !== null && !Array.isArray(args) ? args as GitUiControl : undefined
}

function sparkleAddress(fake: Fake): Address {
  return requiredAddress(fake, 'ai-sparkle:feat')
}

function menuAddress(fake: Fake): Address {
  return requiredAddress(fake, 'ai-sparkle-menu:feat')
}

function generateDialogAddress(fake: Fake): Address {
  return requiredAddress(fake, 'ai-generate-dialog:feat')
}

function launchAddress(fake: Fake): Address {
  return requiredAddress(fake, 'ai-launch:feat:fixCommitFailure')
}

// Bun exposes this Jest-compatible timer API at runtime, although its typings omit it.
const advance = (ms: number) => (jest as unknown as { advanceTimersByTime(ms: number): void }).advanceTimersByTime(ms)

describe('Git AI scoped controls', () => {
  test('discovers one per-mount sparkle address and updates its advertised actions while busy', async () => {
    const { fake, element, unmount } = await open()
    const initial = sparkleAddress(fake)
    expect(aiControls(fake).filter(({ target }) => target === 'ai-sparkle:feat')).toHaveLength(1)
    expect(initial).toMatchObject({ surface: AI_SURFACE, target: 'ai-sparkle:feat', actions: ['generate', 'menu-open'] })
    expect(Object.keys(initial).sort()).toEqual(['actions', 'generation', 'surface', 'target'])
    expect(initial.generation).toMatch(/^ai-\d+$/)

    const run = deferred()
    fake.on('quirky.git/generateCommitMessage', () => run.promise)
    await click(sparkle(element))
    expect(sparkleAddress(fake)).toMatchObject({ actions: ['stop', 'menu-open'] })
    expect(stop(element)).not.toBeNull()

    await click(byLabel(element, 'Commit message options'))
    expect(menuAddress(fake)).toMatchObject({ actions: ['close'] })
    expect(JSON.stringify(aiControls(fake))).not.toContain('util.ts')
    expect(JSON.stringify(aiControls(fake))).not.toContain('Fix prompt')
    run.reject(failure('Generation was stopped.', { reason: 'cancelled' }))
    await settle()
    unmount()
  })

  test('click and command generate use the same sparkle route and current worktree scope', async () => {
    const { fake, element, unmount } = await open()
    await click(sparkle(element))
    expect(fake.called('quirky.git/generateCommitMessage').map(({ params }) => params)).toEqual([
      { worktree: 'feat', scope: 'staged' }
    ])
    expect(message(element).value).toBe('Rename x to count\n\nClearer name.')
    expect(q(element, '[data-git-written-by]')?.textContent).toBe('Written by Claude')
    expect(lastRoutedControl(fake)).toMatchObject({
      surface: AI_SURFACE,
      target: 'ai-sparkle:feat',
      generation: sparkleAddress(fake).generation,
      action: 'generate'
    })

    await type(message(element), '')
    const reply = await dispatch(fake, control(sparkleAddress(fake), 'generate'))
    delivered(reply, true)
    expect(fake.called('quirky.git/generateCommitMessage').map(({ params }) => params)).toEqual([
      { worktree: 'feat', scope: 'staged' },
      { worktree: 'feat', scope: 'staged' }
    ])
    expect(message(element).value).toBe('Rename x to count\n\nClearer name.')
    unmount()
  })

  test('a no-agent sparkle command opens AI settings instead of starting a generation', async () => {
    const { fake, element, unmount } = await open((f) => f.on('quirky.agents/list', () => ({
      defaultAgent: 'claude',
      agents: [{ id: 'claude', label: 'Claude', installed: true, enabled: false, isDefault: true, canGenerate: true }]
    })))
    delivered(await dispatch(fake, control(sparkleAddress(fake), 'generate')), true)
    expect(fake.views).toEqual([{ id: 'view:quirky.git/ai-settings', input: { worktree: 'feat' } }])
    expect(fake.called('quirky.git/generateCommitMessage')).toEqual([])
    unmount()
  })

  test('stop command and Stop click both cancel the accepted run without exposing its later refusal', async () => {
    const run = deferred()
    const { fake, element, unmount } = await open((f) => f.on('quirky.git/generateCommitMessage', () => run.promise))
    await click(sparkle(element))
    delivered(await dispatch(fake, control(sparkleAddress(fake), 'stop')), true)
    expect(fake.called('quirky.git/cancelGenerate').map(({ params }) => params)).toEqual([{ worktree: 'feat' }])
    run.reject(failure('Generation was stopped.', { reason: 'cancelled' }))
    await settle()
    expect(message(element).value).toBe('')
    expect(fake.toasts).toEqual([])
    expect(q(element, '.ui-inline-error')).toBeNull()
    expect(stop(element)).toBeNull()
    unmount()

    const secondRun = deferred()
    const second = await open((f) => f.on('quirky.git/generateCommitMessage', () => secondRun.promise))
    await click(sparkle(second.element))
    await click(stop(second.element))
    expect(second.fake.called('quirky.git/cancelGenerate').map(({ params }) => params)).toEqual([{ worktree: 'feat' }])
    secondRun.reject(failure('Generation was stopped.', { reason: 'cancelled' }))
    await settle()
    expect(second.fake.toasts).toEqual([])
    second.unmount()
  })

  test('menu-open without data uses its own trigger, coordinates are validated, and close accepts empty data', async () => {
    const { fake, element, unmount } = await open()
    const trigger = byLabel(element, 'Commit message options')!
    trigger.getBoundingClientRect = () => ({ right: 45, bottom: 65 } as DOMRect)
    await click(trigger)
    expect(q(document.body, '.qt-menu-anchor')?.style.left).toBe('45px')
    expect(q(document.body, '.qt-menu-anchor')?.style.top).toBe('65px')
    expect(lastRoutedControl(fake)).toMatchObject({ action: 'menu-open', target: 'ai-sparkle:feat' })

    delivered(await dispatch(fake, control(sparkleAddress(fake), 'menu-open', { x: 10, y: 20 })), true)
    expect(q(document.body, '.qt-menu-anchor')?.style.left).toBe('10px')
    expect(q(document.body, '.qt-menu-anchor')?.style.top).toBe('20px')
    const menu = menuAddress(fake)
    expect(menu.actions).toEqual(['close', 'choose-agent'])
    delivered(await dispatch(fake, control(menu, 'close', {})), true)
    expect(q(document.body, '.qt-menu')).toBeNull()
    unmount()
  })

  test('right-click passes its screen coordinates through the sparkle control', async () => {
    const { fake, element, unmount } = await open()
    await act(async () => {
      sparkle(element)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 20 }))
    })
    await settle()
    expect(lastRoutedControl(fake)).toMatchObject({
      target: 'ai-sparkle:feat',
      action: 'menu-open',
      data: { x: 10, y: 20 }
    })
    expect(q(document.body, '.qt-menu-anchor')?.style.left).toBe('10px')
    expect(q(document.body, '.qt-menu-anchor')?.style.top).toBe('20px')
    unmount()
  })

  test('menu choice is one request, with no selection-driven close request or failure toast', async () => {
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'Commit message options'))
    const beforeCommands = commandCalls(fake).length
    const beforeSelf = fake.called('ui.window.self').length
    await click(menuEntry('Choose agent…'))
    const controls = commandCalls(fake).slice(beforeCommands).map(controlArgs)
    expect(controls).toHaveLength(1)
    expect(controls[0]).toMatchObject({ target: 'ai-sparkle-menu:feat', action: 'choose-agent' })
    expect(fake.called('ui.window.self')).toHaveLength(beforeSelf + 1)
    expect(fake.toasts).toEqual([])
    expect(dialogTitle()).toBe('Generate Commit Message')
    expect(generateDialogAddress(fake).actions).toEqual(['close', 'generate'])
    unmount()
  })

  test('menu and dialog Escape paths send their close controls', async () => {
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'Commit message options'))
    let before = commandCalls(fake).length
    await press(q(document.body, '.qt-menu')!, 'Escape')
    let controls = commandCalls(fake).slice(before).map(controlArgs)
    expect(controls).toHaveLength(1)
    expect(controls[0]).toMatchObject({ target: 'ai-sparkle-menu:feat', action: 'close' })
    expect(q(document.body, '.qt-menu')).toBeNull()

    await click(byLabel(element, 'Commit message options'))
    await click(menuEntry('Choose agent…'))
    before = commandCalls(fake).length
    await press(dialog()!, 'Escape')
    controls = commandCalls(fake).slice(before).map(controlArgs)
    expect(controls).toHaveLength(1)
    expect(controls[0]).toMatchObject({ target: 'ai-generate-dialog:feat', action: 'close' })
    expect(dialog()).toBeNull()
    expect(fake.toasts).toEqual([])
    unmount()
  })

  test('dialog generate command validates its exact data and uses the offered choice', async () => {
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'Commit message options'))
    delivered(await dispatch(fake, control(menuAddress(fake), 'choose-agent')), true)
    const generation = generateDialogAddress(fake)
    expect(generation.actions).toEqual(['close', 'generate'])
    const choice = { agent: 'codex', template: '{basePrompt}\nShort.' }
    delivered(await dispatch(fake, control(generation, 'generate', choice)), true)
    expect(fake.called('quirky.git/generateCommitMessage').map(({ params }) => params)).toEqual([
      { worktree: 'feat', scope: 'staged', agent: 'codex', template: '{basePrompt}\nShort.' }
    ])
    expect(dialog()).toBeNull()
    expect(message(element).value).toBe('Rename x to count\n\nClearer name.')
    unmount()
  })

  test('dialog Generate click carries the same draft and closes the dialog', async () => {
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'Commit message options'))
    await click(menuEntry('Choose agent…'))
    await choose(launchField('Agent'), 'codex')
    await type(launchField('Command template') as HTMLTextAreaElement, '{basePrompt}\nShort.')
    const before = commandCalls(fake).length
    await click(buttonText(dialog()!, 'Generate'))
    const controlCall = commandCalls(fake).slice(before).map((params) => params.args)
    expect(controlCall).toHaveLength(1)
    expect(controlCall[0]).toMatchObject({ target: 'ai-generate-dialog:feat', action: 'generate', data: { agent: 'codex', template: '{basePrompt}\nShort.' } })
    expect(fake.called('quirky.git/generateCommitMessage').map(({ params }) => params)).toEqual([
      { worktree: 'feat', scope: 'staged', agent: 'codex', template: '{basePrompt}\nShort.' }
    ])
    expect(dialog()).toBeNull()
    unmount()
  })

  test('launch start sends only its action and builds LaunchParams from the live draft', async () => {
    const { fake, unmount } = await openLaunch()
    await choose(launchField('Agent'), 'codex')
    await type(launchField('CLI arguments') as HTMLInputElement, '--model gpt-5.4')
    await type(launchField('Prompt template') as HTMLTextAreaElement, 'Fix prompt for fixCommitFailure\nKeep the change small.')
    await choose(launchField('Save for') as HTMLSelectElement, 'repo')
    const launch = launchAddress(fake)
    expect(launch.actions).toContain('start')
    expect(launch.actions).toContain('reset-template')
    await refusedWithoutChange(fake, control(launch, 'start', { launchOptions: {} }))
    const beforeStart = commandCalls(fake).length
    delivered(await dispatch(fake, control(launch, 'start')), true)
    expect(fake.called('quirky.git/aiFix').map(({ params }) => params)).toEqual([{
      worktree: 'feat',
      action: 'fixCommitFailure',
      agent: 'codex',
      args: '--model gpt-5.4',
      template: '{basePrompt}\nKeep the change small.',
      launchOptions: null,
      save: 'repo'
    }])
    const startCommands = commandCalls(fake).slice(beforeStart).filter(({ args }) => typeof args === 'object' && args !== null && 'target' in args && args.target === launch.target)
    expect(startCommands).toHaveLength(1)
    const startCommand = startCommands[0]?.args
    expect(startCommand).toEqual({
      surface: AI_SURFACE,
      target: 'ai-launch:feat:fixCommitFailure',
      generation: launch.generation,
      action: 'start'
    })
    expect(dialog()).toBeNull()
    unmount()
  })

  test('Reset click routes locally, then a reset at the default template is refused', async () => {
    const { fake, unmount } = await openLaunch()
    const prompt = launchField('Prompt template') as HTMLTextAreaElement
    await type(prompt, 'Fix prompt for fixCommitFailure\nUse a safer approach.')
    const launch = launchAddress(fake)
    expect(launch.actions).toContain('reset-template')
    await refusedWithoutChange(fake, control(launch, 'reset-template', { unexpected: true }))
    const before = commandCalls(fake).length
    await click(buttonText(dialog()!, 'Reset'))
    expect(prompt.value).toBe('{basePrompt}')
    const controls = commandCalls(fake).slice(before).map((params) => params.args)
    expect(controls).toHaveLength(1)
    expect(controls[0]).toMatchObject({ target: launch.target, generation: launch.generation, action: 'reset-template' })
    expect(fake.called('quirky.git/aiFix')).toEqual([])
    delivered(await dispatch(fake, control(launchAddress(fake), 'reset-template')), false)
    unmount()
  })

  test('exact-window delivery changes only the auxiliary context 22, not owner 11', async () => {
    const owner = await open(undefined, 11)
    const auxiliary = await open(undefined, 22)
    await click(sparkle(auxiliary.element))
    expect(owner.fake.called('quirky.git/generateCommitMessage')).toEqual([])
    expect(message(owner.element).value).toBe('')
    expect(auxiliary.fake.called('quirky.git/generateCommitMessage').map(({ params }) => params)).toEqual([
      { worktree: 'feat', scope: 'staged' }
    ])
    expect(message(auxiliary.element).value).toBe('Rename x to count\n\nClearer name.')
    expect(commandCalls(auxiliary.fake).at(-1)).toMatchObject({ connId: 22, id: UI_CONTROL_COMMAND })
    expect(commandCalls(owner.fake)).toEqual([])
    owner.unmount()
    auxiliary.unmount()
  })

  test('delivery acknowledges an unresolved generation after 30,001 ms, not its completion', async () => {
    const run = deferred()
    const { fake, unmount } = await open((f) => f.on('quirky.git/generateCommitMessage', () => run.promise))
    jest.useFakeTimers()
    const target = control(sparkleAddress(fake), 'generate')
    delivered(await dispatch(fake, target), true)
    expect(fake.called('quirky.git/generateCommitMessage')).toHaveLength(1)
    await act(async () => advance(30_001))
    expect(fake.called('quirky.git/generateCommitMessage')).toHaveLength(1)
    run.resolve({ message: 'Finished later', agent: 'claude' })
    await settle()
    unmount()
  })

  test('launch delivery acknowledges an unresolved start after 30,001 ms and keeps its draft locked', async () => {
    const run = deferred()
    const { fake, unmount } = await openLaunch((f) => f.on('quirky.git/aiFix', () => run.promise))
    await type(launchField('CLI arguments') as HTMLInputElement, '--fast')
    const launch = launchAddress(fake)
    jest.useFakeTimers()
    delivered(await dispatch(fake, control(launch, 'start')), true)
    expect(fake.called('quirky.git/aiFix')).toHaveLength(1)
    expect((buttonText(dialog()!, 'Save & start agent') as HTMLButtonElement).disabled).toBe(true)
    expect(buttonText(dialog()!, 'Save & start agent')).toBeDefined()
    await act(async () => advance(30_001))
    expect(fake.called('quirky.git/aiFix')).toHaveLength(1)
    expect(dialog()).not.toBeNull()
    run.resolve({ session: 's2', agent: 'claude', prompt: 'p', saved: true })
    await settle()
    expect(dialog()).toBeNull()
    unmount()
  })

  test('launch refusal from a command stays in the same dialog as an alert', async () => {
    const { fake, unmount } = await openLaunch((f) => f.on('quirky.git/aiFix', () => {
      throw failure('fixture launch refused', { reason: 'failed' })
    }))
    delivered(await dispatch(fake, control(launchAddress(fake), 'start')), true)
    expect(dialog()).not.toBeNull()
    expect(dialog()!.querySelector('[role="alert"]')?.textContent).toBe('fixture launch refused')
    expect((buttonText(dialog()!, 'Start agent') as HTMLButtonElement).disabled).toBe(false)
    unmount()
  })

  test('refuses unknown, stale, unadvertised and malformed sparkle controls without UI or daemon changes', async () => {
    const { fake, element, unmount } = await open()
    const spark = sparkleAddress(fake)
    const base = control(spark, 'generate')
    for (const candidate of [
      { ...base, target: 'ai-sparkle:missing' },
      { ...base, action: 'unknown' },
      { ...base, generation: 'ai-0' },
      { ...base, data: { agent: 'claude' } },
      control(spark, 'generate', { extra: true }),
      control(spark, 'stop'),
      control(spark, 'stop', { extra: true }),
      control(spark, 'menu-open', { x: 10 }),
      control(spark, 'menu-open', { x: Number.NaN, y: 20 }),
      control(spark, 'menu-open', { x: Number.POSITIVE_INFINITY, y: 20 }),
      control(spark, 'menu-open', { x: '10', y: 20 } as unknown as Record<string, unknown>),
      control(spark, 'menu-open', { x: 10, y: 20, extra: true })
    ]) {
      await refusedWithoutChange(fake, candidate)
    }

    await type(message(element), 'already written')
    await refusedWithoutChange(fake, base)
    expect(message(element).value).toBe('already written')
    unmount()
  })

  test('refuses malformed menu and dialog data, extra fields, and non-offered agents', async () => {
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'Commit message options'))
    const menu = menuAddress(fake)
    for (const candidate of [
      control(menu, 'close', { extra: true }),
      control(menu, 'choose-agent', { extra: true })
    ]) {
      await refusedWithoutChange(fake, candidate)
    }

    const before = commandCalls(fake).length
    const beforeSelf = fake.called('ui.window.self').length
    await click(menuEntry('Choose agent…'))
    const chooseCalls = commandCalls(fake).slice(before).map((params) => params.args)
    expect(chooseCalls).toHaveLength(1)
    expect(chooseCalls[0]).toMatchObject({ target: menu.target, action: 'choose-agent' })
    expect(fake.called('ui.window.self')).toHaveLength(beforeSelf + 1)
    expect(fake.toasts).toEqual([])

    const generate = control(generateDialogAddress(fake), 'generate')
    for (const candidate of [
      { ...generate, data: { agent: '  ', template: 'x' } },
      { ...generate, data: { agent: 'not-offered', template: 'x' } },
      { ...generate, data: { agent: 'codex', template: 5 } },
      { ...generate, data: { agent: 'codex' } },
      { ...generate, data: { agent: 'codex', template: 'x', extra: true } },
      control(generateDialogAddress(fake), 'close', { extra: true })
    ]) {
      await refusedWithoutChange(fake, candidate)
    }
    expect(dialog()).not.toBeNull()
    expect(fake.called('quirky.git/generateCommitMessage')).toEqual([])
    unmount()
  })

  test('choose-agent is refused while a commit is running', async () => {
    const commit = deferred()
    const { fake, element, unmount } = await open((f) => f.on('quirky.git/commit', () => commit.promise))
    await type(message(element), 'Rename x')
    await click(primary(element))
    await click(byLabel(element, 'Commit message options'))
    const menu = menuAddress(fake)
    expect(menu.actions).toEqual(['close'])
    await refusedWithoutChange(fake, control(menu, 'choose-agent'))
    expect(dialog()).toBeNull()
    expect(fake.called('quirky.git/generateCommitMessage')).toEqual([])
    unmount()
  })

  test('start is reserved synchronously for same-turn commands and rejected while already starting', async () => {
    const run = deferred()
    const { fake, unmount } = await openLaunch((f) => f.on('quirky.git/aiFix', () => run.promise))
    const start = control(launchAddress(fake), 'start')
    const replies = await dispatchSameTurn(fake, [start, start])
    expect(replies).toEqual([{ result: { delivered: true } }, { result: { delivered: false } }])
    expect(fake.called('quirky.git/aiFix')).toHaveLength(1)
    expect((buttonText(dialog()!, 'Start agent') as HTMLButtonElement).disabled).toBe(true)
    run.resolve({ session: 's1', agent: 'claude', prompt: 'p', saved: false })
    await settle()
    unmount()
  })

  test('same-turn Reset then Start consumes the reset template without saving the discarded draft', async () => {
    const { fake, unmount } = await openLaunch()
    await type(launchField('Prompt template') as HTMLTextAreaElement, '{basePrompt}\nDiscard this edit.')
    const launch = launchAddress(fake)
    const replies = await dispatchSameTurn(fake, [control(launch, 'reset-template'), control(launch, 'start')])
    expect(replies).toEqual([{ result: { delivered: true } }, { result: { delivered: true } }])
    expect(fake.called('quirky.git/aiFix').map(({ params }) => params)).toEqual([{
      worktree: 'feat', action: 'fixCommitFailure', agent: 'claude', args: '', template: '{basePrompt}'
    }])
    unmount()
  })

  test('generate is reserved synchronously for same-turn commands', async () => {
    const run = deferred()
    const { fake, unmount } = await open((f) => f.on('quirky.git/generateCommitMessage', () => run.promise))
    const generate = control(sparkleAddress(fake), 'generate')
    const replies = await dispatchSameTurn(fake, [generate, generate])
    expect(replies).toEqual([{ result: { delivered: true } }, { result: { delivered: false } }])
    expect(fake.called('quirky.git/generateCommitMessage')).toHaveLength(1)
    expect(stop(document.body.querySelector('[data-git-panel]') as HTMLElement)?.disabled).toBe(false)
    run.resolve({ message: 'Done', agent: 'claude' })
    await settle()
    unmount()
  })

  test('start without a usable agent and reset at the default template are refused', async () => {
    const noAgent = await openLaunch((f) => f.on('quirky.agents/list', () => ({ defaultAgent: 'auto', agents: [] })))
    expect((buttonText(dialog()!, 'Start agent') as HTMLButtonElement).disabled).toBe(true)
    await refusedWithoutChange(noAgent.fake, control(launchAddress(noAgent.fake), 'start'))
    expect(noAgent.fake.called('quirky.git/aiFix')).toEqual([])
    noAgent.unmount()

    const normal = await openLaunch()
    const original = launchAddress(normal.fake)
    delivered(await dispatch(normal.fake, control(original, 'reset-template')), true)
    expect((byLabel(dialog()!, 'Prompt template') as HTMLTextAreaElement).value).toBe('{basePrompt}')
    await refusedWithoutChange(normal.fake, control(launchAddress(normal.fake), 'reset-template'))
    normal.unmount()
  })

  test('menu and dialog sessions get fresh generations and stale A controls cannot touch B', async () => {
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'Commit message options'))
    const menuA = menuAddress(fake)
    await click(menuEntry('Choose agent…'))
    const dialogA = generateDialogAddress(fake)
    delivered(await dispatch(fake, control(dialogA, 'close')), true)
    delivered(await dispatch(fake, control(menuA, 'close')), false)

    await click(byLabel(element, 'Commit message options'))
    const menuB = menuAddress(fake)
    expect(menuB.generation).not.toBe(menuA.generation)
    delivered(await dispatch(fake, control(menuA, 'close')), false)
    expect(q(document.body, '.qt-menu')).not.toBeNull()

    await click(menuEntry('Choose agent…'))
    const dialogB = generateDialogAddress(fake)
    expect(dialogB.generation).not.toBe(dialogA.generation)
    delivered(await dispatch(fake, control(dialogA, 'close')), false)
    expect(dialog()).not.toBeNull()
    expect(dialogTitle()).toBe('Generate Commit Message')
    unmount()
  })

  test('a closed dialog and an unmounted panel refuse their old controls', async () => {
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'Commit message options'))
    delivered(await dispatch(fake, control(menuAddress(fake), 'choose-agent')), true)
    const oldDialog = generateDialogAddress(fake)
    const oldSparkle = sparkleAddress(fake)
    delivered(await dispatch(fake, control(oldDialog, 'close')), true)
    await refusedWithoutChange(fake, control(oldDialog, 'generate', { agent: 'claude', template: 'x' }))
    unmount()
    delivered(await dispatch(fake, control(oldSparkle, 'generate')), false)
  })

  test('an unresolved click sends only one request while its exact-window identity is pending', async () => {
    const identity = deferred<{ connId: number }>()
    const { fake, element, unmount } = await open((f) => f.on('ui.window.self', () => identity.promise))
    const beforeSelf = fake.called('ui.window.self').length
    const beforeCommands = commandCalls(fake).length
    const trigger = byLabel(element, 'Commit message options')
    await click(trigger)
    await click(trigger)
    expect(fake.called('ui.window.self')).toHaveLength(beforeSelf + 1)
    expect(commandCalls(fake)).toHaveLength(beforeCommands)
    expect(fake.toasts).toEqual([])

    identity.resolve({ connId: 22 })
    await settle()
    expect(commandCalls(fake)).toHaveLength(beforeCommands + 1)
    expect(lastRoutedControl(fake)).toMatchObject({ target: 'ai-sparkle:feat', action: 'menu-open' })
    expect(menuEntry('Choose agent…')).toBeDefined()
    unmount()
  })

  test('Escape closes the menu while a Choose agent delivery is pending', async () => {
    const identity = deferred<{ connId: number }>()
    const { fake, element, unmount } = await open()
    await click(byLabel(element, 'Commit message options'))
    const menu = menuAddress(fake)
    let selfCalls = 0
    fake.on('ui.window.self', () => ++selfCalls === 1 ? identity.promise : { connId: fake.connId })
    await click(menuEntry('Choose agent…'))
    expect(q(document.body, '.qt-menu')).not.toBeNull()
    expect(dialog()).toBeNull()
    const beforeClose = commandCalls(fake).length
    await press(q(document.body, '.qt-menu')!, 'Escape')
    expect(commandCalls(fake)).toHaveLength(beforeClose + 1)
    expect(lastRoutedControl(fake)).toMatchObject({ target: menu.target, generation: menu.generation, action: 'close' })
    expect(q(document.body, '.qt-menu')).toBeNull()
    await act(async () => identity.resolve({ connId: fake.connId }))
    await settle()
    expect(dialog()).toBeNull()
    expect(fake.called('quirky.git/generateCommitMessage')).toEqual([])
    unmount()
  })

  const failures: Array<[string, (fake: Fake) => void, number]> = [
    ['invalid window identity', (fake) => fake.on('ui.window.self', () => null), 0],
    ['rejected bridge request', (fake) => fake.on('ui.window.command.run', () => { throw new Error('bridge unavailable') }), 1],
    ['refused bridge reply', (fake) => fake.on('ui.window.command.run', () => ({ result: { result: { delivered: false } } })), 1]
  ]

  for (const [name, fail, commandCallsPerRequest] of failures) {
    test(`AI failed delivery matches the parent refresh toast for ${name}`, async () => {
      const { fake, element, unmount } = await open()
      await click(byLabel(element, 'More source control actions'))
      expect(menuEntry('Refresh')).toBeDefined()
      fail(fake)

      const beforeSelf = fake.called('ui.window.self').length
      const beforeCommand = commandCalls(fake).length
      await click(menuEntry('Refresh'))
      expect(fake.called('ui.window.self')).toHaveLength(beforeSelf + 1)
      expect(commandCalls(fake)).toHaveLength(beforeCommand + commandCallsPerRequest)
      const parentToast = fake.toasts.at(-1)
      const parentOptions = fake.toastOptions.at(-1)
      expect(parentToast?.[0]).toBe('Could not run Source Control action')
      expect(parentOptions).toEqual({ kind: 'error' })

      const beforeAi = document.body.innerHTML
      const beforeAiSelf = fake.called('ui.window.self').length
      const beforeAiCommand = commandCalls(fake).length
      await click(sparkle(element))
      expect(fake.called('ui.window.self')).toHaveLength(beforeAiSelf + 1)
      expect(commandCalls(fake)).toHaveLength(beforeAiCommand + commandCallsPerRequest)
      expect(fake.toasts.at(-1)).toEqual(parentToast)
      expect(fake.toastOptions.at(-1)).toEqual(parentOptions)
      expect(document.body.innerHTML).toBe(beforeAi)
      expect(fake.called('quirky.git/generateCommitMessage')).toEqual([])
      unmount()
    })
  }

  test('failed delivery keeps the menu, Generate draft, and launch draft unchanged', async () => {
    const menuPanel = await open()
    await click(byLabel(menuPanel.element, 'Commit message options'))
    const beforeMenuSelf = menuPanel.fake.called('ui.window.self').length
    const beforeMenuCommands = commandCalls(menuPanel.fake).length
    menuPanel.fake.on('ui.window.self', () => null)
    await press(q(document.body, '.qt-menu')!, 'Escape')
    expect(q(document.body, '.qt-menu')).not.toBeNull()
    expect(menuPanel.fake.called('ui.window.self')).toHaveLength(beforeMenuSelf + 1)
    expect(commandCalls(menuPanel.fake)).toHaveLength(beforeMenuCommands)
    expect(menuPanel.fake.called('quirky.git/generateCommitMessage')).toEqual([])
    expect(menuPanel.fake.toastOptions.at(-1)).toEqual({ kind: 'error' })
    menuPanel.unmount()

    const dialogPanel = await open()
    await click(byLabel(dialogPanel.element, 'Commit message options'))
    await click(menuEntry('Choose agent…'))
    const template = launchField('Command template') as HTMLTextAreaElement
    const templateBefore = template.value
    const beforeDialogSelf = dialogPanel.fake.called('ui.window.self').length
    const beforeDialogCommands = commandCalls(dialogPanel.fake).length
    dialogPanel.fake.on('ui.window.command.run', () => ({ result: { result: { delivered: false } } }))
    await click(buttonText(dialog()!, 'Generate'))
    expect(dialog()).not.toBeNull()
    expect((launchField('Command template') as HTMLTextAreaElement).value).toBe(templateBefore)
    expect(dialogPanel.fake.called('ui.window.self')).toHaveLength(beforeDialogSelf + 1)
    expect(commandCalls(dialogPanel.fake)).toHaveLength(beforeDialogCommands + 1)
    expect(dialogPanel.fake.called('quirky.git/generateCommitMessage')).toEqual([])
    expect(dialogPanel.fake.toastOptions.at(-1)).toEqual({ kind: 'error' })
    dialogPanel.unmount()

    const launchPanel = await openLaunch()
    const args = launchField('CLI arguments') as HTMLInputElement
    await type(args, '--fast')
    const argsBefore = args.value
    const promptBefore = (launchField('Prompt template') as HTMLTextAreaElement).value
    const beforeLaunchSelf = launchPanel.fake.called('ui.window.self').length
    const beforeLaunchCommands = commandCalls(launchPanel.fake).length
    launchPanel.fake.on('ui.window.self', () => null)
    await click(buttonText(dialog()!, 'Save & start agent'))
    expect(dialog()).not.toBeNull()
    expect((launchField('CLI arguments') as HTMLInputElement).value).toBe(argsBefore)
    expect((launchField('Prompt template') as HTMLTextAreaElement).value).toBe(promptBefore)
    expect(launchPanel.fake.called('ui.window.self')).toHaveLength(beforeLaunchSelf + 1)
    expect(commandCalls(launchPanel.fake)).toHaveLength(beforeLaunchCommands)
    expect(launchPanel.fake.called('quirky.git/aiFix')).toEqual([])
    expect(launchPanel.fake.toastOptions.at(-1)).toEqual({ kind: 'error' })
    launchPanel.unmount()
  })

  test('clicks complete each local control within the existing click helper', async () => {
    const run = deferred()
    const sparklePanel = await open((f) => f.on('quirky.git/generateCommitMessage', () => run.promise))
    await click(sparkle(sparklePanel.element))
    expect(sparklePanel.fake.called('quirky.git/generateCommitMessage')).toHaveLength(1)
    expect(stop(sparklePanel.element)).not.toBeNull()
    expect(commandCalls(sparklePanel.fake)).toHaveLength(1)
    run.resolve({ message: 'Done', agent: 'claude' })
    await settle()
    sparklePanel.unmount()

    const menuPanel = await open()
    await click(byLabel(menuPanel.element, 'Commit message options'))
    expect(menuEntry('Choose agent…')).toBeDefined()
    expect(lastRoutedControl(menuPanel.fake)?.action).toBe('menu-open')
    menuPanel.unmount()

    const dialogRun = deferred()
    const dialogPanel = await open((f) => f.on('quirky.git/generateCommitMessage', () => dialogRun.promise))
    await click(byLabel(dialogPanel.element, 'Commit message options'))
    await click(menuEntry('Choose agent…'))
    await click(buttonText(dialog()!, 'Generate'))
    expect(dialogPanel.fake.called('quirky.git/generateCommitMessage')).toHaveLength(1)
    expect(dialog()).toBeNull()
    expect(stop(dialogPanel.element)).not.toBeNull()
    dialogRun.resolve({ message: 'Done', agent: 'claude' })
    await settle()
    dialogPanel.unmount()

    const launchRun = deferred()
    const launchPanel = await openLaunch((f) => f.on('quirky.git/aiFix', () => launchRun.promise))
    await type(launchField('CLI arguments') as HTMLInputElement, '--fast')
    const start = buttonText(dialog()!, 'Save & start agent') as HTMLButtonElement
    await click(start)
    expect(launchPanel.fake.called('quirky.git/aiFix')).toHaveLength(1)
    expect(buttonText(dialog()!, 'Save & start agent')?.disabled).toBe(true)
    expect(commandCalls(launchPanel.fake).at(-1)).toMatchObject({
      id: UI_CONTROL_COMMAND,
      args: { target: 'ai-launch:feat:fixCommitFailure', action: 'start' }
    })
    launchRun.resolve({ session: 's3', agent: 'claude', prompt: 'p', saved: true })
    await settle()
    launchPanel.unmount()
  })
})
