import { useState } from 'react'
import type { Ask, UiPluginContext } from '@quirky/protocol'
import { buildAnswers, emptyDrafts, type Drafts } from './askAnswers'
import { QuestionField } from './QuestionField'
import { ASK_FALLBACK_TITLE } from './store'

type Props = { ask: Ask; context: UiPluginContext; onResolved(askId: string): void }

export function AskCard({ ask, context, onResolved }: Props) {
  const [drafts, setDrafts] = useState<Drafts>(() => emptyDrafts(ask.spec))
  const [busy, setBusy] = useState(false)

  const attempt = async (method: string, params: Record<string, unknown>, failure: string) => {
    setBusy(true)
    try {
      await context.call(method, params)
      onResolved(ask.id)
    } catch (error) {
      context.toast(failure, error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const submit = () => {
    const { answers, skipped } = buildAnswers(ask.spec, drafts)
    return attempt('quirky.ask/answer', { askId: ask.id, answers, skipped }, 'Could not answer')
  }

  const dismiss = () => attempt('quirky.ask/cancel', { askId: ask.id }, 'Could not dismiss')

  return (
    <article className="ask-card" aria-label={ask.spec.title ?? 'Question'}>
      <h3>{ask.spec.title ?? ASK_FALLBACK_TITLE}</h3>
      {ask.spec.questions.map((question) => (
        <fieldset key={question.id}>
          {question.header && <div className="ask-header">{question.header}</div>}
          <legend style={{ whiteSpace: 'pre-wrap' }}>{question.question}</legend>
          <QuestionField
            question={question}
            name={`${ask.id}-${question.id}`}
            draft={drafts[question.id]!}
            onChange={(draft) => setDrafts({ ...drafts, [question.id]: draft })}
          />
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
