// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RenderItemOf } from '../chat-turns'
import { ChatErrorActionsProvider } from '../turn/chat-error-actions'
import { ErrorRow } from '../turn/ErrorRow'

const mocks = vi.hoisted(() => ({
  continueOffer: vi.fn(),
  runFork: vi.fn(),
  resolveSubject: vi.fn()
}))

vi.mock('@/components/native-chat-resume-on-restart-store', () => ({
  continueNativeChatRestartOffer: mocks.continueOffer
}))
vi.mock('@/components/tab-bar/native-chat-cli-fork-run', () => ({
  runNativeChatCliFork: mocks.runFork
}))
vi.mock('@/components/tab-bar/tab-session-history-switch', () => ({
  resolveTabSessionHistorySubject: mocks.resolveSubject
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: { agentCmdOverrides: { claude: 'cl' } } }) }
}))

import { useChatSessionErrorActions } from './use-chat-session-error-actions'

const item: RenderItemOf<'status'> = {
  itemId: 'status-1',
  revision: 1,
  sequence: 1,
  observedAt: 0,
  body: { kind: 'status', text: 'agent exited' }
}

function Harness(props: {
  retryLaunch?: () => void
  ownerWorktreeId?: string | null
  target?: { kind: 'local' } | { kind: 'environment'; environmentId: string }
}): React.JSX.Element {
  const actions = useChatSessionErrorActions({
    tabId: 'tab-1',
    sessionId: 'session-1',
    agent: 'claude',
    target: props.target ?? { kind: 'local' },
    ownerWorktreeId: props.ownerWorktreeId === undefined ? 'wt-1' : props.ownerWorktreeId,
    retryLaunch: props.retryLaunch
  })
  return (
    <ChatErrorActionsProvider actions={actions}>
      <ErrorRow item={item} />
    </ChatErrorActionsProvider>
  )
}

beforeEach(() => {
  mocks.continueOffer.mockReset()
  mocks.runFork.mockReset()
  mocks.resolveSubject.mockReset()
  mocks.resolveSubject.mockReturnValue({ kind: 'chat', sessionId: 'session-1' })
})
afterEach(cleanup)

describe('useChatSessionErrorActions', () => {
  it('restarts a local chat through the resume path and opens a copy in the terminal agent', () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))
    expect(mocks.continueOffer).toHaveBeenCalledWith(['session-1'])

    fireEvent.click(screen.getByRole('button', { name: 'Open in terminal' }))
    expect(mocks.runFork).toHaveBeenCalledWith({
      subject: { kind: 'chat', sessionId: 'session-1' },
      tab: { id: 'tab-1', worktreeId: 'wt-1' },
      agent: 'claude',
      commandOverrides: { claude: 'cl' }
    })
  })

  it('retries a failed start instead of resuming', () => {
    const retryLaunch = vi.fn()
    render(<Harness retryLaunch={retryLaunch} />)

    fireEvent.click(screen.getByRole('button', { name: 'Restart' }))

    expect(retryLaunch).toHaveBeenCalledTimes(1)
    expect(mocks.continueOffer).not.toHaveBeenCalled()
  })

  it('offers no restart for a remote chat whose start did not fail, and no terminal without a workspace', () => {
    render(
      <Harness target={{ kind: 'environment', environmentId: 'env-1' }} ownerWorktreeId={null} />
    )

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('does not open the terminal when the tab has no history subject', () => {
    mocks.resolveSubject.mockReturnValue(null)
    render(<Harness />)

    fireEvent.click(screen.getByRole('button', { name: 'Open in terminal' }))

    expect(mocks.runFork).not.toHaveBeenCalled()
  })
})
