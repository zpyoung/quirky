import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Ask, QuirkyClient, Repo, Session, UiSlotState, UiState, Worktree } from '@quirky/protocol'
import { createFakeGit, useTestGit } from '@quirky/git/testing'
import { runCli, spawnCli } from '../../cli/test/fixtures/fake-daemon'
import { builtinsDir, makeTempHome, startHarness, type Harness } from '../../daemon/test/helpers'
import { startHeadlessWindow, type HeadlessWindow } from './fixtures/headless-window'

const SAMPLE_DISTRO = resolve(import.meta.dir, '../../../distros/sample')
const SIDEBAR = 'sidebar-section:quirky.worktree/worktrees'
const SOURCE_CONTROL = 'panel:quirky.git/source-control'
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
const asking: ReturnType<typeof spawnCli>[] = []

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
  for (const proc of asking.splice(0)) {
    proc.kill()
    await proc.exited
  }
  await win.stop()
  await harness.cleanup()
  useTestGit(null)
  rmSync(scratch, { recursive: true, force: true })
})

const quirky = (args: string[]) => runCli(args, { home: harness.home, cwd: apiDir })

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
  expect(slotOf(stock, SIDEBAR)?.plugin).toBe('quirky.worktree')
  expect(slotOf(stock, SOURCE_CONTROL)).toBeDefined()
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
  expect((await quirky(['git', 'status'])).code).toBe(0)

  const sessions = (await agent.callAny('quirky.session/list', {})) as Session[]
  expect(sessions.find((session) => session.id === shell.id)?.status).toBe('running')
})

test('SC-35: ui state shows the layout and what the sidebar and the session view report', async () => {
  const state = await stateWhere(
    (next) => slotOf(next, SIDEBAR)?.report !== undefined && slotOf(next, SESSION_VIEW)?.report !== undefined
  )
  expect(state.windows).toHaveLength(1)
  expect(state.layout).toEqual({
    view: { id: SESSION_VIEW, input: { worktree: main.id, session: shell.id } },
    panel: null,
    sidebar: true,
    focus: 'view'
  })
  expect(slotOf(state, SIDEBAR)?.report).toMatchObject({
    projects: [{ id: repo.id, name: 'api', worktrees: [{ id: main.id, name: main.name, selected: true }] }]
  })
  const report = slotOf(state, SESSION_VIEW)?.report as { worktree?: string; tabs?: unknown[]; active?: string }
  expect(report.worktree).toBe(main.id)
  expect(report.active).toBe(shell.id)
  expect(report.tabs).toHaveLength(1)
})

/** Starts `quirky ask` with one confirm question and returns its process and the lines it has printed so far. */
function startAsk(question: string): { proc: ReturnType<typeof spawnCli>; lines: string[] } {
  const spec = JSON.stringify({ questions: [{ id: 'go', type: 'confirm', question }] })
  const proc = spawnCli(['ask', '--spec', spec], { home: harness.home, cwd: apiDir })
  asking.push(proc)
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

test('SC-31: an ask opens the Questions panel, badges its toggle and announces itself', async () => {
  expect((await uiState()).layout.panel).toBeNull()
  startAsk('First?')

  const open = await stateWhere((state) => state.layout.panel === QUESTIONS && questionsReport(state)?.pending.length === 1)
  expect(open.layout.panel).toBe(QUESTIONS)
  await win.waitFor(() => win.host.getState().badges[QUESTIONS] === 1)
  expect(harness.notifications).toEqual([{ title: 'Question', body: 'First?' }])
})

test('SC-29: a second pending ask stays listed after the first is answered, and answering it resolves its waiter', async () => {
  const first = startAsk('First?')
  await win.waitFor(() => first.lines.length >= 1)
  const second = startAsk('Second?')
  await stateWhere((state) => questionsReport(state)?.pending.length === 2)
  const [one, two] = await pendingAsks()

  await agent.callAny('quirky.ask/answer', { askId: one!.id, answers: { go: { value: 'yes', source: 'input' } } })
  const remaining = await stateWhere((state) => questionsReport(state)?.pending.length === 1)
  expect(questionsReport(remaining)?.pending[0]?.askId).toBe(two!.id)
  expect((await pendingAsks()).map((ask) => ask.id)).toEqual([two!.id])
  await win.waitFor(() => win.host.getState().badges[QUESTIONS] === 1)

  await agent.callAny('quirky.ask/answer', { askId: two!.id, answers: { go: { value: 'yes', source: 'input' } } })
  await win.waitFor(() => second.lines.length === 2)
  expect(JSON.parse(second.lines[0]!)).toEqual({ status: 'registered', askId: two!.id })
  expect(JSON.parse(second.lines[1]!)).toMatchObject({ status: 'answered', askId: two!.id })
  expect(await second.proc.exited).toBe(0)
})
