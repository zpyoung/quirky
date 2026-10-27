import { gitApi } from '@quirky/git'

/** A notice that the requested remote base could not be refreshed and a local branch was used. */
export type BaseFallback = { requestedRef: string; localRef: string; message: string }

/** The commit-ish a new branch is cut from, as a full ref (or a sha) and in its short, human form. */
export type ResolvedBase = { fullRef: string; shortRef: string; fallback?: BaseFallback }

export type BaseFailureReason = 'no-base' | 'base-unreachable' | 'not-found'

/** Why no base could be used; `reason` maps onto the create error reasons. */
export class BaseError extends Error {
  constructor(
    readonly reason: BaseFailureReason,
    message: string,
    readonly data: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'BaseError'
  }
}

export type ResolveBaseOptions = {
  /** The caller's base; wins over everything. */
  requested?: string | undefined
  /** The project's saved default base. */
  saved?: string | null | undefined
  /** Use the local branch of the same name when a remote base cannot be fetched (default true). */
  allowLocalFallback?: boolean | undefined
  log?: (message: string) => void
  fetchTimeoutMs?: number
}

const FETCH_TIMEOUT_MS = 30_000

const quoted = (text: string): string => `"${text}"`

const shortOf = (fullRef: string, requested: string): string =>
  fullRef.startsWith('refs/remotes/') ? fullRef.slice('refs/remotes/'.length) : fullRef.startsWith('refs/heads/') ? fullRef.slice('refs/heads/'.length) : requested

/** The saved default if usable, else the detected default; throws `no-base` when neither exists. */
async function defaultBaseName(repo: string, saved: string | null | undefined): Promise<string> {
  const git = gitApi()
  const detected = await git.detectDefaultBase(repo)
  const wanted = saved?.trim() || null
  if (wanted !== null) {
    if (wanted === detected) return wanted
    if ((await git.resolveBaseRef(repo, wanted)) !== null) return wanted
  }
  if (detected !== null) return detected
  throw new BaseError('no-base', 'Could not resolve a default base ref for this repo. Pass an explicit --base and try again.')
}

/** The configured remote that `name` is written against (`origin/main` -> `origin`), if any. */
async function remoteOf(repo: string, name: string): Promise<string | null> {
  const slash = name.indexOf('/')
  if (slash <= 0) return null
  const prefix = name.slice(0, slash)
  return (await gitApi().listRemotes(repo)).includes(prefix) ? prefix : null
}

/**
 * Resolves the base of a new branch: the requested one, else the project's saved default, else the
 * detected default. A remote-tracking base that exists is used as is and refreshed in the
 * background; a missing one is fetched first, and if that fails the local branch of the same name
 * is used (with a notice) when `allowLocalFallback` is on. Throws `BaseError` and changes nothing
 * in the repo except what the fetch writes.
 */
export async function resolveBase(repo: string, options: ResolveBaseOptions = {}): Promise<ResolvedBase> {
  const git = gitApi()
  const log = options.log ?? (() => {})
  const name = options.requested?.trim() || (await defaultBaseName(repo, options.saved))

  const remote = await remoteOf(repo, name)
  if (remote === null) {
    const fullRef = await git.resolveBaseRef(repo, name)
    if (fullRef === null) throw new BaseError('not-found', `Base ref "${name}" was not found.`, { ref: name })
    return { fullRef, shortRef: shortOf(fullRef, name) }
  }

  const branch = name.slice(remote.length + 1)
  const remoteRef = `refs/remotes/${name}`
  if (await git.refExists(repo, remoteRef)) {
    void git.fetchRemote(repo, remote, branch).then((ok) => {
      if (!ok) log(`could not refresh ${name} from ${remote} in the background`)
    })
    return { fullRef: remoteRef, shortRef: name }
  }
  if (await git.refExists(repo, `refs/heads/${name}`)) return { fullRef: `refs/heads/${name}`, shortRef: name }

  const fetched = await git.fetchRemote(repo, remote, undefined, options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS)
  if (fetched) {
    if (await git.refExists(repo, remoteRef)) return { fullRef: remoteRef, shortRef: name }
    throw new BaseError('base-unreachable', `Base ref "${name}" was not found after fetching.`, { ref: name, remote })
  }
  if (options.allowLocalFallback !== false && (await git.refExists(repo, `refs/heads/${branch}`))) {
    return {
      fullRef: `refs/heads/${branch}`,
      shortRef: branch,
      fallback: {
        requestedRef: name,
        localRef: branch,
        message: `The remote-tracking ref ${name} was unavailable, so Quirky used local ${branch} instead. This workspace may not include the latest remote changes.`
      }
    }
  }
  throw new BaseError('base-unreachable', `Could not refresh base ref ${quoted(name)} from ${quoted(remote)}. Check your network and try again.`, { ref: name, remote })
}
