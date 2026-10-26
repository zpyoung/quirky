import type { ClientStream } from '@quirky/protocol'
import { internal } from '../errors'
import type { ClientConn } from '../types'

/** Opens a binary stream to `conn` for a `connection: true` method; it is closed when `conn` disconnects. */
export function openStream(_conn: ClientConn): ClientStream {
  throw internal('not implemented: openStream')
}
