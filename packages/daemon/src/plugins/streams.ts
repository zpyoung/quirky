import { encodeTerminalOutput, type ClientStream } from '@quirky/protocol'
import { invalidParams } from '../errors'
import type { ClientConn } from '../types'

/**
 * Opens a binary stream to `conn` for a `connection: true` method. The stream ends when the plugin
 * closes it or the connection goes away (`Core.removeClient` runs the registered closer); its
 * `onClose` callbacks run once either way.
 */
export function openStream(conn: ClientConn): ClientStream {
  if (conn.transport === 'socket') throw invalidParams('this method needs the WebSocket transport')
  const streamId = conn.nextStreamId++
  const callbacks: (() => void)[] = []
  let closed = false

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
  conn.streamClosers.set(streamId, close)

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
