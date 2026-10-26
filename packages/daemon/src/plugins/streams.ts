import { encodeTerminalOutput, type ClientStream } from '@quirky/protocol'
import { invalidParams } from '../errors'
import type { ClientConn } from '../types'

/**
 * Opens a binary stream to `conn` for a `connection: true` method. The stream ends when the plugin
 * closes it or the connection goes away (`Core.removeClient` runs the registered closer); its
 * `onClose` callbacks run once either way. On a connection that is already closed the stream starts
 * closed: `onClose` callbacks run at once, `send` is a no-op and no closer is registered.
 */
export function openStream(conn: ClientConn): ClientStream {
  if (conn.transport === 'socket') throw invalidParams('this method needs the WebSocket transport')
  const streamId = conn.nextStreamId++
  const callbacks: (() => void)[] = []
  let closed = conn.closed

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
    for (const callback of callbacks.splice(0)) runCallback(callback)
  }
  if (!closed) conn.streamClosers.set(streamId, close)

  return {
    streamId,
    send(bytes) {
      if (closed || conn.closed) return
      conn.sendBinary(encodeTerminalOutput(streamId, bytes))
    },
    onClose(callback) {
      if (closed) runCallback(callback)
      else callbacks.push(callback)
    },
    close
  }
}
