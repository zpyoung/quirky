import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QuirkyClient, RpcErrorCode, type PluginEvent } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { groupsInOrder, paneLeaves } from '../src/layout/tree'
import { isTerminalTab } from '../src/layout/types'
import type { QuickCommand, TerminalTab, Workspace } from '../src/layout/types'
import { sessionCreates } from './fakes/quirky.session/main'
import { call, createSession, restartDaemon, startPluginHarness, TERMINAL_PLUGINS } from './support'

let h: Harness
let client: QuirkyClient

beforeEach(async () => {
  sessionCreates().length = 0
  h = await startPluginHarness(TERMINAL_PLUGINS)
  client = await h.connect('cli')
})
afterEach(async () => {
  await h.cleanup()
})

const api = (method: string, params: Record<string, unknown> = {}, c: QuirkyClient = client) => call<any>(c, `quirky.terminal/${method}`, params)
const add = async (fields: Record<string, unknown>) => (await api('addQuickCommand', fields)).commands as QuickCommand[]
const all = async () => (await api('quickCommands', { all: true })).commands as QuickCommand[]
const error = async (promise: Promise<unknown>) => (await promise.then(() => null, (e: unknown) => e)) as (Error & { code?: number }) | null
const typed = (sessionId: string) => h.pty.inputs.filter((input) => input.sessionId === sessionId).map((input) => input.text).join('')
const tabsOf = (ws: Workspace): TerminalTab[] => groupsInOrder(ws.root).flatMap((group) => group.tabs.filter(isTerminalTab))

describe('SC-50: limits and normalization', () => {
  test('SC-50: the 41st command is refused, a duplicate label gets -2, and text is trimmed', async () => {
    await add({ label: '  Hello ', command: '  echo hello  ' })
    for (let i = 1; i < 40; i++) await add({ label: `Command ${i}`, command: `echo ${i}` })
    const full = await all()
    expect(full).toHaveLength(40)
    expect(full[0]).toEqual({ id: 'hello', label: 'Hello', kind: 'terminal', agent: null, command: 'echo hello', appendEnter: true, scope: 'global', repo: null })

    const refused = await error(api('addQuickCommand', { label: 'One more', command: 'true' }))
    expect([refused?.code, refused?.message]).toEqual([RpcErrorCode.InvalidParams, 'at most 40 quick commands'])
    expect(await all()).toHaveLength(40)

    await api('removeQuickCommand', { id: 'command-39', yes: true })
    const commands = await add({ label: 'Hello', command: 'echo again' })
    expect(commands.map((command) => command.id).filter((id) => id.startsWith('hello'))).toEqual(['hello', 'hello-2'])
  })

  test('SC-50: a row with an empty command is kept but can\'t be run; a row with nothing in it is refused', async () => {
    const commands = await add({ label: 'Draft', command: '   ' })
    expect(commands).toEqual([expect.objectContaining({ id: 'draft', command: '' })])
    const run = await error(api('runQuickCommand', { id: 'draft' }))
    expect(run?.code).toBe(RpcErrorCode.InvalidParams)
    const empty = await error(api('addQuickCommand', { label: ' ', command: ' ' }))
    expect([empty?.code, empty?.message]).toEqual([RpcErrorCode.InvalidParams, 'a quick command needs a label or a command'])
    expect(await all()).toHaveLength(1)
  })

  test('over-long labels and commands, bad kinds and scopes are invalid-params', async () => {
    const bad: Record<string, unknown>[] = [
      { label: 'x'.repeat(81), command: 'a' },
      { label: 'ok', command: 'x'.repeat(4001) },
      { label: 'ok', command: 'a', scope: 'repo', repo: 'r'.repeat(201) },
      { label: 'ok', command: 'a', kind: 'agent' },
      { label: 'ok', command: 'a', agent: 'claude' },
      { label: 'ok', command: 'a', kind: 'agent', agent: 'claude', appendEnter: true },
      { label: 'ok', command: 'a', kind: 'other' },
      { label: 'ok', command: 'a', scope: 'team' }
    ]
    for (const fields of bad) expect((await error(api('addQuickCommand', fields)))?.code).toBe(RpcErrorCode.InvalidParams)
    expect(await all()).toEqual([])
    const limit = await add({ label: 'x'.repeat(80), command: 'x'.repeat(4000) })
    expect(limit).toHaveLength(1)
  })

  test('update changes the given fields in place, keeps the id and position, and refuses unknown ids', async () => {
    await add({ label: 'One', command: 'echo 1' })
    await add({ label: 'Two', command: 'echo 2' })
    const updated = (await api('updateQuickCommand', { id: 'one', label: 'First', command: 'echo first', appendEnter: false })).commands as QuickCommand[]
    expect(updated.map((command) => [command.id, command.label, command.command, command.appendEnter])).toEqual([
      ['one', 'First', 'echo first', false],
      ['two', 'Two', 'echo 2', true]
    ])
    expect((await error(api('updateQuickCommand', { id: 'nope', label: 'x' })))?.code).toBe(RpcErrorCode.NotFound)
    expect((await error(api('updateQuickCommand', { id: 'one', command: 'x'.repeat(4001) })))?.code).toBe(RpcErrorCode.InvalidParams)
    expect((await all())[0]!.label).toBe('First')
  })

  test('remove deletes, refuses unknown ids, and asks first unless yes', async () => {
    await add({ label: 'One', command: 'echo 1' })
    expect((await error(api('removeQuickCommand', { id: 'nope', yes: true })))?.code).toBe(RpcErrorCode.NotFound)
    expect(await api('removeQuickCommand', { id: 'one', yes: true })).toEqual({ commands: [] })

    const asking = await startPluginHarness({ ...TERMINAL_PLUGINS, real: [...TERMINAL_PLUGINS.real, 'quirky.ask'] })
    try {
      const asker = await asking.connect('cli')
      await api('addQuickCommand', { label: 'One', command: 'echo 1' }, asker)
      const asked = await error(api('removeQuickCommand', { id: 'one' }, asker))
      expect(asked?.code).toBe(RpcErrorCode.ConfirmationRequired)
      expect(((asked as unknown as { data: { action: string } }).data).action).toBe('Remove quick command one?')
      expect((await api('quickCommands', { all: true }, asker)).commands).toHaveLength(1)
    } finally {
      await asking.cleanup()
    }
  })

  test('commands and a quickCommands event survive a daemon restart', async () => {
    const { events } = await h.connectWithEvents('ui')
    await add({ label: 'Hello', command: 'echo hello', scope: 'repo', repo: 'repo_alpha' })
    await waitFor(() => events.some((event) => event.type === 'quirky.terminal/quickCommands'))
    const before = await all()
    const restarted = await restartDaemon(h)
    try {
      expect((await api('quickCommands', { all: true }, restarted.client)).commands).toEqual(before)
    } finally {
      await restarted.stop()
    }
  })
})

describe('SC-54: scope', () => {
  beforeEach(async () => {
    await add({ label: 'Hello', command: 'echo hello' })
    await add({ label: 'Test', command: 'bun test', scope: 'repo', repo: 'repo_alpha' })
  })

  test('SC-54: a worktree lists its repo\'s commands and the global ones; another repo and floating only the global ones', async () => {
    const ids = async (workspace: string) => ((await api('quickCommands', { workspace })).commands as QuickCommand[]).map((command) => command.id)
    expect(await ids('main')).toEqual(['hello', 'test'])
    expect(await ids('other')).toEqual(['hello', 'test'])
    expect(await ids('beta')).toEqual(['hello'])
    expect(await ids('floating')).toEqual(['hello'])
    expect((await all()).map((command) => command.id)).toEqual(['hello', 'test'])
  })

  test('the caller\'s worktree is the default, and a repo command defaults to its repo', async () => {
    const inBeta = await QuirkyClient.connect(rpcUrl(h.runtime), { role: 'cli', worktreeId: 'wt_beta' })
    const inFloating = await QuirkyClient.connect(rpcUrl(h.runtime), { role: 'cli', worktreeId: 'floating' })
    try {
      expect(((await api('quickCommands', {}, inBeta)).commands as QuickCommand[]).map((command) => command.id)).toEqual(['hello'])
      const added = (await api('addQuickCommand', { label: 'Beta only', command: 'ls', scope: 'repo' }, inBeta)).commands as QuickCommand[]
      expect(added.at(-1)).toMatchObject({ scope: 'repo', repo: 'repo_beta' })
      const refused = await error(api('addQuickCommand', { label: 'Nowhere', command: 'ls', scope: 'repo' }, inFloating))
      expect(refused?.code).toBe(RpcErrorCode.InvalidParams)
      const toGlobal = (await api('updateQuickCommand', { id: 'test', scope: 'global' })).commands as QuickCommand[]
      expect(toGlobal.find((command) => command.id === 'test')).toMatchObject({ scope: 'global', repo: null })
      const toRepo = (await api('updateQuickCommand', { id: 'hello', scope: 'repo' }, inBeta)).commands as QuickCommand[]
      expect(toRepo.find((command) => command.id === 'hello')).toMatchObject({ scope: 'repo', repo: 'repo_beta' })
    } finally {
      inBeta.close()
      inFloating.close()
    }
  })
})

describe('SC-51, SC-52: running a command', () => {
  test('SC-51: a new tab titled with the label gets the command and Enter, and the group remembers it', async () => {
    await add({ label: 'Hello', command: 'echo hello' })
    await add({ label: 'Build', command: 'cd web\n  npm test\n\n' })
    const result = await api('runQuickCommand', { id: 'hello', workspace: 'main' })
    const ws = result.workspace as Workspace
    const tab = tabsOf(ws).at(-1)!
    expect(tab.defaultTitle).toBe('Hello')
    expect(result.session).toBe(paneLeaves(tab.root)[0]!.session)
    expect(groupsInOrder(ws.root)[0]!.lastQuickCommand).toBe('hello')
    await waitFor(() => typed(result.session) === 'echo hello\r')

    const multi = await api('runQuickCommand', { id: 'build', workspace: 'main' })
    await waitFor(() => typed(multi.session) === 'cd web; npm test\r')
    expect(groupsInOrder((multi.workspace as Workspace).root)[0]!.lastQuickCommand).toBe('build')
    expect(tabsOf(multi.workspace as Workspace).map((t) => t.defaultTitle)).toEqual(['Hello', 'Build'])
  })

  test('a lone shell a quick command made exit 0 closes, whether the command ran in a new tab or an existing pane', async () => {
    await add({ label: 'Leave', command: 'exit 0' })
    const created = await api('runQuickCommand', { id: 'leave', workspace: 'main' })
    h.pty.exit(created.session, 0)
    await waitForAsync(async () => tabsOf((await api('workspace', { workspace: 'main' })).workspace).length === 0)

    const ws = (await api('newTab', { workspace: 'main' })).workspace as Workspace
    const pane = paneLeaves(tabsOf(ws)[0]!.root)[0]!
    await api('runQuickCommand', { id: 'leave', pane: pane.id })
    h.pty.exit(pane.session, 0)
    await waitForAsync(async () => tabsOf((await api('workspace', { workspace: 'main' })).workspace).length === 0)
  })

  test('a pane run is remembered as the group\'s last quick command', async () => {
    await add({ label: 'Hello', command: 'echo hello' })
    const ws = (await api('newTab', { workspace: 'main' })).workspace as Workspace
    const pane = paneLeaves(tabsOf(ws)[0]!.root)[0]!
    await api('runQuickCommand', { id: 'hello', pane: pane.id })
    const after = (await api('workspace', { workspace: 'main' })).workspace as Workspace
    expect(groupsInOrder(after.root)[0]!.lastQuickCommand).toBe('hello')
    expect(after.revision).toBe(ws.revision + 1)
  })

  test('a run in the floating workspace opens a floating tab', async () => {
    await add({ label: 'Hello', command: 'echo hello' })
    const result = await api('runQuickCommand', { id: 'hello', workspace: 'floating' })
    expect((result.workspace as Workspace).id).toBe('floating')
    expect(sessionCreates().at(-1)).toMatchObject({ worktree: 'floating' })
  })

  test('SC-52: a pane run types the command, adding Enter only when Append Enter is on', async () => {
    await add({ label: 'Hello', command: 'echo hello' })
    await add({ label: 'Draft', command: 'echo draft', appendEnter: false })
    const ws = (await api('newTab', { workspace: 'main' })).workspace as Workspace
    const pane = paneLeaves(tabsOf(ws)[0]!.root)[0]!
    expect(await api('runQuickCommand', { id: 'draft', pane: pane.id })).toEqual({ ok: true, session: pane.session })
    await waitFor(() => typed(pane.session) === 'echo draft')
    await api('runQuickCommand', { id: 'hello', pane: pane.id })
    await waitFor(() => typed(pane.session) === 'echo draftecho hello\r')
    expect(tabsOf((await api('workspace', { workspace: 'main' })).workspace)).toHaveLength(1)
  })

  test('a pane run refuses an unknown pane, an unknown command and an ended session', async () => {
    await add({ label: 'Hello', command: 'echo hello' })
    expect((await error(api('runQuickCommand', { id: 'hello', pane: 'pane-99' })))?.code).toBe(RpcErrorCode.NotFound)
    expect((await error(api('runQuickCommand', { id: 'nope' })))?.code).toBe(RpcErrorCode.NotFound)
    const ws = (await api('newTab', { workspace: 'main' })).workspace as Workspace
    const pane = paneLeaves(tabsOf(ws)[0]!.root)[0]!
    h.pty.exit(pane.session, 3)
    await waitForAsync(async () => {
      const current = (await api('workspace', { workspace: 'main' })).workspace as Workspace
      return paneLeaves(tabsOf(current)[0]!.root)[0]!.exit
    })
    expect((await error(api('runQuickCommand', { id: 'hello', pane: pane.id })))?.code).toBe(RpcErrorCode.Conflict)
  })
})

describe('SC-53: agent commands', () => {
  test('SC-53: running one opens an agent tab with the command as its first prompt', async () => {
    await add({ label: 'Review', kind: 'agent', agent: 'claude', command: 'review the diff' })
    expect((await all())[0]).toMatchObject({ kind: 'agent', agent: 'claude', appendEnter: false })
    const result = await api('runQuickCommand', { id: 'review', workspace: 'main' })
    expect(sessionCreates().at(-1)).toEqual({ worktree: 'id:wt_main', agent: 'claude', prompt: 'review the diff' })
    const tab = tabsOf(result.workspace as Workspace).at(-1)!
    expect(tab.defaultTitle).toBe('Claude')
    expect(groupsInOrder((result.workspace as Workspace).root)[0]!.lastQuickCommand).toBe('review')
    expect(typed(result.session)).toBe('')
  })

  test('SC-53: an agent whose prompt is typed after start, and an unknown agent, are refused when adding or updating', async () => {
    const goose = await error(api('addQuickCommand', { label: 'Goose', kind: 'agent', agent: 'goose', command: 'hi' }))
    expect(goose?.code).toBe(RpcErrorCode.InvalidParams)
    expect(goose?.message).toContain('goose')
    expect((await error(api('addQuickCommand', { label: 'Ghost', kind: 'agent', agent: 'ghost', command: 'hi' })))?.code).toBe(RpcErrorCode.NotFound)
    await add({ label: 'Review', kind: 'agent', agent: 'claude', command: 'review' })
    expect((await error(api('updateQuickCommand', { id: 'review', agent: 'goose' })))?.code).toBe(RpcErrorCode.InvalidParams)
    expect(await all()).toHaveLength(1)
  })

  test('switching a command between kinds fixes the fields that only one kind has', async () => {
    await add({ label: 'Mixed', command: 'echo mixed' })
    const asAgent = (await api('updateQuickCommand', { id: 'mixed', kind: 'agent', agent: 'codex' })).commands as QuickCommand[]
    expect(asAgent[0]).toMatchObject({ kind: 'agent', agent: 'codex', appendEnter: false })
    const asTerminal = (await api('updateQuickCommand', { id: 'mixed', kind: 'terminal' })).commands as QuickCommand[]
    expect(asTerminal[0]).toMatchObject({ kind: 'terminal', agent: null, appendEnter: true })
  })

  test('a session started elsewhere during a run is bound once, beside the run\'s own tab', async () => {
    await add({ label: 'Hello', command: 'echo hello' })
    await Promise.all([api('runQuickCommand', { id: 'hello', workspace: 'main' }), createSession(client, { worktree: 'id:wt_main', agent: 'shell' })])
    const ws = await waitForAsync(async () => {
      const current = (await api('workspace', { workspace: 'main' })).workspace as Workspace
      return tabsOf(current).length === 2 ? current : null
    })
    const bound = tabsOf(ws).flatMap((tab) => paneLeaves(tab.root).map((pane) => pane.session))
    expect(new Set(bound).size).toBe(2)
  })
})

describe('events', () => {
  test('every change announces quickCommands once', async () => {
    const { events } = await h.connectWithEvents('ui')
    const count = () => events.filter((event) => event.type === 'quirky.terminal/quickCommands' && (event as PluginEvent).data !== undefined).length
    await add({ label: 'One', command: 'a' })
    await api('updateQuickCommand', { id: 'one', command: 'b' })
    await api('removeQuickCommand', { id: 'one', yes: true })
    await waitFor(() => count() === 3)
  })
})
