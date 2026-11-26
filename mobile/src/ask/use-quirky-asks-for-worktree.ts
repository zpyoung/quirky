import { useMemo, useSyncExternalStore } from 'react'
import { ASK_REGISTRY_RUNTIME_CAPABILITY } from '../../../src/shared/fork-ask-question-tool/ask-question-capability'
import type { RpcClient } from '../transport/rpc-client'
import {
  currentLiveAsksForWorktree,
  EMPTY_ASK_REGISTRY_STATE,
  settledAsksForWorktree,
  type MobileAsk
} from './ask-registry-state'
import { hostAskStreamFor, type HostAskStream } from './host-ask-stream'

const NO_ASKS: MobileAsk[] = []

const INERT_STREAM: HostAskStream = {
  getState: () => EMPTY_ASK_REGISTRY_STATE,
  isSupported: () => false,
  subscribe: () => () => {}
}

export type QuirkyAsksForWorktree = {
  liveAsks: MobileAsk[]
  settledAsks: MobileAsk[]
}

/**
 * The asks agents raised in this workspace's terminals. Empty, and no stream opened, unless the
 * host advertises the ask registry, so an older desktop shows nothing.
 */
export function useQuirkyAsksForWorktree(args: {
  client: RpcClient | null
  hostCapabilities: readonly string[]
  worktreeId: string
}): QuirkyAsksForWorktree {
  const { client, hostCapabilities, worktreeId } = args
  const hostHasAskRegistry = hostCapabilities.includes(ASK_REGISTRY_RUNTIME_CAPABILITY)
  const stream = useMemo(
    () => (client && hostHasAskRegistry ? hostAskStreamFor(client) : INERT_STREAM),
    [client, hostHasAskRegistry]
  )
  const state = useSyncExternalStore(stream.subscribe, stream.getState)
  return useMemo(() => {
    if (!stream.isSupported()) {
      return { liveAsks: NO_ASKS, settledAsks: NO_ASKS }
    }
    return {
      liveAsks: currentLiveAsksForWorktree(state, worktreeId),
      settledAsks: settledAsksForWorktree(state, worktreeId)
    }
  }, [stream, state, worktreeId])
}
