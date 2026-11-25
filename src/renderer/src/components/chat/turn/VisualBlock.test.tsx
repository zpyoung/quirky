// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RenderItemOf } from '../chat-turns'
import { ChatTurnEnvContext, type ChatTurnEnv } from './chat-turn-env'
import { VisualBlock } from './VisualBlock'

vi.mock('../panels/VisualItemCard', () => ({
  VisualItemCard: ({
    workspaceRoot,
    worktreeId,
    onOpenLink,
    readWorkspaceImage
  }: {
    workspaceRoot: string | null
    worktreeId?: string | null
    onOpenLink?: unknown
    readWorkspaceImage?: unknown
  }) => (
    <div
      data-testid="inline-card"
      data-root={String(workspaceRoot)}
      data-worktree={String(worktreeId)}
      data-link={String(onOpenLink !== undefined)}
      data-reader={String(readWorkspaceImage !== undefined)}
    />
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

function renderBlock(item: RenderItemOf<'visual'>, overrides: Partial<ChatTurnEnv> = {}): void {
  const value: ChatTurnEnv = Object.assign({}, env, overrides)
  render(
    <ChatTurnEnvContext.Provider value={value}>
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

  it('hands the chat workspace root and image reader to an inline visual', () => {
    renderBlock(visual('inline'), {
      workspaceRoot: '/work/repo',
      readWorkspaceImage: vi.fn()
    })
    const card = screen.getByTestId('inline-card')
    expect(card.getAttribute('data-root')).toBe('/work/repo')
    expect(card.getAttribute('data-reader')).toBe('true')
  })

  it('hands the chat worktree id and link opener to an inline visual', () => {
    renderBlock(visual('inline'), { worktreeId: 'wt-1' })
    const card = screen.getByTestId('inline-card')
    expect(card.getAttribute('data-worktree')).toBe('wt-1')
    expect(card.getAttribute('data-link')).toBe('true')
  })

  it('keeps a pane visual as a chip', () => {
    renderBlock(visual('pane'))
    expect(screen.queryByTestId('inline-card')).toBeNull()
    expect(screen.getByRole('button', { name: /Chart v2/ })).toBeTruthy()
  })
})
