import { randomUUID } from 'node:crypto'
import {
  ACTION_NAME_PATTERN,
  MAX_TITLE_LENGTH,
  findTextQuestion,
  formatViewErrors,
  textAnswerError,
  validateViewSpec,
  type RefusedAttempt,
  type StoredViewRecord,
  type ViewAction,
  type ViewChangeKind,
  type ViewSpec,
  type ViewValidationError
} from './catalog'
import { applyPatch } from './patch'
import type { ViewStore } from './store'

export const MAX_WAIT_MS = 60_000
export const MAX_REJECTED_SOURCE_BYTES = 64 * 1024
const MAX_WAITERS_PER_VIEW = 8
const MAX_ACTION_DATA_BYTES = 16 * 1024
const MAX_SOURCE_LENGTH = 80
const MAX_RENDER_ERROR_LENGTH = 2000
const UNTITLED = 'Untitled view'

export type WaitResult = { action: ViewAction } | { status: 'timeout' } | { status: 'closed' }

export type ActionRoute = { delivered: 'wait' } | { delivered: 'message' }

export type RenderFailedResult = { ok: true } | { duplicate: true } | { ignored: true }

type Refusal = { sessionId: string; attempt: Exclude<RefusedAttempt, 'render'>; view?: StoredViewRecord; title: string; errors: ViewValidationError[]; source: string }

export type ViewServiceDeps = {
  emit(event: string, data: unknown): void
  /** Delivers text to the session as a message; rejects when the session can't take it. */
  send(sessionId: string, text: string): Promise<unknown>
  invalidParams(message: string): Error
  notFound(message: string): Error
  conflict(message: string): Error
  now?: () => Date
  newId?: () => string
}

type Waiter = { resolve(result: WaitResult): void; settle(): void }

/** The text an agent receives when a view action reaches it as a message. */
export function actionMessage(action: ViewAction, title: string): string {
  return `View action "${action.name}" from "${title}" (view ${action.viewId}): ${JSON.stringify(action.data ?? {})}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function capped(text: string): string {
  const bytes = Buffer.from(text)
  return bytes.length <= MAX_REJECTED_SOURCE_BYTES ? text : bytes.subarray(0, MAX_REJECTED_SOURCE_BYTES).toString()
}

function stringified(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

function readableTitle(value: unknown): string {
  const title = isPlainObject(value) && typeof value.title === 'string' ? value.title.trim() : ''
  return title === '' ? UNTITLED : title.slice(0, MAX_TITLE_LENGTH)
}

/**
 * The lifecycle of views: open, update, patch, close, reopen, done, move, wait, action and render
 * failures. An update or patch on a closed view reopens it and clears done. Every spec is checked
 * before it is stored and every stored spec is a version; a refused one is announced as `rejected`,
 * is never a version, and marks the view it was meant for as refused.
 */
export class ViewService {
  private readonly waiters = new Map<string, Set<Waiter>>()
  private readonly now: () => Date
  private readonly newId: () => string

  constructor(
    private readonly views: ViewStore,
    private readonly deps: ViewServiceDeps
  ) {
    this.now = deps.now ?? (() => new Date())
    this.newId = deps.newId ?? (() => `view_${randomUUID().replaceAll('-', '').slice(0, 12)}`)
  }

  /** Stores a new view for the session; a refused spec emits `rejected` and throws invalid-params. */
  open(sessionId: string, rawSpec: unknown, placement: unknown): { viewId: string } {
    if (placement !== undefined && placement !== 'inline' && placement !== 'pane') {
      throw this.deps.invalidParams("placement must be 'inline' or 'pane'")
    }
    const spec = this.checked(sessionId, rawSpec, 'open')
    const at = this.now().toISOString()
    const record: StoredViewRecord = {
      viewId: this.newId(),
      sessionId,
      title: spec.title,
      spec,
      placement: placement ?? 'pane',
      movedByUser: false,
      updates: 0,
      createdAt: at,
      updatedAt: at,
      closed: false,
      done: false,
      version: 1,
      latestVersion: 1,
      refused: null
    }
    this.views.insert(record)
    this.changed(record, 'open')
    return { viewId: record.viewId }
  }

  /** Makes the spec the view's next version, reopening the view; placement and its user override stay as they are. */
  update(sessionId: string, viewId: string, rawSpec: unknown): StoredViewRecord {
    const existing = this.owned(sessionId, viewId)
    const spec = this.checked(sessionId, rawSpec, 'update', existing)
    const record = this.views.appendVersion(viewId, spec, this.now())
    this.changed(record, 'update')
    return record
  }

  /**
   * Applies RFC 6902 ops to the latest spec as the next version. All or nothing: a bad op or an
   * invalid result is refused like a refused update and leaves the stored spec alone.
   */
  patch(sessionId: string, viewId: string, rawOps: unknown): { viewId: string; version: number } {
    const existing = this.owned(sessionId, viewId)
    let ops = rawOps
    let source: string
    if (typeof rawOps === 'string') {
      source = rawOps
      try {
        ops = JSON.parse(rawOps)
      } catch (error) {
        this.reject({ sessionId, attempt: 'patch', view: existing, title: existing.title, source, errors: [{ path: 'ops', message: `ops is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }] })
      }
    } else {
      source = stringified(rawOps)
    }
    const result = applyPatch(existing.spec, ops)
    if (!result.ok) this.reject({ sessionId, attempt: 'patch', view: existing, title: existing.title, source, errors: result.errors })
    const record = this.views.appendVersion(viewId, (result as { ok: true; spec: ViewSpec }).spec, this.now())
    this.changed(record, 'patch')
    return { viewId, version: record.version }
  }

  close(sessionId: string, viewId: string): StoredViewRecord {
    const existing = this.owned(sessionId, viewId)
    if (existing.closed) return existing
    const record = this.views.close(viewId)!
    this.finishWaiters(viewId, { status: 'closed' })
    this.changed(record, 'close')
    return record
  }

  /** Brings a closed view back; an open view is returned as it is, with no event. */
  reopen(viewId: string): StoredViewRecord {
    const existing = this.get(viewId)
    if (!existing.closed) return existing
    const record = this.views.reopen(viewId)!
    this.changed(record, 'reopen')
    return record
  }

  /** Marks the view's work as over, or live again; setting the value it already has emits nothing. */
  setDone(viewId: string, done: boolean): StoredViewRecord {
    const existing = this.get(viewId)
    if (existing.done === done) return existing
    const record = this.views.setDone(viewId, done)!
    this.changed(record, 'done')
    return record
  }

  list(sessionId: string): StoredViewRecord[] {
    return this.views.listBySession(sessionId)
  }

  /** The view at `version`, or its latest version when none is given; an unknown version is not found. */
  get(viewId: string, version?: number): StoredViewRecord {
    const record = version === undefined ? this.views.get(viewId) : this.views.getVersion(viewId, version)
    if (!record) throw this.deps.notFound(version === undefined || !this.views.get(viewId) ? `view ${viewId} not found` : `view ${viewId} has no version ${version}`)
    return record
  }

  /**
   * The window could not draw `version`. The latest version of an open view is marked refused and
   * the agent is told once per `(viewId, version)` when its session can take the message; a failure
   * for any other version is ignored.
   */
  async renderFailed(viewId: string, version: unknown, error: unknown): Promise<RenderFailedResult> {
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) throw this.deps.invalidParams('version must be a positive integer')
    if (typeof error !== 'string' || error.trim() === '') throw this.deps.invalidParams('error must be a non-empty string')
    const record = this.get(viewId)
    if (record.closed || version !== record.latestVersion) return { ignored: true }
    if (!this.views.claimRenderReport(viewId, version)) return { duplicate: true }
    const message = error.slice(0, MAX_RENDER_ERROR_LENGTH)
    const refused = this.views.setRefused(viewId, {
      attempt: 'render',
      version,
      errors: [message],
      source: capped(stringified(record.spec)),
      at: this.now().getTime()
    })!
    this.changed(refused, 'render-failed')
    try {
      await this.deps.send(record.sessionId, `Visual "${record.title}" v${version} didn't render: ${message}. Fix it with quirky view update or patch (view ${viewId}).`)
    } catch {
      // the session is not live; the refused state is still recorded for the window
    }
    return { ok: true }
  }

  /** Records where the user wants the view; later updates keep it there. */
  move(viewId: string, placement: unknown): StoredViewRecord {
    if (placement !== 'inline' && placement !== 'pane') throw this.deps.invalidParams("placement must be 'inline' or 'pane'")
    if (this.get(viewId).closed) throw this.deps.conflict(`view ${viewId} is closed`)
    const record = this.views.moveByUser(viewId, placement)!
    this.changed(record, 'move')
    return record
  }

  /** Parks until an action arrives for the view, the view closes, `timeoutMs` passes or `signal` aborts. */
  wait(sessionId: string, viewId: string, timeoutMs: number | undefined, signal?: AbortSignal): Promise<WaitResult> {
    if (this.owned(sessionId, viewId).closed) return Promise.resolve({ status: 'closed' })
    const parked = this.waiters.get(viewId) ?? new Set<Waiter>()
    if (parked.size >= MAX_WAITERS_PER_VIEW) {
      throw Object.assign(this.deps.conflict(`view ${viewId} already has ${MAX_WAITERS_PER_VIEW} waits`), { data: { reason: 'runtime_busy' } })
    }
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const waiter: Waiter = {
        resolve: (result) => {
          waiter.settle()
          resolve(result)
        },
        settle: () => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          parked.delete(waiter)
          if (parked.size === 0 && this.waiters.get(viewId) === parked) this.waiters.delete(viewId)
        }
      }
      const onAbort = () => waiter.resolve({ status: 'timeout' })
      timer = setTimeout(() => waiter.resolve({ status: 'timeout' }), Math.min(Math.max(timeoutMs ?? MAX_WAIT_MS, 0), MAX_WAIT_MS))
      signal?.addEventListener('abort', onAbort, { once: true })
      parked.add(waiter)
      this.waiters.set(viewId, parked)
      if (signal?.aborted) onAbort()
    })
  }

  /**
   * Routes a click from the window: to the waits parked on the view if there are any, else to the
   * session as a message queued behind a working turn.
   */
  async action(viewId: string, name: unknown, source: unknown, data: unknown): Promise<ActionRoute> {
    const record = this.get(viewId)
    if (record.closed) throw this.deps.conflict(`view ${viewId} is closed`)
    if (typeof name !== 'string' || !ACTION_NAME_PATTERN.test(name)) throw this.deps.invalidParams('name must be 1 to 40 lowercase letters, digits or dashes')
    if (typeof source !== 'string' || source === '' || source.length > MAX_SOURCE_LENGTH) throw this.deps.invalidParams(`source must be a string of 1 to ${MAX_SOURCE_LENGTH} characters`)
    if (data !== undefined && (!isPlainObject(data) || JSON.stringify(data).length > MAX_ACTION_DATA_BYTES)) {
      throw this.deps.invalidParams(`data must be an object of at most ${MAX_ACTION_DATA_BYTES} bytes`)
    }
    if (source === 'field') {
      const question = findTextQuestion(record.spec.root, name)
      const value = isPlainObject(data) ? data.value : undefined
      if (question && typeof value === 'string') {
        const problem = textAnswerError(question, value)
        if (problem) throw this.deps.invalidParams(`value ${problem}`)
      }
    }
    const action: ViewAction = {
      name,
      viewId,
      source,
      at: this.now().toISOString(),
      ...(data === undefined ? {} : { data: data as Record<string, unknown> })
    }
    if ((this.waiters.get(viewId)?.size ?? 0) > 0) {
      this.finishWaiters(viewId, { action })
      return { delivered: 'wait' }
    }
    let result: unknown
    try {
      result = await this.deps.send(record.sessionId, actionMessage(action, record.title))
    } catch (error) {
      throw this.deps.conflict(`could not send the action to the agent: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (isPlainObject(result) && result.ok === false) {
      throw this.deps.conflict(`the agent did not take the action${typeof result.reason === 'string' ? `: ${result.reason}` : ''}`)
    }
    return { delivered: 'message' }
  }

  /** Releases every parked wait; the stored views stay. */
  shutdown(): void {
    for (const viewId of [...this.waiters.keys()]) this.finishWaiters(viewId, { status: 'timeout' })
  }

  private finishWaiters(viewId: string, result: WaitResult): void {
    for (const waiter of [...(this.waiters.get(viewId) ?? [])]) waiter.resolve(result)
  }

  private changed(record: StoredViewRecord, kind: ViewChangeKind): void {
    this.deps.emit('changed', { sessionId: record.sessionId, viewId: record.viewId, version: record.version, kind, placement: record.placement })
  }

  private owned(sessionId: string, viewId: string): StoredViewRecord {
    const record = this.views.get(viewId)
    if (!record || record.sessionId !== sessionId) throw this.deps.notFound(`view ${viewId} not found`)
    return record
  }

  private checked(sessionId: string, raw: unknown, attempt: 'open' | 'update', view?: StoredViewRecord): ViewSpec {
    let value = raw
    let source: string
    if (typeof raw === 'string') {
      source = raw
      try {
        value = JSON.parse(raw)
      } catch (error) {
        this.reject({ sessionId, attempt, view, title: readableTitle(raw), source, errors: [{ path: '', message: `spec is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }] })
      }
    } else {
      source = stringified(raw)
    }
    const result = validateViewSpec(value)
    if (!result.ok) this.reject({ sessionId, attempt, view, title: readableTitle(value), source, errors: result.errors })
    return (result as { ok: true; spec: ViewSpec }).spec
  }

  /** Records the refusal on the view it was meant for, announces it and fails the call with the errors. */
  private reject({ sessionId, attempt, view, title, errors, source }: Refusal): never {
    const lines = errors.map((error) => formatViewErrors([error]))
    const kept = capped(source)
    if (view) {
      const refused = this.views.setRefused(view.viewId, { attempt, version: null, errors: lines, source: kept, at: this.now().getTime() })!
      this.changed(refused, 'refused')
    }
    this.deps.emit('rejected', { sessionId, title, errors: lines, source: kept })
    throw this.deps.invalidParams(formatViewErrors(errors))
  }
}
