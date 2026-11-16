import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { Button, SectionHeader, TextField } from '@quirky/ui'
import type { Ask, AskAnswer, AskEnvelope, QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { AskCard } from './AskCard'
import { ASK_FALLBACK_TITLE } from './store'

export const CARD_VIEW_ID = 'view:quirky.ask/card'

export type CardViewInput = { askId: string; sessionApproveDisabled?: string }

type Decision = 'allow' | 'always' | 'deny'

const DECISION_LABELS: Record<Decision, string> = {
  allow: 'Allow once',
  always: 'Allow for this session',
  deny: 'Deny'
}

const RECORD_LABELS: Record<Decision, string> = {
  allow: 'Allowed once',
  always: 'Allowed for this session',
  deny: 'Denied'
}

const CARD_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-12)',
  minWidth: 0,
  padding: 'var(--ui-space-12)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-control)',
  background: 'var(--ui-surface)'
}

const COMMAND_STYLE: CSSProperties = {
  margin: 0,
  fontFamily: 'var(--ui-font-mono)',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere'
}

const ACTIONS_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  gap: 'var(--ui-space-8)',
  minWidth: 0
}

const RECORD_STYLE: CSSProperties = {
  margin: 0,
  padding: 'var(--ui-space-6) var(--ui-space-12)',
  minWidth: 0,
  overflowWrap: 'anywhere'
}

const DECISION_VALUES: readonly string[] = ['allow', 'always', 'deny']

type ApprovalShape = { command: string }

/** Matches the ask a runner creates for an approval: a `decision` select with exactly the three decision values, then an optional `reason` text. */
function approvalOf(ask: Ask): ApprovalShape | null {
  const [decision, reason, ...rest] = ask.spec.questions
  if (!decision || rest.length > 0 || decision.id !== 'decision' || decision.type !== 'select') return null
  const values = decision.options.map((option) => option.value)
  if (values.length !== DECISION_VALUES.length || !DECISION_VALUES.every((value) => values.includes(value))) return null
  if (reason && (reason.id !== 'reason' || reason.type !== 'text')) return null
  return { command: decision.question }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error))

function answerText(answers: Record<string, AskAnswer>, id: string): string | undefined {
  const answer = answers[id]
  return answer && 'value' in answer && typeof answer.value === 'string' && answer.value.trim() ? answer.value : undefined
}

function approvalRecord(ask: Ask, approval: ApprovalShape): string {
  const { envelope } = ask
  if (envelope.status === 'timed_out') return `Expired: ${approval.command}`
  if (envelope.status === 'declined') return `Dismissed: ${approval.command}`
  if (envelope.status === 'unavailable') return `Unavailable: ${envelope.reason}`
  const decision = answerText(envelope.answers, 'decision')
  if (decision === 'deny') return `Denied: ${answerText(envelope.answers, 'reason') ?? approval.command}`
  if (decision === 'allow' || decision === 'always') return `${RECORD_LABELS[decision]}: ${approval.command}`
  return `Answered: ${approval.command}`
}

function ordinaryRecord(ask: Ask): string {
  const { envelope } = ask
  const title = ask.spec.title ?? ASK_FALLBACK_TITLE
  if (envelope.status === 'timed_out') return `Expired: ${title}`
  if (envelope.status === 'declined') return `Dismissed: ${title}`
  if (envelope.status === 'unavailable') return `Unavailable: ${envelope.reason}`
  return `Answered: ${envelope.summary || title}`
}

function ApprovalCard({ ask, approval, context, sessionApproveDisabled, onResolved }: {
  ask: Ask
  approval: ApprovalShape
  context: UiPluginContext
  sessionApproveDisabled?: string
  onResolved(envelope: AskEnvelope): void
}) {
  const [denying, setDenying] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const hasReason = ask.spec.questions.some((question) => question.id === 'reason')

  const send = async (decision: Decision) => {
    const answers: Record<string, AskAnswer> = { decision: { value: decision, label: DECISION_LABELS[decision], source: 'option' } }
    const note = reason.trim()
    const withReason = decision === 'deny' && hasReason && note !== ''
    if (withReason) answers.reason = { value: note, source: 'input' }
    setBusy(true)
    try {
      const envelope = (await context.call('quirky.ask/answer', {
        askId: ask.id,
        answers,
        skipped: hasReason && !withReason ? ['reason'] : []
      })) as AskEnvelope
      onResolved(envelope)
    } catch (error) {
      context.toast('Could not answer', errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article data-approval-card={ask.id} aria-label={ask.spec.title ?? 'Approval'} style={CARD_STYLE}>
      <SectionHeader title={ask.spec.title ?? ASK_FALLBACK_TITLE} />
      <pre data-approval-command style={COMMAND_STYLE}>{approval.command}</pre>
      {denying && (
        <div data-approval-reason>
          <TextField label="Reason, if you deny" value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
      )}
      <div data-approval-actions style={ACTIONS_STYLE}>
        {denying ? (
          <>
            <Button disabled={busy} onClick={() => setDenying(false)}>Cancel</Button>
            <Button variant="destructive" disabled={busy} onClick={() => void send('deny')}>Confirm deny</Button>
          </>
        ) : (
          <>
            <Button variant="primary" disabled={busy} onClick={() => void send('allow')}>{DECISION_LABELS.allow}</Button>
            <Button
              disabled={busy || sessionApproveDisabled !== undefined}
              title={sessionApproveDisabled}
              onClick={() => void send('always')}
            >
              {DECISION_LABELS.always}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => setDenying(true)}>{DECISION_LABELS.deny}</Button>
          </>
        )}
      </div>
    </article>
  )
}

/**
 * One ask embedded in the chat: the existing question card for ordinary asks, the approval variant
 * for a runner's `decision`/`reason` ask, and a one-line record once the ask is answered or expired.
 * Reloads the ask when it is created, surfaced or resolved, and after the person answers.
 */
export function CardView({ context, input }: { context: UiPluginContext; input: CardViewInput }) {
  const { askId, sessionApproveDisabled } = input
  const [ask, setAsk] = useState<Ask | null>(null)
  const alive = useRef(true)
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    try {
      const asks = (await context.call('quirky.ask/list', { pendingOnly: false, askId })) as Ask[]
      if (!alive.current || seq !== loadSeq.current) return
      const next = asks.find((candidate) => candidate.id === askId) ?? null
      setAsk((current) => (current?.id === askId && current.envelope.status !== 'pending' && next?.envelope.status === 'pending' ? current : next))
    } catch (error) {
      context.log(`could not load ask ${askId}: ${errorText(error)}`)
    }
  }, [context, askId])

  useEffect(() => {
    alive.current = true
    void load()
    const unsubscribeEvents = context.subscribe((event: QuirkyEvent) => {
      if (!('data' in event)) return
      const data = event.data as { ask?: { id?: unknown }; askId?: unknown } | null
      if (event.type === 'quirky.ask/created') return void load()
      if (event.type !== 'quirky.ask/surfaced' && event.type !== 'quirky.ask/resolved') return
      if (data?.ask?.id === askId || data?.askId === askId) void load()
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') void load()
    })
    return () => {
      alive.current = false
      unsubscribeEvents()
      unsubscribeConnection()
    }
  }, [context, askId, load])

  if (!ask) return null

  const approval = approvalOf(ask)
  const resolve = (envelope: AskEnvelope) => {
    if (envelope.status === 'pending') return
    loadSeq.current += 1
    setAsk((current) => (current ? { ...current, envelope } : current))
    void load()
  }

  if (ask.envelope.status !== 'pending') {
    const record = approval ? approvalRecord(ask, approval) : ordinaryRecord(ask)
    return (
      <p
        {...(approval ? { 'data-approval-record': ask.id } : { 'data-ask-record': ask.id })}
        role="status"
        style={RECORD_STYLE}
      >
        {record}
      </p>
    )
  }

  if (approval) {
    return <ApprovalCard ask={ask} approval={approval} context={context} sessionApproveDisabled={sessionApproveDisabled} onResolved={resolve} />
  }
  return <AskCard ask={ask} context={context} onResolved={(_askId, envelope) => resolve(envelope)} />
}

/** Reads the view input, which is untrusted until it has an `askId`. */
export function parseCardInput(input: unknown): CardViewInput | null {
  if (typeof input !== 'object' || input === null) return null
  const { askId, sessionApproveDisabled } = input as { askId?: unknown; sessionApproveDisabled?: unknown }
  if (typeof askId !== 'string' || askId === '') return null
  return typeof sessionApproveDisabled === 'string' && sessionApproveDisabled !== '' ? { askId, sessionApproveDisabled } : { askId }
}
