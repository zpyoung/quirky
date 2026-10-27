import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { RpcError, RpcErrorCode, type QuirkyClient, type Repo, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
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
