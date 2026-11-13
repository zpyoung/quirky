import { encodeTerminalLagged, encodeTerminalOutput, type ClientStream } from '@quirky/protocol'
import { invalidParams } from '../errors'
import type { ClientConn } from '../types'

/** Registers cleanup on either transport without creating a stream or requiring binary support. */
export function onConnectionClose(conn: ClientConn, callback: () => void): () => void {
  const closeId = conn.nextStreamId++
  let active = true
  const close = () => {
    if (!active) return
    active = false
    conn.streamClosers.delete(closeId)
    try {
      callback()
    } catch {
      return
    }
  }

  if (conn.closed) close()
  else conn.streamClosers.set(closeId, close)

  return () => {
    if (!active) return
    active = false
    conn.streamClosers.delete(closeId)
  }
}

/**
 * Opens a binary stream to `conn` for a `connection: true` method. The stream ends when the plugin
 * closes it or the connection goes away (`Core.removeClient` runs the registered closer); its
 * `onClose` callbacks run once either way. `lag()` emits one terminal-lagged frame and runs any
 * registered `onLag` callbacks. On an already closed connection the stream starts closed, `send`
 * returns `false` and no closer is registered.
 */
export function openStream(conn: ClientConn): ClientStream {
  if (conn.transport === 'socket') throw invalidParams('this method needs the WebSocket transport')
  const streamId = conn.nextStreamId++
  const callbacks: (() => void)[] = []
  const lagCallbacks: (() => void)[] = []
  let closed = conn.closed
  let lagged = false

  const runCallback = (callback: () => void) => {
    try {
      callback()
    } catch {
      return
    }
  }
  const close = () => {
    if (closed) return
    closed = true
    conn.streamClosers.delete(streamId)
    try {
      conn.closeStreamOutput?.(streamId)
    } catch {}
    lagCallbacks.length = 0
    for (const callback of callbacks.splice(0)) runCallback(callback)
  }
  if (!closed) conn.streamClosers.set(streamId, close)

  const lag = () => {
    if (closed || conn.closed || lagged) return
    lagged = true
    const listeners = lagCallbacks.splice(0)
    conn.sendBinary(encodeTerminalLagged(streamId))
    for (const callback of listeners) runCallback(callback)
  }

  return {
    streamId,
    get lagged() {
      return lagged
    },
    send(bytes) {
      if (closed || conn.closed || lagged) return false
      if (conn.sendBinary(encodeTerminalOutput(streamId, bytes)) === false) {
        lag()
        return false
      }
      return true
    },
    lag,
    onLag(callback) {
      if (closed) return
      if (lagged) {
        runCallback(callback)
        return
      }
      lagCallbacks.push(callback)
    },
    onClose(callback) {
      if (closed) runCallback(callback)
      else callbacks.push(callback)
    },
    close
  }
}

