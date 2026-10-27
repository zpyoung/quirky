import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type ProjectGroup, type Repo, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { call, failure, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { testCliContext } from '../../quirky.repo/test/harness'
import { commands } from '../cli'
import { worktreeIdForPath } from '../paths'
import { MARINE_NAMES } from '../src/daemon/names'
import { listWorktrees, startRealProject, storedRows, type RealProject } from './fixtures/real-project'

const { scratch } = isolateGitConfig()
let p: RealProject | undefined
afterEach(async () => {
  await p?.t.cleanup()
  p = undefined
})

/** A folder project `notes` holding `notes.txt`, next to the git repository `api` the harness added. */
async function startFolderProject() {
  p = await startRealProject(scratch)
  const dir = join(scratch(), 'notes')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'notes.txt'), 'hello\n')
  const notesDir = realpathSync(dir)
  const notes = (await call(p.client, 'quirky.repo/add', { path: notesDir, folder: true })) as Repo
  return { ...p, notesDir, notes }
}

describe('SC-12: a folder project lists its primary and creates folder workspaces (CLI)', () => {
  test('the primary is synthesised: kind folder, no branch, named for the folder, first in the list', async () => {
    const { client, notes, notesDir } = await startFolderProject()
    const listed = await listWorktrees(client, { repo: notes.id })
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      id: worktreeIdForPath(notesDir),
      repoId: notes.id,
      path: notesDir,
      kind: 'folder',
      branch: null,
      head: '',
      isMain: true,
      name: 'notes',
      status: 'in-progress',
      createdBy: 'external',
      groupId: null
    })
  })

  test('creating drafts adds a second workspace on the same folder and touches no file', async () => {
    const { client, notes, notesDir } = await startFolderProject()
    const { ctx, lines } = testCliContext(client)
    // D-CLI: the CLI passes createdBy cli, so a workspace made through it is attributed to the CLI
    await commands.create!({ positionals: ['notes', 'drafts'], flags: {} }, ctx)
    expect(lines[0]).toMatch(new RegExp(`^id: wt_[0-9a-f]{12}\\nname: drafts\\nbranch: -\\npath: ${notesDir}$`))

    const [primary, drafts] = await listWorktrees(client, { repo: notes.id })
    expect(primary!.isMain).toBe(true)
    expect(drafts).toMatchObject({ repoId: notes.id, path: notesDir, kind: 'folder', branch: null, head: '', isMain: false, name: 'drafts', createdBy: 'cli', status: 'in-progress' })
    expect(drafts!.id).not.toBe(primary!.id)
    expect(drafts!.id).toMatch(/^wt_[0-9a-f]{12}$/)
    expect(readdirSync(notesDir)).toEqual(['notes.txt'])
  })

  test('a name is sanitised, a blank name takes a generated one that is not handed out twice, a bad name is refused', async () => {
    const { client, notes, notesDir } = await startFolderProject()
    const create = (params: Record<string, unknown>) => call(client, 'quirky.worktree/create', { repo: notes.id, ...params }).then((made) => (made as WorktreeCreateResult).worktree)
    expect((await create({ name: 'My Drafts!' })).name).toBe('My-Drafts')

    const first = await create({})
    const second = await create({ name: '  ' })
    for (const worktree of [first, second]) expect(MARINE_NAMES).toContain(worktree.name)
    expect(first.name).not.toBe(second.name)
    expect(storedRows(p!.t.h.home, 'repo_id = ?', notes.id).length).toBe(4)

    const refused = await failure(create({ name: '...' }))
    expect(refused).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'Invalid worktree name', data: { reason: 'invalid-name' } })
    expect(readdirSync(notesDir)).toEqual(['notes.txt'])
  })

  test('a workspace is found by its name, not by the shared folder name', async () => {
    const { client, notes, notesDir } = await startFolderProject()
    const drafts = ((await call(client, 'quirky.worktree/create', { repo: notes.id, name: 'drafts' })) as WorktreeCreateResult).worktree
    const resolve = async (selector: string) => ((await call(client, 'quirky.worktree/resolve', { selector })) as Worktree).id
    expect(await resolve('drafts')).toBe(drafts.id)
    expect(await resolve('name:notes')).toBe(worktreeIdForPath(notesDir))
    expect(await resolve('notes')).toBe(worktreeIdForPath(notesDir))
  })

  test('metadata can be set on the primary and on a folder workspace', async () => {
    const { client, notes } = await startFolderProject()
    const drafts = ((await call(client, 'quirky.worktree/create', { repo: notes.id, name: 'drafts' })) as WorktreeCreateResult).worktree
    await call(client, 'quirky.worktree/set', { worktree: 'notes', status: 'todo' })
    await call(client, 'quirky.worktree/set', { worktree: drafts.id, displayName: 'My drafts', parent: 'notes' })
    const [primary, second] = await listWorktrees(client, { repo: notes.id })
    expect(primary).toMatchObject({ status: 'todo', name: 'notes' })
    expect(second).toMatchObject({ name: 'My drafts', displayName: 'My drafts', parentId: primary!.id })
  })

  test('removing the project drops its folder workspaces', async () => {
    const { client, notes, t } = await startFolderProject()
    await call(client, 'quirky.worktree/create', { repo: notes.id, name: 'drafts' })
    expect(storedRows(t.h.home, 'repo_id = ?', notes.id).length).toBeGreaterThan(0)
    await call(client, 'quirky.repo/remove', { repo: notes.id })
    await waitFor(() => (storedRows(t.h.home, 'repo_id = ?', notes.id).length === 0 ? true : undefined))
  })
})

describe('SC-11: a group can hold a folder workspace on its parent folder (CLI)', () => {
  async function startApps() {
    p = await startRealProject(scratch)
    const appsDir = join(scratch(), 'apps')
    mkdirSync(appsDir, { recursive: true })
    const apps = (await call(p.client, 'quirky.repo/groupCreate', { name: 'apps', parentPath: realpathSync(appsDir) })) as ProjectGroup
    return { ...p, apps, appsDir: realpathSync(appsDir) }
  }

  test('create --group makes a folder workspace on the parent folder, listed with the group and in the full list', async () => {
    const { client, apps, appsDir } = await startApps()
    const created = ((await call(client, 'quirky.worktree/create', { group: 'apps', name: 'apps-root' })) as WorktreeCreateResult).worktree
    expect(created).toMatchObject({
      repoId: `group:${apps.id}`,
      groupId: apps.id,
      path: appsDir,
      kind: 'folder',
      branch: null,
      head: '',
      isMain: false,
      name: 'apps-root',
      createdBy: 'api'
    })
    expect(readdirSync(appsDir)).toEqual([])

    expect(await listWorktrees(client, { group: 'apps' })).toEqual([created])
    expect(await listWorktrees(client, { group: apps.id })).toEqual([created])
    expect((await listWorktrees(client)).map((w) => w.id)).toContain(created.id)
    expect((await listWorktrees(client, { repo: 'api' })).map((w) => w.id)).not.toContain(created.id)
  })

  test('list --group through the CLI prints the workspace', async () => {
    const { client, appsDir } = await startApps()
    await call(client, 'quirky.worktree/create', { group: 'apps', name: 'apps-root' })
    const { ctx, lines } = testCliContext(client)
    await commands.list!({ positionals: [], flags: { group: 'apps' } }, ctx)
    const rows = lines[0]!.split('\n')
    expect(rows[0]).toMatch(/^ID\s+NAME\s+BRANCH\s+STATUS\s+PATH$/)
    expect(rows[1]).toMatch(new RegExp(`^wt_[0-9a-f]{12}\\s+apps-root\\s+-\\s+in-progress\\s+${appsDir}$`))
  })

  test('a group without a parent folder refuses create', async () => {
    const { client } = await startApps()
    await call(client, 'quirky.repo/groupCreate', { name: 'loose' })
    expect(await failure(call(client, 'quirky.worktree/create', { group: 'loose', name: 'x' }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'group loose has no parent folder'
    })
    expect((await failure(call(client, 'quirky.worktree/create', { group: 'nope', name: 'x' }))).code).toBe(RpcErrorCode.NotFound)
    expect((await failure(call(client, 'quirky.worktree/create', { group: 'apps', repo: 'api', name: 'x' }))).code).toBe(RpcErrorCode.InvalidParams)
  })

  test('deleting the group drops its workspaces from the list and the store', async () => {
    const { client, t, apps } = await startApps()
    const created = ((await call(client, 'quirky.worktree/create', { group: 'apps', name: 'apps-root' })) as WorktreeCreateResult).worktree
    await call(client, 'quirky.worktree/set', { worktree: created.id, comment: 'kept while the group lives' })
    expect(storedRows(t.h.home, 'group_id = ?', apps.id)).toHaveLength(1)

    await call(client, 'quirky.repo/groupDelete', { group: apps.id })
    await waitFor(() => (storedRows(t.h.home, 'group_id = ?', apps.id).length === 0 ? true : undefined))
    expect((await listWorktrees(client)).map((w) => w.id)).not.toContain(created.id)
  })

  test('a group workspace survives other repo events while its group exists', async () => {
    const { client, t, apps } = await startApps()
    const created = ((await call(client, 'quirky.worktree/create', { group: 'apps', name: 'apps-root' })) as WorktreeCreateResult).worktree
    await call(client, 'quirky.repo/groupCreate', { name: 'another' })
    await Bun.sleep(100)
    expect(storedRows(t.h.home, 'group_id = ?', apps.id)).toHaveLength(1)
    expect((await listWorktrees(client, { group: 'apps' })).map((w) => w.id)).toEqual([created.id])
  })

  test('a create from inside a workspace of the group nests under that workspace', async () => {
    const { client, t, apps } = await startApps()
    const first = ((await call(client, 'quirky.worktree/create', { group: 'apps', name: 'apps-root' })) as WorktreeCreateResult).worktree
    const inside = await t.connectAs({ worktreeId: first.id })

    const nested = ((await call(inside, 'quirky.worktree/create', { group: 'apps', name: 'nested' })) as WorktreeCreateResult).worktree
    expect(nested).toMatchObject({ groupId: apps.id, parentId: first.id })
    const implied = ((await call(inside, 'quirky.worktree/create', { name: 'implied' })) as WorktreeCreateResult).worktree
    expect(implied).toMatchObject({ groupId: apps.id, parentId: first.id })
    const detached = ((await call(inside, 'quirky.worktree/create', { group: 'apps', name: 'detached', noParent: true })) as WorktreeCreateResult).worktree
    expect(detached.parentId).toBeNull()
  })

  test('a folder workspace is named by its folder name after its display name changes; a shared folder is ambiguous', async () => {
    const { client, apps, appsDir } = await startApps()
    const first = ((await call(client, 'quirky.worktree/create', { group: 'apps', name: 'apps-root' })) as WorktreeCreateResult).worktree
    await call(client, 'quirky.worktree/set', { worktree: first.id, displayName: 'Root of apps' })
    const folderName = appsDir.split('/').at(-1)!
    const resolve = async (selector: string) => ((await call(client, 'quirky.worktree/resolve', { selector })) as Worktree).id
    for (const selector of [folderName, `name:${folderName}`]) expect(await resolve(selector)).toBe(first.id)

    const second = ((await call(client, 'quirky.worktree/create', { group: 'apps', name: 'second', noParent: true })) as WorktreeCreateResult).worktree
    expect(second.groupId).toBe(apps.id)
    const ambiguous = await failure(call(client, 'quirky.worktree/resolve', { selector: folderName }))
    expect(ambiguous.code).toBe(RpcErrorCode.Conflict)
    expect([...(ambiguous.data as { matches: string[] }).matches].sort()).toEqual([`id:${first.id}`, `id:${second.id}`].sort())
  })
})
