import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { createInterface, type Interface } from 'node:readline'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createActorReceiptStore, executeCli, type CliActorReceipt, type CliActorReceiptStore } from './cli-actor'
import type { Readable } from 'node:stream'

const COMMAND_TIMEOUT_MS = 15_000
const WORKER_ASK_TIMEOUT_MS = 40_000
const WORKER_START_TIMEOUT_MS = 60_000
const MAX_STDERR_BYTES = 8 * 1024
const IDLE_SCREEN = '\x1b]0;✳ Claude Code\x07\r\n● Ready.\r\n╭─────────────────────────────────────────────╮\r\n│ >                                           │\r\n╰─────────────────────────────────────────────╯\r\n  ? for shortcuts\r\n'
const PHASE_ONE_TRIGGER = 'cli-parity-release'

export type ParsedWorkerPreamble = {
  sessionId: string
  worktreeId: string
  runId: string
  taskId: string
  dispatchId: string
  mode: 'complete' | 'hold' | 'unknown'
}

export const COORDINATOR_PHASE_ONE_IDS: readonly string[] = [
  'workers-run-list',
  'workers-run-use',
  'workers-target',
  'workers-context-task',
  'workers-dispatch-dry-run',
  'workers-dispatch',
  'workers-dispatch-show',
  'workers-start-complete',
  'workers-reply',
  'workers-reply-replay',
  'workers-reply-mismatch',
  'workers-request-show',
  'workers-request-absent',
  'workers-start-stop',
  'workers-stop',
  'workers-stop-repeat',
  'workers-start-abandon',
  'workers-retain',
  'workers-abandon',
  'workers-abandon-show'
]

export const COORDINATOR_PHASE_TWO_IDS: readonly string[] = [
  'workers-release',
  'workers-release-repeat',
  'workers-read-archived',
  'workers-release-abandoned',
  'workers-close-abandoned',
  'workers-close-target',
  'workers-reset-messages',
  'workers-reset-messages-readback',
  'workers-reset-all',
  'workers-reset-all-readback'
]

type ActorEnvironment = {
  home: string
  cliEntry: string
  sessionId: string
  worktreeId: string
  sessionToken: string
}

type ActorCallOptions = {
  format?: 'json' | 'jsonl'
  timeoutMs?: number
  expectedExitCode?: number
}

type CoordinatorInput = { lines: Interface; closed: Promise<void> }

function actorEnvironment(): ActorEnvironment {
  const home = process.env.QUIRKY_HOME
  const cliEntry = process.env.CLI_PARITY_CLI_ENTRY
  const sessionId = process.env.QUIRKY_SESSION_ID
  const worktreeId = process.env.QUIRKY_WORKTREE_ID
  const sessionToken = process.env.QUIRKY_SESSION_TOKEN
  if (!home || !isAbsolute(home) || !cliEntry || !isAbsolute(cliEntry) || !sessionId || !worktreeId || !sessionToken) {
    throw new Error('fixture actor paths or authenticated session identity are unavailable')
  }
  return { home, cliEntry, sessionId, worktreeId, sessionToken }
}

function privateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function redact(text: string, env: ActorEnvironment): string {
  return text
    .split(env.home).join('<cli-home>')
    .split(env.sessionToken).join('<redacted>')
}

function writeCoordinatorError(directory: string, failedReceipt: string, error: unknown, env: ActorEnvironment): void {
  privateJson(join(directory, 'error.json'), { failedReceipt, message: redact(errorMessage(error), env) })
}

async function actorCall(
  store: CliActorReceiptStore,
  env: ActorEnvironment,
  id: string,
  args: string[],
  options: ActorCallOptions = {}
): Promise<CliActorReceipt> {
  const argv = [process.execPath, env.cliEntry, ...args, '--runtime', 'local', '--json']
  const raw = await executeCli(argv, options.timeoutMs ?? COMMAND_TIMEOUT_MS)
  const receipt: CliActorReceipt = { id, argv, ...raw, format: options.format ?? 'json' }
  store.append(receipt)
  const expectedExitCode = options.expectedExitCode ?? 0
  if (raw.exitCode !== expectedExitCode) {
    throw new Error(`${id} exited ${raw.exitCode}: ${raw.stderr.slice(-MAX_STDERR_BYTES)}`)
  }
  return receipt
}

function jsonObject(stdout: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error(`${label} did not return JSON`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} did not return a JSON object`)
  return value as Record<string, unknown>
}

function objectField(value: unknown, key: string, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}.${key} is not an object`)
  const field = Reflect.get(value, key)
  if (!field || typeof field !== 'object' || Array.isArray(field)) throw new Error(`${label}.${key} is not an object`)
  return field as Record<string, unknown>
}

function stringField(value: unknown, key: string, label: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}.${key} is missing`)
  const field = Reflect.get(value, key)
  if (typeof field !== 'string' || field.length === 0) throw new Error(`${label}.${key} is missing`)
  return field
}

function idFrom(value: unknown, label: string): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} did not return an identity`)
  const fields = value as Record<string, unknown>
  for (const key of ['id', 'runId', 'sessionId', 'taskId', 'dispatchId']) {
    if (typeof fields[key] === 'string' && fields[key]) return fields[key] as string
  }
  throw new Error(`${label} did not return an identity`)
}

function requiredArray(value: unknown, key: string, label: string): unknown[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}.${key} is missing`)
  const field = Reflect.get(value, key)
  if (!Array.isArray(field)) throw new Error(`${label}.${key} is missing`)
  return field
}

function writeIdentity(directory: string, value: Record<string, unknown>): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  privateJson(join(directory, 'identity.json'), value)
}

function readField(lines: string[], prefix: string): string | undefined {
  const line = lines.find((candidate) => candidate.startsWith(prefix))
  const value = line?.slice(prefix.length).trim()
  return value || undefined
}

export function parseWorkerPreamble(text: string): ParsedWorkerPreamble {
  const lines = text.split(/\r\n?|\n/)
  const sessionId = readField(lines, 'Your own Quirky session ID is:')
  const worktreeId = readField(lines, 'Your workspace ID is:')
  const runId = readField(lines, 'Your Run ID is:')
  const taskId = readField(lines, 'Your Task ID is:')
  const dispatchId = readField(lines, 'Your Dispatch ID is:')
  if (!taskId) throw new Error('worker preamble is missing the Task line')
  if (!dispatchId) throw new Error('worker preamble is missing the Dispatch line')
  if (!sessionId || !worktreeId || !runId) throw new Error('worker preamble is missing authenticated identity fields')
  const taskMarker = text.indexOf('=== TASK ===')
  const spec = taskMarker < 0 ? '' : text.slice(taskMarker + '=== TASK ==='.length).trim()
  const mode = spec === 'cli-parity-worker-complete'
    ? 'complete'
    : spec === 'cli-parity-worker-hold'
      ? 'hold'
      : 'unknown'
  return { sessionId, worktreeId, runId, taskId, dispatchId, mode }
}

function workerActorDirectory(env: ActorEnvironment): string {
  if (env.sessionId === '.' || env.sessionId === '..' || /[\\/]/.test(env.sessionId)) {
    throw new Error('fixture worker session identity is invalid')
  }
  return join(env.home, 'cli-worker-actor', 'sessions', env.sessionId)
}

function installWorkerSignalHandlers(): void {
  const finish = () => process.exit(0)
  process.on('SIGTERM', finish)
  process.on('SIGHUP', finish)
  process.on('SIGINT', finish)
}

/** Collect one bracketed paste and submit it only after the terminal sends Enter. */
export function collectBracketedPaste(input: Readable = process.stdin): Promise<string> {
  const start = '\x1b[200~'
  const end = '\x1b[201~'
  const { promise, resolve } = Promise.withResolvers<string>()
  let pending = ''
  let paste = ''
  let receiving = false
  let waitingForEnter = false
  const onData = (chunk: string) => {
    pending += chunk
    if (!receiving && !waitingForEnter) {
      const startAt = pending.indexOf(start)
      if (startAt < 0) {
        pending = pending.slice(-(start.length - 1))
        return
      }
      pending = pending.slice(startAt + start.length)
      receiving = true
    }
    if (receiving) {
      const endAt = pending.indexOf(end)
      if (endAt < 0) return
      paste = pending.slice(0, endAt)
      pending = pending.slice(endAt + end.length)
      receiving = false
      waitingForEnter = true
    }
    if (waitingForEnter && /[\r\n]$/.test(pending)) {
      input.off('data', onData)
      resolve(paste)
    }
  }
  input.setEncoding('utf8')
  input.on('data', onData)
  input.resume()
  return promise
}


async function runCompleteWorker(
  preamble: ParsedWorkerPreamble,
  env: ActorEnvironment,
  store: CliActorReceiptStore
): Promise<void> {
  await actorCall(store, env, 'workers-ask', [
    'orchestration', 'ask', '--question', 'cli-parity-worker-question', '--timeout-ms', '30000'
  ], { timeoutMs: WORKER_ASK_TIMEOUT_MS })
  await actorCall(store, env, 'workers-done', [
    'orchestration', 'send', '--type', 'worker_done', '--task-id', preamble.taskId, '--dispatch-id', preamble.dispatchId,
    '--outcome', 'succeeded', '--subject', 'Worker report', '--body', 'cli-parity-worker-report'
  ])
  process.stdout.write(`CLI-PARITY-WORKER-DONE:${preamble.dispatchId}\r\n${IDLE_SCREEN}`)
}

async function runWorker(env: ActorEnvironment): Promise<void> {
  installWorkerSignalHandlers()
  process.stdout.write(`\x1b[?2004h${IDLE_SCREEN}`)
  if (!process.stdin.isTTY) {
    process.stderr.write('fixture worker requires a terminal\n')
    process.exitCode = 1
    return
  }
  process.stdin.setRawMode(true)
  const pasted = await collectBracketedPaste()
  process.stdout.write('\x1b]0;⠋ Claude Code\x07\r\n✻ Working… (esc to interrupt)\r\n')
  let preamble: ParsedWorkerPreamble
  try {
    preamble = parseWorkerPreamble(pasted)
  } catch {
    process.stdout.write('CLI-PARITY-WORKER-UNKNOWN\r\n')
    return
  }
  const directory = workerActorDirectory(env)
  writeIdentity(directory, {
    sessionId: preamble.sessionId,
    worktreeId: preamble.worktreeId,
    runId: preamble.runId,
    taskId: preamble.taskId,
    dispatchId: preamble.dispatchId
  })
  const store = createActorReceiptStore(directory)
  if (preamble.mode === 'hold') {
    process.stdout.write(`CLI-PARITY-WORKER-HOLD:${preamble.dispatchId}\r\n`)
    return
  }
  if (preamble.mode === 'unknown') {
    process.stdout.write('CLI-PARITY-WORKER-UNKNOWN\r\n')
    return
  }
  await runCompleteWorker(preamble, env, store)
}

function matchingQuestion(messages: unknown[], dispatchId: string): string | undefined {
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue
    const record = message as Record<string, unknown>
    if (record.type !== 'question' || record.body !== 'cli-parity-worker-question') continue
    if (!record.payload || typeof record.payload !== 'object' || Array.isArray(record.payload)) continue
    if (Reflect.get(record.payload, 'dispatchId') !== dispatchId) continue
    if (typeof record.id === 'string' && record.id.length > 0) return record.id
  }
  return undefined
}

async function waitForQuestion(
  call: (id: string, args: string[], options?: ActorCallOptions) => Promise<CliActorReceipt>,
  runId: string,
  dispatchId: string
): Promise<string> {
  const deadline = Date.now() + 20_000
  let attempt = 0
  while (Date.now() < deadline) {
    attempt += 1
    const timeoutMs = Math.max(1, Math.min(COMMAND_TIMEOUT_MS, deadline - Date.now()))
    const receipt = await call(`workers-question-poll-${attempt}`, ['orchestration', 'check', '--run', runId, '--peek'], { timeoutMs })
    const result = jsonObject(receipt.stdout, 'Question poll')
    const messageId = matchingQuestion(requiredArray(result, 'messages', 'Question poll'), dispatchId)
    if (messageId) return messageId
    await Bun.sleep(200)
  }
  throw new Error('worker question did not arrive within 20 seconds')
}

async function waitForCompletion(
  call: (id: string, args: string[], options?: ActorCallOptions) => Promise<CliActorReceipt>,
  dispatchId: string
): Promise<void> {
  const deadline = Date.now() + 20_000
  let attempt = 0
  while (Date.now() < deadline) {
    attempt += 1
    const timeoutMs = Math.max(1, Math.min(COMMAND_TIMEOUT_MS, deadline - Date.now()))
    const receipt = await call(`workers-complete-poll-${attempt}`, ['orchestration', 'worker-show', '--dispatch', dispatchId], { timeoutMs })
    const result = jsonObject(receipt.stdout, 'Worker completion poll')
    const worker = result.worker
    if (worker && typeof worker === 'object' && !Array.isArray(worker) && Reflect.get(worker, 'state') === 'succeeded') return
    await Bun.sleep(200)
  }
  throw new Error('worker did not complete within 20 seconds')
}

async function waitForReleaseTrigger(): Promise<CoordinatorInput> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const { promise: closed, resolve: resolveClosed } = Promise.withResolvers<void>()
  lines.once('close', resolveClosed)
  process.stdout.write('CLI-COORDINATOR-PHASE-1\n')
  const { promise: firstLine, resolve: resolveFirstLine } = Promise.withResolvers<string | undefined>()
  lines.once('line', resolveFirstLine)
  lines.once('close', () => resolveFirstLine(undefined))
  if (await firstLine !== PHASE_ONE_TRIGGER) {
    lines.close()
    throw new Error('coordinator release trigger was not cli-parity-release')
  }
  return { lines, closed }
}

async function runCoordinator(env: ActorEnvironment): Promise<void> {
  const directory = join(env.home, 'cli-worker-actor', 'coordinator')
  writeIdentity(directory, { sessionId: env.sessionId, worktreeId: env.worktreeId, pid: process.pid })
  const store = createActorReceiptStore(directory)
  let failedReceipt = 'workers-run-list'
  const call = (id: string, args: string[], options: ActorCallOptions = {}) => {
    failedReceipt = id
    return actorCall(store, env, id, args, options)
  }
  const callJson = async (id: string, args: string[], options: ActorCallOptions = {}) => {
    const receipt = await call(id, args, options)
    return { receipt, result: jsonObject(receipt.stdout, id) }
  }

  try {
    const { result: listed } = await callJson('workers-run-list', ['orchestration', 'run-list'])
    const runs = requiredArray(listed, 'runs', 'Run list')
    const candidates = runs.filter((run) => run && typeof run === 'object' && !Array.isArray(run) &&
      Reflect.get(run, 'objective') === 'cli-parity-objective')
    if (candidates.length !== 1) throw new Error('Run list did not contain exactly one CLI parity Run')
    const runId = idFrom(candidates[0], 'CLI parity Run')

    await call('workers-run-use', ['orchestration', 'run-use', '--id', runId])
    const { result: target } = await callJson('workers-target', [
      'session', 'new', '--agent', 'shell', '--worktree', env.worktreeId, '--name', 'cli-parity-dispatch-target'
    ])
    const sessionId = idFrom(target.session ?? target, 'Dispatch target session')
    const { result: createdTask } = await callJson('workers-context-task', [
      'orchestration', 'task-create', '--spec', 'cli-parity-context'
    ])
    const taskId = idFrom(createdTask.task ?? createdTask, 'Context Task')
    await call('workers-dispatch-dry-run', [
      'orchestration', 'dispatch', '--task', taskId, '--to', sessionId, '--dry-run'
    ])
    await call('workers-dispatch', [
      'orchestration', 'dispatch', '--task', taskId, '--to', sessionId
    ])
    await call('workers-dispatch-show', [
      'orchestration', 'dispatch-show', '--task', taskId, '--preamble'
    ])

    const { result: startedComplete } = await callJson('workers-start-complete', [
      'orchestration', 'worker-start', '--spec', 'cli-parity-worker-complete', '--worktree', 'current',
      '--agent', 'claude', '--timeout-ms', '30000'
    ], { timeoutMs: WORKER_START_TIMEOUT_MS })
    const dispatchOne = stringField(startedComplete, 'dispatchId', 'worker-start')
    stringField(startedComplete, 'taskId', 'worker-start')
    const messageId = await waitForQuestion(call, runId, dispatchOne)
    const requestId = randomUUID()
    await call('workers-reply', [
      'orchestration', 'reply', '--id', messageId, '--body', 'cli-parity-answer', '--retry-request', requestId
    ])
    await call('workers-reply-replay', [
      'orchestration', 'reply', '--id', messageId, '--body', 'cli-parity-answer', '--retry-request', requestId
    ])
    await call('workers-reply-mismatch', [
      'orchestration', 'reply', '--id', messageId, '--body', 'cli-parity-other', '--retry-request', requestId
    ], { expectedExitCode: 1 })
    await call('workers-request-show', ['orchestration', 'request-show', '--request', requestId])
    const absentRequestId = randomUUID()
    await call('workers-request-absent', ['orchestration', 'request-show', '--request', absentRequestId])
    await waitForCompletion(call, dispatchOne)

    const { result: startedStop } = await callJson('workers-start-stop', [
      'orchestration', 'worker-start', '--spec', 'cli-parity-worker-hold', '--worktree', 'current',
      '--agent', 'claude', '--timeout-ms', '30000'
    ], { timeoutMs: WORKER_START_TIMEOUT_MS })
    const dispatchTwo = stringField(startedStop, 'dispatchId', 'worker-start')
    await call('workers-stop', ['orchestration', 'worker-stop', '--dispatch', dispatchTwo])
    await call('workers-stop-repeat', ['orchestration', 'worker-stop', '--dispatch', dispatchTwo])

    const { result: startedAbandon } = await callJson('workers-start-abandon', [
      'orchestration', 'worker-start', '--spec', 'cli-parity-worker-hold', '--worktree', 'current',
      '--agent', 'claude', '--timeout-ms', '30000'
    ], { timeoutMs: WORKER_START_TIMEOUT_MS })
    const dispatchThree = stringField(startedAbandon, 'dispatchId', 'worker-start')
    await call('workers-retain', ['orchestration', 'worker-retain', '--dispatch', dispatchThree])
    await call('workers-abandon', ['orchestration', 'worker-abandon', '--dispatch', dispatchThree])
    const { result: abandoned } = await callJson('workers-abandon-show', [
      'orchestration', 'worker-show', '--dispatch', dispatchThree
    ])
    const abandonedTerminal = objectField(abandoned, 'terminal', 'worker-show')
    const abandonedSessionId = idFrom(abandonedTerminal, 'Abandoned worker terminal')

    const input = await waitForReleaseTrigger()
    await call('workers-release', ['orchestration', 'worker-release', '--dispatch', dispatchOne])
    await call('workers-release-repeat', ['orchestration', 'worker-release', '--dispatch', dispatchOne])
    await call('workers-read-archived', ['orchestration', 'worker-read', '--dispatch', dispatchOne])
    await call('workers-release-abandoned', ['orchestration', 'worker-release', '--dispatch', dispatchThree])
    await call('workers-close-abandoned', ['session', 'close', abandonedSessionId, '--yes'])
    await call('workers-close-target', ['session', 'close', sessionId, '--yes'])
    await call('workers-reset-messages', ['orchestration', 'reset', '--messages', '--yes'])
    await call('workers-reset-messages-readback', ['orchestration', 'inbox', '--full'])
    await call('workers-reset-all', ['orchestration', 'reset', '--all', '--yes'])
    await call('workers-reset-all-readback', ['orchestration', 'run-list'])
    process.stdout.write('CLI-COORDINATOR-DONE\n')
    await input.closed
    input.lines.close()
  } catch (error) {
    writeCoordinatorError(directory, failedReceipt, error, env)
    throw error
  }
}

async function runRole(role: 'coordinator' | 'worker'): Promise<void> {
  const env = actorEnvironment()
  if (role === 'coordinator') await runCoordinator(env)
  else await runWorker(env)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length !== 1 || (args[0] !== 'coordinator' && args[0] !== 'worker')) {
    process.exitCode = 2
  } else {
    runRole(args[0]).catch((error) => {
      const env = process.env.QUIRKY_HOME && process.env.CLI_PARITY_CLI_ENTRY &&
        process.env.QUIRKY_SESSION_ID && process.env.QUIRKY_WORKTREE_ID && process.env.QUIRKY_SESSION_TOKEN
        ? {
            home: process.env.QUIRKY_HOME,
            cliEntry: process.env.CLI_PARITY_CLI_ENTRY,
            sessionId: process.env.QUIRKY_SESSION_ID,
            worktreeId: process.env.QUIRKY_WORKTREE_ID,
            sessionToken: process.env.QUIRKY_SESSION_TOKEN
          }
        : undefined
      const message = errorMessage(error)
      process.stderr.write(`${env ? redact(message, env) : message}\n`)
      process.exitCode = 1
    })
  }
}
