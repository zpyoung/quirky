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

describe('SC-20: quirky repo commands keep v1 output', () => {
  test('add resolves the path against the CLI cwd and prints the record', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client, { cwd: '/fake/alpha' })
    await commands.add!({ positionals: ['src/deep'], flags: {} }, ctx)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^id: repo_[0-9a-f]+\nname: alpha\npath: \/fake\/alpha$/)
    expect(((await client.callAny('quirky.repo/list', {})) as Repo[])[0]!.path).toBe('/fake/alpha')
  })

  test('add takes an absolute path as given and prints JSON under --json', async () => {
    const { client } = await start()
    const { ctx, lines } = testCliContext(client, { cwd: '/elsewhere', json: true })
    await commands.add!({ positionals: ['/fake/alpha'], flags: {} }, ctx)
    expect(JSON.parse(lines[0]!)).toMatchObject({ name: 'alpha', path: '/fake/alpha' })
  })

  test('list prints "no repos", then a table', async () => {
    const { client } = await start()
    const first = testCliContext(client)
    await commands.list!({ positionals: [], flags: {} }, first.ctx)
    expect(first.lines).toEqual(['no repos'])

    const repo = (await client.callAny('quirky.repo/add', { path: '/fake/alpha' })) as Repo
    const second = testCliContext(client)
    await commands.list!({ positionals: [], flags: {} }, second.ctx)
    expect(second.lines[0]!.split('\n')).toEqual(['ID' + ' '.repeat(repo.id.length - 2) + '  NAME   PATH', `${repo.id}  alpha  /fake/alpha`])
  })

  test('rm prints "removed <repo>" and takes selectors', async () => {
    const { client } = await start()
    await client.callAny('quirky.repo/add', { path: '/fake/alpha' })
    const { ctx, lines } = testCliContext(client)
    await commands.rm!({ positionals: ['name:alpha'], flags: {} }, ctx)
    expect(lines).toEqual(['removed name:alpha'])
    expect(await client.callAny('quirky.repo/list', {})).toEqual([])
  })

  test('rm --json prints the method result', async () => {
    const { client } = await start()
    await client.callAny('quirky.repo/add', { path: '/fake/alpha' })
    const { ctx, lines } = testCliContext(client, { json: true })
    await commands.rm!({ positionals: ['alpha'], flags: {} }, ctx)
    expect(lines).toEqual(['{"ok":true}'])
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
    const [out, err, missingCode] = await Promise.all([new Response(missing.stdout).text(), new Response(missing.stderr).text(), missing.exited])
    expect(missingCode).toBe(1)
    expect(out + err).toContain('no repo matches name:nope; use id:, name: or path:')
  })
})
