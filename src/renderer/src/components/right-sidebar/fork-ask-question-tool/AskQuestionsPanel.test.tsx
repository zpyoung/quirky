// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AskCardModel } from '@/store/slices/fork-ask-question-tool/asks'
import AskQuestionsPanel from './AskQuestionsPanel'

let focusedPaneKey: string | null = 'pane-a'
vi.mock('../fork-session-info/focused-session-info', () => ({
  useFocusedPaneKey: () => focusedPaneKey
}))

const runtimeCall = vi.fn(() => Promise.resolve({ ok: true, result: { committed: true } }))

function card(askId: string, overrides: Partial<AskCardModel> = {}): AskCardModel {
  return {
    askId,
    paneKey: 'pane-a',
    status: 'pending',
    spec: { questions: [{ id: 'name', type: 'text', question: 'Project name?' }] },
    partial: {},
    ...overrides
  }
}

beforeEach(() => {
  focusedPaneKey = 'pane-a'
  runtimeCall.mockClear()
  // @ts-expect-error -- the panel only reaches for runtime.call and notifications
  window.api = { runtime: { call: runtimeCall } }
  useAppStore.setState({ pendingAsksByPaneKey: {} })
})

afterEach(cleanup)

describe('AskQuestionsPanel', () => {
  it('explains itself when the focused session has nothing outstanding', () => {
    render(<AskQuestionsPanel />)
    expect(screen.getByText('No questions')).toBeInTheDocument()
  })

  it('shows the empty state when no pane is focused at all', () => {
    focusedPaneKey = null
    useAppStore.setState({ pendingAsksByPaneKey: { 'pane-a': [card('ask-1')] } })
    render(<AskQuestionsPanel />)
    expect(screen.getByText('No questions')).toBeInTheDocument()
  })

  it('renders the focused pane head ask and answers it through the runtime bridge', () => {
    useAppStore.setState({ pendingAsksByPaneKey: { 'pane-a': [card('ask-1')] } })
    render(<AskQuestionsPanel />)

    fireEvent.change(screen.getByRole('textbox', { name: 'Project name?' }), {
      target: { value: 'quirky' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'ask.answer',
        params: expect.objectContaining({ askId: 'ask-1' })
      })
    )
  })

  it('follows the focused pane rather than binding to one', () => {
    useAppStore.setState({
      pendingAsksByPaneKey: {
        'pane-a': [card('ask-1')],
        'pane-b': [
          card('ask-2', {
            paneKey: 'pane-b',
            spec: { questions: [{ id: 'port', type: 'text', question: 'Which port?' }] }
          })
        ]
      }
    })

    const { unmount } = render(<AskQuestionsPanel />)
    expect(screen.getByRole('textbox', { name: 'Project name?' })).toBeInTheDocument()
    unmount()

    focusedPaneKey = 'pane-b'
    render(<AskQuestionsPanel />)
    expect(screen.getByRole('textbox', { name: 'Which port?' })).toBeInTheDocument()
  })

  it('shows only the head of a queued pair', () => {
    useAppStore.setState({
      pendingAsksByPaneKey: {
        'pane-a': [
          card('ask-1'),
          card('ask-2', {
            spec: { questions: [{ id: 'port', type: 'text', question: 'Which port?' }] }
          })
        ]
      }
    })
    render(<AskQuestionsPanel />)
    expect(screen.getByRole('textbox', { name: 'Project name?' })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Which port?' })).not.toBeInTheDocument()
  })

  it('collapses to the result summary once the ask resolves', () => {
    useAppStore.setState({
      pendingAsksByPaneKey: {
        'pane-a': [
          card('ask-1', {
            status: 'answered',
            result: { answers: {}, skipped: [], summary: 'name: quirky' }
          })
        ]
      }
    })
    render(<AskQuestionsPanel />)
    expect(screen.getByText('Answered')).toBeInTheDocument()
    expect(screen.getByText('name: quirky')).toBeInTheDocument()
  })
})
