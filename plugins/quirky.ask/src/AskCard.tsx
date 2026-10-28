import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Badge, Button, SectionHeader } from '@quirky/ui'
import type { Ask, AskEnvelope, UiPluginContext } from '@quirky/protocol'
import { buildSubmission, draftsToPartial, initialDraftFor, type QuestionDraft } from './core/submission'
import { QuestionField } from './QuestionField'
import { ASK_FALLBACK_TITLE } from './store'

type Props = { ask: Ask; context: UiPluginContext; onResolved(askId: string, envelope: AskEnvelope): void }
type Drafts = Record<string, QuestionDraft>

const SAVE_DELAY_MS = 500

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

const FIELDSET_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-8)',
  minWidth: 0,
  margin: 0,
  padding: 'var(--ui-space-12)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-control)'
}

const ACTIONS_STYLE: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  gap: 'var(--ui-space-8)',
  minWidth: 0
}

const OPTION_LIST_STYLE: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ui-space-4)',
  minWidth: 0,
  margin: 0,
  paddingInlineStart: 'var(--ui-space-16)'
}

const QUESTION_TEXT_STYLE: CSSProperties = { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }

export function AskCard({ ask, context, onResolved }: Props) {
  const [drafts, setDrafts] = useState<Drafts>(() => Object.fromEntries(ask.spec.questions.map((q) => [q.id, initialDraftFor(ask.partial[q.id])])))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const latest = useRef(drafts)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cancelSave = () => {
    if (saveTimer.current === null) return false
    clearTimeout(saveTimer.current)
    saveTimer.current = null
    return true
  }

  const scheduleSave = () => {
    cancelSave()
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      context
        .call('quirky.ask/updatePartial', { askId: ask.id, partial: draftsToPartial(latest.current, ask.spec) })
        .catch((error: unknown) => context.log(`could not save draft: ${error instanceof Error ? error.message : String(error)}`))
    }, SAVE_DELAY_MS)
  }

  useEffect(() => () => void cancelSave(), [])

  const change = (questionId: string, draft: QuestionDraft) => {
    latest.current = { ...latest.current, [questionId]: draft }
    setDrafts(latest.current)
    setErrors(({ [questionId]: _cleared, ...rest }) => rest)
    scheduleSave()
  }

  const attempt = async (method: string, params: Record<string, unknown>, failure: string) => {
    const hadPendingSave = cancelSave()
    setBusy(true)
    try {
      const envelope = (await context.call(method, params)) as AskEnvelope
      onResolved(ask.id, envelope)
    } catch (error) {
      if (hadPendingSave) scheduleSave()
      context.toast(failure, error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const openDelegatedQuestion = async () => {
    if (!ask.sessionId) {
      context.toast('Could not open delegated question', 'The exact delegated session is unavailable.')
      return
    }
    setBusy(true)
    try {
      let worktreeId = ask.worktreeId
      if (!worktreeId) {
        const session = await context.call('quirky.session/get', { session: ask.sessionId })
        if (typeof session !== 'object' || session === null || !('worktreeId' in session) || typeof session.worktreeId !== 'string') {
          throw new Error('The delegated session has no worktree view.')
        }
        worktreeId = session.worktreeId
      }
      context.openView('view:quirky.session/worktree', { worktree: worktreeId, session: ask.sessionId })
    } catch (error) {
      context.toast('Could not open delegated question', error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const submit = () => {
    const submission = buildSubmission(ask.spec, drafts)
    if (!submission.ok) {
      setErrors(submission.errors)
      return
    }
    setErrors({})
    return attempt('quirky.ask/answer', { askId: ask.id, answers: submission.answers, skipped: submission.skipped }, 'Could not answer')
  }

  const dismiss = () => attempt('quirky.ask/cancel', { askId: ask.id }, 'Could not dismiss')

  return (
    <article data-ask-card={ask.id} aria-label={ask.spec.title ?? 'Question'} style={CARD_STYLE}>
      <SectionHeader title={ask.spec.title ?? ASK_FALLBACK_TITLE} />
      {ask.handoff ? (
        <>
          <p>This is a delegated question. Open its session to answer the exact coordinator question.</p>
          {ask.spec.questions.map((question) => (
            <fieldset key={question.id} data-question={question.id} style={FIELDSET_STYLE}>
              <legend>
                {question.header ?? (
                  <span data-question-text style={QUESTION_TEXT_STYLE}>{question.question}</span>
                )}
              </legend>
              {question.header && (
                <p data-question-text style={QUESTION_TEXT_STYLE}>{question.question}</p>
              )}
              {(question.type === 'select' || question.type === 'multiselect') && (
                <ul style={OPTION_LIST_STYLE}>
                  {question.options.map((option) => <li key={option.value}>{option.label}</li>)}
                </ul>
              )}
            </fieldset>
          ))}
          <div style={ACTIONS_STYLE}>
            <Button variant="primary" disabled={busy} onClick={() => void openDelegatedQuestion()}>
              Open delegated question
            </Button>
          </div>
        </>
      ) : (
        <>
          {ask.spec.questions.map((question) => (
            <fieldset key={question.id} data-question={question.id} style={FIELDSET_STYLE}>
              <legend>
                {question.header && <><strong>{question.header}</strong><br /></>}
                <span data-question-text style={QUESTION_TEXT_STYLE}>{question.question}</span>
              </legend>
              {!question.required && <Badge>(optional)</Badge>}
              <QuestionField question={question} draft={drafts[question.id]!} onChange={(draft) => change(question.id, draft)} />
              {errors[question.id] && (
                <div role="alert">
                  <Badge tone="failing">{errors[question.id]}</Badge>
                </div>
              )}
            </fieldset>
          ))}
          <div style={ACTIONS_STYLE}>
            <Button disabled={busy} onClick={() => void dismiss()}>
              Dismiss
            </Button>
            <Button variant="primary" disabled={busy} onClick={() => void submit()}>
              Submit
            </Button>
          </div>
        </>
      )}
    </article>
  )
}
