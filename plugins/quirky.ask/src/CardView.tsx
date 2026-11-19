import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { Button, EmptyState, InlineError, NoticeLine, SectionHeader, TextField } from '@quirky/ui'
import type { Ask, AskAnswer, AskEnvelope, QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { AskCard } from './AskCard'
import { ASK_FALLBACK_TITLE, type AskStore } from './store'

export const CARD_VIEW_ID = 'view:quirky.ask/card'

export type CardViewInput = { askId: string; sessionApproveDisabled?: string }

type Decision = 'allow' | 'always' | 'deny'

type LoadPhase = { status: 'loading' } | { status: 'ready' } | { status: 'failed'; message: string }

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
  display: 'flex',
  margin: 0,
  padding: 'var(--ui-space-6) var(--ui-space-12)',
  minWidth: 0
}

const RECORD_TOGGLE_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--ui-space-6)',
  minWidth: 0,
  padding: 0,
  border: 0,
  background: 'none',
  color: 'inherit',
  font: 'inherit',
  textAlign: 'start',
  cursor: 'pointer'
}

const RECORD_CLIPPED_STYLE: CSSProperties = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const RECORD_WRAPPED_STYLE: CSSProperties = { minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }
const RECORD_CHEVRON_BOX_STYLE: CSSProperties = { display: 'flex', alignItems: 'center', flex: 'none', height: '1lh' }
const RECORD_CHEVRON_STYLE: CSSProperties = {
  width: 'var(--ui-space-6)',
  height: 'var(--ui-space-6)',
  borderInlineEnd: 'var(--ui-border-width) solid currentColor',
  borderBlockEnd: 'var(--ui-border-width) solid currentColor',
  color: 'var(--ui-muted)'
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

/** A resolved ask's record on one line with an ellipsis; when it is cut off, clicking it toggles the whole text wrapped in place. */
function RecordLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  const [clipped, setClipped] = useState(false)
  const [textElement, setTextElement] = useState<HTMLSpanElement | null>(null)
  useLayoutEffect(() => {
    if (!textElement) return
    const check = () => setClipped(textElement.scrollWidth > textElement.clientWidth)
    check()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(check)
    observer.observe(textElement)
    return () => observer.disconnect()
  }, [textElement, text])
  const textSpan = (
    <span ref={setTextElement} style={open ? RECORD_WRAPPED_STYLE : RECORD_CLIPPED_STYLE} title={open ? undefined : text}>
      {text}
    </span>
  )
  if (!open && !clipped) return textSpan
  const onToggle = () => setOpen((shown) => !shown)
  return (
    <button type="button" style={RECORD_TOGGLE_STYLE} aria-expanded={open} onClick={onToggle}>
      {textSpan}
      <span style={RECORD_CHEVRON_BOX_STYLE}>
        <span aria-hidden="true" style={{ ...RECORD_CHEVRON_STYLE, transform: open ? 'rotate(45deg)' : 'rotate(-45deg)' }} />
      </span>
    </button>
  )
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
  const onStartDeny = () => setDenying(true)
  const onCancelDeny = () => setDenying(false)

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
            <Button disabled={busy} onClick={onCancelDeny}>Cancel</Button>
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
            <Button variant="destructive" disabled={busy} onClick={onStartDeny}>{DECISION_LABELS.deny}</Button>
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
export function CardView({ context, input, store }: { context: UiPluginContext; input: CardViewInput; store: AskStore }) {
  const { askId, sessionApproveDisabled } = input
  const previews = useSyncExternalStore(store.subscribe, store.previews)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [phase, setPhase] = useState<LoadPhase>({ status: 'loading' })
  const alive = useRef(true)
  const loadSeq = useRef(0)

  async function load(): Promise<void> {
    const seq = ++loadSeq.current
    try {
      const asks = (await context.call('quirky.ask/list', { pendingOnly: false, askId })) as Ask[]
      if (!alive.current || seq !== loadSeq.current) return
      const next = asks.find((candidate) => candidate.id === askId) ?? null
      setAsk((current) => (current?.id === askId && current.envelope.status !== 'pending' && next?.envelope.status === 'pending' ? current : next))
      setPhase({ status: 'ready' })
    } catch (error) {
      context.log(`could not load ask ${askId}: ${errorText(error)}`)
      if (!alive.current || seq !== loadSeq.current) return
      setPhase((current) => (current.status === 'ready' ? current : { status: 'failed', message: errorText(error) }))
    }
  }

  useEffect(() => {
    alive.current = true
    setAsk(null)
    setPhase({ status: 'loading' })
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
  }, [context, askId])

  if (!ask) {
    if (phase.status === 'failed') {
      return <InlineError message={`Could not load the question: ${phase.message}`} action={{ label: 'Retry', onAction: () => void load() }} />
    }
    if (phase.status === 'loading') return <NoticeLine>Loading question…</NoticeLine>
    return <EmptyState message="This question is no longer available." />
  }

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
        data-approval-record={approval ? ask.id : undefined}
        data-ask-record={approval ? undefined : ask.id}
        role="status"
        style={RECORD_STYLE}
      >
        <RecordLine text={record} />
      </p>
    )
  }

  if (approval) {
    return <ApprovalCard ask={ask} approval={approval} context={context} sessionApproveDisabled={sessionApproveDisabled} onResolved={resolve} />
  }
  return <AskCard ask={ask} context={context} resolve={(_askId, envelope) => resolve(envelope)} previews={previews} />
}

/** Reads the view input, which is untrusted until it has an `askId`. */
export function parseCardInput(input: unknown): CardViewInput | null {
  if (typeof input !== 'object' || input === null) return null
  const { askId, sessionApproveDisabled } = input as { askId?: unknown; sessionApproveDisabled?: unknown }
  if (typeof askId !== 'string' || askId === '') return null
  return typeof sessionApproveDisabled === 'string' && sessionApproveDisabled !== '' ? { askId, sessionApproveDisabled } : { askId }
}
