import type { PluginContext } from '@quirky/protocol'
import { createReviewsEnv, parentMethods, type ActiveReviewsEnv } from './src/env'
import { detailMethods } from './src/detail/methods'
import { checksMethods } from './src/checks/methods'
import { createMethods } from './src/create/methods'

let active: ActiveReviewsEnv | null = null

export function activate(context: PluginContext): void {
  const env = createReviewsEnv(context)
  active = env
  const methods = { ...parentMethods(env), ...detailMethods(env), ...checksMethods(env), ...createMethods(env) }
  for (const [id, handler] of Object.entries(methods)) context.provide(`method:quirky.reviews/${id}`, handler)
}

export async function deactivate(): Promise<void> {
  const env = active
  active = null
  await env?.dispose()
}
