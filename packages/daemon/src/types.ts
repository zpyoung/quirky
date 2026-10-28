import type { ClientRole } from '@quirky/protocol'

/** One connected RPC client, independent of the transport that carries it. */
export type ClientConn = {
  id: number
  role: ClientRole | null
  name?: string
  /** Authenticated identity for a client admitted by a trusted plugin. */
  readonly deviceId?: string
  /** Revalidates admitted-client access before every RPC dispatch. */
  authorize?: (method: string, params: Record<string, unknown>) => void | Promise<void>
  subscribed: boolean
  closed: boolean
  transport: 'websocket' | 'socket'
  cwd?: string
  sessionId?: string
  worktreeId?: string
  /** Epoch milliseconds of the last `ui.window.focused` with `focused: true`. */
  focusedAt?: number
  /** Epoch milliseconds of the last `ui.window.activity`. */
  inputAt?: number
  /** terminal streamId -> sessionId */
  streams: Map<number, string>
  nextStreamId: number
  sendText(text: string): void
  /** streamId -> closes that stream; run on disconnect. */
  streamClosers: Map<number, () => void>
  sendBinary(bytes: Uint8Array): void
}
