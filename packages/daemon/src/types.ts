import type { ClientRole } from '@quirky/protocol'

/** One connected RPC client, independent of the transport that carries it. */
export type ClientConn = {
  id: number
  role: ClientRole | null
  name?: string
  subscribed: boolean
  closed: boolean
  /** terminal streamId -> sessionId */
  streams: Map<number, string>
  nextStreamId: number
  sendText(text: string): void
  sendBinary(bytes: Uint8Array): void
}
