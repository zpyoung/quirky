/**
 * Working-tree mutations: staging by path or scope, unstaging and discarding. Paths always reach
 * git as `:(literal)` pathspecs, so a name with glob characters or a leading colon means itself.
 */
import { hasCommits } from './ops'
import { git, runGit } from './run'

const CLEAN_CHUNK = 100

const literal = (path: string): string => `:(literal)${path}`

const nulList = (paths: string[]): string => paths.map((p) => `${literal(p)}\0`).join('')

const splitNul = (out: string): string[] => out.split('\0').filter((p) => p.length > 0)

/**
 * Stages exactly `paths`. A listed path that no longer exists on disk is staged as a deletion,
 * which is also how a conflicted path whose file was removed becomes resolved.
 */
export async function stagePaths(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await git(cwd, ['add', '--all', '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(paths) })
}

/**
 * Stages the whole worktree (`all`, including untracked files) or only tracked changes
 * (`tracked`), leaving `exclude` alone. Unmerged paths are never staged by scope: a bulk
 * `add` would mark them resolved, so with any present the rest is staged path by path.
 */
export async function stageScope(cwd: string, scope: 'all' | 'tracked', exclude: string[] = []): Promise<void> {
  const unmerged = splitNul(await git(cwd, ['diff', '--name-only', '--relative', '-z', '--diff-filter=U'], { readOnly: true }))
  if (unmerged.length === 0) {
    if (scope === 'tracked') await git(cwd, ['add', '--update', '--', '.'])
    else await git(cwd, ['add', '--all', '--', '.', ...exclude.map((p) => `:(exclude,literal)${p}`)])
    return
  }
  const skip = new Set([...unmerged, ...exclude])
  const changed = splitNul(await git(cwd, ['diff', '--name-only', '--relative', '-z'], { readOnly: true }))
  const untracked =
    scope === 'all'
      ? splitNul(await git(cwd, ['ls-files', '-z', '--others', '--exclude-standard'], { readOnly: true }))
      : []
  await stagePaths(cwd, [...new Set([...changed, ...untracked])].filter((p) => !skip.has(p)))
}

/**
 * Removes `paths` from the index, keeping the working files. Works before the first commit, where
 * there is no HEAD to restore from. Pass both sides of a staged rename to reset the whole rename.
 */
export async function unstagePaths(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const args = (await hasCommits(cwd))
    ? ['restore', '--staged']
    : ['rm', '--cached', '-r', '-q']
  await git(cwd, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: nulList(paths) })
}

type DiscardFailure = { path: string; message: string }

/** Runs `attempt` on the whole `group`; if that fails, on each path alone so the failure names its path. */
async function attributing(
  group: string[],
  attempt: (paths: string[]) => Promise<string | null>,
  failures: DiscardFailure[]
): Promise<void> {
  if (group.length === 0) return
  if ((await attempt(group)) === null) return
  for (const path of group) {
    const message = await attempt([path])
    if (message !== null) failures.push({ path, message })
  }
}

const failureText = (r: { stderr: string; exitCode: number }): string =>
  r.stderr.trim() || `git exited with code ${r.exitCode}`

/**
 * Throws away the working-tree changes to `paths`: tracked files are restored from the index
 * (a deleted one comes back) and untracked files and folders are deleted. A path that cannot be
 * discarded is reported in `failures` and does not stop the others.
 */
export async function discardPaths(cwd: string, paths: string[]): Promise<{ failures: DiscardFailure[] }> {
  const failures: DiscardFailure[] = []
  if (paths.length === 0) return { failures }

  const listed = splitNul(await git(cwd, ['ls-files', '-z', '--', ...paths.map(literal)], { readOnly: true }))
  const isTracked = (path: string): boolean => {
    const dir = `${path.replace(/\/+$/, '')}/`
    return listed.some((file) => file === path || file.startsWith(dir))
  }
  const tracked = paths.filter(isTracked)
  const untracked = paths.filter((p) => !isTracked(p))

  await attributing(
    tracked,
    async (group) => {
      const r = await runGit(cwd, ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'], {
        input: nulList(group)
      })
      return r.exitCode === 0 ? null : failureText(r)
    },
    failures
  )

  const clean = async (group: string[]): Promise<string | null> => {
    const r = await runGit(cwd, ['clean', '-ffdx', '--', ...group.map(literal)])
    return r.exitCode === 0 ? null : failureText(r)
  }
  for (let i = 0; i < untracked.length; i += CLEAN_CHUNK) {
    await attributing(untracked.slice(i, i + CLEAN_CHUNK), clean, failures)
  }
  return { failures }
}
