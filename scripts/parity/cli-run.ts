import { createHash } from 'node:crypto'
import { readRuntime } from '@quirky/protocol/node'
import type { CliTableRow } from './cli-table'
import type { CliWorld, CliWorldOptions } from './cli-world'
import type { CliCheckContext } from './cli-checks'
import * as table from './cli-table'
import * as checks from './cli-checks'
import { createCliWorld } from './cli-world'

export type CliArguments = { json: boolean; help: boolean }
export type CliReceipt = {
  id: string
  command: string
  argv: string[]
  exitCode: number
  format: 'json' | 'jsonl'
  stdoutBytes: number
  elapsedMs: number
  evidence: Record<string, unknown>
}
export type CliCheckFailure = { checkId: string; kind: string; message: string; stderrTail?: string }
export type CliParityRow = {
  id: string
  status: 'passed' | 'mapped-only' | 'gap' | 'excluded' | 'delegated' | 'failed' | 'not-run'
  executed: boolean
  checks: string[]
  catalogRefs: string[]
  followUp?: string
  reason?: string
  error?: CliCheckFailure
}
export type CliParityReport = {
  schemaVersion: 1
  scope: 'goal-11-cli-commands'
  ok: boolean
  parityComplete: boolean
  providerMode: 'local-stand-ins'
  rows: CliParityRow[]
  receipts: CliReceipt[]
  error?: { stage: string; kind: string; message: string; stderrTail?: string }
  cleanup: { ok: boolean; error?: string }
  elapsedMs: number
}

export class CliRunFailure extends Error {
  constructor(readonly kind: string, message: string, readonly stderrTail?: string) { super(message) }
}

export function parseCliArgs(args: string[]): CliArguments {
  if (args.length === 0) return { json: false, help: false }
  if (args.length === 1 && args[0] === '--json') return { json: true, help: false }
  if (args.length === 1 && args[0] === '--help') return { json: false, help: true }
  throw new CliRunFailure('invalid-arguments', 'Usage: bun scripts/parity/cli.ts [--json | --help]')
}

export function parseCliOutput(stdout: string, format: 'json' | 'jsonl', exitCode: number): unknown {
  if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) throw new CliRunFailure('stdout-overflow', 'CLI stdout exceeded 16 MiB')
  let result: unknown
  try {
    if (format === 'json') result = JSON.parse(stdout)
    else {
      const lines = stdout.trim().split('\n')
      result = lines.map(line => {
        const value: unknown = JSON.parse(line)
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSONL record is not an object')
        return value
      })
    }
  } catch {
    if (exitCode !== 0) throw new CliRunFailure('cli-exit', `CLI exited ${exitCode}`)
    throw new CliRunFailure('malformed-output', `CLI did not emit valid ${format}`)
  }
  for (const value of format === 'jsonl' && Array.isArray(result) ? result : [result]) {
    if (value && typeof value === 'object' && 'error' in value && value.error != null) {
      const detail = typeof value.error === 'string' ? value.error :
        typeof value.error === 'object' && 'message' in value.error && typeof value.error.message === 'string' ? value.error.message : 'CLI returned an error envelope'
      throw new CliRunFailure(exitCode === 0 ? 'cli-error' : 'cli-exit', detail.slice(0, 1024))
    }
  }
  if (exitCode !== 0) throw new CliRunFailure('cli-exit', `CLI exited ${exitCode}`)
  return result
}

type CliRefusal = { code: string; message: string; data?: unknown }

function parseCliRefusal(stdout: string, exitCode: number): CliRefusal {
  if (exitCode === 0) throw new CliRunFailure('unexpected-success', 'CLI refusal command unexpectedly succeeded')
  if (exitCode !== 1) throw new CliRunFailure('cli-exit', `CLI refusal command exited ${exitCode}`)
  if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) throw new CliRunFailure('stdout-overflow', 'CLI stdout exceeded 16 MiB')
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new CliRunFailure('malformed-output', 'CLI did not emit a single JSON error envelope')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !Object.hasOwn(value, 'error')) {
    throw new CliRunFailure('malformed-output', 'CLI did not emit a single JSON error envelope')
  }
  const error = Reflect.get(value, 'error')
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    throw new CliRunFailure('malformed-output', 'CLI did not emit a single JSON error envelope')
  }
  const code = Reflect.get(error, 'code')
  const message = Reflect.get(error, 'message')
  if (typeof code !== 'string' || code.length === 0 || typeof message !== 'string' || message.length === 0) {
    throw new CliRunFailure('malformed-output', 'CLI did not emit a single JSON error envelope')
  }
  return { code, message, ...(Object.hasOwn(error, 'data') ? { data: Reflect.get(error, 'data') } : {}) }
}
type ImportedActorReceipt = {
  id: string
  argv: string[]
  stdout: string
  stderr: string
  exitCode: number
  stdoutBytes: number
  elapsedMs: number
  format: 'json' | 'jsonl'
}

function parseImportedActorReceipt(value: unknown): ImportedActorReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CliRunFailure('malformed-actor', 'Actor receipt is missing raw CLI fields')
  }
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || !Array.isArray(item.argv) || !item.argv.every((arg: unknown) => typeof arg === 'string') ||
      typeof item.stdout !== 'string' || typeof item.stderr !== 'string' || typeof item.exitCode !== 'number' ||
      typeof item.stdoutBytes !== 'number' || typeof item.elapsedMs !== 'number' ||
      (item.format !== 'json' && item.format !== 'jsonl')) {
    throw new CliRunFailure('malformed-actor', 'Actor receipt is missing raw CLI fields')
  }
  const receipt = item as ImportedActorReceipt
  if (!receipt.argv.includes('--json') ||
      !receipt.argv.some((arg, index) => arg === '--runtime' && receipt.argv[index + 1] === 'local')) {
    throw new CliRunFailure('malformed-actor', 'Actor command omitted explicit local JSON mode')
  }
  return receipt
}


export function reduceCliRows(
  rows: CliTableRow[], receipts: CliReceipt[], proven: ReadonlySet<string>,
  catalogRefs: ReadonlyMap<string, string[]>, failure?: CliCheckFailure
): CliParityRow[] {
  const successful = new Set(receipts.filter(receipt => receipt.exitCode === 0 && receipt.stdoutBytes > 0).map(receipt => receipt.id))
  const invoked = new Set(receipts.map(receipt => receipt.id))
  return rows.map(row => {
    const result: CliParityRow = {
      id: row.id, status: row.disposition === 'covered' ? 'not-run' : row.disposition,
      executed: false, checks: row.checks, catalogRefs: catalogRefs.get(row.id) ?? [],
      ...(row.reason ? { reason: row.reason } : {}), ...(row.followUp ? { followUp: row.followUp } : {})
    }
    if (row.disposition === 'mapped-only' && result.catalogRefs.length === 0) result.status = 'not-run'
    if (row.disposition !== 'covered') return result
    if (failure && row.checks.includes(failure.checkId)) {
      result.status = 'failed'
      result.executed = invoked.has(failure.checkId)
      result.error = failure
    } else if (row.checks.length > 0 && row.checks.every(id => successful.has(id) && proven.has(id)) && result.catalogRefs.length > 0) {
      result.status = 'passed'
      result.executed = true
    }
    return result
  })
}

export type CliReportInput = {
  rows: CliTableRow[]
  receipts: CliReceipt[]
  proven: ReadonlySet<string>
  catalogRefs: ReadonlyMap<string, string[]>
  failure?: CliCheckFailure
  cleanupError?: string
  elapsedMs: number
}

export function buildCliReport(input: CliReportInput): CliParityReport {
  let failure = input.failure
  let outcomes = reduceCliRows(input.rows, input.receipts, input.proven, input.catalogRefs, failure)
  const incomplete = outcomes.find(row => row.status === 'not-run' || row.status === 'failed')
  if (!failure && incomplete) {
    failure = { checkId: incomplete.checks.find(id => !input.proven.has(id)) ?? incomplete.id, kind: 'missing-receipt', message: `Required evidence incomplete for ${incomplete.id}` }
    outcomes = reduceCliRows(input.rows, input.receipts, input.proven, input.catalogRefs, failure)
  }
  const ok = !failure && !input.cleanupError
  return {
    schemaVersion: 1, scope: 'goal-11-cli-commands', ok,
    parityComplete: ok && outcomes.every(row => row.status === 'passed' || row.status === 'excluded'),
    providerMode: 'local-stand-ins', rows: outcomes, receipts: input.receipts,
    ...(failure ? { error: { stage: failure.checkId, kind: failure.kind, message: failure.message, ...(failure.stderrTail ? { stderrTail: failure.stderrTail } : {}) } } : {}),
    cleanup: { ok: !input.cleanupError, ...(input.cleanupError ? { error: input.cleanupError } : {}) }, elapsedMs: input.elapsedMs
  }
}

export type CliRunOptions = {
  signal?: AbortSignal
  hooks?: CliWorldOptions['hooks']
  onActorLive?: () => Promise<void> | void
  createWorld?: (options: CliWorldOptions) => Promise<CliWorld>
  runChecks?: (context: CliCheckContext) => Promise<void>
  cleanupChecks?: (context: CliCheckContext) => Promise<void>
}

export async function runCliParity(options: CliRunOptions = {}): Promise<CliParityReport> {
  const started = Date.now()
  const controller = new AbortController()
  const forwardAbort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', forwardAbort, { once: true })
  if (options.signal?.aborted) forwardAbort()
  const timer = setTimeout(() => controller.abort(new CliRunFailure('deadline', 'CLI rehearsal work deadline exceeded')), 340_000)
  const receipts: CliReceipt[] = []
  const refusalReceipts = new Set<string>()
  const proven = new Set<string>()
  const catalogRefs = new Map<string, string[]>()
  const tokens: string[] = []
  let rows: CliTableRow[] = []
  let world: CliWorld | undefined
  let context: CliCheckContext | undefined
  let currentCheck = 'inventory'
  let failure: CliCheckFailure | undefined
  let cleanupError: string | undefined
  let cleanupMode = false
  let cleanupDeadline = 0
  const cleanupController = new AbortController()
  const diagnostic = (value: string) => {
    let text = value
    if (world) text = text.split(world.home).join('<cli-home>')
    for (const token of tokens) if (token) text = text.split(token).join('<redacted>')
    return text.replace(/((?:token|authorization|secret|password)\s*[=:]\s*)[^\s,"'}]+/gi, '$1<redacted>').slice(-8192)
  }
  const errorRecord = (error: unknown): CliCheckFailure => {
    const kind = error && typeof error === 'object' && 'kind' in error && typeof error.kind === 'string' ? error.kind : 'assertion'
    const checkId = error && typeof error === 'object' && 'checkId' in error && typeof error.checkId === 'string' ? error.checkId : currentCheck
    const stderr = error && typeof error === 'object' && 'stderrTail' in error && typeof error.stderrTail === 'string' ? error.stderrTail : undefined
    return { checkId, kind, message: diagnostic(error instanceof Error ? error.message : String(error)), ...(stderr ? { stderrTail: diagnostic(stderr) } : {}) }
  }
  const recordReceipt = (id: string, argv: string[], raw: { stdout: string; stderr: string; exitCode: number; stdoutBytes: number; elapsedMs: number }, format: 'json' | 'jsonl') => {
    if (receipts.some(receipt => receipt.id === id)) throw new CliRunFailure('duplicate-receipt', `Duplicate receipt ${id}`)
    receipts.push({ id, command: argv.slice(0, 2).join(' '), argv, exitCode: raw.exitCode, format, stdoutBytes: raw.stdoutBytes, elapsedMs: raw.elapsedMs, evidence: {} })
  }
  const adopt = (id: string, argv: string[], raw: { stdout: string; stderr: string; exitCode: number; stdoutBytes: number; elapsedMs: number }, format: 'json' | 'jsonl') => {
    recordReceipt(id, argv, raw, format)
    try { return parseCliOutput(raw.stdout, format, raw.exitCode) }
    catch (error) {
      throw new CliRunFailure(error instanceof CliRunFailure ? error.kind : 'malformed-output', error instanceof Error ? error.message : String(error), diagnostic(raw.stderr))
    }
  }
  try {
    rows = table.loadCliTable()
    table.validateInventory(table.loadCliInventory(), rows, checks.checkIds)
    currentCheck = 'startup'
    world = await (options.createWorld ?? createCliWorld)({ signal: controller.signal, deadline: started + 340_000, hooks: options.hooks })
    const runtime = readRuntime(world.home)
    if (runtime) tokens.push(runtime.token, runtime.hookToken)
    const liveWorld = world
    context = {
      world, state: {},
      check(id) {
        currentCheck = id
        const signal = cleanupMode ? cleanupController.signal : controller.signal
        signal.throwIfAborted()
      },
      async call(id, argv, format = 'json', executeOptions: { cwd?: string } = {}) {
        const signal = cleanupMode ? cleanupController.signal : controller.signal
        signal.throwIfAborted()
        const remaining = (cleanupMode ? cleanupDeadline : started + 340_000) - Date.now()
        if (remaining <= 0) throw new CliRunFailure('deadline', 'No command time remains')
        const args = [...argv, '--runtime', 'local', '--json']
        try {
          const raw = await liveWorld.execute([process.execPath, liveWorld.paths.cliEntry, ...args], {
            signal, timeoutMs: Math.min(15_000, remaining), cwd: executeOptions.cwd
          })
          return adopt(id, args, raw, format)
        } catch (error) {
          if (!receipts.some(receipt => receipt.id === id) && error && typeof error === 'object' &&
              'stdoutBytes' in error && typeof error.stdoutBytes === 'number' &&
              'elapsedMs' in error && typeof error.elapsedMs === 'number' &&
              'exitCode' in error && typeof error.exitCode === 'number') {
            recordReceipt(id, args, {
              stdout: '', stderr: '', exitCode: error.exitCode, stdoutBytes: error.stdoutBytes, elapsedMs: error.elapsedMs
            }, format)
          }
          throw error
        }
      },
      async refuse(id, argv, executeOptions: { cwd?: string } = {}) {
        const signal = cleanupMode ? cleanupController.signal : controller.signal
        signal.throwIfAborted()
        const remaining = (cleanupMode ? cleanupDeadline : started + 340_000) - Date.now()
        if (remaining <= 0) throw new CliRunFailure('deadline', 'No command time remains')
        if (receipts.some(receipt => receipt.id === id)) throw new CliRunFailure('duplicate-receipt', `Duplicate receipt ${id}`)
        const args = [...argv, '--runtime', 'local', '--json']
        refusalReceipts.add(id)
        try {
          const raw = await liveWorld.execute([process.execPath, liveWorld.paths.cliEntry, ...args], {
            signal, timeoutMs: Math.min(15_000, remaining), cwd: executeOptions.cwd
          })
          recordReceipt(id, args, raw, 'json')
          return parseCliRefusal(raw.stdout, raw.exitCode)
        } catch (error) {
          if (!receipts.some(receipt => receipt.id === id) && error && typeof error === 'object' &&
              'stdoutBytes' in error && typeof error.stdoutBytes === 'number' &&
              'elapsedMs' in error && typeof error.elapsedMs === 'number' &&
              'exitCode' in error && typeof error.exitCode === 'number') {
            recordReceipt(id, args, {
              stdout: '', stderr: '', exitCode: error.exitCode, stdoutBytes: error.stdoutBytes, elapsedMs: error.elapsedMs
            }, 'json')
          }
          throw error
        }
      },
      prove(id, evidence) {
        const receipt = receipts.find(receipt => receipt.id === id && receipt.exitCode === 0 && receipt.stdoutBytes > 0)
        if (!receipt || refusalReceipts.has(id)) {
          throw new CliRunFailure('missing-receipt', `No successful invocation for ${id}`)
        }
        receipt.evidence = evidence
        proven.add(id)
      },
      importActor(value) {
        if (!Array.isArray(value)) throw new CliRunFailure('malformed-actor', 'Actor receipts must be an array')
        for (const item of value) {
          const receipt = parseImportedActorReceipt(item)
          currentCheck = receipt.id
          adopt(receipt.id, receipt.argv, {
            stdout: receipt.stdout,
            stderr: receipt.stderr,
            exitCode: receipt.exitCode,
            stdoutBytes: receipt.stdoutBytes,
            elapsedMs: receipt.elapsedMs
          }, receipt.format)
        }
      },
      importActorRefusal(value) {
        const receipt = parseImportedActorReceipt(value)
        currentCheck = receipt.id
        recordReceipt(receipt.id, receipt.argv, {
          stdout: receipt.stdout,
          stderr: receipt.stderr,
          exitCode: receipt.exitCode,
          stdoutBytes: receipt.stdoutBytes,
          elapsedMs: receipt.elapsedMs
        }, receipt.format)
        refusalReceipts.add(receipt.id)
        return parseCliRefusal(receipt.stdout, receipt.exitCode)
      },
      async onActorLive() {
        await liveWorld.actorLive()
        await options.onActorLive?.()
      }
    }
    currentCheck = 'catalog'
    const catalog = await context.call('catalog', ['api'])
    const references = table.validateCatalog(catalog, rows)
    for (const reference of references) catalogRefs.set(reference.rowId, reference.refs)
    if (!catalog || typeof catalog !== 'object' || !('schemaVersion' in catalog)) throw new CliRunFailure('catalog-mismatch', 'Missing catalog schema')
    const counts: Record<string, number> = {}
    for (const key of ['commands', 'methods', 'events', 'uiCommands']) {
      const entries: unknown = Reflect.get(catalog, key)
      if (!Array.isArray(entries)) throw new CliRunFailure('catalog-mismatch', `Missing catalog ${key}`)
      counts[key] = entries.length
    }
    context.prove('catalog', { schemaVersion: catalog.schemaVersion, counts, checkedRows: references.filter(reference => reference.refs.length > 0).length, digest: createHash('sha256').update(JSON.stringify(catalog)).digest('hex') })
    await (options.runChecks ?? checks.runCliChecks)(context)
  } catch (error) {
    failure = errorRecord(error)
    if (error && typeof error === 'object' && 'cleanupError' in error && typeof error.cleanupError === 'string') cleanupError = diagnostic(error.cleanupError)
  }
  finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', forwardAbort)
    cleanupMode = true
    cleanupDeadline = Math.min(started + 360_000, Date.now() + 20_000)
    const cleanupTimer = setTimeout(() => {
      cleanupController.abort(new CliRunFailure('cleanup-deadline', 'CLI cleanup deadline exceeded'))
      world?.scope.killNow()
    }, Math.max(1, cleanupDeadline - Date.now()))
    try {
      if (context) {
        await (options.cleanupChecks ?? checks.cleanupCliChecks)(context)
      }
    } catch (error) { cleanupError = [cleanupError, errorRecord(error).message].filter(Boolean).join('; ') }
    finally {
      try { await world?.cleanup() }
      catch (error) { cleanupError = [cleanupError, errorRecord(error).message].filter(Boolean).join('; ') }
      clearTimeout(cleanupTimer)
    }
  }
  const report = buildCliReport({ rows, receipts, proven, catalogRefs, failure, cleanupError, elapsedMs: Date.now() - started })
  return JSON.parse(diagnosticReport(JSON.stringify(report)))

  function diagnosticReport(text: string): string {
    if (world) text = text.split(world.home).join('<cli-home>')
    for (const token of tokens) if (token) text = text.split(token).join('<redacted>')
    return text
  }
}
