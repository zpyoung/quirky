import { afterEach, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { QuickCommand } from '../../src/layout/types'
import { startAgentsE2E, type E2E } from '../../../quirky.agents/test/support/e2e'
import {
  RpcErrorCode,
  SCENARIO_MS,
  addRepo,
  cleanupAll,
  groupOf,
  groupsOf,
  layoutOf,
  leavesOf,
  openTab,
  rejection,
  splitPane,
  startE2e,
  tabsOf,
  waitFor,
  type E2eHarness
} from './support'

let agents: E2E | undefined
afterEach(async () => {
  await agents?.cleanup()
  agents = undefined
  await cleanupAll()
})

type Commands = { commands: QuickCommand[] }

const add = (h: E2eHarness, fields: Record<string, unknown>) => h.call<Commands>('quirky.terminal/addQuickCommand', { scope: 'global', ...fields })

test(
  'SC-50: limits and normalization',
  async () => {
    const h = await startE2e()
    await add(h, { label: 'Hello', command: 'echo hello' })
    for (let n = 2; n <= 40; n += 1) await add(h, { label: `Command ${n}`, command: `echo ${n}` })
    expect((await h.json<Commands>(['terminal', 'quick-command', 'list', '--all'])).commands).toHaveLength(40)
    expect((await h.json<Commands>(['terminal', 'quick-command', 'list', '--all'])).commands[0]!.id).toBe('hello')

    const full = await h.cli(['terminal', 'quick-command', 'add', '--label', 'One more', '--command', 'true'])
    expect(full).toMatchObject({ code: 1, stderr: 'quirky: at most 40 quick commands\n' })
    expect(await rejection(add(h, { label: 'Hello', command: 'echo again' }))).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'at most 40 quick commands' })

    await h.call('quirky.terminal/removeQuickCommand', { id: 'command-40', yes: true })
    const second = await add(h, { label: '  Hello  ', command: '  echo second  ' })
    expect(second.commands.at(-1)).toMatchObject({ id: 'hello-2', label: 'Hello', command: 'echo second', scope: 'global', kind: 'terminal', appendEnter: true })

    await h.call('quirky.terminal/removeQuickCommand', { id: 'command-39', yes: true })
    const half = await add(h, { label: 'Half typed', command: '   ' })
    const kept = half.commands.find((command) => command.id === 'half-typed')!
    expect(kept.command).toBe('')
    const tab = await openTab(h, [], { ready: false })
    const refused = await rejection(h.call('quirky.terminal/runQuickCommand', { id: 'half-typed', workspace: 'main' }))
    expect(refused).toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect(refused.message).toContain('no command to run')
    expect(tabsOf(await layoutOf(h)).map((candidate) => candidate.id)).toEqual([tab.tab.id])
    const missing = await h.cli(['terminal', 'quick-command', 'run', 'nope'])
    expect(missing).toMatchObject({ code: 1, stderr: 'quirky: no quick command nope\n' })
  },
  SCENARIO_MS
)

test(
  'SC-51: running from the tab strip opens a titled tab that runs the command once',
  async () => {
    const h = await startE2e()
    mkdirSync(join(h.repo, 'web'))
    const web = join(h.repo, 'web')
    const added = await h.json<Commands>(['terminal', 'quick-command', 'add', '--label', 'Hello', '--command', 'echo hello'])
    expect(added.commands).toMatchObject([{ id: 'hello', label: 'Hello', kind: 'terminal', appendEnter: true, scope: 'global' }])
    await h.json<Commands>(['terminal', 'quick-command', 'add', '--label', 'Two lines', '--command', 'cd web\npwd'])

    const ran = await h.json<{ session: string; workspace: { id: string } }>(['terminal', 'quick-command', 'run', 'hello'])
    const rows = await h.waitForLine(ran.session, 'hello')
    expect(rows.filter((line) => line === 'hello')).toHaveLength(1)
    expect(rows.filter((line) => /[%#] echo hello$/.test(line))).toHaveLength(1)
    const ws = await layoutOf(h)
    const tab = tabsOf(ws).find((candidate) => leavesOf(candidate.root)[0]!.session === ran.session)!
    expect(tab.defaultTitle).toBe('Hello')
    expect(groupOf(ws, tab.id).lastQuickCommand).toBe('hello')
    expect(ws.activeGroup).toBe(groupOf(ws, tab.id).id)

    const multi = await h.json<{ session: string }>(['terminal', 'quick-command', 'run', 'two-lines'])
    const multiRows = await h.waitForLine(multi.session, web)
    expect(multiRows.some((line) => line.endsWith('cd web; pwd'))).toBe(true)
    expect(groupOf(await layoutOf(h), tab.id).lastQuickCommand).toBe('two-lines')
  },
  SCENARIO_MS
)

test(
  'SC-52: running into a pane types the command, and runs it only with Append Enter',
  async () => {
    const h = await startE2e()
    await h.json<Commands>(['terminal', 'quick-command', 'add', '--label', 'Hello', '--command', 'echo hello'])
    await h.json<Commands>(['terminal', 'quick-command', 'add', '--label', 'Draft', '--command', 'echo draft', '--no-enter'])
    const build = await openTab(h, ['--title', 'Build'])
    const second = await splitPane(h, build.pane.id, 'right')

    await h.cli(['terminal', 'quick-command', 'run', 'draft', '--pane', second.pane.id])
    await waitFor('the draft at the prompt', async () => ((await h.screen(second.pane.session)).some((line) => /[%#] echo draft$/.test(line)) ? true : undefined))
    await Bun.sleep(500)
    expect((await h.screen(second.pane.session)).includes('draft')).toBe(false)

    await h.cli(['terminal', 'quick-command', 'run', 'hello', '--pane', build.pane.id])
    await h.waitForLine(build.session, 'hello')
    expect((await h.screen(build.session)).filter((line) => line === 'hello')).toHaveLength(1)
    expect(groupOf(await layoutOf(h), build.tab.id).lastQuickCommand).toBe('hello')
    expect(tabsOf(await layoutOf(h))).toHaveLength(1)

    const gone = await h.cli(['terminal', 'quick-command', 'run', 'hello', '--pane', 'pane-99'])
    expect(gone).toMatchObject({ code: 1, stderr: 'quirky: no pane pane-99\n' })
  },
  SCENARIO_MS
)

test(
  'SC-53: an agent command opens an agent tab with the prompt, and a typed-in prompt agent is refused',
  async () => {
    agents = await startAgentsE2E({ fakes: { claude: true, aider: true } })
    const added = await agents.cli(['terminal', 'quick-command', 'add', '--label', 'Review', '--kind', 'agent', '--agent', 'claude', '--command', 'review the diff', '--json'])
    expect(added.code, added.stderr).toBe(0)
    expect((JSON.parse(added.stdout) as Commands).commands).toMatchObject([{ id: 'review', kind: 'agent', agent: 'claude', command: 'review the diff', appendEnter: false }])

    const refused = await agents.cli(['terminal', 'quick-command', 'add', '--label', 'Typed', '--kind', 'agent', '--agent', 'aider', '--command', 'hello'])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain("takes its prompt after it starts and can't run a quick command")
    const listed = JSON.parse((await agents.cli(['terminal', 'quick-command', 'list', '--all', '--json'])).stdout) as Commands
    expect(listed.commands.map((command) => command.id)).toEqual(['review'])

    const ran = await agents.cli(['terminal', 'quick-command', 'run', 'review', '--json'])
    expect(ran.code, ran.stderr).toBe(0)
    const { session, workspace } = JSON.parse(ran.stdout) as { session: string; workspace: { root: { tabs: { root: { session: string } }[] } } }
    expect(workspace.root.tabs).toHaveLength(1)
    expect(workspace.root.tabs[0]!.root.session).toBe(session)
    const events = await agents.waitForFakeLog('claude', (log) => log.some((event) => event.type === 'start'), 20_000)
    const start = events.find((event) => event.type === 'start')
    if (start?.type !== 'start') throw new Error('claude never started')
    expect(start.argv.at(-1)).toBe('review the diff')
    const record = (await agents.call('quirky.session/get', { session })) as { agent: string; status: string }
    expect(record).toMatchObject({ agent: 'claude', status: 'running' })
  },
  SCENARIO_MS
)

test(
  'SC-54: quick-command list --worktree main lists the project commands of its repo, and a worktree of another repo only the global ones',
  async () => {
    const h = await startE2e()
    await h.json<Commands>(['terminal', 'quick-command', 'add', '--label', 'Hello', '--command', 'echo hello'])
    await h.json<Commands>(['terminal', 'quick-command', 'add', '--label', 'Test', '--command', 'echo test', '--scope', 'repo'])
    const ids = (listed: Commands) => listed.commands.map((command) => command.id)

    expect(ids(await h.json<Commands>(['terminal', 'quick-command', 'list', '--worktree', 'main']))).toEqual(['hello', 'test'])
    const other = await addRepo(h, 'docs')
    expect(ids(await h.json<Commands>(['terminal', 'quick-command', 'list', '--worktree', `path:${other}`]))).toEqual(['hello'])
    expect(ids(await h.json<Commands>(['terminal', 'quick-command', 'list', '--worktree', `path:${h.repo}`]))).toEqual(['hello', 'test'])
  },
  SCENARIO_MS
)

test(
  'SC-54: a repo command is offered only to that repo, and the strip remembers the last one',
  async () => {
    const h = await startE2e()
    const other = await addRepo(h, 'docs')
    await h.json<Commands>(['terminal', 'quick-command', 'add', '--label', 'Hello', '--command', 'echo hello'])
    const mine = await h.json<Commands>(['terminal', 'quick-command', 'add', '--label', 'Test', '--command', 'echo test', '--scope', 'repo'])
    expect(mine.commands.map((command) => [command.id, command.scope])).toEqual([
      ['hello', 'global'],
      ['test', 'repo']
    ])
    expect(mine.commands[1]!.repo).toBeTruthy()

    const inApi = await h.json<Commands>(['terminal', 'quick-command', 'list'])
    expect(inApi.commands.map((command) => command.id)).toEqual(['hello', 'test'])
    const inDocs = JSON.parse((await h.cli(['terminal', 'quick-command', 'list', '--json'], { cwd: other })).stdout) as Commands
    expect(inDocs.commands.map((command) => command.id)).toEqual(['hello'])
    const byWorktree = await h.call<Commands>('quirky.terminal/quickCommands', { workspace: `path:${h.repo}` })
    expect(byWorktree.commands.map((command) => command.id)).toEqual(['hello', 'test'])
    const byOther = await h.call<Commands>('quirky.terminal/quickCommands', { workspace: `path:${other}` })
    expect(byOther.commands.map((command) => command.id)).toEqual(['hello'])
    const all = await h.json<Commands>(['terminal', 'quick-command', 'list', '--all'])
    expect(all.commands.map((command) => command.id)).toEqual(['hello', 'test'])
    const text = await h.ok(['terminal', 'quick-command', 'list'])
    expect(text).toMatch(/hello\s+Hello\s+terminal\s+global\s+echo hello/)
    expect(text).toMatch(/test\s+Test\s+terminal\s+repo\s+echo test/)

    await h.json(['terminal', 'quick-command', 'run', 'test'])
    const group = () => layoutOf(h, `path:${h.repo}`).then((ws) => groupsOf(ws)[0]!)
    expect((await group()).lastQuickCommand).toBe('test')
    await h.json(['terminal', 'quick-command', 'run', 'hello'])
    expect((await group()).lastQuickCommand).toBe('hello')
  },
  SCENARIO_MS
)
