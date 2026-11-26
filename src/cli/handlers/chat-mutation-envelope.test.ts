import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MutationEnvelope } from '../../shared/rpc-contract/structured-agent-session-params'
import { buildMutationEnvelope } from './chat-mutation-envelope'

const SESSION_ID = 'claude_0b1c2d3e_4f5a_4b6c_8d7e_9f0a1b2c3d4e'

function build(fields: Record<string, unknown>, method = 'agentSession.setOption') {
  return buildMutationEnvelope({
    method,
    sessionId: SESSION_ID,
    fields,
    expectedRuntimeFence: 4
  })
}

describe('buildMutationEnvelope', () => {
  it('produces an envelope the host schema accepts', () => {
    expect(MutationEnvelope.safeParse(build({ key: 'model', value: 'opus' })).success).toBe(true)
    expect(
      MutationEnvelope.safeParse(
        buildMutationEnvelope({
          method: 'agentSession.create',
          sessionId: SESSION_ID,
          fields: {},
          expectedRuntimeFence: null
        })
      ).success
    ).toBe(true)
  })

  it('fingerprints the sorted-key JSON of the method, session and fields', () => {
    const expected = createHash('sha256')
      .update(
        `{"fields":{"key":"model","value":"opus"},"method":"agentSession.setOption","sessionId":"${SESSION_ID}"}`
      )
      .digest('hex')
    expect(build({ key: 'model', value: 'opus' }).payloadFingerprint).toBe(expected)
  })

  it('gives the same fingerprint however the keys are ordered, at every depth', () => {
    const first = build({ body: { kind: 'message', blocks: [{ type: 'text', text: 'hi' }] }, a: 1 })
    const second = build({
      a: 1,
      body: { blocks: [{ text: 'hi', type: 'text' }], kind: 'message' }
    })
    expect(first.payloadFingerprint).toBe(second.payloadFingerprint)
  })

  it('ignores fields that are undefined', () => {
    expect(build({ itemId: 'i1', optionId: undefined }).payloadFingerprint).toBe(
      build({ itemId: 'i1' }).payloadFingerprint
    )
  })

  it('changes the fingerprint when a value or the method changes', () => {
    const base = build({ key: 'model', value: 'opus' }).payloadFingerprint
    expect(build({ key: 'model', value: 'sonnet' }).payloadFingerprint).not.toBe(base)
    expect(build({ key: 'model', value: 'opus' }, 'agentSession.send').payloadFingerprint).not.toBe(
      base
    )
  })

  it('mints a new operation id on every call', () => {
    const ids = new Set(
      Array.from({ length: 20 }, () => build({ key: 'model', value: 'opus' }).clientOperationId)
    )
    expect(ids.size).toBe(20)
    for (const id of ids) {
      expect(id).toMatch(/^\d{13}-[0-9a-f]{32}$/)
    }
  })

  it('embeds the uuid it is given in the operation id', () => {
    const envelope = buildMutationEnvelope({
      method: 'agentSession.cancel',
      sessionId: SESSION_ID,
      fields: {},
      expectedRuntimeFence: 1,
      randomUuid: () => '123e4567-e89b-42d3-a456-426614174000',
      now: 1_790_000_000_000
    })
    expect(envelope.clientOperationId).toBe('1790000000000-123e4567e89b42d3a456426614174000')
  })

  it('carries the fence it is given, null included', () => {
    expect(build({}).expectedRuntimeFence).toBe(4)
    expect(
      buildMutationEnvelope({
        method: 'agentSession.cancel',
        sessionId: SESSION_ID,
        fields: {},
        expectedRuntimeFence: null
      }).expectedRuntimeFence
    ).toBeNull()
  })
})
