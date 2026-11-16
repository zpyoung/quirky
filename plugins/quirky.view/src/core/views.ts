import { randomUUID } from 'node:crypto'
import {
  ACTION_NAME_PATTERN,
  MAX_TITLE_LENGTH,
  formatViewErrors,
  validateViewSpec,
  type ViewAction,
  type ViewPlacement,
  type ViewRecord,
  type ViewSpec,
  type ViewValidationError
} from './catalog'
import type { ViewStore } from './store'

export const MAX_WAIT_MS = 60_000
export const MAX_REJECTED_SOURCE_BYTES = 64 * 1024
const MAX_WAITERS_PER_VIEW = 8
const MAX_ACTION_DATA_BYTES = 16 * 1024
const MAX_SOURCE_LENGTH = 80
const UNTITLED = 'Untitled view'

export type WaitResult = { action: ViewAction } | { status: 'timeout' } | { status: 'closed' }

export type ActionRoute = { delivered: 'wait' } | { delivered: 'message' }

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

function readableTitle(value: unknown): string {
  const title = isPlainObject(value) && typeof value.title === 'string' ? value.title.trim() : ''
  return title === '' ? UNTITLED : title.slice(0, MAX_TITLE_LENGTH)
}

/**
 * The lifecycle of views: open, update, close, move, wait and action. Every spec is checked before
 * it is stored; a refused one is announced as `rejected` and never stored.
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
    const spec = this.checked(sessionId, rawSpec)
    const at = this.now().toISOString()
    const record: ViewRecord = {
      viewId: this.newId(),
      sessionId,
      title: spec.title,
      spec,
      placement: placement ?? 'inline',
      movedByUser: false,
      updates: 0,
      createdAt: at,
      updatedAt: at,
      closed: false
    }
    this.views.insert(record)
    this.changed(record)
    return { viewId: record.viewId }
  }

  /** Replaces the content of an open view in place; placement and its user override stay as they are. */
  update(sessionId: string, viewId: string, rawSpec: unknown): ViewRecord {
    this.ownedOpen(sessionId, viewId)
    const spec = this.checked(sessionId, rawSpec)
    const record = this.views.replaceSpec(viewId, spec, this.now().toISOString())!
    this.changed(record)
    return record
  }

  close(sessionId: string, viewId: string): ViewRecord {
    const existing = this.owned(sessionId, viewId)
    if (existing.closed) return existing
    const record = this.views.close(viewId)!
    this.finishWaiters(viewId, { status: 'closed' })
    this.changed(record)
    return record
  }

  list(sessionId: string): ViewRecord[] {
    return this.views.listBySession(sessionId)
  }

  get(viewId: string): ViewRecord {
    const record = this.views.get(viewId)
    if (!record) throw this.deps.notFound(`view ${viewId} not found`)
    return record
  }

  /** Records where the user wants the view; later updates keep it there. */
  move(viewId: string, placement: unknown): ViewRecord {
    if (placement !== 'inline' && placement !== 'pane') throw this.deps.invalidParams("placement must be 'inline' or 'pane'")
    if (this.get(viewId).closed) throw this.deps.conflict(`view ${viewId} is closed`)
    const record = this.views.moveByUser(viewId, placement)!
    this.changed(record)
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

  private changed(record: ViewRecord): void {
    this.deps.emit('changed', { sessionId: record.sessionId, viewId: record.viewId })
  }

  private owned(sessionId: string, viewId: string): ViewRecord {
    const record = this.views.get(viewId)
    if (!record || record.sessionId !== sessionId) throw this.deps.notFound(`view ${viewId} not found`)
    return record
  }

  private ownedOpen(sessionId: string, viewId: string): ViewRecord {
    const record = this.owned(sessionId, viewId)
    if (record.closed) throw this.deps.conflict(`view ${viewId} is closed; open a new one`)
    return record
  }

  private checked(sessionId: string, raw: unknown): ViewSpec {
    let value = raw
    let source: string
    if (typeof raw === 'string') {
      source = raw
      try {
        value = JSON.parse(raw)
      } catch (error) {
        this.reject(sessionId, raw, source, [{ path: '', message: `spec is not valid JSON: ${error instanceof Error ? error.message : String(error)}` }])
      }
    } else {
      try {
        source = JSON.stringify(raw, null, 2) ?? String(raw)
      } catch {
        source = String(raw)
      }
    }
    const result = validateViewSpec(value)
    if (!result.ok) this.reject(sessionId, value, source, result.errors)
    return (result as { ok: true; spec: ViewSpec }).spec
  }

  private reject(sessionId: string, value: unknown, source: string, errors: ViewValidationError[]): never {
    this.deps.emit('rejected', {
      sessionId,
      title: readableTitle(value),
      errors: errors.map((error) => formatViewErrors([error])),
      source: capped(source)
    })
    throw this.deps.invalidParams(formatViewErrors(errors))
  }
}
