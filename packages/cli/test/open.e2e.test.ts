import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ClientRole, QuirkyClient } from '@quirky/protocol'
import { connectDaemon } from '@quirky/protocol/node'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { FakeDaemon } from './fixtures/fake-daemon'

const CLI = join(import.meta.dir, '..', 'src', 'main.ts')

type CliResult = { code: number; stdout: string; stderr: string }
type RunningCli = { result: Promise<CliResult> }

let daemon: FakeDaemon
let scope: ProcessScope
let clients: QuirkyClient[] = []
let openerDir: string
let openerMarker: string

beforeEach(() => {
  daemon = new FakeDaemon().start()
  scope = createProcessScope(daemon.home)
  clients = []
  openerDir = join(daemon.home, 'test-bin')
  mkdirSync(openerDir, { recursive: true })
  openerMarker = join(daemon.home, 'opener-started')
})

afterEach(async () => {
  for (const client of clients) client.close()
  await scope?.cleanup()
  daemon.stop()
})

function installOpener(body: string): void {
  writeFileSync(join(openerDir, 'open'), `#!/bin/sh\n${body}\n`, { mode: 0o700 })
}

function startOpen(): RunningCli {
  const child = scope.spawn([process.execPath, CLI, 'open', '--json'], {
    cwd: daemon.home,
    env: {
      HOME: daemon.home,
      QUIRKY_HOME: daemon.home,
      PATH: `${openerDir}:${process.env.PATH ?? ''}`,
      OPEN_MARKER: openerMarker
    },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const result = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]).then(([stdout, stderr, code]) => ({ code, stdout, stderr }))
  return { result }
}

async function open(): Promise<CliResult> {
  return startOpen().result
}

async function connectClient(role: ClientRole, name: string): Promise<QuirkyClient> {
  const client = await connectDaemon({ home: daemon.home, role, name, autostart: false })
  clients.push(client)
  return client
}

function waitForOpener(running: RunningCli): Promise<void> {
  if (existsSync(openerMarker)) return Promise.resolve()
  const watcher = watch(daemon.home)
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    watcher.close()
    resolve()
  }
  watcher.on('change', () => {
    if (existsSync(openerMarker)) finish()
  })
  watcher.on('error', (error) => {
    watcher.close()
    reject(error)
  })
  void running.result.then(finish, finish)
  if (existsSync(openerMarker)) finish()
  return promise.then(() => {
    expect(existsSync(openerMarker)).toBe(true)
  })
}

describe('open', () => {
  test.skipIf(process.platform !== 'darwin')('returns ready without launching when a desktop client is connected', async () => {
    installOpener("printf '%s\\n' 'unexpected opener launch' >&2\nexit 73")
    await connectClient('desktop', 'Quirky desktop')

    const result = await open()

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: true })
  })

  test.skipIf(process.platform !== 'darwin')('succeeds when a desktop connection appears after launching', async () => {
    installOpener(': > "$OPEN_MARKER"\nexit 0')
    const running = startOpen()
    await waitForOpener(running)
    await connectClient('desktop', 'Quirky desktop')
    const result = await running.result

    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ ready: true })
  })

  test.skipIf(process.platform !== 'darwin')('does not treat CLI or web clients as desktop readiness', async () => {
    installOpener(': > "$OPEN_MARKER"\nexit 0')
    await connectClient('ui', 'browser observer')

    const result = await open()

    expect(result.code).toBe(1)
    expect(existsSync(openerMarker)).toBe(true)
    expect(`${result.stdout}${result.stderr}`).toMatch(/desktop/i)
    expect(`${result.stdout}${result.stderr}`).toMatch(/ready|available|connect|timeout/i)
  }, 20_000)

  test.skipIf(process.platform !== 'darwin')('times out when daemon status never replies', async () => {
    installOpener(': > "$OPEN_MARKER"\nexit 0')
    daemon.withholdNextReply('status.get')

    const result = await open()

    expect(result.code).toBe(1)
    expect(existsSync(openerMarker)).toBe(false)
    const document = JSON.parse(result.stdout)
    expect(document.error.code).toBe('internal')
    expect(document.error.message).toBe('Quirky desktop did not become ready within 15 seconds')
    expect(document).not.toHaveProperty('ready')
  }, 20_000)

  test.skipIf(process.platform !== 'darwin')('reports an external opener failure', async () => {
    installOpener("printf '%s\\n' 'injected launcher failure' >&2\nexit 9")

    const result = await open()

    expect(result.code).toBe(1)
    expect(`${result.stdout}${result.stderr}`).toContain('injected launcher failure')
  })
})
