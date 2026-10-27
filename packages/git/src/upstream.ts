import type { GitUpstreamStatus } from '@quirky/protocol'
import { getConfig } from './ops'
import { runGit } from './run'

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

const NO_UPSTREAM: GitUpstreamStatus = {
  hasUpstream: false,
  name: null,
  sha: null,
  ahead: 0,
  behind: 0,
  behindPatchEquivalent: null
}

async function revParse(cwd: string, args: string[]): Promise<string | null> {
  const r = await runGit(cwd, ['rev-parse', ...args], { readOnly: true })
  if (r.exitCode !== 0) return null
  return text(r.stdout).trim() || null
}

/** The short name of the upstream `branch` should be compared with, or null when it has none. */
async function upstreamName(cwd: string, branch: string): Promise<string | null> {
  const configured = await revParse(cwd, ['--abbrev-ref', `${branch}@{upstream}`])
  if (configured) return configured
  const remote = (await getConfig(cwd, `branch.${branch}.remote`))?.trim() || 'origin'
  const ref = `refs/remotes/${remote}/${branch}`
  return (await revParse(cwd, ['--verify', '--quiet', ref])) ? `${remote}/${branch}` : null
}

/** Whether every commit only the upstream has is the same change as one already on HEAD (a rebased branch). */
async function behindIsPatchEquivalent(cwd: string, upstream: string): Promise<boolean | null> {
  const r = await runGit(
    cwd,
    ['log', '--no-show-signature', '--no-color', '--oneline', '--cherry-mark', '--right-only', `HEAD...${upstream}`, '--'],
    { readOnly: true }
  )
  if (r.exitCode !== 0) return null
  return text(r.stdout)
    .split('\n')
    .filter((line) => line.length > 0)
    .every((line) => line.startsWith('='))
}

/**
 * Where `branch` stands against the upstream it is compared with: the porcelain upstream when
 * given, else its configured `@{upstream}`, else the remote-tracking ref of the same name (the
 * remote is `branch.<b>.remote`, or `origin`). Counts are porcelain's when it named the upstream,
 * else read with `rev-list`. `behindPatchEquivalent` is set only when the branch is both ahead and
 * behind: true when everything behind is a rebased copy of something ahead, false otherwise.
 * A null `branch` (detached) or no upstream gives the empty status; never throws on git failures.
 */
export async function effectiveUpstream(
  cwd: string,
  branch: string | null,
  porcelain: { upstream: string | null; ahead: number; behind: number }
): Promise<GitUpstreamStatus> {
  if (!branch) return { ...NO_UPSTREAM }
  const name = porcelain.upstream ?? (await upstreamName(cwd, branch))
  if (!name) return { ...NO_UPSTREAM }

  const sha = await revParse(cwd, ['--verify', '--quiet', name])
  let { ahead, behind } = porcelain
  if (porcelain.upstream === null && sha) {
    const counts = await runGit(cwd, ['rev-list', '--left-right', '--count', `HEAD...${name}`], { readOnly: true })
    if (counts.exitCode === 0) {
      const [left, right] = text(counts.stdout).trim().split(/\s+/).map(Number)
      ahead = left ?? 0
      behind = right ?? 0
    } else {
      ahead = 0
      behind = 0
    }
  }
  const behindPatchEquivalent = ahead > 0 && behind > 0 && sha ? await behindIsPatchEquivalent(cwd, name) : null
  return { hasUpstream: true, name, sha, ahead, behind, behindPatchEquivalent }
}
