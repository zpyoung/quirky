import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { QuirkyClient } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { startDaemon } from '../src/daemon'
import { createFakeGit } from './fixtures/fake-git'
import { startFakePtyHost } from './fixtures/fake-pty-host'
import { makeTempHome } from './helpers'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function setup() {
  const home = makeTempHome('qd-id-')
  const pty = startFakePtyHost(home)
  cleanups.push(() => pty.stop(), () => rmSync(home, { recursive: true, force: true }))
  const start = async (port = 0) => {
    const daemon = await startDaemon({
      home,
      port,
      git: createFakeGit(),
      shell: '/bin/zsh',
      notifier: () => {},
      uiDir: '/none',
      log: () => {}
    })
    cleanups.push(() => daemon.stop())
    return daemon
  }
  return { home, start }
}

describe('daemon identity', () => {
  test('a restarted daemon keeps its port, rpc token and hook token', async () => {
    const { home, start } = setup()
    const first = await start()
    const identity = JSON.parse(await Bun.file(join(home, 'daemon-identity.json')).text())
    expect(identity).toEqual({ port: first.port, token: first.runtime.token, hookToken: first.runtime.hookToken })
    expect(statSync(join(home, 'daemon-identity.json')).mode & 0o777).toBe(0o600)
    const url = rpcUrl(first.runtime)
    await first.stop()

    const second = await start()
    expect(second.port).toBe(first.port)
    expect(second.runtime.token).toBe(first.runtime.token)
    expect(second.runtime.hookToken).toBe(first.runtime.hookToken)
    const client = await QuirkyClient.connect(url, { role: 'cli' })
    expect((await client.call('status.get', {})).pid).toBe(process.pid)
    client.close()
  })

  test('falls back to a free port but keeps the token when the old port is taken', async () => {
    const { home, start } = setup()
    const first = await start()
    await first.stop()
    const squatter = Bun.serve({ hostname: '127.0.0.1', port: first.port, fetch: () => new Response('x') })
    cleanups.push(() => squatter.stop(true))

    const second = await start()
    expect(second.port).not.toBe(first.port)
    expect(second.runtime.token).toBe(first.runtime.token)
    expect(JSON.parse(await Bun.file(join(home, 'daemon-identity.json')).text()).port).toBe(second.port)
  })

  test('an unreadable identity file is replaced with a fresh one', async () => {
    const { home, start } = setup()
    writeFileSync(join(home, 'daemon-identity.json'), 'not json')
    const daemon = await start()
    expect(daemon.runtime.token).toHaveLength(48)
    expect(JSON.parse(await Bun.file(join(home, 'daemon-identity.json')).text()).token).toBe(daemon.runtime.token)
  })

  test('an identity file from before hook tokens were stored gains one and keeps the rpc token', async () => {
    const { home, start } = setup()
    const first = await start()
    await first.stop()
    writeFileSync(
      join(home, 'daemon-identity.json'),
      JSON.stringify({ port: first.port, token: first.runtime.token })
    )
    const second = await start()
    expect(second.runtime.token).toBe(first.runtime.token)
    expect(second.runtime.hookToken).toHaveLength(48)
    const stored = JSON.parse(await Bun.file(join(home, 'daemon-identity.json')).text())
    expect(stored.hookToken).toBe(second.runtime.hookToken)
  })

  test('an explicit port is used as given and the token is still kept', async () => {
    const { start } = setup()
    const first = await start()
    await first.stop()
    const free = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('x') })
    const wanted = free.port as number
    free.stop(true)
    const second = await start(wanted)
    expect(second.port).toBe(wanted)
    expect(second.runtime.token).toBe(first.runtime.token)
  })
})
