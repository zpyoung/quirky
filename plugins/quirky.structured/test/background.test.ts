import { afterEach, expect, setDefaultTimeout, test } from 'bun:test'
import { symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RpcErrorCode, type QuirkyClient, type QuirkyEvent, type Session, type StructuredMessage } from '@quirky/protocol'
import { startHarness, waitFor, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import { makeTempDir, removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'
import type { Group, GroupNode, PaneNode, Workspace } from '../../quirky.terminal/src/layout/types'
import type { StructuredContext, StructuredRunnerFactory, StructuredStartOptions } from '../runner'

const PLUGIN_DIR = dirname(dirname(fileURLToPath(import.meta.url)))
const PLUGINS_DIR = dirname(PLUGIN_DIR)
const gitConfig = isolateGitConfig()
const globals = globalThis as typeof globalThis & { __QUIRKY_TEST_STRUCTURED_RUNNER__?: StructuredRunnerFactory }
const PLUGINS = ['quirky.agents', 'quirky.ask', 'quirky.cli', 'quirky.repo', 'quirky.session', 'quirky.structured', 'quirky.terminal', 'quirky.worktree']

setDefaultTimeout(30_000)

let h: Harness | undefined
let client: QuirkyClient | undefined
let events: QuirkyEvent[] = []

afterEach(async () => {
  try {
    await h?.cleanup()
  } finally {
    h = undefined
    client = undefined
    events = []
    delete globals.__QUIRKY_TEST_STRUCTURED_RUNNER__
    removeTempDirs()
  }
})

const call = <T = unknown>(method: string, params: Record<string, unknown> = {}) => client!.callAny(method, params) as Promise<T>

function builtinDir(): string {
  const dir = makeTempDir('q-background-plugins-')
  for (const id of PLUGINS) symlinkSync(join(PLUGINS_DIR, id), join(dir, id))
  return dir
}

function groupsIn(node: GroupNode): Group[] {
  return node.kind === 'group' ? [node] : [...groupsIn(node.first), ...groupsIn(node.second)]
}

function paneSessions(node: PaneNode): string[] {
  return node.kind === 'pane' ? [node.session] : [...paneSessions(node.first), ...paneSessions(node.second)]
}

function terminalSessionIds(workspace: Workspace): string[] {
  return groupsIn(workspace.root).flatMap((group) =>
    group.tabs.flatMap((tab) => (tab.kind === 'view' ? [] : paneSessions(tab.root)))
  )
}

function activeTab(workspace: Workspace): string | null {
  return groupsIn(workspace.root).find((group) => group.id === workspace.activeGroup)?.activeTab ?? null
}

async function expectInvalid(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught
  )
  expect(error).toMatchObject({ code: RpcErrorCode.InvalidParams })
}

async function waitForSessionChange(sessionId: string): Promise<void> {
  await waitFor(() =>
    events.some((event) => {
      if (event.type !== 'quirky.session/changed') return false
      return (event.data as { session?: Session }).session?.id === sessionId
    })
      ? true
      : undefined
  )
}

async function journal(sessionId: string): Promise<StructuredMessage[]> {
  return waitForAsync(async () => {
    const messages = await call<StructuredMessage[]>('quirky.structured/messages', { session: sessionId })
    return messages.length >= 2 ? messages : undefined
  })
}

test('background structured sessions stay journaled without changing terminal selection and remain hidden on resume', async () => {
  const home = makeTempDir('q-background-home-')
  const repoPath = makeRepo(gitConfig.scratch())
  const worktreesRoot = makeTempDir('q-background-worktrees-')
  globals.__QUIRKY_TEST_STRUCTURED_RUNNER__ = (context: StructuredContext) => ({
    async start(session: Session, prompt?: string, options?: StructuredStartOptions) {
      await context.setProviderSession(session.id, options?.providerSession ?? { id: `provider-${session.id}`, transcriptPath: null })
      if (prompt !== undefined) context.appendMessage({ sessionId: session.id, role: 'user', text: prompt })
      context.appendMessage({ sessionId: session.id, role: 'result', text: 'scripted result' })
    },
    async send() {},
    async stop() {}
  })

  h = await startHarness({ home, builtinPluginsDir: builtinDir() })
  ;({ client, events } = await h.connectWithEvents('cli'))

  const repo = (await call('quirky.repo/add', { path: repoPath })) as { id: string }
  await call('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: worktreesRoot })
  const [worktree] = (await call('quirky.worktree/list', { repo: repo.id })) as { id: string }[]
  expect(worktree).toBeDefined()

  const terminal = (await call('quirky.terminal/newTab', {
    workspace: worktree!.id,
    agent: 'shell',
    title: 'Selected shell'
  })) as { workspace: Workspace; session: string; tab: string }
  await call('quirky.terminal/focusContext', { workspace: worktree!.id })
  const initial = (await call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: worktree!.id })).workspace
  const initialFocus = (await call<{ workspace: string | null }>('quirky.terminal/focusContext')).workspace
  expect(initial.id).toBe(worktree!.id)
  expect(activeTab(initial)).toBe(terminal.tab)
  expect(terminalSessionIds(initial)).toEqual([terminal.session])
  expect(initialFocus).toBe(worktree!.id)

  const background = (await call('quirky.structured/create', {
    worktree: worktree!.id,
    agent: 'claude',
    prompt: 'background task',
    background: true
  })) as Session
  expect(background.background).toBe(true)
  expect((await journal(background.id)).map(({ role, text }) => [role, text])).toEqual([
    ['user', 'background task'],
    ['result', 'scripted result']
  ])
  await waitForSessionChange(background.id)

  const backgroundRecord = (await call('quirky.session/get', { session: background.id })) as Session
  const listedBackground = (await call('quirky.session/list', { worktree: worktree!.id })) as Session[]
  expect(backgroundRecord.background).toBe(true)
  expect(listedBackground.find((session) => session.id === background.id)?.background).toBe(true)
  const afterBackground = (await call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: worktree!.id })).workspace
  const focusAfterBackground = (await call<{ workspace: string | null }>('quirky.terminal/focusContext')).workspace
  expect(terminalSessionIds(afterBackground)).not.toContain(background.id)
  expect(afterBackground.id).toBe(initial.id)
  expect(afterBackground.activeGroup).toBe(initial.activeGroup)
  expect(activeTab(afterBackground)).toBe(activeTab(initial))
  expect(focusAfterBackground).toBe(initialFocus)

  await call('quirky.structured/stop', { session: background.id })
  const resumed = (await call('quirky.structured/resume', { session: background.id, prompt: 'resume hidden task' })) as Session
  expect(resumed.background).toBe(true)
  expect((await journal(resumed.id)).map(({ role, text }) => [role, text])).toEqual([
    ['user', 'resume hidden task'],
    ['result', 'scripted result']
  ])
  await waitForSessionChange(resumed.id)
  const resumedRecord = (await call('quirky.session/get', { session: resumed.id })) as Session
  expect(resumedRecord.background).toBe(true)
  expect(
    terminalSessionIds(
      (await call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: worktree!.id })).workspace
    )
  ).not.toContain(resumed.id)

  const ordinary = (await call('quirky.structured/create', {
    worktree: worktree!.id,
    agent: 'claude',
    prompt: 'ordinary task'
  })) as Session
  await journal(ordinary.id)
  await waitForSessionChange(ordinary.id)
  const afterOrdinary = (await call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: worktree!.id })).workspace
  expect(terminalSessionIds(afterOrdinary)).not.toContain(ordinary.id)
  expect(activeTab(afterOrdinary)).toBe(activeTab(initial))

  const explicitFalse = (await call('quirky.structured/create', {
    worktree: worktree!.id,
    agent: 'claude',
    prompt: 'explicit false flag task',
    background: false
  })) as Session
  await journal(explicitFalse.id)
  await waitForSessionChange(explicitFalse.id)
  const afterExplicitFalse = (await call<{ workspace: Workspace }>('quirky.terminal/workspace', { workspace: worktree!.id })).workspace
  expect(terminalSessionIds(afterExplicitFalse)).not.toContain(explicitFalse.id)
  expect(activeTab(afterExplicitFalse)).toBe(activeTab(initial))

  const sessionsBeforeInvalidCalls = (await call('quirky.session/list', { worktree: worktree!.id })) as Session[]
  await expectInvalid(
    call('quirky.structured/create', {
      worktree: worktree!.id,
      agent: 'claude',
      prompt: 'invalid flag',
      background: 'true'
    })
  )
  await expectInvalid(
    call('quirky.session/register', {
      worktree: worktree!.id,
      agent: 'claude',
      kind: 'structured',
      title: 'invalid flag',
      background: 1
    })
  )
  await expectInvalid(
    call('quirky.structured/create', {
      worktree: worktree!.id,
      agent: 'claude',
      prompt: 'raw args remain refused',
      extraArgs: '--unsafe'
    })
  )
  expect((await call('quirky.session/list', { worktree: worktree!.id }) as Session[]).map((session) => session.id)).toEqual(
    sessionsBeforeInvalidCalls.map((session) => session.id)
  )
})
