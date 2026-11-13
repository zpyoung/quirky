import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PtyClient } from '../src/client'
import { createProcessScope, type ProcessScope } from '../../../scripts/test-support/process-scope'
import { waitFor } from './helpers'

const MAIN = join(import.meta.dir, '..', 'src', 'main.ts')
const scopes: ProcessScope[] = []

afterEach(async () => {
  let firstError: unknown
  for (const scope of scopes.splice(0).reverse()) {
    try {
      await scope.cleanup()
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError !== undefined) throw firstError
})

function scopedHome(): { home: string; scope: ProcessScope } {
  const scope = createProcessScope()
  scopes.push(scope)
  return { home: scope.home, scope }
}

function capture(stream: ReadableStream<Uint8Array>) {
  let output = ''
  const decoder = new TextDecoder()
  const done = (async () => {
    const reader = stream.getReader()
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      output += decoder.decode(chunk.value, { stream: true })
    }
    output += decoder.decode()
  })()
  return { text: () => output, done }
}

async function hostClient(home: string): Promise<PtyClient> {
  const socketPath = join(home, 'pty.sock')
  const token = await waitFor(
    () => (existsSync(socketPath) && existsSync(join(home, 'pty.token')) ? readFileSync(join(home, 'pty.token'), 'utf8') : ''),
    10000,
    'PTY host socket'
  )
  for (let attempt = 0; ; attempt++) {
    try {
      const client = await PtyClient.connect(socketPath)
      try {
        await client.hello(token)
        return client
      } catch (error) {
        client.close()
        throw error
      }
    } catch (error) {
      if (attempt >= 100) throw error
      await Bun.sleep(50)
    }
  }
}

async function exitCode(proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>, what: string): Promise<number> {
  const result = await waitFor(() => (proc.exitCode === null ? undefined : { code: proc.exitCode }), 10000, what)
  return result.code
}

describe('quirky-pty crash guards', () => {
  test('survives a timer throw and unhandled rejection without dropping a live PTY', async () => {
    const { home, scope } = scopedHome()
    // The preload must use real timers so SIGUSR2 exercises the host's event loop.
    const preloadPath = join(home, 'fault-preload.ts')
    writeFileSync(
      preloadPath,
      `process.on('SIGUSR2', () => {\n  setTimeout(() => { throw new Error('pty-timer-fault') }, 10)\n  setTimeout(() => { void Promise.reject(new Error('pty-reject-fault')) }, 20)\n})\n`
    )
    const proc = scope.spawn([process.execPath, '--preload', preloadPath, MAIN], { stdout: 'pipe', stderr: 'pipe' })
    const stderr = capture(proc.stderr)
    const client = await hostClient(home)
    const sessionId = 'crash-survivor'
    await client.request('create', {
      sessionId,
      cwd: '/tmp',
      argv: ['/bin/sh', '-c', 'cat'],
      env: { PATH: '/usr/bin:/bin' },
      cols: 80,
      rows: 24
    })
    let output = ''
    client.onData((id, bytes) => {
      if (id === sessionId) output += new TextDecoder().decode(bytes)
    })
    await client.request('subscribe', { sessionId })

    process.kill(proc.pid, 'SIGUSR2')
    await waitFor(() => (stderr.text().includes('[quirky-pty] uncaughtException: Error: pty-timer-fault') ? true : undefined), 5000, 'timer crash log')
      .catch((error) => { throw new Error(`${error}; host exit=${proc.exitCode}; stderr=${stderr.text()}`) })
    await waitFor(() => (stderr.text().includes('[quirky-pty] unhandledRejection: Error: pty-reject-fault') ? true : undefined), 5000, 'rejection crash log')
    client.sendInput(sessionId, new TextEncoder().encode('alive\n'))
    await waitFor(() => (output.includes('alive') ? true : undefined), 5000, 'PTY echo after process errors')

    expect(proc.exitCode).toBeNull()
    expect(readFileSync(join(home, 'pty.pid'), 'utf8')).toBe(String(proc.pid))
    client.close()
  }, 30000)

  test('logs a startup failure and exits 1 when pty.token cannot be written', async () => {
    const { home, scope } = scopedHome()
    mkdirSync(join(home, 'pty.token'))
    const proc = scope.spawn([process.execPath, MAIN], { stdout: 'pipe', stderr: 'pipe' })
    const stderr = capture(proc.stderr)

    expect(await exitCode(proc, 'startup failure exit')).toBe(1)
    await stderr.done
    expect(stderr.text()).toContain('[quirky-pty] startup failed:')
    expect(stderr.text()).toContain('EISDIR')
  }, 30000)

  test('a duplicate host exits 0 without replacing the live host', async () => {
    const { home, scope } = scopedHome()
    const first = scope.spawn([process.execPath, MAIN], { stdout: 'ignore', stderr: 'ignore' })
    const client = await hostClient(home)
    const token = readFileSync(join(home, 'pty.token'), 'utf8')

    const second = scope.spawn([process.execPath, MAIN], { stdout: 'pipe', stderr: 'pipe' })
    const stdout = capture(second.stdout)
    expect(await exitCode(second, 'duplicate host exit')).toBe(0)
    await stdout.done
    expect(stdout.text()).toContain(`quirky-pty already running for ${home}`)
    expect(readFileSync(join(home, 'pty.token'), 'utf8')).toBe(token)
    expect(readFileSync(join(home, 'pty.pid'), 'utf8')).toBe(String(first.pid))
    expect(first.exitCode).toBeNull()
    client.close()
  }, 30000)

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    test(`${signal} logs a stop failure, removes pty.pid and exits 1`, async () => {
      const { home, scope } = scopedHome()
      const proc = scope.spawn([process.execPath, MAIN], { stdout: 'pipe', stderr: 'pipe' })
      const stderr = capture(proc.stderr)
      const client = await hostClient(home)
      client.close()

      rmSync(join(home, 'pty.sock'))
      mkdirSync(join(home, 'pty.sock'))
      proc.kill(signal)

      expect(await exitCode(proc, `${signal} shutdown exit`)).toBe(1)
      await stderr.done
      expect(stderr.text()).toContain('[quirky-pty] shutdown failed:')
      expect(stderr.text()).toContain('EISDIR')
      expect(stderr.text()).not.toContain('[quirky-pty] unhandledRejection:')
      expect(existsSync(join(home, 'pty.pid'))).toBe(false)
    }, 30000)
  }

  test('shutdown replies before a stop failure is logged and exits 1 after removing pty.pid', async () => {
    const { home, scope } = scopedHome()
    const proc = scope.spawn([process.execPath, MAIN], { stdout: 'pipe', stderr: 'pipe' })
    const stderr = capture(proc.stderr)
    const client = await hostClient(home)

    rmSync(join(home, 'pty.sock'))
    mkdirSync(join(home, 'pty.sock'))
    expect(await client.request('shutdown', {})).toEqual({})

    expect(await exitCode(proc, 'shutdown request exit')).toBe(1)
    await stderr.done
    expect(stderr.text()).toContain('[quirky-pty] shutdown failed:')
    expect(stderr.text()).toContain('EISDIR')
    expect(stderr.text()).not.toContain('[quirky-pty] unhandledRejection:')
    expect(existsSync(join(home, 'pty.pid'))).toBe(false)
    client.close()
  }, 30000)
})
