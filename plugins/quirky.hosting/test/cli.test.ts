import { afterEach, expect, test } from 'bun:test'
import { bootHosting, type HostingTest } from './helpers'

const ghSource = `process.stdout.write('{}')\n`
let host: HostingTest | undefined
afterEach(async () => {
  await host?.cleanup()
  host = undefined
})

test('GH32 method schemas are discoverable without activation and generated CLI calls the daemon API', async () => {
  host = await bootHosting(ghSource)
  const plugins = await host.client.callAny('plugin.list', {})
  const before = JSON.stringify(plugins)
  expect(before).toContain('quirky.hosting')
  const description = await host.client.callAny('api.describe', {})
  expect(JSON.stringify(description)).toContain('quirky.hosting/repository')
  expect(JSON.stringify(description)).toContain('hosting repository')

  const result = await host.cli(['--json', 'hosting', 'repository', '--worktree', host.worktree])
  expect(result).toMatchObject({ code: 0, stderr: '' })
  expect(JSON.parse(result.stdout)).toMatchObject({ origin: { owner: 'test-owner', repo: 'test-repo' } })
}, 20_000)

test('GH32 disabling the hosting owner removes its API and generated CLI commands, and re-enable restores them', async () => {
  host = await bootHosting(ghSource)
  await host.client.callAny('plugin.disable', { id: 'quirky.hosting' })
  await expect(host.call('repository')).rejects.toMatchObject({ code: -32601 })
  const disabled = await host.cli(['--json', 'hosting', 'repository', '--worktree', host.worktree])
  expect(disabled.code).not.toBe(0)

  await host.client.callAny('plugin.enable', { id: 'quirky.hosting' })
  expect(await host.call('repository')).toMatchObject({ origin: { owner: 'test-owner', repo: 'test-repo' } })
}, 20_000)
