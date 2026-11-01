/** Thrown when a worktree name is unusable. */
export class InvalidNameError extends Error {
  constructor(message = 'Invalid worktree name') {
    super(message)
    this.name = 'InvalidNameError'
  }
}

// Reserve Git's `.lock` and the longest automatic `-100` suffix within a 255-byte component.
export const MAX_WORKTREE_NAME_BYTES = 246
const utf8Encoder = new TextEncoder()

/** Thrown when every candidate in the suffix walk is taken. */
export class NoFreeNameError extends Error {
  constructor() {
    super('Could not find an available worktree name')
    this.name = 'NoFreeNameError'
  }
}

/**
 * Turns arbitrary user input into a name that is safe as a single folder and branch segment.
 *
 * The result contains only letters, digits, `.`, `_` and `-`, never starts or ends with `.` or
 * `-`, and cannot be `.` or `..`, so it can never leave the worktrees folder. Input made only of
 * emoji yields `workspace`. Throws `InvalidNameError` when unusable or longer than the byte limit.
 */
export function sanitizeName(input: string): string {
  const name = input
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+|[.-]+$/g, '')
  if (name === '' && /\p{Extended_Pictographic}/u.test(input)) return 'workspace'
  if (name === '' || name === '.' || name === '..') throw new InvalidNameError()
  if (utf8Encoder.encode(name).byteLength > MAX_WORKTREE_NAME_BYTES) {
    throw new InvalidNameError(`Workspace name is too long (maximum ${MAX_WORKTREE_NAME_BYTES} UTF-8 bytes).`)
  }
  return name
}

/** Trims a branch prefix, strips leading and trailing `/`, and collapses repeated `/`. */
export function normalizePrefix(prefix: string): string {
  return prefix.trim().replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '')
}

/** `<normalized prefix>/<name>`, or just `name` when the prefix is null or normalises to empty. */
export function branchName(prefix: string | null, name: string): string {
  const normalized = prefix === null ? '' : normalizePrefix(prefix)
  return normalized === '' ? name : `${normalized}/${name}`
}

/**
 * Tries `name`, `name-2`, ... `name-<max>` in order and resolves to the first one `isTaken`
 * reports free. Candidates are checked sequentially, never concurrently. Throws
 * `NoFreeNameError` after `max` taken candidates.
 */
export async function walkCandidates(
  name: string,
  isTaken: (candidate: string) => Promise<boolean>,
  max = 100,
): Promise<string> {
  for (let n = 1; n <= max; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`
    if (!(await isTaken(candidate))) return candidate
  }
  throw new NoFreeNameError()
}
