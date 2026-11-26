import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TurnChangesFile } from '../../shared/agent-session-journal-v1-items'
import { extractExecError } from './exec-error'
import { gitExecFileAsync } from './runner'

export type WorkspaceTreeSnapshot = { tree: string } | { notGit: true } | { failed: string }

const NOT_A_REPOSITORY = /not a git repository/i
const TREE_ID = /^[0-9a-f]{40,64}$/
const DIFF_MAX_BUFFER = 64 * 1024 * 1024

function failureText(error: unknown): string {
  const { stderr } = extractExecError(error)
  return stderr.trim().split('\n')[0] || (error instanceof Error ? error.message : String(error))
}

/**
 * Writes a tree object for the whole working tree (tracked and untracked files, honoring
 * `.gitignore`) and returns its id. The tree is built in a temporary index seeded from HEAD, so
 * the real index, HEAD and refs are never touched; only objects are added. Never throws.
 *
 * A directory below its repository's top level is `notGit`: `git add -A` would snapshot the whole
 * repository, and a file path git reports would no longer be relative to `cwd`.
 */
export async function snapshotWorkspaceTree(cwd: string): Promise<WorkspaceTreeSnapshot> {
  let scratch: string | null = null
  try {
    let inside: string
    try {
      inside = (
        await gitExecFileAsync(['rev-parse', '--is-inside-work-tree', '--show-prefix'], { cwd })
      ).stdout
    } catch (error) {
      return NOT_A_REPOSITORY.test(extractExecError(error).stderr)
        ? { notGit: true }
        : { failed: failureText(error) }
    }
    const [isWorkTree, prefix = ''] = inside.split('\n')
    if (isWorkTree?.trim() !== 'true' || prefix.trim() !== '') {
      return { notGit: true }
    }
    scratch = await mkdtemp(join(tmpdir(), 'quirky-turn-tree-'))
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') }
    const born = await gitExecFileAsync(['rev-parse', '--verify', '--quiet', 'HEAD'], { cwd })
      .then(() => true)
      .catch(() => false)
    if (born) {
      await gitExecFileAsync(['read-tree', 'HEAD'], { cwd, env })
    }
    await gitExecFileAsync(['add', '-A'], { cwd, env })
    const tree = (await gitExecFileAsync(['write-tree'], { cwd, env })).stdout.trim()
    return TREE_ID.test(tree) ? { tree } : { failed: 'git write-tree returned no tree id' }
  } catch (error) {
    return { failed: failureText(error) }
  } finally {
    if (scratch !== null) {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

const RAW_STATUS: Readonly<Record<string, TurnChangesFile['status']>> = {
  A: 'added',
  C: 'added',
  D: 'deleted',
  M: 'modified',
  R: 'renamed',
  T: 'modified'
}

const NUMSTAT_TOKEN = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/

/** Parses `git diff --raw --numstat -z`: raw records first, then numstat records. A rename's
 *  paths follow its record as two more tokens in both sections. */
function parseTreeChanges(output: string): TurnChangesFile[] {
  const tokens = output.split('\0')
  const files: TurnChangesFile[] = []
  const counts = new Map<string, { added: number; removed: number }>()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? ''
    if (token.startsWith(':')) {
      const status = token.split(' ').at(-1)?.charAt(0) ?? ''
      const mapped = RAW_STATUS[status]
      const first = tokens[index + 1]
      if (mapped === undefined || first === undefined) {
        continue
      }
      if (status === 'R' || status === 'C') {
        const second = tokens[index + 2]
        index += 2
        if (second !== undefined) {
          files.push(
            status === 'R'
              ? { path: second, status: mapped, oldPath: first }
              : { path: second, status: mapped }
          )
        }
      } else {
        index += 1
        files.push({ path: first, status: mapped })
      }
      continue
    }
    const numstat = NUMSTAT_TOKEN.exec(token)
    if (!numstat) {
      continue
    }
    let path = numstat[3] ?? ''
    if (path === '') {
      path = tokens[index + 2] ?? ''
      index += 2
    }
    if (numstat[1] !== '-' && numstat[2] !== '-') {
      counts.set(path, { added: Number(numstat[1]), removed: Number(numstat[2]) })
    }
  }
  return files.map((file) => {
    const count = counts.get(file.path)
    return count ? { ...file, ...count } : file
  })
}

/**
 * The files that differ between two tree ids, with line counts and renames detected; binary files
 * carry no counts. Throws when git fails, so a caller can tell "nothing changed" from "unknown".
 */
export async function listTreeChanges(
  cwd: string,
  from: string,
  to: string
): Promise<TurnChangesFile[]> {
  const { stdout } = await gitExecFileAsync(
    ['diff', '--raw', '--numstat', '-z', '-M', from, to, '--'],
    { cwd, maxBuffer: DIFF_MAX_BUFFER }
  )
  return parseTreeChanges(stdout)
}
