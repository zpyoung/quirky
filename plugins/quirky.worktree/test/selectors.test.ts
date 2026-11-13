import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RpcError, RpcErrorCode, type ProjectGroup, type QuirkyClient, type Repo, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import { addFakeRepo, fakeRegistrations } from './fixtures/fake-git'

let t: PluginHarness | undefined
afterEach(async () => {
  await t?.cleanup()
  t = undefined
})

const call = (client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params)

async function failure(promise: Promise<unknown>): Promise<{ code: number; message: string; data: unknown }> {
  try {
    await promise
  } catch (error) {
    const rpc = error as RpcError
    return { code: rpc.code, message: rpc.message, data: rpc.data }
  }
  throw new Error('expected the call to fail')
}

/** Repo api with worktrees main and fix-login, under a real root so path selectors compare real paths. */
async function apiRepo() {
  t = await startPluginHarness()
  const root = realpathSync(makeTempDir('qs-'))
  await call(t.client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  fakeRegistrations(t.git!)
  const apiDir = addFakeRepo(t.git!, 'api')
  const repo = (await call(t.client, 'quirky.repo/add', { path: apiDir })) as Repo
  const fixLogin = ((await call(t.client, 'quirky.worktree/create', { repo: repo.id, name: 'fix-login' })) as WorktreeCreateResult).worktree
  mkdirSync(join(fixLogin.path, 'src'), { recursive: true })
  const [main] = (await call(t.client, 'quirky.worktree/list', { repo: repo.id })) as Worktree[]
  return { t, root, repo, apiDir, main: main!, fixLogin }
}

async function selectorFixture() {
  const project = await apiRepo()
  const webDir = addFakeRepo(project.t.git!, 'web')
  const webRepo = (await call(project.t.client, 'quirky.repo/add', { path: webDir })) as Repo
  const worktrees = (await call(project.t.client, 'quirky.worktree/list')) as Worktree[]
  const fixLoginRecord = worktrees.find((worktree) => worktree.id === project.fixLogin.id)!
  const webMain = worktrees.find((worktree) => worktree.repoId === webRepo.id)!
  const mark = () => project.t.git!.calls.length
  const listed = (from: number) =>
    project.t.git!.calls
      .slice(from)
      .filter(({ fn }) => fn === 'listRegistrations')
      .map(({ args }) => args[0] as string)
      .sort()
  return { ...project, webDir, webRepo, worktrees, fixLoginRecord, webMain, mark, listed }
}

describe('SC-7: a worktree selector resolves by each form', () => {
  test('from a cwd inside fix-login', async () => {
    const { t, main, fixLogin } = await apiRepo()
    const inside = await t.connectAs({ cwd: join(fixLogin.path, 'src') })
    const resolve = async (selector: string) => ((await call(inside, 'quirky.worktree/resolve', { selector })) as Worktree).id
    expect(await resolve(`id:${fixLogin.id}`)).toBe(fixLogin.id)
    expect(await resolve(fixLogin.id)).toBe(fixLogin.id)
    expect(await resolve('name:main')).toBe(main.id)
    expect(await resolve('main')).toBe(main.id)
    expect(await resolve('branch:fix-login')).toBe(fixLogin.id)
    expect(await resolve(`path:${join(fixLogin.path, 'src')}`)).toBe(fixLogin.id)
    expect(await resolve('current')).toBe(fixLogin.id)
    expect(await resolve('active')).toBe(fixLogin.id)
  })

  test('a path selector picks the innermost worktree and compares real paths', async () => {
    const { t, root, repo, fixLogin } = await apiRepo()
    const link = join(root, 'link-to-fix-login')
    const { symlinkSync } = await import('node:fs')
    symlinkSync(fixLogin.path, link)
    const resolved = (await call(t.client, 'quirky.worktree/resolve', { selector: `path:${link}/src` })) as Worktree
    expect(resolved.id).toBe(fixLogin.id)
    expect(repo.id).toBe(fixLogin.repoId)
  })

  test('a bare name falls through to a branch when no worktree has that name', async () => {
    const { t, repo, apiDir } = await apiRepo()
    const oddPath = `${apiDir}-odd`
    mkdirSync(oddPath)
    t.git!.worktreesByRepo.get(apiDir)!.push({ path: oddPath, branch: 'feat/odd', head: 'c'.repeat(40), isMain: false, locked: null })
    const odd = ((await call(t.client, 'quirky.worktree/list', { repo: repo.id })) as Worktree[]).find((w) => w.path === oddPath)!
    // D8: a non-primary worktree is named for its folder, so the branch is reachable only through the branch fallback
    expect(odd.name).toBe('api-odd')
    expect(((await call(t.client, 'quirky.worktree/resolve', { selector: 'feat/odd' })) as Worktree).id).toBe(odd.id)
  })

  test('a display name does not hide the folder name: name: and bare names match both', async () => {
    const { t, fixLogin } = await apiRepo()
    await call(t.client, 'quirky.worktree/set', { worktree: fixLogin.id, displayName: 'Login fix' })
    const resolve = async (selector: string) => ((await call(t.client, 'quirky.worktree/resolve', { selector })) as Worktree).id
    for (const selector of ['name:fix-login', 'fix-login', 'name:Login fix', 'Login fix']) expect(await resolve(selector)).toBe(fixLogin.id)
  })

  test('current with neither a cwd nor a session worktree is NotFound', async () => {
    const { t } = await apiRepo()
    const result = await failure(call(t.client, 'quirky.worktree/resolve', { selector: 'current' }))
    expect(result).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: 'no worktree matches current; use id:, name:, branch:, path: or current'
    })
  })

  test('explicit cwd and worktreeId params stand in for the caller identity', async () => {
    const { t, main, fixLogin } = await apiRepo()
    expect(((await call(t.client, 'quirky.worktree/resolve', { selector: 'current', cwd: join(fixLogin.path, 'src') })) as Worktree).id).toBe(fixLogin.id)
    expect(((await call(t.client, 'quirky.worktree/resolve', { selector: 'current', worktreeId: main.id })) as Worktree).id).toBe(main.id)
  })
})

describe('SC-8: current prefers the session worktree over the cwd', () => {
  test('a hello worktreeId wins over a cwd in another worktree', async () => {
    const { t, main, fixLogin } = await apiRepo()
    const session = await t.connectAs({ cwd: join(fixLogin.path, 'src'), worktreeId: main.id, sessionId: 's_1' })
    expect(((await call(session, 'quirky.worktree/resolve', { selector: 'current' })) as Worktree).id).toBe(main.id)
    expect(((await call(session, 'quirky.worktree/describeRemove', { worktree: 'current' })) as string)).toContain('main')
  })
})

describe('SC-9: no match and several matches', () => {
  test('no match names the selector and the forms; a shared name lists both as id selectors', async () => {
    const { t, main } = await apiRepo()
    const web = (await call(t.client, 'quirky.repo/add', { path: addFakeRepo(t.git!, 'web') })) as Repo
    const [webMain] = (await call(t.client, 'quirky.worktree/list', { repo: web.id })) as Worktree[]

    const none = await failure(call(t.client, 'quirky.worktree/resolve', { selector: 'name:nope' }))
    expect(none).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: 'no worktree matches name:nope; use id:, name:, branch:, path: or current'
    })

    const many = await failure(call(t.client, 'quirky.worktree/resolve', { selector: 'main' }))
    expect(many.code).toBe(RpcErrorCode.Conflict)
    const matches = (many.data as { matches: string[] }).matches
    expect([...matches].sort()).toEqual([`id:${main.id}`, `id:${webMain!.id}`].sort())
    expect(many.message).toBe(`main matches 2 worktrees: ${matches.join(', ')}`)
  })

  test('an empty selector is InvalidParams', async () => {
    const { t } = await apiRepo()
    expect((await failure(call(t.client, 'quirky.worktree/resolve', { selector: ' ' }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await failure(call(t.client, 'quirky.worktree/resolve', { selector: 'branch:' }))).code).toBe(RpcErrorCode.InvalidParams)
  })
})

describe('SC-10: repo selectors', () => {
  test('create takes name:, path: and a plain ID; an unknown name is NotFound', async () => {
    const { t, repo, apiDir } = await apiRepo()
    for (const [selector, name] of [
      ['name:api', 'feature-x'],
      [`path:${apiDir}`, 'feature-y'],
      [repo.id, 'feature-z']
    ] as const) {
      const created = ((await call(t.client, 'quirky.worktree/create', { repo: selector, name })) as WorktreeCreateResult).worktree
      expect(created).toMatchObject({ repoId: repo.id, name })
    }
    const missing = await failure(call(t.client, 'quirky.worktree/create', { repo: 'name:nope', name: 'x' }))
    expect(missing).toMatchObject({ code: RpcErrorCode.NotFound, message: 'no repo matches name:nope; use id:, name: or path:' })
  })
})

describe('g2-34: resolve lists the owner of a known worktree ID', () => {
  test('each ID-only selector lists only the owner project', async () => {
    const { t, apiDir, fixLogin, fixLoginRecord, mark, listed } = await selectorFixture()
    const session = await t.connectAs({ worktreeId: fixLogin.id, sessionId: 's_1' })
    const calls: [QuirkyClient, Record<string, unknown>][] = [
      [t.client, { selector: `id:${fixLogin.id}` }],
      [t.client, { selector: ` id:${fixLogin.id} ` }],
      [t.client, { selector: fixLogin.id }],
      [t.client, { selector: 'current', worktreeId: fixLogin.id }],
      [t.client, { selector: 'active', worktreeId: fixLogin.id }],
      [session, { selector: 'current' }],
      [session, { selector: 'active' }]
    ]

    for (const [client, params] of calls) {
      const from = mark()
      expect(await call(client, 'quirky.worktree/resolve', params)).toEqual(fixLoginRecord)
      expect(listed(from)).toEqual([apiDir])
    }
  })

  test('an ID is resolved through the project that owns its record', async () => {
    const { t, webDir, webMain, mark, listed } = await selectorFixture()
    const from = mark()
    expect(await call(t.client, 'quirky.worktree/resolve', { selector: `id:${webMain.id}` })).toEqual(webMain)
    expect(listed(from)).toEqual([webDir])
  })

  test('name, branch, path and cwd selectors search every project', async () => {
    const { t, apiDir, webDir, fixLogin, mark, listed } = await selectorFixture()
    const requests = [
      { selector: 'name:fix-login' },
      { selector: 'fix-login' },
      { selector: 'branch:fix-login' },
      { selector: `path:${fixLogin.path}` },
      { selector: 'current', cwd: fixLogin.path }
    ]

    for (const params of requests) {
      const from = mark()
      expect((await call(t.client, 'quirky.worktree/resolve', params) as Worktree).id).toBe(fixLogin.id)
      expect(listed(from)).toEqual([apiDir, webDir].sort())
    }
  })

  test('name: never takes the short path, but a bare exact ID wins', async () => {
    const { t, apiDir, webDir, main, fixLogin, mark, listed } = await selectorFixture()
    await call(t.client, 'quirky.worktree/set', { worktree: main.id, displayName: fixLogin.id })

    let from = mark()
    expect((await call(t.client, 'quirky.worktree/resolve', { selector: `name:${fixLogin.id}` }) as Worktree).id).toBe(main.id)
    expect(listed(from)).toEqual([apiDir, webDir].sort())

    from = mark()
    expect((await call(t.client, 'quirky.worktree/resolve', { selector: fixLogin.id }) as Worktree).id).toBe(fixLogin.id)
    expect(listed(from)).toEqual([apiDir])
  })

  test('an unknown ID falls back to the full search and is NotFound', async () => {
    const { t, apiDir, webDir, mark, listed } = await selectorFixture()
    const missingId = 'wt_000000000000'

    for (const selector of [`id:${missingId}`, missingId]) {
      const from = mark()
      expect(await failure(call(t.client, 'quirky.worktree/resolve', { selector }))).toMatchObject({
        code: RpcErrorCode.NotFound,
        message: `no worktree matches ${selector}; use id:, name:, branch:, path: or current`
      })
      expect(listed(from)).toEqual([apiDir, webDir].sort())
    }

    const from = mark()
    expect(await failure(call(t.client, 'quirky.worktree/resolve', { selector: 'current', worktreeId: missingId }))).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: 'no worktree matches current; use id:, name:, branch:, path: or current'
    })
    expect(listed(from)).toEqual([apiDir, webDir].sort())
  })

  test('ID values are not trimmed and an empty id: is InvalidParams', async () => {
    const { t, fixLogin } = await selectorFixture()
    const spaced = `id: ${fixLogin.id}`
    expect(await failure(call(t.client, 'quirky.worktree/resolve', { selector: spaced }))).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: `no worktree matches ${spaced}; use id:, name:, branch:, path: or current`
    })
    expect(await failure(call(t.client, 'quirky.worktree/resolve', { selector: 'id:' }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'id: needs a value'
    })
  })

  test('a stale owner registration is NotFound and its record is pruned', async () => {
    const { t, apiDir, repo, main, fixLogin } = await selectorFixture()
    const registrations = t.git!.worktreesByRepo.get(apiDir)!
    registrations.splice(registrations.findIndex((worktree) => worktree.path === fixLogin.path), 1)
    rmSync(fixLogin.path, { recursive: true, force: true })

    expect(await failure(call(t.client, 'quirky.worktree/resolve', { selector: `id:${fixLogin.id}` }))).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: `no worktree matches id:${fixLogin.id}; use id:, name:, branch:, path: or current`
    })
    expect(((await call(t.client, 'quirky.worktree/list', { repo: repo.id })) as Worktree[]).map((worktree) => worktree.id)).toEqual([main.id])
  })

  test('a worktree moved to another project resolves there after the full search', async () => {
    const { t, apiDir, webDir, webRepo, fixLogin, mark, listed } = await selectorFixture()
    const registrations = t.git!.worktreesByRepo.get(apiDir)!
    const moved = registrations.splice(registrations.findIndex((worktree) => worktree.path === fixLogin.path), 1)[0]!
    t.git!.worktreesByRepo.get(webDir)!.push(moved)

    const from = mark()
    expect(await call(t.client, 'quirky.worktree/resolve', { selector: `id:${fixLogin.id}` })).toMatchObject({
      id: fixLogin.id,
      repoId: webRepo.id,
      path: fixLogin.path
    })
    expect(listed(from)).toEqual([apiDir, apiDir, webDir].sort())
  })

  test('a project that cannot list fails only for its own IDs', async () => {
    const { t, apiDir, webDir, fixLogin, webMain, mark, listed } = await selectorFixture()
    t.git!.worktreesByRepo.delete(apiDir)

    expect(await failure(call(t.client, 'quirky.worktree/resolve', { selector: `id:${fixLogin.id}` }))).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: `no worktree matches id:${fixLogin.id}; use id:, name:, branch:, path: or current`
    })

    const from = mark()
    expect(await call(t.client, 'quirky.worktree/resolve', { selector: `id:${webMain.id}` })).toEqual(webMain)
    expect(listed(from)).toEqual([webDir])
  })

  test('folder projects and group workspaces resolve without git', async () => {
    const { t, mark, listed } = await selectorFixture()
    const notesDir = realpathSync(makeTempDir('qs-notes-'))
    const notes = (await call(t.client, 'quirky.repo/add', { path: notesDir, folder: true })) as Repo
    const drafts = ((await call(t.client, 'quirky.worktree/create', { repo: notes.id, name: 'drafts' })) as WorktreeCreateResult).worktree
    const appsDir = realpathSync(makeTempDir('qs-apps-'))
    const apps = (await call(t.client, 'quirky.repo/groupCreate', { name: 'apps', parentPath: appsDir })) as ProjectGroup
    const appsRoot = ((await call(t.client, 'quirky.worktree/create', { group: apps.id, name: 'apps-root' })) as WorktreeCreateResult).worktree
    const worktrees = (await call(t.client, 'quirky.worktree/list')) as Worktree[]
    const expected = [
      worktrees.find((worktree) => worktree.repoId === notes.id && worktree.isMain)!,
      worktrees.find((worktree) => worktree.id === drafts.id)!,
      worktrees.find((worktree) => worktree.id === appsRoot.id)!
    ]

    for (const record of expected) {
      const from = mark()
      expect(await call(t.client, 'quirky.worktree/resolve', { selector: `id:${record.id}` })).toEqual(record)
      expect(listed(from)).toEqual([])
    }
  })

  test('two projects on the same repository keep the conflict', async () => {
    const { t, apiDir, webDir, fixLogin, main, mark, listed } = await selectorFixture()
    t.git!.worktreesByRepo.set(fixLogin.path, t.git!.worktreesByRepo.get(apiDir)!)
    await call(t.client, 'quirky.repo/add', { path: fixLogin.path })

    for (const id of [main.id, fixLogin.id]) {
      const selector = `id:${id}`
      const duplicate = `id:${id}`
      const from = mark()
      const result = await failure(call(t.client, 'quirky.worktree/resolve', { selector }))
      expect(result.code).toBe(RpcErrorCode.Conflict)
      expect(result.message).toBe(`${selector} matches 2 worktrees: ${duplicate}, ${duplicate}`)
      expect(result.data).toMatchObject({ matches: [duplicate, duplicate] })
      expect(listed(from)).toContain(webDir)
    }
  })
})
