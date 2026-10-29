import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PLUGIN_API_VERSION, type Ask, type ApiCatalog, type DistroInspection, type QuirkyClient, type Repo, type Session, type UiSlotState, type UiState, type Worktree } from '@quirky/protocol'
import { createFakeGit, useTestGit } from '@quirky/git/testing'
import { spawnCli } from '../../cli/test/fixtures/fake-daemon'
import { builtinsDir, makeTempHome, startHarness, type Harness } from '../../daemon/test/helpers'
import { startHeadlessWindow, type HeadlessWindow } from './fixtures/headless-window'

const SAMPLE_DISTRO = resolve(import.meta.dir, '../../../distros/sample')
const SIDEBAR = 'sidebar-section:quirky.worktree/worktrees'
const SOURCE_CONTROL = 'panel:quirky.git/source-control'
const SOURCE_CONTROL_ACTIVITY = 'activity-item:quirky.sidebar-extras/source-control'
const QUESTIONS = 'panel:quirky.ask/questions'
const SESSION_VIEW = 'view:quirky.session/worktree'

let scratch: string
let apiDir: string
let harness: Harness
let win: HeadlessWindow
let agent: QuirkyClient
let repo: Repo
let main: Worktree
let shell: Session
const cliProcesses = new Set<Bun.Subprocess>()

function ownCli(args: string[], options: Parameters<typeof spawnCli>[1]) {
  const proc = spawnCli(args, options)
  cliProcesses.add(proc)
  void proc.exited.then(() => cliProcesses.delete(proc))
  return proc
}

async function runCliOwned(
  args: string[],
  options: Parameters<typeof spawnCli>[1]
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = ownCli(args, options)
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { code, stdout, stderr }
}

// happy-dom swaps these globals for its own, and the in-process daemon answers the CLI's
// HTTP requests with whichever `Response` is global when it builds the reply
const HTTP_GLOBALS = ['Response', 'Request', 'Headers'] as const

beforeEach(async () => {
  scratch = realpathSync(mkdtempSync('/tmp/qx-'))
  apiDir = join(scratch, 'api')
  mkdirSync(apiDir)
  const git = createFakeGit()
  git.addRepo(apiDir)
  useTestGit(git)

  harness = await startHarness({ home: makeTempHome('qx-'), builtinPluginsDir: builtinsDir() })
  agent = await harness.connect('cli', 'setup')
  repo = (await agent.callAny('quirky.repo/add', { path: apiDir })) as Repo
  main = ((await agent.callAny('quirky.worktree/list', {})) as Worktree[]).find((worktree) => worktree.isMain)!
  shell = (await agent.callAny('quirky.session/create', { worktree: main.id, agent: 'shell' })) as Session
  await agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree: main.id, session: shell.id } })
  await agent.callAny('ui.focus', { target: 'view' })
  const native = HTTP_GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
  win = await startHeadlessWindow({ home: harness.home, runtime: harness.runtime })
  for (const [name, value] of native) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
})

afterEach(async () => {
  const processes = [...cliProcesses]
  for (const proc of processes) proc.kill()
  await Promise.all(processes.map((proc) => proc.exited))
  await win.stop()
  await harness.cleanup()
  useTestGit(null)
  rmSync(scratch, { recursive: true, force: true })
})

const quirky = (args: string[]) => runCliOwned(args, { home: harness.home, cwd: apiDir })

async function ok(args: string[]): Promise<string> {
  const result = await quirky(args)
  if (result.code !== 0) throw new Error(`quirky ${args.join(' ')} exited ${result.code}: ${result.stderr}`)
  return result.stdout
}

const uiState = async () => JSON.parse(await ok(['ui', 'state', '--json'])) as UiState
const slotOf = (state: UiState, id: string): UiSlotState | undefined => state.slots.find((slot) => slot.id === id)

/** Polls `ui state --json` through the CLI until `check` holds, so a slot's first report has arrived. */
async function stateWhere(check: (state: UiState) => boolean): Promise<UiState> {
  return win.waitFor(async () => {
    const state = await uiState()
    return check(state) ? state : undefined
  })
}

test('SC-59: the M0 exit test, through the CLI only', async () => {
  const stock = await stateWhere((state) => slotOf(state, SIDEBAR)?.report !== undefined)
  const inspected = await quirky(['distro', 'inspect', SAMPLE_DISTRO, '--json'])
  expect(inspected.code).toBe(0)
  const inspection = JSON.parse(inspected.stdout) as DistroInspection
  expect(inspection.plugins.map(({ id }) => id)).toContain('sample.sidebar')
  const catalog = JSON.parse(await ok(['api', '--json'])) as ApiCatalog
  expect(catalog.pluginApiVersion).toBe(PLUGIN_API_VERSION)

  expect(slotOf(stock, SIDEBAR)?.plugin).toBe('quirky.worktree')
  expect(slotOf(stock, SOURCE_CONTROL)).toBeDefined()
  expect(slotOf(stock, SOURCE_CONTROL_ACTIVITY)).toBeDefined()
  expect((await quirky(['git', 'status'])).code).toBe(0)

  const installed = await quirky(['distro', 'install', SAMPLE_DISTRO, '--yes'])
  expect(installed.code).toBe(0)

  const flat = await stateWhere((state) => {
    const slot = slotOf(state, SIDEBAR)
    return slot?.plugin === 'sample.sidebar' && (slot.report as { flat?: boolean } | undefined)?.flat === true
  })
  expect(slotOf(flat, SIDEBAR)).toMatchObject({
    title: 'Worktrees (flat)',
    plugin: 'sample.sidebar',
    report: { flat: true, worktrees: [{ id: main.id, name: main.name }] }
  })
  expect(flat.slots.filter((slot) => slot.kind === 'panel').map((slot) => slot.id)).not.toContain(SOURCE_CONTROL)
  expect(slotOf(flat, SOURCE_CONTROL_ACTIVITY)).toBeUndefined()
  const unknown = await quirky(['git', 'status'])
  expect(unknown.code).not.toBe(0)
  expect(unknown.stderr).toContain('unknown command')

  const removed = await quirky(['distro', 'remove', 'sample', '--yes'])
  expect(removed.code).toBe(0)

  const restored = await stateWhere((state) => {
    const slot = slotOf(state, SIDEBAR)
    return slot?.plugin === 'quirky.worktree' && slot.report !== undefined
  })
  expect(slotOf(restored, SIDEBAR)).toMatchObject({ title: 'Worktrees', plugin: 'quirky.worktree' })
  expect(slotOf(restored, SOURCE_CONTROL)).toBeDefined()
  expect(slotOf(restored, SOURCE_CONTROL_ACTIVITY)).toBeDefined()
  expect((await quirky(['git', 'status'])).code).toBe(0)

  const sessions = (await agent.callAny('quirky.session/list', {})) as Session[]
  expect(sessions.find((session) => session.id === shell.id)?.status).toBe('running')
})

test('SC-35: ui state includes the sidebar and session view reports', async () => {
  const state = await stateWhere(
    (next) => slotOf(next, SIDEBAR)?.report !== undefined && slotOf(next, SESSION_VIEW)?.report !== undefined
  )
  expect(slotOf(state, SIDEBAR)?.report).toMatchObject({
    projects: [{ id: repo.id, name: 'api', worktrees: [{ id: main.id, name: main.name, selected: true }] }]
  })
  const report = slotOf(state, SESSION_VIEW)?.report as { worktree?: string; tabs?: unknown[]; active?: string }
  expect(report.worktree).toBe(main.id)
  expect(report.active).toBe(shell.id)
  expect(report.tabs).toHaveLength(1)
})

/** Starts `quirky ask` with one confirm question and returns its process and the lines it has printed so far. */
function startAsk(question: string) {
  const spec = JSON.stringify({ questions: [{ id: 'go', type: 'confirm', question }] })
  const proc = ownCli(['ask', '--spec', spec], { home: harness.home, cwd: apiDir })
  const lines: string[] = []
  void (async () => {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffered += decoder.decode(value, { stream: true })
      const parts = buffered.split('\n')
      buffered = parts.pop()!
      lines.push(...parts)
    }
  })()
  return { proc, lines }
}

const pendingAsks = async () => (await agent.callAny('quirky.ask/list', { pendingOnly: true })) as Ask[]
const questionsReport = (state: UiState) => slotOf(state, QUESTIONS)?.report as { pending: { askId: string }[] } | undefined

test('SC-31: a sessionless CLI ask badges Questions without changing the selected view, and appears when opened', async () => {
  const before = await uiState()
  expect(before.layout).toMatchObject({
    view: { id: SESSION_VIEW, input: { worktree: main.id, session: shell.id } },
    focus: 'view'
  })
  const ask = startAsk('First?')
  await win.waitFor(() => ask.lines.length >= 1)
  const registered = JSON.parse(ask.lines[0]!) as { status: string; askId: string }
  expect(registered.status).toBe('registered')

  const pending = await win.waitFor(async () => {
    const [current] = await pendingAsks()
    return current?.id === registered.askId ? current : undefined
  })
  expect(pending.sessionId).toBeNull()
  await win.waitFor(() => win.host.getState().badges[QUESTIONS] === 1)
  expect(harness.notifications).toEqual([])

  const unchanged = await uiState()
  expect(unchanged.layout).toEqual(before.layout)
  expect(unchanged.windows.map((window) => window.focused)).toEqual(before.windows.map((window) => window.focused))

  await agent.callAny('ui.panel.open', { id: QUESTIONS })
  const open = await stateWhere(
    (state) =>
      state.layout.panel === QUESTIONS &&
      questionsReport(state)?.pending.some((item) => item.askId === registered.askId) === true
  )
  expect(questionsReport(open)?.pending.map((item) => item.askId)).toEqual([registered.askId])
})

test('SC-29: a second pending ask stays listed after the first is answered, and answering it resolves its waiter', async () => {
  const first = startAsk('First?')
  await win.waitFor(() => first.lines.length >= 1)
  const firstRegistered = JSON.parse(first.lines[0]!) as { status: string; askId: string }
  expect(firstRegistered.status).toBe('registered')

  const second = startAsk('Second?')
  await win.waitFor(() => second.lines.length >= 1)
  const secondRegistered = JSON.parse(second.lines[0]!) as { status: string; askId: string }
  expect(secondRegistered.status).toBe('registered')

  await agent.callAny('ui.panel.open', { id: QUESTIONS })
  const both = await stateWhere((state) => questionsReport(state)?.pending.length === 2)
  expect(questionsReport(both)?.pending.map((ask) => ask.askId)).toEqual([
    firstRegistered.askId,
    secondRegistered.askId
  ])
  expect((await pendingAsks()).map((ask) => ask.id)).toEqual([firstRegistered.askId, secondRegistered.askId])

  await agent.callAny('quirky.ask/answer', {
    askId: firstRegistered.askId,
    answers: { go: { value: true, source: 'input' } }
  })
  const remaining = await stateWhere(
    (state) =>
      questionsReport(state)?.pending.length === 1 &&
      questionsReport(state)?.pending[0]?.askId === secondRegistered.askId
  )
  expect(questionsReport(remaining)?.pending[0]?.askId).toBe(secondRegistered.askId)
  expect((await pendingAsks()).map((ask) => ask.id)).toEqual([secondRegistered.askId])
  await win.waitFor(() => win.host.getState().badges[QUESTIONS] === 1)

  await win.waitFor(() => first.lines.length === 2)
  expect(JSON.parse(first.lines[1]!)).toMatchObject({ status: 'answered', askId: firstRegistered.askId })
  expect(await first.proc.exited).toBe(0)

  await agent.callAny('quirky.ask/answer', {
    askId: secondRegistered.askId,
    answers: { go: { value: true, source: 'input' } }
  })
  await win.waitFor(() => second.lines.length === 2)
  expect(JSON.parse(second.lines[1]!)).toMatchObject({ status: 'answered', askId: secondRegistered.askId })
  expect(await second.proc.exited).toBe(0)
})
