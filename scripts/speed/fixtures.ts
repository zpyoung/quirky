import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FixtureWorktree, RegisteredCaptureFixtures } from '../ui-review/fixtures'
import type { SoakWorld } from '../soak/world'
import { FLOOD_CHUNK_BYTES, FLOOD_INTERVAL_MS } from './worker.ts'

const WORKTREE_COUNT = 10
const INITIAL_WORKTREE_COUNT = 7
const DIFF_PATH = 'speed-diff.txt'
const DIFF_LINE_COUNT = 5000
const SETUP_TIMEOUT_MS = 30_000
const WORKER_READY_TIMEOUT_MS = 20_000
const FLOOD_STOP_TIMEOUT_MS = 30_000
const CONTROL_PREFIX = '\u001e'
const FLOOD_OFFERED_BYTES_PER_SECOND = 4_096_000 as const

export type SpeedFixtureWorktree = {
  id: string
  path: string
  tabId: string
  sessions: [string, string]
  panes: [string, string]
  workerIds: [string, string]
}

export type FloodStart = {
  workerId: string
  sessionId: string
  runId: string
  offeredBytesPerChunk: 65_536
  intervalMs: 16
  offeredBytesPerSecond: 4_096_000
  startedAt: number
}

export type FloodStats = {
  workerId: string
  sessionId: string
  runId: string
  offeredBytesPerChunk: 65_536
  intervalMs: 16
  offeredBytesPerSecond: 4_096_000
  bytesWritten: number
  firstCounter: number
  lastCounter: number
  elapsedMs: number
}

export type SpeedFixture = {
  worktrees: SpeedFixtureWorktree[]
  target: SpeedFixtureWorktree
  diffPath: typeof DIFF_PATH
  firstLine: string
  startFlood(worktreeId?: string): Promise<FloodStart>
  stopFlood(): Promise<FloodStats>
  stop(): Promise<void>
}

type RpcClient = Pick<SoakWorld['control'], 'callAny'>
type Options = { signal?: AbortSignal; timeoutMs?: number }
type WorkerRecord = { sessionId: string; workerId: string; ready: boolean }
type FloodActive = { sessionId: string; workerId: string; runId: string }

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} did not return an ID`)
  return value
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('speed fixture setup was interrupted')
}

function bounded<T>(task: Promise<T>, timeoutMs: number, signal: AbortSignal | undefined, label: string): Promise<T> {
  checkAbort(signal)
  const { promise, resolve: resolveTask, reject } = Promise.withResolvers<T>()
  let settled = false
  let timer: ReturnType<typeof setTimeout>
  const finish = (error: unknown, value?: T) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (error !== undefined) reject(error)
    else resolveTask(value as T)
  }
  const onAbort = () => finish(signal?.reason instanceof Error ? signal.reason : new Error('speed fixture setup was interrupted'))
  timer = setTimeout(() => finish(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs)
  signal?.addEventListener('abort', onAbort, { once: true })
  task.then((value) => finish(undefined, value), (error) => finish(error))
  return promise
}

async function callRpc(
  client: RpcClient,
  method: string,
  params: Record<string, unknown>,
  options: Required<Pick<Options, 'timeoutMs'>> & Options
): Promise<unknown> {
  checkAbort(options.signal)
  return bounded(
    client.callAny(method, params, { timeoutMs: options.timeoutMs }),
    options.timeoutMs,
    options.signal,
    method
  )
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function controlBytes(op: string, extras: Record<string, unknown> = {}): string {
  return `${CONTROL_PREFIX}${JSON.stringify({ op, ...extras })}\n`
}

function terminalText(value: unknown): string {
  const lines = record(value).lines
  return Array.isArray(lines) ? lines.filter((line): line is string => typeof line === 'string').join('\n') : ''
}

function compactTerminalText(text: string): string {
  return text.replace(/\s+/g, '')
}

async function waitForMarker(
  client: RpcClient,
  sessionId: string,
  marker: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  const expected = compactTerminalText(marker)
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    checkAbort(signal)
    const result = await callRpc(client, 'quirky.terminal/read', { session: sessionId, lines: 20 }, {
      timeoutMs: Math.min(5000, Math.max(1, Math.ceil(deadline - performance.now()))), signal
    })
    if (compactTerminalText(terminalText(result)).includes(expected)) return
    await Bun.sleep(25)
  }
  throw new Error(`worker ${sessionId} did not render its expected acknowledgement`)
}

async function runGit(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  signal?: AbortSignal,
  timeoutMs = SETUP_TIMEOUT_MS
): Promise<string> {
  checkAbort(signal)
  const child = Bun.spawn(['git', ...args], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  const stdoutText = new Response(child.stdout).text()
  const stderrText = new Response(child.stderr).text()
  try {
    const code = await bounded(child.exited, timeoutMs, signal, `git ${args[0] ?? 'command'}`)
    const [stdout, stderr] = await Promise.all([stdoutText, stderrText])
    if (code !== 0) throw new Error(`git ${args[0] ?? 'command'} failed (${code}): ${stderr.trim() || stdout.trim() || 'no details'}`)
    return stdout.trimEnd()
  } catch (error) {
    child.kill('SIGTERM')
    await Promise.race([child.exited, Bun.sleep(250)])
    if (child.exitCode === null) child.kill('SIGKILL')
    await Promise.allSettled([stdoutText, stderrText])
    throw error
  }
}

function lineCount(text: string): number {
  return text === '' ? 0 : text.endsWith('\n') ? text.slice(0, -1).split('\n').length : text.split('\n').length
}

function speedDiffContents(): string {
  return `${Array.from({ length: DIFF_LINE_COUNT }, (_, index) => `speed fixture line ${String(index + 1).padStart(4, '0')}`).join('\n')}\n`
}

function safeError(error: unknown, home: string): Error {
  const message = error instanceof Error ? error.message : String(error)
  return new Error(message.replaceAll(home, '<speed-home>'))
}

/** Extends the disposable soak repositories with the ten-worktree renderer workload. */
export async function prepareSpeedFixture(world: Pick<SoakWorld, 'home' | 'env' | 'fixtures' | 'control' | 'preserveSessions'>, options: Options = {}): Promise<SpeedFixture> {
  const rpc: RpcClient = world.control
  const boundedOptions = { timeoutMs: options.timeoutMs ?? SETUP_TIMEOUT_MS, signal: options.signal }
  const created: SpeedFixtureWorktree[] = []
  const workers: WorkerRecord[] = []
  let activeFlood: FloodActive | undefined
  let stopPromise: Promise<void> | undefined

  const sendControl = async (sessionId: string, op: string, extras: Record<string, unknown> = {}) => {
    await callRpc(rpc, 'quirky.terminal/write', { session: sessionId, data: controlBytes(op, extras) }, boundedOptions)
  }

  const stopFlood = async (): Promise<FloodStats> => {
    const current = activeFlood
    if (!current) throw new Error('the speed flood worker is not running')
    await sendControl(current.sessionId, 'flood-stop', { runId: current.runId })
    const deadline = performance.now() + FLOOD_STOP_TIMEOUT_MS
    const summaryPattern = new RegExp(
      `SPEED_FLOOD_SUMMARY:${escapeRegExp(current.workerId)}:${escapeRegExp(current.sessionId)}:${escapeRegExp(current.runId)}:(\\d+):(\\d+):(\\d+):([\\d.]+)`
    )
    try {
      while (performance.now() < deadline) {
        checkAbort(options.signal)
        const result = await callRpc(rpc, 'quirky.terminal/read', { session: current.sessionId, lines: 30 }, {
          timeoutMs: Math.min(5000, Math.max(1, Math.ceil(deadline - performance.now()))), signal: options.signal
        })
        const text = compactTerminalText(terminalText(result))
        const match = summaryPattern.exec(text)
        if (match) {
          const stats = {
            workerId: current.workerId,
            sessionId: current.sessionId,
            runId: current.runId,
            offeredBytesPerChunk: FLOOD_CHUNK_BYTES,
            intervalMs: FLOOD_INTERVAL_MS,
            offeredBytesPerSecond: FLOOD_OFFERED_BYTES_PER_SECOND,
            firstCounter: Number(match[1]),
            lastCounter: Number(match[2]),
            bytesWritten: Number(match[3]),
            elapsedMs: Number(match[4])
          }
          if (Object.values(stats).some((value) => typeof value === 'number' && !Number.isFinite(value))) {
            throw new Error('the speed flood worker returned invalid statistics')
          }
          activeFlood = undefined
          return stats
        }
        await Bun.sleep(25)
      }
      throw new Error('the speed flood worker did not acknowledge its stop command')
    } catch (error) {
      throw safeError(error, world.home)
    }
  }

  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      const failures: unknown[] = []
      if (activeFlood) {
        try {
          await stopFlood()
        } catch (error) {
          failures.push(error)
        }
      }
      await Promise.all(workers.map(async ({ sessionId, workerId, ready }) => {
        try {
          await sendControl(sessionId, 'shutdown')
          if (ready) await waitForMarker(rpc, sessionId, `SPEED_STOPPED ${workerId} ${sessionId}`, 5000, options.signal)
        } catch (error) {
          failures.push(error)
        }
      }))
      if (failures.length > 0) throw safeError(failures[0], world.home)
    })()
    return stopPromise
  }

  try {
    if (world.fixtures.worktrees.length !== INITIAL_WORKTREE_COUNT) {
      throw new Error(`speed fixtures require the existing ${INITIAL_WORKTREE_COUNT} worktrees`)
    }
    await callRpc(rpc, 'setting.set', { id: 'setting:quirky.terminal/gpu-acceleration', value: 'off' }, boundedOptions)
    await callRpc(rpc, 'quirky.worktree/setOptions', { filterRepoIds: [] }, boundedOptions)

    const worktrees: FixtureWorktree[] = [...world.fixtures.worktrees]
    for (let index = worktrees.length; index < WORKTREE_COUNT; index++) {
      checkAbort(options.signal)
      const name = `speed-fixture-${index + 1}`
      const result = record(await callRpc(rpc, 'quirky.worktree/create', {
        repo: world.fixtures.repo.id,
        name,
        setup: 'skip',
        noParent: true,
        activate: false
      }, boundedOptions))
      const createdWorktree = record(result.worktree)
      const entry: FixtureWorktree = {
        id: requiredString(createdWorktree.id, `worktree ${name}`),
        path: requiredString(createdWorktree.path, `worktree ${name} path`),
        repoId: world.fixtures.repo.id,
        name: typeof createdWorktree.name === 'string' ? createdWorktree.name : name,
        isMain: false,
        status: 'idle'
      }
      if (worktrees.some((existing) => existing.id === entry.id || resolve(existing.path) === resolve(entry.path))) {
        throw new Error(`public worktree creation returned a duplicate for ${name}`)
      }
      worktrees.push(entry)
    }
    if (worktrees.length !== WORKTREE_COUNT) throw new Error(`speed fixture created ${worktrees.length} worktrees instead of ${WORKTREE_COUNT}`)

    const diffPath = join(world.fixtures.primaryWorktree.path, DIFF_PATH)
    mkdirSync(world.fixtures.primaryWorktree.path, { recursive: true })
    writeFileSync(diffPath, '')
    await runGit(['-C', world.fixtures.primaryWorktree.path, 'add', '--', DIFF_PATH], world.home, world.env, options.signal)
    await runGit(['-C', world.fixtures.primaryWorktree.path, 'commit', '--only', '-m', 'Seed empty speed diff fixture', '--', DIFF_PATH], world.home, world.env, options.signal)
    const contents = speedDiffContents()
    writeFileSync(diffPath, contents)
    const numstat = await runGit(['-C', world.fixtures.primaryWorktree.path, 'diff', '--numstat', '--', DIFF_PATH], world.home, world.env, options.signal)
    if (numstat !== `${DIFF_LINE_COUNT}\t0\t${DIFF_PATH}`) {
      throw new Error(`speed diff fixture has unexpected git additions: ${numstat || 'none'}`)
    }
    const firstLine = contents.slice(0, contents.indexOf('\n'))
    const publicDiff = record(await callRpc(rpc, 'quirky.git/diff', {
      worktree: world.fixtures.primaryWorktree.id,
      path: DIFF_PATH,
      source: 'unstaged'
    }, boundedOptions))
    if (publicDiff.kind !== 'text' || publicDiff.binary !== false || publicDiff.tooLarge !== undefined
      || publicDiff.original !== '' || typeof publicDiff.modified !== 'string'
      || publicDiff.modified !== contents || lineCount(publicDiff.modified) !== DIFF_LINE_COUNT) {
      throw new Error('the public git diff did not report all 5,000 speed fixture additions')
    }

    const workerScript = fileURLToPath(new URL('./worker.ts', import.meta.url))
    for (const [index, worktree] of worktrees.entries()) {
      checkAbort(options.signal)
      const workerIds: [string, string] = [randomUUID(), randomUUID()]
      const command = (workerId: string) => `${shellQuote(process.execPath)} ${shellQuote(workerScript)} ${shellQuote(workerId)}`
      const opened = record(await callRpc(rpc, 'quirky.terminal/newTab', {
        workspace: worktree.id,
        cwd: worktree.path,
        agent: 'shell',
        command: command(workerIds[0]),
        title: `speed echo ${index + 1}`,
        activate: false
      }, boundedOptions))
      const echoSession = requiredString(opened.session, 'quirky.terminal/newTab')
      const tabId = requiredString(opened.tab, 'quirky.terminal/newTab tab')
      const echoPane = requiredString(opened.pane, 'quirky.terminal/newTab pane')
      const echoWorker = { sessionId: echoSession, workerId: workerIds[0], ready: false }
      workers.push(echoWorker)

      const split = record(await callRpc(rpc, 'quirky.terminal/splitPane', {
        session: echoSession,
        direction: 'right',
        title: `speed flood ${index + 1}`,
        command: command(workerIds[1]),
        activate: false
      }, boundedOptions))
      const floodSession = requiredString(split.session, 'quirky.terminal/splitPane')
      const floodPane = requiredString(split.pane, 'quirky.terminal/splitPane pane')
      const floodWorker = { sessionId: floodSession, workerId: workerIds[1], ready: false }
      workers.push(floodWorker)
      const fixtureWorktree: SpeedFixtureWorktree = {
        id: worktree.id,
        path: worktree.path,
        tabId,
        sessions: [echoSession, floodSession],
        panes: [echoPane, floodPane],
        workerIds
      }
      created.push(fixtureWorktree)

      for (const worker of [echoWorker, floodWorker]) {
        await sendControl(worker.sessionId, 'bind', { session: worker.sessionId })
        await waitForMarker(rpc, worker.sessionId, `SPEED_READY ${worker.workerId} ${worker.sessionId}`, WORKER_READY_TIMEOUT_MS, options.signal)
        worker.ready = true
      }
    }

    world.preserveSessions(created.flatMap(({ sessions }) => sessions))
    const target = created[0]
    if (!target) throw new Error('speed fixture did not produce a target worktree')

    const fixture: SpeedFixture = {
      worktrees: created,
      target,
      diffPath: DIFF_PATH,
      firstLine,
      async startFlood(worktreeId = target.id) {
        if (activeFlood) throw new Error('a speed flood worker is already running')
        const worktree = created.find((candidate) => candidate.id === worktreeId)
        if (!worktree) throw new Error(`no speed fixture worktree ${worktreeId}`)
        const workerId = worktree.workerIds[1]
        const sessionId = worktree.sessions[1]
        const runId = randomUUID()
        const startedAt = performance.now()
        await sendControl(sessionId, 'flood-start', { runId })
        activeFlood = { workerId, sessionId, runId }
        return {
          workerId,
          sessionId,
          runId,
          offeredBytesPerChunk: FLOOD_CHUNK_BYTES,
          intervalMs: FLOOD_INTERVAL_MS,
          offeredBytesPerSecond: FLOOD_OFFERED_BYTES_PER_SECOND,
          startedAt
        }
      },
      stopFlood,
      stop
    }
    return fixture
  } catch (error) {
    try {
      await stop()
    } catch {
    }
    throw safeError(error, world.home)
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
