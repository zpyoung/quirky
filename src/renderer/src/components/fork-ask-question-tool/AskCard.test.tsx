// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AskCard } from './AskCard'
import type { AskCardModel } from './ask-card-model'
import type { AskAnswers } from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type {
  AskConfirmQuestion,
  AskDateQuestion,
  AskMultiselectQuestion,
  AskNumberQuestion,
  AskQuestion,
  AskSelectQuestion,
  AskTextQuestion
} from '../../../../shared/fork-ask-question-tool/ask-question-schema'

afterEach(() => cleanup())

function modelFor(questions: AskQuestion[], overrides: Partial<AskCardModel> = {}): AskCardModel {
  return {
    askId: 'ask_1',
    status: 'registered',
    spec: { questions },
    partial: {},
    ...overrides
  }
}

function renderCard(
  questions: AskQuestion[],
  overrides: Partial<AskCardModel> = {}
): { onSubmit: ReturnType<typeof vi.fn>; onCancel: ReturnType<typeof vi.fn> } {
  const onSubmit = vi.fn()
  const onCancel = vi.fn()
  render(<AskCard model={modelFor(questions, overrides)} onSubmit={onSubmit} onCancel={onCancel} />)
  return { onSubmit, onCancel }
}

const dbQuestion: AskSelectQuestion = {
  id: 'db_engine',
  type: 'select',
  question: 'Which database?',
  options: [
    { value: 'pg', label: 'PostgreSQL' },
    { value: 'mysql', label: 'MySQL' }
  ]
}

const fruitsQuestion: AskMultiselectQuestion = {
  id: 'fruits',
  type: 'multiselect',
  question: 'Which fruits?',
  options: [
    { value: 'apple', label: 'Apple' },
    { value: 'banana', label: 'Banana' },
    { value: 'cherry', label: 'Cherry' }
  ]
}

describe('AskCard — select', () => {
  it('keys the answer by option value, not by label or click position (STA-1860-class)', () => {
    const { onSubmit } = renderCard([dbQuestion])

    fireEvent.click(screen.getByRole('button', { name: 'MySQL' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    const answers = onSubmit.mock.calls[0]?.[0] as AskAnswers
    expect(answers.db_engine).toEqual({
      value: 'mysql',
      label: 'MySQL',
      note: undefined,
      source: 'option'
    })
  })

  it('takes the free-text escape hatch when no option is picked', () => {
    const { onSubmit } = renderCard([dbQuestion])

    fireEvent.change(screen.getByPlaceholderText('Add your own answer'), {
      target: { value: 'CockroachDB' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    const answers = onSubmit.mock.calls[0]?.[0] as AskAnswers
    expect(answers.db_engine).toEqual({ value: 'CockroachDB', source: 'other' })
  })

  it('skips an optional question left untouched', () => {
    const { onSubmit } = renderCard([dbQuestion])

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({}, ['db_engine'])
  })

  it('blocks submit on a required question with neither an option nor free text, but a required question still accepts free text', () => {
    const required: AskSelectQuestion = { ...dbQuestion, required: true }
    const { onSubmit } = renderCard([required])

    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent('This question is required.')

    fireEvent.change(screen.getByPlaceholderText('Add your own answer'), {
      target: { value: 'CockroachDB' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    const answers = onSubmit.mock.calls[0]?.[0] as AskAnswers
    expect(answers.db_engine).toEqual({ value: 'CockroachDB', source: 'other' })
  })
})

describe('AskCard — multiselect', () => {
  it('emits picked values/labels in spec option order regardless of click order', () => {
    const { onSubmit } = renderCard([fruitsQuestion])

    fireEvent.click(screen.getByRole('button', { name: 'Cherry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Apple' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    const answers = onSubmit.mock.calls[0]?.[0] as AskAnswers
    expect(answers.fruits).toEqual({
      values: ['apple', 'cherry'],
      labels: ['Apple', 'Cherry'],
      other: undefined,
      source: 'options'
    })
  })
})

describe('AskCard — text', () => {
  const textQuestion: AskTextQuestion = { id: 'name', type: 'text', question: 'Project name?' }

  it('submits the typed value', () => {
    const { onSubmit } = renderCard([textQuestion])

    fireEvent.change(screen.getByRole('textbox', { name: 'Project name?' }), {
      target: { value: 'quirky' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({ name: { value: 'quirky', source: 'input' } }, [])
  })

  it('flags an aria-invalid error when a pattern does not match', () => {
    const patterned: AskTextQuestion = { ...textQuestion, pattern: '^[a-z]+$', required: true }
    const { onSubmit } = renderCard([patterned])

    const input = screen.getByRole('textbox', { name: 'Project name?' })
    fireEvent.change(input, { target: { value: 'Quirky123' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('AskCard — number', () => {
  const poolSize: AskNumberQuestion = {
    id: 'pool_size',
    type: 'number',
    question: 'Pool size?',
    min: 1,
    max: 10,
    integer: true
  }

  it('submits a valid integer within range', () => {
    const { onSubmit } = renderCard([poolSize])

    fireEvent.change(screen.getByRole('spinbutton', { name: 'Pool size?' }), {
      target: { value: '5' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({ pool_size: { value: 5, source: 'input' } }, [])
  })

  it('flags aria-invalid when the value is out of range', () => {
    const { onSubmit } = renderCard([poolSize])

    const input = screen.getByRole('spinbutton', { name: 'Pool size?' })
    fireEvent.change(input, { target: { value: '999' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('AskCard — date', () => {
  const dueDate: AskDateQuestion = {
    id: 'due',
    type: 'date',
    question: 'Due date?',
    required: true
  }

  it('submits a valid ISO date', () => {
    const { onSubmit } = renderCard([dueDate])

    fireEvent.change(screen.getByLabelText('Due date?'), { target: { value: '2026-09-01' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({ due: { value: '2026-09-01', source: 'input' } }, [])
  })

  it('flags aria-invalid on an unparseable date', () => {
    const { onSubmit } = renderCard([dueDate])

    const input = screen.getByLabelText('Due date?')
    fireEvent.change(input, { target: { value: 'not-a-date' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('AskCard — confirm', () => {
  const proceed: AskConfirmQuestion = { id: 'proceed', type: 'confirm', question: 'Proceed?' }

  it('submits the picked boolean', () => {
    const { onSubmit } = renderCard([proceed])

    const group = screen.getByRole('group', { name: 'Proceed?' })
    fireEvent.click(within(group).getByRole('button', { name: 'No' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(onSubmit).toHaveBeenCalledWith({ proceed: { value: false, source: 'input' } }, [])
  })
})

describe('AskCard — cancel', () => {
  it('calls onCancel without validating anything', () => {
    const required: AskTextQuestion = {
      id: 'name',
      type: 'text',
      question: 'Name?',
      required: true
    }
    const { onCancel, onSubmit } = renderCard([required])

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})

describe('AskCard — collapsed summary', () => {
  it('renders the terminal result instead of the form once resolved', () => {
    renderCard([dbQuestion], {
      status: 'answered',
      result: {
        answers: { db_engine: { value: 'pg', label: 'PostgreSQL', source: 'option' } },
        skipped: [],
        summary: 'Database: PostgreSQL'
      }
    })

    expect(screen.getByText('Database: PostgreSQL')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument()
    expect(screen.getByText('Answered')).toBeInTheDocument()
  })
})

describe('AskCard — height and scrolling', () => {
  function tenQuestions(): AskQuestion[] {
    return Array.from({ length: 10 }, (_, index) => ({
      id: `q${index}`,
      type: 'text' as const,
      question: `Question ${index}?`
    }))
  }

  it('fills its host and scrolls the question list rather than growing past it', () => {
    const { container } = render(
      <AskCard model={modelFor(tenQuestions())} onSubmit={vi.fn()} onCancel={vi.fn()} />
    )

    const root = container.firstElementChild
    expect(root).toHaveClass('flex-1', 'min-h-0', 'overflow-hidden')
    expect(root).toHaveClass('flex-col')
    // happy-dom computes no real scrollHeight, so this asserts the structure that makes the cap
    // work; tests/e2e/ask-card.spec.ts is what proves it against real layout.
    expect(container.querySelector('.overflow-y-auto')).toHaveClass('min-h-0', 'flex-1')
  })

  it('keeps Submit reachable with a full ten-question spec', () => {
    renderCard(tenQuestions())
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
  })

  it('labels the card with its question count', () => {
    renderCard([dbQuestion])
    expect(screen.getByText('1 question')).toBeInTheDocument()
    cleanup()

    renderCard([dbQuestion, fruitsQuestion, { id: 'go', type: 'confirm', question: 'Go?' }])
    expect(screen.getByText('3 questions')).toBeInTheDocument()
  })

  it('scrolls a long collapsed summary instead of stretching the card', () => {
    const summary = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n')
    const { container } = render(
      <AskCard
        model={modelFor([dbQuestion], {
          status: 'answered',
          result: { answers: {}, skipped: [], summary }
        })}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />
    )

    expect(screen.getByText('Answered')).toBeInTheDocument()
    expect(container.firstElementChild).toHaveClass('flex-1', 'min-h-0', 'overflow-hidden')
    expect(container.querySelector('.overflow-y-auto')).toHaveClass('min-h-0', 'flex-1')
  })
})
