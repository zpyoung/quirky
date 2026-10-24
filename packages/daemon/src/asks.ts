import type {
  Ask,
  AskAnswer,
  AskEnvelope,
  AskQuestion,
  AskSpec,
  QuirkyEvent
} from '@quirky/protocol'
import { conflict, invalidParams, notFound } from './errors'
import type { Store } from './store'

const MAX_WAIT_MS = 60000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validates an untrusted ask spec and returns it in canonical form. */
export function parseAskSpec(value: unknown): AskSpec {
  if (!isRecord(value)) throw invalidParams('spec must be an object')
  if (!Array.isArray(value.questions) || value.questions.length === 0) {
    throw invalidParams('spec.questions must be a non-empty array')
  }
  if (value.title !== undefined && typeof value.title !== 'string') {
    throw invalidParams('spec.title must be a string')
  }
  const seen = new Set<string>()
  const questions = value.questions.map((raw, index): AskQuestion => {
    if (!isRecord(raw)) throw invalidParams(`spec.questions[${index}] must be an object`)
    const { id, type, question } = raw
    if (typeof id !== 'string' || id === '') throw invalidParams(`spec.questions[${index}].id must be a string`)
    if (seen.has(id)) throw invalidParams(`duplicate question id: ${id}`)
    seen.add(id)
    if (typeof question !== 'string') throw invalidParams(`spec.questions[${index}].question must be a string`)
    if (type === 'select' || type === 'multiselect') {
      if (!Array.isArray(raw.options) || raw.options.length === 0) {
        throw invalidParams(`spec.questions[${index}].options must be a non-empty array`)
      }
      for (const option of raw.options) {
        if (!isRecord(option) || typeof option.value !== 'string' || typeof option.label !== 'string') {
          throw invalidParams(`spec.questions[${index}].options need string value and label`)
        }
      }
    } else if (type !== 'text' && type !== 'confirm') {
      throw invalidParams(`spec.questions[${index}].type must be select, multiselect, text or confirm`)
    }
    return raw as AskQuestion
  })
  return { ...(value.title !== undefined ? { title: value.title as string } : {}), questions }
}

export type AskServiceHooks = {
  emit(event: QuirkyEvent): void
  notify(title: string, body: string, ids: { sessionId?: string; worktreeId?: string }): void
  worktreeIdForSession(sessionId: string): string | null
}

/** Asks persisted in SQLite, with long-poll waiters held in memory. */
export class AskService {
  private readonly waiters = new Map<string, Set<(envelope: AskEnvelope) => void>>()

  constructor(
    private readonly store: Store,
    private readonly hooks: AskServiceHooks
  ) {}

  create(specInput: unknown, sessionId?: string, worktreeId?: string): Ask {
    const spec = parseAskSpec(specInput)
    const ask: Ask = {
      id: `ask_${randomId()}`,
      spec,
      sessionId: sessionId ?? null,
      worktreeId: worktreeId ?? (sessionId ? this.hooks.worktreeIdForSession(sessionId) : null),
      createdAt: Date.now(),
      envelope: { status: 'pending', askId: '', answers: {}, skipped: [] }
    }
    ask.envelope.askId = ask.id
    this.store.insertAsk(ask)
    this.hooks.emit({ type: 'ask.created', ask })
    this.hooks.notify(spec.title ?? 'Question', spec.questions[0].question, {
      sessionId: ask.sessionId ?? undefined,
      worktreeId: ask.worktreeId ?? undefined
    })
    return ask
  }

  /** Creates an ask and resolves with its final envelope. */
  createAndWait(spec: unknown, sessionId: string): Promise<AskEnvelope> {
    const ask = this.create(spec, sessionId)
    return new Promise((resolve) => this.addWaiter(ask.id, resolve))
  }

  get(askId: string): Ask {
    const ask = this.store.getAsk(askId)
    if (!ask) throw notFound(`no such ask: ${askId}`)
    return ask
  }

  list(pendingOnly: boolean): Ask[] {
    return this.store.listAsks(pendingOnly)
  }

  /** Resolves as soon as the ask leaves `pending`, or returns it still pending after `timeoutMs`. */
  async wait(askId: string, timeoutMs = MAX_WAIT_MS): Promise<AskEnvelope> {
    const ask = this.get(askId)
    if (ask.envelope.status !== 'pending') return ask.envelope
    const limit = Math.max(0, Math.min(timeoutMs, MAX_WAIT_MS))
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeWaiter(askId, onResolved)
        resolve(this.get(askId).envelope)
      }, limit)
      const onResolved = (envelope: AskEnvelope) => {
        clearTimeout(timer)
        resolve(envelope)
      }
      this.addWaiter(askId, onResolved)
    })
  }

  answer(askId: string, answersInput: unknown, skippedInput: unknown): AskEnvelope {
    const ask = this.get(askId)
    if (!isRecord(answersInput)) throw invalidParams('answers must be an object')
    if (
      skippedInput !== undefined &&
      (!Array.isArray(skippedInput) || skippedInput.some((id) => typeof id !== 'string'))
    ) {
      throw invalidParams('skipped must be an array of question ids')
    }
    if (ask.envelope.status !== 'pending') throw conflict(`ask ${askId} is already ${ask.envelope.status}`)
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
    const envelope: AskEnvelope = { status, askId: ask.id, answers, skipped }
    this.store.updateAskEnvelope(envelope)
    this.hooks.emit({ type: 'ask.resolved', askId: ask.id, envelope })
    const waiting = this.waiters.get(ask.id)
    this.waiters.delete(ask.id)
    for (const resolve of waiting ?? []) resolve(envelope)
    return envelope
  }

  private addWaiter(askId: string, waiter: (envelope: AskEnvelope) => void): void {
    const set = this.waiters.get(askId) ?? new Set()
    set.add(waiter)
    this.waiters.set(askId, set)
  }

  private removeWaiter(askId: string, waiter: (envelope: AskEnvelope) => void): void {
    const set = this.waiters.get(askId)
    set?.delete(waiter)
    if (set?.size === 0) this.waiters.delete(askId)
  }
}

export function randomId(length = 12): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, length)
}
