// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AskCard } from './AskCard'
import type { AskCardModel } from './ask-card-model'
import type {
  AskPartial,
  AskQuestion,
  AskTextQuestion
} from '../../../../shared/fork-ask-question-tool/ask-question-schema'

afterEach(() => cleanup())

function modelFor(questions: AskQuestion[]): AskCardModel {
  return { askId: 'ask_1', status: 'registered', spec: { questions }, partial: {} }
}

const nameQuestion: AskTextQuestion = { id: 'name', type: 'text', question: 'Project name?' }

describe('AskCard — onDraftChange', () => {
  it('fires with the normalized partial on every draft change', () => {
    const onDraftChange = vi.fn<(partial: AskPartial) => void>()
    render(
      <AskCard
        model={modelFor([nameQuestion])}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onDraftChange={onDraftChange}
      />
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Project name?' }), {
      target: { value: 'quirky' }
    })

    expect(onDraftChange).toHaveBeenCalledWith({ name: { draft: 'quirky' } })
  })

  it('omits a question with no meaningful input from the partial', () => {
    const onDraftChange = vi.fn<(partial: AskPartial) => void>()
    const dbQuestion: AskQuestion = {
      id: 'db',
      type: 'select',
      question: 'DB?',
      options: [{ value: 'pg', label: 'PostgreSQL' }]
    }
    render(
      <AskCard
        model={modelFor([nameQuestion, dbQuestion])}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onDraftChange={onDraftChange}
      />
    )

    fireEvent.change(screen.getByRole('textbox', { name: 'Project name?' }), {
      target: { value: 'quirky' }
    })

    expect(onDraftChange).toHaveBeenCalledWith({ name: { draft: 'quirky' } })
  })

  it('behaves identically to the merged component when the prop is absent', () => {
    const onSubmit = vi.fn()
    render(<AskCard model={modelFor([nameQuestion])} onSubmit={onSubmit} onCancel={vi.fn()} />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Project name?' }), {
      target: { value: 'quirky' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({ name: { value: 'quirky', source: 'input' } }, [])
  })
})
