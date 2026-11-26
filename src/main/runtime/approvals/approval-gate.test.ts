import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttributedCaller } from '../../../shared/public-rpc/caller-hint'
import type { AskEnvelope } from '../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type { AskSpec } from '../../../shared/fork-ask-question-tool/ask-question-schema'
import type { AskOrigin } from '../../fork-ask-question-tool/ask-registry'
import {
  APPROVAL_TIMEOUT_MS,
  ApprovalGate,
  readAgentApprovalPolicySetting,
  type ApprovalRegistry
} from './approval-gate'

const CALLER: AttributedCaller = { kind: 'agent-session', label: 'Agent abc12345' }
const ASK_ID = 'ask_1'

// A registry whose waitChunk behaves like the real one: it resolves with the terminal envelope
// when the ask is settled, and with `pending` when the chunk or the abort signal runs out.
function createFakeRegistry() {
  const registered: { spec: AskSpec; origin: AskOrigin }[] = []
  const cancelled: string[] = []
  let settle: (envelope: AskEnvelope) => void = () => {}
  const registry: ApprovalRegistry = {
    register: async (spec, origin) => {
      registered.push({ spec, origin })
      return { askId: ASK_ID }
    },
    waitChunk: (askId, chunkMs, signal) =>
      new Promise<AskEnvelope>((resolve) => {
        const pending: AskEnvelope = { status: 'pending', askId, instruction: 'wait' }
        const timer = setTimeout(() => resolve(pending), chunkMs)
        signal.addEventListener('abort', () => resolve(pending), { once: true })
        settle = (envelope) => {
          clearTimeout(timer)
          resolve(envelope)
        }
      }),
    cancel: (askId) => {
      cancelled.push(askId)
      return { committed: true }
    }
  }
  return {
    registry,
    registered,
    cancelled,
    answer: (value: boolean) =>
      settle({
        status: 'answered',
        askId: ASK_ID,
        answers: { approve: { value, source: 'input' } },
        skipped: [],
        summary: ''
      }),
    resolveWith: (status: 'declined' | 'timed_out' | 'unavailable') =>
      settle(
        status === 'unavailable'
          ? { status, askId: ASK_ID, reason: 'pane gone', answers: {}, skipped: [], summary: '' }
          : { status, askId: ASK_ID, answers: {}, skipped: [], summary: '' }
      )
  }
}

function createGate(policy: unknown = {}) {
  const fake = createFakeRegistry()
  const gate = new ApprovalGate({ readPolicy: () => policy, registry: () => fake.registry })
  return { gate, ...fake }
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('ApprovalGate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('policyFor', () => {
    it('reads the configured mode per category', () => {
      const { gate } = createGate({ 'workspace-delete': 'ask', 'security-settings': 'agent' })

      expect(gate.policyFor('workspace-delete')).toBe('ask')
      expect(gate.policyFor('security-settings')).toBe('agent')
    })

    it('defaults a category the setting does not list to agent', () => {
      const { gate } = createGate({ 'workspace-delete': 'ask' })

      expect(gate.policyFor('chat-discard-rewind')).toBe('agent')
    })

    it.each([undefined, null, 'ask', { 'workspace-delete': 'always' }])(
      'treats the malformed setting %j as all agent',
      (policy) => {
        const { gate } = createGate(policy)

        expect(gate.policyFor('workspace-delete')).toBe('agent')
      }
    )

    it('re-reads the setting on every call', () => {
      let policy: unknown = { 'workspace-delete': 'agent' }
      const fake = createFakeRegistry()
      const gate = new ApprovalGate({ readPolicy: () => policy, registry: () => fake.registry })

      policy = { 'workspace-delete': 'ask' }

      expect(gate.policyFor('workspace-delete')).toBe('ask')
    })
  })

  describe('readAgentApprovalPolicySetting', () => {
    it('returns the stored policy and nothing for a store without one', () => {
      const policy = { 'workspace-delete': 'ask' }

      expect(
        readAgentApprovalPolicySetting({ getSettings: () => ({ agentApprovalPolicy: policy }) })
      ).toBe(policy)
      expect(readAgentApprovalPolicySetting({ getSettings: () => ({}) })).toBeUndefined()
      expect(readAgentApprovalPolicySetting(null)).toBeUndefined()
    })
  })

  describe('require', () => {
    it('asks a confirm question naming the caller, the call and its effects', async () => {
      const { gate, registered, answer } = createGate()

      const result = gate.require(
        'workspace-delete',
        CALLER,
        'delete workspace',
        ['removes /tmp/wt', 'drops 2 branches'],
        { worktreeId: 'wt-1', paneKey: 'pane-1' }
      )
      await flush()
      answer(true)

      await expect(result).resolves.toBe('approved')
      expect(registered).toHaveLength(1)
      expect(registered[0].origin).toEqual({ paneKey: 'pane-1', worktreeId: 'wt-1' })
      const [question] = registered[0].spec.questions
      expect(question).toMatchObject({ id: 'approve', type: 'confirm' })
      expect(question.question).toContain('Agent abc12345 wants to: delete workspace')
      expect(question.question).toContain('- removes /tmp/wt')
      expect(question.question).toContain('- drops 2 branches')
    })

    it('registers without a pane when the caller names none', async () => {
      const { gate, registered, answer } = createGate()

      const result = gate.require('workspace-delete', CALLER, 'delete workspace', [])
      await flush()
      answer(true)
      await result

      expect(registered[0].origin).toEqual({ paneKey: null, worktreeId: null })
    })

    it('throws needs_confirmation/declined when the user answers no', async () => {
      const { gate, answer, cancelled } = createGate()

      const result = gate.require('workspace-delete', CALLER, 'delete workspace', [])
      const assertion = expect(result).rejects.toMatchObject({
        name: 'PublicRpcError',
        code: 'needs_confirmation',
        reason: 'declined'
      })
      await flush()
      answer(false)

      await assertion
      expect(cancelled).toEqual([])
    })

    it('throws declined when the user dismisses the question', async () => {
      const { gate, resolveWith } = createGate()

      const result = gate.require('workspace-delete', CALLER, 'delete workspace', [])
      const assertion = expect(result).rejects.toMatchObject({
        code: 'needs_confirmation',
        reason: 'declined'
      })
      await flush()
      resolveWith('declined')

      await assertion
    })

    it.each(['timed_out', 'unavailable'] as const)(
      'throws timed_out when the ask ends as %s',
      async (status) => {
        const { gate, resolveWith } = createGate()

        const result = gate.require('workspace-delete', CALLER, 'delete workspace', [])
        const assertion = expect(result).rejects.toMatchObject({
          code: 'needs_confirmation',
          reason: 'timed_out'
        })
        await flush()
        resolveWith(status)

        await assertion
      }
    )

    it('gives up after APPROVAL_TIMEOUT_MS, cancels the ask and throws timed_out', async () => {
      const { gate, cancelled } = createGate()

      const result = gate.require('workspace-delete', CALLER, 'delete workspace', [])
      const assertion = expect(result).rejects.toMatchObject({
        code: 'needs_confirmation',
        reason: 'timed_out'
      })
      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS - 1)
      expect(cancelled).toEqual([])
      await vi.advanceTimersByTimeAsync(1)

      await assertion
      expect(cancelled).toEqual([ASK_ID])
    })

    it('cancels the ask and throws declined when the requesting client goes away', async () => {
      const { gate, cancelled } = createGate()
      const controller = new AbortController()

      const result = gate.require('workspace-delete', CALLER, 'delete workspace', [], {
        signal: controller.signal
      })
      const assertion = expect(result).rejects.toMatchObject({
        code: 'needs_confirmation',
        reason: 'declined'
      })
      await flush()
      controller.abort()

      await assertion
      expect(cancelled).toEqual([ASK_ID])
    })

    it('carries a next step on both refusals', async () => {
      const { gate, answer } = createGate()

      const result = gate.require('workspace-delete', CALLER, 'delete workspace', [])
      await flush()
      answer(false)

      const error = await result.catch((caught: unknown) => caught)
      expect(error).toMatchObject({
        next: [expect.objectContaining({ command: expect.any(String) })]
      })
    })
  })
})
