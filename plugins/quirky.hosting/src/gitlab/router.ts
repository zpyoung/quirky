import type { Handler, HostingEnv } from '../env'
import { isRecord } from '../data'
import { createGitLabClient, gitlabError } from './api'
import { createGitLabIdentityHandlers, resolveGitLabScope } from './identity'
import { createGitLabReviewHandlers } from './reviews'
import { createGitLabDiscussionHandlers } from './discussions'
import type { GitLabHandler, GitLabScope } from './types'

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
      if (Object.hasOwn(params, 'prRepo')) assertRepositoryPin(env, scope, params.prRepo)
      return handle(scope, params)
    }
  }
  return routed
}

function assertRepositoryPin(env: HostingEnv, scope: GitLabScope, pin: unknown): void {
  const expected = scope.repository
  if (!isRecord(pin) ||
      typeof pin.host !== 'string' || pin.host.toLowerCase() !== expected.host.toLowerCase() ||
      typeof pin.owner !== 'string' || pin.owner.toLowerCase() !== expected.owner.toLowerCase() ||
      typeof pin.repo !== 'string' || pin.repo.toLowerCase() !== expected.repo.toLowerCase()) {
    throw gitlabError(env, 'repository_mismatch', 'The requested review repository does not match this worktree.')
  }
}
