import { existsSync, lstatSync, readlinkSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { GitError, gitApi, type GitRegistration } from '@quirky/git'
import type { EffectiveHooks, Repo, Worktree, WorktreeRemoveResult } from '@quirky/protocol'
import { contains, resolveRealPath, worktreeIdForPath } from '../../paths'
import { SelectorSyntaxError, matchWorktrees, type CallerIdentity } from '../../selector'
import { sharedEntryProblem, symlinkedAncestor } from './carry'
import type { BranchCleaner, BranchOutcome } from './branches'
import { gitRunnerPath, runHookScript } from './hooks-run'
import { birthtimeOf, joinMetadata, listEverything, type ListEnv } from './list'
import { filesystemIdentitySource, instanceIdFor } from './identity'
import { forgetWorktreeOrigins, rowOf, type WorktreeRow } from './store'

/** What `quirky.worktree/remove` and `describeRemove` accept. */
export type RemoveParams = {
  worktree: string
  force?: boolean
  withDescendants?: boolean
  skipArchive?: boolean
  allowFailedArchiveHook?: boolean
  /** Refuses when this exact filesystem instance is no longer at the worktree path. */
  expectedInstanceId?: string
  /** Internal cleanup guard: refuse live or unknown runtime state and never close sessions. */
  safeOnly?: boolean
}

export type DeleteBranchParams = { repo: string; branch: string; head: string }

type Options = {
  force: boolean
  withDescendants: boolean
  skipArchive: boolean
  allowFailedArchiveHook: boolean
  expectedInstanceId?: string
  safeOnly: boolean
}

/** A remove that is running in this daemon, so an identical request can share it. */
export type InFlightRemove = { options: string; promise: Promise<WorktreeRemoveResult> }

/** What the pipeline needs from the plugin: the listing environment plus errors, sessions, hooks and branch cleanup. */
export type RemoveEnv = ListEnv & {
  /** The IDs being removed; the same set the list reads. */
  removing: Set<string>
  inflight: Map<string, InFlightRemove>
  fail(kind: 'invalid-params' | 'not-found' | 'conflict', message: string, data?: unknown): Error
  changed(data: { repoId: string; worktreeId: string; removed?: true }): void
  repos(): Promise<Repo[]>
  resolveRepo(selector: string): Promise<Repo>
  /** The effective hooks of a project as read at `ref`. */
  hooksAt(repo: Repo, ref: string): Promise<EffectiveHooks>
  /** Closes every session of a worktree, attempting all; one message per failure. */
  closeSessions(worktreeId: string): Promise<string[]>
  /** Rechecks public session process evidence without closing anything. */
  assertNoActiveSessions(worktreeId: string): Promise<string[]>
  branches: BranchCleaner
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** git's own explanation for a failure: its stderr when it has one, else the error message. */
function gitMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  return typeof stderr === 'string' && stderr.trim() ? stderr.trim() : messageOf(error)
}

const reasoned = (env: RemoveEnv, kind: 'invalid-params' | 'not-found' | 'conflict', reason: string, message: string, data: Record<string, unknown> = {}) =>
  env.fail(kind, message, { reason, ...data })

const optionsOf = (params: RemoveParams): Options => ({
  force: params.force === true,
  withDescendants: params.withDescendants === true,
  skipArchive: params.skipArchive === true,
  allowFailedArchiveHook: params.allowFailedArchiveHook === true,
  ...(params.expectedInstanceId === undefined ? {} : { expectedInstanceId: params.expectedInstanceId }),
  safeOnly: params.safeOnly === true
})


/** A workspace git no longer lists as a usable folder: `gone` has no folder, `forgotten` has a folder but no registration. */
type Orphan = { kind: 'gone' | 'forgotten'; registration: GitRegistration | null; row: WorktreeRow | null }

/** Every workspace a remove can name: the listed ones plus the orphans `list` hides. */
type Scope = { repos: Repo[]; worktrees: Worktree[]; orphans: Map<string, Orphan> }

function blankRow(id: string, repoId: string, path: string): WorktreeRow {
  return {
    id,
    repo_id: repoId,
    kind: 'git',
    path,
    name: null,
    display_name: null,
    comment: '',
    status: 'in-progress',
    pinned: 0,
    unread: 0,
    parent_id: null,
    created_at: null,
    created_by: 'external',
    base_ref: null,
    keep_branch: 0,
    birthtime: null,
    group_id: null,
    created_root: null,
    project_group_id: null,
    last_activity_at: 0,
    instance_id: `unverified:${id}`,
    linked_pr: null,
    linked_issue: null,
    push_target: null,
    manual_order: 0,
    sleeping: 0,
    sleep_changed_at: 0,
    cleanup_ignored_fingerprint: null,
    references_json: '[]',
    archived_at: null,
    automation_provenance: null,
    cleanup_ignored_at: null
  }
}

/**
 * The listed workspaces plus, for each git project, the registrations that are prunable or whose
 * folder is gone, and the rows git no longer registers (a folder still on disk makes it
 * `forgotten`). A project git can't be asked about contributes no orphans.
 */
async function gatherScope(env: RemoveEnv): Promise<Scope> {
  const repos = await env.repos()
  const listed = await listEverything(env, repos)
  const worktrees = [...listed]
  const orphans = new Map<string, Orphan>()
  const known = new Set(listed.map((worktree) => worktree.id))

  const add = (repo: Repo, id: string, path: string, branch: string | null, head: string, orphan: Orphan) => {
    const row = orphan.row ?? blankRow(id, repo.id, path)
    worktrees.push(joinMetadata({ id, repoId: repo.id, path, branch, head, isMain: false, kind: 'git', groupId: null }, row, env.removing.has(id), env.store))
    orphans.set(id, orphan)
    known.add(id)
  }

  for (const repo of repos) {
    if (repo.kind !== 'git') continue
    let registrations: GitRegistration[]
    try {
      registrations = await gitApi().listRegistrations(repo.path)
    } catch (error) {
      env.log(`could not look for orphaned workspaces of ${repo.name}: ${messageOf(error)}`)
      continue
    }
    const registered = new Set(registrations.map((registration) => worktreeIdForPath(registration.path)))
    for (const registration of registrations) {
      if (registration.isMain || !(registration.prunable || !registration.exists)) continue
      const id = worktreeIdForPath(registration.path)
      if (known.has(id)) continue
      add(repo, id, resolveRealPath(registration.path), registration.branch, registration.head, { kind: 'gone', registration, row: rowOf(env.store, id) })
    }
    for (const row of env.store.all<WorktreeRow>("SELECT * FROM worktrees WHERE repo_id = ? AND kind = 'git' AND group_id IS NULL", repo.id)) {
      if (registered.has(row.id) || known.has(row.id) || row.path === null) continue
      add(repo, row.id, row.path, null, '', { kind: existsSync(row.path) ? 'forgotten' : 'gone', registration: null, row })
    }
  }
  return { repos, worktrees, orphans }
}

/** The one workspace a selector names among listed workspaces and orphans; a `path:` to a folder Quirky has no record of is `unregistered`. */
async function resolveTarget(env: RemoveEnv, selector: string, identity: CallerIdentity): Promise<{ target: Worktree; scope: Scope }> {
  const scope = await gatherScope(env)
  let matches: Worktree[]
  try {
    matches = matchWorktrees(scope.worktrees, selector, identity)
  } catch (error) {
    if (error instanceof SelectorSyntaxError) throw env.fail('invalid-params', error.message)
    throw error
  }
  if (matches.length === 0) {
    const asPath = /^path:(.+)$/s.exec(selector.trim())
    if (asPath) {
      const wanted = isAbsolute(asPath[1]!) ? asPath[1]! : resolve(identity.cwd ?? '/', asPath[1]!)
      if (existsSync(wanted)) {
        const path = resolveRealPath(wanted)
        throw reasoned(env, 'conflict', 'unregistered', `${path} is not a workspace Quirky knows, so it was left alone.`, { path })
      }
    }
    throw env.fail('not-found', `no worktree matches ${selector}; use id:, name:, branch:, path: or current`)
  }
  if (matches.length > 1) {
    const ids = matches.map((worktree) => `id:${worktree.id}`)
    throw env.fail('conflict', `${selector} matches ${matches.length} worktrees: ${ids.join(', ')}`, { matches: ids })
  }
  return { target: matches[0]!, scope }
}

/** The workspaces nested under `id` at any depth, parents before their children. */
function descendantsOf(worktrees: Worktree[], id: string): Worktree[] {
  const found: Worktree[] = []
  const seen = new Set([id])
  const visit = (parentId: string) => {
    for (const child of worktrees.filter((worktree) => worktree.parentId === parentId && !seen.has(worktree.id))) {
      seen.add(child.id)
      found.push(child)
      visit(child.id)
    }
  }
  visit(id)
  return found
}

/**
 * The question asked before a remove: the target, its descendants when they go too, and what a
 * forced remove discards.
 */
export async function describeRemove(env: RemoveEnv, params: RemoveParams, identity: CallerIdentity): Promise<string> {
  const { target, scope } = await resolveTarget(env, params.worktree, identity)
  const options = optionsOf(params)
  const names = options.withDescendants ? descendantsOf(scope.worktrees, target.id).map((worktree) => worktree.name) : []
  return `Remove worktree ${target.name} (${target.path})${names.length > 0 ? ` and its descendants ${names.join(', ')}` : ''}${options.force ? ', discarding uncommitted changes' : ''}?`
}

/**
 * Removes a workspace and, with `withDescendants`, everything nested under it, deepest first. A
 * second request for the same workspace with equal options shares the running remove; different
 * options are refused. The call returns only when everything is finished.
 */
export async function removeWorktree(env: RemoveEnv, params: RemoveParams, identity: CallerIdentity): Promise<WorktreeRemoveResult> {
  if (params.expectedInstanceId !== undefined &&
    (typeof params.expectedInstanceId !== 'string' || params.expectedInstanceId.trim() === '')) {
    throw env.fail('invalid-params', 'expectedInstanceId must be a non-empty filesystem instance identity')
  }
  if (params.expectedInstanceId !== undefined && params.withDescendants === true) {
    throw env.fail('invalid-params', 'expectedInstanceId cannot be combined with withDescendants')
  }
  const options = optionsOf(params)
  const key = JSON.stringify(options)
  const selector = params.worktree.trim()
  const early = env.inflight.get(selector.startsWith('id:') ? selector.slice(3) : selector)
  if (early) return joinRunning(env, early, key)

  const { target, scope } = await resolveTarget(env, params.worktree, identity)
  return run(env, target.id, options, () => removeTree(env, scope, target, options))
}

function joinRunning(env: RemoveEnv, running: InFlightRemove, key: string): Promise<WorktreeRemoveResult> {
  if (running.options !== key) throw reasoned(env, 'conflict', 'deletion-in-progress', 'Worktree deletion already in progress')
  return running.promise
}

/** Runs `work` as the one remove of `id`, or joins the one already running. */
function run(env: RemoveEnv, id: string, options: Options, work: () => Promise<WorktreeRemoveResult>): Promise<WorktreeRemoveResult> {
  const key = JSON.stringify(options)
  const running = env.inflight.get(id)
  if (running) return joinRunning(env, running, key)
  env.removing.add(id)
  const promise = work().finally(() => {
    env.removing.delete(id)
    env.inflight.delete(id)
  })
  env.inflight.set(id, { options: key, promise })
  return promise
}

/** What one workspace's removal contributes to the result. */
type Piece = { removed: string[]; kept: { name: string; head: string }[]; sessionErrors: string[] }

async function removeTree(env: RemoveEnv, scope: Scope, target: Worktree, options: Options): Promise<WorktreeRemoveResult> {
  if (target.isMain) throw reasoned(env, 'conflict', 'primary', 'the primary worktree cannot be deleted; remove the project instead')

  const descendants = descendantsOf(scope.worktrees, target.id)
  const primary = descendants.find((descendant) => descendant.isMain)
  if (primary) throw reasoned(env, 'conflict', 'primary', `${primary.name} is a primary worktree nested under ${target.name} and cannot be deleted; remove the project instead`, { primary: primary.id })
  if (descendants.length > 0 && !options.withDescendants) {
    throw reasoned(env, 'conflict', 'has-descendants', `${target.name} has child workspaces: ${descendants.map((worktree) => worktree.name).join(', ')}. Remove them too with --with-descendants.`, {
      descendants: descendants.map((worktree) => worktree.id)
    })
  }

  const pieces: Piece[] = []
  const removedSoFar = () => pieces.flatMap((piece) => piece.removed)
  try {
    for (const child of [...descendants].reverse()) pieces.push(await removeNested(env, scope, child, options))
    pieces.push(await removeOne(env, scope, target, options))
  } catch (error) {
    if (descendants.length > 0 && typeof error === 'object' && error !== null) {
      Object.assign(error, { data: { ...((error as { data?: object }).data ?? {}), removed: removedSoFar() } })
    }
    throw error
  }

  const sessionErrors = pieces.flatMap((piece) => piece.sessionErrors)
  const kept = pieces.at(-1)!.kept[0] ?? pieces.flatMap((piece) => piece.kept)[0]
  for (const extra of pieces.flatMap((piece) => piece.kept)) {
    if (extra !== kept) env.log(`kept branch ${extra.name} at ${extra.head}: it is not merged`)
  }
  return { ok: true, removed: removedSoFar(), ...(kept ? { keptBranch: kept } : {}), ...(sessionErrors.length > 0 ? { sessionErrors } : {}) }
}

/** A descendant goes through the same pipeline as any remove, so it is flagged and joinable while it runs. */
async function removeNested(env: RemoveEnv, scope: Scope, child: Worktree, options: Options): Promise<Piece> {
  const nested: Options = { ...options, withDescendants: false }
  const result = await run(env, child.id, nested, async () => {
    const piece = await removeOne(env, scope, child, nested)
    return { ok: true, removed: piece.removed, ...(piece.kept[0] ? { keptBranch: piece.kept[0] } : {}), ...(piece.sessionErrors.length > 0 ? { sessionErrors: piece.sessionErrors } : {}) }
  })
  return { removed: result.removed, kept: result.keptBranch ? [result.keptBranch] : [], sessionErrors: result.sessionErrors ?? [] }
}

/** Steps 5 to 12 for one workspace that has no descendants left. */
async function removeOne(env: RemoveEnv, scope: Scope, target: Worktree, options: Options): Promise<Piece> {
  assertExpectedInstance(env, target, options.expectedInstanceId)
  if (options.safeOnly) {
    const blockers = await env.assertNoActiveSessions(target.id)
    if (blockers.length > 0) throw reasoned(env, 'conflict', 'runtime-safety', `could not prove ${target.name} has no live sessions: ${blockers.join('; ')}`)
  }
  if (target.kind === 'folder') return removeFolderWorkspace(env, target, options)
  const repo = scope.repos.find((candidate) => candidate.id === target.repoId)
  if (!repo) throw env.fail('not-found', `no project for ${target.name}`)
  const orphan = scope.orphans.get(target.id)
  return orphan ? removeOrphan(env, repo, target, orphan, options) : removeRegistered(env, repo, target, options)
}

function dropRow(env: RemoveEnv, target: Worktree): void {
  env.store.transaction(() => {
    forgetWorktreeOrigins(env.store, target.id)
    env.store.run('DELETE FROM worktrees WHERE id = ?', target.id)
  })
  env.changed({ repoId: target.repoId, worktreeId: target.id, removed: true })
}

/** Rechecks the kernel-visible filesystem instance, never only its path-derived row ID. */
function assertExpectedInstance(env: RemoveEnv, target: Worktree, expectedInstanceId?: string): void {
  if (expectedInstanceId === undefined) return
  const identity = filesystemIdentitySource.stat(target.path)
  const actualInstanceId = identity === null ? null : instanceIdFor(identity)
  if (target.instanceId !== expectedInstanceId || actualInstanceId !== expectedInstanceId) {
    throw reasoned(
      env,
      'conflict',
      'instance-changed',
      `${target.name} is no longer the filesystem instance selected for removal; refresh and select it again.`,
      { expectedInstanceId, actualInstanceId, worktreeId: target.id }
    )
  }
}

/** Closes sessions for an ordinary remove; safe-only cleanup rechecks and never closes them. */
async function closeSessions(env: RemoveEnv, target: Worktree, options: Options): Promise<string[]> {
  if (options.safeOnly) {
    const blockers = await env.assertNoActiveSessions(target.id)
    if (blockers.length > 0) throw reasoned(env, 'conflict', 'runtime-safety', `could not prove ${target.name} has no live sessions: ${blockers.join('; ')}`)
    return []
  }
  const errors = await env.closeSessions(target.id)
  if (errors.length > 0 && !options.force) throw env.fail('conflict', `could not close the sessions of ${target.name}: ${errors.join('; ')}`)
  return errors
}

/** Closes its sessions and forgets the row; the folder it stands on is never touched. */
async function removeFolderWorkspace(env: RemoveEnv, target: Worktree, options: Options): Promise<Piece> {
  const sessionErrors = await closeSessions(env, target, options)
  assertExpectedInstance(env, target, options.expectedInstanceId)
  dropRow(env, target)
  return { removed: [target.id], kept: [], sessionErrors }
}


const lockedError = (env: RemoveEnv, target: Worktree, reason: string) =>
  reasoned(
    env,
    'conflict',
    'locked',
    `This workspace is locked by Git. Git reported: ${reason || 'no reason given'}. Run git worktree unlock ${target.path} from its repository, then retry deletion.`,
    { lockReason: reason }
  )

async function cleanBranch(env: RemoveEnv, repo: Repo, target: Worktree): Promise<Piece['kept']> {
  if (target.branch === null) return []
  let outcome: BranchOutcome
  try {
    outcome = await env.branches.cleanUp({ repoPath: repo.path, branch: target.branch, keepBranch: target.keepBranch, baseRef: target.baseRef })
  } catch (error) {
    env.log(`could not clean up branch ${target.branch} of ${target.name}: ${messageOf(error)}`)
    const head = await gitApi().branchHead(repo.path, target.branch).catch(() => null)
    return head === null ? [] : [{ name: target.branch, head }]
  }
  return outcome.status === 'kept' ? [{ name: outcome.name, head: outcome.head }] : []
}

/** A workspace git has lost track of: a missing folder is pruned and cleaned up; a leftover folder is refused or, forced, deleted only if it is still the folder Quirky made. */
async function removeOrphan(env: RemoveEnv, repo: Repo, target: Worktree, orphan: Orphan, options: Options): Promise<Piece> {
  if (orphan.kind === 'gone') {
    if (orphan.registration?.locked != null) throw lockedError(env, target, orphan.registration.locked)
    const sessionErrors = await closeSessions(env, target, options)
    assertExpectedInstance(env, target, options.expectedInstanceId)
    await gitApi().prune(repo.path)
    const kept = await cleanBranch(env, repo, target)
    dropRow(env, target)
    return { removed: [target.id], kept, sessionErrors }
  }

  if (!options.force) {
    throw reasoned(env, 'conflict', 'orphaned', 'Git already forgot this workspace, but its directory is still on disk. Use Force Delete to remove the orphaned directory.', { path: target.path })
  }
  const folder = resolveRealPath(target.path)
  const createdRoot = orphan.row?.created_root ? resolveRealPath(orphan.row.created_root) : null
  if (createdRoot === null || folder === createdRoot || !contains(createdRoot, folder)) {
    throw reasoned(env, 'conflict', 'unregistered', `${folder} is not a workspace Quirky created inside its worktrees folder, so it was left alone.`, { path: folder })
  }
  const recorded = orphan.row?.birthtime ?? null
  if (recorded === null || birthtimeOf(folder) !== recorded) {
    throw reasoned(env, 'conflict', 'unregistered', `${folder} is not the folder Quirky created for this workspace, so it was left alone.`, { path: folder })
  }
  const sessionErrors = await closeSessions(env, target, options)
  assertExpectedInstance(env, target, options.expectedInstanceId)
  rmSync(folder, { recursive: true, force: true })
  dropRow(env, target)
  return { removed: [target.id], kept: [], sessionErrors }
}

/**
 * The shared directories of the hooks file that are Quirky's own links in the worktree: an entry
 * that passes the creation rules, sits under no symlinked directory, and points at the primary
 * checkout's copy. Anything else is left in place and counts as a change.
 */
function sharedLinks(repoPath: string, worktreePath: string, sharedDirectories: string[]): string[] {
  return sharedDirectories
    .map((entry) => entry.replace(/\/+$/, ''))
    .filter((entry) => {
      try {
        if (entry === '' || sharedEntryProblem(entry) !== null || symlinkedAncestor(worktreePath, entry) !== null) return false
        const link = join(worktreePath, entry)
        if (!lstatSync(link).isSymbolicLink()) return false
        return resolve(dirname(link), readlinkSync(link)) === resolve(repoPath, entry)
      } catch {
        return false
      }
    })
}

/** Steps 7 to 12 for a worktree git still registers with a folder on disk. */
async function removeRegistered(env: RemoveEnv, repo: Repo, target: Worktree, options: Options): Promise<Piece> {
  const git = gitApi()
  const registration = (await git.listRegistrations(repo.path)).find((candidate) => worktreeIdForPath(candidate.path) === target.id)
  if (!registration) {
    return removeOrphan(env, repo, target, { kind: existsSync(target.path) ? 'forgotten' : 'gone', registration: null, row: rowOf(env.store, target.id) }, options)
  }
  if (registration.locked !== null) throw lockedError(env, target, registration.locked)

  let hooks: Promise<EffectiveHooks> | undefined
  const loadHooks = () => (hooks ??= env.hooksAt(repo, target.head || 'HEAD'))
  const links = sharedLinks(repo.path, target.path, await loadHooks().then((loaded) => loaded.sharedDirectories, () => []))

  if (!options.force) {
    const linked = new Set(links)
    const changes = (await git.dirtyEntries(target.path)).filter((path) => !linked.has(path.replace(/\/+$/, '')))
    if (changes.length > 0) throw reasoned(env, 'conflict', 'dirty', 'Worktree has uncommitted or untracked changes.', { count: changes.length })
    if (await git.hasPopulatedSubmodules(target.path)) {
      throw reasoned(env, 'conflict', 'submodules', 'Worktree has populated submodules. Use force to delete it.')
    }
  }

  if (!options.skipArchive) {
    assertExpectedInstance(env, target, options.expectedInstanceId)
    await runArchive(env, repo, target, await loadHooks(), options)
  }

  const sessionErrors = await closeSessions(env, target, options)
  assertExpectedInstance(env, target, options.expectedInstanceId)
  for (const link of links) {
    try {
      assertExpectedInstance(env, target, options.expectedInstanceId)
      unlinkSync(join(target.path, link))
    } catch (error) {
      if (options.expectedInstanceId !== undefined) throw error
      env.log(`could not remove the shared directory link ${link} of ${target.name}: ${messageOf(error)}`)
    }
  }
  assertExpectedInstance(env, target, options.expectedInstanceId)
  try {
    await git.removeWorktree(repo.path, target.path, options.force)
  } catch (error) {
    if (error instanceof GitError && error.exitCode > 0) throw env.fail('conflict', `could not remove ${target.name}: ${gitMessage(error)}`)
    throw new Error(gitMessage(error))
  }

  const kept = await cleanBranch(env, repo, target)
  dropRow(env, target)
  return { removed: [target.id], kept, sessionErrors }
}


/** Step 9: the effective archive script, refusing an untrusted shared one and failing the remove if it fails. */
async function runArchive(env: RemoveEnv, repo: Repo, target: Worktree, hooks: EffectiveHooks, options: Options): Promise<void> {
  const archive = hooks.archive
  if (!archive) return
  const shared = archive.shared
  if (shared && !shared.trusted) {
    const file = hooks.file ?? 'quirky.yaml'
    const lead = shared.changed ? `The archive script in ${file} changed since you last trusted it` : `The archive script in ${file} has not been trusted`
    throw reasoned(
      env,
      'conflict',
      'hooks-untrusted',
      `${lead}:\n${shared.text}\nRun: quirky repo trust-hooks ${repo.displayName ?? repo.name} --kind archive, or pass --skip-archive`,
      { repo: repo.id, kind: 'archive', source: file, script: shared.text, hash: shared.hash, changed: shared.changed }
    )
  }
  const runner = await gitRunnerPath(target.path, 'archive')
  const outcome = await runHookScript(runner, { rootPath: repo.path, worktreePath: target.path }, archive.text)
  if (outcome.exitCode === 0 && !outcome.timedOut) return
  const what = outcome.timedOut ? 'timed out' : `exited with ${outcome.exitCode ?? 'a signal'}`
  if (options.allowFailedArchiveHook) {
    env.log(`archive script for ${target.path} ${what}; removing anyway:\n${outcome.output.slice(-2000)}`)
    return
  }
  throw reasoned(
    env,
    'conflict',
    'archive-hook-failed',
    `The archive script for ${target.name} ${what}.${outcome.output.trim() ? `\n${outcome.output.trim().slice(-2000)}` : ''}\nFix it, or pass --skip-archive or --allow-failed-archive-hook.`,
    { exitCode: outcome.exitCode, output: outcome.output }
  )
}

/**
 * Deletes `branch` of a project only while it still points at `head`, so a branch that gained
 * commits since the remove reported it is left alone. A branch checked out in a worktree is never deleted.
 */
export async function deleteBranch(env: RemoveEnv, params: DeleteBranchParams): Promise<{ ok: true }> {
  const git = gitApi()
  const repo = await env.resolveRepo(params.repo)
  if (repo.kind !== 'git') throw env.fail('invalid-params', `${repo.name} is not a git project`)
  if (params.branch.startsWith('-') || !(await git.checkRefFormatBranch(params.branch))) throw env.fail('invalid-params', `${params.branch} is not a valid branch name`)
  if (!/^[0-9a-f]{7,64}$/i.test(params.head)) throw env.fail('invalid-params', 'head must be the commit the branch pointed at, as hex')

  const holder = (await git.listRegistrations(repo.path)).find((registration) => registration.branch === params.branch)
  if (holder) {
    throw reasoned(env, 'conflict', 'branch-checked-out', `branch '${params.branch}' is checked out at ${holder.path}, so it was not deleted`, { branch: params.branch, path: holder.path })
  }
  const outcome = await env.branches.deleteAt(repo.path, params.branch, params.head)
  if (!outcome.deleted) {
    const now = outcome.head === null ? 'no longer exists' : `is now at ${outcome.head}`
    throw reasoned(env, 'conflict', 'branch-moved', `Branch ${params.branch} is not at ${params.head} any more (it ${now}), so it was left alone.`, { branch: params.branch, head: outcome.head })
  }
  return { ok: true }
}
