// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { LoopSnapshot } from '../../../shared/fork-loops/loop-types'
import { LoopQueueEditor } from './LoopQueueEditor'

const initialState = useAppStore.getInitialState()

function makeLoop(overrides: Partial<LoopSnapshot> = {}): LoopSnapshot {
  return {
    id: 'loop-1',
    worktreeId: 'wt-1',
    name: 'Work the queue',
    agent: 'claude',
    preset: 'queue',
    config: {
      promptSource: { kind: 'queue', repeatQueue: false },
      pacing: { kind: 'on-idle' },
      sessionPolicy: 'fresh',
      done: {},
      caps: {},
      noProgress: true,
      checkpointCommits: false,
      askBeforeNext: false,
      resumeAtLimitReset: false
    },
    state: 'running',
    iterationsCompleted: 1,
    detached: false,
    skippedTicks: 0,
    activeMs: 0,
    queue: [
      { id: 'q-0', position: 0, body: 'Write the parser', state: 'in-flight' },
      { id: 'q-1', position: 1, body: 'Add the tests', state: 'pending' },
      { id: 'q-2', position: 2, body: 'Update the docs', state: 'pending' }
    ],
    recentIterations: [],
    ...overrides
  }
}

function installQueueApi(): ReturnType<typeof vi.fn> {
  const queue = vi.fn(async () => makeLoop({ name: 'Updated by queue op' }))
  Object.defineProperty(window, 'api', { configurable: true, value: { loops: { queue } } })
  return queue
}

function itemRow(body: string): HTMLElement {
  const row = screen.getByText(body).closest('li')
  if (!row) {
    throw new Error(`no row for ${body}`)
  }
  return row
}

let previousApi: unknown

beforeEach(() => {
  previousApi = window.api
  useAppStore.setState(initialState, true)
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  Object.defineProperty(window, 'api', { configurable: true, value: previousApi })
})

describe('LoopQueueEditor', () => {
  it('renders nothing for a loop that is not queue-driven', () => {
    installQueueApi()
    const { container } = render(
      <LoopQueueEditor
        loop={makeLoop({
          preset: 'until-done',
          config: { ...makeLoop().config, promptSource: { kind: 'repeat', body: 'go' } }
        })}
      />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('lists items in position order and marks the in-flight one', () => {
    installQueueApi()
    const loop = makeLoop()
    render(<LoopQueueEditor loop={{ ...loop, queue: loop.queue?.toReversed() }} />)

    const bodies = screen.getAllByRole('listitem').map((row) => row.textContent)
    expect(bodies[0]).toContain('Write the parser')
    expect(bodies[1]).toContain('Add the tests')
    expect(within(itemRow('Write the parser')).getByText('In progress')).toBeInTheDocument()
  })

  it('offers no edit, move, or remove on the in-flight item', () => {
    installQueueApi()
    render(<LoopQueueEditor loop={makeLoop()} />)

    expect(within(itemRow('Write the parser')).queryAllByRole('button')).toHaveLength(0)
    expect(within(itemRow('Add the tests')).getAllByRole('button').length).toBeGreaterThan(0)
  })

  it('adds an item with the typed body and applies the returned snapshot', async () => {
    const queue = installQueueApi()
    render(<LoopQueueEditor loop={makeLoop()} />)

    fireEvent.change(screen.getByLabelText('New queue item'), {
      target: { value: '  Ship it  ' }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    })

    expect(queue).toHaveBeenCalledWith('loop-1', { op: 'add', body: 'Ship it' })
    expect(useAppStore.getState().loopsById['loop-1']?.name).toBe('Updated by queue op')
  })

  it('does not add an empty item', () => {
    const queue = installQueueApi()
    render(<LoopQueueEditor loop={makeLoop()} />)

    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled()
    expect(queue).not.toHaveBeenCalled()
  })

  it('moves a pending item up and down to its neighbour position', async () => {
    const queue = installQueueApi()
    render(<LoopQueueEditor loop={makeLoop()} />)

    await act(async () => {
      fireEvent.click(within(itemRow('Add the tests')).getByRole('button', { name: 'Move down' }))
    })
    expect(queue).toHaveBeenLastCalledWith('loop-1', { op: 'move', id: 'q-1', position: 2 })

    await act(async () => {
      fireEvent.click(within(itemRow('Update the docs')).getByRole('button', { name: 'Move up' }))
    })
    expect(queue).toHaveBeenLastCalledWith('loop-1', { op: 'move', id: 'q-2', position: 1 })
  })

  it('cannot move the first pending item above the in-flight item or the last one down', () => {
    installQueueApi()
    render(<LoopQueueEditor loop={makeLoop()} />)

    expect(within(itemRow('Add the tests')).getByRole('button', { name: 'Move up' })).toBeDisabled()
    expect(
      within(itemRow('Update the docs')).getByRole('button', { name: 'Move down' })
    ).toBeDisabled()
  })

  it('keeps controls on done items and lets moves cross them but not the in-flight item', async () => {
    const queue = installQueueApi()
    const loop = makeLoop({
      queue: [
        { id: 'q-0', position: 0, body: 'Shipped already', state: 'done' },
        { id: 'q-1', position: 1, body: 'Write the parser', state: 'in-flight' },
        { id: 'q-2', position: 2, body: 'Add the tests', state: 'pending' },
        { id: 'q-3', position: 3, body: 'Update the docs', state: 'done' }
      ]
    })
    render(<LoopQueueEditor loop={loop} />)

    const done = itemRow('Shipped already')
    expect(within(done).getByRole('button', { name: 'Edit' })).toBeEnabled()
    expect(within(done).getByRole('button', { name: 'Remove' })).toBeEnabled()
    expect(within(done).getByRole('button', { name: 'Move up' })).toBeDisabled()
    expect(within(done).getByRole('button', { name: 'Move down' })).toBeDisabled()
    expect(within(itemRow('Write the parser')).queryAllByRole('button')).toHaveLength(0)
    expect(within(itemRow('Add the tests')).getByRole('button', { name: 'Move up' })).toBeDisabled()

    await act(async () => {
      fireEvent.click(within(itemRow('Add the tests')).getByRole('button', { name: 'Move down' }))
    })
    expect(queue).toHaveBeenLastCalledWith('loop-1', { op: 'move', id: 'q-2', position: 3 })

    await act(async () => {
      fireEvent.click(within(done).getByRole('button', { name: 'Remove' }))
    })
    expect(queue).toHaveBeenLastCalledWith('loop-1', { op: 'remove', id: 'q-0' })
  })

  it('removes an item', async () => {
    const queue = installQueueApi()
    render(<LoopQueueEditor loop={makeLoop()} />)

    await act(async () => {
      fireEvent.click(within(itemRow('Update the docs')).getByRole('button', { name: 'Remove' }))
    })

    expect(queue).toHaveBeenCalledWith('loop-1', { op: 'remove', id: 'q-2' })
  })

  it('edits an item body', async () => {
    const queue = installQueueApi()
    render(<LoopQueueEditor loop={makeLoop()} />)

    fireEvent.click(within(itemRow('Add the tests')).getByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByLabelText('Edit queue item'), {
      target: { value: 'Add more tests' }
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    })

    expect(queue).toHaveBeenCalledWith('loop-1', { op: 'edit', id: 'q-1', body: 'Add more tests' })
  })

  it('shows the error and keeps the editor usable when a queue call fails', async () => {
    const queue = installQueueApi()
    queue.mockRejectedValueOnce(new Error('loop_invalid_transition'))
    render(<LoopQueueEditor loop={makeLoop()} />)

    await act(async () => {
      fireEvent.click(within(itemRow('Update the docs')).getByRole('button', { name: 'Remove' }))
    })

    expect(screen.getByRole('alert')).toHaveTextContent('loop_invalid_transition')
  })

  it('shows an empty state when the queue has no items', () => {
    installQueueApi()
    render(<LoopQueueEditor loop={makeLoop({ queue: [] })} />)

    expect(screen.getByText('The queue is empty')).toBeInTheDocument()
  })
})
