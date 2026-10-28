import { describe, expect, test } from 'bun:test'
import { decideTaskLinkClick, taskLinkModifierLabel } from '../../src/window/pane/links'
import { openTaskTerminal } from '../../src/window/pane/task-links'
import { fakeContext } from '../ui-fake'

type TaskTerminalTarget = { taskId: string; dispatchId: string; sessionId: string; worktreeId: string }

const taskId = 'task_demo'
const viewId = 'view:quirky.session/worktree'

function click(over: Partial<MouseEvent> = {}): MouseEvent {
  return { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...over } as MouseEvent
}

function target(over: Partial<TaskTerminalTarget> = {}): TaskTerminalTarget {
  return { taskId, dispatchId: 'ctx_demo', sessionId: 's_demo', worktreeId: 'wt_demo', ...over }
}

function sessionFor(destination: TaskTerminalTarget, kind: 'terminal' | 'structured' = 'terminal') {
  return {
    id: destination.sessionId,
    kind,
    agent: 'codex',
    worktreeId: destination.worktreeId,
    cwd: '/tmp/wt_demo',
    title: 'opaque session title',
    status: 'done',
    createdAt: 1,
    lastActivityAt: 2,
    exitCode: 0,
    exitSignal: null,
    exitCause: null,
    restorable: true,
    launch: null,
    providerSession: null,
    promptDelivery: null,
    launchSettings: null,
    resumedFrom: null,
    agentStatus: null,
    name: null,
    unread: null,
    badges: {}
  }
}

function fixtureContext(
  targets: TaskTerminalTarget[],
  latestIndex = 0,
  sessionOverride?: (session: ReturnType<typeof sessionFor>) => unknown,
  refusal?: Error
) {
  let latest = targets[latestIndex]
  const sessions = new Map(targets.map((destination) => [destination.sessionId, sessionFor(destination)]))
  const fake = fakeContext({
    'quirky.orchestration/taskTerminal': ({ taskId: requested }) => {
      if (refusal) throw refusal
      if (!latest || requested !== latest.taskId) throw new Error('No exact current task terminal is available.')
      return latest
    },
    'quirky.session/get': ({ session }) => {
      const found = sessions.get(session)
      return found === undefined ? undefined : sessionOverride ? sessionOverride(found) : found
    }
  })
  return {
    ...fake,
    setLatest(index: number) {
      latest = targets[index]
    }
  }
}

describe('task link click behavior', () => {
  test('plain click offers actions and the platform modifier switches directly', () => {
    expect(decideTaskLinkClick(click(), 'MacIntel')).toBe('popover')
    expect(decideTaskLinkClick(click({ metaKey: true }), 'MacIntel')).toBe('open')
    expect(decideTaskLinkClick(click({ ctrlKey: true }), 'MacIntel')).toBe('none')
    expect(decideTaskLinkClick(click({ ctrlKey: true }), 'Linux x86_64')).toBe('open')
    expect(decideTaskLinkClick(click({ metaKey: true }), 'Linux x86_64')).toBe('none')
    expect(taskLinkModifierLabel('MacIntel')).toBe('Cmd')
    expect(taskLinkModifierLabel('Linux x86_64')).toBe('Ctrl')
  })

  test('opens a context-only Dispatch target without requiring a WorkerRecord', async () => {
    const destination = target({ dispatchId: 'ctx_context_only', sessionId: 's_context_only' })
    const fake = fixtureContext([destination])

    await openTaskTerminal(fake.context, taskId)

    expect(fake.callsTo('quirky.orchestration/taskTerminal').map((call) => call.params)).toEqual([{ taskId }])
    expect(fake.callsTo('quirky.orchestration/workerShow')).toEqual([])
    expect(fake.opened).toEqual([{ id: viewId, input: { worktree: destination.worktreeId, session: destination.sessionId } }])
  })

  test('resolves the latest retry target on each activation', async () => {
    const first = target({ dispatchId: 'ctx_first', sessionId: 's_first' })
    const retry = target({ dispatchId: 'ctx_retry', sessionId: 's_retry' })
    const fake = fixtureContext([first, retry])

    await openTaskTerminal(fake.context, taskId)
    fake.setLatest(1)
    await openTaskTerminal(fake.context, taskId)

    expect(fake.callsTo('quirky.orchestration/taskTerminal').map((call) => call.params)).toEqual([{ taskId }, { taskId }])
    expect(fake.opened).toEqual([
      { id: viewId, input: { worktree: first.worktreeId, session: first.sessionId } },
      { id: viewId, input: { worktree: retry.worktreeId, session: retry.sessionId } }
    ])
  })

  test('a typed target refusal is visible and never opens a view', async () => {
    const fake = fixtureContext([], 0, undefined, Object.assign(new Error('no exact local target'), { code: 'task_terminal_unavailable' }))

    await openTaskTerminal(fake.context, taskId)

    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]?.body.length).toBeGreaterThan(0)
    expect(fake.opened).toEqual([])
  })

  test('malformed target fields or a mismatched session workspace refuse navigation', async () => {
    for (const malformedTarget of [
      target({ taskId: 'task_wrong' }),
      target({ dispatchId: '' }),
      target({ sessionId: '' }),
      target({ worktreeId: '' })
    ]) {
      const malformed = fixtureContext([malformedTarget])
      await openTaskTerminal(malformed.context, taskId)
      expect(malformed.toasts).toHaveLength(1)
      expect(malformed.opened).toEqual([])
    }

    const moved = fixtureContext([target()], 0, (session) => ({ ...session, worktreeId: 'wt_other' }))
    await openTaskTerminal(moved.context, taskId)
    expect(moved.toasts).toHaveLength(1)
    expect(moved.opened).toEqual([])
  })
})
