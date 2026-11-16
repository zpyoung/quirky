import { afterEach, describe, expect, jest, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { liveProcesses } from '@quirky/process'
import { runtimeFilePath } from '@quirky/protocol/node'
import { createShutdown } from '../src/shutdown'
import { startDaemon, type DaemonOptions } from '../src/daemon'
import { makeTempHome } from './helpers'
import { writeModulePlugin } from './plugins/fixtures'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function makeHome(): string {
  const home = makeTempHome('qd-shutdown-')
  homes.push(home)
  return home
}

function startTestDaemon(home: string, options: Partial<DaemonOptions> = {}) {
  return startDaemon({
    home,
    port: 0,
    notifier: () => {},
    uiDir: join(home, 'no-ui'),
    ptyHostEntry: join(home, 'missing.ts'),
    ptyConnectTimeoutMs: 300,
    hostPowerSource: null,
    ...options
  })
}

// Bun exposes timer advancement at runtime but omits it from the test typings.
const timerControls = jest as unknown as { advanceTimersByTime(ms: number): void }
const advanceTimersByTime = (ms: number): void => timerControls.advanceTimersByTime(ms)

describe('daemon shutdown', () => {
  test('bounds a plugin that never deactivates and continues cleanup', async () => {
    const home = makeHome()
    const logs: string[] = []
    writeModulePlugin(join(home, 'builtin'), join(home, 'plugin.log'), {
      id: 'acme.stuck',
      activation: 'startup'
    }, {
      deactivate: 'await new Promise(() => {})'
    })
    const daemon = await startTestDaemon(home, {
      builtinPluginsDir: join(home, 'builtin'),
      pluginActivationTimeoutMs: 60000,
      pluginStopTimeoutMs: 200,
      log: (message) => logs.push(message)
    })

    // A real daemon exercises its deadline alongside socket, server, store, and PTY cleanup.
    const deadline = Promise.withResolvers<boolean>()
    const timeout = setTimeout(() => deadline.resolve(false), 2800)
    let stopped: boolean
    try {
      stopped = await Promise.race([daemon.stop().then(() => true), deadline.promise])
    } finally {
      clearTimeout(timeout)
    }

    expect(stopped).toBe(true)
    expect(logs).toContain('plugins did not stop within 200 ms; continuing shutdown')
    expect(existsSync(runtimeFilePath(home))).toBe(false)
    expect(liveProcesses()).toEqual([])
  }, 5000)

  test('clean stop does not log a plugin stop timeout', async () => {
    const home = makeHome()
    const logs: string[] = []
    const daemon = await startTestDaemon(home, {
      builtinPluginsDir: null,
      pluginStopTimeoutMs: 200,
      log: (message) => logs.push(message)
    })

    await daemon.stop()

    expect(logs.some((message) => message.includes('did not stop within'))).toBe(false)
  })
})
async function withFakeTimers(action: () => Promise<void>): Promise<void> {
  jest.useFakeTimers()
  try {
    await action()
  } finally {
    jest.useRealTimers()
  }
}

describe('process shutdown deadline', () => {
  test('calls the deadline handler and exits with code 1 when stop misses its deadline', async () => {
    await withFakeTimers(async () => {
      const events: string[] = []
      const logs: string[] = []
      const shutdown = createShutdown({
        stop: () => Promise.withResolvers<void>().promise,
        onDeadline: () => events.push('deadline'),
        release: () => events.push('release'),
        exit: (code) => events.push(`exit ${code}`),
        log: (message) => logs.push(message),
        deadlineMs: 50
      })

      shutdown()
      advanceTimersByTime(50)

      expect(events).toEqual(['deadline', 'release', 'exit 1'])
      expect(logs).toContain('stop did not finish within 50 ms; exiting')
    })
  })

  test('releases and exits cleanly when stop resolves before its deadline', async () => {
    await withFakeTimers(async () => {
      const events: string[] = []
      const stopped = Promise.withResolvers<void>()
      setTimeout(() => stopped.resolve(), 10)
      const shutdown = createShutdown({
        stop: () => stopped.promise,
        onDeadline: () => events.push('deadline'),
        release: () => events.push('release'),
        exit: (code) => events.push(`exit ${code}`),
        log: () => {},
        deadlineMs: 50
      })

      shutdown()
      advanceTimersByTime(10)
      await Promise.resolve()
      advanceTimersByTime(80)

      expect(events).toEqual(['release', 'exit 0'])
    })
  })

  test('releases and exits cleanly when stop rejects before its deadline', async () => {
    await withFakeTimers(async () => {
      const events: string[] = []
      const stopped = Promise.withResolvers<void>()
      setTimeout(() => stopped.reject(new Error('stop failed')), 10)
      const shutdown = createShutdown({
        stop: () => stopped.promise,
        onDeadline: () => events.push('deadline'),
        release: () => events.push('release'),
        exit: (code) => events.push(`exit ${code}`),
        log: () => {},
        deadlineMs: 50
      })

      shutdown()
      advanceTimersByTime(10)
      await Promise.resolve()
      advanceTimersByTime(80)

      expect(events).toEqual(['release', 'exit 0'])
    })
  })

  test('ignores repeated shutdown signals', async () => {
    await withFakeTimers(async () => {
      let stops = 0
      const events: string[] = []
      const shutdown = createShutdown({
        stop: () => {
          stops += 1
          return Promise.withResolvers<void>().promise
        },
        onDeadline: () => events.push('deadline'),
        release: () => events.push('release'),
        exit: (code) => events.push(`exit ${code}`),
        log: () => {},
        deadlineMs: 50
      })

      shutdown()
      shutdown()
      shutdown()
      advanceTimersByTime(50)

      expect(stops).toBe(1)
      expect(events).toEqual(['deadline', 'release', 'exit 1'])
    })
  })
})
