import { vi } from 'vitest'
import { OrchestrationDb } from '../../../orchestration/db'
import { QuirkyRuntimeService } from '../../../quirky-runtime'
import { AskDb } from '../../../../fork-ask-question-tool/ask-db'
import { AskRegistry } from '../../../../fork-ask-question-tool/ask-registry'
import {
  createAskAttachedSurfaceRoster,
  type AskAttachedSurfaceRoster
} from '../../../../fork-ask-question-tool/ask-attached-surface-roster'
import { createAskWaitConcurrencyGate } from '../../../../fork-ask-question-tool/ask-wait-concurrency-gate'
import type { RpcContext } from '../../core'
import { ASK_METHODS } from './ask'

export const HANDOFF_PANE_KEY = 'tab_worker:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

export type AskRpcHarness = {
  runtime: QuirkyRuntimeService
  orchestrationDb: OrchestrationDb
  askDb: AskDb
  registry: AskRegistry
  roster: AskAttachedSurfaceRoster
  ctx: RpcContext
  hasLocalRendererWindow: { value: boolean }
  setPaneOwner(paneKey: string, terminalHandle: string): void
  /** Makes a worktreeId/workspaceId resolve as known (F4) — everything else 404s via `showManagedWorktree`. */
  setKnownWorktree(worktreeId: string): void
  call(
    name: string,
    params: Record<string, unknown>,
    ctxOverride?: Partial<RpcContext>
  ): Promise<unknown>
  /**
   * Starts a streaming method. Its handler resolves only once `stop()` triggers the registered
   * subscription cleanup, so this captures that cleanup call rather than the internal
   * subscriptionId string, which is otherwise opaque to callers.
   */
  subscribe(
    name: string,
    params: Record<string, unknown>,
    ctxOverride?: Partial<RpcContext>
  ): { frames: unknown[]; stop(): Promise<void> }
  /**
   * Rebuilds the runtime/registry/roster (and every in-memory cache keyed by runtime identity —
   * the ask epoch, the hand-off event emitter) against the SAME durable askDb/orchestrationDb, so
   * only what genuinely survives a host restart does.
   */
  simulateRestart(): AskRpcHarness
}

/** Per-test instance of the shared ask RPC fixture: real runtime/DBs, spied pane resolution, roster control. */
export function createAskRpcHarness(): { setup(): AskRpcHarness; cleanup(): void } {
  let orchestrationDb: OrchestrationDb
  let askDb: AskDb
  let opened = false

  function buildInstance(
    paneOwnersSeed?: Map<string, string>,
    knownWorktreesSeed?: Set<string>
  ): AskRpcHarness {
    const runtime = new QuirkyRuntimeService()
    runtime.setOrchestrationDb(orchestrationDb)

    const registry = new AskRegistry(askDb)
    const hasLocalRendererWindow = { value: false }
    const roster = createAskAttachedSurfaceRoster({
      hasLocalRendererWindow: () => hasLocalRendererWindow.value
    })
    vi.spyOn(runtime, 'getAskServices').mockReturnValue({
      db: askDb,
      registry,
      roster,
      waitGate: createAskWaitConcurrencyGate(),
      resolvePaneClosed: (paneKey) => registry.resolvePaneClosed(paneKey)
    })

    const paneOwners = paneOwnersSeed ?? new Map<string, string>()
    vi.spyOn(runtime, 'getAgentStatusTerminalHandleForPaneKey').mockImplementation((paneKey) =>
      paneOwners.get(paneKey)
    )
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => {
      for (const [paneKey, owningHandle] of paneOwners) {
        if (owningHandle === handle) {
          return paneKey
        }
      }
      return null
    })
    vi.spyOn(runtime, 'getTerminalWorktreeIdForPaneKey').mockReturnValue(null)

    const knownWorktrees = knownWorktreesSeed ?? new Set<string>()
    vi.spyOn(runtime, 'showManagedWorktree').mockImplementation(async (selector: string) => {
      const worktreeId = selector.startsWith('id:') ? selector.slice(3) : selector
      if (!knownWorktrees.has(worktreeId)) {
        throw new Error('selector_not_found')
      }
      return { id: worktreeId } as unknown as Awaited<
        ReturnType<typeof runtime.showManagedWorktree>
      >
    })

    const ctx: RpcContext = { runtime }

    function findMethod(name: string) {
      const method = ASK_METHODS.find((candidate) => candidate.name === name)
      if (!method) {
        throw new Error(`Method not found: ${name}`)
      }
      return method
    }

    return {
      runtime,
      orchestrationDb,
      askDb,
      registry,
      roster,
      ctx,
      hasLocalRendererWindow,
      setPaneOwner: (paneKey, terminalHandle) => paneOwners.set(paneKey, terminalHandle),
      setKnownWorktree: (worktreeId) => knownWorktrees.add(worktreeId),
      call: async (name, params, ctxOverride) => {
        const method = findMethod(name)
        if ('stream' in method) {
          throw new Error(`${name} is a streaming method; use subscribe() instead`)
        }
        const parsed = method.params ? method.params.parse(params) : undefined
        return method.handler(parsed as never, { ...ctx, ...ctxOverride })
      },
      subscribe: (name, params, ctxOverride) => {
        const method = findMethod(name)
        if (!('stream' in method)) {
          throw new Error(`${name} is not a streaming method`)
        }
        const parsed = method.params ? method.params.parse(params) : undefined
        const frames: unknown[] = []
        // Why: an async handler runs synchronously up to its first await, so by the time this
        // call returns, registerSubscriptionCleanup has already fired with the real id — capture
        // it via a spy rather than reconstructing the internal id scheme.
        const registerSpy = vi.spyOn(runtime, 'registerSubscriptionCleanup')
        const handlerPromise = method.handler(
          parsed as never,
          { ...ctx, ...ctxOverride },
          (frame) => frames.push(frame)
        )
        const subscriptionId = registerSpy.mock.calls.at(-1)?.[0] as string | undefined
        registerSpy.mockRestore()
        return {
          frames,
          stop: async () => {
            if (subscriptionId) {
              runtime.cleanupSubscription(subscriptionId)
            }
            await handlerPromise
          }
        }
      },
      simulateRestart: () => buildInstance(paneOwners, knownWorktrees)
    }
  }

  function setup(): AskRpcHarness {
    opened = true
    orchestrationDb = new OrchestrationDb(':memory:')
    askDb = new AskDb(':memory:')
    return buildInstance()
  }

  function cleanup(): void {
    if (!opened) {
      return
    }
    opened = false
    askDb.close()
    orchestrationDb.close()
  }

  return { setup, cleanup }
}
