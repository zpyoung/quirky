export const MAX_SHARED_DIRECTORIES = 100

export function staysInside(path: string): boolean {
  return !/^(?:[a-z]:)?[\\/]/i.test(path) && !path.split(/[\\/]/).includes('..')
}

/** Why a shared-directory entry cannot be linked, or null when it is a relative path inside the repository and outside `.git`. */
export function sharedEntryProblem(entry: string): string | null {
  if (entry.trim() === '' || /^(?:[a-z]:)?[\\/]/i.test(entry)) return 'it is not a relative path'
  if (!staysInside(entry)) return 'it is outside the repository'
  const normalized = entry.replace(/\\/g, '/').replace(/\/+$/, '')
  if (normalized === '.git' || normalized.startsWith('.git/')) return 'it is inside .git'
  return null
}

/** Validates and normalizes a project-owned shared-directory setting. */
export function normalizeSharedDirectories(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error('sharedDirectories must be an array of relative paths')
  }
  if (value.length > MAX_SHARED_DIRECTORIES) {
    throw new Error(`sharedDirectories may contain at most ${MAX_SHARED_DIRECTORIES} paths`)
  }
  const paths: string[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    const path = entry.trim()
    if (/[\u0000-\u001f\u007f]/.test(path)) {
      throw new Error(`shared directory \"${entry}\" contains control characters`)
    }
    const problem = sharedEntryProblem(path)
    if (problem !== null) throw new Error(`shared directory "${entry}" ${problem}`)
    const segments = path.replace(/\\/g, '/').split('/')
    if (segments.some((segment) => segment === '' || segment === '.')) {
      throw new Error(`shared directory "${entry}" must be a normalized relative path`)
    }
    if (!seen.has(path)) {
      seen.add(path)
      paths.push(path)
    }
  }
  return paths
}

export function parseSharedDirectoriesText(value: string): string[] {
  return normalizeSharedDirectories(value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean))
}
