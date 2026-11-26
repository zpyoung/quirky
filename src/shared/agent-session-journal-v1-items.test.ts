import { describe, expect, it } from 'vitest'
import { AgentJournalItemBodySchema } from './agent-session-journal-schemas'
import { V1_CHAT_ITEM_KINDS } from './agent-session-journal-v1-items'

const BOUNDED = { head: '{"kind":"markdown"}', byteLength: 19, digest: 'abc', truncated: false }

const BODIES = {
  plan: { kind: 'plan', version: 1, status: 'waiting', text: 'Do the thing' },
  'turn-changes': {
    kind: 'turn-changes',
    turnId: 'turn-1',
    source: 'git-tree',
    fromTree: 'aaa',
    toTree: 'bbb',
    files: [{ path: 'a.ts', status: 'renamed', oldPath: 'b.ts', added: 1, removed: 2 }]
  },
  mode: { kind: 'mode', mode: 'plan', previous: 'ask' },
  fork: { kind: 'fork', fromSessionId: 'session-1', fromItemId: 'item-1' },
  visual: { kind: 'visual', viewId: 'view-1', version: 1, placement: 'inline', spec: BOUNDED },
  'test-result': {
    kind: 'test-result',
    callId: 'call-1',
    command: 'pnpm test',
    state: 'failed',
    passed: 3,
    failed: 1
  }
} as const

describe('v1 chat journal items', () => {
  it.each(V1_CHAT_ITEM_KINDS)('reads a %s body', (kind) => {
    expect(AgentJournalItemBodySchema.parse(BODIES[kind])).toEqual(BODIES[kind])
  })

  it('refuses a known kind with a value outside its closed set', () => {
    expect(
      AgentJournalItemBodySchema.safeParse({ ...BODIES.plan, status: 'rejected' }).success
    ).toBe(false)
  })

  it('still admits a kind this build does not know', () => {
    const unknown = { kind: 'a-newer-kind', anything: 1 }
    expect(AgentJournalItemBodySchema.safeParse(unknown).success).toBe(true)
  })
})
