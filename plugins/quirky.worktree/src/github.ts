import type { GitHubRepositoryIdentity, GitHubWorktreeSource } from '@quirky/protocol'

export type GitHubWorkItem = {
  kind: 'issue' | 'pullRequest'
  number: number
  title: string
  url: string
  labels: string[]
  headRefName: string | null
}

export type GitHubWorkItemsPage = { items: GitHubWorkItem[]; partial: boolean; errors: string[] }

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function identity(value: unknown): value is GitHubRepositoryIdentity {
  const candidate = record(value)
  return candidate !== null && typeof candidate.host === 'string' && typeof candidate.owner === 'string' && typeof candidate.repo === 'string'
}

function sourceHead(value: unknown): boolean {
  const candidate = record(value)
  return candidate !== null &&
    identity(candidate.repository) &&
    typeof candidate.refName === 'string' &&
    typeof candidate.oid === 'string' &&
    typeof candidate.sshUrl === 'string' &&
    typeof candidate.httpsUrl === 'string' &&
    typeof candidate.maintainerCanModify === 'boolean'
}

function sourceBase(value: unknown): boolean {
  const candidate = record(value)
  return candidate !== null && identity(candidate.repository) && typeof candidate.refName === 'string' && typeof candidate.oid === 'string'
}

function workItem(value: unknown): GitHubWorkItem | null {
  const candidate = record(value)
  if (!candidate || (candidate.kind !== 'issue' && candidate.kind !== 'pullRequest')) return null
  if (typeof candidate.number !== 'number' || !Number.isInteger(candidate.number) || candidate.number < 1) return null
  if (typeof candidate.title !== 'string' || typeof candidate.url !== 'string' || candidate.url === '') return null
  return {
    kind: candidate.kind,
    number: candidate.number,
    title: candidate.title,
    url: candidate.url,
    labels: Array.isArray(candidate.labels) ? candidate.labels.filter((label): label is string => typeof label === 'string') : [],
    headRefName: typeof candidate.headRefName === 'string' ? candidate.headRefName : null
  }
}

/** A Smart GitHub work-item reference must never become a workspace name on lookup failure. */
export function isGitHubWorktreeReference(value: string): boolean {
  const text = value.trim()
  if (/^#\d+$/.test(text)) return true
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:') return false
    if (url.hostname.toLowerCase() === 'github.com') return true
    const parts = url.pathname.split('/').filter(Boolean)
    return parts.length >= 4 && (parts[2] === 'issues' || parts[2] === 'pull') && /^\d+$/.test(parts[3]!)
  } catch {
    return false
  }
}

export function parseWorkItemsPage(value: unknown): GitHubWorkItemsPage {
  const candidate = record(value)
  if (!candidate || !Array.isArray(candidate.items)) throw new Error('GitHub returned an invalid work-item search response.')
  const items = candidate.items.map(workItem).filter((item): item is GitHubWorkItem => item !== null)
  const errors: string[] = []
  const sources = record(candidate.errors)
  if (sources) {
    for (const result of Object.values(sources)) {
      const detail = record(result)
      if (detail && typeof detail.message === 'string' && detail.message !== '') errors.push(detail.message)
    }
  }
  const partial = candidate.partial === true || errors.length > 0
  if (partial && errors.length === 0) errors.push('Some GitHub work-item results could not be loaded.')
  return { items, partial, errors }
}

export function parseWorktreeSource(value: unknown): GitHubWorktreeSource {
  const candidate = record(value)
  const item = record(candidate?.item)
  if (!candidate || !item || item.provider !== 'github' || (item.kind !== 'issue' && item.kind !== 'pullRequest') ||
      typeof item.number !== 'number' || !Number.isInteger(item.number) || item.number < 1 || typeof item.title !== 'string' ||
      typeof item.url !== 'string' || item.url === '' || !identity(item.repository)) {
    throw new Error('GitHub returned an invalid worktree source.')
  }
  if (item.kind === 'pullRequest') {
    if (!sourceHead(candidate.head) || !sourceBase(candidate.base)) throw new Error('GitHub returned an incomplete pull-request source.')
  } else if (candidate.head !== null || candidate.base !== null) {
    throw new Error('GitHub returned an invalid issue source.')
  }
  return value as GitHubWorktreeSource
}
