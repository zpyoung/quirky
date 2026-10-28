import { runGit } from './run'

export type GitMergePreview = {
  base: string
  head: string
  available: boolean
  conflicting: boolean
  files: string[]
  reason?: 'objects-unavailable' | 'custom-merge-driver' | 'preview-unavailable'
}

/** Compare existing commit objects without changing HEAD, the index, refs or working files. */
export async function mergePreview(cwd: string, base: string, head: string): Promise<GitMergePreview> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(base) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) throw new Error('Merge preview requires complete commit object IDs.')
  const result: GitMergePreview = { base, head, available: false, conflicting: false, files: [] }
  // A configured external merge driver can write arbitrary files; never execute it in a read preview.
  const drivers = await runGit(cwd, ['config', '--get-regexp', '^merge\\..*\\.driver$'], { readOnly: true, timeoutMs: 10_000 })
  if (drivers.exitCode === 0 && drivers.stdout.length > 0) return { ...result, reason: 'custom-merge-driver' }
  if (drivers.exitCode !== 0 && drivers.exitCode !== 1) return { ...result, reason: 'preview-unavailable' }
  for (const oid of [base, head]) {
    const object = await runGit(cwd, ['cat-file', '-e', `${oid}^{commit}`], { readOnly: true, timeoutMs: 10_000, env: { GIT_NO_LAZY_FETCH: '1' } })
    if (object.exitCode !== 0) return { ...result, reason: 'objects-unavailable' }
  }
  const merged = await runGit(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', base, head], { readOnly: true, timeoutMs: 30_000, env: { GIT_NO_LAZY_FETCH: '1' } })
  if (merged.timedOut || (merged.exitCode !== 0 && merged.exitCode !== 1) || merged.stdout.length > 2 * 1024 * 1024) return { ...result, reason: 'preview-unavailable' }
  const fields = new TextDecoder().decode(merged.stdout).split('\0')
  const tree = fields.shift()
  if (!tree || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(tree)) return { ...result, reason: 'preview-unavailable' }
  const files = fields.filter((path) => path.length > 0)
  if (files.some((path) => path.startsWith('/') || path.split('/').some((part) => part === '..' || part === '.'))) return { ...result, reason: 'preview-unavailable' }
  return { base, head, available: true, conflicting: merged.exitCode === 1, files: [...new Set(files)].sort() }
}
