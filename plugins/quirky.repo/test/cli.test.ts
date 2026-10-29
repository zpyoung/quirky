import { afterEach, describe, expect, test } from 'bun:test'
import type { Repo } from '@quirky/protocol'
import { spawnCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { commands } from '../cli'
import { startPluginHarness, testCliContext, type PluginHarness } from './harness'

let t: PluginHarness | undefined
afterEach(async () => {
  await t?.cleanup()
  t = undefined
})

async function start() {
  t = await startPluginHarness()
  t.git!.addRepo('/fake/alpha')
  return t
}

describe('SC-20: quirky repo command path handling', () => {
  test('add resolves the path against the CLI cwd', async () => {
    const { client } = await start()
    const { ctx } = testCliContext(client, { cwd: '/fake/alpha' })
    await commands.add!({ positionals: ['src/deep'], flags: {} }, ctx)
    expect((await client.callAny('quirky.repo/list', {})) as Repo[]).toMatchObject([{ name: 'alpha', path: '/fake/alpha' }])
  })

  test('add preserves an absolute path from a different CLI cwd', async () => {
    const { client } = await start()
    const { ctx } = testCliContext(client, { cwd: '/elsewhere' })
    await commands.add!({ positionals: ['/fake/alpha'], flags: {} }, ctx)
    expect((await client.callAny('quirky.repo/list', {})) as Repo[]).toMatchObject([{ name: 'alpha', path: '/fake/alpha' }])
  })
})

describe('quirky repo through the real CLI', () => {
  test('SC-10: a generated command resolves a selector in the daemon', async () => {
    const { client, h } = await start()
    const repo = (await client.callAny('quirky.repo/add', { path: '/fake/alpha' })) as Repo
    const proc = spawnCli(['repo', 'resolve', '--selector', 'name:alpha', '--json'], { home: h.home })
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
    expect(JSON.parse(stdout)).toMatchObject({ id: repo.id, name: 'alpha' })

    const missing = spawnCli(['repo', 'resolve', '--selector', 'name:nope', '--json'], { home: h.home })
    const [out, , missingCode] = await Promise.all([new Response(missing.stdout).text(), new Response(missing.stderr).text(), missing.exited])
    expect(missingCode).toBe(1)
    expect(JSON.parse(out).error).toMatchObject({ code: 'not-found' })
    expect(JSON.parse(out).error.message).toContain('name:nope')
  })

  test('rm removes only the selected repo and a second removal is NotFound', async () => {
    const { client, h } = await start()
    t!.git!.addRepo('/fake/beta')
    const removed = (await client.callAny('quirky.repo/add', { path: '/fake/alpha' })) as Repo
    const retained = (await client.callAny('quirky.repo/add', { path: '/fake/beta' })) as Repo

    const remove = spawnCli(['repo', 'rm', 'name:alpha'], { home: h.home })
    const [, , removeCode] = await Promise.all([new Response(remove.stdout).text(), new Response(remove.stderr).text(), remove.exited])
    expect(removeCode).toBe(0)
    const remaining = ((await client.callAny('quirky.repo/list', {})) as Repo[]).map(({ id }) => id)
    expect(remaining).not.toContain(removed.id)
    expect(remaining).toContain(retained.id)

    const missing = spawnCli(['repo', 'rm', 'name:alpha', '--json'], { home: h.home })
    const [out, , missingCode] = await Promise.all([new Response(missing.stdout).text(), new Response(missing.stderr).text(), missing.exited])
    expect(missingCode).toBe(1)
    expect(JSON.parse(out).error).toMatchObject({ code: 'not-found' })
    expect(JSON.parse(out).error.message).toContain('name:alpha')
    expect(((await client.callAny('quirky.repo/list', {})) as Repo[]).map(({ id }) => id)).toEqual([retained.id])
  })
})
