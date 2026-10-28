export type ReviewTarget = {
  worktree: string
  number: number
  tab?: 'conversation' | 'checks' | 'files'
  url?: string
  host?: string
  owner?: string
  repo?: string
}
type PullIdentity = { host: string; owner: string; repo: string }

function invalidTarget(): never {
  throw new Error('A pull request target must use one exact, safe HTTP(S) source identity.')
}

function repositoryPart(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || !/^[A-Za-z0-9._-]+$/u.test(value) || value === '.' || value === '..') return invalidTarget()
  return value
}

function canonicalHost(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || /\s/u.test(value) || value.includes('%') || value.includes('/') || value.includes('\\') || value.includes('?') || value.includes('#') || value.includes('@')) return invalidTarget()
  let url: URL
  try {
    url = new URL(`https://${value}`)
  } catch {
    return invalidTarget()
  }
  if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.host === '') return invalidTarget()
  return url.host.toLowerCase()
}

function explicitIdentity(target: ReviewTarget): PullIdentity | null {
  const hasHost = target.host !== undefined
  const hasOwner = target.owner !== undefined
  const hasRepo = target.repo !== undefined
  if (!hasHost && !hasOwner && !hasRepo) return null
  if (!hasOwner || !hasRepo) return invalidTarget()
  return {
    host: hasHost ? canonicalHost(target.host) : 'github.com',
    owner: repositoryPart(target.owner),
    repo: repositoryPart(target.repo)
  }
}

function identityFromUrl(value: unknown, number: number): PullIdentity {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() || /[\s\u0000-\u001F\u007F]/u.test(value) || value.includes('%') || value.includes('\\') || value.includes('@') || value.includes('?') || value.includes('#')) return invalidTarget()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return invalidTarget()
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') return invalidTarget()
  const schemeEnd = value.indexOf('://')
  const pathStart = schemeEnd < 0 ? -1 : value.indexOf('/', schemeEnd + 3)
  const rawPath = pathStart < 0 ? '/' : value.slice(pathStart)
  if (rawPath !== url.pathname) return invalidTarget()
  const match = /^\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)\/pull\/([1-9][0-9]*)$/u.exec(url.pathname)
  if (!match || match[1] === '.' || match[1] === '..' || match[2] === '.' || match[2] === '..') return invalidTarget()
  const urlNumber = Number(match[3])
  if (!Number.isSafeInteger(urlNumber) || urlNumber !== number || String(urlNumber) !== match[3]) return invalidTarget()
  return { host: url.host.toLowerCase(), owner: match[1], repo: match[2] }
}

function pullIdentity(target: ReviewTarget): PullIdentity | null {
  if (target.url === undefined) return explicitIdentity(target)
  const fromUrl = identityFromUrl(target.url, target.number)
  if (target.host !== undefined && canonicalHost(target.host) !== fromUrl.host) return invalidTarget()
  if (target.owner !== undefined && repositoryPart(target.owner).toLowerCase() !== fromUrl.owner.toLowerCase()) return invalidTarget()
  if (target.repo !== undefined && repositoryPart(target.repo).toLowerCase() !== fromUrl.repo.toLowerCase()) return invalidTarget()
  return fromUrl
}

/** Public cross-plugin navigation; Reviews owns target resolution and prior-view restoration. */
export async function openReview(context: { call(method: string, params?: Record<string, unknown>): Promise<unknown> }, target: ReviewTarget): Promise<unknown> {
  if (typeof target.worktree !== 'string' || target.worktree.trim().length === 0 || !Number.isSafeInteger(target.number) || target.number < 1) throw new Error('A registered workspace and positive pull request number are required')
  if (target.tab !== undefined && !['conversation', 'checks', 'files'].includes(target.tab)) throw new Error('Unknown pull request tab')
  const identity = pullIdentity(target)
  return context.call('quirky.reviews/open', {
    worktree: target.worktree,
    number: target.number,
    ...(target.tab ? { tab: target.tab } : {}),
    ...(identity ? { prRepo: identity } : {})
  })
}
