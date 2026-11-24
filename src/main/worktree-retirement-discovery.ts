import { claudeProfileHistoryDirs } from './claude-accounts/claude-profile-installed-router'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  encodeClaudeProjectPaths,
  isClaudeProjectDirInScope
} from './ai-vault/claude-project-dir-encoding'
import type { RetirementScanResult } from './worktree-retirement-backfill-scan'
import { normalizeRetirableGeneratedName } from './worktree-name-retirement'

/** Why: over-retiring costs one name from a 552-entry pool; under-retiring reissues a path whose
 *  agent history is still on disk. So this matches generously and never tries to be exact. */
export function collectRetiredNamesFromLeafNames(leafNames: Iterable<string>): Set<string> {
  const retired = new Set<string>()
  for (const leafName of leafNames) {
    if (typeof leafName !== 'string' || leafName.length === 0) {
      continue
    }
    const normalized = normalizeRetirableGeneratedName(leafName)
    if (normalized) {
      retired.add(normalized)
    }
  }
  return retired
}

/** The workspace leaf is whatever the bucket has beyond its encoded parent. Deriving it from
 *  trailing dash segments instead makes a numerically named workspace retire its parent
 *  directory's name — and `orca` is in the pool. The first segment is also offered because an
 *  agent run from a subdirectory buckets the whole subpath. */
export function extractBucketLeafCandidates(
  bucketName: string,
  encodedParents: readonly string[]
): string[] {
  const bucket = bucketName.toLowerCase()
  for (const parent of encodedParents) {
    if (!parent || bucket === parent || !isClaudeProjectDirInScope(bucket, [parent])) {
      continue
    }
    const remainder = bucket.slice(parent.length + 1)
    if (!remainder) {
      continue
    }
    const firstSegment = remainder.split('-')[0]
    return remainder === firstSegment ? [remainder] : [remainder, firstSegment]
  }
  return []
}

/** A listing failure other than a missing directory is reported rather than thrown, so the names
 *  that were found are still returned; what must not happen is memoizing the hole, since
 *  under-retiring is the direction that leaks. */
async function readDirectoryNames(path: string): Promise<{ names: string[]; refused: boolean }> {
  try {
    const entries = await readdir(path, { withFileTypes: true })
    return {
      names: entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
      refused: false
    }
  } catch (error) {
    // A missing directory is itself a complete answer: the agent may never have run on this
    // machine. Anything else — an EIO on a redirected or network home — leaves names unread, and
    // memoizing that as "nothing is retired" is the under-retiring direction.
    const code = (error as NodeJS.ErrnoException | null)?.code
    return { names: [], refused: code !== 'ENOENT' && code !== 'ENOTDIR' }
  }
}

/** Claude buckets its per-conversation state under a directory derived from the workspace cwd. A
 *  bucket surviving its workspace is exactly the evidence we need: the name was used, the
 *  directory is gone, and reissuing the name would hand the next occupant that conversation.
 *  CLAUDE_CONFIG_DIR relocates the whole state root, buckets included.
 *
 *  Codex is deliberately not scanned: it records the cwd inside
 *  `sessions/YYYY/MM/DD/rollout-*.jsonl` rather than in a directory name, so seeding from it would
 *  mean parsing user conversation files. Names spent only under Codex before this feature shipped
 *  stay issuable; every name spent after it is recorded at create time regardless of agent. */
function getClaudeProjectsDir(home: string, env: NodeJS.ProcessEnv): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim()
  return override ? join(override, 'projects') : join(home, '.claude', 'projects')
}

/** A bucket directory to scan, paired with the encoded cwds whose workspaces it would hold. */
type ClaudeProjectsSource = {
  projectsDir: string
  encodedParents: string[]
}

// Lowercased on both sides: the recorded cwd can differ in case from ours on case-insensitive
// filesystems, and a missed bucket reissues a live path while a spurious one costs one name.
function encodeParents(paths: readonly string[]): string[] {
  return paths
    .filter((path) => path.length > 0)
    .flatMap((path) => encodeClaudeProjectPaths(path).map((encoded) => encoded.toLowerCase()))
}

/** Every bucket directory that could hold a workspace under these roots. */
function claudeProjectsSources(args: {
  workspaceRoots: readonly string[]
  home?: string
  env?: NodeJS.ProcessEnv
}): ClaudeProjectsSource[] {
  const hostParents = encodeParents(args.workspaceRoots)
  if (hostParents.length === 0) {
    return []
  }
  return [
    getClaudeProjectsDir(args.home ?? homedir(), args.env ?? process.env),
    ...claudeProfileHistoryDirs('projects')
  ].map((projectsDir) => ({ projectsDir, encodedParents: hostParents }))
}

/** Discovers names already spent for a repo, for the one-time seed of the retirement registry.
 *  Local and best-effort by design — agent state for an SSH workspace lives on the execution host,
 *  so names used only there stay issuable until this host observes them. */
export async function discoverRetiredWorktreeNames(args: {
  workspaceRoots: readonly string[]
  home?: string
  env?: NodeJS.ProcessEnv
}): Promise<RetirementScanResult> {
  const leafNames: string[] = []
  let refused = false
  for (const root of args.workspaceRoots) {
    const listing = await readDirectoryNames(root)
    refused ||= listing.refused
    leafNames.push(...listing.names)
  }

  for (const source of claudeProjectsSources(args)) {
    const listing = await readDirectoryNames(source.projectsDir)
    refused ||= listing.refused
    for (const bucket of listing.names) {
      leafNames.push(...extractBucketLeafCandidates(bucket, source.encodedParents))
    }
  }

  return { names: collectRetiredNamesFromLeafNames(leafNames), complete: !refused }
}
