import { useEffect, useRef, useState } from 'react'
import type { Ask, UiPluginContext } from '@quirky/protocol'
import { buildSubmission, draftsToPartial, initialDraftFor, type QuestionDraft } from './core/submission'
import { QuestionField } from './QuestionField'
import { ASK_FALLBACK_TITLE } from './store'

type Props = { ask: Ask; context: UiPluginContext; onResolved(askId: string): void }
type Drafts = Record<string, QuestionDraft>

const SAVE_DELAY_MS = 500

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
      await context.call(method, params)
      onResolved(ask.id)
    } catch (error) {
      if (hadPendingSave) scheduleSave()
      context.toast(failure, error instanceof Error ? error.message : String(error))
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
    <article className="ask-card" aria-label={ask.spec.title ?? 'Question'}>
      <h3>{ask.spec.title ?? ASK_FALLBACK_TITLE}</h3>
      {ask.spec.questions.map((question) => (
        <fieldset key={question.id} data-question={question.id}>
          <legend>
            {question.header && <strong style={{ display: 'block' }}>{question.header}</strong>}
            <span data-question-text style={{ display: 'block', whiteSpace: 'pre-wrap', fontWeight: question.header ? 400 : undefined }}>
              {question.question}
            </span>
          </legend>
          {!question.required && <small className="muted">(optional)</small>}
          <QuestionField question={question} draft={drafts[question.id]!} onChange={(draft) => change(question.id, draft)} />
          {errors[question.id] && (
            <p role="alert" style={{ color: 'var(--danger)', margin: '4px 0 0' }}>
              {errors[question.id]}
            </p>
          )}
        </fieldset>
      ))}
      <div className="dialog-actions">
        <button disabled={busy} onClick={() => void dismiss()}>
          Dismiss
        </button>
        <button className="primary" disabled={busy} onClick={() => void submit()}>
          Submit
        </button>
      </div>
    </article>
  )
}
