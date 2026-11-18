import { afterEach, expect, test } from 'bun:test'
import { bootHosting, type HostingTest } from './helpers'

const hosts: HostingTest[] = []
afterEach(async () => {
  // cleanup restores process-wide environment snapshots, so keep both fixtures alive and unwind newest first
  for (const host of hosts.splice(0).reverse()) await host.cleanup()
})

const ghFixture = String.raw`
const args = process.argv.slice(2)
if (args[0] === 'auth') {
  process.stdout.write(args[1] === 'status'
    ? 'Logged in to github.com account fixture-user (keyring)\nActive account: true\nToken scopes: repo, read:org, project\n'
    : 'fixture-token\n')
} else if (args[0] === 'api' && args.includes('user')) {
  process.stdout.write(JSON.stringify({ login: 'fixture-user' }))
} else {
  process.stderr.write('HTTP 503: temporarily unavailable')
  process.exit(1)
}
`

async function host(): Promise<HostingTest> {
  const harness = await bootHosting(ghFixture)
  hosts.push(harness)
  return harness
}

function configuration(harness: HostingTest) {
  return { worktreeId: harness.worktree, issueSourcePreference: 'auto', account: null }
}

test('disabling hosting in one daemon leaves another activation usable', async () => {
  const a = await host()
  expect(await a.call('configuration')).toEqual(configuration(a))
  const b = await host()
  expect(await b.call('configuration')).toEqual(configuration(b))

  expect(await a.client.callAny('plugin.disable', { id: 'quirky.hosting' })).toEqual({ ok: true })

  expect(process.env.QUIRKY_HOME).toBe(b.home)
  expect(await b.call('configuration')).toEqual(configuration(b))
}, 30_000)

test('disabling hosting prevents review-cache expiry from emitting through a revoked context', async () => {
  const a = await host()
  expect(await a.call('forBranch', { branch: 'feature' })).toMatchObject({
    kind: 'unavailable', reason: 'server_error'
  })
  const b = await host()
  expect(await b.call('configuration')).toEqual(configuration(b))

  expect(await a.client.callAny('plugin.disable', { id: 'quirky.hosting' })).toEqual({ ok: true })

  // the daemon's real expiry timer must run past its 5-second TTL; fake time would bypass this integration path
  await Bun.sleep(6_000)
}, 30_000)
