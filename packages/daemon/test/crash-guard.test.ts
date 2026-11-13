import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { readRuntime, rpcUrl } from '@quirky/protocol/node'
import { createProcessScope } from '../../../scripts/test-support/process-scope'
import { acquireDaemonLock } from '../src/lock'
import { makeTempHome, waitFor } from './helpers'
import { writeModulePlugin } from './plugins/fixtures'

const MAIN = join(import.meta.dir, '../src/main.ts')
const FAKE_HOST = join(import.meta.dir, 'fixtures/fake-pty-host.ts')
const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function fixture() {
  const home = makeTempHome('qd-crash-')
  const scope = createProcessScope(home)
  cleanups.push(() => rmSync(home, { recursive: true, force: true }))
  cleanups.push(() => scope.cleanup())
  const env = {
    ...process.env,
    QUIRKY_HOME: home,
    QUIRKY_PORT: '0',
    QUIRKY_UI_DIR: join(home, 'no-ui'),
    QUIRKY_BUILTIN_PLUGINS_DIR: join(home, 'no-builtins'),
    QUIRKY_PTY_HOST_ENTRY: FAKE_HOST
  }
  const log = join(home, 'stderr.log')
  return { home, scope, env, log }
}

test('timer throws and unhandled rejections leave the same daemon serving RPC', async () => {
  const { home, scope, env, log } = fixture()
  // real child-process timers exercise Bun's uncaught-error dispatch, which fake timers bypass
  writeModulePlugin(join(home, 'plugins'), join(home, 'marker.log'), {
    id: 'acme.fault',
    contributes: { method: [{ id: 'trigger', params: { type: 'object' } }] }
  }, {
    activate: `context.provide('method:acme.fault/trigger', () => {
      setTimeout(() => { throw new Error('timer-fault') }, 10)
      setTimeout(() => { void Promise.reject(new Error('reject-fault')) }, 20)
      return {}
    })`
  })
  const child = scope.spawn([process.execPath, MAIN], { env, stdout: 'ignore', stderr: Bun.file(log) })
  const runtime = await waitFor(() => readRuntime(home), 10000)
  expect(runtime.pid).toBe(child.pid)
  const client = await QuirkyClient.connect(rpcUrl(runtime), { role: 'cli' })
  cleanups.push(() => client.close())
  await client.callAny('acme.fault/trigger', {})
  await waitFor(() => {
    const text = readFileSync(log, 'utf8')
    return text.includes('[quirkyd] uncaughtException: Error: timer-fault') && text.includes('[quirkyd] unhandledRejection: Error: reject-fault')
  }, 3000)
  expect(child.exitCode).toBeNull()
  expect(readRuntime(home)?.pid).toBe(child.pid)
  expect(await client.call('status.get', {})).toBeDefined()
  child.kill('SIGTERM')
  expect(await child.exited).toBe(0)
}, 15000)

for (const fault of ['invalid port', 'database directory'] as const) {
  test(`${fault} logs startup failure, exits 1 and releases daemon.lock`, async () => {
    const { home, scope, env, log } = fixture()
    if (fault === 'invalid port') env.QUIRKY_PORT = '-1'
    else mkdirSync(join(home, 'quirky.db'))
    const child = scope.spawn([process.execPath, MAIN], { env, stdout: 'ignore', stderr: Bun.file(log) })
    await waitFor(() => child.exitCode !== null, 10000)
    expect(await child.exited).toBe(1)
    expect(readFileSync(log, 'utf8')).toContain('[quirkyd] startup failed: ')
    expect(existsSync(join(home, 'daemon.lock'))).toBe(false)
    const lock = await acquireDaemonLock(home)
    expect(lock).not.toBeNull()
    lock?.release()
  }, 15000)
}

test('a duplicate daemon still exits 0 and leaves its owner alive', async () => {
  const { home, scope, env, log } = fixture()
  const first = scope.spawn([process.execPath, MAIN], { env, stdout: 'ignore', stderr: 'ignore' })
  await waitFor(() => readRuntime(home), 10000)
  const second = scope.spawn([process.execPath, MAIN], { env, stdout: 'ignore', stderr: Bun.file(log) })
  await waitFor(() => second.exitCode !== null, 10000)
  expect(await second.exited).toBe(0)
  expect(readFileSync(log, 'utf8')).toContain('a daemon already owns this home; exiting')
  expect(readRuntime(home)?.pid).toBe(first.pid)
  const client = await QuirkyClient.connect(rpcUrl(readRuntime(home)!), { role: 'cli' })
  cleanups.push(() => client.close())
  expect(await client.call('status.get', {})).toBeDefined()
}, 15000)
