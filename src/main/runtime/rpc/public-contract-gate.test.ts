import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttributedCaller, CallerHint } from '../../../shared/public-rpc/caller-hint'
import type { PublicMethodSpec } from '../../../shared/public-rpc/public-method-spec'
import type * as PublicMethodsModule from '../../../shared/public-rpc/public-methods'
import type { AskEnvelope } from '../../../shared/fork-ask-question-tool/ask-answer-envelope'
import {
  APPROVAL_TIMEOUT_MS,
  ApprovalGate,
  type ApprovalRegistry
} from '../approvals/approval-gate'
import type { QuirkyRuntimeService } from '../quirky-runtime'
import type { RpcContext, RpcMethod, RpcRequest, RpcResponse } from './core'
import {
  clearDestructivePreviewersForTest,
  registerDestructivePreviewer
} from './destructive-previewers'
import { mapRuntimeError } from './errors'
import { gatePublicContract, readCallerHint, resolvePublicCaller } from './public-contract-gate'
import { PublicRpcError } from './public-rpc-error'
import { admitRpcRequest } from './rpc-request-admission-prologue'
import { OWNER_RPC_CALLER_SCOPE, type RpcCallerScope } from './rpc-caller-scope'

// A public mutating spec with an approval category; no shipped spec has one yet.
vi.mock('../../../shared/public-rpc/public-methods', async (importOriginal) => {
  const actual = await importOriginal<typeof PublicMethodsModule>()
  const { z } = await import('zod')
  const approvalGatedSpec: PublicMethodSpec = {
    method: 'test.approvalGated',
    cliPath: ['test', 'approval-gated'],
    summary: 'change a security setting',
    stability: 'stable',
    effect: 'mutate',
    params: null,
    result: z.unknown(),
    approvalCategory: 'security-settings',
    errors: ['needs_confirmation']
  }
  return {
    ...actual,
    publicSpecForMethod: (name: string) =>
      name === approvalGatedSpec.method ? approvalGatedSpec : actual.publicSpecForMethod(name)
  }
})

// git.discard is classified destructive in 'file-overwrite-delete'; events.unsubscribe is a public mutation.
const DESTRUCTIVE = 'git.discard'
const PUBLIC_MUTATION = 'events.unsubscribe'
const AGENT_ENV_REQUEST = { agentSessionId: 'session-abcdef123456', worktreeId: 'wt-1' }

function createMethod(
  name: string,
  handler: RpcMethod['handler'] = vi.fn(async () => ({ done: true }))
): RpcMethod {
  return { name, permission: 'workspace', params: null, handler }
}

function createRequest(method: string, extra: Partial<RpcRequest> = {}): RpcRequest {
  return { id: 'req-1', authToken: 'token', method, ...extra }
}

type ApprovalWorld = ReturnType<typeof createWorld>

function createWorld(policy: Record<string, 'agent' | 'ask'> = {}) {
  const asked: { askId: string }[] = []
  const cancelled: string[] = []
  let settle: (envelope: AskEnvelope) => void = () => {}
  const registry: ApprovalRegistry = {
    register: async () => {
      const askId = `ask_${asked.length + 1}`
      asked.push({ askId })
      return { askId }
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
  const approvalGate = new ApprovalGate({ readPolicy: () => policy, registry: () => registry })
  const requireSpy = vi.spyOn(approvalGate, 'require')
  const activityTrail = { record: vi.fn() }
  const getTerminalPaneKey = vi.fn((_handle: string): string | null => null)
  // SAFETY: the gate and rpcContextFromTransport read only these members of the runtime.
  const runtime = {
    approvalGate,
    activityTrail,
    getTerminalPaneKey
  } as unknown as QuirkyRuntimeService
  return {
    runtime,
    activityTrail,
    approvalGate,
    requireSpy,
    asked,
    cancelled,
    getTerminalPaneKey,
    answer: (value: boolean): void =>
      settle({
        status: 'answered',
        askId: 'ask_1',
        answers: { approve: { value, source: 'input' } },
        skipped: [],
        summary: ''
      })
  }
}

function gate(
  world: ApprovalWorld,
  method: RpcMethod,
  request: RpcRequest,
  options: { params?: unknown; scope?: RpcCallerScope; pairedDeviceId?: string } = {}
) {
  return gatePublicContract({
    runtime: world.runtime,
    method,
    request,
    params: options.params,
    callerScope: options.scope ?? OWNER_RPC_CALLER_SCOPE,
    options: options.pairedDeviceId ? { pairedDeviceId: options.pairedDeviceId } : undefined,
    orchestrationCaller: undefined
  })
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('public contract gate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    clearDestructivePreviewersForTest()
    vi.useRealTimers()
  })

  describe('requests that do not opt in', () => {
    it('are not gated at all, even for a destructive method', () => {
      const world = createWorld({ 'file-overwrite-delete': 'ask' })
      const method = createMethod(DESTRUCTIVE)

      const gated = gate(world, method, createRequest(DESTRUCTIVE))

      expect(gated).toBeNull()
      expect(world.requireSpy).not.toHaveBeenCalled()
      expect(world.activityTrail.record).not.toHaveBeenCalled()
    })

    it('ignore confirm and caller fields, which only mean something with publicContract', () => {
      const world = createWorld({ 'file-overwrite-delete': 'ask' })

      const gated = gate(
        world,
        createMethod(DESTRUCTIVE),
        createRequest(DESTRUCTIVE, { confirm: true, caller: { role: 'brain' } })
      )

      expect(gated).toBeNull()
    })

    it('are admitted synchronously with the method object untouched', () => {
      const world = createWorld({ 'file-overwrite-delete': 'ask' })
      const method = createMethod(DESTRUCTIVE)
      const request = createRequest(DESTRUCTIVE)

      const admission = admitRpcRequest(
        {
          runtime: world.runtime,
          registry: new Map([[method.name, method]]),
          meta: { runtimeId: 'rt' }
        },
        request,
        undefined,
        (candidate): candidate is RpcMethod => candidate === method
      )

      expect(admission).not.toBeInstanceOf(Promise)
      expect(admission).toMatchObject({ method, request })
    })
  })

  describe('previewing a destructive call', () => {
    it('refuses without confirm and lists the previewer effects', async () => {
      registerDestructivePreviewer(DESTRUCTIVE, async () => [
        'discards 3 files',
        'cannot be undone'
      ])
      const world = createWorld()
      const handler = vi.fn(async () => ({ done: true }))

      const gated = gate(
        world,
        createMethod(DESTRUCTIVE, handler),
        createRequest(DESTRUCTIVE, { publicContract: 1 })
      )

      await expect(gated).rejects.toMatchObject({
        name: 'PublicRpcError',
        code: 'needs_confirmation',
        reason: 'preview',
        next: [{ command: 're-run with --yes', why: 'confirms the effects listed' }],
        data: { effects: ['discards 3 files', 'cannot be undone'] }
      })
      expect(handler).not.toHaveBeenCalled()
      expect(world.requireSpy).not.toHaveBeenCalled()
    })

    it('hands the previewer the parsed params and a context carrying the caller', async () => {
      const previewer = vi.fn(async (_params: unknown, _ctx: RpcContext) => ['effect'])
      registerDestructivePreviewer(DESTRUCTIVE, previewer)
      const world = createWorld()

      const gated = gate(
        world,
        createMethod(DESTRUCTIVE),
        createRequest(DESTRUCTIVE, { publicContract: 1, caller: AGENT_ENV_REQUEST }),
        { params: { paths: ['a.ts'] } }
      )
      await gated?.catch(() => undefined)

      expect(previewer).toHaveBeenCalledWith(
        { paths: ['a.ts'] },
        expect.objectContaining({
          runtime: world.runtime,
          publicCaller: expect.objectContaining({ kind: 'agent-session' })
        })
      )
    })

    it('falls back to a single generic effect when no previewer is registered', async () => {
      const world = createWorld()

      const gated = gate(
        world,
        createMethod(DESTRUCTIVE),
        createRequest(DESTRUCTIVE, { publicContract: 1 })
      )

      await expect(gated).rejects.toMatchObject({
        reason: 'preview',
        data: { effects: [`${DESTRUCTIVE} is destructive`] }
      })
    })

    it('does not treat confirm: false as a confirmation', async () => {
      const world = createWorld()

      const gated = gate(
        world,
        createMethod(DESTRUCTIVE),
        createRequest(DESTRUCTIVE, { publicContract: 1, confirm: false })
      )

      await expect(gated).rejects.toMatchObject({ reason: 'preview' })
    })

    it('reaches the client as error data with reason, next and effects', async () => {
      registerDestructivePreviewer(DESTRUCTIVE, async () => ['discards 3 files'])
      const world = createWorld()
      const gated = gate(
        world,
        createMethod(DESTRUCTIVE),
        createRequest(DESTRUCTIVE, { publicContract: 1 })
      )
      const error = await gated?.catch((caught: unknown) => caught)

      const response: RpcResponse = mapRuntimeError('req-1', { runtimeId: 'rt' }, error)

      expect(response).toMatchObject({
        ok: false,
        error: {
          code: 'needs_confirmation',
          data: {
            reason: 'preview',
            next: [{ command: 're-run with --yes' }],
            effects: ['discards 3 files']
          }
        }
      })
    })

    it('is rejected through admission as a failure response, not a thrown error', async () => {
      registerDestructivePreviewer(DESTRUCTIVE, async () => ['discards 3 files'])
      const world = createWorld()
      const method = createMethod(DESTRUCTIVE)

      const admission = await admitRpcRequest(
        {
          runtime: world.runtime,
          registry: new Map([[method.name, method]]),
          meta: { runtimeId: 'rt' }
        },
        createRequest(DESTRUCTIVE, { publicContract: 1 }),
        undefined,
        (candidate): candidate is RpcMethod => candidate === method
      )

      expect(admission).toMatchObject({
        rejected: {
          id: 'req-1',
          ok: false,
          error: { code: 'needs_confirmation', data: { reason: 'preview' } }
        }
      })
    })
  })

  describe('a confirmed destructive call', () => {
    it('dispatches and records one activity entry once the handler succeeds', async () => {
      registerDestructivePreviewer(DESTRUCTIVE, async () => ['discards 3 files'])
      const world = createWorld()
      const handler = vi.fn(async () => ({ discarded: 3 }))

      const gated = gate(
        world,
        createMethod(DESTRUCTIVE, handler),
        createRequest(DESTRUCTIVE, { publicContract: 1, confirm: true, caller: AGENT_ENV_REQUEST }),
        { params: { worktreeId: 'wt-1' } }
      )
      const bound = await gated
      expect(world.activityTrail.record).not.toHaveBeenCalled()
      const result = await bound?.handler({ worktreeId: 'wt-1' }, { runtime: world.runtime })

      expect(result).toEqual({ discarded: 3 })
      expect(world.activityTrail.record).toHaveBeenCalledTimes(1)
      expect(world.activityTrail.record).toHaveBeenCalledWith({
        caller: expect.objectContaining({
          kind: 'agent-session',
          agentSessionId: 'session-abcdef123456'
        }),
        method: DESTRUCTIVE,
        summary: DESTRUCTIVE,
        workspaceId: 'wt-1',
        at: expect.any(Number)
      })
    })

    it('records nothing when the handler throws', async () => {
      const world = createWorld()
      const handler = vi.fn(async () => {
        throw new Error('git failed')
      })

      const bound = await gate(
        world,
        createMethod(DESTRUCTIVE, handler),
        createRequest(DESTRUCTIVE, { publicContract: 1, confirm: true })
      )

      await expect(bound?.handler({}, { runtime: world.runtime })).rejects.toThrow('git failed')
      expect(world.activityTrail.record).not.toHaveBeenCalled()
    })

    it('does not ask when the category policy is agent', async () => {
      const world = createWorld({ 'file-overwrite-delete': 'agent' })

      await gate(
        world,
        createMethod(DESTRUCTIVE),
        createRequest(DESTRUCTIVE, { publicContract: 1, confirm: true })
      )

      expect(world.requireSpy).not.toHaveBeenCalled()
    })

    it('does not fail the call when recording the activity throws', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const world = createWorld()
      world.activityTrail.record.mockImplementation(() => {
        throw new Error('trail broke')
      })

      const bound = await gate(
        world,
        createMethod(DESTRUCTIVE),
        createRequest(DESTRUCTIVE, { publicContract: 1, confirm: true })
      )

      await expect(bound?.handler({}, { runtime: world.runtime })).resolves.toEqual({ done: true })
    })
  })

  describe('when the approval policy says ask', () => {
    function askedDestructiveCall(world: ApprovalWorld) {
      registerDestructivePreviewer(DESTRUCTIVE, async () => ['discards 3 files'])
      const handler = vi.fn(async () => ({ discarded: 3 }))
      const gated = gate(
        world,
        createMethod(DESTRUCTIVE, handler),
        createRequest(DESTRUCTIVE, { publicContract: 1, confirm: true, caller: AGENT_ENV_REQUEST }),
        { params: { worktreeId: 'wt-1' } }
      )
      return { gated, handler }
    }

    it('waits for the user, then dispatches after approval', async () => {
      const world = createWorld({ 'file-overwrite-delete': 'ask' })
      const { gated } = askedDestructiveCall(world)
      let settled = false
      void gated?.then(() => {
        settled = true
      })
      await flush()

      expect(world.requireSpy).toHaveBeenCalledWith(
        'file-overwrite-delete',
        expect.objectContaining({ kind: 'agent-session' }),
        DESTRUCTIVE,
        ['discards 3 files'],
        expect.objectContaining({ worktreeId: 'wt-1', paneKey: null })
      )
      expect(settled).toBe(false)

      world.answer(true)
      const bound = await gated

      await expect(bound?.handler({}, { runtime: world.runtime })).resolves.toEqual({
        discarded: 3
      })
    })

    it('refuses with needs_confirmation/declined and never dispatches when the user says no', async () => {
      const world = createWorld({ 'file-overwrite-delete': 'ask' })
      const { gated, handler } = askedDestructiveCall(world)
      const assertion = expect(gated).rejects.toMatchObject({
        code: 'needs_confirmation',
        reason: 'declined'
      })
      await flush()

      world.answer(false)

      await assertion
      expect(handler).not.toHaveBeenCalled()
      expect(world.activityTrail.record).not.toHaveBeenCalled()
    })

    it('refuses with needs_confirmation/timed_out after APPROVAL_TIMEOUT_MS and cancels the ask', async () => {
      const world = createWorld({ 'file-overwrite-delete': 'ask' })
      const { gated, handler } = askedDestructiveCall(world)
      const assertion = expect(gated).rejects.toMatchObject({
        code: 'needs_confirmation',
        reason: 'timed_out'
      })

      await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS)

      await assertion
      expect(world.cancelled).toEqual(['ask_1'])
      expect(handler).not.toHaveBeenCalled()
    })

    it('points the question at the pane of the calling terminal', async () => {
      const world = createWorld({ 'file-overwrite-delete': 'ask' })
      world.getTerminalPaneKey.mockReturnValue('pane-7')

      const gated = gate(
        world,
        createMethod(DESTRUCTIVE),
        createRequest(DESTRUCTIVE, {
          publicContract: 1,
          confirm: true,
          caller: { terminalHandle: 'term_1' }
        })
      )
      await flush()
      world.answer(true)
      await gated

      expect(world.getTerminalPaneKey).toHaveBeenCalledWith('term_1')
      expect(world.requireSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ kind: 'terminal' }),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ paneKey: 'pane-7' })
      )
    })
  })

  describe('a method with an approval category', () => {
    it('asks first when the policy says ask, without needing confirm', async () => {
      const world = createWorld({ 'security-settings': 'ask' })

      const gated = gate(
        world,
        createMethod('test.approvalGated'),
        createRequest('test.approvalGated', { publicContract: 1 })
      )
      await flush()

      expect(world.requireSpy).toHaveBeenCalledWith(
        'security-settings',
        expect.anything(),
        'change a security setting',
        [],
        expect.anything()
      )
      world.answer(true)
      await expect(gated).resolves.toMatchObject({ name: 'test.approvalGated' })
    })

    it('runs straight through when the policy says agent', async () => {
      const world = createWorld({ 'security-settings': 'agent' })

      await gate(
        world,
        createMethod('test.approvalGated'),
        createRequest('test.approvalGated', { publicContract: 1 })
      )

      expect(world.requireSpy).not.toHaveBeenCalled()
    })

    it('skips approval entirely for a request without publicContract, but still attributes it', async () => {
      const world = createWorld({ 'security-settings': 'ask' })

      const bound = await gate(
        world,
        createMethod('test.approvalGated'),
        createRequest('test.approvalGated')
      )
      await bound?.handler({}, { runtime: world.runtime })

      expect(world.requireSpy).not.toHaveBeenCalled()
      expect(world.activityTrail.record).toHaveBeenCalledTimes(1)
    })
  })

  describe('a public mutating method', () => {
    it('records its summary against the caller after success', async () => {
      const world = createWorld()
      const handler = vi.fn(async () => ({ unsubscribed: true }))

      const bound = await gate(
        world,
        createMethod(PUBLIC_MUTATION, handler),
        createRequest(PUBLIC_MUTATION, { publicContract: 1, caller: { terminalHandle: 'term_1' } })
      )
      await bound?.handler({ subscriptionId: 'x' }, { runtime: world.runtime })

      expect(world.activityTrail.record).toHaveBeenCalledWith({
        caller: { kind: 'terminal', label: 'Terminal term_1' },
        method: PUBLIC_MUTATION,
        summary: expect.any(String),
        at: expect.any(Number)
      })
    })

    it('gives the handler the resolved caller on its context', async () => {
      const world = createWorld()
      const seen: (AttributedCaller | undefined)[] = []
      const handler = vi.fn(async (_params: unknown, ctx: RpcContext) => {
        seen.push(ctx.publicCaller)
        return {}
      })

      const bound = await gate(
        world,
        createMethod(PUBLIC_MUTATION, handler),
        createRequest(PUBLIC_MUTATION, { publicContract: 1, caller: { role: 'brain' } })
      )
      await bound?.handler({}, { runtime: world.runtime })

      expect(seen).toEqual([{ kind: 'brain', label: 'Brain' }])
    })

    it('does not record a read-only public call', async () => {
      const world = createWorld()

      const bound = await gate(
        world,
        createMethod('events.subscribe'),
        createRequest('events.subscribe', { publicContract: 1 })
      )
      await bound?.handler({}, { runtime: world.runtime })

      expect(world.activityTrail.record).not.toHaveBeenCalled()
    })
  })

  describe('resolvePublicCaller', () => {
    const OWNER_CASES: [string, CallerHint, AttributedCaller][] = [
      ['brain', { role: 'brain' }, { kind: 'brain', label: 'Brain' }],
      [
        'an agent session',
        { agentSessionId: 'session-abcdef123456', worktreeId: 'wt-1' },
        {
          kind: 'agent-session',
          label: 'Agent session-',
          agentSessionId: 'session-abcdef123456',
          worktreeId: 'wt-1'
        }
      ],
      ['a terminal', { terminalHandle: 'term_9' }, { kind: 'terminal', label: 'Terminal term_9' }],
      ['a bare script', {}, { kind: 'script', label: 'Script' }]
    ]

    it.each(OWNER_CASES)('names an owner call from %s', (_name, hint, expected) => {
      expect(resolvePublicCaller(OWNER_RPC_CALLER_SCOPE, undefined, hint)).toEqual(expected)
    })

    it('lets the brain role win over a session id', () => {
      expect(
        resolvePublicCaller(OWNER_RPC_CALLER_SCOPE, undefined, {
          role: 'brain',
          agentSessionId: 's1'
        })
      ).toMatchObject({ kind: 'brain', agentSessionId: 's1' })
    })

    it('attributes a phone to mobile whatever the hint claims', () => {
      expect(
        resolvePublicCaller({ kind: 'mobile' }, 'device-1', { role: 'brain', agentSessionId: 's1' })
      ).toEqual({ kind: 'mobile', label: 'Phone', deviceId: 'device-1' })
    })

    it('attributes a paired desktop to remote, with its device when known', () => {
      const scope: RpcCallerScope = { kind: 'runtime-paired', grants: [] }

      expect(resolvePublicCaller(scope, 'device-2', { role: 'brain' })).toEqual({
        kind: 'remote',
        label: 'Remote desktop',
        deviceId: 'device-2'
      })
      expect(resolvePublicCaller(scope, undefined, {})).toEqual({
        kind: 'remote',
        label: 'Remote desktop'
      })
    })

    it('clips oversized hint values so a caller cannot flood the activity feed', () => {
      const caller = resolvePublicCaller(OWNER_RPC_CALLER_SCOPE, undefined, {
        terminalHandle: 'x'.repeat(5000)
      })

      expect(caller.label.length).toBeLessThan(300)
    })
  })

  describe('readCallerHint', () => {
    it('keeps a valid hint', () => {
      expect(readCallerHint({ role: 'brain', agentSessionId: 's1' })).toEqual({
        role: 'brain',
        agentSessionId: 's1'
      })
    })

    it.each([undefined, null, 'brain', 42, { role: 'admin' }, { agentSessionId: 7 }])(
      'treats the malformed hint %j as no hint',
      (hint) => {
        expect(readCallerHint(hint)).toEqual({})
      }
    )

    it('does not authorize anything: a brain hint on a mobile call still resolves to mobile', () => {
      const hint = readCallerHint({ role: 'brain' })

      expect(resolvePublicCaller({ kind: 'mobile' }, undefined, hint).kind).toBe('mobile')
    })
  })

  it('uses PublicRpcError for every refusal it raises', async () => {
    const world = createWorld()

    const gated = gate(
      world,
      createMethod(DESTRUCTIVE),
      createRequest(DESTRUCTIVE, { publicContract: 1 })
    )

    await expect(gated).rejects.toBeInstanceOf(PublicRpcError)
  })
})
