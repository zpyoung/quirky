// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { StructuredAgentSessionQueuedMessagesController } from '@/components/native-chat/use-structured-agent-session-queued-messages'
import type { ComposerProps } from '../composer/composer-types'
import type { ChatSessionComposerProps } from './ChatSessionComposer'

type MockState = {
  composer: { current: ComposerProps | null }
  hostAgent: { current: { capabilities: { planMode?: boolean } } | undefined }
}

const mocks = vi.hoisted((): MockState => ({
  composer: { current: null },
  hostAgent: { current: undefined }
}))

vi.mock('../composer/Composer', () => ({
  Composer: (props: ComposerProps) => {
    mocks.composer.current = props
    return null
  }
}))
vi.mock('@/runtime/use-host-structured-agent', () => ({
  useHostStructuredAgent: () => mocks.hostAgent.current,
  useStructuredAgentAcceptsImages: () => true
}))
vi.mock('@/components/native-chat/NativeChatComposerNotices', () => ({
  NativeChatPromptSlotNotices: () => null
}))
vi.mock('@/components/native-chat/native-chat-composer-draft-store', () => ({
  structuredAgentSessionDraftScopeKey: (sessionId: string) => `structured:${sessionId}`
}))
vi.mock('@/lib/structured-agent-session-launch-label', () => ({
  structuredAgentLabel: (agent: string) => agent
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

import { ChatSessionComposer } from './ChatSessionComposer'

const TARGET: RuntimeClientTarget = { kind: 'local' }

function baseController(overrides: Record<string, unknown> = {}) {
  return {
    fence: 3,
    conversationCommands: ['compact'],
    sessionCommands: undefined,
    optionSurface: {},
    setStructuredOption: vi.fn(),
    acceptsImages: true,
    canStop: false,
    send: vi.fn(() => true),
    runConversationCommand: vi.fn(async () => ({ accepted: true, error: null })),
    ...overrides
  }
}

function renderComposer(
  controller: ReturnType<typeof baseController>,
  props: Partial<ChatSessionComposerProps> = {}
) {
  const onError = vi.fn()
  const sendThroughLaunch = vi.fn(
    (_text: string, _withImages: boolean, send: () => boolean | 'queued') => send()
  )
  render(
    <ChatSessionComposer
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the composer reads only the fields baseController supplies.
      controller={controller as unknown as ChatSessionComposerProps['controller']}
      sessionId="session-1"
      agent="claude"
      target={TARGET}
      tabId="tab-1"
      paneKey="tab-1:session-1"
      worktreeId="wt-1"
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the composer only forwards the queue to the stubbed Composer.
      queue={{ cards: [] } as unknown as StructuredAgentSessionQueuedMessagesController}
      sendThroughLaunch={sendThroughLaunch}
      starting={false}
      transportEnabled
      sendBlockedReason={null}
      unavailableHint={undefined}
      working={false}
      onStop={undefined}
      notices={[]}
      onError={onError}
      {...props}
    />
  )
  return { onError, sendThroughLaunch }
}

beforeEach(() => {
  mocks.composer.current = null
  mocks.hostAgent.current = undefined
})
afterEach(cleanup)

describe('ChatSessionComposer', () => {
  it('moves queued messages under the runtime fence the queue was read at', () => {
    renderComposer(baseController({ fence: 7 }))

    expect(mocks.composer.current?.queueMove).toEqual({
      target: TARGET,
      sessionId: 'session-1',
      fence: 7
    })
  })

  it('keeps a missing fence as null so the queue never moves under a guessed one', () => {
    renderComposer(baseController({ fence: null }))

    expect(mocks.composer.current?.queueMove?.fence).toBeNull()
  })

  it.each([
    [{ capabilities: { planMode: true } }, true],
    [{ capabilities: {} }, false],
    [undefined, false]
  ])('offers plan mode from the agent capabilities: %j', (hostAgent, expected) => {
    mocks.hostAgent.current = hostAgent
    renderComposer(baseController())

    expect(mocks.composer.current?.planModeAvailable).toBe(expected)
  })

  it('sends through the launch gate with the attachments and returns its verdict', async () => {
    const controller = baseController({ send: vi.fn(() => 'queued') })
    const { sendThroughLaunch } = renderComposer(controller)
    const attachments = [{ path: '/tmp/a.png', previewUri: '/tmp/a.png' }]

    const result = await mocks.composer.current?.onSubmit('look', attachments)

    expect(sendThroughLaunch).toHaveBeenCalledWith('look', true, expect.any(Function))
    expect(controller.send).toHaveBeenCalledWith('look', attachments)
    expect(result).toBe('queued')
  })

  it('refuses a send while the host may take no turn, keeping the draft', async () => {
    const controller = baseController()
    const { onError, sendThroughLaunch } = renderComposer(controller, {
      sendBlockedReason: 'Checking whether Claude is ready…'
    })

    const result = await mocks.composer.current?.onSubmit('hello', [])

    expect(result).toBe(false)
    expect(onError).toHaveBeenCalledWith('Checking whether Claude is ready…')
    expect(sendThroughLaunch).not.toHaveBeenCalled()
    expect(controller.send).not.toHaveBeenCalled()
  })

  it('runs a host command through the session and reports its refusal', async () => {
    const controller = baseController({
      runConversationCommand: vi.fn(async () => ({
        accepted: false,
        error: 'Wait for the agent to finish.',
        refusedWhile: 'working'
      }))
    })
    const { onError } = renderComposer(controller)

    mocks.composer.current?.onRunCommand?.({ name: 'compact', kind: 'host' })
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith('Wait for the agent to finish.', {
        refusedWhile: 'working'
      })
    )
    expect(controller.runConversationCommand).toHaveBeenCalledWith('compact')
  })

  it('disables the composer while the chat waits on an install', () => {
    renderComposer(baseController(), { unavailableHint: 'Install Claude' })

    expect(mocks.composer.current?.disabled).toBe(true)
  })
})
