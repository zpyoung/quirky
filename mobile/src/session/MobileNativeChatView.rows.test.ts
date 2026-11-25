import { describe, expect, it, vi } from 'vitest'
import type { AgentJournalItemBody } from '../../../src/shared/agent-session-journal-types'
import { projectStructuredItemToNativeChat } from '../../../src/shared/structured-agent-session-projection'
import {
  installChatViewHooks,
  assistantTurn,
  listIds,
  render,
  renderedRow,
  update
} from './MobileNativeChatView.harness.test-fixture'

vi.mock('react-native', async () => {
  const { reactNativeStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return reactNativeStub()
})
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', async () => {
  const { gestureHandlerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return gestureHandlerStub()
})
vi.mock('lucide-react-native', () => ({
  ArrowDown: 'ArrowDown',
  ChevronsDownUp: 'ChevronsDownUp',
  ChevronsUpDown: 'ChevronsUpDown',
  Square: 'Square'
}))
vi.mock('./MobileNativeChatMessage', () => ({ MobileNativeChatMessage: 'ChatMessage' }))
vi.mock('./MobileNativeChatLiveLine', () => ({ MobileNativeChatLiveLine: 'LiveStatus' }))
vi.mock('./MobileNativeChatAsk', () => ({ MobileNativeChatAsk: 'ChatAsk' }))
vi.mock('./MobileNativeChatPermission', () => ({ MobileNativeChatPermission: 'ChatPermission' }))
vi.mock('./MobileNativeChatQuestion', () => ({ MobileNativeChatQuestion: 'ChatQuestion' }))
vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('./MobileNativeChatComposer', async () => {
  const { composerStub } = await import('./MobileNativeChatView.render-stubs.test-fixture')
  return composerStub()
})

describe('MobileNativeChatView: rows and the streaming bubble', () => {
  installChatViewHooks()

  // The gate that decides `streaming` lives in MobileNativeChatOverlay, which
  // outlives this view; see MobileNativeChatOverlay.test.ts.
  it('appends the gated streaming bubble after the folded transcript', async () => {
    const folded = [assistantTurn('a1', 'The tests pass.')]
    await render({ folded })
    expect(listIds()).toEqual(['a1'])

    await update({ folded, streaming: 'The tests' })

    expect(listIds()).toEqual(['a1', 'streaming'])
  })

  it('tells a row whether the host still waits on the prompt it stands for', async () => {
    const rows = [assistantTurn('asked', 'Tea or coffee?'), assistantTurn('open', 'Which branch?')]
    await render({ messages: rows, folded: rows, actionablePromptIds: ['open'] })
    expect(renderedRow('asked').props.awaiting).toBe(false)
    expect(renderedRow('open').props.awaiting).toBe(true)
  })

  it('draws a row for each v1 chat item kind', async () => {
    const spec = { head: '{}', byteLength: 2, digest: 'd', truncated: false }
    const bodies: AgentJournalItemBody[] = [
      { kind: 'plan', version: 1, status: 'waiting', text: 'Step one' },
      {
        kind: 'turn-changes',
        turnId: 't',
        source: 'edit-tools',
        files: [{ path: 'a.ts', status: 'added' }]
      },
      { kind: 'mode', mode: 'plan' },
      { kind: 'fork', fromSessionId: 's' },
      { kind: 'visual', viewId: 'v', version: 1, placement: 'inline', spec },
      { kind: 'test-result', callId: 'c', command: 'pnpm test', state: 'passed', passed: 2 }
    ]
    const rows = bodies.flatMap((body, index) => {
      const message = projectStructuredItemToNativeChat({
        itemId: `${body.kind}-${index}`,
        revision: 1,
        sequence: index + 1,
        observedAt: index + 1,
        body
      })
      return message ? [message] : []
    })

    await render({ messages: rows, folded: rows })

    expect(listIds()).toEqual(rows.map((row) => row.id))
    expect(rows).toHaveLength(bodies.length)
  })

  it('renders an accepted optimistic image send without a queued state', async () => {
    await render({
      pending: [{ id: 'pending-1', text: 'look', images: ['file:///phone-photo.jpg'] }]
    })

    expect(listIds()).toEqual(['pending-1'])
    expect(renderedRow('pending-1').props).not.toHaveProperty('queued')
  })
})
