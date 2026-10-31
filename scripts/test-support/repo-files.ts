import { readdirSync } from 'node:fs'

/** The repo's tracked files, or everything outside node_modules in the test host's copy of the tree, which has no .git. */
export function repoFiles(repo: string): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files'], { cwd: repo })
  if (listed.success) return listed.stdout.toString().split('\n').filter(Boolean)
  return readdirSync(repo, { recursive: true, encoding: 'utf8' }).filter((path) => !path.split('/').includes('node_modules'))
}
