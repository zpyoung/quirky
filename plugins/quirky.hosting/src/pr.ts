import type { Handler, HostingEnv } from './env'
import { createPRCreationMethods } from './pr-create'
import { createPRMutationMethods } from './pr-mutations'
import { createPRLookup } from './pr-review'
import { createPRConversationMethods } from './review-conversation'
import { createPRStackMethods } from './review-stack'

export function prMethods(env: HostingEnv): Record<string, Handler> {
  const lookup = createPRLookup(env)
  return {
    forBranch: lookup.forBranch,
    review: lookup.review,
    cachedReviews: lookup.cachedReviews,
    ...createPRCreationMethods(env, lookup),
    ...createPRMutationMethods(env, lookup),
    ...createPRConversationMethods(env, lookup),
    ...createPRStackMethods(env, lookup)
  }
}
