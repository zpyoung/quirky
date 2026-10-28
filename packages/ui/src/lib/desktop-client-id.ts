const STORAGE_KEY = 'quirky.desktopClientId'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

type ClientIdentityStorage = Pick<Storage, 'getItem' | 'setItem'>

/** Returns a stable installation identity only when it can be durably stored in first-party storage. */
export function loadDesktopClientId(storage: ClientIdentityStorage): string | undefined {
  try {
    const existing = storage.getItem(STORAGE_KEY)
    if (existing && UUID.test(existing)) return existing
    const generated = globalThis.crypto.randomUUID()
    if (!UUID.test(generated)) return undefined
    storage.setItem(STORAGE_KEY, generated)
    return generated
  } catch {
    return undefined
  }
}
