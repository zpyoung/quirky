import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient, Repo, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { spawnCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { fakeAsks } from '../../quirky.repo/test/fakes/quirky.ask/main'
import { startPluginHarness, testCliContext, type PluginHarness } from '../../quirky.repo/test/harness'
import { commands } from '../cli'
import { addFakeRepo, fakeRegistrations } from './fixtures/fake-git'

isolateGitConfig()
let t: PluginHarness | undefined
afterEach(async () => {
  await t?.cleanup()
  t = undefined
})

const call = (client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params)

async function start(options: Parameters<typeof startPluginHarness>[0] = {}) {
  t = await startPluginHarness(options)
  fakeRegistrations(t.git!)
  const alpha = addFakeRepo(t.git!, 'alpha')
  const root = realpathSync(makeTempDir('qw-'))
  await call(t.client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const repo = (await call(t.client, 'quirky.repo/add', { path: alpha })) as Repo
  return { t, client: t.client, root, repo, alpha }
}

describe('SC-20: quirky worktree commands keep v1 output', () => {
  test('list prints "no worktrees" without repos, then a table with a detached placeholder', async () => {
    t = await startPluginHarness()
    fakeRegistrations(t.git!)
    const empty = testCliContext(t.client)
    await commands.list!({ positionals: [], flags: {} }, empty.ctx)
    expect(empty.lines).toEqual(['no worktrees'])

    const alpha = addFakeRepo(t.git!, 'alpha')
    const detached = `${alpha}-det`
    mkdirSync(detached)
    t.git!.worktreesByRepo.get(alpha)!.push({ path: detached, branch: null, head: 'd'.repeat(40), isMain: false, locked: null })
    await call(t.client, 'quirky.repo/add', { path: alpha })
    const filled = testCliContext(t.client)
    await commands.list!({ positionals: [], flags: {} }, filled.ctx)
    const rows = filled.lines[0]!.split('\n')
    // the table grew a STATUS column (m1-worktrees tech.md "CLI")
    expect(rows[0]).toMatch(/^ID\s+NAME\s+BRANCH\s+STATUS\s+PATH$/)
    expect(rows[1]).toMatch(new RegExp(`^wt_[0-9a-f]{12}\\s+main\\s+main\\s+in-progress\\s+${alpha}$`))
    expect(rows[2]).toMatch(new RegExp(`\\(detached\\)\\s+in-progress\\s+${detached}$`))
  })

  test('list --repo takes a selector', async () => {
    const { client } = await start()
    const beta = addFakeRepo(t!.git!, 'beta')
    await call(client, 'quirky.repo/add', { path: beta })
    const { ctx, lines } = testCliContext(client, { json: true })
    await commands.list!({ positionals: [], flags: { repo: 'name:beta' } }, ctx)
    const listed = JSON.parse(lines[0]!) as Worktree[]
    expect(listed.map((w) => w.path)).toEqual([beta])
  })

  test('create prints the record and resolves --base to a full ref', async () => {
    const { t, client, root } = await start()
    const { ctx, lines } = testCliContext(client)
    await commands.create!({ positionals: ['name:alpha', 'feature-x'], flags: { base: 'main' } }, ctx)
    expect(lines[0]).toMatch(
      new RegExp(`^id: wt_[0-9a-f]{12}\\nname: feature-x\\nbranch: feature-x\\npath: ${join(root, 'alpha', 'feature-x')}$`)
    )
    expect(t.git!.calls.find((c) => c.fn === 'addWorktree')?.args[3]).toBe('c'.repeat(40))
  })

  test('create without --base cuts from the detected default branch, not HEAD', async () => {
    const { t, client } = await start()
    const { ctx } = testCliContext(client)
    await commands.create!({ positionals: ['alpha', 'feature-x'], flags: {} }, ctx)
    expect(t.git!.calls.find((c) => c.fn === 'addWorktree')?.args[3]).toBe('c'.repeat(40))
  })

  test('rm prints "removed <worktree>" and passes --force', async () => {
    const { t, client, repo } = await start()
    await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'feature-x' })
    const { ctx, lines } = testCliContext(client, { yes: ['quirky.worktree/remove'] })
    await commands.rm!({ positionals: ['feature-x'], flags: { force: true } }, ctx)
    expect(lines).toEqual(['removed feature-x'])
    expect(t.git!.calls.find((c) => c.fn === 'removeWorktree')?.args[2]).toBe(true)
  })

  test('rm without --force sends no force param', async () => {
    const { t, client, repo } = await start()
    await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'feature-x' })
    const { ctx } = testCliContext(client, { yes: ['quirky.worktree/remove'] })
    await commands.rm!({ positionals: ['name:feature-x'], flags: {} }, ctx)
    expect(t.git!.calls.find((c) => c.fn === 'removeWorktree')?.args[2]).toBe(false)
  })
})

describe('quirky worktree through the real CLI', () => {
  test('SC-17: the unshadowed group word lists worktrees and wt is an alias', async () => {
    const { t, repo } = await start()
    await call(t.client, 'quirky.worktree/create', { repo: repo.id, name: 'feature-x' })
    const run = async (args: string[]) => {
      const proc = spawnCli(args, { home: t.h.home })
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
      return { stdout, stderr, code }
    }
    const listed = await run(['worktree', 'list', '--json'])
    expect(listed.code).toBe(0)
    expect((JSON.parse(listed.stdout) as Worktree[]).map((w) => w.name)).toEqual(['main', 'feature-x'])
    const text = await run(['worktree', 'list', '--repo', 'name:alpha'])
    expect(text.stdout.split('\n')[0]).toMatch(/^ID\s+NAME\s+BRANCH\s+STATUS\s+PATH$/)
  })

  test('SC-44: worktree rm --yes removes at once', async () => {
    const { t, repo } = await start({ fakeAsk: true })
    await call(t.client, 'quirky.worktree/create', { repo: repo.id, name: 'feature-x' })
    const proc = spawnCli(['worktree', 'rm', 'feature-x', '--yes'], { home: t.h.home })
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(0)
    expect(stdout).toBe('removed feature-x\n')
    expect(fakeAsks().size).toBe(0)
  })

  test('SC-43: worktree rm asks first; Yes removes it and No keeps it', async () => {
    const { t, repo } = await start({ fakeAsk: true })
    const created = ((await call(t.client, 'quirky.worktree/create', { repo: repo.id, name: 'feature-x' })) as WorktreeCreateResult).worktree

    const yes = spawnCli(['worktree', 'rm', 'feature-x'], { home: t.h.home })
    const askId = await waitFor(() => [...fakeAsks().keys()][0])
    fakeAsks().get(askId)!.status = 'answered'
    fakeAsks().get(askId)!.value = true
    const [yesOut, yesErr, yesCode] = await Promise.all([new Response(yes.stdout).text(), new Response(yes.stderr).text(), yes.exited])
    expect(yesErr).toContain(`confirm in Quirky: Remove worktree feature-x (${created.path})? (ask ${askId}); or rerun with --yes`)
    expect({ code: yesCode, out: yesOut }).toEqual({ code: 0, out: 'removed feature-x\n' })

    await call(t.client, 'quirky.worktree/create', { repo: repo.id, name: 'feature-y' })
    const no = spawnCli(['worktree', 'rm', 'feature-y'], { home: t.h.home })
    const secondAsk = await waitFor(() => [...fakeAsks().keys()].find((id) => id !== askId))
    fakeAsks().get(secondAsk)!.status = 'declined'
    const [noErr, noCode] = await Promise.all([new Response(no.stderr).text(), no.exited])
    expect(noCode).toBe(1)
    expect(noErr).toContain('declined')
    const names = ((await call(t.client, 'quirky.worktree/list', { repo: repo.id })) as Worktree[]).map((w) => w.name)
    expect(names).toEqual(['main', 'feature-y'])
  })
})
