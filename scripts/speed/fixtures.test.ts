import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PreparedCaptureFixtureHome, RegisteredCaptureFixtures } from '../ui-review/fixtures'
import { prepareSpeedFixture, readFloodSleepCapture } from './fixtures.ts'
import { createFloodChunk, writeWorkerOutput, runWorker, publishFloodSleepCapture } from './worker.ts'
import { startWorld } from '../soak/world.ts'
import { fixtureIssue, fixturePullRequest } from '../../plugins/quirky.tasks/test/fixtures/list'

const liveSessions = Array.from({ length: 20 }, (_, index) => `session-${index + 1}`)
const fixtureTasks: PreparedCaptureFixtureHome['tasks'] = {
  owner: 'fixture-owner',
  repo: 'fixture-repo',
  originUrl: 'https://github.com/fixture-owner/fixture-repo.git',
  issue: fixtureIssue('fixture-owner', 'fixture-repo', 1, '2026-11-01T00:00:00Z'),
  pullRequest: fixturePullRequest('fixture-owner', 'fixture-repo', 2, '2026-11-02T00:00:00Z'),
  sshCommand: '/bin/false'
}

function fixtureFiles(root: string): PreparedCaptureFixtureHome['files'] {
  return {
    source: join(root, 'src/app.ts'),
    markdown: join(root, 'docs/review-notes.md'),
    notebook: join(root, 'notebooks/summary.ipynb'),
    svg: join(root, 'assets/fixture-diagram.svg'),
    csv: join(root, 'data/metrics.csv')
  }
}

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
  const fixtures: RegisteredCaptureFixtures = {
    home: fixtureRoot,
    repoPath,
    projects: [{ name: 'fixture', path: repoPath }],
    worktreesRoot: join(fixtureRoot, 'worktrees'),
    files: fixtureFiles(repoPath),
    tasks: fixtureTasks,
    cleanup() {},
    repo: { id: 'fixture-repo' },
    primaryWorktree: { id: 'worktree-1', path: repoPath, repoId: 'fixture-repo', name: 'worktree-1' },
    worktrees: initialWorktrees
  }
  const workerBySession = new Map<string, string>()
  const summaryBySession = new Map<string, string>()
  const stoppedBySession = new Set<string>()
  const pendingSummaryBySession = new Map<string, string>()
  const runIdBySession = new Map<string, string>()
  let sessionCounter = 0
  let extraCounter = 0
  let initialControlClosed = false
  let replacementControlCalls = 0
  const handleRpc = async (method: string, params: Record<string, unknown> = {}) => {
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
      const workerId = String(params.command ?? '').match(/worker\.ts' '([^']+)'/)?.[1]!
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
          writeFileSync(join(fixtureRoot, `speed-sleep-${workerId}.json`), JSON.stringify({
            version: 1, workerId, sessionId: session, runId, status: 'complete', reason: null, intervals: []
          }))
        }
        if (command.op === 'shutdown') stoppedBySession.add(session)
      }
      return { ok: true }
    }
    if (method === 'quirky.terminal/read') {
      const session = String(params.session ?? '')
      if (stoppedBySession.has(session)) throw new Error(`no such session: ${session}`)
      const pending = pendingSummaryBySession.get(session)
      const marker = summaryBySession.get(session) ?? `SPEED_READY ${workerBySession.get(session)} ${session}`
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
  const initialControl = {
    async callAny(method: string, params: Record<string, unknown> = {}) {
      if (initialControlClosed) throw new Error('the original control connection is closed')
      return handleRpc(method, params)
    },
    close() {
      initialControlClosed = true
    }
  }
  const world = {
    home: fixtureRoot,
    env,
    fixtures,
    preserved: [] as string[],
    preserveSessions(ids: string[]) { this.preserved = ids },
    control: initialControl
  }
  const controller = new AbortController()

  try {
    const fixture = await prepareSpeedFixture(world as never, { signal: controller.signal })
    const originalControl = world.control
    originalControl.close()
    world.control = {
      async callAny(method: string, params: Record<string, unknown> = {}) {
        replacementControlCalls++
        return handleRpc(method, params)
      },
      close() {}
    }
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
    expect(workerCommands.every(({ params }) => !String(params.command).includes('--echo-delay-ms'))).toBe(true)
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
    expect(stats.sleepTiming).toMatchObject({ status: 'complete', runId: flood.runId, intervals: [] })
    expect(flood.offeredBytesPerSecond).toBe(4_096_000)
    expect(stats.bytesWritten).toBeGreaterThanOrEqual(0)
    expect(stats.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(stats.firstCounter).toBeLessThanOrEqual(stats.lastCounter)
    const nextFlood = await fixture.startFlood()
    expect(nextFlood.runId).not.toBe(flood.runId)
    controller.abort(new Error('cancelled setup'))
    const nextStats = await fixture.stopFlood()
    expect(nextStats.runId).toBe(nextFlood.runId)
    expect(replacementControlCalls).toBeGreaterThan(0)
    await fixture.stop()
    const workerControls = calls.filter(({ method }) => method === 'quirky.terminal/write')
      .map(({ params }) => JSON.parse(String(params.data).slice(1).trim()) as { op: string })
    expect(workerControls.filter(({ op }) => op === 'flood-stop')).toHaveLength(2)
    expect(workerControls.filter(({ op }) => op === 'shutdown')).toHaveLength(20)
    expect(calls.filter(({ method }) => method === 'quirky.terminal/write')
      .every(({ params }) => String(params.data).startsWith('\u001e'))).toBe(true)
    await fixture.stop()
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true })
  }
})

test('passes the requested echo delay to both speed worker commands', async () => {
  const harness = fakeFixtureWorld()
  try {
    const fixture = await prepareSpeedFixture(harness.world as never, { echoDelayMs: 1500 })
    const workerCommands = harness.calls.filter(({ method }) => method === 'quirky.terminal/newTab' || method === 'quirky.terminal/splitPane')

    expect(workerCommands).toHaveLength(20)
    expect(workerCommands.slice(0, 2).map(({ method }) => method)).toEqual(['quirky.terminal/newTab', 'quirky.terminal/splitPane'])
    expect(workerCommands.slice(0, 2).every(({ params }) => String(params.command).replaceAll("'", '').includes('--echo-delay-ms 1500'))).toBe(true)
    expect(workerCommands.slice(2).every(({ params }) => !String(params.command).includes('--echo-delay-ms'))).toBe(true)
    await fixture.stop()
  } finally {
    harness.cleanup()
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

async function flushWorker() {
  for (let index = 0; index < 20; index++) await Promise.resolve()
}

async function workerHarness(delay = 0, options: { backpressure?: boolean; failPublish?: boolean } = {}) {
  const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, setEncoding() {}, pause() {} })
  let epoch = 100012
  let drain: (() => void) | undefined
  let sleeping: (() => void) | undefined
  let requestedAt: number | undefined
  let capture: unknown
  const chunks: string[] = []
  await runWorker('w', delay, '/tmp/disposable-timing.json', {
    input, output: {
      write(bytes) {
        const text = Buffer.from(bytes).toString()
        chunks.push(text)
        return !(options.backpressure && text.length === 65536)
      },
      once(_event, listener) { drain = listener }
    },
    now: () => epoch,
    sleep: () => {
      requestedAt = epoch
      const { promise, resolve } = Promise.withResolvers<void>()
      sleeping = resolve
      return promise
    },
    async publish(_path, value) { if (options.failPublish) throw new Error('disk full'); capture = structuredClone(value) }
  })
  const control = async (op: string, extras: Record<string, string> = {}) => {
    input.emit('data', `\u001e${JSON.stringify({ op, ...extras })}\n`)
    await flushWorker()
  }
  await control('bind', { session: 's' })
  return {
    input, chunks, control, capture: () => capture, requestedAt: () => requestedAt,
    setEpoch(value: number) { epoch = value },
    drain() { drain?.() },
    async wake(value: number) { epoch = value; sleeping?.(); await flushWorker() }
  }
}

test('timestamps printable input at read, before a seeded delay, and ignores controls and UTF-8 bytes', async () => {
  for (const delay of [0, 1500]) {
    const worker = await workerHarness(delay)
    worker.input.emit('data', 'a\u0003é')
    await flushWorker()
    if (delay) {
      expect(worker.chunks.join('')).not.toContain('SPEED_ECHO')
      await worker.wake(101512)
    }
    expect(worker.chunks.join('')).toContain('\r\nSPEED_ECHO w s 1 a readEpochMs=100012\r\n')
    expect(worker.chunks.join('').match(/SPEED_ECHO/g)).toHaveLength(1)
    await worker.control('shutdown')
  }
})

test('captures actual flood sleep after drain, publishes before acknowledgement, and resets each run', async () => {
  const worker = await workerHarness(0, { backpressure: true })
  await worker.control('flood-start', { runId: 'r1' })
  expect(worker.requestedAt()).toBeUndefined()
  worker.setEpoch(100052)
  worker.drain()
  await flushWorker()
  expect(worker.requestedAt()).toBe(100052)
  await worker.control('flood-stop', { runId: 'r1' })
  expect(worker.chunks.join('')).not.toContain('SPEED_FLOOD_SUMMARY')
  await worker.wake(100104)
  expect(worker.capture()).toMatchObject({
    version: 1, workerId: 'w', sessionId: 's', runId: 'r1', status: 'complete', reason: null,
    intervals: [{ requestedEpochMs: 100052, dueEpochMs: 100068, wokeEpochMs: 100104, lateMs: 36 }]
  })
  expect(worker.chunks.join('')).toContain('SPEED_FLOOD_SUMMARY:w:s:r1:1:1:65536:92')
  await worker.control('flood-start', { runId: 'r2' })
  worker.drain()
  await flushWorker()
  await worker.control('flood-stop', { runId: 'r2' })
  await worker.wake(100120)
  expect(worker.capture()).toMatchObject({ runId: 'r2', intervals: [{ lateMs: 0 }] })
  await worker.control('shutdown')
})

test('sidecar publication failure does not suppress flood stop acknowledgement', async () => {
  const worker = await workerHarness(0, { failPublish: true })
  await worker.control('flood-start', { runId: 'r' })
  await worker.control('flood-stop', { runId: 'r' })
  await worker.wake(100028)
  expect(worker.chunks.join('')).toContain('SPEED_FLOOD_SUMMARY:w:s:r:')
  expect(worker.chunks.join('')).not.toContain('SPEED_FLOOD_ERROR')
  await worker.control('shutdown')
})

test('bounds flood sidecars and rejects stale, truncated, malformed, oversized and invalid-clock captures', async () => {
  const root = mkdtempSync(join(tmpdir(), 'speed-capture-'))
  const path = join(root, 'timing.json')
  const expected = { workerId: 'w', sessionId: 's', runId: 'r' }
  const interval = { requestedEpochMs: 100008, dueEpochMs: 100024, wokeEpochMs: 100060, lateMs: 36 }
  const capture = { version: 1 as const, ...expected, status: 'complete' as const, reason: null, intervals: [interval] }
  try {
    expect((await readFloodSleepCapture(path, expected)).status).toBe('unavailable')
    await publishFloodSleepCapture(path, capture)
    expect(await readFloodSleepCapture(path, expected)).toEqual(capture)
    for (const value of [
      { ...capture, runId: 'old' }, { ...capture, workerId: 'other' }, { ...capture, sessionId: 'other' },
      { ...capture, intervals: [{ ...interval, lateMs: 35 }] },
      { ...capture, intervals: [{ a: 1, b: 2, c: 3, d: 4 }] },
      { ...capture, intervals: [null] },
      { ...capture, intervals: [{ ...interval, wokeEpochMs: 100020, lateMs: -4 }] },
      { ...capture, intervals: Array(8193).fill(interval) }
    ]) {
      writeFileSync(path, JSON.stringify(value))
      expect((await readFloodSleepCapture(path, expected)).status).toBe('unavailable')
    }
    for (const text of ['{', JSON.stringify(capture).slice(0, -2), ' '.repeat(2 * 1024 * 1024 + 1)]) {
      writeFileSync(path, text)
      expect((await readFloodSleepCapture(path, expected)).status).toBe('unavailable')
    }
    await publishFloodSleepCapture(path, { ...capture, intervals: Array.from({ length: 8192 }, (_, index) => ({
      requestedEpochMs: 100000 + index * 16, dueEpochMs: 100016 + index * 16,
      wokeEpochMs: 100016 + index * 16, lateMs: 0
    })) })
    expect((await readFloodSleepCapture(path, expected)).intervals).toHaveLength(8192)
    await publishFloodSleepCapture(path, { ...capture, runId: 'x'.repeat(2 * 1024 * 1024) })
    expect(Buffer.byteLength(readFileSync(path))).toBeLessThan(2 * 1024 * 1024)
    expect(JSON.parse(readFileSync(path, 'utf8')).status).toBe('unavailable')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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
    let notifications = 0

    await expect(world.restartDaemon(undefined, () => { notifications++ })).rejects.toThrow('shutdown failed')
    expect(notifications).toBe(0)
    expect(harness.spawnedCount()).toBe(1)
    await world.stop()
    expect(harness.cleanupCount()).toBe(1)
  } finally {
    harness.cleanup()
  }
})
test('notifies exactly once for the replacement after ownership and before health waiting', async () => {
  const harness = fakeWorldHarness()
  try {
    const world = await harness.start({ workers: false })
    world.preserveSessions(liveSessions)
    const notifications: Array<{ spawnedAt: number; pid: number }> = []
    expect(notifications).toEqual([])

    const restart = await world.restartDaemon(undefined, (spawn) => {
      notifications.push(spawn)
      harness.recordEvent(`notify:${spawn.pid}`)
      expect(harness.ownedPids()).toContain(spawn.pid)
    })

    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ pid: 101 })
    expect(restart.spawnedAt).toBe(notifications[0]?.spawnedAt)
    expect(harness.events()).toEqual([
      'spawn:100',
      'health:100',
      'shutdown:100',
      'spawn:101',
      'notify:101',
      'health:101'
    ])
    await world.stop()
  } finally {
    harness.cleanup()
  }
})

test('keeps the replacement owned when its spawn callback throws', async () => {
  const harness = fakeWorldHarness()
  try {
    const world = await harness.start({ workers: false })
    world.preserveSessions(liveSessions)

    await expect(world.restartDaemon(undefined, () => {
      throw new Error('spawn observer failed')
    })).rejects.toThrow('spawn observer failed')
    expect(harness.ownedPids()).toContain(101)
    expect(harness.events()).not.toContain('health:101')

    await world.stop()
    expect(harness.killedPids()).toContain(101)
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
  const fixtures: RegisteredCaptureFixtures = {
    home: fixtureRoot,
    repoPath,
    projects: [],
    worktreesRoot: join(fixtureRoot, 'worktrees'),
    files: fixtureFiles(repoPath),
    tasks: fixtureTasks,
    cleanup() {},
    repo: { id: 'fixture-repo' },
    primaryWorktree: { id: worktrees[0]!.id, path: repoPath, repoId: 'fixture-repo', name: worktrees[0]!.name },
    worktrees
  }
  let extraCounter = 0
  let sessions = 0
  let splitCalls = 0
  const workerBySession = new Map<string, string>()
  const stoppedBySession = new Set<string>()
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
          const workerId = String(params.command ?? '').match(/worker\.ts' '([^']+)'/)?.[1] ?? `worker-${sessions}`
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
            if (command.op === 'shutdown') stoppedBySession.add(session)
          }
          return { ok: true }
        }
        if (method === 'quirky.terminal/read') {
          const session = String(params.session ?? '')
          if (stoppedBySession.has(session)) throw new Error(`no such session: ${session}`)
          return { lines: [`SPEED_READY ${workerBySession.get(session)} ${session}`] }
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
  const events: string[] = []
  const killedPids: number[] = []
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
      const pid = 100 + processes.length
      events.push(`spawn:${pid}`)
      const child = {
        pid,
        exited,
        kill() {
          killedPids.push(pid)
          if (!options.shutdownFails) resolveExit(0)
        }
      }
      processes.push(child)
      return child
    },
    track() { trackedPids++ },
    async cleanup() {
      cleanupCount++
      for (const process of processes) process.kill()
    }
  }
  const captureWorktrees = Array.from({ length: 7 }, (_, index) => ({
    id: `soak-worktree-${index + 1}`,
    path: join(home, `worktree-${index + 1}`),
    repoId: 'soak-repo',
    name: `worktree-${index + 1}`,
    isMain: index === 0,
    status: 'idle' as const
  }))
  const captureFixtures: RegisteredCaptureFixtures = {
    home,
    repoPath: join(home, 'project'),
    projects: [{ name: 'fixture', path: join(home, 'project') }],
    worktreesRoot: join(home, 'worktrees'),
    files: fixtureFiles(join(home, 'project')),
    tasks: fixtureTasks,
    cleanup() {},
    repo: { id: 'soak-repo' },
    primaryWorktree: { id: captureWorktrees[0]!.id, path: captureWorktrees[0]!.path, repoId: 'soak-repo', name: 'worktree-1' },
    worktrees: captureWorktrees
  }
  const prepared: PreparedCaptureFixtureHome = {
    home,
    repoPath: join(home, 'project'),
    projects: [{ name: 'fixture', path: join(home, 'project') }],
    worktreesRoot: join(home, 'worktrees'),
    files: fixtureFiles(join(home, 'project')),
    tasks: fixtureTasks,
    cleanup() {}
  }
  const dependencies = {
    createScope: () => scope,
    prepareCaptureFixtureHome: async () => prepared,
    registerCaptureFixtures: async () => captureFixtures,
    waitForDaemon: async (_home: string, process: { pid: number }) => {
      events.push(`health:${process.pid}`)
      return {
        pid: process.pid,
        port: 4000 + process.pid,
        token: 'fixture-token',
        hookToken: 'fixture-hook-token',
        daemonVersion: 'test',
        protocolVersion: 1,
        startedAt: Date.now()
      }
    },
    waitForShutdown: async (process: { pid: number; exited: Promise<number> }) => {
      events.push(`shutdown:${process.pid}`)
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
    ownedPids: () => processes.map((process) => process.pid),
    killedPids: () => [...killedPids],
    events: () => [...events],
    recordEvent: (event: string) => events.push(event),
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

test('worker capture overflow is unavailable, not a truncated complete run', async () => {
  const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, setEncoding() {}, pause() {} })
  let epoch = 100000
  let sleeps = 0
  let capture: unknown
  let stopped = false
  const control = (op: string) => input.emit('data', `\u001e${JSON.stringify({ op, session: 's', runId: 'r' })}\n`)
  await runWorker('w', 0, '/tmp/disposable-capture.json', {
    input, now: () => epoch,
    output: { write(chunk) { if (Buffer.from(chunk).toString().startsWith('\r\nSPEED_FLOOD_SUMMARY:')) stopped = true; return true }, once() {} },
    async sleep() { epoch += 16; if (++sleeps === 8193) control('flood-stop') },
    async publish(_path, value) { capture = value }
  })
  control('bind')
  await flushWorker()
  control('flood-start')
  for (let turn = 0; !stopped && turn < 100000; turn++) await Promise.resolve()
  expect(stopped).toBe(true)
  expect(capture).toMatchObject({ status: 'unavailable', reason: 'sleep-buffer-overflow', intervals: [] })
  control('shutdown')
  await flushWorker()
})
