import { randomUUID } from 'node:crypto'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const MAX_STDOUT_BYTES = 16 * 1024 * 1024
const MAX_STDERR_BYTES = 8 * 1024
const COMMAND_TIMEOUT_MS = 15_000

export type CliActorReceipt = {
  id: string
  argv: string[]
  stdout: string
  stderr: string
  exitCode: number
  stdoutBytes: number
  elapsedMs: number
  format: 'json' | 'jsonl'
}
export type CliActorReceiptStore = {
  append(receipt: CliActorReceipt): void
  read(): CliActorReceipt[]
}

export type CliActorIdentity = { sessionId: string; worktreeId: string; pid: number }

type HeadCapture = { done: Promise<void>; text(): string; bytes(): number; overflow(): boolean; cancel(): Promise<void> }
type TailCapture = { done: Promise<void>; text(): string; cancel(): Promise<void> }

export function quotePosixShellLiteral(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function buildCliActorCommand(paths: { bunPath: string; actorEntry: string }): string {
  if (!isAbsolute(paths.bunPath) || !isAbsolute(paths.actorEntry)) throw new Error('actor executable paths must be absolute')
  return `${quotePosixShellLiteral(paths.bunPath)} ${quotePosixShellLiteral(paths.actorEntry)}`
}

export function parseActorReceipt(raw: string): CliActorReceipt {
  const value: unknown = JSON.parse(raw)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('actor receipt must be an object')
  const receipt = value as Record<string, unknown>
  const allowed = new Set(['id', 'argv', 'stdout', 'stderr', 'exitCode', 'stdoutBytes', 'elapsedMs', 'format'])
  if (Object.keys(receipt).some((key) => !allowed.has(key)) || Object.keys(receipt).length !== allowed.size) {
    throw new Error('actor receipt has missing or unexpected fields')
  }
  if (typeof receipt.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(receipt.id) ||
      !Array.isArray(receipt.argv) || !receipt.argv.every((part) => typeof part === 'string') ||
      typeof receipt.stdout !== 'string' || typeof receipt.stderr !== 'string' ||
      !Number.isInteger(receipt.exitCode) || typeof receipt.exitCode !== 'number' ||
      !Number.isInteger(receipt.stdoutBytes) || typeof receipt.stdoutBytes !== 'number' || receipt.stdoutBytes < 0 ||
      typeof receipt.elapsedMs !== 'number' || !Number.isFinite(receipt.elapsedMs) || receipt.elapsedMs < 0 ||
      (receipt.format !== 'json' && receipt.format !== 'jsonl')) {
    throw new Error('actor receipt fields are invalid')
  }
  if (receipt.stdoutBytes < Buffer.byteLength(receipt.stdout)) throw new Error('actor receipt stdout byte count is inconsistent')
  return receipt as CliActorReceipt
}

function actorDirectory(home: string): string {
  return join(resolve(home), 'cli-actor')
}

function receiptDirectory(directory: string): string {
  return join(directory, 'receipts')
}

function receiptManifest(directory: string): string {
  return join(directory, 'receipt-index.json')
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, content, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, path)
}

function readManifest(directory: string, missingIsEmpty = false): string[] {
  const path = receiptManifest(directory)
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    if (missingIsEmpty && !existsSync(path)) return []
    throw new Error(`actor receipt manifest is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && /^[a-z][a-z0-9-]*$/.test(id))) {
    throw new Error('actor receipt manifest is malformed')
  }
  if (new Set(value).size !== value.length) throw new Error('actor receipt manifest contains duplicate IDs')
  return value
}

function readActorReceiptsAt(directory: string, missingIsEmpty = false): CliActorReceipt[] {
  const ids = readManifest(directory, missingIsEmpty)
  return ids.map((id) => {
    const path = join(receiptDirectory(directory), `${id}.json`)
    const mode = statSync(path).mode & 0o777
    if ((mode & 0o077) !== 0) throw new Error(`actor receipt ${id} is not private`)
    const receipt = parseActorReceipt(readFileSync(path, 'utf8'))
    if (receipt.id !== id) throw new Error(`actor receipt index does not match ${basename(path)}`)
    return receipt
  })
}

function appendActorReceipt(directory: string, receipt: CliActorReceipt): void {
  const ids = readManifest(directory, true)
  if (ids.includes(receipt.id)) throw new Error(`actor receipt ID already exists: ${receipt.id}`)
  const receipts = receiptDirectory(directory)
  mkdirSync(receipts, { recursive: true, mode: 0o700 })
  atomicWrite(join(receipts, `${receipt.id}.json`), JSON.stringify(receipt))
  atomicWrite(receiptManifest(directory), `${JSON.stringify([...ids, receipt.id])}\n`)
}

export function createActorReceiptStore(directory: string): CliActorReceiptStore {
  const root = resolve(directory)
  return {
    append(receipt) {
      appendActorReceipt(root, receipt)
    },
    read() {
      return readActorReceiptsAt(root, true)
    }
  }
}

export function actorReceiptFiles(home: string): string[] {
  const directory = actorDirectory(home)
  return readManifest(directory).map((id) => join(receiptDirectory(directory), `${id}.json`))
}

export function readActorReceipts(home: string): CliActorReceipt[] {
  return readActorReceiptsAt(actorDirectory(home))
}

export function readActorIdentity(home: string): CliActorIdentity {
  const path = join(actorDirectory(home), 'identity.json')
  if (!existsSync(path)) throw new Error('authenticated actor identity is missing')
  const mode = statSync(path).mode & 0o777
  if ((mode & 0o077) !== 0) throw new Error('authenticated actor identity is not private')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('authenticated actor identity is malformed')
  const identity = value as Record<string, unknown>
  if (Object.keys(identity).sort().join(',') !== 'pid,sessionId,worktreeId' ||
      typeof identity.sessionId !== 'string' || identity.sessionId.length === 0 ||
      typeof identity.worktreeId !== 'string' || identity.worktreeId.length === 0 ||
      !Number.isInteger(identity.pid) || typeof identity.pid !== 'number' || identity.pid <= 0) {
    throw new Error('authenticated actor identity fields are invalid')
  }
  return identity as CliActorIdentity
}

function createHeadCapture(stream: ReadableStream<Uint8Array> | null, onOverflow: () => void): HeadCapture {
  const chunks: Buffer[] = []
  let keptBytes = 0
  let totalBytes = 0
  let didOverflow = false
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const done = (async () => {
    if (!stream) return
    reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        totalBytes += chunk.length
        const allowed = Math.max(0, Math.min(chunk.length, MAX_STDOUT_BYTES - keptBytes))
        if (allowed > 0) {
          chunks.push(allowed === chunk.length ? chunk : chunk.subarray(0, allowed))
          keptBytes += allowed
        }
        if (allowed < chunk.length && !didOverflow) {
          didOverflow = true
          onOverflow()
        }
      }
    } finally {
      reader.releaseLock()
    }
  })()
  return {
    done,
    text: () => Buffer.concat(chunks, keptBytes).toString('utf8'),
    bytes: () => totalBytes,
    overflow: () => didOverflow,
    async cancel() { await reader?.cancel().catch(() => undefined) }
  }
}

function createTailCapture(stream: ReadableStream<Uint8Array> | null): TailCapture {
  const chunks: Buffer[] = []
  let keptBytes = 0
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const done = (async () => {
    if (!stream) return
    reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        if (chunk.length >= MAX_STDERR_BYTES) {
          chunks.splice(0, chunks.length, chunk.subarray(chunk.length - MAX_STDERR_BYTES))
          keptBytes = MAX_STDERR_BYTES
          continue
        }
        chunks.push(chunk)
        keptBytes += chunk.length
        while (keptBytes > MAX_STDERR_BYTES) {
          const excess = keptBytes - MAX_STDERR_BYTES
          const first = chunks[0]!
          if (first.length <= excess) {
            chunks.shift()
            keptBytes -= first.length
          } else {
            chunks[0] = first.subarray(excess)
            keptBytes -= excess
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  })()
  return {
    done,
    text: () => Buffer.concat(chunks, keptBytes).toString('utf8'),
    async cancel() { await reader?.cancel().catch(() => undefined) }
  }
}


function signalActorChildGroup(child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    try { child.kill(signal) } catch {}
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') return
    try { child.kill(signal) } catch {}
  }
}

async function stopChild(child: Bun.Subprocess<'ignore', 'pipe', 'pipe'>): Promise<void> {
  signalActorChildGroup(child, 'SIGTERM')
  const graceful = await Promise.race([child.exited.then(() => true), Bun.sleep(200).then(() => false)])
  signalActorChildGroup(child, 'SIGKILL')
  if (!graceful && !await Promise.race([child.exited.then(() => true), Bun.sleep(500).then(() => false)])) {
    throw new Error(`actor CLI child ${child.pid} was not reaped`)
  }
}

async function drainCaptures(stdout: HeadCapture, stderr: TailCapture): Promise<void> {
  const drains = Promise.all([stdout.done, stderr.done])
  const finished = await Promise.race([drains.then(() => true), Bun.sleep(500).then(() => false)])
  if (finished) return
  await Promise.allSettled([stdout.cancel(), stderr.cancel()])
  await Promise.allSettled([stdout.done, stderr.done])
}

export async function executeCli(argv: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<{
  stdout: string
  stderr: string
  exitCode: number
  stdoutBytes: number
  elapsedMs: number
}> {
  if (timeoutMs <= 0) throw new Error('actor CLI timeout must be positive')
  const home = process.env.QUIRKY_HOME
  if (!home || !isAbsolute(home)) throw new Error('actor did not inherit an owned QUIRKY_HOME')
  if (argv[0] !== process.execPath || !isAbsolute(argv[0]) || !argv[1] || !isAbsolute(argv[1])) {
    throw new Error('actor CLI must use absolute Bun and checkout CLI paths')
  }
  const startedAt = Date.now()
  const spawnOptions: Bun.SpawnOptions.OptionsObject<'ignore', 'pipe', 'pipe'> = {
    cwd: process.cwd(),
    env: { ...process.env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  }
  Object.assign(spawnOptions, { detached: true })
  const child = Bun.spawn(argv, spawnOptions)
  const failure = Promise.withResolvers<never>()
  const stdout = createHeadCapture(child.stdout, () => failure.reject(new Error(`actor CLI stdout exceeded ${MAX_STDOUT_BYTES} bytes`)))
  const stderr = createTailCapture(child.stderr)
  const timer = setTimeout(() => failure.reject(new Error(`actor CLI exceeded ${timeoutMs}ms`)), timeoutMs)
  let exitCode: number
  try {
    exitCode = await Promise.race([child.exited, failure.promise])
  } catch (error) {
    await stopChild(child)
    await drainCaptures(stdout, stderr)
    const failureError = error instanceof Error ? error : new Error(String(error))
    Object.assign(failureError, { stderrTail: stderr.text() })
    throw failureError
  } finally {
    clearTimeout(timer)
  }
  if (stdout.overflow()) {
    await stopChild(child)
    await drainCaptures(stdout, stderr)
    throw Object.assign(new Error(`actor CLI stdout exceeded ${MAX_STDOUT_BYTES} bytes`), { stderrTail: stderr.text() })
  }
  await stopChild(child)
  await drainCaptures(stdout, stderr)
  return { stdout: stdout.text(), stderr: stderr.text(), exitCode, stdoutBytes: stdout.bytes(), elapsedMs: Date.now() - startedAt }
}

function atomicReceipt(home: string, receipt: CliActorReceipt): void {
  appendActorReceipt(actorDirectory(home), receipt)
}

function writeActorIdentity(home: string): CliActorIdentity {
  const sessionId = process.env.QUIRKY_SESSION_ID
  const worktreeId = process.env.QUIRKY_WORKTREE_ID
  if (!sessionId || !worktreeId || !process.env.QUIRKY_SESSION_TOKEN) {
    throw new Error('fixture actor requires an authenticated terminal session and worktree')
  }
  const identity = { sessionId, worktreeId, pid: process.pid }
  atomicWrite(join(actorDirectory(home), 'identity.json'), `${JSON.stringify(identity)}\n`)
  return identity
}

function objectFromJson(stdout: string, label: string): Record<string, unknown> {
  const value: unknown = JSON.parse(stdout)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} did not return a JSON object`)
  return value as Record<string, unknown>
}

function stringAt(value: unknown, keys: readonly string[]): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const object = value as Record<string, unknown>
  for (const key of keys) if (typeof object[key] === 'string' && object[key]) return object[key] as string
  return undefined
}

function requiredId(stdout: string, label: string, nestedKey?: string): string {
  const value = objectFromJson(stdout, label)
  const candidate = nestedKey === undefined ? value : value[nestedKey]
  const id = stringAt(candidate, ['id', 'runId', 'taskId', 'gateId']) ?? stringAt(value, ['id', 'runId', 'taskId', 'gateId'])
  if (!id) throw new Error(`${label} did not return an identity`)
  return id
}

function askIdentity(stdout: string): string {
  const lines = stdout.trim().split('\n')
  if (lines.length !== 2) throw new Error('Ask did not emit exactly two JSONL records')
  const first = JSON.parse(lines[0]!) as Record<string, unknown>
  const second = JSON.parse(lines[1]!) as Record<string, unknown>
  const askId = typeof first.askId === 'string' ? first.askId : undefined
  if (first.status !== 'registered' || second.status !== 'pending' || !askId || second.askId !== askId) {
    throw new Error('Ask registration and pending records do not match')
  }
  return askId
}

async function actorCall(home: string, cliEntry: string, id: string, args: string[], format: 'json' | 'jsonl' = 'json'): Promise<CliActorReceipt> {
  const argv = [process.execPath, cliEntry, ...args, '--runtime', 'local', '--json']
  const raw = await executeCli(argv)
  const receipt: CliActorReceipt = { id, argv, ...raw, format }
  atomicReceipt(home, receipt)
  if (raw.exitCode !== 0) throw new Error(`${id} exited ${raw.exitCode}: ${raw.stderr.slice(-MAX_STDERR_BYTES)}`)
  return receipt
}

async function runActor(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('fixture actor accepts no command-line arguments')
  const home = process.env.QUIRKY_HOME
  const cliEntry = process.env.CLI_PARITY_CLI_ENTRY
  if (!home || !cliEntry || !isAbsolute(home) || !isAbsolute(cliEntry)) throw new Error('fixture actor paths are unavailable')
  const specPath = join(actorDirectory(home), 'confirm-spec.json')
  if (!existsSync(specPath)) throw new Error('fixed Ask spec is unavailable')
  if (!process.env.QUIRKY_SESSION_TOKEN) throw new Error('fixture actor is not authenticated')
  writeActorIdentity(home)

  const spec = `@${specPath}`
  const ask = await actorCall(home, cliEntry, 'ask-register', ['ask', '--spec', spec, '--chunk-ms', '50', '--timeout-ms', '10000'], 'jsonl')
  const askId = askIdentity(ask.stdout)
  await actorCall(home, cliEntry, 'ask-cancel', ['ask', 'cancel', '--id', askId])
  await actorCall(home, cliEntry, 'ask-wait', ['ask', 'wait', '--id', askId, '--chunk-ms', '1000'])

  const run = await actorCall(home, cliEntry, 'actor-run-create', ['orchestration', 'run-create', '--objective', 'cli-parity-objective'])
  const runId = requiredId(run.stdout, 'Run creation', 'run')
  await actorCall(home, cliEntry, 'actor-run-current', ['orchestration', 'run-current'])
  await actorCall(home, cliEntry, 'actor-run-show', ['orchestration', 'run-show', '--id', runId])
  const task = await actorCall(home, cliEntry, 'actor-task-create', ['orchestration', 'task-create', '--spec', 'cli-parity-task'])
  const taskId = requiredId(task.stdout, 'Task creation', 'task')
  await actorCall(home, cliEntry, 'actor-task-list', ['orchestration', 'task-list'])
  await actorCall(home, cliEntry, 'actor-task-update', ['orchestration', 'task-update', '--id', taskId, '--result', 'cli-parity-result'])
  await actorCall(home, cliEntry, 'actor-task-list-updated', ['orchestration', 'task-list'])
  const gate = await actorCall(home, cliEntry, 'actor-gate-create', [
    'orchestration', 'gate-create', '--task', taskId, '--question', 'cli-parity-gate', '--options', '["continue"]'
  ])
  const gateId = requiredId(gate.stdout, 'Gate creation', 'gate')
  await actorCall(home, cliEntry, 'actor-gate-list', ['orchestration', 'gate-list', '--task', taskId])
  await actorCall(home, cliEntry, 'actor-gate-resolve', ['orchestration', 'gate-resolve', '--id', gateId, '--resolution', 'continue'])
  await actorCall(home, cliEntry, 'actor-send', [
    'orchestration', 'send', '--to', `run:${runId}`, '--subject', 'cli-parity-mail', '--body', 'cli-parity-body'
  ])
  await actorCall(home, cliEntry, 'actor-check', ['orchestration', 'check', '--run', runId, '--peek'])
  await actorCall(home, cliEntry, 'actor-inbox', ['orchestration', 'inbox', '--full'])

  process.stdout.write('CLI-ACTOR-READY\n')
  const inputLog = join(actorDirectory(home), 'input.log')
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  await new Promise<void>((resolveClose) => {
    lines.on('line', (line) => {
      appendFileSync(inputLog, `${line}\n`, { mode: 0o600 })
      process.stdout.write(`ACK:${line}\n`)
    })
    lines.once('close', resolveClose)
  })
}

if (import.meta.main) {
  runActor().catch((error) => {
    const token = process.env.QUIRKY_SESSION_TOKEN
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`${message.replaceAll(process.env.QUIRKY_HOME ?? '', '<cli-home>').replaceAll(token ?? '', '<redacted>')}\n`)
    process.exitCode = 1
  })
}
