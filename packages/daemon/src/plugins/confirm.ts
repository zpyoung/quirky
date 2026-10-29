import { createHash } from 'node:crypto'
import { RpcErrorCode, type Ask } from '@quirky/protocol'
import { conflict, confirmationRequired, DaemonError, internal } from '../errors'
import type { Store } from '../store'
import type { DispatchSource } from './dispatch'
import { canonicalJson, LazyPruner } from './requests'

const ASK_CREATE = 'quirky.ask/create'
const ASK_LIST = 'quirky.ask/list'
const ASKS_OFF = 'this action needs confirmation and asks are off; pass --yes'

export type ConfirmStore = Pick<Store, 'getConfirmation' | 'putConfirmation' | 'markConfirmationUsed' | 'pruneConfirmations'>

/** Calls a method through the dispatcher; how confirmations reach `quirky.ask` and `describe` methods. */
export type CallMethod = (method: string, params: Record<string, unknown>, from: DispatchSource) => Promise<unknown>

/** Produces a destructive kernel method's whole action text; see `DispatcherOptions.kernelDescribers`. */
export type KernelDescriber = (params: Record<string, unknown>, from: DispatchSource) => Promise<string>

/**
 * What a destructive method declares: its `confirm` text and the full name of its `describe`
 * method, or for a kernel method a `describeWith` function that replaces both.
 */
export type ConfirmTarget = { method: string; confirm: string; describe?: string; describeWith?: KernelDescriber }

/** `confirm` with each `{name}` replaced by `String(params[name])`; a name with no value stays as written. */
export function fillConfirm(confirm: string, params: Record<string, unknown>): string {
  return confirm.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    Object.hasOwn(params, name) && params[name] !== undefined ? String(params[name]) : placeholder
  )
}

/** The question a person is asked and the digest the answer is bound to. */
export type PreparedConfirmation = { action: string; digest: string }

const isMethodNotFound = (error: unknown) => error instanceof DaemonError && error.code === RpcErrorCode.MethodNotFound

/** The caller identity a confirmation is bound to; plugin and kernel callers have none. */
function identityOf(from: DispatchSource) {
  if (!('conn' in from)) return { cwd: null, sessionId: null, worktreeId: null }
  const { cwd, sessionId, worktreeId } = from.conn
  return { cwd: cwd ?? null, sessionId: sessionId ?? null, worktreeId: worktreeId ?? null }
}

/**
 * Gates destructive calls on an answered confirm ask. `request` opens the ask for one exact call
 * (method, params, caller and resolved action text); `consume` accepts that ask once, only for the
 * same call.
 */
export class Confirmations {
  private readonly now: () => number
  private readonly pruner: LazyPruner

  constructor(
    private readonly store: ConfirmStore,
    private readonly call: CallMethod,
    options: { now?: () => number; log?: (message: string) => void } = {}
  ) {
    this.now = options.now ?? Date.now
    this.pruner = new LazyPruner(
      (cutoff) => store.pruneConfirmations(cutoff),
      this.now,
      (count) => options.log?.(`confirmations: pruned ${count} record${count === 1 ? '' : 's'}`)
    )
  }

  /**
   * Resolves the action text for `target` with `params` as `from` (the `describe` method's answer,
   * else the `confirm` text with `{name}` filled from params) and digests it with the call and the
   * caller's cwd, session and worktree. `params` must not contain `yes` or `confirmation`.
   * Resolves null when the `describe` method returned null: nothing irreversible, so no ask.
   */
  async prepare(target: ConfirmTarget, params: Record<string, unknown>, from: DispatchSource): Promise<PreparedConfirmation | null> {
    const action = await this.actionText(target, params, from)
    if (action === null) return null
    const { cwd, sessionId, worktreeId } = identityOf(from)
    const digest = createHash('sha256')
      .update(canonicalJson([target.method, params, cwd, sessionId, worktreeId, action]))
      .digest('hex')
    return { action, digest }
  }

  /**
   * Rejects with Conflict when `askId` names no confirmation or one already used. Runs before the
   * action text is computed, so a replay after the target is gone reports the reuse and not the
   * `describe` method's NotFound.
   */
  assertUnused(askId: string): void {
    const row = this.store.getConfirmation(askId)
    if (!row) throw conflict('confirmation is for another call')
    if (row.used) throw conflict('confirmation already used')
  }

  /**
   * Opens a confirm ask for the call and rejects with ConfirmationRequired naming it. Rejects with
   * Conflict when `quirky.ask` is not available.
   */
  async request(method: string, prepared: PreparedConfirmation, from: DispatchSource): Promise<never> {
    const { sessionId, worktreeId } = identityOf(from)
    const params = {
      spec: { title: 'Confirm', questions: [{ id: 'confirm', type: 'confirm', question: prepared.action }] },
      ...(sessionId !== null ? { session: sessionId } : {}),
      ...(worktreeId !== null ? { worktree: worktreeId } : {})
    }
    let created: unknown
    try {
      created = await this.call(ASK_CREATE, params, { kernel: true })
    } catch (error) {
      throw isMethodNotFound(error) ? conflict(ASKS_OFF) : error
    }
    const askId = (created as { askId?: unknown } | null)?.askId
    if (typeof askId !== 'string') throw internal(`${ASK_CREATE} returned no askId`)
    this.store.putConfirmation({ askId, method, digest: prepared.digest, used: false, createdAt: this.now() })
    this.pruner.touch()
    throw confirmationRequired({ askId, action: prepared.action })
  }

  /**
   * Accepts ask `askId` as the go-ahead for the call with `digest`, once. Rejects with Conflict
   * `confirmation is for another call`, `confirmation already used`, `declined` or
   * `confirmation not answered yet`.
   */
  async consume(askId: string, method: string, digest: string): Promise<void> {
    const row = this.store.getConfirmation(askId)
    if (!row || row.method !== method || row.digest !== digest) throw conflict('confirmation is for another call')
    if (row.used) throw conflict('confirmation already used')

    let asks: Ask[]
    try {
      asks = (await this.call(ASK_LIST, { askId }, { kernel: true })) as Ask[]
    } catch (error) {
      throw isMethodNotFound(error) ? conflict(ASKS_OFF) : error
    }
    // Confirmations are kernel-created local asks. Inspect their durable outcome without
    // entering the connection-bound long-poll API or borrowing a client's session authority.
    const envelope = asks.find((ask) => ask.id === askId)?.envelope
    if (!envelope) throw conflict('confirmation unavailable: ask is unknown or has expired')
    if (envelope.status === 'pending') throw conflict('confirmation not answered yet')
    if (envelope.status === 'unavailable') throw conflict(`confirmation unavailable: ${envelope.reason}`)
    const answer = envelope.answers?.confirm
    if (envelope.status !== 'answered' || !answer || !('value' in answer) || answer.value !== true) throw conflict('declined')
    if (!this.store.markConfirmationUsed(askId)) throw conflict('confirmation already used')
  }

  private async actionText(target: ConfirmTarget, params: Record<string, unknown>, from: DispatchSource): Promise<string | null> {
    if (target.describeWith) return await target.describeWith(params, from)
    if (target.describe) {
      const text = await this.call(target.describe, params, from)
      if (text === null) return null
      if (typeof text !== 'string') throw internal(`${target.describe} must return a string`)
      return text
    }
    return fillConfirm(target.confirm, params)
  }
}
