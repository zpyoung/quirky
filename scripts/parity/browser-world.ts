import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import { checkSchemaDeclaration, validateValue, type Schema } from '@quirky/protocol'
import { isDaemonAlive, readRuntime } from '@quirky/protocol/node'
import { resolveHelperBinary } from '../../plugins/quirky.browser/src/runtime/native'
import { createProcessScope, type ProcessScope } from '../test-support/process-scope'
import { createIsolatedRuntimeEnvironment } from '../ui-review/fixtures'
import { startBrowserFixture, type BrowserFixture } from './browser-fixture'

const MAX_DIAGNOSTIC_BYTES = 8 * 1024
const MAX_CLI_OUTPUT_BYTES = 48 * 1024 * 1024
const OPERATION_TIMEOUT_MS = 30_000
const WORK_DEADLINE_MS = 460_000
const EARLY_WORK_DEADLINE_MS = 20_000

export type BrowserArguments = { json: boolean; help: boolean }
export type CliReceipt = { argv: string[]; result: unknown; exitCode: number; stderrTail: string }
export type BrowserCleanup = { ok: boolean; error?: string; evidence?: Record<string, unknown> }
export type BrowserWorld = {
  home: string
  env: Record<string, string>
  fixture: BrowserFixture
  worktreeA: string
  worktreeB: string
  daemonPid: number
  daemonExited?: Promise<number>
  cli(argv: string[], options?: { allowFailure?: boolean; timeoutMs?: number }): Promise<CliReceipt>
  cleanup(): Promise<BrowserCleanup>
  processEvidence(): Promise<Record<string, unknown>>
}

export class BrowserFailure extends Error {
  readonly kind: string
  stderrTail?: string
  cleanup?: BrowserCleanup

  constructor(kind: string, message: string, stderrTail?: string) {
    super(message)
    this.name = 'BrowserFailure'
    this.kind = kind
    this.stderrTail = stderrTail
  }
}

type ProcessIdentity = { pid: number; ppid: number; pgid: number; started: string; command: string }
type ExpectedCliResult = { method: string; schema: Schema; extraProfileLabel?: boolean }
type BrowserCliRoute = { words: string[]; method: string }
type CliSchemas = { methods: Map<string, Schema>; browser: BrowserCliRoute[] }
type PipeChild = Bun.Subprocess<'ignore', 'pipe', 'pipe'>
type TailCapture = { done: Promise<void>; text(): string }
type HeadCapture = { done: Promise<void>; text(): string; truncated(): boolean }

export function boundedDiagnostic(text: string, home: string, tokens: readonly string[] = []): string {
  let safe = text
  if (home !== '') safe = safe.replaceAll(home, '<browser-home>')
  for (const token of [...tokens].filter((value) => value !== '').sort((left, right) => right.length - left.length)) {
    safe = safe.replaceAll(token, '<redacted>')
  }
  let bytes = Buffer.from(safe, 'utf8')
  if (bytes.length > MAX_DIAGNOSTIC_BYTES) bytes = bytes.subarray(bytes.length - MAX_DIAGNOSTIC_BYTES)
  let result = bytes.toString('utf8')
  while (Buffer.byteLength(result, 'utf8') > MAX_DIAGNOSTIC_BYTES) result = result.slice(1)
  return result
}

export function decodeCliReceipt(
  argv: string[],
  stdout: string,
  stderr: string,
  exitCode: number,
  home: string,
  allowFailure = false,
  options: { schemas?: CliSchemas; tokens?: readonly string[] } = {}
): CliReceipt {
  const tokens = options.tokens ?? []
  const stderrTail = boundedDiagnostic(stderr, home, tokens)
  if (Buffer.byteLength(stdout, 'utf8') > MAX_CLI_OUTPUT_BYTES) {
    throw new BrowserFailure('cli-output-too-large', 'CLI output exceeded the bounded capture limit', stderrTail)
  }
  const output = stdout.trim()
  let result: unknown
  if (output === '') {
    if (exitCode === 0) throw new BrowserFailure('malformed-cli-json', 'successful CLI command returned no JSON', stderrTail)
  } else {
    try {
      result = JSON.parse(output) as unknown
    } catch {
      if (exitCode === 0) throw new BrowserFailure('malformed-cli-json', 'CLI output was not valid JSON', stderrTail)
    }
  }
  if (exitCode === 0) {
    const schemas = options.schemas ?? loadCliSchemas(resolve(import.meta.dir, '../..'))
    validateCliResult(argv, result, schemas)
  }
  const receipt: CliReceipt = { argv: [...argv], result, exitCode, stderrTail }
  if (exitCode !== 0 && !allowFailure) {
    throw new BrowserFailure('cli-nonzero', `CLI command exited with code ${exitCode}`, stderrTail)
  }
  return receipt
}


export function parseBrowserArgs(args: readonly string[]): BrowserArguments {
  let json = false
  let help = false
  for (const argument of args) {
    if (argument === '--json') json = true
    else if (argument === '--help') help = true
    else throw new BrowserFailure('invalid-arguments', 'only --json and --help are supported')
  }
  return { json, help }
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function installedChrome(): string | undefined {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium'
  ]
  return candidates.find(isExecutableFile)
}

function requireInstalledChrome(): string {
  const chrome = installedChrome()
  if (!chrome) throw new BrowserFailure('missing-chrome', 'install Google Chrome or Chromium to run the browser parity checks')
  return chrome
}

function installShims(home: string): string {
  const bin = join(home, 'shim-bin')
  const logs = join(home, 'shim-logs')
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  mkdirSync(logs, { recursive: true, mode: 0o700 })
  for (const command of ['orca', 'security']) {
    const path = join(bin, command)
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' invoked >> "$QUIRKY_HOME/shim-logs/${command}.log"\nexit 97\n`, { mode: 0o700 })
    chmodSync(path, 0o700)
    writeFileSync(join(logs, `${command}.log`), '', { mode: 0o600 })
  }
  return bin
}

export function createBrowserEnvironment(home: string, repoRoot: string): Record<string, string> {
  const root = resolve(home)
  const checkout = resolve(repoRoot)
  const chrome = installedChrome()
  const env = createIsolatedRuntimeEnvironment(root, { repoRoot: checkout })
  for (const key of ['TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) {
    const path = env[key]
    if (path) mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  const shimBin = installShims(root)
  return {
    ...env,
    PATH: `${shimBin}${delimiter}${env.PATH ?? ''}`,
    ...(chrome ? { QUIRKY_BROWSER_CHROME: chrome } : {})
  }
}

function requirePinnedHelper(repoRoot: string): void {
  try {
    const helper = resolveHelperBinary(join(repoRoot, 'plugins/quirky.browser'))
    if (!isExecutableFile(helper)) throw new Error('resolved helper is not executable')
  } catch (error) {
    throw new BrowserFailure('missing-helper', error instanceof Error ? error.message : String(error))
  }
}

type ManifestMethod = { id: string; result: Schema }
type ManifestCommand = { words: string; methods: string[] }
type PluginManifestInfo = { id: string; methods: ManifestMethod[]; browserCommands: ManifestCommand[] }

function stringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false
  const entries: unknown[] = value
  return entries.every((item) => typeof item === 'string')
}

function readPluginManifest(path: string, browserPlugin: boolean): PluginManifestInfo {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new BrowserFailure('invalid-cli-contract', `could not read a plugin manifest: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrowserFailure('invalid-cli-contract', `plugin manifest is not an object: ${path}`)
  }
  const manifest = value as Record<string, unknown>
  const contributionValue = manifest.contributes
  if (typeof manifest.id !== 'string' || contributionValue === null || typeof contributionValue !== 'object' || Array.isArray(contributionValue)) {
    throw new BrowserFailure('invalid-cli-contract', `plugin manifest is missing contributions: ${path}`)
  }
  const contributes = contributionValue as Record<string, unknown>
  if (!Array.isArray(contributes.method)) throw new BrowserFailure('invalid-cli-contract', `plugin methods are missing: ${path}`)

  const methods: ManifestMethod[] = []
  const methodEntries: unknown[] = contributes.method
  for (const item of methodEntries) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new BrowserFailure('invalid-cli-contract', `plugin method declaration is invalid: ${path}`)
    }
    const entry = item as Record<string, unknown>
    if (typeof entry.id !== 'string' || !('result' in entry)) {
      throw new BrowserFailure('invalid-cli-contract', `plugin method declaration is missing a result schema: ${path}`)
    }
    const problems = checkSchemaDeclaration(entry.result, `${manifest.id}/${entry.id} result`)
    if (problems.length > 0) throw new BrowserFailure('invalid-cli-contract', problems.join('; '))
    methods.push({ id: entry.id, result: entry.result as Schema })
  }

  const browserCommands: ManifestCommand[] = []
  if (browserPlugin) {
    if (!Array.isArray(contributes['cli-command'])) {
      throw new BrowserFailure('invalid-cli-contract', 'browser CLI commands are missing from its manifest')
    }
    const commandEntries: unknown[] = contributes['cli-command']
    for (const item of commandEntries) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new BrowserFailure('invalid-cli-contract', 'browser CLI command declaration is invalid')
      }
      const command = item as Record<string, unknown>
      if (typeof command.words !== 'string' || !stringArray(command.methods) || command.methods.length === 0) {
        throw new BrowserFailure('invalid-cli-contract', 'browser CLI command declaration is invalid')
      }
      browserCommands.push({ words: command.words, methods: command.methods })
    }
  }
  return { id: manifest.id, methods, browserCommands }
}

function loadCliSchemas(repoRoot: string): CliSchemas {
  const methods = new Map<string, Schema>()
  const browser: BrowserCliRoute[] = []
  for (const plugin of ['quirky.browser', 'quirky.repo', 'quirky.worktree']) {
    const manifest = readPluginManifest(join(repoRoot, 'plugins', plugin, 'quirky-plugin.json'), plugin === 'quirky.browser')
    for (const method of manifest.methods) methods.set(`${manifest.id}/${method.id}`, method.result)
    for (const command of manifest.browserCommands) {
      browser.push({ words: command.words.trim().split(/\s+/), method: command.methods[0]! })
    }
  }
  browser.sort((left, right) => right.words.length - left.words.length)
  return { methods, browser }
}

function expectedCliResult(argv: readonly string[], schemas: CliSchemas): ExpectedCliResult | undefined {
  if (argv[0] === 'browser') {
    const words = argv.slice(1)
    const route = schemas.browser.find((candidate) => candidate.words.every((word, index) => words[index] === word))
    if (!route) throw new BrowserFailure('invalid-cli-contract', 'browser command has no public method declaration')
    const schema = schemas.methods.get(route.method)
    if (!schema) throw new BrowserFailure('invalid-cli-contract', `browser method schema is missing: ${route.method}`)
    return {
      method: route.method,
      schema,
      ...(route.words.join(' ') === 'tab list' && argv.includes('--show-profile') ? { extraProfileLabel: true } : {})
    }
  }
  const method = argv[0] === 'repo' && argv[1] === 'add'
    ? 'quirky.repo/add'
    : argv[0] === 'worktree' && argv[1] === 'list'
      ? 'quirky.worktree/list'
      : undefined
  if (!method) return undefined
  const schema = schemas.methods.get(method)
  if (!schema) throw new BrowserFailure('invalid-cli-contract', `public method schema is missing: ${method}`)
  return { method, schema }
}

function schemaWithProfileLabel(schema: Schema): Schema {
  const tabs = schema.properties?.tabs
  const items = tabs?.items
  if (!tabs || !items) return schema
  return {
    ...schema,
    properties: {
      ...schema.properties,
      tabs: {
        ...tabs,
        items: {
          ...items,
          properties: { ...items.properties, profileLabel: {} }
        }
      }
    }
  }
}

function validateCliResult(argv: readonly string[], result: unknown, schemas: CliSchemas): void {
  const expected = expectedCliResult(argv, schemas)
  if (!expected) return
  const schema = expected.extraProfileLabel ? schemaWithProfileLabel(expected.schema) : expected.schema
  const failure = validateValue(schema, result, `${expected.method} result`)
  if (failure) throw new BrowserFailure('malformed-cli-json', `CLI JSON does not match ${expected.method}: ${failure}`)
}

function parseProcessTable(text: string): Map<number, ProcessIdentity> {
  const rows = new Map<number, ProcessIdentity>()
  for (const line of text.split('\n')) {
    const columns = line.trim().split(/\s+/)
    const [pid, ppid, pgid] = columns.slice(0, 3).map(Number)
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || !Number.isInteger(pgid) || columns.length < 9) continue
    rows.set(pid, {
      pid,
      ppid,
      pgid,
      started: columns.slice(3, 8).join(' '),
      command: columns.slice(8).join(' ')
    })
  }
  return rows
}

function processSnapshot(env: Record<string, string>): Map<number, ProcessIdentity> {
  const result = Bun.spawnSync(['/bin/ps', '-A', '-o', 'pid=,ppid=,pgid=,lstart=,command='], {
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore'
  })
  if (result.exitCode !== 0) throw new Error('could not inspect process identities')
  return parseProcessTable(Buffer.from(result.stdout).toString('utf8'))
}


function descendants(snapshot: Map<number, ProcessIdentity>, rootPid: number): ProcessIdentity[] {
  const children = new Map<number, ProcessIdentity[]>()
  for (const row of snapshot.values()) {
    const rows = children.get(row.ppid) ?? []
    rows.push(row)
    children.set(row.ppid, rows)
  }
  const found: ProcessIdentity[] = []
  const seen = new Set<number>([rootPid])
  const pending = [rootPid]
  while (pending.length > 0) {
    const parent = pending.pop()!
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      found.push(child)
      pending.push(child.pid)
    }
  }
  return found
}

function sameProcess(left: ProcessIdentity, right: ProcessIdentity | undefined): boolean {
  return !!right && left.pid === right.pid && left.started === right.started &&
    (left.command === right.command || (left.ppid === right.ppid && left.pgid === right.pgid))
}

type ShimLogState = { empty: boolean; bytes: Record<string, number>; orcaLog: string; securityLog: string }

function readShimLogs(home: string): ShimLogState {
  const bytes: Record<string, number> = {}
  const logs: { orca: string; security: string } = { orca: '', security: '' }
  let empty = true
  for (const command of ['orca', 'security'] as const) {
    try {
      const content = readFileSync(join(home, 'shim-logs', `${command}.log`))
      bytes[command] = content.byteLength
      logs[command] = content.toString('utf8')
      if (content.byteLength > 0) empty = false
    } catch {
      bytes[command] = 0
    }
  }
  return { empty, bytes, orcaLog: logs.orca, securityLog: logs.security }
}

function createCleanup(
  scope: ProcessScope,
  home: string,
  getEnv: () => Record<string, string>,
  getFixture: () => BrowserFixture | undefined,
  getDaemonPid: () => number | undefined,
  getDaemonIdentity: () => ProcessIdentity | undefined
): { cleanup(): Promise<BrowserCleanup>; processEvidence(): Promise<Record<string, unknown>> } {
  let cleanupPromise: Promise<BrowserCleanup> | undefined
  let savedEvidence: Record<string, unknown> | undefined
  const capture = (): ProcessIdentity[] => {
    const daemonPid = getDaemonPid()
    if (daemonPid === undefined) return []
    const snapshot = processSnapshot({ ...getEnv(), ...scope.env, HOME: home, QUIRKY_HOME: home })
    const originalDaemon = getDaemonIdentity()
    const currentDaemon = snapshot.get(daemonPid)
    const daemonMatches = currentDaemon !== undefined && (!originalDaemon || sameProcess(originalDaemon, currentDaemon))
    const tracked = new Map<number, ProcessIdentity>()
    if (currentDaemon && daemonMatches) tracked.set(daemonPid, currentDaemon)
    else if (originalDaemon) tracked.set(daemonPid, originalDaemon)
    if (daemonMatches) {
      for (const row of descendants(snapshot, daemonPid)) {
        const command = row.command.toLowerCase()
        if (row.command.includes(home) || command.includes('chrome') || command.includes('chromium') ||
          command.includes('agent-browser') || command.includes('pty-host')) tracked.set(row.pid, row)
      }
    }
    return [...tracked.values()]
  }
  const evidenceNow = async (): Promise<Record<string, unknown>> => {
    let tracked: ProcessIdentity[] = []
    let scanError: string | undefined
    try {
      tracked = capture()
    } catch (error) {
      scanError = error instanceof Error ? error.message : String(error)
    }
    const logState = readShimLogs(home)
    return {
      trackedIdentities: tracked.map(({ pid, started, command }) => ({
        pid,
        started,
        command: boundedDiagnostic(command, home, [scope.env.QUIRKY_TEST_SCOPE ?? ''])
      })),
      aliveAfter: tracked.map(({ pid }) => pid),
      processIdentitiesGone: false,
      orcaLog: logState.orcaLog,
      securityLog: logState.securityLog,
      shimLogsEmpty: logState.empty,
      shimLogBytes: logState.bytes,
      homeRemoved: !existsSync(home),
      ...(scanError ? { processScanError: scanError } : {})
    }
  }
  const cleanup = (): Promise<BrowserCleanup> => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      const errors: string[] = []
      let identitiesVerified = true
      let tracked: ProcessIdentity[] = []
      try {
        tracked = capture()
      } catch (error) {
        identitiesVerified = false
        errors.push(`process identities could not be captured: ${error instanceof Error ? error.message : String(error)}`)
      }
      let fixtureStopped = true
      try {
        await getFixture()?.stop()
      } catch (error) {
        fixtureStopped = false
        errors.push(`fixture cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      const logState = readShimLogs(home)
      try {
        await scope.cleanup()
      } catch (error) {
        errors.push(`process scope cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
      }

      let aliveAfter: number[] = []
      try {
        const after = processSnapshot({ ...getEnv(), ...scope.env, HOME: home, QUIRKY_HOME: home })
        aliveAfter = tracked.filter((identity) => sameProcess(identity, after.get(identity.pid))).map(({ pid }) => pid)
      } catch (error) {
        identitiesVerified = false
        errors.push(`process identities could not be verified: ${error instanceof Error ? error.message : String(error)}`)
        aliveAfter = tracked.map(({ pid }) => pid)
      }
      const homeRemoved = !existsSync(home)
      if (aliveAfter.length > 0) errors.push(`process identities remain alive: ${aliveAfter.join(', ')}`)
      if (!logState.empty) errors.push('orca/security shim logs were not empty')
      if (!fixtureStopped) errors.push('fixture did not stop')
      if (!homeRemoved) errors.push('owned browser home was not removed')
      const evidence: Record<string, unknown> = {
        trackedIdentities: tracked.map(({ pid, started, command }) => ({
          pid,
          started,
          command: boundedDiagnostic(command, home, [scope.env.QUIRKY_TEST_SCOPE ?? ''])
        })),
        aliveAfter,
        processIdentitiesGone: identitiesVerified && aliveAfter.length === 0,
        orcaLog: logState.orcaLog,
        securityLog: logState.securityLog,
        shimLogsEmpty: logState.empty,
        shimLogBytes: logState.bytes,
        fixtureStopped,
        homeRemoved
      }
      savedEvidence = evidence
      const safeErrors = errors.map((message) => boundedDiagnostic(message, home, [scope.env.QUIRKY_TEST_SCOPE ?? '']))
      return {
        ok: errors.length === 0,
        ...(errors.length > 0 ? { error: safeErrors.join('; ') } : {}),
        evidence
      }
    })()
    return cleanupPromise
  }
  return {
    cleanup,
    async processEvidence() {
      return savedEvidence ?? await evidenceNow()
    }
  }
}

function diagnosticTokens(scope: ProcessScope, home: string): string[] {
  const runtime = readRuntime(home)
  return [scope.env.QUIRKY_TEST_SCOPE ?? '', runtime?.token ?? '', runtime?.hookToken ?? ''].filter(Boolean)
}

function normalizeFailure(error: unknown, home: string, tokens: readonly string[]): BrowserFailure {
  if (error instanceof BrowserFailure) {
    error.message = boundedDiagnostic(error.message, home, tokens)
    if (error.stderrTail !== undefined) error.stderrTail = boundedDiagnostic(error.stderrTail, home, tokens)
    return error
  }
  return new BrowserFailure('startup-failed', boundedDiagnostic(error instanceof Error ? error.message : String(error), home, tokens))
}

function stopError(signal?: AbortSignal): BrowserFailure | undefined {
  if (signal?.aborted) {
    const reason: unknown = signal.reason
    if (reason instanceof BrowserFailure) return reason
    return new BrowserFailure('aborted', reason instanceof Error ? reason.message : 'browser world startup was aborted')
  }
  return undefined
}

function ensureWorkTime(signal: AbortSignal | undefined, deadline: number): void {
  const aborted = stopError(signal)
  if (aborted) throw aborted
  if (Date.now() >= deadline) throw new BrowserFailure('deadline', 'browser parity work deadline reached')
}

function withinDeadline<T>(operation: Promise<T>, signal: AbortSignal | undefined, deadline: number): Promise<T> {
  ensureWorkTime(signal, deadline)
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  let settled = false
  let timer: ReturnType<typeof setTimeout>
  const finish = (settle: () => void) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    settle()
  }
  const abort = () => {
    const failure = stopError(signal)
    if (failure) finish(() => reject(failure))
  }
  timer = setTimeout(() => {
    finish(() => reject(new BrowserFailure('deadline', 'browser parity work deadline reached')))
  }, Math.max(1, deadline - Date.now()))
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  operation.then(
    (value) => finish(() => resolve(value)),
    (error: unknown) => finish(() => reject(error))
  )
  return promise
}

async function daemonStatus(home: string, daemonPid: number, deadline: number): Promise<boolean> {
  const runtime = readRuntime(home)
  if (!runtime || runtime.pid !== daemonPid || Date.now() >= deadline) return false
  return await isDaemonAlive(runtime, Math.max(1, Math.min(300, deadline - Date.now())))
}

async function waitForDaemon(
  home: string,
  daemon: PipeChild,
  deadline: number,
  signal?: AbortSignal,
  diagnostics?: () => string
): Promise<void> {
  const readinessDeadline = Math.min(deadline, Date.now() + OPERATION_TIMEOUT_MS)
  while (Date.now() < readinessDeadline) {
    ensureWorkTime(signal, readinessDeadline)
    if (daemon.exitCode !== null) {
      const output = diagnostics?.() ?? ''
      throw new BrowserFailure(
        'daemon-exited',
        `daemon exited with code ${daemon.exitCode} before readiness`,
        output || undefined
      )
    }
    const runtime = readRuntime(home)
    if (runtime) {
      if (runtime.pid !== daemon.pid) throw new BrowserFailure('daemon-start-failed', 'runtime.json belongs to a different daemon identity')
      if (await isDaemonAlive(runtime, Math.max(1, Math.min(300, readinessDeadline - Date.now())))) {
        ensureWorkTime(signal, readinessDeadline)
        return
      }
    }
    await Bun.sleep(Math.max(1, Math.min(50, readinessDeadline - Date.now())))
  }
  const output = diagnostics?.() ?? ''
  throw new BrowserFailure(
    'daemon-readiness-timeout',
    `daemon did not become healthy within ${OPERATION_TIMEOUT_MS}ms`,
    output || undefined
  )
}

async function waitForChild(child: PipeChild, timeoutMs: number, signal?: AbortSignal, workDeadline?: number): Promise<number> {
  const deadline = Math.min(Date.now() + timeoutMs, workDeadline ?? Number.POSITIVE_INFINITY)
  while (Date.now() < deadline) {
    const aborted = stopError(signal)
    if (aborted) throw aborted
    const remaining = deadline - Date.now()
    const outcome = await Promise.race([
      child.exited.then((code) => ({ kind: 'exit' as const, code })),
      Bun.sleep(Math.max(1, Math.min(40, remaining))).then(() => ({ kind: 'sleep' as const }))
    ])
    if (outcome.kind === 'exit') return outcome.code
  }
  if (signal?.aborted) throw stopError(signal)!
  if (workDeadline !== undefined && Date.now() >= workDeadline) throw new BrowserFailure('deadline', 'browser parity work deadline reached')
  throw new BrowserFailure('cli-timeout', `CLI command timed out after ${timeoutMs}ms`)
}

async function stopChild(child: PipeChild): Promise<void> {
  if (child.exitCode !== null) return
  try { child.kill('SIGTERM') } catch { /* The child may have exited. */ }
  await Promise.race([child.exited, Bun.sleep(150)])
  if (child.exitCode === null) {
    try { child.kill('SIGKILL') } catch { /* The scope cleanup remains the final owner. */ }
    await Promise.race([child.exited, Bun.sleep(300)])
  }
}

function makeTailCapture(stream: ReadableStream<Uint8Array> | null, limit: number): TailCapture {
  const chunks: Buffer[] = []
  let size = 0
  const done = (async () => {
    if (!stream) return
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        if (chunk.length >= limit) {
          chunks.splice(0, chunks.length, chunk.subarray(chunk.length - limit))
          size = limit
          continue
        }
        chunks.push(chunk)
        size += chunk.length
        while (size > limit && chunks.length > 0) {
          const first = chunks[0]!
          const excess = size - limit
          if (first.length <= excess) {
            chunks.shift()
            size -= first.length
          } else {
            chunks[0] = first.subarray(excess)
            size -= excess
          }
        }
      }
    } catch {
      return
    } finally {
      reader.releaseLock()
    }
  })()
  return { done, text: () => Buffer.concat(chunks, size).toString('utf8') }
}

function makeHeadCapture(stream: ReadableStream<Uint8Array> | null, limit: number): HeadCapture {
  const chunks: Buffer[] = []
  let size = 0
  let overflow = false
  const done = (async () => {
    if (!stream) return
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (size >= limit) {
          overflow = true
          continue
        }
        const chunk = Buffer.from(value)
        const allowed = Math.min(chunk.length, limit - size)
        if (allowed > 0) {
          chunks.push(allowed === chunk.length ? chunk : chunk.subarray(0, allowed))
          size += allowed
        }
        if (allowed < chunk.length) overflow = true
      }
    } catch {
      return
    } finally {
      reader.releaseLock()
    }
  })()
  return { done, text: () => Buffer.concat(chunks, size).toString('utf8'), truncated: () => overflow }
}

function currentDiagnostics(home: string, scope: ProcessScope, captures: TailCapture[]): string {
  return boundedDiagnostic(captures.map((capture) => capture.text()).filter(Boolean).join('\n'), home, diagnosticTokens(scope, home))
}

export async function startBrowserWorld(options: {
  signal?: AbortSignal
  deadline?: number
  afterReady?: (world: BrowserWorld) => Promise<void>
  beforeBrowser?: boolean
} = {}): Promise<BrowserWorld> {
  const startedAt = Date.now()
  const defaultDeadline = startedAt + (options.beforeBrowser ? EARLY_WORK_DEADLINE_MS : WORK_DEADLINE_MS)
  const deadline = options.beforeBrowser ? Math.min(options.deadline ?? defaultDeadline, defaultDeadline) : options.deadline ?? defaultDeadline
  if (!Number.isFinite(deadline)) throw new BrowserFailure('deadline', 'browser parity work deadline is invalid')
  ensureWorkTime(options.signal, deadline)

  let scope: ProcessScope
  try {
    scope = createProcessScope()
  } catch (error) {
    throw new BrowserFailure('startup-failed', error instanceof Error ? error.message : String(error))
  }
  const home = scope.home
  const repoRoot = resolve(import.meta.dir, '../..')
  let env: Record<string, string> = {}
  let fixture: BrowserFixture | undefined
  let daemon: PipeChild | undefined
  let daemonIdentity: ProcessIdentity | undefined
  const cleanupTools = createCleanup(scope, home, () => env, () => fixture, () => daemon?.pid, () => daemonIdentity)
  const abortInFlight = async (error: unknown): Promise<never> => {
    const cleanup = await cleanupTools.cleanup()
    const failure = normalizeFailure(error, home, diagnosticTokens(scope, home))
    failure.cleanup = cleanup
    if (!cleanup.ok && cleanup.error) failure.message = boundedDiagnostic(`${failure.message}; cleanup failed: ${cleanup.error}`, home, diagnosticTokens(scope, home))
    throw failure
  }

  try {
    ensureWorkTime(options.signal, deadline)
    env = createBrowserEnvironment(home, repoRoot)
    env.QUIRKY_BROWSER_CHROME = requireInstalledChrome()
    requirePinnedHelper(repoRoot)
    const schemas = loadCliSchemas(repoRoot)
    fixture = startBrowserFixture()

    const daemonOut: TailCapture[] = []
    try {
      daemon = scope.spawn([process.execPath, join(repoRoot, 'packages/daemon/src/main.ts')], {
        cwd: repoRoot,
        env,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe'
      })
    } catch (error) {
      throw new BrowserFailure('daemon-start-failed', error instanceof Error ? error.message : String(error))
    }
    daemonOut.push(makeTailCapture(daemon.stdout, MAX_DIAGNOSTIC_BYTES), makeTailCapture(daemon.stderr, MAX_DIAGNOSTIC_BYTES))
    const daemonExited = daemon.exited
    const daemonDiagnostics = () => currentDiagnostics(home, scope, daemonOut)
    await waitForDaemon(home, daemon, deadline, options.signal, daemonDiagnostics)
    daemonIdentity = processSnapshot({ ...env, ...scope.env, HOME: home, QUIRKY_HOME: home }).get(daemon.pid)
    if (!daemonIdentity) throw new BrowserFailure('daemon-start-failed', 'ready daemon process identity could not be captured')

    const cli = async (argv: string[], cliOptions: { allowFailure?: boolean; timeoutMs?: number } = {}): Promise<CliReceipt> => {
      ensureWorkTime(options.signal, deadline)
      if (!Array.isArray(argv) || argv.some((argument) => typeof argument !== 'string')) {
        throw new BrowserFailure('invalid-cli-arguments', 'CLI arguments must be literal strings')
      }
      if (argv.some((argument) => argument === '--runtime' || argument.startsWith('--runtime=') || argument === '--pairing-code' || argument.startsWith('--pairing-code='))) {
        throw new BrowserFailure('invalid-cli-arguments', 'runtime selection is fixed to the owned local daemon')
      }
      if (!(await daemonStatus(home, daemon!.pid, deadline))) throw new BrowserFailure('daemon-exited', 'owned daemon is not healthy; refusing CLI auto-start')

      const limit = Math.min(
        OPERATION_TIMEOUT_MS,
        Math.max(0, cliOptions.timeoutMs ?? OPERATION_TIMEOUT_MS),
        deadline - Date.now()
      )
      if (limit <= 0) throw new BrowserFailure('deadline', 'browser parity work deadline reached')
      const command = [process.execPath, join(repoRoot, 'packages/cli/src/main.ts'), '--runtime', 'local', '--json', ...argv]
      let child: PipeChild
      try {
        child = scope.spawn(command, {
          cwd: repoRoot,
          env,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe'
        })
      } catch (error) {
        throw new BrowserFailure('cli-start-failed', error instanceof Error ? error.message : String(error))
      }
      const stdout = makeHeadCapture(child.stdout, MAX_CLI_OUTPUT_BYTES)
      const stderr = makeTailCapture(child.stderr, MAX_DIAGNOSTIC_BYTES)
      let exitCode: number
      try {
        exitCode = await waitForChild(child, limit, options.signal, deadline)
      } catch (error) {
        await stopChild(child)
        await Promise.all([stdout.done, stderr.done])
        const tail = boundedDiagnostic(stderr.text(), home, diagnosticTokens(scope, home))
        const failure = normalizeFailure(error, home, diagnosticTokens(scope, home))
        failure.stderrTail = tail
        throw failure
      }
      await Promise.all([stdout.done, stderr.done])
      const stdoutText = stdout.text()
      const stderrText = stderr.text()
      if (stdout.truncated()) throw new BrowserFailure('cli-output-too-large', 'CLI output exceeded the bounded capture limit', boundedDiagnostic(stderrText, home, diagnosticTokens(scope, home)))
      const decoded = decodeCliReceipt(argv, stdoutText, stderrText, exitCode, home, true, {
        schemas,
        tokens: diagnosticTokens(scope, home)
      })
      const receipt: CliReceipt = { ...decoded, argv: [...command] }
      if (exitCode !== 0 && !(cliOptions.allowFailure ?? false)) {
        const after = readRuntime(home)
        if (!after || after.pid !== daemon!.pid || !(await isDaemonAlive(after, Math.max(1, Math.min(300, deadline - Date.now()))))) {
          throw new BrowserFailure('daemon-exited', 'owned daemon exited during the CLI operation', receipt.stderrTail)
        }
        throw new BrowserFailure('cli-nonzero', `CLI command exited with code ${exitCode}`, receipt.stderrTail)
      }
      return receipt
    }

    const world: BrowserWorld = {
      home,
      env,
      fixture,
      worktreeA: '',
      worktreeB: '',
      daemonPid: daemon.pid,
      daemonExited,
      cli,
      cleanup: cleanupTools.cleanup,
      processEvidence: cleanupTools.processEvidence
    }

    const repositoriesRoot = join(home, 'repositories')
    const repositoryA = join(repositoriesRoot, "repo A ' ; $")
    const repositoryB = join(repositoriesRoot, 'repo B')
    mkdirSync(repositoryA, { recursive: true, mode: 0o700 })
    mkdirSync(repositoryB, { recursive: true, mode: 0o700 })
    const addedA = await cli(['repo', 'add', repositoryA, '--folder'])
    const addedB = await cli(['repo', 'add', repositoryB, '--folder'])
    const repoResultA = addedA.result
    const repoResultB = addedB.result
    if (repoResultA === null || typeof repoResultA !== 'object' || Array.isArray(repoResultA) ||
      !('id' in repoResultA) || typeof repoResultA.id !== 'string' ||
      repoResultB === null || typeof repoResultB !== 'object' || Array.isArray(repoResultB) ||
      !('id' in repoResultB) || typeof repoResultB.id !== 'string') {
      throw new BrowserFailure('malformed-cli-json', 'repo add did not return repository identities')
    }
    const repoIdA = repoResultA.id
    const repoIdB = repoResultB.id
    const listA = await cli(['worktree', 'list', '--repo', repoIdA])
    const listB = await cli(['worktree', 'list', '--repo', repoIdB])
    if (!Array.isArray(listA.result) || !Array.isArray(listB.result)) throw new BrowserFailure('malformed-cli-json', 'worktree list did not return arrays')
    const worktreeRowsA: unknown[] = listA.result
    const worktreeRowsB: unknown[] = listB.result
    const worktreeA = worktreeRowsA.find((item) => item !== null && typeof item === 'object' && !Array.isArray(item) &&
      'path' in item && item.path === repositoryA && 'repoId' in item && item.repoId === repoIdA)
    const worktreeB = worktreeRowsB.find((item) => item !== null && typeof item === 'object' && !Array.isArray(item) &&
      'path' in item && item.path === repositoryB && 'repoId' in item && item.repoId === repoIdB)
    if (worktreeA === undefined || worktreeA === null || typeof worktreeA !== 'object' || Array.isArray(worktreeA) ||
      !('id' in worktreeA) || typeof worktreeA.id !== 'string' || !('kind' in worktreeA) || worktreeA.kind !== 'folder' ||
      worktreeB === undefined || worktreeB === null || typeof worktreeB !== 'object' || Array.isArray(worktreeB) ||
      !('id' in worktreeB) || typeof worktreeB.id !== 'string' || !('kind' in worktreeB) || worktreeB.kind !== 'folder') {
      throw new BrowserFailure('malformed-cli-json', 'worktree list did not resolve both folder worktrees')
    }
    world.worktreeA = worktreeA.id
    world.worktreeB = worktreeB.id

    ensureWorkTime(options.signal, deadline)
    if (options.afterReady) await withinDeadline(options.afterReady(world), options.signal, deadline)
    ensureWorkTime(options.signal, deadline)
    if (!(await daemonStatus(home, daemon.pid, deadline))) throw new BrowserFailure('daemon-exited', 'owned daemon exited after readiness')
    return world
  } catch (error) {
    return await abortInFlight(error)
  }
}
