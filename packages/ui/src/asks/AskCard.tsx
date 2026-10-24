import { useState } from 'react'
import type { Ask } from '@quirky/protocol'
import { useConnection, useDispatch } from '../context'
import { buildAnswers, emptyDrafts, type Drafts } from '../lib/askAnswers'
import { QuestionField } from './QuestionField'

export function AskCard({ ask }: { ask: Ask }) {
  const connection = useConnection()
  const dispatch = useDispatch()
  const [drafts, setDrafts] = useState<Drafts>(() => emptyDrafts(ask.spec))
  const [busy, setBusy] = useState(false)

  const resolved = (askId: string) =>
    dispatch({
      type: 'event',
      event: {
        type: 'ask.resolved',
        askId,
        envelope: { status: 'answered', askId, answers: {}, skipped: [] }
      }
    })

  const submit = async () => {
    setBusy(true)
    const { answers, skipped } = buildAnswers(ask.spec, drafts)
    const result = await connection.attempt('ask.answer', { askId: ask.id, answers, skipped }, 'Could not answer')
    setBusy(false)
    if (result) resolved(ask.id)
  }

  const dismiss = async () => {
    setBusy(true)
    const result = await connection.attempt('ask.cancel', { askId: ask.id }, 'Could not dismiss')
    setBusy(false)
    if (result) resolved(ask.id)
  }

  return (
    <article className="ask-card" aria-label={ask.spec.title ?? 'Question'}>
      <h3>{ask.spec.title ?? 'An agent has a question'}</h3>
      {ask.spec.questions.map((question) => (
        <fieldset key={question.id}>
          {question.header && <div className="ask-header">{question.header}</div>}
          <legend>{question.question}</legend>
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
