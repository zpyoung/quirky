import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { makeRepo } from '../../quirky.repo/test/git-fixtures'
import type { PluginContext } from '@quirky/protocol'
import {
  boot,
  createGitProject,
  createWorktree,
  extras,
  git,
  openWorktreeView,
  type DirtyResult,
  type TestEnvironment
} from './support'
import { readDirty } from '../src/daemon/dirty'
setDefaultTimeout(20_000)

let env: TestEnvironment | null = null
afterEach(async () => {
  await env?.harness.cleanup()
  env = null
})

describe('sidebar-extras dirty status', () => {
  test('uses only the active canonical Git workspace and counts staged, unstaged, and untracked rows', async () => {
    env = await boot()
    const project = await createGitProject(env.client)
    const background = await createWorktree(env.client, project.repo.id, 'background')
    writeFileSync(join(background.path, 'background.txt'), 'dirty elsewhere\n')
    await openWorktreeView(env.client, project.main.id)
    // Presentation recency intentionally points elsewhere; dirty-without-selector follows ui.state.
    await extras(env.client, 'activate', { worktree: background.id })

    const backgroundStatus = await extras<DirtyResult>(env.client, 'dirty', { worktree: background.id })
    expect(backgroundStatus).toMatchObject({ worktreeId: background.id, count: 1, capped: false, dirty: true, available: true })

    const cleanActive = await extras<DirtyResult>(env.client, 'dirty')
    expect(cleanActive).toMatchObject({
      worktreeId: project.main.id,
      count: 0,
      capped: false,
      title: 'Source Control',
      dirty: false,
      available: true
    })
    const explicitlyInactive = await extras<DirtyResult>(env.client, 'dirty', { worktree: null })
    expect(explicitlyInactive).toMatchObject({ worktreeId: null, count: 0, capped: false, title: 'Source Control', dirty: false })

    writeFileSync(join(project.main.path, 'README.md'), 'staged version\n')
    git(project.main.path, 'add', 'README.md')
    writeFileSync(join(project.main.path, 'README.md'), 'unstaged version\n')
    writeFileSync(join(project.main.path, 'untracked.txt'), 'new file\n')
    const threeRows = await extras<DirtyResult>(env.client, 'dirty')
    expect(threeRows).toMatchObject({ worktreeId: project.main.id, count: 3, capped: false, dirty: true, available: true })
    expect(threeRows.title).toMatch(/\b3\b.*changes?/i)

    git(project.main.path, 'reset', '--hard')
    rmSync(join(project.main.path, 'untracked.txt'), { force: true })
    writeFileSync(join(project.main.path, 'single-untracked.txt'), 'one row\n')
    const oneRow = await extras<DirtyResult>(env.client, 'dirty')
    expect(oneRow).toMatchObject({ count: 1, dirty: true, available: true })
    expect(oneRow.title).toMatch(/\b1\b.*change\b/i)
    expect(oneRow.title).not.toMatch(/\bchanges\b/i)
  })

  test('preserves capped panel counts and adds the capped marker to the title', async () => {
    env = await boot()
    const project = await createGitProject(env.client)
    await openWorktreeView(env.client, project.main.id)

    for (let index = 0; index < 1_005; index += 1) {
      writeFileSync(join(project.main.path, `untracked-${index}.txt`), 'x\n')
    }

    const capped = await extras<DirtyResult>(env.client, 'dirty')
    expect(capped).toMatchObject({ worktreeId: project.main.id, count: 1_000, capped: true, dirty: true, available: true })
    expect(capped.title).toContain('1000+')
  })

  test('reports unavailable status instead of a clean state when canonical Git status fails', async () => {
    env = await boot()
    const project = await createGitProject(env.client)
    await openWorktreeView(env.client, project.main.id)
    writeFileSync(join(project.main.path, 'dirty.txt'), 'dirty before failure\n')
    expect((await extras<DirtyResult>(env.client, 'dirty')).dirty).toBe(true)

    rmSync(project.main.path, { recursive: true, force: true })
    const unavailable = await extras<DirtyResult>(env.client, 'dirty')
    expect(unavailable).toMatchObject({
      worktreeId: project.main.id,
      count: 0,
      capped: false,
      title: 'Source Control',
      dirty: false,
      available: false,
      error: expect.any(String)
    })
  })
  test('expanded submodule details do not inflate the active worktree count', async () => {
    env = await boot()
    const project = await createGitProject(env.client)
    const library = makeRepo(join(env.harness.home, 'submodule-library'), { 'x.c': 'int x;\n' })
    git(project.path, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'vendor/lib')
    git(project.path, 'commit', '-q', '-m', 'add submodule')
    writeFileSync(join(project.main.path, 'vendor/lib/x.c'), 'int y;\n')
    await openWorktreeView(env.client, project.main.id)

    const before = await extras<DirtyResult>(env.client, 'dirty')
    expect(before).toMatchObject({ worktreeId: project.main.id, count: 1, dirty: true, available: true })
    const children = await env.client.callAny('quirky.git/submoduleStatus', {
      worktree: `id:${project.main.id}`,
      path: 'vendor/lib'
    }) as { entries: { path: string }[] }
    expect(children.entries.map((entry) => entry.path)).toEqual(['x.c'])
    const after = await extras<DirtyResult>(env.client, 'dirty')
    expect(after).toMatchObject({ worktreeId: project.main.id, count: 1, dirty: true, available: true })
  })
})
test('dirty status uses layout selection in a global view', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const context = {
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'ui.state') return { layout: { view: { id: 'view:global' }, worktree: 'wt-selected' } }
      if (method === 'quirky.worktree/resolve') return { id: 'wt-selected', path: '/work/selected' }
      if (method === 'quirky.git/status') return { entries: [{ path: 'src/change.ts' }], capped: false }
      throw new Error(`unexpected call: ${method}`)
    }
  } as unknown as PluginContext

  expect(await readDirty(context, {})).toMatchObject({
    worktreeId: 'wt-selected',
    count: 1,
    dirty: true,
    available: true
  })
  expect(calls).toEqual([
    { method: 'ui.state', params: {} },
    { method: 'quirky.worktree/resolve', params: { selector: 'wt-selected' } },
    { method: 'quirky.git/status', params: { worktree: 'id:wt-selected' } }
  ])
})

test('dirty status keeps a structured session bound to its own worktree', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const context = {
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      if (method === 'ui.state') {
        return {
          layout: {
            view: { id: 'view:quirky.session/structured', input: { session: 'session-selected' } },
            worktree: 'wt-retained'
          }
        }
      }
      if (method === 'quirky.session/get') return { worktreeId: 'wt-session' }
      if (method === 'quirky.worktree/resolve') return { id: 'wt-session', path: '/work/session' }
      if (method === 'quirky.git/status') return { entries: [], capped: false }
      throw new Error(`unexpected call: ${method}`)
    }
  } as unknown as PluginContext

  expect(await readDirty(context, {})).toMatchObject({ worktreeId: 'wt-session', count: 0, available: true })
  expect(calls).toEqual([
    { method: 'ui.state', params: {} },
    { method: 'quirky.session/get', params: { session: 'session-selected' } },
    { method: 'quirky.worktree/resolve', params: { selector: 'id:wt-session' } },
    { method: 'quirky.git/status', params: { worktree: 'id:wt-session' } }
  ])
})
