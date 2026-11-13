import { isDeepStrictEqual } from 'node:util'
import { createHash } from 'node:crypto'
import { startBrowserWorld, BrowserFailure, boundedDiagnostic, type BrowserWorld, type CliReceipt } from './browser-world'
import { readBrowserTable, validateBrowserTable, type BrowserRow } from './browser-table'
import { tabChecks } from './browser-checks-tabs'
import { actionChecks } from './browser-checks-actions'
import { stateChecks } from './browser-checks-state'
import { networkChecks } from './browser-checks-network'

export type Evidence = Record<string, unknown>
export type BrowserCheck = { id: string; run(c: CheckContext): Promise<Evidence> }
export type CheckContext = {
  world: BrowserWorld
  state: { profileA: string; profileB: string; pageA: string; pageB: string; peer: string; [key: string]: unknown }
  call<T = Record<string, unknown>>(words: string, flags?: Record<string, string | number | boolean>, page?: string): Promise<T>
  probe(words: string, flags?: Record<string, string | number | boolean>, page?: string): Promise<CliReceipt>
  observe<T = unknown>(expression: string, page?: string): Promise<T>
  assert(condition: unknown, message: string): void
  equal(actual: unknown, expected: unknown, message?: string): void
}
export type BrowserRowResult = {
  id: string; status: 'passed' | 'gap' | 'excluded' | 'failed' | 'not-run'; elapsedMs: number; executed: boolean
  evidence: Evidence; reason?: string; error?: { kind: string; message: string; stderrTail?: string }
}
export type BrowserParityReport = {
  schemaVersion: 1; scope: 'goal-10-browser'; ok: boolean; parityComplete: boolean; rows: BrowserRowResult[]
  cleanup: { ok: boolean; error?: string; evidence?: Evidence }; elapsedMs: number
  error?: { kind: string; message: string; stderrTail?: string }
}
export const browserChecks: BrowserCheck[] = [...tabChecks, ...actionChecks, ...stateChecks, ...networkChecks]

function summarize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(summarize)
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    if (typeof object.data === 'string') {
      const bytes = Buffer.from(object.data, 'base64')
      return { format: object.format ?? (bytes.subarray(0, 4).toString() === '%PDF' ? 'pdf' : 'binary'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
    }
    return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, summarize(entry)]))
  }
  return value
}

function failure(error: unknown, home: string): NonNullable<BrowserRowResult['error']> {
  return { kind: error instanceof BrowserFailure ? error.kind : 'assertion', message: boundedDiagnostic(error instanceof Error ? error.message : String(error), home),
    ...(error instanceof BrowserFailure && error.stderrTail ? { stderrTail: boundedDiagnostic(error.stderrTail, home) } : {}) }
}

export function validateOutcomes(rows: BrowserRow[], outcomes: BrowserRowResult[], checks: BrowserCheck[]): void {
  const registry = new Set(checks.map(check => check.id))
  if (new Set(outcomes.map(result => result.id)).size !== outcomes.length || outcomes.length !== rows.length) throw new BrowserFailure('invalid-report', 'row outcomes must be unique and complete')
  for (const row of rows) {
    const result = outcomes.find(result => result.id === row.id)
    if (!result) throw new BrowserFailure('invalid-report', `missing result ${row.id}`)
    if (result.status === 'passed' && (!result.executed || !row.check || !registry.has(row.check) || row.deferred)) throw new BrowserFailure('invalid-report', `unobserved pass ${row.id}`)
    if (result.status === 'gap' && (row.disposition !== 'gap' || !result.reason || (!result.executed && !row.deferred))) throw new BrowserFailure('invalid-report', `undeclared gap ${row.id}`)
  }
}

export async function runBrowserParity(options: {
  rows?: BrowserRow[]; checks?: BrowserCheck[]; signal?: AbortSignal
  startWorld?: typeof startBrowserWorld
} = {}): Promise<BrowserParityReport> {
  const started = Date.now()
  const rows = options.rows ?? readBrowserTable()
  const checks = options.checks ?? browserChecks
  const results = new Map<string, BrowserRowResult>()
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason ?? new BrowserFailure('deadline', 'run interrupted'))
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timer = setTimeout(() => controller.abort(new BrowserFailure('deadline', '460 second work deadline reached')), 460_000)
  let world: BrowserWorld | undefined
  let operationError: BrowserParityReport['error']
  let cleanup: BrowserParityReport['cleanup'] = { ok: true }
  try {
    if (!options.rows) validateBrowserTable(rows, checks.map(check => check.id))
    world = await (options.startWorld ?? startBrowserWorld)({ signal: controller.signal, deadline: started + 460_000 })
    let receipts: CliReceipt[] = []
    const state: CheckContext['state'] = { profileA: '', profileB: '', pageA: '', pageB: '', peer: '' }
    const probe: CheckContext['probe'] = async (words, flags = {}, page = state.pageA) => {
      const args = ['browser', ...words.split(' ')]
      const targeted = page ? { page, worktree: page === state.pageB ? world!.worktreeB : world!.worktreeA, ...flags } : flags
      for (const [key, value] of Object.entries(targeted)) {
        if (typeof value === 'boolean') { if (value) args.push(`--${key}`) }
        else args.push(`--${key}`, String(value))
      }
      const receipt = await world!.cli(args, { allowFailure: true })
      receipts.push({ ...receipt, result: summarize(receipt.result) })
      return receipt
    }
    const call: CheckContext['call'] = async <T>(words: string, flags?: Record<string, string | number | boolean>, page?: string): Promise<T> => {
      const receipt = await probe(words, flags, page)
      if (receipt.exitCode !== 0) throw new BrowserFailure('cli-nonzero', `${words}: ${JSON.stringify(receipt.result)}`, receipt.stderrTail)
      // The world validates successful CLI payloads against their public method schema.
      return receipt.result as T
    }
    const c: CheckContext = { world, state, probe, call,
      observe: async <T>(expression: string, page?: string): Promise<T> => (await call<{ value: T }>('eval', { expression }, page)).value,
      assert(condition, message) { if (!condition) throw new BrowserFailure('wrong-page', message) },
      equal(actual, expected, message = 'unexpected observed state') { if (!isDeepStrictEqual(actual, expected)) throw new BrowserFailure('wrong-page', `${message}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`) }
    }
    for (const check of checks) {
      const row = rows.find(row => row.check === check.id)
      if (!row || row.deferred || row.disposition === 'excluded') continue
      const time = Date.now()
      receipts = []
      try {
        controller.signal.throwIfAborted()
        const cancelled = Promise.withResolvers<never>()
        const interrupt = () => cancelled.reject(controller.signal.reason)
        controller.signal.addEventListener('abort', interrupt, { once: true })
        let evidence: Evidence
        try { evidence = await Promise.race([check.run(c), cancelled.promise]) }
        finally { controller.signal.removeEventListener('abort', interrupt) }
        const gap = typeof evidence.gap === 'string' ? evidence.gap : undefined
        if (gap && row.disposition !== 'gap') throw new BrowserFailure('invalid-report', `check ${row.id} returned undeclared gap`)
        results.set(row.id, { id: row.id, status: gap ? 'gap' : 'passed', executed: true, elapsedMs: Date.now() - time, evidence: { ...evidence, receipts }, ...(gap ? { reason: gap } : {}) })
      } catch (error) {
        results.set(row.id, { id: row.id, status: 'failed', executed: true, elapsedMs: Date.now() - time, evidence: { receipts }, error: failure(error, world.home) })
        break
      }
    }
    if (![...results.values()].some(row => row.status === 'failed')) {
      const missing = rows.find(row => !row.deferred && row.disposition !== 'excluded' && !results.has(row.id))
      if (missing) results.set(missing.id, { id: missing.id, status: 'failed', executed: false, elapsedMs: 0, evidence: {}, error: { kind: 'missing-check', message: `no executing check for ${missing.id}` } })
    }
  } catch (error) {
    operationError = failure(error, world?.home ?? '')
    if (error instanceof BrowserFailure && error.cleanup) cleanup = error.cleanup
  }
  finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    if (world) {
      try { cleanup = await world.cleanup() }
      catch (error) { cleanup = { ok: false, error: failure(error, world.home).message } }
    }
  }
  const outcomes = rows.map(row => results.get(row.id) ?? {
    id: row.id, status: row.disposition === 'excluded' ? 'excluded' : row.deferred ? 'gap' : 'not-run',
    elapsedMs: 0, executed: false, evidence: {}, ...(row.reason ? { reason: row.reason } : {})
  } satisfies BrowserRowResult)
  try { validateOutcomes(rows, outcomes, checks) }
  catch (error) { operationError ??= failure(error, world?.home ?? '') }
  const ok = !operationError && cleanup.ok && outcomes.every(row => ['passed', 'gap', 'excluded'].includes(row.status))
  return { schemaVersion: 1, scope: 'goal-10-browser', ok, parityComplete: ok && outcomes.every(row => ['passed', 'excluded'].includes(row.status)),
    rows: outcomes, cleanup, elapsedMs: Date.now() - started, ...(operationError ? { error: operationError } : {}) }
}
