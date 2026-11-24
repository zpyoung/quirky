import { isQuirkySessionId, type QuirkySessionId } from './quirky-session-address'

/** A literal Quirky session id for a test, checked by the same predicate production uses. */
export function testQuirkySessionId(id: string): QuirkySessionId {
  if (!isQuirkySessionId(id)) {
    throw new Error(`Not an Quirky session id: ${id}`)
  }
  return id
}
