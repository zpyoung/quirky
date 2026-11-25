// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComposerProps } from '../../chat/composer/composer-types'

type MockState = {
  status: { state: string }
  cancel: ReturnType<typeof vi.fn>
  sendNativeChatMessage: ReturnType<typeof vi.fn>
  sendNativeChatTypedCommand: ReturnType<typeof vi.fn>
  sendWithImages: ReturnType<typeof vi.fn>
  composer: { current: ComposerProps | null }
}

const mocks = vi.hoisted((): MockState => ({
  status: { state: 'waiting' },
  cancel: vi.fn(),
  sendNativeChatMessage: vi.fn(),
  sendNativeChatTypedCommand: vi.fn(),
  sendWithImages: vi.fn(),
  composer: { current: null }
}))

vi.mock('../../../store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ agentStatusByPaneKey: { 'pane-1': mocks.status } })
}))
vi.mock('@/lib/structured-agent-session-launch-label', () => ({
  structuredAgentLabel: () => 'Claude'
}))
vi.mock('../../native-chat/use-native-chat-interactive-send', () => ({
  useNativeChatInteractiveSend: () => ({ cancel: mocks.cancel })
}))
vi.mock('../../native-chat/native-chat-runtime-send', () => ({
  sendNativeChatMessage: mocks.sendNativeChatMessage,
  sendNativeChatTypedCommand: mocks.sendNativeChatTypedCommand
}))
vi.mock('../../native-chat/native-chat-runtime-image-send', () => ({
  sendNativeChatMessageWithImageAttachments: mocks.sendWithImages
}))
vi.mock('../../chat/composer/Composer', () => ({
  Composer: (props: ComposerProps) => {
    mocks.composer.current = props
    return <div data-testid="composer" data-quarantined={String(props.quarantined)} />
  }
}))

import {
  _resetTerminalInputQuarantineForTests,
  armTerminalInputQuarantine
} from '../terminal-input-quarantine'
import { TerminalDockComposer } from './TerminalDockComposer'

const baseProps = {
  ref: null,
  terminalTabId: 'tab-1',
  paneKey: 'pane-1',
  targetPtyId: 'pty-1',
  agent: 'claude' as const,
  canSend: true
}

async function submit(text: string, attachments: { path: string; previewUri: string }[] = []) {
  return mocks.composer.current?.onSubmit(text, attachments)
}

describe('TerminalDockComposer', () => {
  beforeEach(() => {
    mocks.status.state = 'waiting'
    mocks.composer.current = null
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
    _resetTerminalInputQuarantineForTests()
  })

  it('types a sent message into the pty through the per-pty send queue', async () => {
    render(<TerminalDockComposer {...baseProps} />)

    expect(mocks.composer.current?.mode).toBe('terminal')
    await submit('hello agent')

    expect(mocks.sendNativeChatMessage).toHaveBeenCalledExactlyOnceWith(
      { terminalTabId: 'tab-1', ptyId: 'pty-1' },
      'hello agent'
    )
  })

  it('refuses a send while the tab is quarantined and keeps the draft', async () => {
    render(<TerminalDockComposer {...baseProps} />)
    expect(screen.getByTestId('composer')).toHaveAttribute('data-quarantined', 'false')

    act(() => armTerminalInputQuarantine('tab-1'))

    expect(screen.getByTestId('composer')).toHaveAttribute('data-quarantined', 'true')
    await expect(submit('rm -rf x')).resolves.toBe(false)
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
    expect(mocks.sendWithImages).not.toHaveBeenCalled()
  })

  it('refuses a send that races ahead of the quarantine render', async () => {
    render(<TerminalDockComposer {...baseProps} />)
    const staleSubmit = mocks.composer.current?.onSubmit

    armTerminalInputQuarantine('tab-1')

    await expect(staleSubmit?.('echo hi', [])).resolves.toBe(false)
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
  })

  it('sends again once the quarantine releases', async () => {
    render(<TerminalDockComposer {...baseProps} />)
    act(() => armTerminalInputQuarantine('tab-1'))
    act(() => _resetTerminalInputQuarantineForTests())

    await submit('ls')

    expect(mocks.sendNativeChatMessage).toHaveBeenCalledTimes(1)
  })

  it('keeps the draft when the terminal has no pty', async () => {
    render(<TerminalDockComposer {...baseProps} targetPtyId={null} />)

    expect(mocks.composer.current?.disabled).toBe(true)
    await expect(submit('hello')).resolves.toBe(false)
    expect(mocks.sendNativeChatMessage).not.toHaveBeenCalled()
  })

  it('sends attached images with the message', async () => {
    render(<TerminalDockComposer {...baseProps} />)

    await submit('look', [{ path: '/tmp/a.png', previewUri: '/tmp/a.png' }])

    expect(mocks.sendWithImages).toHaveBeenCalledExactlyOnceWith(
      'claude',
      { terminalTabId: 'tab-1', ptyId: 'pty-1' },
      'look',
      ['/tmp/a.png']
    )
  })

  it('offers Stop only while the agent works, routed through the terminal cancel', () => {
    const { rerender } = render(<TerminalDockComposer {...baseProps} />)
    expect(mocks.composer.current?.working).toBe(false)

    mocks.status.state = 'working'
    rerender(<TerminalDockComposer {...baseProps} />)

    expect(mocks.composer.current?.working).toBe(true)
    mocks.composer.current?.onStop?.()
    expect(mocks.cancel).toHaveBeenCalledTimes(1)
  })
})
