import { useId, useState, type CSSProperties } from 'react'
import type { Session, UiPluginContext } from '@quirky/protocol'
import { Button, ControlIcon, EmptyState, IconButton, InlineError, NoticeLine, TextArea } from '@quirky/ui'
import { planMarker, type PlanVersion } from './plan'
import { Prose } from './Prose'

type Decision = { value: 'approve-auto' | 'approve-review' | 'keep'; label: string }

const AUTO: Decision = { value: 'approve-auto', label: 'Approve, auto mode' }
const REVIEW: Decision = { value: 'approve-review', label: 'Approve, review edits' }
const KEEP: Decision = { value: 'keep', label: 'Keep planning' }
const PRESENT_AGAIN = 'Please present the plan again.'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const root = { display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0, minWidth: 0, height: '100%' } satisfies CSSProperties
const header = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--ui-space-8)',
  minHeight: 'var(--ui-row-single)',
  padding: '0 var(--ui-space-8) 0 var(--ui-space-12)',
  borderBlockEnd: 'var(--ui-border-width) solid var(--ui-border)'
} satisfies CSSProperties
const title = { margin: 0, fontSize: 'var(--ui-font-label)', fontWeight: 700 } satisfies CSSProperties
const marker = { minWidth: 0, color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' } satisfies CSSProperties
const markerApproved = { ...marker, color: 'var(--ui-working)' } satisfies CSSProperties
const markerGrow = { flex: 1 } satisfies CSSProperties
const markerSheet = { padding: 'var(--ui-space-4) var(--ui-space-12) 0' } satisfies CSSProperties
const body = { flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--ui-space-12)' } satisfies CSSProperties
const file = { marginBlockStart: 'var(--ui-space-8)' } satisfies CSSProperties
const actions = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-6)',
  padding: 'var(--ui-space-12)',
  borderBlockStart: 'var(--ui-border-width) solid var(--ui-border)'
} satisfies CSSProperties
const exit = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-2)' } satisfies CSSProperties
const exitHint = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' } satisfies CSSProperties
const buttons = { display: 'flex', gap: 'var(--ui-space-6)' } satisfies CSSProperties

/**
 * One plan version: its marker, the plan as Claude wrote it, a link to the plan file and, for the
 * newest version, the way to answer it. Approval is click-only; nothing here listens for keys.
 * `framed` adds the panel's own title and close button, which a sheet supplies itself.
 */
export function PlanPanel({
  context,
  session,
  version,
  isNewest,
  onClose,
  framed = true
}: {
  context: UiPluginContext
  session: Session
  version: PlanVersion
  isNewest: boolean
  onClose: () => void
  framed?: boolean
}) {
  const [feedback, setFeedback] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const exits = isNewest && version.status === 'waiting'
  const restarted = isNewest && version.status === 'not-answered' && version.reason === 'restarted'

  const attempt = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setProblem(null)
    try {
      await work()
    } catch (error) {
      setProblem(messageOf(error))
    } finally {
      setBusy(false)
    }
  }

  const answer = (decision: Decision, reason?: string) =>
    attempt(() =>
      context.call('quirky.ask/answer', {
        askId: version.askId,
        answers: {
          decision: { value: decision.value, label: decision.label, source: 'option' },
          ...(reason === undefined || reason === '' ? {} : { reason: { value: reason, source: 'input' } })
        },
        skipped: []
      })
    )

  const presentAgain = () => attempt(() => context.call('quirky.structured/send', { session: session.id, text: PRESENT_AGAIN }))

  const openFile = (path: string) => {
    void context
      .confirm({ title: 'Open plan file', body: path, confirmLabel: 'Open' })
      .then((ok) => (ok ? context.call('quirky.terminal/openExternal', { target: path }) : undefined))
      .catch((error) => context.toast('Could not open plan file', messageOf(error)))
  }

  const onKeepPlanning = () => setFeedback('')
  const onCancelFeedback = () => setFeedback(null)

  const answerable = version.askId !== undefined && !busy
  const markerStyle = version.status === 'approved' ? markerApproved : marker
  const hints = useId()

  return (
    <div style={root}>
      {framed ? (
        <header style={header}>
          <strong style={title}>Plan</strong>
          <span style={{ ...markerStyle, ...markerGrow }}>{planMarker(version)}</span>
          <IconButton label="Close plan" onClick={onClose}>
            <ControlIcon name="x" />
          </IconButton>
        </header>
      ) : (
        <div style={{ ...markerStyle, ...markerSheet }}>{planMarker(version)}</div>
      )}
      <div style={body}>
        {restarted && (
          <NoticeLine actions={[{ label: 'Ask Claude to present it again', onAction: () => void presentAgain(), disabled: busy }]}>
            Quirky restarted before you answered. Claude is no longer waiting on this plan.
          </NoticeLine>
        )}
        {version.empty === true ? <EmptyState message="Claude sent an empty plan" /> : <Prose context={context} session={session} text={version.text} />}
        {version.filePath !== undefined && (
          <div style={file}>
            <Button onClick={() => openFile(version.filePath!)}>Open plan file</Button>
          </div>
        )}
      </div>
      {(exits || problem !== null) && (
        <div style={actions}>
          {problem !== null && <InlineError message={problem} />}
          {exits && feedback === null && (
            <>
              {version.empty !== true && (
                <>
                  <div style={exit}>
                    <Button variant="primary" disabled={!answerable} aria-describedby={`${hints}-auto`} onClick={() => void answer(AUTO)}>{AUTO.label}</Button>
                    <span id={`${hints}-auto`} style={exitHint}>Claude starts now; most tool calls run without asking</span>
                  </div>
                  <div style={exit}>
                    <Button disabled={!answerable} aria-describedby={`${hints}-review`} onClick={() => void answer(REVIEW)}>{REVIEW.label}</Button>
                    <span id={`${hints}-review`} style={exitHint}>Claude starts now and asks before each edit</span>
                  </div>
                </>
              )}
              <div style={exit}>
                <Button disabled={!answerable} aria-describedby={`${hints}-keep`} onClick={onKeepPlanning}>{KEEP.label}</Button>
                <span id={`${hints}-keep`} style={exitHint}>Tell Claude what to change</span>
              </div>
            </>
          )}
          {exits && feedback !== null && (
            <>
              <TextArea label="What should Claude change?" value={feedback} onChange={(event) => setFeedback(event.target.value)} />
              <div style={buttons}>
                <Button variant="primary" disabled={!answerable} onClick={() => void answer(KEEP, feedback.trim())}>Send to Claude</Button>
                <Button disabled={busy} onClick={onCancelFeedback}>Cancel</Button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
