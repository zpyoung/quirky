import type { NativeBrowserHandle } from '@quirky/protocol'

type Listener = () => void

let resident: string | null = null
const listeners = new Set<Listener>()
const handles = new Map<string, NativeBrowserHandle>()

const notify = () => {
  for (const listener of listeners) listener()
}

/** Which live preview holds the window's one native browser view, or null when none does. */
export const residentPreview = (): string | null => resident

export function subscribePreview(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Moves the native browser view to the preview `id`; the one that held it goes back to its placeholder. */
export function claimPreview(id: string): void {
  if (resident === id) return
  resident = id
  notify()
}

/** Gives the native browser view up, but only if `id` is the one holding it. */
export function releasePreview(id: string): void {
  if (resident !== id) return
  resident = null
  notify()
}

export function rememberHandle(id: string, handle: NativeBrowserHandle | null): void {
  if (handle === null) handles.delete(id)
  else handles.set(id, handle)
}

/** Reloads the page shown by the preview `id`; resolves false when it holds no native view. */
export async function reloadPreview(id: string): Promise<boolean> {
  const handle = handles.get(id)
  if (handle === undefined) return false
  await handle.request({ action: 'reload' })
  return true
}
