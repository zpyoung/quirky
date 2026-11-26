import { describe, expect, it } from 'vitest'
import type { AgentJournalItemBody } from './agent-session-journal-types'
import { projectStructuredItemToNativeChat } from './structured-agent-session-projection'

function textOf(body: AgentJournalItemBody): string | null {
  const message = projectStructuredItemToNativeChat({
    itemId: 'item-1',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body
  })
  if (!message) {
    return null
  }
  expect(message.role).toBe('system')
  return message.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
}

const SPEC = { head: '{}', byteLength: 2, digest: 'd', truncated: false }

describe('v1 chat items on the phone projection', () => {
  it('names the plan version, its status and its text', () => {
    expect(textOf({ kind: 'plan', version: 2, status: 'approved', text: 'Ship it' })).toBe(
      'Plan v2: approved\nShip it'
    )
  })

  it('counts the changed files and lists them', () => {
    expect(
      textOf({
        kind: 'turn-changes',
        turnId: 't',
        source: 'edit-tools',
        files: [
          { path: 'a.ts', status: 'modified' },
          { path: 'b.ts', status: 'added' }
        ]
      })
    ).toBe('2 files changed\na.ts\nb.ts')
    expect(
      textOf({
        kind: 'turn-changes',
        turnId: 't',
        source: 'edit-tools',
        files: [{ path: 'a.ts', status: 'modified' }]
      })
    ).toBe('1 file changed\na.ts')
  })

  it('sends a visual to the desktop, with or without a title', () => {
    const visual = {
      kind: 'visual',
      viewId: 'v',
      version: 1,
      placement: 'pane',
      spec: SPEC
    } as const
    expect(textOf({ ...visual, title: 'Flow' })).toBe('Visual: Flow. Open on desktop.')
    expect(textOf(visual)).toBe('Visual. Open on desktop.')
  })

  it('names the mode switched to', () => {
    expect(textOf({ kind: 'mode', mode: 'plan' })).toBe('Switched to plan')
  })

  it('names the chat a fork came from, or says another chat', () => {
    expect(textOf({ kind: 'fork', fromSessionId: 's', fromTitle: 'Fix login' })).toBe(
      'Forked from Fix login'
    )
    expect(textOf({ kind: 'fork', fromSessionId: 's' })).toBe('Forked from another chat')
  })

  it('counts passed and failed tests, zero when absent', () => {
    const base = { kind: 'test-result', callId: 'c', command: 'pnpm test' } as const
    expect(textOf({ ...base, state: 'failed', passed: 4, failed: 1 })).toBe('4 passed, 1 failed')
    expect(textOf({ ...base, state: 'running' })).toBe('0 passed, 0 failed')
  })

  it('still draws nothing for a kind this build does not know', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a newer host's body is outside the union on purpose.
    expect(textOf({ kind: 'a-newer-kind' } as unknown as AgentJournalItemBody)).toBeNull()
  })
})
