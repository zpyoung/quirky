import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'

let draftTick = 0

/** Returns the next order shared by UI state requests and settled draft writes. */
export function nextDraftTick(): number {
  return ++draftTick
}

/** Resolves false when the daemon kept another value; rejects when the write failed. */
export type DraftWrite<T> = (value: T) => Promise<boolean | void>

/** A post, save, or generation guarded by the field's target epoch. */
export type DraftAction<T> = {
  status(): 'same' | 'edited' | 'gone'
  take(): T
  succeed(cleared: T, options?: { send?: boolean }): void
  fail(): void
}

export type DraftField<T> = {
  value: T
  error: string | null
  edit(value: T): void
  hold(value: T): void
  reset(value: T): void
  settled(): Promise<void>
  begin(): DraftAction<T>
}

type DraftFieldInput<T> = {
  identity: string
  remote: T
  snapshot: number | undefined
  write: DraftWrite<T>
  refresh(): Promise<void>
  resend?: boolean
  equal?(left: T, right: T): boolean
}

type DraftFieldSnapshot<T> = { value: T; error: string | null }

type DraftWriteRequest<T> = {
  epoch: number
  revision: number
  value: T
}

/** Controller exposed for deterministic tests; the hook owns its mount lifecycle. */
export interface DraftFieldController<T> extends DraftField<T> {
  update(input: DraftFieldInput<T>): void
  subscribe(listener: () => void): () => void
  getSnapshot(): DraftFieldSnapshot<T>
  mount(): void
  unmount(): void
}

class DraftFieldControllerImpl<T> implements DraftFieldController<T> {
  private input: DraftFieldInput<T>
  private identity: string
  private epoch = 0
  private revision = 0
  private currentValue: T
  private currentError: string | null = null
  private view: DraftFieldSnapshot<T>
  private mounted = true
  private inFlight: DraftWriteRequest<T> | null = null
  private queued: DraftWriteRequest<T> | null = null
  private fence: number | null = null
  private dirty = false
  private held = false
  private blocked = false
  private retryPending = false
  private retryUsed = false
  private actionId = 0
  private activeAction: { id: number; epoch: number } | null = null
  private readonly listeners = new Set<() => void>()
  private readonly settleWaiters = new Set<() => void>()
  private readonly equal: (left: T, right: T) => boolean

  constructor(input: DraftFieldInput<T>) {
    this.input = input
    this.identity = input.identity
    this.currentValue = input.remote
    this.view = { value: input.remote, error: null }
    this.equal = (left, right) => this.input.equal?.(left, right) ?? Object.is(left, right)
  }

  get value(): T {
    return this.currentValue
  }

  get error(): string | null {
    return this.currentError
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  readonly getSnapshot = (): DraftFieldSnapshot<T> => this.view

  update(input: DraftFieldInput<T>): void {
    if (!this.mounted) return
    this.input = input
    if (input.identity !== this.identity) {
      this.identity = input.identity
      this.epoch++
      this.revision = 0
      this.currentValue = input.remote
      this.currentError = null
      this.fence = null
      this.dirty = false
      this.held = false
      this.blocked = false
      this.retryPending = false
      this.retryUsed = false
      this.queued = null
      this.activeAction = null
      this.publish()
      return
    }
    this.receiveSnapshot(input.remote, input.snapshot)
  }

  edit(value: T): void {
    if (!this.mounted) return
    this.revision++
    this.currentValue = value
    this.dirty = true
    this.held = false
    this.blocked = false
    this.retryPending = false
    this.retryUsed = false
    this.publish()
    this.enqueue({ epoch: this.epoch, revision: this.revision, value })
  }

  hold(value: T): void {
    if (!this.mounted) return
    this.revision++
    this.currentValue = value
    this.dirty = true
    this.held = true
    this.blocked = true
    this.retryPending = false
    this.retryUsed = false
    this.queued = null
    this.publish()
  }

  reset(value: T): void {
    if (!this.mounted) return
    this.revision++
    this.currentValue = value
    this.currentError = null
    this.fence = nextDraftTick()
    this.dirty = false
    this.held = false
    this.blocked = false
    this.retryPending = false
    this.retryUsed = false
    this.queued = null
    this.publish()
  }

  settled(): Promise<void> {
    if (!this.inFlight && !this.queued) return Promise.resolve()
    const { promise, resolve } = Promise.withResolvers<void>()
    this.settleWaiters.add(resolve)
    return promise
  }

  begin(): DraftAction<T> {
    const action = { id: ++this.actionId, epoch: this.epoch }
    this.activeAction = action
    let revision = this.revision
    let complete = false
    const current = () => this.epoch === action.epoch && this.activeAction?.id === action.id
    const status = () => {
      if (this.epoch !== action.epoch) return 'gone' as const
      return this.revision === revision ? 'same' as const : 'edited' as const
    }
    const take = () => {
      revision = this.revision
      return this.currentValue
    }
    const finish = (success: boolean, cleared?: T, send = false) => {
      if (complete) return
      if (!current()) {
        complete = true
        return
      }
      complete = true
      this.activeAction = null
      this.fence = nextDraftTick()
      const edited = this.revision !== revision
      if (!success) {
        if (edited) {
          this.dirty = true
          this.held = true
          this.blocked = true
          this.retryPending = false
        }
        this.publish()
        this.refreshIfIdle()
        return
      }
      if (edited) {
        this.dirty = true
        this.held = false
        this.blocked = false
        this.retryPending = false
        this.enqueue({ epoch: this.epoch, revision: this.revision, value: this.currentValue })
        return
      }
      this.currentValue = cleared as T
      this.currentError = null
      this.dirty = false
      this.held = false
      this.blocked = false
      this.retryPending = false
      this.retryUsed = false
      if (send) {
        this.revision++
        this.dirty = true
        this.enqueue({ epoch: this.epoch, revision: this.revision, value: this.currentValue })
      }
      this.publish()
      this.refreshIfIdle()
    }
    return {
      status,
      take,
      succeed: (cleared, options) => finish(true, cleared, options?.send ?? false),
      fail: () => finish(false),
    }
  }

  mount(): void {
    this.mounted = true
  }

  unmount(): void {
    if (!this.mounted) return
    this.mounted = false
    this.queued = null
    this.activeAction = null
    this.listeners.clear()
    this.resolveSettleWaiters()
  }

  private receiveSnapshot(remote: T, snapshot: number | undefined): void {
    if (this.activeAction || this.inFlight || this.queued || !this.isFresh(snapshot)) return
    if (this.dirty) {
      if (this.retryPending && !this.retryUsed && this.input.resend) {
        this.retryPending = false
        this.retryUsed = true
        this.blocked = true
        this.enqueue({ epoch: this.epoch, revision: this.revision, value: this.currentValue })
        return
      }
      if (this.held || this.blocked) return
      if (!this.equal(remote, this.currentValue)) this.currentValue = remote
      this.dirty = false
      this.held = false
      this.retryPending = false
      this.retryUsed = false
      this.publish()
      return
    }
    if (!this.equal(remote, this.currentValue)) {
      this.currentValue = remote
      this.publish()
    }
  }

  private isFresh(snapshot: number | undefined): boolean {
    return snapshot === undefined || this.fence === null || snapshot > this.fence
  }

  private enqueue(request: DraftWriteRequest<T>): void {
    if (!this.mounted) return
    this.queued = request
    if (this.inFlight) return
    this.startQueued()
  }

  private startQueued(): void {
    const request = this.queued
    if (!request || this.inFlight || !this.mounted) return
    this.queued = null
    if (request.epoch !== this.epoch) {
      this.resolveSettleWaiters()
      return
    }
    this.inFlight = request
    let reply: Promise<boolean | void>
    try {
      reply = Promise.resolve(this.input.write(request.value))
    } catch (error) {
      reply = Promise.reject(error)
    }
    void reply.then(
      (applied) => this.writeSettled(request, applied === false ? 'not-applied' : 'applied'),
      (error: unknown) => this.writeSettled(request, 'failed', error),
    )
  }

  private writeSettled(
    request: DraftWriteRequest<T>,
    outcome: 'applied' | 'not-applied' | 'failed',
    error?: unknown,
  ): void {
    const settledTick = nextDraftTick()
    if (this.inFlight !== request) return
    this.inFlight = null
    if (!this.mounted) {
      this.queued = null
      this.resolveSettleWaiters()
      return
    }
    this.fence = settledTick
    if (request.epoch === this.epoch) {
      if (this.queued?.epoch === this.epoch) {
        this.startQueued()
        return
      }
      this.queued = null
      if (request.revision === this.revision) this.applyWriteOutcome(outcome, error)
      this.refreshIfIdle()
    } else if (this.queued?.epoch === this.epoch) {
      this.startQueued()
      return
    } else {
      this.queued = null
    }
    this.resolveSettleWaiters()
  }

  private applyWriteOutcome(outcome: 'applied' | 'not-applied' | 'failed', error?: unknown): void {
    if (outcome === 'applied') {
      this.currentError = null
      this.blocked = false
      this.retryPending = false
      this.retryUsed = false
    } else if (outcome === 'not-applied') {
      this.currentError = null
      this.blocked = true
      this.retryPending = false
      this.retryUsed = true
    } else {
      this.currentError = error instanceof Error ? error.message : String(error)
      this.blocked = true
      this.retryPending = Boolean(this.input.resend && !this.retryUsed)
    }
    this.publish()
  }

  private refreshIfIdle(): void {
    if (!this.mounted || this.inFlight || this.queued) return
    try {
      void this.input.refresh().catch(() => {})
    } catch {
      return
    }
  }

  private publish(): void {
    if (Object.is(this.view.value, this.currentValue) && this.view.error === this.currentError) return
    this.view = { value: this.currentValue, error: this.currentError }
    if (this.mounted) for (const listener of this.listeners) listener()
  }

  private resolveSettleWaiters(): void {
    if (this.inFlight || this.queued) return
    const waiters = [...this.settleWaiters]
    this.settleWaiters.clear()
    for (const resolve of waiters) resolve()
  }
}

/** Creates the state machine used by the hook and deterministic controller tests. */
export function createDraftFieldController<T>(input: DraftFieldInput<T>): DraftFieldController<T> {
  return new DraftFieldControllerImpl(input)
}

/** Keeps one controller per hook instance and reconciles each committed state snapshot. */
export function useDraftField<T>(input: DraftFieldInput<T>): DraftField<T> {
  const controllerRef = useRef<DraftFieldController<T> | null>(null)
  if (controllerRef.current === null) controllerRef.current = createDraftFieldController(input)
  const controller = controllerRef.current
  useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  useLayoutEffect(() => {
    controller.mount()
    return () => controller.unmount()
  }, [controller])
  useLayoutEffect(() => controller.update(input))
  return controller
}

/** Captures the current identity epoch so a guard stays false after any target change. */
export function useTargetGuard(identity: string): () => () => boolean {
  const target = useRef<{ identity: string; epoch: number } | null>(null)
  if (target.current === null) target.current = { identity, epoch: 0 }
  const epoch = target.current.identity === identity ? target.current.epoch : target.current.epoch + 1
  useLayoutEffect(() => {
    if (target.current?.identity !== identity) {
      target.current = { identity, epoch: (target.current?.epoch ?? -1) + 1 }
    }
  }, [identity])
  return () => () => target.current?.epoch === epoch
}

/** Creates strictly increasing draft versions and rebases retries to the wall clock. */
export function createDraftVersions(now: () => number = Date.now): { next(): number; rebase(): number } {
  let version = 0
  return {
    next() {
      version = Math.max(version + 1, now() * 1000)
      return version
    },
    rebase() {
      version = Math.max(version, now() * 1000)
      return version
    },
  }
}
