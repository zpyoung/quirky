import type { ItemTarget, TaskRepo, TasksEnv } from '../contracts'

export type GitHubIdentity = { host: string; owner: string; repo: string }
export type SourceAvailability = { status: 'available' | 'unavailable' | 'unresolved'; reason?: string; message?: string }
export type ResolvedRepoSource = {
  repo: TaskRepo
  origin: GitHubIdentity
  repository: GitHubIdentity
  issueRepository: GitHubIdentity
  candidates: GitHubIdentity[]
  issueSourcePreference: string
  issueSourceFellBack: boolean
  availability: SourceAvailability
}

export function object(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

export function identity(value: unknown): GitHubIdentity | null {
  const raw = object(value)
  const host = text(raw?.host)
  const owner = text(raw?.owner)
  const repo = text(raw?.repo)
  return host && owner && repo ? { host: host.toLowerCase(), owner, repo } : null
}

export function canonicalIdentity(value: GitHubIdentity): string {
  return `${value.host.toLowerCase()}/${value.owner.toLowerCase()}/${value.repo.toLowerCase()}`
}

export function eligibleRepositories(repositories: TaskRepo[]): TaskRepo[] {
  return repositories.filter((repo) => repo.kind === 'git' && repo.path.trim().length > 0 && repo.worktree.trim().length > 0)
}

export function identityFromTarget(target: ItemTarget): GitHubIdentity | null {
  if (target.url) {
    try {
      const url = new URL(target.url)
      const parts = url.pathname.split('/').filter(Boolean)
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || parts.length !== 4) return null
      const [owner, repo, section, number] = parts
      const expectedSection = target.kind === 'issue' ? 'issues' : 'pull'
      if (!owner || !repo || section !== expectedSection || Number(number) !== target.number) return null
      if (target.owner && target.owner.toLowerCase() !== owner.toLowerCase()) return null
      if (target.repo && target.repo.toLowerCase() !== repo.toLowerCase()) return null
      if (target.host && target.host.toLowerCase() !== url.host.toLowerCase()) return null
      return { host: url.host.toLowerCase(), owner, repo }
    } catch {
      return null
    }
  }
  if (!target.owner || !target.repo) return null
  return { host: (target.host ?? 'github.com').toLowerCase(), owner: target.owner, repo: target.repo }
}

export function targetLinkKey(target: ItemTarget): string {
  if (typeof target.url === 'string' && target.url.length > 0) return target.url
  const source = identityFromTarget(target)
  if (source) return `${source.host.toLowerCase()}|${target.kind}|${source.owner.toLowerCase()}/${source.repo.toLowerCase()}|${target.number}`
  return `${target.worktree}/${target.kind}/${target.number}`
}

export function targetUrl(target: ItemTarget): string {
  if (target.url) return target.url
  const source = identityFromTarget(target)
  if (!source) return ''
  return `https://${source.host}/${source.owner}/${source.repo}/${target.kind === 'issue' ? 'issues' : 'pull'}/${target.number}`
}

export async function resolveRepoSource(env: TasksEnv, repo: TaskRepo): Promise<ResolvedRepoSource> {
  const response = object(await env.context.call('quirky.hosting/repository', { worktree: repo.worktree }))
  const origin = identity(response?.origin)
  const repository = identity(response?.repository)
  const issueRepository = identity(response?.issueRepository)
  const candidatesRaw = Array.isArray(response?.candidates) ? response.candidates : []
  const candidates = candidatesRaw.map(identity).filter((candidate): candidate is GitHubIdentity => candidate !== null)
  if (!response || !origin || !repository || !issueRepository) throw new Error('GitHub repository source could not be resolved.')

  const preference = text(response.issueSourcePreference) ?? 'auto'
  const sourceName = canonicalIdentity(issueRepository) === canonicalIdentity(origin) ? 'origin' : 'upstream'
  let availability: SourceAvailability = { status: 'available' }
  try {
    const diagnosis = object(await env.context.call('quirky.hosting/diagnoseAuth', { worktree: repo.worktree }))
    if (diagnosis?.ghAvailable === false) {
      availability = { status: 'unavailable', reason: 'gh_unavailable', message: 'GitHub CLI is unavailable.' }
    } else if (diagnosis?.requiredHostAuthenticated === false) {
      availability = { status: 'unavailable', reason: 'auth_required', message: `Sign in to ${origin.host} with gh auth login.` }
    }
  } catch (error) {
    availability = { status: 'unavailable', reason: errorReason(error), message: messageOf(error) }
  }

  return {
    repo,
    origin,
    repository,
    issueRepository,
    candidates,
    issueSourcePreference: preference,
    issueSourceFellBack: response.issueSourceFellBack === true,
    availability: availability.status === 'available' ? { status: 'available', message: `${sourceName} · ${origin.host}/${origin.owner}/${origin.repo}` } : availability
  }
}

export function sourceMatchesTarget(source: ResolvedRepoSource, target: ItemTarget): boolean {
  const targetIdentity = identityFromTarget(target)
  if (!targetIdentity) return source.repo.worktree === target.worktree
  const candidates = [source.origin, source.issueRepository, source.repository, ...source.candidates]
  return candidates.some((candidate) => canonicalIdentity(candidate) === canonicalIdentity(targetIdentity))
}

export function issueSourceMatchesTarget(source: ResolvedRepoSource, target: ItemTarget): boolean {
  const targetIdentity = identityFromTarget(target)
  return targetIdentity === null || canonicalIdentity(source.issueRepository) === canonicalIdentity(targetIdentity)
}


export function errorReason(error: unknown): string | undefined {
  const outer = object(error)
  const data = object(outer?.data)
  return text(data?.reason) ?? text(outer?.reason)
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
