// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as QueueMoveClient from '@/runtime/structured-agent-session-queue-move-client'
import type { QueuedMessageCard } from '@/components/native-chat/structured-agent-session-queued-cards'
import { QueuedList } from './QueuedList'
import type { ComposerQueue, ComposerQueueMove } from './composer-types'

const mocks = vi.hoisted(() => ({
  capability: vi.fn(),
  move: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: mocks.capability
}))
vi.mock('@/runtime/structured-agent-session-queue-move-client', async (importOriginal) => ({
  ...(await importOriginal<typeof QueueMoveClient>()),
  moveStructuredAgentSessionQueuedMessage: mocks.move
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

const REORDER = /Reorder queued message/

const card = (messageId: string, text: string): QueuedMessageCard => ({
  messageId,
  position: 1,
  text,
  state: 'waiting',
  hold: 'turn'
})

function queueOf(overrides: Partial<ComposerQueue> = {}): ComposerQueue {
  return {
    cards: [card('a', 'first'), card('b', 'second')],
    queueCapable: true,
    clearCapable: true,
    pause: null,
    resume: vi.fn(),
    clear: vi.fn(),
    queuePending: null,
    pending: () => null,
    steer: vi.fn(),
    remove: vi.fn(),
    editCapable: true,
    editor: undefined,
    edit: vi.fn(),
    steerNewest: () => false,
    ...overrides
  }
}

const move: ComposerQueueMove = { target: { kind: 'local' }, sessionId: 'session-1', fence: 3 }

function rowTexts(): string[] {
  return within(screen.getByRole('list', { name: 'Queued messages' }))
    .getAllByRole('listitem')
    .map((row) => row.querySelector('p')?.textContent ?? '')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.capability.mockReturnValue('supported')
  mocks.move.mockResolvedValue({ ok: true })
})

afterEach(cleanup)

describe('QueuedList reorder', () => {
  it('offers no drag handle when the host does not serve queuedMessageMove', () => {
    mocks.capability.mockReturnValue('unsupported')
    render(<QueuedList queue={queueOf()} working move={move} />)
    expect(screen.queryAllByLabelText(REORDER)).toHaveLength(0)
    expect(
      screen.getAllByRole('listitem').some((row) => row.getAttribute('draggable') === 'true')
    ).toBe(false)
  })

  it('offers no drag handle until the host has answered', () => {
    mocks.capability.mockReturnValue('unknown')
    render(<QueuedList queue={queueOf()} working move={move} />)
    expect(screen.queryAllByLabelText(REORDER)).toHaveLength(0)
  })

  it('offers no drag handle without a session to move in', () => {
    render(<QueuedList queue={queueOf()} working />)
    expect(screen.queryAllByLabelText(REORDER)).toHaveLength(0)
  })

  it('offers a handle on every row when the host serves it, and moves with the arrow keys', async () => {
    render(<QueuedList queue={queueOf()} working move={move} />)
    const handles = screen.getAllByLabelText(REORDER)
    expect(handles).toHaveLength(2)
    fireEvent.keyDown(handles[0]!, { key: 'ArrowDown' })
    await act(async () => {})
    expect(mocks.move).toHaveBeenCalledWith({ ...move, messageId: 'a', toIndex: 1 })
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('says why and leaves the order alone when the host refuses a move', async () => {
    mocks.move.mockResolvedValue({ ok: false, reason: 'sending' })
    render(<QueuedList queue={queueOf()} working move={move} />)
    fireEvent.keyDown(screen.getAllByLabelText(REORDER)[1]!, { key: 'ArrowUp' })
    await act(async () => {})
    expect(mocks.toastError).toHaveBeenCalledWith('That message is already being sent.')
    expect(rowTexts()).toEqual(['first', 'second'])
  })

  it('does not move the first row up or the last row down', async () => {
    render(<QueuedList queue={queueOf()} working move={move} />)
    const handles = screen.getAllByLabelText(REORDER)
    fireEvent.keyDown(handles[0]!, { key: 'ArrowUp' })
    fireEvent.keyDown(handles[1]!, { key: 'ArrowDown' })
    await act(async () => {})
    expect(mocks.move).not.toHaveBeenCalled()
  })
})

describe('QueuedList actions', () => {
  it('steers, edits and deletes through the session controller', () => {
    const queue = queueOf({ cards: [card('a', 'first')] })
    render(<QueuedList queue={queue} working />)
    fireEvent.click(screen.getByRole('button', { name: 'Steer now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Edit queued message' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete queued message' }))
    expect(queue.steer).toHaveBeenCalledWith('a')
    expect(queue.edit).toHaveBeenCalledWith('a')
    expect(queue.remove).toHaveBeenCalledWith('a')
  })

  it('renders nothing for an empty queue', () => {
    const { container } = render(<QueuedList queue={queueOf({ cards: [] })} working />)
    expect(container.textContent).toBe('')
  })
})
