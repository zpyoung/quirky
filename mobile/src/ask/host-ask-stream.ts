import type { RpcClient } from '../transport/rpc-client'
import {
  applyAskStreamFrame,
  EMPTY_ASK_REGISTRY_STATE,
  type AskRegistryState
} from './ask-registry-state'
import { readAskStreamFrame } from './ask-stream-frame-schema'

export type HostAskStream = {
  getState: () => AskRegistryState
  /** False once the host refused `ask.subscribe`; the ask surface stays hidden for that host. */
  isSupported: () => boolean
  subscribe: (listener: () => void) => () => void
}

const streamsByClient = new WeakMap<RpcClient, HostAskStream>()

/**
 * One `ask.subscribe` per client, shared by every screen that shows asks. The host has no
 * ask-unsubscribe call, only socket close, so the stream stays open while the client is connected
 * instead of being reopened (and leaked host-side) on every screen mount.
 */
export function hostAskStreamFor(client: RpcClient): HostAskStream {
  const existing = streamsByClient.get(client)
  if (existing) {
    return existing
  }
  const created = createHostAskStream(client)
  streamsByClient.set(client, created)
  return created
}

function createHostAskStream(client: RpcClient): HostAskStream {
  let state = EMPTY_ASK_REGISTRY_STATE
  let supported = true
  let closeStream: (() => void) | null = null
  let stopStateWatch: (() => void) | null = null
  const listeners = new Set<() => void>()

  const publish = (next: AskRegistryState): void => {
    state = next
    for (const listener of listeners) {
      listener()
    }
  }

  const open = (): void => {
    if (closeStream || !supported) {
      return
    }
    const cursor = state.cursor
    // Mid-snapshot state from a dropped stream would merge into the next one.
    publish({ ...state, collecting: null })
    closeStream = client.subscribe(
      'ask.subscribe',
      cursor ? { sinceSeq: cursor.seq, epoch: cursor.epoch } : {},
      (data) => {
        const frame = readAskStreamFrame(data)
        if (!frame) {
          return
        }
        if (frame.type === 'error') {
          // An older host rejects ask.* for phones outright; the next reconnect tries again.
          supported = false
          closeStream = null
          publish({ ...state })
          return
        }
        publish(applyAskStreamFrame(state, frame))
        if (frame.type === 'end') {
          closeStream = null
          if (frame.reason === 'epoch_changed' && client.getState() === 'connected') {
            open()
          }
        }
      }
    )
  }

  const close = (): void => {
    closeStream?.()
    closeStream = null
  }

  const onConnectionState = (connection: string): void => {
    if (connection === 'connected') {
      open()
    } else {
      supported = true
      close()
      publish({ ...state })
    }
  }

  const start = (): void => {
    if (stopStateWatch) {
      return
    }
    stopStateWatch = client.onStateChange(onConnectionState)
    onConnectionState(client.getState())
  }

  return {
    getState: () => state,
    isSupported: () => supported,
    subscribe(listener) {
      listeners.add(listener)
      start()
      return () => {
        listeners.delete(listener)
      }
    }
  }
}
