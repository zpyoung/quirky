/** The repo's tracked files, from `git ls-files`. Throws an Error naming `repo` when it isn't a git checkout. */
export function repoFiles(repo: string): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files'], { cwd: repo })
  if (!listed.success) throw new Error(`git ls-files failed in ${repo}: ${listed.stderr.toString().trim()}`)
  return listed.stdout.toString().split('\n').filter(Boolean)
}
