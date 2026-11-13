import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RegisteredCaptureFixtures } from '../ui-review/fixtures'
import { prepareSpeedFixture } from './fixtures.ts'
import { createFloodChunk, writeWorkerOutput } from './worker.ts'
import { startWorld } from '../soak/world.ts'

const liveSessions = Array.from({ length: 20 }, (_, index) => `session-${index + 1}`)

test('builds ten two-pane worktrees, a committed empty diff, and isolated raw workers', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'quirky-speed-fixture-'))
  const repoPath = join(fixtureRoot, 'project')
  mkdirSync(repoPath, { recursive: true })
  const env = { ...process.env, QUIRKY_HOME: fixtureRoot, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  await git(['init', '--initial-branch=main', repoPath], fixtureRoot, env)
  await git(['-C', repoPath, 'config', 'user.name', 'Speed Fixture'], fixtureRoot, env)
  await git(['-C', repoPath, 'config', 'user.email', 'speed-fixture@localhost'], fixtureRoot, env)
  writeFileSync(join(repoPath, 'README.md'), 'fixture\n')
  await git(['-C', repoPath, 'add', '--all'], fixtureRoot, env)
  await git(['-C', repoPath, 'commit', '-m', 'Seed speed fixture'], fixtureRoot, env)

  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const initialWorktrees = Array.from({ length: 7 }, (_, index) => ({
    id: `worktree-${index + 1}`,
    path: index === 0 ? repoPath : join(fixtureRoot, `worktree-${index + 1}`),
    repoId: 'fixture-repo',
    name: `worktree-${index + 1}`,
    isMain: index === 0,
    status: 'idle' as const
  }))
  const fixtures = {
    home: fixtureRoot,
    repoPath,
    projects: [{ name: 'fixture', path: repoPath }],
    worktreesRoot: join(fixtureRoot, 'worktrees'),
    files: {},
    tasks: {},
    cleanup() {},
    repo: { id: 'fixture-repo' },
    primaryWorktree: { id: 'worktree-1', path: repoPath, repoId: 'fixture-repo', name: 'worktree-1' },
    worktrees: initialWorktrees
  } as RegisteredCaptureFixtures
  const workerBySession = new Map<string, string>()
  const summaryBySession = new Map<string, string>()
  const stoppedBySession = new Map<string, string>()
  const pendingSummaryBySession = new Map<string, string>()
  const runIdBySession = new Map<string, string>()
  let sessionCounter = 0
  let extraCounter = 0
  const world = {
    home: fixtureRoot,
    env,
    fixtures,
    preserved: [] as string[],
    preserveSessions(ids: string[]) { this.preserved = ids },
    control: {
      async callAny(method: string, params: Record<string, unknown> = {}) {
        calls.push({ method, params })
        if (method === 'quirky.worktree/create') {
          extraCounter++
          const path = join(fixtureRoot, `extra-${extraCounter}`)
          mkdirSync(path)
          return { worktree: { id: `extra-${extraCounter}`, path, name: `extra-${extraCounter}` } }
        }
        if (method === 'quirky.terminal/newTab' || method === 'quirky.terminal/splitPane') {
          sessionCounter++
          const session = `speed-session-${sessionCounter}`
          const workerId = String(params.command ?? '').split(' ').at(-1)?.replaceAll("'", '')
            ?? String(params.title ?? '').split(' ').at(-1)!
          workerBySession.set(session, workerId)
          return method.endsWith('newTab')
            ? { session, tab: `tab-${sessionCounter}`, pane: `pane-${sessionCounter}` }
            : { session, pane: `pane-${sessionCounter}` }
        }
        if (method === 'quirky.terminal/write') {
          const data = String(params.data ?? '')
          const session = String(params.session ?? '')
          if (data.startsWith('\u001e')) {
            const command = JSON.parse(data.slice(1).trim()) as { op: string; runId?: string }
            const workerId = workerBySession.get(session)!
            if (command.op === 'flood-start') runIdBySession.set(session, command.runId!)
            if (command.op === 'flood-stop') {
              const runId = command.runId ?? runIdBySession.get(session)!
              pendingSummaryBySession.set(session, `SPEED_FLOOD_SUMMARY:${workerId}:${session}:${runId}:1:2:131072:32`)
            }
            if (command.op === 'shutdown') stoppedBySession.set(session, `SPEED_STOPPED ${workerId} ${session}`)
          }
          return { ok: true }
        }
        if (method === 'quirky.terminal/read') {
          const session = String(params.session ?? '')
          const pending = pendingSummaryBySession.get(session)
          const marker = stoppedBySession.get(session) ?? summaryBySession.get(session) ?? `SPEED_READY ${workerBySession.get(session)} ${session}`
          if (pending) {
            pendingSummaryBySession.delete(session)
            summaryBySession.set(session, pending)
            return { lines: [marker], cols: 120, rows: 40, alt: false }
          }
          return { lines: [marker], cols: 120, rows: 40, alt: false }
        }
        if (method === 'quirky.git/diff') {
          return { path: 'speed-diff.txt', source: 'unstaged', staged: false, original: '', modified: speedLines(), binary: false, kind: 'text' }
        }
        return { ok: true }
      }
    }
  }

  try {
    const fixture = await prepareSpeedFixture(world as never)
    expect(fixture.worktrees).toHaveLength(10)
    expect(fixture.worktrees.every(({ sessions, tabId }) => sessions.length === 2 && tabId.length > 0)).toBe(true)
    expect(fixture.target).toBe(fixture.worktrees[0])
    expect(fixture.diffPath).toBe('speed-diff.txt')
    expect(fixture.firstLine).toBe('speed fixture line 0001')
    expect(world.preserved).toHaveLength(20)
    expect(new Set(world.preserved)).toEqual(new Set(fixture.worktrees.flatMap(({ sessions }) => sessions)))
    expect(calls.filter(({ method }) => method === 'quirky.worktree/create')).toHaveLength(3)
    expect(calls.filter(({ method }) => method === 'quirky.terminal/newTab')).toHaveLength(10)
    expect(calls.filter(({ method }) => method === 'quirky.terminal/splitPane')).toHaveLength(10)
    const extraWorktrees = calls.filter(({ method }) => method === 'quirky.worktree/create')
    expect(extraWorktrees.every(({ params }) => params.setup === 'skip' && params.noParent === true && params.activate === false)).toBe(true)
    const workerCommands = calls.filter(({ method }) => method === 'quirky.terminal/newTab' || method === 'quirky.terminal/splitPane')
    expect(workerCommands).toHaveLength(20)
    expect(workerCommands.every(({ params }) => String(params.command).includes('/scripts/speed/worker.ts'))).toBe(true)
    expect(calls).toContainEqual({
      method: 'setting.set',
      params: { id: 'setting:quirky.terminal/gpu-acceleration', value: 'off' }
    })
    expect(calls).toContainEqual({ method: 'quirky.worktree/setOptions', params: { filterRepoIds: [] } })

    expect(await git(['-C', repoPath, 'diff', '--numstat', '--', fixture.diffPath], fixtureRoot, env))
      .toBe('5000\t0\tspeed-diff.txt')
    const publicDiff = calls.find(({ method }) => method === 'quirky.git/diff')
    expect(publicDiff?.params).toEqual({ worktree: fixture.target.id, path: fixture.diffPath, source: 'unstaged' })

    const flood = await fixture.startFlood()
    expect(flood).toMatchObject({ workerId: fixture.target.workerIds[1], sessionId: fixture.target.sessions[1], offeredBytesPerChunk: 65536, intervalMs: 16, offeredBytesPerSecond: 4_096_000 })
    expect(flood.runId.length).toBeGreaterThan(0)
    const stats = await fixture.stopFlood()
    expect(stats).toMatchObject({ workerId: flood.workerId, sessionId: flood.sessionId, runId: flood.runId, offeredBytesPerChunk: 65536, intervalMs: 16, offeredBytesPerSecond: 4_096_000 })
    expect(flood.offeredBytesPerSecond).toBe(4_096_000)
    expect(stats.bytesWritten).toBeGreaterThanOrEqual(0)
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(stats.firstCounter).toBeLessThanOrEqual(stats.lastCounter)
    const nextFlood = await fixture.startFlood()
    expect(nextFlood.runId).not.toBe(flood.runId)
    const nextStats = await fixture.stopFlood()
    expect(nextStats.runId).toBe(nextFlood.runId)
    await fixture.stop()
    expect(calls.filter(({ method }) => method === 'quirky.terminal/write')
      .every(({ params }) => String(params.data).startsWith('\u001e'))).toBe(true)
    await fixture.stop()
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('stops workers already opened when fixture setup fails partway', async () => {
  const { world, calls, cleanup } = fakeFixtureWorld({ failOnSplitAt: 2 })
  try {
    await expect(prepareSpeedFixture(world as never)).rejects.toThrow('splitPane failed')
    const shutdowns = calls.filter(({ method, params }) => method === 'quirky.terminal/write'
      && String(params.data).includes('"op":"shutdown"'))
    expect(shutdowns.length).toBeGreaterThan(0)
  } finally {
    cleanup()
  }
})

test('encodes flood counters in an exact 65,536-byte output chunk', () => {
  const chunk = createFloodChunk('worker-a', 'session-a', 42)
  const text = new TextDecoder().decode(chunk)

  expect(chunk.byteLength).toBe(65_536)
  expect(text.includes('SPEED_FLOOD worker-a session-a 42 65536\r\n')).toBe(true)
  expect(text.endsWith('\r\n')).toBe(true)
})

test('does not offer a subsequent output chunk before stdout drain', async () => {
  let writes = 0
  let drain: (() => void) | undefined
  const output = {
    write() {
      writes++
      return writes > 1
    },
    once(event: string, listener: () => void) {
      expect(event).toBe('drain')
      drain = listener
      return this
    }
  }

  let settled = false
  const pending = (async () => {
    await writeWorkerOutput(output, new Uint8Array([65]))
    await writeWorkerOutput(output, new Uint8Array([66]))
    settled = true
  })()
  await Promise.resolve()
  expect(writes).toBe(1)
  expect(settled).toBe(false)
  drain?.()
  await pending
  expect(settled).toBe(true)
  expect(writes).toBe(2)
})

test('keeps the seven default soak workers and suppresses them only when requested', async () => {
  const suppressed = fakeWorldHarness()
  try {
    const world = await suppressed.start({ workers: false })
    expect(world.workers).toEqual([])
    expect(suppressed.newTabCount()).toBe(0)
    await world.stop()
  } finally {
    suppressed.cleanup()
  }

  const defaults = fakeWorldHarness()
  try {
    const world = await defaults.start({})
    expect(world.workers).toHaveLength(7)
    expect(defaults.newTabCount()).toBe(7)
    await world.stop()
  } finally {
    defaults.cleanup()
  }
})

test('does not spawn a replacement daemon when owned shutdown fails', async () => {
  const harness = fakeWorldHarness({ shutdownFails: true })
  try {
    const world = await harness.start({ workers: false })
    world.preserveSessions(liveSessions)

    await expect(world.restartDaemon()).rejects.toThrow('shutdown failed')
    expect(harness.spawnedCount()).toBe(1)
    await world.stop()
    expect(harness.cleanupCount()).toBe(1)
  } finally {
    harness.cleanup()
  }
})

test('keeps stop usable after a replacement daemon fails to connect', async () => {
  const harness = fakeWorldHarness({ failConnectionAt: 2 })
  try {
    const world = await harness.start({ workers: false })
    world.preserveSessions(liveSessions)

    await expect(world.restartDaemon()).rejects.toThrow('connection failed')
    expect(harness.spawnedCount()).toBe(2)
    await world.stop()
    await world.stop()
    expect(harness.cleanupCount()).toBe(1)
  } finally {
    harness.cleanup()
  }
})

test('refreshes daemon identity while keeping the registered PTY sessions alive', async () => {
  const harness = fakeWorldHarness()
  try {
    const world = await harness.start({ workers: false })
    world.preserveSessions(liveSessions)
    const originalPid = world.daemonPid

    const restart = await world.restartDaemon()

    expect(restart.spawnedAt).toBeGreaterThanOrEqual(0)
    expect(world.daemonPid).not.toBe(originalPid)
    expect(world.runtime.pid).toBe(world.daemonPid)
    expect(world.ptyHostPid()).toBe(501)
    expect(harness.liveSessionChecks()).toBe(2)
    await world.stop()
  } finally {
    harness.cleanup()
  }
})

function fakeFixtureWorld(options: { failOnSplitAt?: number } = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'quirky-speed-fixture-failure-'))
  const repoPath = join(fixtureRoot, 'repo')
  mkdirSync(repoPath, { recursive: true })
  const env = {
    ...process.env,
    QUIRKY_HOME: fixtureRoot,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0'
  }
  writeFileSync(join(repoPath, 'README.md'), 'fixture\n')
  gitSync(['init', '--initial-branch=main', repoPath], fixtureRoot, env)
  gitSync(['-C', repoPath, 'config', 'user.name', 'Speed Fixture'], fixtureRoot, env)
  gitSync(['-C', repoPath, 'config', 'user.email', 'speed-fixture@localhost'], fixtureRoot, env)
  gitSync(['-C', repoPath, 'add', '--all'], fixtureRoot, env)
  gitSync(['-C', repoPath, 'commit', '-m', 'Seed speed fixture'], fixtureRoot, env)
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const worktrees = Array.from({ length: 7 }, (_, index) => ({
    id: `worktree-${index + 1}`,
    path: index === 0 ? repoPath : join(fixtureRoot, `worktree-${index + 1}`),
    repoId: 'fixture-repo',
    name: `worktree-${index + 1}`,
    isMain: index === 0,
    status: 'idle' as const
  }))
  const fixtures = {
    home: fixtureRoot,
    repoPath,
    projects: [],
    worktreesRoot: join(fixtureRoot, 'worktrees'),
    files: {},
    tasks: {},
    cleanup() {},
    repo: { id: 'fixture-repo' },
    primaryWorktree: { id: worktrees[0]!.id, path: repoPath, repoId: 'fixture-repo', name: worktrees[0]!.name },
    worktrees
  } as RegisteredCaptureFixtures
  let extraCounter = 0
  let sessions = 0
  let splitCalls = 0
  const workerBySession = new Map<string, string>()
  const stoppedBySession = new Map<string, string>()
  const world = {
    home: fixtureRoot,
    env,
    fixtures,
    preserveSessions() {},
    control: {
      async callAny(method: string, params: Record<string, unknown> = {}) {
        calls.push({ method, params })
        if (method === 'quirky.worktree/create') {
          extraCounter++
          const path = join(fixtureRoot, `extra-${extraCounter}`)
          mkdirSync(path)
          return { worktree: { id: `extra-${extraCounter}`, path, name: `extra-${extraCounter}` } }
        }
        if (method === 'quirky.terminal/splitPane') {
          splitCalls++
          if (splitCalls === options.failOnSplitAt) throw new Error('splitPane failed')
        }
        if (method === 'quirky.terminal/newTab' || method === 'quirky.terminal/splitPane') {
          sessions++
          const workerId = String(params.command ?? '').split(' ').at(-1)?.replaceAll("'", '') ?? `worker-${sessions}`
          const session = `session-${sessions}`
          workerBySession.set(session, workerId)
          return method.endsWith('newTab')
            ? { session, tab: `tab-${sessions}`, pane: `pane-${sessions}` }
            : { session, pane: `pane-${sessions}` }
        }
        if (method === 'quirky.terminal/write') {
          const data = String(params.data ?? '')
          const session = String(params.session ?? '')
          if (data.startsWith('\u001e')) {
            const command = JSON.parse(data.slice(1).trim()) as { op: string }
            if (command.op === 'shutdown') stoppedBySession.set(session, `SPEED_STOPPED ${workerBySession.get(session)} ${session}`)
          }
          return { ok: true }
        }
        if (method === 'quirky.terminal/read') {
          const session = String(params.session ?? '')
          return { lines: [stoppedBySession.get(session) ?? `SPEED_READY ${workerBySession.get(session)} ${session}`] }
        }
        if (method === 'quirky.git/diff') {
          return { path: 'speed-diff.txt', source: 'unstaged', staged: false, original: '', modified: speedLines(), binary: false, kind: 'text' }
        }
        return { ok: true }
      }
    }
  }
  return { world, calls, cleanup: () => rmSync(fixtureRoot, { recursive: true, force: true }) }
}
function fakeWorldHarness(options: { shutdownFails?: boolean; failConnectionAt?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'quirky-speed-world-'))
  const processes: Array<{ pid: number; exited: Promise<number>; kill(signal?: string | number): void }> = []
  const spawnedCommands: string[][] = []
  let cleanupCount = 0
  let connections = 0
  let liveSessionChecks = 0
  let newTabs = 0
  let trackedPids = 0

  const scope = {
    home,
    spawn(command: string[]) {
      spawnedCommands.push(command)
      let resolveExit!: (code: number) => void
      const exited = new Promise<number>((resolve) => { resolveExit = resolve })
      const child = {
        pid: 100 + processes.length,
        exited,
        kill() {
          if (!options.shutdownFails) resolveExit(0)
        }
      }
      processes.push(child)
      return child
    },
    track() { trackedPids++ },
    async cleanup() { cleanupCount++ }
  }
  const captureWorktrees = Array.from({ length: 7 }, (_, index) => ({
    id: `soak-worktree-${index + 1}`,
    path: join(home, `worktree-${index + 1}`),
    repoId: 'soak-repo',
    name: `worktree-${index + 1}`,
    isMain: index === 0,
    status: 'idle' as const
  }))
  const captureFixtures = {
    home,
    repoPath: join(home, 'project'),
    projects: [{ name: 'fixture', path: join(home, 'project') }],
    worktreesRoot: join(home, 'worktrees'),
    files: {},
    tasks: {},
    cleanup() {},
    repo: { id: 'soak-repo' },
    primaryWorktree: { id: captureWorktrees[0]!.id, path: captureWorktrees[0]!.path, repoId: 'soak-repo', name: 'worktree-1' },
    worktrees: captureWorktrees
  }
  const prepared = {
    home,
    repoPath: join(home, 'project'),
    projects: [{ name: 'fixture', path: join(home, 'project') }],
    worktreesRoot: join(home, 'worktrees'),
    files: {},
    tasks: {},
    cleanup() {}
  }
  const dependencies = {
    createScope: () => scope,
    prepareCaptureFixtureHome: async () => prepared,
    registerCaptureFixtures: async () => captureFixtures,
    waitForDaemon: async (_home: string, process: { pid: number }) => ({
      pid: process.pid,
      port: 4000 + process.pid,
      token: 'fixture-token',
      hookToken: 'fixture-hook-token',
      daemonVersion: 'test',
      protocolVersion: 1,
      startedAt: Date.now()
    }),
    waitForShutdown: async (process: { exited: Promise<number> }) => {
      if (options.shutdownFails) throw new Error('shutdown failed')
      await process.exited
    },
    connectDaemon: async () => {
      connections++
      if (connections === options.failConnectionAt) throw new Error('connection failed')
      return {
        async callAny(method: string) {
          if (method === 'status.get') return { home, ptyHost: { pid: 501 } }
          if (method === 'quirky.terminal/sessions') {
            liveSessionChecks++
            return { sessions: liveSessions.map((sessionId) => ({ sessionId, alive: true })) }
          }
          if (method === 'quirky.terminal/newTab') {
            newTabs++
            return { session: `soak-worker-${newTabs}` }
          }
          return {}
        },
        close() {}
      }
    }
  }

  return {
    start: (worldOptions: { workers?: boolean }) => startWorld({
      out: join(home, 'out'),
      repoRoot: home,
      ...worldOptions
    }, dependencies as never),
    spawnedCount: () => spawnedCommands.length,
    cleanupCount: () => cleanupCount,
    liveSessionChecks: () => liveSessionChecks,
    newTabCount: () => newTabs,
    trackedPids: () => trackedPids,
    cleanup: () => rmSync(home, { recursive: true, force: true })
  }
}


function speedLines(): string {
  return `${Array.from({ length: 5000 }, (_, index) => `speed fixture line ${String(index + 1).padStart(4, '0')}`).join('\n')}\n`
}

function gitSync(args: string[], cwd: string, env: Record<string, string>): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr).trim()}`)
}

async function git(args: string[], cwd: string, env: Record<string, string>): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text()
  ])
  if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`)
  return stdout.trimEnd()
}
