import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { Screen } from '../../packages/pty-host/src/screen'
import {
  ASK_CARD_FIXTURE_COMMAND,
  closeAskCardFixture,
  createAskCardFixture,
  prepareCaptureTerminalFixture,
  closeCaptureTerminalFixture,
  createCaptureTerminalFixture,
  createIsolatedRuntimeEnvironment,
  createLoopFixture,
  createTranscriptFixture,
  createViewFixture,
  prepareCaptureFixtureHome,
  prepareProviderExecutables,
  registerCaptureFixtures,
  seedWorktreeStatuses,
  type FixtureRpcClient,
  type FixtureStatus,
  type PreparedCaptureFixtureHome,
  type RegisteredCaptureFixtures
} from './fixtures'
import { approvalSpec } from '../../plugins/quirky.structured/native-questions'
import { fixtureIssue, fixturePullRequest } from '../../plugins/quirky.tasks/test/fixtures/list'
import { CHECKS_FIXTURE_BRANCH } from './tasks-fixture'
import { createProcessRunner } from '../../packages/process/src/api'
import { QuirkyClient, type ProcessRunner } from '@quirky/protocol'
import { resolveCodexThroughLoginShell } from '../../plugins/quirky.structured/codex-path'

import bundleSizeSpec from '../../plugins/quirky.view/test/fixtures/bundle-size.json'

const fixtureProcesses: Array<Bun.Subprocess<'ignore', 'ignore', 'ignore'>> = []
let viewFixtureSessionNumber = 0

const VIEW_FIXTURE_CLI = String.raw`
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const args = process.argv.slice(2)
const logPath = process.env.VIEW_FIXTURE_CLI_LOG
const mode = process.env.VIEW_FIXTURE_CLI_MODE
const readRows = () => existsSync(logPath) ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
const flagValue = name => {
  const index = args.indexOf(name)
  if (index >= 0) return args[index + 1]
  const joined = args.find(value => value.startsWith(name + '='))
  return joined?.slice(name.length + 1)
}
const rows = readRows()
const isOpen = args[0] === 'view' && args[1] === 'open'
const isList = args[0] === 'api' && args[1] === 'call' && args[2] === 'quirky.view/list'
let spec
if (isOpen) {
  const raw = flagValue('--spec')
  const source = raw?.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw
  spec = JSON.parse(source)
}
const placement = isOpen ? flagValue('--placement') ?? 'inline' : undefined
const row = { kind: isOpen ? 'open' : isList ? 'list' : 'other', args, spec, placement }
appendFileSync(logPath, JSON.stringify(row) + '\n')

if (isOpen) {
  const index = rows.filter(candidate => candidate.kind === 'open').length
  if (mode === 'nonzero' && index === 0 || mode === 'nonzero-second-open' && index === 1) {
    process.stderr.write('fixture CLI stand-in failed')
    process.exitCode = 7
  } else if (mode === 'malformed') {
    process.stdout.write('not JSON')
  } else if (mode === 'missing-id') {
    process.stdout.write('{}')
  } else {
    process.stdout.write(JSON.stringify({ viewId: ['view_000000000001', 'view_000000000002', 'view_000000000003'][index] }))
  }
} else if (isList) {
  if (mode === 'invalid-list' || flagValue('--session') !== process.env.QUIRKY_SESSION_ID) {
    process.stdout.write('[]')
  } else {
    const opened = [...rows, row].filter(candidate => candidate.kind === 'open')
    const ids = ['view_000000000001', 'view_000000000002', 'view_000000000003']
    const records = opened.map((candidate, index) => ({
      viewId: ids[index],
      sessionId: process.env.QUIRKY_SESSION_ID,
      title: candidate.spec.title,
      spec: { root: candidate.spec.root, title: candidate.spec.title },
      placement: candidate.placement,
      movedByUser: false,
      updates: 0,
      createdAt: '2026-11-17T12:00:00.000Z',
      updatedAt: '2026-11-17T12:00:00.000Z',
      closed: false
    }))
    process.stdout.write(JSON.stringify(records))
  }
} else {
  process.stdout.write('{}')
}
`

function readJsonLines(path: string): Array<Record<string, unknown>> {
  return existsSync(path)
    ? readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
    : []
}

async function prepareViewFixtureHome(): Promise<{ prepared: PreparedCaptureFixtureHome; fixtures: RegisteredCaptureFixtures }> {
  const prepared = await prepareCaptureFixtureHome(freshHome(), { timeoutMs: 20_000 })
  const fixtures = await registerCaptureFixtures(fakeFixtureClient(prepared), prepared, { timeoutMs: 5_000 })
  return { prepared, fixtures }
}

function localViewFixtureBridge(
  prepared: PreparedCaptureFixtureHome,
  mode = 'success',
  onSessionCreated?: (session: string) => void
) {
  const base = fakeFixtureClient(prepared)
  const cliPath = join(prepared.home, 'view-fixture-cli.ts')
  const logPath = join(prepared.home, `view-fixture-${mode}.jsonl`)
  writeFileSync(cliPath, VIEW_FIXTURE_CLI)
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const createdSessions: string[] = []
  const closedSessions: string[] = []
  const processes = new Map<string, Bun.Subprocess<'ignore', 'ignore', 'ignore'>>()
  const client: FixtureRpcClient = {
    async callAny(method, params = {}, options) {
      calls.push({ method, params })
      if (method === 'quirky.session/create') {
        const session = `session_${String(++viewFixtureSessionNumber).padStart(12, '0')}`
        createdSessions.push(session)
        if (mode !== 'provider-timeout' && mode !== 'abort') {
          const env = {
            ...createIsolatedRuntimeEnvironment(prepared.home, { repoRoot: resolve(import.meta.dir, '../..') }),
            QUIRKY_SESSION_ID: session,
            WORKER_TEST_CLI: cliPath,
            VIEW_FIXTURE_CLI_LOG: logPath,
            VIEW_FIXTURE_CLI_MODE: mode
          }
          const child = Bun.spawn([join(prepared.home, 'fakebin', 'claude')], {
            cwd: prepared.repoPath,
            env,
            stdin: 'ignore',
            stdout: 'ignore',
            stderr: 'ignore'
          })
          fixtureProcesses.push(child)
          processes.set(session, child)
        }
        onSessionCreated?.(session)
        return { id: session }
      }
      if (method === 'quirky.session/close') {
        const session = String(params.session)
        closedSessions.push(session)
        const child = processes.get(session)
        if (child?.exitCode === null) {
          child.kill('SIGTERM')
          await Promise.race([child.exited, Bun.sleep(500)])
          if (child.exitCode === null) {
            child.kill('SIGKILL')
            await Promise.race([child.exited, Bun.sleep(500)])
          }
        }
        return { ok: true }
      }
      return await base.callAny(method, params, options)
    }
  }
  return { client, calls, createdSessions, closedSessions, logPath }
}

const temporaryHomes: string[] = []

afterEach(async () => {
  for (const child of fixtureProcesses.splice(0)) {
    if (child.exitCode === null) child.kill('SIGTERM')
    await Promise.race([child.exited, Bun.sleep(500)])
    if (child.exitCode === null) {
      child.kill('SIGKILL')
      await Promise.race([child.exited, Bun.sleep(500)])
    }
  }
  for (const home of temporaryHomes.splice(0)) rmSync(home, { recursive: true, force: true })
})

test('creates three stored view fixtures through the authorized fake-Claude CLI bridge', async () => {
  const { prepared, fixtures } = await prepareViewFixtureHome()
  const bridge = localViewFixtureBridge(prepared)
  const fixture = await createViewFixture(bridge.client, fixtures, { timeoutMs: 8_000 })

  expect(fixture).toEqual({
    sessionId: bridge.createdSessions[0],
    inlineViewId: 'view_000000000001',
    paneViewIds: ['view_000000000002', 'view_000000000003']
  })
  expect(bridge.createdSessions).toHaveLength(1)
  expect(bridge.closedSessions).toEqual([])
  expect(bridge.calls.find((call) => call.method === 'quirky.session/create')?.params).toMatchObject({
    worktree: fixtures.primaryWorktree.id,
    agent: 'claude'
  })

  const eventPath = join(prepared.home, 'worker-fixture', `${fixture.sessionId}.events.jsonl`)
  const requestPath = join(prepared.home, 'worker-fixture', `${fixture.sessionId}.requests.jsonl`)
  expect(readJsonLines(eventPath).map((event) => event.type)).toContain('started')
  const requests = readJsonLines(requestPath).map((request) => request.args as string[])
  expect(requests.filter((args) => args[0] === 'view' && args[1] === 'open')).toHaveLength(3)
  expect(requests.some((args) =>
    args[0] === 'api' && args[1] === 'call' && args[2] === 'quirky.view/list' &&
    args.includes('--session') && args[args.indexOf('--session') + 1] === fixture.sessionId && args.includes('--json')
  )).toBe(true)
  expect(bridge.calls.some((call) => call.method === 'quirky.view/list')).toBe(false)

  const cliRows = readJsonLines(bridge.logPath)
  const opened = cliRows.filter((row) => row.kind === 'open')
  expect(opened.map((row) => ({
    title: (row.spec as { title: string }).title,
    placement: row.placement,
    spec: row.spec
  }))).toEqual([
    { title: 'Bundle size by route', placement: 'inline', spec: bundleSizeSpec },
    { title: 'Bundle size by route', placement: 'pane', spec: bundleSizeSpec },
    {
      title: 'Module map',
      placement: 'pane',
      spec: { title: 'Module map', root: { type: 'markdown', props: { text: 'Module map body' } } }
    }
  ])
})

test('view fixture setup failures close the session, including a partially seeded session', async () => {
  const { prepared, fixtures } = await prepareViewFixtureHome()
  const failures: Array<{ mode: string; timeoutMs: number; expected?: RegExp | string }> = [
    { mode: 'provider-timeout', timeoutMs: 60, expected: /started|provider|worker/i },
    { mode: 'nonzero', timeoutMs: 5_000, expected: /exited 7/ },
    { mode: 'malformed', timeoutMs: 5_000, expected: /JSON/i },
    { mode: 'missing-id', timeoutMs: 5_000, expected: /view.*ID|ID.*view/i },
    { mode: 'invalid-list', timeoutMs: 5_000, expected: /view|list/i },
    { mode: 'nonzero-second-open', timeoutMs: 5_000, expected: /exited 7/ }
  ]

  for (const failure of failures) {
    const bridge = localViewFixtureBridge(prepared, failure.mode)
    const setup = createViewFixture(bridge.client, fixtures, { timeoutMs: failure.timeoutMs })
    if (failure.expected) await expect(setup).rejects.toThrow(failure.expected)
    else await expect(setup).rejects.toThrow()
    expect(bridge.closedSessions).toEqual(bridge.createdSessions)
    if (failure.mode === 'nonzero-second-open') {
      expect(readJsonLines(bridge.logPath).filter((row) => row.kind === 'open')).toHaveLength(2)
    }
  }

  const controller = new AbortController()
  const abortBridge = localViewFixtureBridge(prepared, 'abort', () => {
    // Abort after create returns so the fixture has an acquired session to clean up.
    setTimeout(() => controller.abort(new Error('view fixture setup cancelled')), 25)
  })
  await expect(createViewFixture(abortBridge.client, fixtures, { timeoutMs: 5_000, signal: controller.signal }))
    .rejects.toThrow('view fixture setup cancelled')
  expect(abortBridge.closedSessions).toEqual(abortBridge.createdSessions)
})

test('closes a view fixture session returned after create cancellation', async () => {
  const creation = Promise.withResolvers<unknown>()
  const started = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<string>()
  const controller = new AbortController()
  const fixtures = { home: freshHome(), primaryWorktree: { id: 'worktree' } } as RegisteredCaptureFixtures
  const client: FixtureRpcClient = {
    async callAny(method, params) {
      if (method === 'quirky.session/create') {
        started.resolve()
        return await creation.promise
      }
      if (method === 'quirky.session/close') {
        closed.resolve(String(params?.session))
        return { ok: true }
      }
      throw new Error(`Unexpected fixture RPC: ${method}`)
    }
  }
  const setup = createViewFixture(client, fixtures, {
    timeoutMs: 1_000,
    signal: controller.signal
  })
  await started.promise
  controller.abort(new Error('cancelled during create'))
  await expect(setup).rejects.toThrow('cancelled during create')
  creation.resolve({ id: 'late-session' })
  expect(await closed.promise).toBe('late-session')
}, 1_000)

test('closes a view session returned after its local creation deadline without expiring the RPC response', async () => {
  const started = Promise.withResolvers<void>()
  const closed = Promise.withResolvers<string>()
  let replyToCreation: (() => void) | undefined
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return undefined
      return new Response('WebSocket only', { status: 400 })
    },
    websocket: {
      message(socket, message) {
        const request = JSON.parse(String(message))
        if (request.method === 'quirky.session/create') {
          replyToCreation = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { id: 'late-session' } }))
          started.resolve()
        } else {
          socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }))
        }
      }
    }
  })
  let transport: QuirkyClient | undefined
  try {
    transport = await QuirkyClient.connect(`ws://127.0.0.1:${server.port}`, { role: 'cli' })
    const client: FixtureRpcClient = {
      async callAny(method, params = {}, options) {
        const result = await transport!.callAny(method, params, options)
        if (method === 'quirky.session/close') closed.resolve(String(params.session))
        return result
      }
    }
    const fixtures = { home: freshHome(), primaryWorktree: { id: 'worktree' } } as RegisteredCaptureFixtures
    const setup = createViewFixture(client, fixtures, { timeoutMs: 50 })
    await started.promise
    await expect(setup).rejects.toThrow('quirky.session/create exceeded 50ms')
    replyToCreation!()
    expect(await closed.promise).toBe('late-session')
  } finally {
    transport?.close()
    server.stop(true)
  }
}, 2_000)
const TASKS_FIXTURE_OWNER = 'fixture-owner'
const TASKS_FIXTURE_REPO = 'ui-review-fixture'
const TASKS_FIXTURE_ORIGIN = `git@github.com:${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}.git`

function expectedTasksItems() {
  const issue = fixtureIssue(TASKS_FIXTURE_OWNER, TASKS_FIXTURE_REPO, 31, '2026-11-01T12:00:00Z')
  issue.title = 'Review the capture fixture issue'
  issue.labels = ['bug', 'needs review']

  const pullRequest = fixturePullRequest(TASKS_FIXTURE_OWNER, TASKS_FIXTURE_REPO, 32, '2026-11-02T12:00:00Z', [
    { name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS', url: `https://github.com/${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}/actions/runs/32` }
  ])
  pullRequest.title = 'Add capture fixture Tasks data'
  pullRequest.headRefName = 'feature/capture-fixture-tasks'
  pullRequest.reviewDecision = 'REVIEW_REQUIRED'
  pullRequest.requestedReviewers = ['reviewer-one']
  pullRequest.reviews = [{ author: 'reviewer-two', state: 'APPROVED' }]
  pullRequest.additions = 84
  pullRequest.deletions = 12
  pullRequest.changedFiles = 5

  return { issue, pullRequest }
}

function localFixtureGhPath(home: string, env: Record<string, string>): string {
  const binDirectory = env.PATH.split(delimiter).find((entry) =>
    entry.startsWith(`${home}/`) && existsSync(join(entry, 'gh'))
  )
  if (!binDirectory) throw new Error('prepared fixture did not add its local gh executable to PATH')
  return join(binDirectory, 'gh')
}

function runFixtureGh(ghPath: string, args: string[], cwd: string, env: Record<string, string>): string {
  const result = Bun.spawnSync([ghPath, ...args], { cwd, env, stdin: 'ignore' })
  const stdout = result.stdout.toString()
  if (result.exitCode !== 0) {
    throw new Error(`local fixture gh ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.toString().trim()}`)
  }
  return stdout
}

function gitOrigin(path: string, env: Record<string, string>): string | null {
  const result = Bun.spawnSync(['git', '-C', path, 'config', '--get', 'remote.origin.url'], { env, stdin: 'ignore' })
  return result.exitCode === 0 ? result.stdout.toString().trim() : null
}

function runFixtureGit(path: string, args: string[], env: Record<string, string>): string {
  const result = Bun.spawnSync(['git', '-C', path, ...args], { env, stdin: 'ignore' })
  const stdout = result.stdout.toString().trim()
  if (result.exitCode !== 0) {
    throw new Error(`local fixture git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.toString().trim()}`)
  }
  return stdout
}

async function runFixtureGhWithInput(
  ghPath: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  input: string
): Promise<string> {
  const child = Bun.spawn([ghPath, ...args], { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
  const stdoutText = new Response(child.stdout).text()
  const stderrText = new Response(child.stderr).text()
  child.stdin.write(input)
  child.stdin.end()
  const { promise: timeout, reject: rejectTimeout } = Promise.withResolvers<number>()
  const timer = setTimeout(() => rejectTimeout(new Error(`local fixture gh ${args.join(' ')} exceeded 5000ms`)), 5_000)
  try {
    const status = await Promise.race([child.exited, timeout])
    const [stdout, stderr] = await Promise.all([stdoutText, stderrText])
    if (status !== 0) throw new Error(`local fixture gh ${args.join(' ')} failed (${status}): ${stderr.trim()}`)
    return stdout
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(250).then(() => false)])
      if (!stopped) {
        child.kill('SIGKILL')
        await Promise.race([child.exited, Bun.sleep(250)])
      }
    }
    await Promise.allSettled([stdoutText, stderrText])
  }
}


function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'quirky-ui-review-fixture-test-'))
  temporaryHomes.push(home)
  return home
}

function fakeFixtureClient(
  prepared: PreparedCaptureFixtureHome,
  failAt?: string
): { callAny(method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }): Promise<unknown> } {
  let created = 0
  return {
    async callAny(method: string, params: Record<string, unknown> = {}, _options?: { timeoutMs?: number }) {
      if (method === failAt) throw new Error(`fixture RPC failed at ${method}`)
      if (method === 'quirky.repo/add') return { id: `repo:${String(params.path).split('/').pop()}` }
      if (method === 'quirky.worktree/list') {
        const repoId = String(params.repo)
        const project = prepared.projects.find((candidate) => `repo:${candidate.name}` === repoId)!
        return [{ id: `worktree:${project.name}-main`, repoId, path: project.path, name: project.name, isMain: true, kind: 'git' }]
      }
      if (method === 'quirky.worktree/create') {
        created += 1
        const name = String(params.name)
        return { worktree: {
          id: `worktree:ui-review-${created}`, repoId: String(params.repo),
          path: join(prepared.worktreesRoot, name), name, isMain: false, kind: 'git'
        } }
      }
      return { ok: true }
    }
  }
}

test('removes fixture files when public registration fails', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const client = fakeFixtureClient(prepared, 'quirky.worktree/create')

  await expect(registerCaptureFixtures(client, prepared, { timeoutMs: 2_000 })).rejects.toThrow(/fixture RPC failed/)

  expect(existsSync(prepared.repoPath)).toBe(false)
  expect(existsSync(prepared.worktreesRoot)).toBe(false)
})

test('repeated cleanup is safe after a successful fixture registration', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const registered = await registerCaptureFixtures(fakeFixtureClient(prepared), prepared, { timeoutMs: 2_000 })

  registered.cleanup()
  registered.cleanup()

  expect(existsSync(prepared.repoPath)).toBe(false)
})


test('registers three projects whose worktrees cover every status dot', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const registered = await registerCaptureFixtures(fakeFixtureClient(prepared), prepared, { timeoutMs: 2_000 })

  expect(prepared.projects).toHaveLength(3)
  for (const project of prepared.projects) expect(existsSync(join(project.path, '.git'))).toBe(true)
  expect(new Set(registered.worktrees.map((worktree) => worktree.repoId)).size).toBe(3)
  expect(new Set(registered.worktrees.map((worktree) => worktree.status))).toEqual(
    new Set<FixtureStatus>(['working', 'needs-you', 'failing', 'done', 'idle'])
  )
  expect(registered.worktrees.every((worktree) => worktree.id.length > 0 && worktree.path.startsWith(home))).toBe(true)
  expect(registered.primaryWorktree.repoId).toBe(registered.repo.id)
  registered.cleanup()
  for (const project of prepared.projects) expect(existsSync(project.path)).toBe(false)
})

test('seeds one agent session per non-idle worktree and waits for its status', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const registered = await registerCaptureFixtures(fakeFixtureClient(prepared), prepared, { timeoutMs: 2_000 })
  const hooksBySession = new Map<string, string[]>()
  const sessions = new Map<string, string>()
  const displayOf: Record<string, string> = { UserPromptSubmit: 'working', PermissionRequest: 'waiting', StopFailure: 'failed', Stop: 'done' }
  const client = {
    async callAny(method: string, params: Record<string, unknown> = {}) {
      if (method === 'quirky.terminal/newTab') {
        const session = `session:${sessions.size + 1}`
        sessions.set(session, String(params.workspace))
        return { session, tab: 'tab', pane: 'pane' }
      }
      if (method === 'quirky.agent-status/list') {
        return [...hooksBySession].map(([sessionId, events]) => ({ sessionId, display: displayOf[events.at(-1)!] }))
      }
      return { ok: true }
    }
  }
  const posted: Array<{ url: string; token: string | null }> = []
  const fakeFetch = async (url: string, init: RequestInit) => {
    const session = new URL(url).searchParams.get('session')!
    const event = (JSON.parse(String(init.body)) as { hook_event_name: string }).hook_event_name
    hooksBySession.set(session, [...(hooksBySession.get(session) ?? []), event])
    posted.push({ url, token: new Headers(init.headers).get('x-quirky-hook-token') })
    return { ok: true, status: 200 }
  }

  await seedWorktreeStatuses(client, registered, { port: 4321, hookToken: 'hook-token-value-1234' }, { timeoutMs: 2_000, fetch: fakeFetch })

  const wanted = registered.worktrees.filter((worktree) => worktree.status !== 'idle')
  expect(sessions.size).toBe(wanted.length)
  expect([...hooksBySession.values()].map((events) => displayOf[events.at(-1)!]).sort()).toEqual(['done', 'failed', 'waiting', 'working'])
  expect(posted.every((hook) => hook.url.startsWith('http://127.0.0.1:4321/hook/claude?session=') && hook.token === 'hook-token-value-1234')).toBe(true)
  registered.cleanup()
})

test('a rejected agent hook fails seeding instead of leaving a silent idle dot', async () => {
  const home = freshHome()
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000 })
  const registered = await registerCaptureFixtures(fakeFixtureClient(prepared), prepared, { timeoutMs: 2_000 })
  const client = { async callAny() { return { session: 'session:1' } } }

  await expect(seedWorktreeStatuses(client, registered, { port: 1, hookToken: 'x'.repeat(24) }, {
    timeoutMs: 2_000,
    fetch: async () => ({ ok: false, status: 401 })
  })).rejects.toThrow(/rejected with status 401/)
  registered.cleanup()
})

test('prepares populated Tasks data behind an isolated local gh executable', async () => {
  const home = freshHome()
  const env = createIsolatedRuntimeEnvironment(home)
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000, env })
  try {
    const ghPath = localFixtureGhPath(home, env)
    expect(env.PATH.split(delimiter)[0]).toBe(dirname(ghPath))
    const fixtureDir = env.QUIRKY_TEST_FIXTURE_DIR
    expect(fixtureDir.startsWith(`${home}/`)).toBe(true)
    expect(existsSync(join(fixtureDir, 'state.json'))).toBe(true)
    for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
      expect(env[name]).toBeUndefined()
    }

    const version = runFixtureGh(ghPath, ['--version'], home, env)
    expect(version).toMatch(/^gh version \d/)
    const tokenHelp = runFixtureGh(ghPath, ['auth', 'token', '--help'], home, env)
    expect(tokenHelp).toContain('--user')
    expect(runFixtureGh(ghPath, ['auth', 'token', '--hostname', 'github.com', '--user', 'fixture-user'], home, env).trim())
      .toBe('ui-review-capture-fixture-token')
    expect(runFixtureGh(ghPath, ['auth', 'status', '--hostname', 'github.com'], home, env))
      .toContain('Logged in to github.com account fixture-user (keyring)')

    const { issue, pullRequest } = expectedTasksItems()
    const issueQuery = `repo:${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO} is:issue is:open`
    const issues = JSON.parse(runFixtureGh(ghPath, [
      'api',
      `search/issues?q=${encodeURIComponent(issueQuery)}&sort=created&order=desc&per_page=100&page=1`
    ], home, env)) as { total_count: number; items: Record<string, unknown>[] }
    expect(issues.total_count).toBe(1)
    expect(issues.items).toHaveLength(1)
    expect(issues.items[0]).toMatchObject({
      number: issue.number,
      title: issue.title,
      state: 'OPEN',
      html_url: issue.url,
      updated_at: issue.updatedAt,
      user: { login: issue.author },
      labels: issue.labels.map((name) => ({ name })),
      assignees: issue.assignees.map((login) => ({ login }))
    })

    const pullRequestQuery = `repo:${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO} is:pr is:open`
    const pullRequests = JSON.parse(runFixtureGh(ghPath, [
      'pr', 'list', '--limit', '100', '--state', 'all',
      '--json', 'number,title,url,state,isDraft,headRefName,reviewDecision,reviewRequests,reviews,additions,deletions,changedFiles',
      '--repo', `${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}`, '--search', pullRequestQuery
    ], home, env)) as Record<string, unknown>[]
    expect(pullRequests).toHaveLength(1)
    expect(pullRequests[0]).toMatchObject({
      number: pullRequest.number,
      title: pullRequest.title,
      url: pullRequest.url,
      state: 'OPEN',
      isDraft: false,
      headRefName: pullRequest.headRefName,
      reviewDecision: pullRequest.reviewDecision,
      reviewRequests: [{ login: 'reviewer-one' }],
      reviews: [{ author: { login: 'reviewer-two' }, state: 'APPROVED' }],
      additions: pullRequest.additions,
      deletions: pullRequest.deletions,
      changedFiles: pullRequest.changedFiles
    })

    const checks = JSON.parse(runFixtureGh(ghPath, [
      'api', 'graphql',
      '-f', 'query=query HostingChecksRollup { repository { pullRequest { headRefOid } } }',
      '-F', `owner=${TASKS_FIXTURE_OWNER}`,
      '-F', `name=${TASKS_FIXTURE_REPO}`,
      '-F', `number=${pullRequest.number}`
    ], home, env))
    expect(checks.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes)
      .toMatchObject([{ name: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS' }])

    const origins = prepared.projects.map((project) => gitOrigin(project.path, env))
    expect(origins).toEqual([TASKS_FIXTURE_ORIGIN, null, null])
    const sshPath = join(home, 'fakebin', 'ssh-deny')
    const sshConfig = Bun.spawnSync(['git', '-C', prepared.repoPath, 'config', '--get', 'core.sshCommand'], { env })
    expect(sshConfig.exitCode).toBe(0)
    expect(sshConfig.stdout.toString()).toContain(sshPath)
    expect(existsSync(sshPath)).toBe(true)
    expect(Bun.spawnSync([sshPath, '-T', 'git@github.com'], { env, stdin: 'ignore' }).exitCode).toBe(1)
  } finally {
    prepared.cleanup()
  }
})

test('isolated provider logins write disposable credentials and guard the host Keychain', async () => {
  const home = freshHome()
  const env = createIsolatedRuntimeEnvironment(home)
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000, env })
  try {
    const bin = join(home, 'fakebin')
    const browserLog = join(home, 'browser-url')
    const browser = join(bin, 'fixture-browser')
    writeFileSync(browser, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(browserLog)}, process.argv[2])\n`, { mode: 0o700 })
    const providerEnv = { ...env, CLAUDE_CONFIG_DIR: join(home, 'claude-login'), CODEX_HOME: join(home, 'codex-login'), BROWSER: browser }
    for (const [provider, version] of [['claude', 'Claude Code 2.1.80\n'], ['codex', 'codex 1.0.0\n']]) {
      const executable = join(bin, provider!)
      for (const flag of ['--version', '-v']) {
        const result = Bun.spawnSync([executable, flag], { env: providerEnv })
        expect(result.exitCode).toBe(0)
        expect(result.stdout.toString()).toBe(version!)
      }
      expect(Bun.spawnSync([executable, 'login'], { env: providerEnv }).exitCode).toBe(0)
    }
    expect(JSON.parse(readFileSync(join(providerEnv.CLAUDE_CONFIG_DIR, '.claude.json'), 'utf8')))
      .toEqual({ oauthAccount: { emailAddress: 'claude@example.test', organizationUuid: 'fixture-org', organizationName: 'Fixture Org' } })
    const claudeCredentials = join(providerEnv.CLAUDE_CONFIG_DIR, '.credentials.json')
    expect(JSON.parse(readFileSync(claudeCredentials, 'utf8')).claudeAiOauth.accessToken).toBe('fixture-claude-token')
    expect(statSync(claudeCredentials).mode & 0o777).toBe(0o600)
    expect(readFileSync(browserLog, 'utf8')).toContain('https://claude.ai/oauth/authorize?client_id=fixture')
    const codexCredentials = join(providerEnv.CODEX_HOME, 'auth.json')
    const auth = JSON.parse(readFileSync(codexCredentials, 'utf8'))
    expect(auth.auth_mode).toBe('chatgpt')
    expect(auth.tokens.account_id).toBe('fixture-workspace')
    expect(JSON.parse(Buffer.from(auth.tokens.id_token.split('.')[1], 'base64url').toString()).email).toBe('codex@example.test')
    expect(statSync(codexCredentials).mode & 0o777).toBe(0o600)
    for (const action of ['find-generic-password', 'delete-generic-password']) {
      expect(Bun.spawnSync([join(bin, 'security'), action], { env }).exitCode).toBe(44)
    }
    expect(Bun.spawnSync([join(bin, 'security'), 'other'], { env }).exitCode).toBe(2)
  } finally {
    prepared.cleanup()
  }
})

test('primary fixture tracks a divergent local bare origin with ahead and behind commits', async () => {
  const home = freshHome()
  const env = createIsolatedRuntimeEnvironment(home)
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000, env })
  try {
    expect(gitOrigin(prepared.repoPath, env)).toBe(TASKS_FIXTURE_ORIGIN)
    expect(runFixtureGit(prepared.repoPath, ['remote', 'get-url', '--all', 'origin'], env)).toBe(TASKS_FIXTURE_ORIGIN)
    expect(existsSync(join(home, 'origin.git', 'HEAD'))).toBe(true)
    expect(runFixtureGit(prepared.repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], env))
      .toBe('origin/main')

    const [ahead, behind] = runFixtureGit(prepared.repoPath, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], env)
      .split(/\s+/u).map(Number)
    expect(ahead).toBeGreaterThanOrEqual(1)
    expect(behind).toBeGreaterThanOrEqual(1)
    expect(runFixtureGit(prepared.repoPath, ['ls-remote', 'origin', 'refs/heads/main'], env))
      .toMatch(/\trefs\/heads\/main$/u)
  } finally {
    prepared.cleanup()
  }
})

test('fake gh answers the Reviews routes and delegates other commands to the Tasks fixture', async () => {
  const home = freshHome()
  const env = createIsolatedRuntimeEnvironment(home)
  const prepared = await prepareCaptureFixtureHome(home, { timeoutMs: 10_000, env })
  try {
    const gh = localFixtureGhPath(home, env)
    const rateLimit = JSON.parse(runFixtureGh(gh, ['api', 'rate_limit'], home, env))
    expect(rateLimit.resources).toEqual({
      core: { limit: 5000, remaining: 4200, reset: 1999999999 },
      search: { limit: 30, remaining: 28, reset: 1999999999 },
      graphql: { limit: 5000, remaining: 4000, reset: 1999999999 }
    })

    expect(JSON.parse(runFixtureGh(gh, ['api', '--hostname=github.com', 'rate_limit'], home, env)))
      .toEqual(rateLimit)
    expect(JSON.parse(runFixtureGh(gh, [
      'api',
      '--hostname', 'github.com',
      `repos/${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}/pulls?head=fixture-owner:ui-review-ready&state=all&per_page=100`,
      '-X', 'GET'
    ], home, env))).toEqual([])

    for (const head of ['fixture-owner:ui-review-ready', 'fixture-owner:main']) {
      expect(JSON.parse(runFixtureGh(gh, [
        'api',
        `repos/${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}/pulls?head=${head}&state=all&per_page=100`,
        '-X', 'GET'
      ], home, env))).toEqual([])
    }

    runFixtureGit(prepared.repoPath, ['branch', CHECKS_FIXTURE_BRANCH], env)
    const checksHeadSha = runFixtureGit(prepared.repoPath, ['rev-parse', `refs/heads/${CHECKS_FIXTURE_BRANCH}`], env)
    const checksBaseSha = runFixtureGit(prepared.repoPath, ['rev-parse', 'refs/remotes/origin/main'], env)
    expect(checksHeadSha).toMatch(/^[a-f0-9]{40}$/u)
    expect(checksBaseSha).toMatch(/^[a-f0-9]{40}$/u)
    expect(runFixtureGit(prepared.repoPath, ['rev-parse', `refs/heads/${CHECKS_FIXTURE_BRANCH}`], env)).toBe(checksHeadSha)
    const checksPull = JSON.parse(runFixtureGh(gh, [
      'api',
      '--hostname', 'github.com',
      `repos/${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}/pulls?head=fixture-owner:${CHECKS_FIXTURE_BRANCH}&state=all&per_page=100`,
      '-X', 'GET'
    ], home, env))
    expect(checksPull).toMatchObject([{
      number: 33,
      state: 'open',
      head: {
        ref: CHECKS_FIXTURE_BRANCH,
        sha: checksHeadSha,
        repo: { name: TASKS_FIXTURE_REPO, owner: { login: TASKS_FIXTURE_OWNER } }
      },
      base: { ref: 'main', sha: checksBaseSha }
    }])

    const review = JSON.parse(runFixtureGh(gh, [
      'pr', 'view', '33', '--repo', `${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}`,
      '--json', 'number,title,state,url,headRefName,baseRefName,headRefOid,statusCheckRollup'
    ], home, env))
    expect(review).toMatchObject({
      number: 33,
      state: 'OPEN',
      headRefName: CHECKS_FIXTURE_BRANCH,
      baseRefName: 'main',
      headRefOid: checksHeadSha,
      statusCheckRollup: [
        { name: 'CI / unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'CI / lint', status: 'COMPLETED', conclusion: 'FAILURE' }
      ]
    })
    expect(JSON.parse(runFixtureGh(gh, [
      'pr', 'checks', '33', '--json', 'name,state,link', '--repo', `${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}`
    ], home, env))).toEqual([
      { name: 'CI / unit', state: 'SUCCESS', link: expect.any(String) },
      { name: 'CI / lint', state: 'FAILURE', link: expect.any(String) }
    ])

    const restReview = JSON.parse(runFixtureGh(gh, [
      'api', '--hostname', 'github.com',
      `repos/${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}/pulls/33`, '-X', 'GET'
    ], home, env))
    expect(restReview).toMatchObject({
      number: 33,
      state: 'open',
      head: { ref: CHECKS_FIXTURE_BRANCH, sha: checksHeadSha },
      base: { ref: 'main', sha: checksBaseSha }
    })

    const rollup = JSON.parse(await runFixtureGhWithInput(gh, [
      'api', '--hostname', 'github.com', 'graphql', '-X', 'POST', '--input', '-'
    ], home, env, JSON.stringify({
      query: 'query HostingChecksRollup { repository { pullRequest { headRefOid } } }',
      variables: { owner: TASKS_FIXTURE_OWNER, name: TASKS_FIXTURE_REPO, number: 33 }
    })))
    expect(rollup.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.nodes)
      .toMatchObject([
        { name: 'CI / unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'CI / lint', status: 'COMPLETED', conclusion: 'FAILURE' }
      ])
    expect(JSON.parse(runFixtureGh(gh, [
      'api',
      `repos/${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO}/pulls?head=fixture-owner:feature/capture-fixture-tasks&state=all&per_page=100`,
      '-X', 'GET'
    ], home, env))).toEqual([{
      number: 32,
      state: 'open',
      head: {
        ref: 'feature/capture-fixture-tasks',
        repo: { name: TASKS_FIXTURE_REPO, owner: { login: TASKS_FIXTURE_OWNER } }
      }
    }])
    expect(JSON.parse(runFixtureGh(gh, ['repo', 'view', '--json', 'defaultBranchRef'], home, env)))
      .toEqual({ defaultBranchRef: { name: 'main' } })

    const query = `repo:${TASKS_FIXTURE_OWNER}/${TASKS_FIXTURE_REPO} is:issue is:open`
    const delegated = JSON.parse(runFixtureGh(gh, [
      'api', `search/issues?q=${encodeURIComponent(query)}&sort=created&order=desc&per_page=100&page=1`
    ], home, env))
    expect(delegated.total_count).toBe(1)
    expect(delegated.items[0].number).toBe(31)
  } finally {
    prepared.cleanup()
  }
})

test('provider environment is pinned to fixture executables and the private worker bridge', () => {
  const home = freshHome()
  const env = createIsolatedRuntimeEnvironment(home, { repoRoot: '/repo/fixture' })

  expect(env.QUIRKY_AGENT_SEARCH_DIRS).toBe(join(home, 'fakebin'))
  expect(env.WORKER_TEST_CLI).toBe(join('/repo/fixture', 'packages/cli/src/main.ts'))
  expect(env.WORKER_TEST_CLI).toBe(env.QUIRKY_CLI_ENTRY)

  const withoutRepo = createIsolatedRuntimeEnvironment(home)
  expect(withoutRepo.QUIRKY_AGENT_SEARCH_DIRS).toBe(join(home, 'fakebin'))
  expect(withoutRepo.WORKER_TEST_CLI).toBeUndefined()
})

test('fixture login shell resolves local Codex without reading a hostile profile', async () => {
  const home = freshHome()
  const env = createIsolatedRuntimeEnvironment(home)
  prepareProviderExecutables(home)
  const profileMarker = join(home, 'profile-was-loaded')
  writeFileSync(join(home, '.profile'), `touch '${profileMarker}'\nPATH=/usr/bin:/bin\nexport PATH\n`)
  const processRunner = createProcessRunner({ owner: 'ui-review-fixture-login-shell-test' })
  const runner: ProcessRunner = {
    run: (argv, options) => processRunner.run(argv, { ...(options ?? {}), env })
  }
  try {
    expect(env.SHELL).toBe(join(home, 'fakebin', 'sh'))
    expect(env.PATH.split(delimiter)[0]).toBe(join(home, 'fakebin'))
    expect(await resolveCodexThroughLoginShell(runner, env.SHELL)).toBe(join(home, 'fakebin', 'codex'))
    expect(existsSync(profileMarker)).toBe(false)
  } finally {
    await processRunner.dispose()
  }
})

test('codex forwards app-server to the native fixture executable', async () => {
  const home = freshHome()
  prepareProviderExecutables(home)
  const env = { ...createIsolatedRuntimeEnvironment(home), CODEX_HOME: join(home, 'codex') }
  const codex = join(home, 'fakebin', 'codex')
  const child = Bun.spawn([codex, 'app-server'], {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const stdout = new Response(child.stdout).text()
  const stderr = new Response(child.stderr).text()
  try {
    child.stdin.write('{"id":1,"method":"initialize","params":{}}\n')
    child.stdin.end()
    const result = await Promise.race([
      Promise.all([child.exited, stdout, stderr]),
      Bun.sleep(5_000).then(() => { throw new Error('codex app-server fixture exceeded 5000ms') })
    ])
    expect(result[0]).toBe(0)
    expect(JSON.parse(result[1])).toEqual({
      id: 1,
      result: { userAgent: 'codex-fixture', platformFamily: 'unix', platformOs: 'macos' }
    })
    expect(result[2]).toBe('')
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(500).then(() => false)])
      if (!stopped) {
        child.kill('SIGKILL')
        await Promise.race([child.exited, Bun.sleep(500)])
      }
    }
  }
})

test('claude launches the acceptance agent only with both private bridge variables set', async () => {
  const home = freshHome()
  prepareProviderExecutables(home)
  const cli = join(home, 'fixture-cli.ts')
  writeFileSync(cli, "process.stdout.write(JSON.stringify({ ok: true }))\n")
  const session = 'provider-fixture-session'
  const child = Bun.spawn([join(home, 'fakebin', 'claude')], {
    env: {
      ...createIsolatedRuntimeEnvironment(home),
      QUIRKY_SESSION_ID: session,
      WORKER_TEST_CLI: cli
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const stdout = new Response(child.stdout).text()
  try {
    const root = join(home, 'worker-fixture')
    const eventsPath = join(root, `${session}.events.jsonl`)
    const requestsPath = join(root, `${session}.requests.jsonl`)
    const readyDeadline = Date.now() + 5_000
    while (!existsSync(eventsPath) && Date.now() < readyDeadline) await Bun.sleep(25)
    expect(existsSync(eventsPath)).toBe(true)
    expect(readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line).type))
      .toContain('started')

    appendFileSync(requestsPath, `${JSON.stringify({ id: 'fixture-request-1', args: ['probe'] })}\n`)
    const replyPath = join(root, 'fixture-request-1.reply.json')
    const replyDeadline = Date.now() + 5_000
    while (!existsSync(replyPath) && Date.now() < replyDeadline) await Bun.sleep(25)
    expect(existsSync(replyPath)).toBe(true)
    expect(JSON.parse(readFileSync(replyPath, 'utf8'))).toMatchObject({
      code: 0,
      stdout: '{"ok":true}',
      stderr: ''
    })
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(500).then(() => false)])
      if (!stopped) {
        child.kill('SIGKILL')
        await Promise.race([child.exited, Bun.sleep(500)])
      }
    }
  }
  const output = await stdout
  expect(output.startsWith('\x1b[?2004h')).toBe(true)
  expect(output).toContain('● Ready.')
})

test('claude stays silent and alive without the private worker CLI', async () => {
  const home = freshHome()
  prepareProviderExecutables(home)
  const env: Record<string, string> = { ...createIsolatedRuntimeEnvironment(home), QUIRKY_SESSION_ID: 'idle-provider-session' }
  delete env.WORKER_TEST_CLI
  const child = Bun.spawn([join(home, 'fakebin', 'claude')], {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const reader = child.stdout.getReader()
  const firstOutput = reader.read()
  try {
    const activity = await Promise.race([
      firstOutput.then(() => 'output'),
      Bun.sleep(500).then(() => 'quiet')
    ])
    expect(activity).toBe('quiet')
    expect(child.exitCode).toBeNull()
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      const stopped = await Promise.race([child.exited.then(() => true), Bun.sleep(500).then(() => false)])
      if (!stopped) {
        child.kill('SIGKILL')
        await Promise.race([child.exited, Bun.sleep(500)])
      }
    }
    await firstOutput
  }
})

test('transcript fixture records four turns on a titled shell session', async () => {
  const home = freshHome()
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const fixtures = {
    home,
    primaryWorktree: { id: 'worktree:primary', path: join(home, 'projects', 'primary') }
  } as RegisteredCaptureFixtures
  const client: FixtureRpcClient = {
    async callAny(method, params = {}) {
      calls.push({ method, params })
      if (method === 'quirky.terminal/newTab') return { session: 'session:transcript', tab: 'tab:transcript', pane: 'pane:transcript' }
      return { ok: true }
    }
  }

  const transcript = await createTranscriptFixture(client, fixtures, { timeoutMs: 1_000 })
  const contents = readFileSync(transcript.transcriptPath, 'utf8')
  const rows = contents.trimEnd().split('\n').map((line) => JSON.parse(line))

  expect(transcript).toEqual({
    sessionId: 'session:transcript',
    transcriptPath: join(home, 'transcripts', 'ui-review-transcript.jsonl')
  })
  expect(rows).toHaveLength(4)
  expect(rows.map((row) => row.type)).toEqual(['user', 'assistant', 'user', 'assistant'])
  expect(contents).toContain('Summarize the fixture change.')
  expect(contents).toContain('All provider and GitHub activity stays inside this fixture.')
  expect(calls).toEqual([
    {
      method: 'quirky.terminal/newTab',
      params: {
        workspace: fixtures.primaryWorktree.id,
        cwd: fixtures.primaryWorktree.path,
        agent: 'shell',
        title: 'UI Review Transcript',
        activate: true
      }
    },
    {
      method: 'quirky.session/setProviderSession',
      params: {
        session: transcript.sessionId,
        id: 'ui-review-transcript',
        transcriptPath: transcript.transcriptPath
      }
    }
  ])
})

const askFixtureRow = (askId: string, overrides: Record<string, unknown> = {}) => ({
  id: askId,
  spec: approvalSpec(ASK_CARD_FIXTURE_COMMAND),
  sessionId: null,
  worktreeId: null,
  envelope: { status: 'pending', askId, answers: {}, skipped: [], summary: '' },
  queued: false,
  ...overrides
})

test('terminal fixture acquisition uses the requested worktree and hands off ownership', async () => {
  const worktree = { id: 'worktree:checks', path: '/fixture/checks' }
  const fixtures = {
    primaryWorktree: { id: 'worktree:primary', path: '/fixture/primary' }
  } as RegisteredCaptureFixtures
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const order: string[] = []
  let acquired: unknown
  const client: FixtureRpcClient = {
    async callAny(method, params = {}) {
      calls.push({ method, params })
      return { session: 'session:checks', tab: 'tab:checks', pane: 'pane:checks' }
    }
  }

  const terminal = await createCaptureTerminalFixture(client, fixtures, { timeoutMs: 1_000 }, 'UI Review Checks', {
    worktree,
    onAcquired: (fixture) => {
      acquired = fixture
      order.push('acquired')
    }
  })
  order.push('returned')

  expect(acquired).toEqual(terminal)
  expect(order).toEqual(['acquired', 'returned'])
  expect(calls).toEqual([{
    method: 'quirky.terminal/newTab',
    params: {
      workspace: worktree.id,
      cwd: worktree.path,
      agent: 'shell',
      title: 'UI Review Checks',
      activate: true
    }
  }])
})

test('terminal readiness waits for a supported shell state and marker output exactly once', async () => {
  const terminal = { sessionId: 'session:owned', tabId: 'tab:owned', paneId: 'pane:owned' }
  for (const shellState of ['ready', 'unsupported'] as const) {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    let snapshots = 0
    let historiesAfterWrite = 0
    let writes = 0
    const client: FixtureRpcClient = {
      async callAny(method, params = {}) {
        calls.push({ method, params })
        if (method === 'quirky.terminal/snapshot') {
          snapshots += 1
          return { shellState: snapshots === 1 ? 'pending' : shellState, ansi: '' }
        }
        if (method === 'quirky.terminal/history') {
          if (writes > 0) historiesAfterWrite += 1
          return { lines: historiesAfterWrite >= 2 ? ['UI review terminal ready'] : [] }
        }
        if (method === 'quirky.terminal/write') {
          writes += 1
          return { ok: true }
        }
        throw new Error(`unexpected ${method}`)
      }
    }

    await prepareCaptureTerminalFixture(client, terminal, { timeoutMs: 1_000 })

    const writeCalls = calls.filter((call) => call.method === 'quirky.terminal/write')
    expect(writes).toBe(1)
    expect(writeCalls).toHaveLength(1)
    expect(String(writeCalls[0]?.params.data).match(/UI review terminal ready/g)).toHaveLength(1)
    expect(historiesAfterWrite).toBeGreaterThanOrEqual(2)
  }
})

test('terminal readiness surfaces RPC errors and times out while the shell never becomes ready', async () => {
  const terminal = { sessionId: 'session:owned', tabId: 'tab:owned', paneId: 'pane:owned' }
  const rpcFailure: FixtureRpcClient = {
    async callAny(method) {
      if (method === 'quirky.terminal/snapshot') throw new Error('snapshot transport failed')
      throw new Error(`unexpected ${method}`)
    }
  }
  await expect(prepareCaptureTerminalFixture(rpcFailure, terminal, { timeoutMs: 100 }))
    .rejects.toThrow('snapshot transport failed')

  let wrote = false
  const neverReady: FixtureRpcClient = {
    async callAny(method) {
      if (method === 'quirky.terminal/snapshot') return { shellState: 'pending', ansi: '' }
      if (method === 'quirky.terminal/write') {
        wrote = true
        return { ok: true }
      }
      if (method === 'quirky.terminal/history') return { lines: [] }
      throw new Error(`unexpected ${method}`)
    }
  }
  await expect(prepareCaptureTerminalFixture(neverReady, terminal, { timeoutMs: 40 }))
    .rejects.toThrow()
  expect(wrote).toBe(false)
})

test('terminal readiness aborts promptly and an acquired terminal is still closed after preparation failure', async () => {
  const fixtures = {
    primaryWorktree: { id: 'worktree:primary', path: '/fixture/primary' }
  } as RegisteredCaptureFixtures
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const controller = new AbortController()
  const snapshotStarted = Promise.withResolvers<void>()
  const snapshotReply = Promise.withResolvers<unknown>()
  const client: FixtureRpcClient = {
    callAny(method, params = {}) {
      calls.push({ method, params })
      if (method === 'quirky.terminal/newTab') {
        return Promise.resolve({ session: 'session:owned', tab: 'tab:owned', pane: 'pane:owned' })
      }
      if (method === 'quirky.terminal/snapshot') {
        snapshotStarted.resolve()
        return snapshotReply.promise
      }
      if (method === 'quirky.terminal/closeTab') return Promise.resolve({ ok: true })
      throw new Error(`unexpected ${method}`)
    }
  }
  let acquired: { sessionId: string; tabId: string; paneId: string } | undefined
  const terminal = await createCaptureTerminalFixture(client, fixtures, { timeoutMs: 1_000 }, 'Owned terminal', {
    onAcquired: (fixture) => { acquired = fixture }
  })
  const preparing = prepareCaptureTerminalFixture(client, terminal, { timeoutMs: 1_000, signal: controller.signal })
  await snapshotStarted.promise
  controller.abort(new Error('fixture preparation aborted'))
  await expect(preparing).rejects.toThrow('fixture preparation aborted')
  snapshotReply.resolve({ shellState: 'pending', ansi: '' })
  await closeCaptureTerminalFixture(client, acquired!, { timeoutMs: 1_000 })
  expect(acquired).toEqual(terminal)
  expect(calls.at(-1)).toEqual({
    method: 'quirky.terminal/closeTab',
    params: { tab: terminal.tabId, yes: true }
  })
})

test('terminal readiness rejects unrelated history and an echoed marker command without its output', async () => {
  const terminal = { sessionId: 'session:owned', tabId: 'tab:owned', paneId: 'pane:owned' }
  for (const lines of [['an unrelated prompt'], ["printf '\\nUI review terminal ready\\n'"]]) {
    let writes = 0
    const client: FixtureRpcClient = {
      async callAny(method) {
        if (method === 'quirky.terminal/snapshot') return { shellState: 'ready' }
        if (method === 'quirky.terminal/write') { writes += 1; return { ok: true } }
        if (method === 'quirky.terminal/history') return { lines }
        throw new Error(`unexpected ${method}`)
      }
    }
    await expect(prepareCaptureTerminalFixture(client, terminal, { timeoutMs: 40 })).rejects.toThrow()
    expect(writes).toBe(1)
  }
})

test('terminal readiness finds the marker on the live screen before it reaches scrollback', async () => {
  const terminal = { sessionId: 'session:owned', tabId: 'tab:owned', paneId: 'pane:owned' }
  const screen = new Screen({ cols: 80, rows: 24 })
  let writes = 0
  const client: FixtureRpcClient = {
    async callAny(method) {
      if (method === 'quirky.terminal/snapshot') return { ...screen.snapshot(), shellState: 'ready' }
      if (method === 'quirky.terminal/history') return { lines: [] }
      if (method === 'quirky.terminal/write') {
        writes += 1
        screen.write('\r\n\x1b[32mUI review terminal ready\x1b[0m\r\n')
        await screen.settled()
        return { ok: true }
      }
      throw new Error(`unexpected ${method}`)
    }
  }
  try {
    await prepareCaptureTerminalFixture(client, terminal, { timeoutMs: 250 })
    expect(writes).toBe(1)
  } finally {
    screen.dispose()
  }
})

test('terminal acquisition retains late IDs after abort so the owner can close that tab', async () => {
  const fixtures = { primaryWorktree: { id: 'worktree:primary', path: '/fixture/primary' } } as RegisteredCaptureFixtures
  const controller = new AbortController()
  const reply = Promise.withResolvers<unknown>()
  const acquired = Promise.withResolvers<{ sessionId: string; tabId: string; paneId: string }>()
  const closed: string[] = []
  const client: FixtureRpcClient = {
    callAny(method, params = {}) {
      if (method === 'quirky.terminal/newTab') return reply.promise
      if (method === 'quirky.terminal/closeTab') { closed.push(String(params.tab)); return Promise.resolve({ ok: true }) }
      throw new Error(`unexpected ${method}`)
    }
  }
  const creating = createCaptureTerminalFixture(client, fixtures, { timeoutMs: 1_000, signal: controller.signal }, 'Late shell', {
    onAcquired: acquired.resolve
  })
  controller.abort(new Error('caller stopped'))
  await expect(creating).rejects.toThrow('caller stopped')
  reply.resolve({ session: 'session:late', tab: 'tab:late', pane: 'pane:late' })
  await closeCaptureTerminalFixture(client, await acquired.promise, { timeoutMs: 1_000 })
  expect(closed).toEqual(['tab:late'])
})

test('an already aborted Ask caller acquires nothing while cancellation ignores a caller abort', async () => {
  const controller = new AbortController()
  controller.abort(new Error('caller stopped'))
  const calls: string[] = []
  const owned: unknown[] = []
  const client: FixtureRpcClient = {
    async callAny(method) {
      calls.push(method)
      if (method === 'quirky.ask/cancel') return { status: 'declined' }
      if (method === 'quirky.ask/list') return [askFixtureRow('ask:owned', { envelope: { status: 'declined' } })]
      throw new Error(`unexpected ${method}`)
    }
  }
  await expect(createAskCardFixture(client, { timeoutMs: 100, signal: controller.signal }, (fixture) => owned.push(fixture)))
    .rejects.toThrow('caller stopped')
  expect(owned).toEqual([])
  expect(calls).toEqual([])
  await closeAskCardFixture(client, { askId: 'ask:owned', command: ASK_CARD_FIXTURE_COMMAND }, { timeoutMs: 100, signal: controller.signal })
  expect(calls).toEqual(['quirky.ask/cancel', 'quirky.ask/list'])
})

test('Ask-card fixture creates one unscoped approval and transfers ownership before read-back', async () => {
  const askId = 'ask:fixture'
  const calls: Array<{ method: string; params: Record<string, unknown>; options?: { timeoutMs?: number } }> = []
  const order: string[] = []
  let owned: unknown
  const client: FixtureRpcClient = {
    async callAny(method, params = {}, options) {
      calls.push({ method, params, options })
      if (method === 'quirky.ask/create') {
        order.push('create')
        return { askId }
      }
      if (method === 'quirky.ask/list') {
        order.push('read-back')
        return [askFixtureRow(askId)]
      }
      throw new Error(`unexpected ${method}`)
    }
  }

  const fixture = await createAskCardFixture(client, { timeoutMs: 500 }, (value) => {
    owned = value
    order.push('owned')
  })

  expect(fixture).toEqual({ askId, command: 'Bash: bun run build' })
  expect(owned).toEqual(fixture)
  expect(order).toEqual(['create', 'owned', 'read-back'])
  expect(calls).toEqual([
    {
      method: 'quirky.ask/create',
      params: { spec: approvalSpec('Bash: bun run build') },
      options: { timeoutMs: 500 }
    },
    {
      method: 'quirky.ask/list',
      params: { pendingOnly: false, askId },
      options: { timeoutMs: 500 }
    }
  ])
})

test('Ask-card acquisition rejects missing identities and invalid or scoped read-back rows', async () => {
  const askId = 'ask:fixture'
  const cases: Array<{ name: string; create?: unknown; rows?: unknown }> = [
    { name: 'missing ask ID', create: {} },
    { name: 'malformed ask ID', create: { askId: '' } },
    { name: 'missing read-back row', rows: [] },
    { name: 'non-pending envelope', rows: [askFixtureRow(askId, { envelope: { status: 'answered', askId } })] },
    { name: 'queued row', rows: [askFixtureRow(askId, { queued: true })] },
    { name: 'session-scoped row', rows: [askFixtureRow(askId, { sessionId: 'session:other' })] },
    { name: 'worktree-scoped row', rows: [askFixtureRow(askId, { worktreeId: 'worktree:other' })] },
    { name: 'mismatched spec', rows: [askFixtureRow(askId, { spec: approvalSpec('Bash: bun test') })] },
    { name: 'wrong ask identity', rows: [askFixtureRow('ask:other')] }
  ]

  for (const scenario of cases) {
    const client: FixtureRpcClient = {
      async callAny(method) {
        if (method === 'quirky.ask/create') return scenario.create ?? { askId }
        if (method === 'quirky.ask/list') return scenario.rows ?? [askFixtureRow(askId)]
        throw new Error(`unexpected ${method}`)
      }
    }
    const owned: unknown[] = []
    await expect(createAskCardFixture(client, { timeoutMs: 200 }, (fixture) => owned.push(fixture)))
      .rejects.toThrow()
    expect(owned.length, scenario.name).toBe(scenario.name.includes('ask ID') || scenario.name.includes('malformed') ? 0 : 1)
  }
})

test('Ask-card read-back errors and aborts preserve the acquired ID', async () => {
  const askId = 'ask:fixture'
  let readbackStarted = false
  const client: FixtureRpcClient = {
    async callAny(method) {
      if (method === 'quirky.ask/create') return { askId }
      if (method === 'quirky.ask/list') {
        readbackStarted = true
        throw new Error('read-back unavailable')
      }
      throw new Error(`unexpected ${method}`)
    }
  }
  const owned: unknown[] = []
  await expect(createAskCardFixture(client, { timeoutMs: 200 }, (fixture) => owned.push(fixture)))
    .rejects.toThrow('read-back unavailable')
  expect(readbackStarted).toBe(true)
  expect(owned).toEqual([{ askId, command: ASK_CARD_FIXTURE_COMMAND }])

  const controller = new AbortController()
  const listStarted = Promise.withResolvers<void>()
  const listReply = Promise.withResolvers<unknown>()
  const blockedReadback: FixtureRpcClient = {
    callAny(method) {
      if (method === 'quirky.ask/create') return Promise.resolve({ askId })
      if (method === 'quirky.ask/list') {
        listStarted.resolve()
        return listReply.promise
      }
      throw new Error(`unexpected ${method}`)
    }
  }
  const abortOwned: unknown[] = []
  const acquiring = createAskCardFixture(blockedReadback, { timeoutMs: 1_000, signal: controller.signal }, (fixture) => abortOwned.push(fixture))
  await listStarted.promise
  controller.abort(new Error('Ask fixture aborted'))
  await expect(acquiring).rejects.toThrow('Ask fixture aborted')
  expect(abortOwned).toEqual([{ askId, command: ASK_CARD_FIXTURE_COMMAND }])
  listReply.resolve([askFixtureRow(askId)])
})

test('Ask-card fixture reports a create identity that arrives after caller abort', async () => {
  const askId = 'ask:late'
  const controller = new AbortController()
  const createStarted = Promise.withResolvers<void>()
  const createReply = Promise.withResolvers<unknown>()
  const calls: string[] = []
  const client: FixtureRpcClient = {
    callAny(method) {
      calls.push(method)
      if (method === 'quirky.ask/create') {
        createStarted.resolve()
        return createReply.promise
      }
      throw new Error(`unexpected ${method}`)
    }
  }
  const owned: unknown[] = []
  const wasOwned = Promise.withResolvers<void>()
  const acquiring = createAskCardFixture(client, { timeoutMs: 1_000, signal: controller.signal }, (fixture) => {
    owned.push(fixture)
    wasOwned.resolve()
  })
  await createStarted.promise
  controller.abort(new Error('Ask fixture aborted'))
  await expect(acquiring).rejects.toThrow('Ask fixture aborted')
  createReply.resolve({ askId })
  await wasOwned.promise

  expect(owned).toEqual([{ askId, command: ASK_CARD_FIXTURE_COMMAND }])
  expect(calls).toEqual(['quirky.ask/create'])
})

test('Ask-card cancellation verifies its durable non-pending row', async () => {
  const fixture = { askId: 'ask:fixture', command: ASK_CARD_FIXTURE_COMMAND }
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const client: FixtureRpcClient = {
    async callAny(method, params = {}) {
      calls.push({ method, params })
      if (method === 'quirky.ask/cancel') return { status: 'declined', askId: fixture.askId }
      if (method === 'quirky.ask/list') return [askFixtureRow(fixture.askId, { envelope: { status: 'declined', askId: fixture.askId } })]
      throw new Error(`unexpected ${method}`)
    }
  }

  await closeAskCardFixture(client, fixture, { timeoutMs: 200 })

  expect(calls).toEqual([
    { method: 'quirky.ask/cancel', params: { askId: fixture.askId } },
    { method: 'quirky.ask/list', params: { pendingOnly: false, askId: fixture.askId } }
  ])
})

test('Ask-card cancellation rejects pending outcomes and cancellation or read-back errors', async () => {
  const fixture = { askId: 'ask:fixture', command: ASK_CARD_FIXTURE_COMMAND }
  const pendingRow = askFixtureRow(fixture.askId)
  const cases: Array<{ name: string; cancel?: unknown; rows?: unknown; failAt?: string }> = [
    { name: 'cancel reply is pending', cancel: pendingRow.envelope, rows: [pendingRow] },
    { name: 'durable row remains pending', cancel: { status: 'declined' }, rows: [pendingRow] },
    { name: 'cancel RPC fails', failAt: 'quirky.ask/cancel' },
    { name: 'read-back RPC fails', cancel: { status: 'declined' }, failAt: 'quirky.ask/list' },
    { name: 'durable row is missing', cancel: { status: 'declined' }, rows: [] }
  ]

  for (const scenario of cases) {
    const client: FixtureRpcClient = {
      async callAny(method) {
        if (method === scenario.failAt) throw new Error(`${scenario.name} failure`)
        if (method === 'quirky.ask/cancel') return scenario.cancel ?? { status: 'declined', askId: fixture.askId }
        if (method === 'quirky.ask/list') return scenario.rows ?? [askFixtureRow(fixture.askId, { envelope: { status: 'declined', askId: fixture.askId } })]
        throw new Error(`unexpected ${method}`)
      }
    }
    await expect(closeAskCardFixture(client, fixture, { timeoutMs: 200 })).rejects.toThrow()
  }
})

test('terminal fixtures honor titles and close their own tab with confirmation', async () => {
  const home = freshHome()
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const fixtures = {
    primaryWorktree: { id: 'worktree:primary', path: join(home, 'projects', 'primary') }
  } as RegisteredCaptureFixtures
  const client: FixtureRpcClient = {
    async callAny(method, params = {}) {
      calls.push({ method, params })
      return { session: 'session:cell', tab: 'tab:cell', pane: 'pane:cell' }
    }
  }

  const terminal = await createCaptureTerminalFixture(client, fixtures, { timeoutMs: 1_000 }, 'UI Review Handoff')
  await closeCaptureTerminalFixture(client, terminal, { timeoutMs: 1_000 })

  expect(calls).toEqual([
    {
      method: 'quirky.terminal/newTab',
      params: {
        workspace: fixtures.primaryWorktree.id,
        cwd: fixtures.primaryWorktree.path,
        agent: 'shell',
        title: 'UI Review Handoff',
        activate: true
      }
    },
    { method: 'quirky.terminal/closeTab', params: { tab: terminal.tabId, yes: true } }
  ])
})

test('loop fixture enables Codex, creates one iteration, and polls to the cap pause', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  let polls = 0
  const fixtures = { primaryWorktree: { id: 'worktree:primary' } } as RegisteredCaptureFixtures
  const client: FixtureRpcClient = {
    async callAny(method, params = {}) {
      calls.push({ method, params })
      if (method === 'quirky.loops/create') return { id: 'loop:fixture' }
      if (method === 'quirky.loops/get') {
        polls += 1
        return polls === 1
          ? { id: 'loop:fixture', state: 'running', iterationsCompleted: 0 }
          : { id: 'loop:fixture', state: 'paused', pauseReason: 'cap-iterations', iterationsCompleted: 1 }
      }
      return { ok: true }
    }
  }

  await expect(createLoopFixture(client, fixtures, { timeoutMs: 1_000 })).resolves.toEqual({ loopId: 'loop:fixture' })

  expect(calls.slice(0, 3)).toEqual([
    { method: 'quirky.agents/refresh', params: {} },
    { method: 'quirky.agents/setEnabled', params: { agent: 'codex', enabled: true } },
    {
      method: 'quirky.loops/create',
      params: {
        worktreeId: fixtures.primaryWorktree.id,
        name: 'UI review loop',
        agent: 'codex',
        config: {
          promptSource: { kind: 'repeat', body: 'Summarize the fixture change in one sentence.' },
          pacing: { kind: 'on-idle' },
          sessionPolicy: 'fresh',
          done: {},
          caps: { maxIterations: 1 },
          noProgress: false,
          checkpointCommits: false,
          askBeforeNext: false,
          resumeAtLimitReset: false
        }
      }
    }
  ])
  expect(polls).toBe(2)
})

test('loop fixture stops a failed loop and reports the refused step', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const fixtures = { primaryWorktree: { id: 'worktree:primary' } } as RegisteredCaptureFixtures
  const client: FixtureRpcClient = {
    async callAny(method, params = {}) {
      calls.push({ method, params })
      if (method === 'quirky.loops/create') return { id: 'loop:fixture' }
      if (method === 'quirky.loops/get') throw new Error('snapshot unavailable')
      return { ok: true }
    }
  }

  await expect(createLoopFixture(client, fixtures, { timeoutMs: 1_000 }))
    .rejects.toThrow('loop fixture quirky.loops/get: snapshot unavailable')
  expect(calls.at(-1)).toEqual({
    method: 'quirky.loops/stop',
    params: { loopId: 'loop:fixture', mode: 'now' }
  })
})

test('loop fixture times out with its last snapshot and stops the loop', async () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const fixtures = { primaryWorktree: { id: 'worktree:primary' } } as RegisteredCaptureFixtures
  const client: FixtureRpcClient = {
    async callAny(method, params = {}) {
      calls.push({ method, params })
      if (method === 'quirky.loops/create') return { id: 'loop:fixture' }
      if (method === 'quirky.loops/get') return { id: 'loop:fixture', state: 'running', iterationsCompleted: 0 }
      return { ok: true }
    }
  }

  await expect(createLoopFixture(client, fixtures, { timeoutMs: 40 }))
    .rejects.toThrow(/loop fixture quirky\.loops\/get: timed out after 40ms; last snapshot .*"state":"running"/)
  expect(calls.at(-1)).toEqual({
    method: 'quirky.loops/stop',
    params: { loopId: 'loop:fixture', mode: 'now' }
  })
})
