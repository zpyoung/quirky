import type { Handler, HostingEnv } from './env'
import { createPRCreationMethods } from './pr-create'
import { createPRMutationMethods } from './pr-mutations'
import { createPRLookup } from './pr-review'
import { createPRConversationMethods } from './review-conversation'
import { createPRStackMethods } from './review-stack'

export function prMethods(env: HostingEnv): Record<string, Handler> {
  const lookup = createPRLookup(env)
  const forBranch: Handler = async (params, caller) => {
    const fresh = params.fresh
    if (fresh !== undefined && typeof fresh !== 'boolean') {
      throw env.invalid('validation_error', 'fresh must be a boolean.')
    }
    const request = { ...params }
    delete request.fresh
    return lookup.forBranch(request, caller, { noCache: fresh === true, strict: fresh === true })
  }
  return {
    forBranch,
    pushRepository: lookup.pushRepository,
    review: lookup.review,
    cachedReviews: lookup.cachedReviews,
    ...createPRCreationMethods(env, lookup),
    ...createPRMutationMethods(env, lookup),
    ...createPRConversationMethods(env, lookup),
    ...createPRStackMethods(env, lookup)
  }
}
