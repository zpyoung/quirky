import type { RpcContext } from './core'

/** Describes, without performing it, what a destructive call would change; each line is one effect. */
export type DestructivePreviewer = (params: unknown, ctx: RpcContext) => Promise<string[]>

const previewers = new Map<string, DestructivePreviewer>()

export function registerDestructivePreviewer(method: string, fn: DestructivePreviewer): void {
  if (previewers.has(method)) {
    throw new Error(`duplicate_destructive_previewer:${method}`)
  }
  previewers.set(method, fn)
}

export function getDestructivePreviewer(method: string): DestructivePreviewer | undefined {
  return previewers.get(method)
}

export function clearDestructivePreviewersForTest(): void {
  previewers.clear()
}
