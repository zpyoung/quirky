import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { RpcErrorCode, type ApiDescription, type ProjectGroup, type Repo, type Worktree, type WorktreeCreateResult, type WorktreeRemoveResult } from '@quirky/protocol'
import { waitFor, waitForAsync } from '../../../packages/daemon/test/helpers'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { call, commitFiles, failure, git, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { startPluginHarness, testCliContext, type PluginHarness } from '../../quirky.repo/test/harness'
import { commands } from '../cli'
import { worktreeIdForPath } from '../paths'
import { makeOrigin, makeProject } from './fixtures/repos'
import { addExternalWorktree, listWorktrees, storedRows } from './fixtures/real-project'

const { scratch } = isolateGitConfig()
// every test starts a daemon and runs real git several times
setDefaultTimeout(60_000)

type World = {
  t: PluginHarness
  root: string
  repoDir: string
  repo: Repo
}

/** A path inside a fresh scratch directory that exists, so scripts can write to it. */
function scratchFile(name: string): string {
  const dir = scratch()
  mkdirSync(dir, { recursive: true })
  return join(dir, name)
}

let world: World | undefined
afterEach(async () => {
  await world?.t.cleanup()
  world = undefined
})

/** A daemon on real git with a project cloned from a local origin, so `origin/main` is the default base. */
async function start(options: { files?: Record<string, string>; ignored?: string[] } = {}): Promise<World> {
  const t = await startPluginHarness({ realGit: true, fakeAsk: true })
  const root = realpathSync(makeTempDir('qw-'))
  await call(t.client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const origin = makeOrigin(join(scratch(), 'origin.git'))
  const repoDir = makeProject(join(scratch(), 'api'), { origin, ...options })
  if (options.files || options.ignored) git(repoDir, 'push', '-q', 'origin', 'main')
  const repo = (await call(t.client, 'quirky.repo/add', { path: repoDir })) as Repo
  world = { t, root, repoDir, repo }
  return world
}

const create = async (w: World, name: string, extra: Record<string, unknown> = {}): Promise<Worktree> =>
  ((await call(w.t.client, 'quirky.worktree/create', { repo: w.repo.id, name, ...extra })) as WorktreeCreateResult).worktree

const remove = async (w: World, worktree: string, extra: Record<string, unknown> = {}): Promise<WorktreeRemoveResult> =>
  (await call(w.t.client, 'quirky.worktree/remove', { worktree, yes: true, ...extra })) as WorktreeRemoveResult

const removeFailure = (w: World, worktree: string, extra: Record<string, unknown> = {}) => failure(call(w.t.client, 'quirky.worktree/remove', { worktree, yes: true, ...extra }))

const shell = async (w: World, worktree: Worktree) => (await call(w.t.client, 'quirky.session/create', { worktree: worktree.id, agent: 'shell' })) as { id: string }

const setArchive = (w: World, script: string) => call(w.t.client, 'quirky.repo/set', { repo: w.repo.id, archiveScript: script })

const branches = (w: World): string[] => git(w.repoDir, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean)
const registered = (w: World): string[] => git(w.repoDir, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).map((line) => line.slice(9))
const listIds = async (w: World) => (await listWorktrees(w.t.client, { repo: w.repo.id })).map((worktree) => worktree.id)

/** Runs `quirky wt rm` through the CLI module, answering the kernel confirmation with `--yes`. */
async function cliRm(w: World, selector: string, flags: Record<string, unknown> = {}, json = false): Promise<string[]> {
  const { ctx, lines } = testCliContext(w.t.client, { yes: ['quirky.worktree/remove'], json })
  await commands.rm!({ positionals: [selector], flags }, ctx)
  return lines
}

/** Commits `files` on a worktree's branch, so the branch has commits `origin/main` does not. */
const commitIn = (worktree: Worktree, files: Record<string, string>) => commitFiles(worktree.path, files)

describe('SC-46: deleting a clean worktree removes it and its merged branch (CLI)', () => {
  test('the folder, registration, branch, session and list entry are gone; --yes goes through the CLI too', async () => {
    const w = await start()
    const fix = await create(w, 'fix-login')
    const docs = await create(w, 'docs')
    const session = await shell(w, fix)

    const result = await remove(w, fix.id)
    expect(result).toEqual({ ok: true, removed: [fix.id] })
    expect(existsSync(fix.path)).toBe(false)
    expect(registered(w)).not.toContain(fix.path)
    expect(branches(w)).not.toContain(fix.branch!)
    expect(w.t.sessions.closed).toEqual([session.id])
    expect(await listIds(w)).not.toContain(fix.id)

    expect(await cliRm(w, 'docs')).toEqual(['removed docs'])
    expect(existsSync(docs.path)).toBe(false)
    expect(branches(w)).not.toContain(docs.branch!)
  })

  test('the row is dropped and a changed event names the worktree', async () => {
    const w = await start()
    const fix = await create(w, 'fix-login')
    expect(storedRows(w.t.h.home, 'id = ?', fix.id)).toHaveLength(1)
    const watcher = await w.t.h.connectWithEvents('cli')
    await remove(w, fix.id)
    expect(storedRows(w.t.h.home, 'id = ?', fix.id)).toHaveLength(0)
    await waitFor(() => watcher.events.some((event) => event.type === 'quirky.worktree/changed' && (event.data as { worktreeId?: string })?.worktreeId === fix.id))
  })
})

describe('SC-47: changes block a delete unless forced, and nothing is stopped first (CLI)', () => {
  test('an untracked file refuses with the exact sentence; force removes and closes the session', async () => {
    const w = await start()
    const fix = await create(w, 'fix-login')
    const session = await shell(w, fix)
    writeFileSync(join(fix.path, 'notes.txt'), 'x')

    const refused = await failure(cliRm(w, 'fix-login'))
    expect(refused.code).toBe(RpcErrorCode.Conflict)
    expect(refused.message).toBe('Worktree has uncommitted or untracked changes.')
    expect(refused.data).toMatchObject({ reason: 'dirty', count: 1 })
    expect(existsSync(fix.path)).toBe(true)
    expect(w.t.sessions.sessions.map((s) => s.id)).toEqual([session.id])
    expect(w.t.sessions.closed).toEqual([])

    expect(await cliRm(w, 'fix-login', { force: true })).toEqual(['removed fix-login'])
    expect(existsSync(fix.path)).toBe(false)
    expect(w.t.sessions.closed).toEqual([session.id])
  })

  test('a populated submodule refuses unless forced', async () => {
    const w = await start()
    const library = makeProject(join(scratch(), 'library'))
    const fix = await create(w, 'with-submodule')
    git(fix.path, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'vendor')
    git(fix.path, 'commit', '-q', '-m', 'add submodule')

    const refused = await removeFailure(w, fix.id)
    expect(refused.data).toMatchObject({ reason: 'submodules' })
    expect(existsSync(fix.path)).toBe(true)
    await remove(w, fix.id, { force: true })
    expect(existsSync(fix.path)).toBe(false)
  })

  test('a symlinked shared directory is not a change and is removed with the worktree', async () => {
    const w = await start({ files: { 'quirky.yaml': 'worktree:\n  sharedDirectories:\n    - node_modules\n' }, ignored: ['node_modules/'] })
    mkdirSync(join(w.repoDir, 'node_modules'))
    writeFileSync(join(w.repoDir, 'node_modules', 'dep.js'), 'x')
    const fix = await create(w, 'linked')
    expect(existsSync(join(fix.path, 'node_modules', 'dep.js'))).toBe(true)

    await remove(w, fix.id)
    expect(existsSync(fix.path)).toBe(false)
    expect(readFileSync(join(w.repoDir, 'node_modules', 'dep.js'), 'utf8')).toBe('x')
  })
})

describe('SC-48: a locked worktree is refused even with force (CLI)', () => {
  test('both refusals carry the lock reason and the unlock command; unlocking lets the delete through', async () => {
    const w = await start()
    const fix = await create(w, 'fix-login')
    git(w.repoDir, 'worktree', 'lock', '--reason', 'ci holds it', fix.path)
    const sentence = `This workspace is locked by Git. Git reported: ci holds it. Run git worktree unlock ${fix.path} from its repository, then retry deletion.`

    const plain = await failure(cliRm(w, 'fix-login'))
    expect(plain.code).toBe(RpcErrorCode.Conflict)
    expect(plain.message).toBe(sentence)
    expect(plain.data).toMatchObject({ reason: 'locked', lockReason: 'ci holds it' })
    const forced = await failure(cliRm(w, 'fix-login', { force: true }))
    expect(forced.message).toBe(sentence)
    expect(existsSync(fix.path)).toBe(true)

    git(w.repoDir, 'worktree', 'unlock', fix.path)
    expect(await cliRm(w, 'fix-login')).toEqual(['removed fix-login'])
    expect(existsSync(fix.path)).toBe(false)
  })
})

describe('SC-49: an unmerged branch is kept and can be deleted later only if it has not moved (CLI)', () => {
  const advance = (w: World, branch: string) => {
    const tree = git(w.repoDir, 'rev-parse', `${branch}^{tree}`)
    const next = git(w.repoDir, 'commit-tree', tree, '-p', branch, '-m', 'later')
    git(w.repoDir, 'update-ref', `refs/heads/${branch}`, next)
    return next
  }

  test('the delete reports the kept branch with its head; delete-branch then removes it', async () => {
    const w = await start()
    const fix = await create(w, 'fix-login')
    commitIn(fix, { 'fix.txt': 'fix\n' })
    const head = git(fix.path, 'rev-parse', 'HEAD')

    const lines = (await cliRm(w, 'fix-login')).join('\n').split('\n')
    expect(lines).toEqual([
      'removed fix-login',
      `kept branch ${fix.branch} at ${head} (not merged); delete it with: quirky wt delete-branch ${w.repo.name} ${fix.branch} --head ${head}`
    ])
    expect(existsSync(fix.path)).toBe(false)
    expect(branches(w)).toContain(fix.branch!)

    const { ctx } = testCliContext(w.t.client, { yes: ['quirky.worktree/deleteBranch'] })
    await commands['delete-branch']!({ positionals: [w.repo.name, fix.branch!], flags: { head } }, ctx)
    expect(branches(w)).not.toContain(fix.branch!)
  })

  test('the API result carries keptBranch', async () => {
    const w = await start()
    const fix = await create(w, 'fix-login')
    commitIn(fix, { 'fix.txt': 'fix\n' })
    const head = git(fix.path, 'rev-parse', 'HEAD')
    expect(await remove(w, fix.id)).toEqual({ ok: true, removed: [fix.id], keptBranch: { name: fix.branch!, head } })
  })

  test('a branch that moved after the delete is refused and stays', async () => {
    const w = await start()
    const fix = await create(w, 'fix-login')
    commitIn(fix, { 'fix.txt': 'fix\n' })
    const head = git(fix.path, 'rev-parse', 'HEAD')
    await remove(w, fix.id)
    const moved = advance(w, fix.branch!)

    const { ctx } = testCliContext(w.t.client, { yes: ['quirky.worktree/deleteBranch'] })
    const refused = await failure(commands['delete-branch']!({ positionals: [w.repo.id, fix.branch!], flags: { head } }, ctx))
    expect(refused.code).toBe(RpcErrorCode.Conflict)
    expect(refused.data).toMatchObject({ reason: 'branch-moved', branch: fix.branch, head: moved })
    expect(branches(w)).toContain(fix.branch!)
  })

  test('deleteBranch is destructive: without yes it asks first and deletes nothing', async () => {
    const w = await start()
    const fix = await create(w, 'fix-login')
    commitIn(fix, { 'fix.txt': 'fix\n' })
    const head = git(fix.path, 'rev-parse', 'HEAD')
    await remove(w, fix.id)
    const asked = await failure(call(w.t.client, 'quirky.worktree/deleteBranch', { repo: w.repo.id, branch: fix.branch!, head }))
    expect(asked.code).toBe(RpcErrorCode.ConfirmationRequired)
    expect(asked.data).toMatchObject({ action: `Delete branch ${fix.branch}?` })
    expect(branches(w)).toContain(fix.branch!)
  })

  test('a branch checked out in a worktree is never deleted', async () => {
    const w = await start()
    const fix = await create(w, 'busy')
    const head = git(fix.path, 'rev-parse', 'HEAD')
    const refused = await failure(call(w.t.client, 'quirky.worktree/deleteBranch', { repo: w.repo.id, branch: fix.branch!, head, yes: true }))
    expect(refused.data).toMatchObject({ reason: 'branch-checked-out', branch: fix.branch })
    expect(branches(w)).toContain(fix.branch!)
  })
})

describe('SC-50: a squash-merged branch is deleted (CLI)', () => {
  test('git branch -d refuses it, the tree check accepts it, and nothing is reported kept', async () => {
    const w = await start()
    const fix = await create(w, 'fix-login')
    commitIn(fix, { 'one.txt': '1\n' })
    commitIn(fix, { 'two.txt': '2\n' })
    git(w.repoDir, 'merge', '--squash', fix.branch!)
    git(w.repoDir, 'commit', '-q', '-m', 'squash fix-login')
    git(w.repoDir, 'push', '-q', 'origin', 'main')
    expect(Bun.spawnSync(['git', 'branch', '-d', '--', fix.branch!], { cwd: w.repoDir, env: process.env }).exitCode).not.toBe(0)

    const result = await remove(w, fix.id)
    expect(result.keptBranch).toBeUndefined()
    expect(branches(w)).not.toContain(fix.branch!)
  })
})

describe('SC-51: a reused branch is kept on delete (CLI)', () => {
  test('the worktree is gone and the branch still exists at the same commit', async () => {
    const w = await start()
    git(w.repoDir, 'branch', 'feat/passing')
    const head = git(w.repoDir, 'rev-parse', 'feat/passing')
    const reused = await create(w, 'feat-passing', { branch: 'feat/passing' })
    expect(reused.keepBranch).toBe(true)

    expect(await cliRm(w, 'feat-passing')).toEqual(['removed feat-passing'])
    expect(existsSync(reused.path)).toBe(false)
    expect(git(w.repoDir, 'rev-parse', 'feat/passing')).toBe(head)
  })
})

describe('SC-52: the archive hook runs before a delete and its failure stops it (CLI)', () => {
  test('a script that works runs first; a failing one stops the delete unless allowed, and skip runs nothing', async () => {
    const w = await start()
    const log = scratchFile('archived.txt')
    const x = await create(w, 'x')
    const y = await create(w, 'y')
    const z = await create(w, 'z')
    const yShell = await shell(w, y)

    await setArchive(w, `echo "$QUIRKY_WORKTREE_PATH" >> ${log}`)
    await cliRm(w, 'x')
    expect(readFileSync(log, 'utf8')).toBe(`${x.path}\n`)
    expect(existsSync(x.path)).toBe(false)

    await setArchive(w, `echo "$QUIRKY_WORKTREE_PATH" >> ${log}; echo boom; exit 1`)
    const first = await failure(cliRm(w, 'y'))
    expect(first.code).toBe(RpcErrorCode.Conflict)
    expect(first.data).toMatchObject({ reason: 'archive-hook-failed', exitCode: 1 })
    expect(String(first.data.output)).toContain('boom')
    const second = await failure(cliRm(w, 'y', { force: true }))
    expect(second.data).toMatchObject({ reason: 'archive-hook-failed' })
    expect(existsSync(y.path)).toBe(true)
    expect(w.t.sessions.sessions.map((s) => s.id)).toEqual([yShell.id])

    await cliRm(w, 'y', { 'allow-failed-archive-hook': true })
    expect(existsSync(y.path)).toBe(false)
    expect(w.t.sessions.closed).toEqual([yShell.id])

    const lines = readFileSync(log, 'utf8').trim().split('\n')
    await cliRm(w, 'z', { 'skip-archive': true })
    expect(existsSync(z.path)).toBe(false)
    expect(readFileSync(log, 'utf8').trim().split('\n')).toEqual(lines)
    expect(lines).toHaveLength(4)
  })

  test('the hook runs with the hook environment in the worktree', async () => {
    const w = await start()
    const out = scratchFile('env.txt')
    const x = await create(w, 'x')
    await setArchive(w, `echo "$QUIRKY_ROOT_PATH|$QUIRKY_WORKTREE_PATH|$QUIRKY_WORKSPACE_NAME|$(pwd -P)" > ${out}`)
    await remove(w, x.id)
    expect(readFileSync(out, 'utf8').trim()).toBe(`${w.repoDir}|${x.path}|x|${x.path}`)
  })

  test('an untrusted shared archive script is refused until trusted; skipping it works', async () => {
    const marker = scratchFile('shared-ran')
    const w = await start({ files: { 'quirky.yaml': `scripts:\n  archive: "touch ${marker}"\n` } })
    await call(w.t.client, 'quirky.repo/set', { repo: w.repo.id, commandSource: 'shared-only' })
    const a = await create(w, 'a', { base: 'main' })
    const b = await create(w, 'b', { base: 'main' })

    const refused = await removeFailure(w, a.id)
    expect(refused.code).toBe(RpcErrorCode.Conflict)
    expect(refused.data).toMatchObject({ reason: 'hooks-untrusted', kind: 'archive', source: 'quirky.yaml', script: `touch ${marker}` })
    expect(refused.message).toContain('quirky repo trust-hooks')
    expect(existsSync(a.path)).toBe(true)
    expect(existsSync(marker)).toBe(false)

    await remove(w, a.id, { skipArchive: true })
    expect(existsSync(a.path)).toBe(false)
    expect(existsSync(marker)).toBe(false)

    await call(w.t.client, 'quirky.repo/trustHooks', { repo: w.repo.id, kind: 'archive' })
    await remove(w, b.id)
    expect(existsSync(b.path)).toBe(false)
    expect(existsSync(marker)).toBe(true)
  })
})

describe('SC-53: a parent is deleted only with its descendants (CLI)', () => {
  async function chain(w: World) {
    const a = await create(w, 'a')
    const b = await create(w, 'b', { parent: a.id })
    const c = await create(w, 'c', { parent: b.id })
    return { a, b, c }
  }

  test('without the flag the refusal names the descendants; with it they go deepest first', async () => {
    const w = await start()
    const { a, b, c } = await chain(w)

    const refused = await failure(cliRm(w, 'a'))
    expect(refused.code).toBe(RpcErrorCode.Conflict)
    expect(refused.data).toMatchObject({ reason: 'has-descendants', descendants: [b.id, c.id] })
    expect(refused.message).toContain('b')
    expect(refused.message).toContain('c')
    expect(existsSync(a.path)).toBe(true)

    const result = JSON.parse((await cliRm(w, 'a', { 'with-descendants': true }, true))[0]!) as WorktreeRemoveResult
    expect(result).toEqual({ ok: true, removed: [c.id, b.id, a.id] })
    for (const worktree of [a, b, c]) expect(existsSync(worktree.path)).toBe(false)
  })

  test('the first failure stops the run and names what was already removed', async () => {
    const w = await start()
    const { a, b, c } = await chain(w)
    writeFileSync(join(b.path, 'dirty.txt'), 'x')

    const refused = await removeFailure(w, a.id, { withDescendants: true })
    expect(refused.data).toMatchObject({ reason: 'dirty', removed: [c.id] })
    expect(existsSync(c.path)).toBe(false)
    expect(existsSync(b.path)).toBe(true)
    expect(existsSync(a.path)).toBe(true)
  })

  test('a primary checkout assigned a parent refuses the whole run up front', async () => {
    const w = await start()
    const a = await create(w, 'a')
    const b = await create(w, 'b', { parent: a.id })
    const [primary] = await listWorktrees(w.t.client, { repo: w.repo.id })
    await call(w.t.client, 'quirky.worktree/set', { worktree: primary!.id, parent: a.id })
    const session = await shell(w, primary!)

    const refused = await removeFailure(w, a.id, { withDescendants: true, force: true })
    expect(refused.data).toMatchObject({ reason: 'primary' })
    expect(refused.message).toContain(primary!.name)
    expect(existsSync(w.repoDir)).toBe(true)
    expect(existsSync(a.path)).toBe(true)
    expect(existsSync(b.path)).toBe(true)
    const after = await listWorktrees(w.t.client, { repo: w.repo.id })
    expect(after.find((worktree) => worktree.id === primary!.id)?.parentId).toBe(a.id)
    const sessions = (await call(w.t.client, 'quirky.session/list', {})) as { id: string }[]
    expect(sessions.map((open) => open.id)).toContain(session.id)
  })

  test('describeRemove names the target, its descendants and what force discards', async () => {
    const w = await start()
    const { a } = await chain(w)
    const text = async (params: Record<string, unknown>) => (await call(w.t.client, 'quirky.worktree/describeRemove', { worktree: a.id, ...params })) as string
    expect(await text({})).toBe(`Remove worktree a (${a.path})?`)
    expect(await text({ withDescendants: true })).toContain('b, c')
    expect(await text({ force: true })).toContain('discarding uncommitted changes')
    expect(await text({})).not.toContain('discarding')
  })
})

describe('SC-54: orphaned worktrees are cleaned or refused (CLI)', () => {
  /** Makes git forget a worktree while its folder stays, by deleting its administrative directory. */
  const forget = (worktree: Worktree) => rmSync(git(worktree.path, 'rev-parse', '--absolute-git-dir'), { recursive: true, force: true })

  test('a worktree whose folder was deleted by hand is pruned, its branch handled and no archive runs', async () => {
    const w = await start()
    const marker = scratchFile('archive-ran')
    await setArchive(w, `touch ${marker}`)
    const gone = await create(w, 'gone')
    rmSync(gone.path, { recursive: true, force: true })
    expect(await listIds(w)).not.toContain(gone.id)

    expect(await cliRm(w, gone.id)).toEqual([`removed ${gone.id}`])
    expect(registered(w)).not.toContain(gone.path)
    expect(branches(w)).not.toContain(gone.branch!)
    expect(storedRows(w.t.h.home, 'id = ?', gone.id)).toHaveLength(0)
    expect(existsSync(marker)).toBe(false)
  })

  test('a worktree git forgot is refused, then deleted by force inside the folder it was created under', async () => {
    const w = await start()
    const forgot = await create(w, 'forgot')
    forget(forgot)
    expect(await listIds(w)).not.toContain(forgot.id)
    expect(storedRows(w.t.h.home, 'id = ?', forgot.id)).toHaveLength(1)

    const refused = await failure(cliRm(w, forgot.id))
    expect(refused.code).toBe(RpcErrorCode.Conflict)
    expect(refused.message).toBe('Git already forgot this workspace, but its directory is still on disk. Use Force Delete to remove the orphaned directory.')
    expect(refused.data).toMatchObject({ reason: 'orphaned', path: forgot.path })
    expect(existsSync(forgot.path)).toBe(true)

    await call(w.t.client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: realpathSync(makeTempDir('qw-')) })
    await cliRm(w, forgot.id, { force: true })
    expect(existsSync(forgot.path)).toBe(false)
    expect(storedRows(w.t.h.home, 'id = ?', forgot.id)).toHaveLength(0)
  })

  test('a folder recreated at the old path by something else is refused even by force', async () => {
    const w = await start()
    const forgot = await create(w, 'forgot')
    forget(forgot)
    rmSync(forgot.path, { recursive: true, force: true })
    await Bun.sleep(25)
    mkdirSync(forgot.path, { recursive: true })
    writeFileSync(join(forgot.path, 'theirs.txt'), 'x')

    const refused = await removeFailure(w, forgot.id, { force: true })
    expect(refused.data).toMatchObject({ reason: 'unregistered' })
    expect(readFileSync(join(forgot.path, 'theirs.txt'), 'utf8')).toBe('x')
    expect(storedRows(w.t.h.home, 'id = ?', forgot.id)).toHaveLength(1)
  })

  test('a row with no recorded birth time is not force-deleted', async () => {
    const w = await start()
    const forgot = await create(w, 'forgot')
    forget(forgot)
    const db = new (await import('bun:sqlite')).Database(join(w.t.h.home, 'plugin-data', 'quirky.worktree', 'store.db'))
    db.run('UPDATE worktrees SET birthtime = NULL WHERE id = ?', [forgot.id])
    db.close()

    const refused = await removeFailure(w, forgot.id, { force: true })
    expect(refused.data).toMatchObject({ reason: 'unregistered' })
    expect(existsSync(forgot.path)).toBe(true)
  })

  test('a folder Quirky never made is refused and left alone', async () => {
    const w = await start()
    const other = join(scratch(), 'other')
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, 'keep.txt'), 'x')

    const refused = await removeFailure(w, `path:${other}`, { force: true })
    expect(refused.data).toMatchObject({ reason: 'unregistered', path: realpathSync(other) })
    expect(readFileSync(join(other, 'keep.txt'), 'utf8')).toBe('x')
  })

  test('a worktree Quirky found rather than made is never force-deleted', async () => {
    const w = await start()
    const external = addExternalWorktree(w.repoDir, join(scratch(), 'external'), 'ext')
    await listIds(w)
    expect(storedRows(w.t.h.home, 'id = ?', worktreeIdForPath(external))[0]).toMatchObject({ created_root: null })
    rmSync(join(external, '.git'))
    rmSync(join(w.repoDir, '.git', 'worktrees', basename(external)), { recursive: true, force: true })

    const refused = await removeFailure(w, worktreeIdForPath(external), { force: true })
    expect(refused.data).toMatchObject({ reason: 'unregistered', path: external })
    expect(existsSync(external)).toBe(true)
  })

  test('a row whose folder is not inside its created root is not deleted either', async () => {
    const w = await start()
    const forgot = await create(w, 'forgot')
    forget(forgot)
    const elsewhere = join(scratch(), 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    const db = new (await import('bun:sqlite')).Database(join(w.t.h.home, 'plugin-data', 'quirky.worktree', 'store.db'))
    db.run('UPDATE worktrees SET created_root = ? WHERE id = ?', [elsewhere, forgot.id])
    db.close()

    const refused = await removeFailure(w, forgot.id, { force: true })
    expect(refused.data).toMatchObject({ reason: 'unregistered' })
    expect(existsSync(forgot.path)).toBe(true)
  })
})

describe('SC-55: concurrent deletes share one run (API)', () => {
  test('equal options join, different options are refused, and the list shows removing', async () => {
    const w = await start()
    const counter = scratchFile('runs.txt')
    const fix = await create(w, 'fix-login')
    await setArchive(w, `echo run >> ${counter}; sleep 1`)
    const other = await w.t.connectAs({})

    const first = remove(w, fix.id)
    const listed = await waitForAsync(async () => (await listWorktrees(w.t.client, { repo: w.repo.id })).find((worktree) => worktree.id === fix.id)?.removing === true && true, 5000)
    expect(listed).toBe(true)
    const second = other.callAny('quirky.worktree/remove', { worktree: fix.id, yes: true }) as Promise<WorktreeRemoveResult>
    const third = await failure(call(w.t.client, 'quirky.worktree/remove', { worktree: fix.id, yes: true, force: true }))
    expect(third.code).toBe(RpcErrorCode.Conflict)
    expect(third.message).toBe('Worktree deletion already in progress')
    expect(third.data).toMatchObject({ reason: 'deletion-in-progress' })
    const during = (await listWorktrees(other, { repo: w.repo.id })).find((worktree) => worktree.id === fix.id)
    expect(during?.removing).toBe(true)

    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(b)
    expect(readFileSync(counter, 'utf8').trim().split('\n')).toEqual(['run'])
    expect(existsSync(fix.path)).toBe(false)
    expect(await listIds(w)).not.toContain(fix.id)
  })

  test('removing is false again once the delete has failed', async () => {
    const w = await start()
    const fix = await create(w, 'fix-login')
    writeFileSync(join(fix.path, 'x.txt'), 'x')
    await removeFailure(w, fix.id)
    const listed = (await listWorktrees(w.t.client, { repo: w.repo.id })).find((worktree) => worktree.id === fix.id)
    expect(listed?.removing).toBe(false)
    await remove(w, fix.id, { force: true })
  })
})

describe('SC-56: a delete is finished when it returns (API)', () => {
  test('killing the daemon right after the call leaves nothing behind', async () => {
    const w = await start()
    const fix = await create(w, 'fix-login')
    await remove(w, fix.id)
    await w.t.restart()

    expect(existsSync(fix.path)).toBe(false)
    expect(registered(w)).not.toContain(fix.path)
    expect(branches(w)).not.toContain(fix.branch!)
    expect(storedRows(w.t.h.home, 'id = ?', fix.id)).toHaveLength(0)
    const after = await listWorktrees(w.t.client, { repo: w.repo.id })
    expect(after.map((worktree) => worktree.id)).not.toContain(fix.id)
    expect(after.some((worktree) => worktree.removing)).toBe(false)
  })
})

describe('closing sessions', () => {
  test('a session that will not close stops the delete, and force carries on and reports it', async () => {
    const w = await start()
    const fix = await create(w, 'fix-login')
    const session = await shell(w, fix)
    w.t.sessions.closeError = 'pty host unavailable'

    const refused = await removeFailure(w, fix.id)
    expect(refused.code).toBe(RpcErrorCode.Conflict)
    expect(refused.message).toContain('pty host unavailable')
    expect(existsSync(fix.path)).toBe(true)

    const result = await remove(w, fix.id, { force: true })
    expect(existsSync(fix.path)).toBe(false)
    expect(result.sessionErrors).toHaveLength(1)
    expect(result.sessionErrors![0]).toContain(session.id)
  })
})

describe('SC-59: the primary checkout cannot be deleted (API)', () => {
  test('a git project primary and a folder project primary both refuse', async () => {
    const w = await start()
    const [primary] = await listWorktrees(w.t.client, { repo: w.repo.id })
    const refused = await removeFailure(w, primary!.id)
    expect(refused.code).toBe(RpcErrorCode.Conflict)
    expect(refused.message).toBe('the primary worktree cannot be deleted; remove the project instead')
    expect(refused.data).toMatchObject({ reason: 'primary' })
    expect(existsSync(w.repoDir)).toBe(true)

    const notesDir = join(scratch(), 'notes')
    mkdirSync(notesDir, { recursive: true })
    const notes = (await call(w.t.client, 'quirky.repo/add', { path: notesDir, folder: true })) as Repo
    const [folderPrimary] = await listWorktrees(w.t.client, { repo: notes.id })
    expect((await removeFailure(w, folderPrimary!.id, { force: true })).data).toMatchObject({ reason: 'primary' })
  })
})

describe('SC-12 and SC-11 (delete): folder workspaces', () => {
  test('SC-12: removing drafts forgets it, closes its shell and leaves notes.txt', async () => {
    const w = await start()
    const dir = join(scratch(), 'notes')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'notes.txt'), 'hello\n')
    const notesDir = realpathSync(dir)
    const notes = (await call(w.t.client, 'quirky.repo/add', { path: notesDir, folder: true })) as Repo
    const drafts = ((await call(w.t.client, 'quirky.worktree/create', { repo: notes.id, name: 'drafts' })) as WorktreeCreateResult).worktree
    const session = await shell(w, drafts)

    expect(await cliRm(w, 'drafts')).toEqual(['removed drafts'])
    expect(w.t.sessions.closed).toEqual([session.id])
    expect((await listWorktrees(w.t.client, { repo: notes.id })).map((worktree) => worktree.name)).toEqual(['notes'])
    expect(readdirSync(notesDir)).toEqual(['notes.txt'])
    expect(storedRows(w.t.h.home, 'id = ?', drafts.id)).toHaveLength(0)
  })

  test('SC-11: deleting a group workspace forgets it and leaves every file in the parent folder', async () => {
    const w = await start()
    const parent = join(scratch(), 'apps')
    mkdirSync(join(parent, 'sub'), { recursive: true })
    writeFileSync(join(parent, 'a.txt'), 'a')
    const apps = (await call(w.t.client, 'quirky.repo/groupCreate', { name: 'apps', parentPath: parent })) as ProjectGroup
    const root = ((await call(w.t.client, 'quirky.worktree/create', { group: 'apps', name: 'apps-root' })) as WorktreeCreateResult).worktree
    expect(root).toMatchObject({ kind: 'folder', groupId: apps.id })
    await shell(w, root)

    const result = await remove(w, root.id)
    expect(result).toEqual({ ok: true, removed: [root.id] })
    expect(await listWorktrees(w.t.client, { group: 'apps' })).toEqual([])
    expect(readdirSync(parent).sort()).toEqual(['a.txt', 'sub'])
    expect(w.t.sessions.sessions).toEqual([])
  })
})

describe('SC-61: the new methods and commands are listed with schemas', () => {
  test('api.describe has the worktree and repo surface', async () => {
    const w = await start()
    const api = (await call(w.t.client, 'api.describe')) as ApiDescription
    const method = (name: string) => api.methods.find((entry) => entry.name === name)!
    for (const name of ['set', 'show', 'suggestName', 'deleteBranch', 'create', 'remove']) expect(method(`quirky.worktree/${name}`)).toBeDefined()
    expect(method('quirky.worktree/deleteBranch')).toMatchObject({ destructive: true, confirm: 'Delete branch {branch}?' })
    expect(Object.keys(method('quirky.worktree/deleteBranch').params.properties!).sort()).toEqual(['branch', 'head', 'repo'])
    expect(method('quirky.worktree/remove')).toMatchObject({ destructive: true })
    expect(Object.keys(method('quirky.worktree/remove').params.properties!).sort()).toEqual(['allowFailedArchiveHook', 'force', 'skipArchive', 'withDescendants', 'worktree'])
    expect(Object.keys(method('quirky.worktree/remove').result.properties!).sort()).toEqual(['keptBranch', 'ok', 'removed', 'sessionErrors'])
    expect(method('quirky.worktree/create').params.properties).toHaveProperty('createdBy')
    for (const name of ['clone', 'create', 'scan', 'import', 'set', 'show', 'trustHooks', 'groupList']) expect(method(`quirky.repo/${name}`).params).toBeDefined()

    const words = (plugin: string) => api.cli.commands.filter((command) => command.plugin === plugin).map((command) => command.words)
    expect(words('quirky.worktree')).toEqual(expect.arrayContaining(['worktree list', 'worktree create', 'worktree set', 'worktree show', 'worktree rm', 'worktree delete-branch']))
    expect(words('quirky.repo')).toEqual(expect.arrayContaining(['repo clone', 'repo create', 'repo scan', 'repo import', 'repo set', 'repo show', 'repo trust-hooks', 'repo group list']))
    const rm = api.cli.commands.find((command) => command.plugin === 'quirky.worktree' && command.words === 'worktree rm')!
    expect(rm.flags.map((flag) => flag.name).sort()).toEqual(['allow-failed-archive-hook', 'force', 'skip-archive', 'with-descendants'])
    const deleteBranch = api.cli.commands.find((command) => command.plugin === 'quirky.worktree' && command.words === 'worktree delete-branch')!
    expect(deleteBranch.positionals.map((positional) => positional.name)).toEqual(['repo', 'branch'])
    expect(deleteBranch.flags.map((flag) => flag.name)).toEqual(['head'])
  })
})

describe('unresolvable targets', () => {
  test('an unknown worktree is NotFound and a symlinked path form still resolves', async () => {
    const w = await start()
    const missing = await removeFailure(w, 'no-such-worktree')
    expect(missing.code).toBe(RpcErrorCode.NotFound)

    const fix = await create(w, 'fix-login')
    const link = scratchFile('link')
    symlinkSync(fix.path, link)
    await remove(w, `path:${link}`)
    expect(existsSync(fix.path)).toBe(false)
  })
})

describe('the rm and delete-branch commands', () => {
  test('rm sends each flag as its remove param', async () => {
    const w = await start()
    await create(w, 'feature-x')
    const { ctx } = testCliContext(w.t.client, { yes: ['quirky.worktree/remove'] })
    const sent: [string, Record<string, unknown>][] = []
    const spy = { ...ctx, call: (method: string, params?: Record<string, unknown>) => (sent.push([method, params ?? {}]), ctx.call(method, params)) }
    await commands.rm!({ positionals: ['feature-x'], flags: { force: true, 'with-descendants': true, 'skip-archive': true, 'allow-failed-archive-hook': true } }, spy)
    expect(sent.find(([method]) => method === 'quirky.worktree/remove')![1]).toEqual({
      worktree: 'feature-x',
      force: true,
      withDescendants: true,
      skipArchive: true,
      allowFailedArchiveHook: true
    })
  })

  test('delete-branch needs --head', async () => {
    const w = await start()
    const { ctx } = testCliContext(w.t.client, { yes: ['quirky.worktree/deleteBranch'] })
    await expect(commands['delete-branch']!({ positionals: [w.repo.name, 'any'], flags: {} }, ctx)).rejects.toThrow(/usage: --head is required/)
  })
})
