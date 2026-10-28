import type { Handler, HostingEnv } from './env'
import { isRecord, parseOid, parsePositiveInteger } from './pr-data'
import { isPRStackSummary, type PRLookup } from './pr-review'

// Source-supported stack membership protocol; the selector is a PR number, never the stack number.
const STACK_QUERY = `query HostingReviewStack($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) { pullRequest(number: $pr) { stack {
    number size baseRefName entries(first: 100) { nodes { position pullRequest {
      number title url updatedAt state isDraft headRefName headRefOid mergeable reviewDecision mergeStateStatus statusCheckRollup { state }
    } } }
  } } }
}`

type StackEntry = {
  position: number; number: number; title: string; url: string
  state: string; checksStatus: string; mergeable: string
  updatedAt: string | null; headRefName: string | null; headRefOid: string | null
  reviewDecision: string | null; mergeStateStatus: string | null
}

export function createPRStackMethods(env: HostingEnv, lookup: PRLookup): Record<string, Handler> {
  return {
    reviewStack: async (params, caller) => {
      const read = await lookup.readFresh(params, caller)
      if (!read) throw env.invalid('not_found', 'The pull request was not found in a configured repository.')
      const number = read.review.number
      const summary = read.review.stack
      if (summary === null && read.stackKnown) return { number, available: true, stack: null, truncated: false }
      if (!isPRStackSummary(summary)) return { number, available: false, stack: null, truncated: false, reason: 'stack_unavailable' }
      const unavailable = (reason: string) => ({ number, available: false, stack: { ...summary, entries: [] }, truncated: false, reason })
      const load = async () => {
        let raw: unknown
        try {
          raw = await env.graphql({ ...read.scope, repository: read.repository }, STACK_QUERY, { owner: read.repository.owner, repo: read.repository.repo, pr: number }, { idempotent: true })
        } catch { return unavailable('stack_unavailable') }
        if (!isRecord(raw) || (Array.isArray(raw.errors) && raw.errors.length > 0) || !isRecord(raw.data) || !isRecord(raw.data.repository) || !isRecord(raw.data.repository.pullRequest)) return unavailable('stack_unavailable')
        const stack = raw.data.repository.pullRequest.stack
        if (!isRecord(stack) || stack.number !== summary.number) return unavailable('stack_mismatch')
        if (!isRecord(stack.entries) || !Array.isArray(stack.entries.nodes) || stack.entries.nodes.length > 100) return unavailable('stack_unavailable')
        const entries: StackEntry[] = []
        const numbers = new Set<number>()
        const positions = new Set<number>()
        for (const node of stack.entries.nodes) {
          if (!isRecord(node) || !parsePositiveInteger(node.position) || !isRecord(node.pullRequest)) return unavailable('stack_unavailable')
          const pr = node.pullRequest
          const member = parsePositiveInteger(pr.number)
          if (!member || typeof pr.title !== 'string' || typeof pr.url !== 'string' || numbers.has(member) || positions.has(Number(node.position))) return unavailable('stack_unavailable')
          let url: URL
          try { url = new URL(pr.url) } catch { return unavailable('stack_unavailable') }
          const path = `/${read.repository.owner}/${read.repository.repo}/pull/${member}`
          if (url.protocol !== 'https:' || url.host.toLowerCase() !== read.repository.host.toLowerCase() || url.pathname.toLowerCase() !== path.toLowerCase() || url.username || url.password) return unavailable('stack_unavailable')
          const rollup = isRecord(pr.statusCheckRollup) ? pr.statusCheckRollup.state : null
          const state = pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : pr.state === 'OPEN' ? pr.isDraft === true ? 'draft' : 'open' : 'unknown'
          entries.push({ position: Number(node.position), number: member, title: pr.title, url: `https://${read.repository.host}${path}`, state,
            checksStatus: rollup === 'SUCCESS' ? 'success' : rollup === 'FAILURE' || rollup === 'ERROR' ? 'failure' : rollup === 'PENDING' || rollup === 'EXPECTED' ? 'pending' : 'unknown',
            mergeable: pr.mergeable === 'MERGEABLE' || pr.mergeable === 'CONFLICTING' ? pr.mergeable : 'UNKNOWN',
            updatedAt: typeof pr.updatedAt === 'string' ? pr.updatedAt : null, headRefName: typeof pr.headRefName === 'string' ? pr.headRefName : null, headRefOid: parseOid(pr.headRefOid) ?? null,
            reviewDecision: typeof pr.reviewDecision === 'string' ? pr.reviewDecision : null, mergeStateStatus: typeof pr.mergeStateStatus === 'string' ? pr.mergeStateStatus : null })
          numbers.add(member); positions.add(Number(node.position))
        }
        entries.sort((left, right) => left.position - right.position)
        const size = parsePositiveInteger(stack.size) ?? summary.size
        if (summary.position > size || entries.length > size || entries.some((entry) => entry.position > size)) return unavailable('stack_mismatch')
        if (entries.length === size && !numbers.has(number)) return unavailable('stack_mismatch')
        return { number, available: true, stack: { ...summary, size, base: { ...summary.base, ref: typeof stack.baseRefName === 'string' ? stack.baseRefName : summary.base.ref }, entries }, truncated: size > entries.length }
      }
      return params.noCache === true ? load() : env.cache(env.cacheKey(read.scope, `stack:${read.repository.host}:${read.repository.owner}/${read.repository.repo}:${summary.number}:${number}:${summary.position}:${read.review.headRefOid}`), 30_000, load)
    }
  }
}
