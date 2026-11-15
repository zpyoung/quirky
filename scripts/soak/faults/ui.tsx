import type { MountFunction, QuirkyEvent, UiLayout, UiPluginContext } from '@quirky/protocol'
import type * as React from '../../../packages/ui/node_modules/@types/react'
import type * as ReactClient from '../../../packages/ui/node_modules/@types/react-dom/client'
import { EmptyState, InlineError } from '../../../packages/ui/src/design-system/index.ts'

// script fixtures have no package links; the host import map supplies shared React modules
const reactModule: string = 'react'
const clientModule: string = 'react-dom/client'
const { createElement, useCallback, useEffect, useRef, useState }: typeof React = await import(reactModule)
const { createRoot }: typeof ReactClient = await import(clientModule)

const PANEL_ID = 'panel:soak.faults/feedback'
const FEEDBACK_LIMIT = 17

type PanelReport = { ready: boolean; worktree: string | null; sequence: number; error: string | null }
type WorktreePair = [string, string]

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function worktreeOf(layout: UiLayout): string | null {
  return typeof layout.worktree === 'string' && layout.worktree.trim() !== '' ? layout.worktree : null
}

function worktreePair(value: unknown): WorktreePair | null {
  if (!Array.isArray(value) || value.length !== 2
    || !value.every((worktree) => typeof worktree === 'string' && worktree.trim() !== '')
    || value[0] === value[1]) return null
  return [value[0], value[1]]
}

function samePair(value: unknown, expected: WorktreePair): boolean {
  const pair = worktreePair(value)
  return pair !== null && pair[0] === expected[0] && pair[1] === expected[1]
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'The feedback fixture request failed.'
}

function FeedbackPanel({ context, report }: {
  context: UiPluginContext
  report?: (state: unknown) => void
}) {
  const [worktree, setWorktree] = useState(() => worktreeOf(context.getLayout()))
  const [state, setState] = useState<PanelReport>(() => ({ ready: false, worktree: worktreeOf(context.getLayout()), sequence: 0, error: null }))
  const [layoutRevision, setLayoutRevision] = useState(0)
  const worktreeRef = useRef(worktree)
  const stateRef = useRef(state)
  const reportRef = useRef(report)
  const generation = useRef(0)
  const armedPair = useRef<WorktreePair | null>(null)
  const eventSequence = useRef(0)
  const requestedSequences = useRef(new Set<number>())
  worktreeRef.current = worktree
  stateRef.current = state
  reportRef.current = report

  const publish = useCallback((next: PanelReport) => {
    stateRef.current = next
    setState(next)
    reportRef.current?.(next)
  }, [])

  useEffect(() => context.onLayout((layout) => {
    const next = worktreeOf(layout)
    if (next === worktreeRef.current) return
    generation.current += 1
    setLayoutRevision((revision) => revision + 1)
    worktreeRef.current = next
    armedPair.current = null
    eventSequence.current = 0
    requestedSequences.current = new Set()
    publish({ ready: false, worktree: next, sequence: 0, error: null })
    setWorktree(next)
  }), [context, publish])

  useEffect(() => {
    const currentWorktree = worktree
    const currentGeneration = ++generation.current
    worktreeRef.current = currentWorktree
    armedPair.current = null
    eventSequence.current = 0
    requestedSequences.current = new Set()
    const isCurrent = () => generation.current === currentGeneration && worktreeRef.current === currentWorktree
    const waitingReport = (): PanelReport => ({ ready: false, worktree: currentWorktree, sequence: 0, error: null })

    if (currentWorktree === null) {
      publish(waitingReport())
      return () => { if (generation.current === currentGeneration) generation.current += 1 }
    }

    const refresh = (owner: string, sequence: number) => {
      if (!isCurrent() || owner !== currentWorktree || requestedSequences.current.has(sequence)) return
      requestedSequences.current.add(sequence)
      void context.call('soak.faults/feedbackRefresh', { owner }).then((value) => {
        if (!isCurrent()) return
        if (!record(value) || value.owner !== owner || value.sequence !== sequence) {
          throw new Error(`feedback refresh ${sequence} returned an unexpected result`)
        }
        publish({ ...stateRef.current, sequence, error: null })
      }).catch((error: unknown) => {
        if (!isCurrent()) return
        publish({ ...stateRef.current, error: failureMessage(error) })
      })
    }

    const onEvent = (event: QuirkyEvent) => {
      if (!('data' in event)) return
      const data = event.data
      if (!isCurrent() || !record(data)) return
      if (event.type === 'soak.faults/feedbackStarted') {
        const pair = worktreePair(data.worktrees)
        if (!pair || !pair.includes(currentWorktree) || data.first !== pair[0] || armedPair.current !== null) return
        armedPair.current = pair
        eventSequence.current = 0
        requestedSequences.current = new Set()
        if (currentWorktree === pair[0]) refresh(currentWorktree, 1)
        return
      }
      if (event.type !== 'soak.faults/feedbackChanged') return
      const pair = armedPair.current
      if (!pair || !samePair(data.worktrees, pair)) return
      const sequence = eventSequence.current + 1
      const expectedOwner = sequence % 2 === 1 ? pair[0] : pair[1]
      if (data.sequence !== sequence || data.owner !== expectedOwner || sequence > FEEDBACK_LIMIT) return
      eventSequence.current = sequence
      if (sequence === FEEDBACK_LIMIT) return
      const nextOwner = sequence % 2 === 1 ? pair[1] : pair[0]
      if (currentWorktree === nextOwner) refresh(nextOwner, sequence + 1)
    }

    let unsubscribe = () => {}
    try {
      unsubscribe = context.subscribe(onEvent, { worktreeId: currentWorktree })
      publish({ ready: true, worktree: currentWorktree, sequence: 0, error: null })
    } catch (error) {
      publish({ ...waitingReport(), error: failureMessage(error) })
    }

    return () => {
      if (generation.current === currentGeneration) generation.current += 1
      unsubscribe()
    }
  }, [context, layoutRevision, publish, worktree])

  return createElement(
    'section',
    { className: 'ui-stack', style: { padding: 'var(--ui-space-12)', gap: 'var(--ui-space-8)' } },
    state.error
      ? createElement(InlineError, { message: state.error })
      : createElement(EmptyState, { message: state.ready ? 'Feedback fixture is mounted and listening.' : 'Waiting for a worktree subscription…' }),
    createElement(
      'p',
      { className: 'ui-text-muted', role: 'status' },
      state.worktree === null ? 'No worktree selected.' : `Worktree: ${state.worktree}`,
      ' · Refresh sequence ',
      state.sequence,
      ' of ',
      FEEDBACK_LIMIT
    )
  )
}

export function activate(context: UiPluginContext): void {
  const mount: MountFunction = (element, props) => {
    const root = createRoot(element)
    root.render(createElement(FeedbackPanel, { context, report: props.report }))
    return () => root.unmount()
  }
  context.provide(PANEL_ID, mount)
}
