// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RenderItemOf } from '../chat-turns'
import { ChatTurnEnvContext, type ChatTurnEnv } from './chat-turn-env'
import { VisualBlock } from './VisualBlock'

vi.mock('../panels/VisualItemCard', () => ({
  VisualItemCard: ({ workspaceRoot }: { workspaceRoot: string | null }) => (
    <div data-testid="inline-card" data-root={String(workspaceRoot)} />
  )
}))

afterEach(cleanup)

function visual(placement: 'inline' | 'pane'): RenderItemOf<'visual'> {
  return {
    itemId: 'v-1',
    revision: 1,
    sequence: 1,
    observedAt: 0,
    body: {
      kind: 'visual',
      viewId: 'view-1',
      version: 2,
      title: 'Chart',
      placement,
      spec: { head: '{}', byteLength: 2, digest: 'd', truncated: false }
    }
  }
}

const env: ChatTurnEnv = {
  sessionId: 's1',
  target: { kind: 'local' },
  roster: new Map(),
  rewind: undefined,
  answerableAskIds: new Set(),
  respond: vi.fn(),
  cancelAsk: vi.fn(),
  markdown: { assets: undefined, onOpenLink: vi.fn() },
  onOpenPlan: undefined,
  onOpenVisual: vi.fn(),
  onSendComments: undefined,
  hostServesV1ChatMethods: true
}

function renderBlock(item: RenderItemOf<'visual'>): void {
  render(
    <ChatTurnEnvContext.Provider value={env}>
      <VisualBlock item={item} />
    </ChatTurnEnvContext.Provider>
  )
}

describe('VisualBlock', () => {
  it('draws an inline visual in the turn with an Open in panel control', () => {
    renderBlock(visual('inline'))
    expect(screen.getByTestId('inline-card').getAttribute('data-root')).toBe('null')
    expect(screen.getByRole('button', { name: 'Open in panel' })).toBeTruthy()
  })

  it('keeps a pane visual as a chip', () => {
    renderBlock(visual('pane'))
    expect(screen.queryByTestId('inline-card')).toBeNull()
    expect(screen.getByRole('button', { name: /Chart v2/ })).toBeTruthy()
  })
})
