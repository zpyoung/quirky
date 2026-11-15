import type { Handler, HostingEnv } from '../env'
import { createGitLabClient } from './api'
import { createGitLabIdentityHandlers, resolveGitLabScope } from './identity'
import { createGitLabReviewHandlers } from './reviews'
import { createGitLabDiscussionHandlers } from './discussions'
import type { GitLabHandler } from './types'

const handlers = new WeakMap<HostingEnv, Record<string, GitLabHandler>>()

/** Keep GitHub behavior intact and refuse GitHub-only operations on GitLab origins. */
export function routeByProvider(env: HostingEnv, table: Record<string, Handler>): Record<string, Handler> {
  let gitlab = handlers.get(env)
  if (!gitlab) {
    const client = createGitLabClient(env)
    gitlab = {
      ...createGitLabIdentityHandlers(env, client),
      ...createGitLabReviewHandlers(env, client),
      ...createGitLabDiscussionHandlers(env, client)
    }
    handlers.set(env, gitlab)
  }
  const routed: Record<string, Handler> = {}
  for (const [name, github] of Object.entries(table)) {
    if (name === 'cachedReviews') {
      routed[name] = github
      continue
    }
    routed[name] = async (params, caller) => {
      const scope = await resolveGitLabScope(env, params, caller)
      if (!scope) return github(params, caller)
      const handle = gitlab[name]
      if (!handle) throw env.invalid('unsupported_provider', `GitLab hosting does not answer quirky.hosting/${name} yet.`)
      return handle(scope, params)
    }
  }
  return routed
}
