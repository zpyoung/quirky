export type ExplorerEntryLike = {
  path: string
  name: string
  isDirectory: boolean
  isSymlink?: boolean
  error?: string
}

export function normalizeWorktreeRelativePath(value: string): string | null {
  const normalized = value.replace(/\\/g, '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized) || normalized.includes('\0')) return null
  const parts = normalized.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.some((part) => part === '..')) return null
  return parts.length === 0 ? '.' : parts.join('/')
}

export function toWorktreeRelativePath(worktreeRoot: string, entryPath: string): string | null {
  const root = worktreeRoot.replace(/\\/g, '/').replace(/\/+$/u, '')
  const candidate = entryPath.replace(/\\/g, '/')
  if (root.length === 0 || candidate.includes('\0')) return null

  let relativePath = candidate
  if (candidate.startsWith('/') || /^[A-Za-z]:\//u.test(candidate)) {
    if (candidate === root) return '.'
    const prefix = `${root}/`
    if (!candidate.startsWith(prefix)) return null
    relativePath = candidate.slice(prefix.length)
  }
  return normalizeWorktreeRelativePath(relativePath)
}

export function safeExplorerPath(entry: ExplorerEntryLike, worktreeRoot: string): string | null {
  if (entry.error) return null
  return toWorktreeRelativePath(worktreeRoot, entry.path)
}

const explorerNameCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

export function sortExplorerEntries<T extends Pick<ExplorerEntryLike, 'name' | 'isDirectory'>>(entries: T[]): T[] {
  return [...entries].sort((left, right) =>
    Number(right.isDirectory) - Number(left.isDirectory)
      || explorerNameCollator.compare(left.name, right.name)
      || left.name.localeCompare(right.name)
  )
}
export const MOBILE_EDITOR_DRAFT_LIMIT = 1024 * 1024
export const MOBILE_EDITOR_INLINE_DRAFT_LIMIT = 48 * 1024
export const MOBILE_EDITOR_TRANSFER_CHUNK_LIMIT = 48 * 1024

export function draftWriteMode(totalBytes: number): 'inline' | 'transfer' {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0 || totalBytes > MOBILE_EDITOR_DRAFT_LIMIT) {
    throw new Error('Mobile file drafts are limited to 1 MiB.')
  }
  return totalBytes <= MOBILE_EDITOR_INLINE_DRAFT_LIMIT ? 'inline' : 'transfer'
}

export function draftChunkLength(totalBytes: number, offset: number, maxChunkBytes: number): number {
  if (
    !Number.isSafeInteger(totalBytes) || totalBytes < 0
    || !Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes
    || !Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1
  ) throw new Error('Invalid draft transfer range.')
  return Math.min(maxChunkBytes, totalBytes - offset)
}

type TaskFilter = 'status' | 'assignee' | 'review'

function queryTokens(value: string): string[] {
  const tokens: string[] = []
  let start = -1
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (start < 0) {
      if (/\s/u.test(character)) continue
      start = index
    }
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '"') quoted = !quoted
    if (!quoted && /\s/u.test(character)) {
      tokens.push(value.slice(start, index))
      start = -1
    }
  }
  if (start >= 0) tokens.push(value.slice(start))
  return tokens
}

function filterOwnsToken(filter: TaskFilter, token: string): boolean {
  const colon = token.indexOf(':')
  if (colon < 0) return false
  const qualifier = token.slice(0, colon).toLowerCase()
  const argument = token.slice(colon + 1).toLowerCase()
  if (filter === 'status') return qualifier === 'is' && ['open', 'closed', 'merged', 'draft'].includes(argument)
  if (filter === 'assignee') return qualifier === 'assignee'
  return qualifier === 'review' || qualifier === 'review-requested' || qualifier === 'reviewed-by'
}

function taskFilterToken(filter: TaskFilter, value: string): string | null {
  const normalized = value.trim()
  if (!normalized) return null
  if (filter === 'status') {
    if (!['open', 'closed', 'merged', 'draft'].includes(normalized)) throw new Error('Choose a supported GitHub status filter.')
    return `is:${normalized}`
  }
  if (filter === 'assignee') {
    if (normalized.toLowerCase() === '@me') return 'assignee:@me'
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(normalized)) throw new Error('Enter a GitHub login or choose Assigned to me.')
    return `assignee:${normalized}`
  }
  if (normalized === 'needs-review') return 'review-requested:@me'
  if (['approved', 'changes_requested', 'none', 'required'].includes(normalized)) return `review:${normalized}`
  throw new Error('Choose a supported pull-request review filter.')
}

export function replaceTaskFilter(query: string, filter: TaskFilter, value: string): string {
  const kept = queryTokens(query).filter((token) => !filterOwnsToken(filter, token))
  const replacement = taskFilterToken(filter, value)
  if (replacement) kept.push(replacement)
  return kept.join(' ')
}

export function taskFilterValue(query: string, filter: TaskFilter): string {
  for (const token of queryTokens(query).reverse()) {
    const colon = token.indexOf(':')
    if (colon < 0) continue
    const qualifier = token.slice(0, colon).toLowerCase()
    const argument = token.slice(colon + 1)
    const lowered = argument.toLowerCase()
    if (filter === 'status' && qualifier === 'is' && ['open', 'closed', 'merged', 'draft'].includes(lowered)) return lowered
    if (filter === 'assignee' && qualifier === 'assignee') return argument
    if (filter === 'review' && qualifier === 'review-requested' && lowered === '@me') return 'needs-review'
    if (filter === 'review' && qualifier === 'review' && ['approved', 'changes_requested', 'none', 'required'].includes(lowered)) return lowered
  }
  return ''
}


export type WorkspaceResult =
  | { kind: 'created'; worktreeId: string; name: string }
  | { kind: 'resumed'; worktreeId: string; name: string }
  | { kind: 'composer'; requestId: string; request: Record<string, unknown> }
  | { kind: 'invalid' }

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function classifyWorkspaceResult(value: unknown): WorkspaceResult {
  const result = record(value)
  if (!result) return { kind: 'invalid' }
  if (result.kind === 'created' || result.kind === 'resumed') {
    const worktree = record(result.worktree)
    if (typeof worktree?.id !== 'string' || worktree.id.length === 0) return { kind: 'invalid' }
    return { kind: result.kind, worktreeId: worktree.id, name: typeof worktree.name === 'string' ? worktree.name : '' }
  }
  if (result.kind === 'composer' && typeof result.requestId === 'string' && result.requestId.length > 0) {
    return { kind: 'composer', requestId: result.requestId, request: result }
  }
  return { kind: 'invalid' }
}
