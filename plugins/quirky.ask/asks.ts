import type { Ask, AskAnswer, AskEnvelope, AskQuestion, AskSpec, PluginStore } from '@quirky/protocol'

/** Longest a single `wait` holds the connection. */
export const MAX_WAIT_MS = 60000

/** Builds the errors the RPC layer reports as InvalidParams, NotFound and Conflict. */
export type AskErrors = {
  invalidParams(message: string): Error
  notFound(message: string): Error
  conflict(message: string): Error
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validates an untrusted ask spec and returns it in canonical form. */
export function parseAskSpec(value: unknown, errors: Pick<AskErrors, 'invalidParams'>): AskSpec {
  const invalid = errors.invalidParams
  if (!isRecord(value)) throw invalid('spec must be an object')
  if (!Array.isArray(value.questions) || value.questions.length === 0) {
    throw invalid('spec.questions must be a non-empty array')
  }
  if (value.title !== undefined && typeof value.title !== 'string') throw invalid('spec.title must be a string')
  const seen = new Set<string>()
  const questions = value.questions.map((raw, index): AskQuestion => {
    if (!isRecord(raw)) throw invalid(`spec.questions[${index}] must be an object`)
    const { id, type, question } = raw
    if (typeof id !== 'string' || id === '') throw invalid(`spec.questions[${index}].id must be a string`)
    if (seen.has(id)) throw invalid(`duplicate question id: ${id}`)
    seen.add(id)
    if (typeof question !== 'string') throw invalid(`spec.questions[${index}].question must be a string`)
    if (type === 'select' || type === 'multiselect') {
      if (!Array.isArray(raw.options) || raw.options.length === 0) {
        throw invalid(`spec.questions[${index}].options must be a non-empty array`)
      }
      for (const option of raw.options) {
        if (!isRecord(option) || typeof option.value !== 'string' || typeof option.label !== 'string') {
          throw invalid(`spec.questions[${index}].options need string value and label`)
        }
      }
    } else if (type !== 'text' && type !== 'confirm') {
      throw invalid(`spec.questions[${index}].type must be select, multiselect, text or confirm`)
    }
    return raw as AskQuestion
  })
  return { ...(value.title !== undefined ? { title: value.title as string } : {}), questions }
}

type AskRow = {
  id: string
  spec: string
  session_id: string | null
  worktree_id: string | null
  created_at: number
  status: AskEnvelope['status']
  answers: string
  skipped: string
}

function toAsk(row: AskRow): Ask {
  return {
    id: row.id,
    spec: JSON.parse(row.spec) as AskSpec,
    sessionId: row.session_id,
    worktreeId: row.worktree_id,
    createdAt: row.created_at,
    envelope: {
      status: row.status,
      askId: row.id,
      answers: JSON.parse(row.answers),
      skipped: JSON.parse(row.skipped),
      summary: ''
    },
    seq: 0,
    queued: false,
    partial: {},
    expiresAt: null
  }
}

/** What an `AskService` tells the rest of the daemon. */
export type AskServiceHooks = {
  created(ask: Ask): void
  resolved(askId: string, envelope: AskEnvelope): void
}

type Waiter = { resolve(envelope: AskEnvelope): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** Asks persisted in the plugin's store, with long-poll waiters held in memory. */
export class AskService {
  private readonly waiters = new Map<string, Set<Waiter>>()
  private stopped = false

  constructor(
    private readonly store: PluginStore,
    private readonly errors: AskErrors,
    private readonly hooks: AskServiceHooks
  ) {}

  /** Stores a pending ask for a validated spec and announces it. */
  create(specInput: unknown, sessionId: string | null, worktreeId: string | null): Ask {
    const spec = parseAskSpec(specInput, this.errors)
    const id = `ask_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`
    const ask: Ask = {
      id,
      spec,
      sessionId,
      worktreeId,
      createdAt: Date.now(),
      envelope: { status: 'pending', askId: id, answers: {}, skipped: [], summary: '' },
      seq: 0,
      queued: false,
      partial: {},
      expiresAt: null
    }
    this.store.run(
      'INSERT INTO asks (id, spec, session_id, worktree_id, created_at, status, answers, skipped) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ask.id,
      JSON.stringify(spec),
      sessionId,
      worktreeId,
      ask.createdAt,
      'pending',
      '{}',
      '[]'
    )
    this.hooks.created(ask)
    return ask
  }

  get(askId: string): Ask {
    const row = this.store.get<AskRow>('SELECT * FROM asks WHERE id = ?', askId)
    if (!row) throw this.errors.notFound(`no such ask: ${askId}`)
    return toAsk(row)
  }

  /** Every ask in creation order, optionally only those still pending. */
  list(pendingOnly: boolean): Ask[] {
    const rows = this.store.all<AskRow>(
      pendingOnly ? "SELECT * FROM asks WHERE status = 'pending' ORDER BY created_at, id" : 'SELECT * FROM asks ORDER BY created_at, id'
    )
    return rows.map(toAsk)
  }

  /**
   * Resolves as soon as the ask leaves `pending`, or returns it still pending after `timeoutMs`.
   * If the service is shut down while the wait is pending, the promise rejects with a "shut down"
   * error instead of reading the store, which the host closes right after deactivation.
   */
  async wait(askId: string, timeoutMs = MAX_WAIT_MS): Promise<AskEnvelope> {
    if (this.stopped) throw new Error('quirky.ask has shut down')
    const ask = this.get(askId)
    const limit = Math.max(0, Math.min(timeoutMs, MAX_WAIT_MS))
    if (ask.envelope.status !== 'pending' || limit === 0) return ask.envelope
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (envelope) => {
          clearTimeout(waiter.timer)
          resolve(envelope)
        },
        reject: (error) => {
          clearTimeout(waiter.timer)
          reject(error)
        },
        timer: setTimeout(() => {
          this.removeWaiter(askId, waiter)
          try {
            resolve(this.get(askId).envelope)
          } catch (error) {
            reject(error as Error)
          }
        }, limit)
      }
      this.addWaiter(askId, waiter)
    })
  }

  /** Clears every wait timer and rejects each pending waiter; call before the store closes. */
  shutdown(): void {
    this.stopped = true
    const pending = [...this.waiters.values()].flatMap((set) => [...set])
    this.waiters.clear()
    for (const waiter of pending) waiter.reject(new Error('quirky.ask shut down while the wait was pending'))
  }

  answer(askId: string, answersInput: unknown, skippedInput: unknown): AskEnvelope {
    const ask = this.get(askId)
    if (!isRecord(answersInput)) throw this.errors.invalidParams('answers must be an object')
    if (
      skippedInput !== undefined &&
      (!Array.isArray(skippedInput) || skippedInput.some((id) => typeof id !== 'string'))
    ) {
      throw this.errors.invalidParams('skipped must be an array of question ids')
    }
    if (ask.envelope.status !== 'pending') throw this.errors.conflict(`ask ${askId} is already ${ask.envelope.status}`)
    const skipped = (skippedInput as string[] | undefined) ?? []
    return this.resolve(ask, skipped.length > 0 ? 'partial' : 'answered', answersInput as Record<string, AskAnswer>, skipped)
  }

  /** Declines a pending ask; an ask that already finished is returned unchanged. */
  cancel(askId: string): AskEnvelope {
    const ask = this.get(askId)
    if (ask.envelope.status !== 'pending') return ask.envelope
    return this.resolve(ask, 'declined', {}, [])
  }

  private resolve(
    ask: Ask,
    status: AskEnvelope['status'],
    answers: Record<string, AskAnswer>,
    skipped: string[]
  ): AskEnvelope {
    const envelope: AskEnvelope = { status, askId: ask.id, answers, skipped, summary: '' }
    this.store.run(
      'UPDATE asks SET status = ?, answers = ?, skipped = ? WHERE id = ?',
      status,
      JSON.stringify(answers),
      JSON.stringify(skipped),
      ask.id
    )
    this.hooks.resolved(ask.id, envelope)
    const waiting = this.waiters.get(ask.id)
    this.waiters.delete(ask.id)
    for (const waiter of waiting ?? []) waiter.resolve(envelope)
    return envelope
  }

  private addWaiter(askId: string, waiter: Waiter): void {
    const set = this.waiters.get(askId) ?? new Set()
    set.add(waiter)
    this.waiters.set(askId, set)
  }

  private removeWaiter(askId: string, waiter: Waiter): void {
    const set = this.waiters.get(askId)
    set?.delete(waiter)
    if (set?.size === 0) this.waiters.delete(askId)
  }
}
