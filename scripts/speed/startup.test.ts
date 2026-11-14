import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runtimeFilePath, writePrivateJson, type RuntimeInfo } from '@quirky/protocol/node'
import { watchReplacementRuntime } from './startup.ts'

function makeHome(): { home: string; cleanup(): void } {
  const home = mkdtempSync(join(tmpdir(), 'quirky-speed-startup-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

function runtime(pid: number): RuntimeInfo {
  return {
    pid,
    port: 4000,
    token: 'fixture-token',
    hookToken: 'fixture-hook-token',
    daemonVersion: 'fixture',
    protocolVersion: 1,
    startedAt: 1
  }
}

async function expectPending(promise: Promise<unknown>): Promise<void> {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
}

test('ignores an old daemon runtime until the replacement PID is published', async () => {
  const { home, cleanup } = makeHome()
  const expected = runtime(202)
  writePrivateJson(runtimeFilePath(home), runtime(101))
  const watcher = watchReplacementRuntime({ home, signal: new AbortController().signal, timeoutMs: 5_000 })
  try {
    watcher.expectSpawn({ spawnedAt: performance.now(), pid: expected.pid })
    await expectPending(watcher.runtime)
    writePrivateJson(runtimeFilePath(home), expected)
    await expect(watcher.runtime).resolves.toEqual(expected)
  } finally {
    watcher.dispose()
    cleanup()
  }
})

test('ignores incomplete runtime JSON and observes atomic runtime replacement', async () => {
  const { home, cleanup } = makeHome()
  const expected = runtime(303)
  writeFileSync(runtimeFilePath(home), '{"pid":')
  const watcher = watchReplacementRuntime({ home, signal: new AbortController().signal, timeoutMs: 5_000 })
  try {
    watcher.expectSpawn({ spawnedAt: performance.now(), pid: expected.pid })
    await expectPending(watcher.runtime)
    writePrivateJson(runtimeFilePath(home), expected)
    await expect(watcher.runtime).resolves.toEqual(expected)
  } finally {
    watcher.dispose()
    cleanup()
  }
})

test('reads an already-published matching runtime immediately on spawn notification', async () => {
  const { home, cleanup } = makeHome()
  const expected = runtime(404)
  writePrivateJson(runtimeFilePath(home), expected)
  const watcher = watchReplacementRuntime({ home, signal: new AbortController().signal, timeoutMs: 5_000 })
  try {
    watcher.expectSpawn({ spawnedAt: performance.now(), pid: expected.pid })
    await expect(watcher.runtime).resolves.toEqual(expected)
  } finally {
    watcher.dispose()
    cleanup()
  }
})

test('anchors the startup deadline to the spawn notification', async () => {
  const { home, cleanup } = makeHome()
  const watcher = watchReplacementRuntime({ home, signal: new AbortController().signal, timeoutMs: 1_000 })
  try {
    watcher.expectSpawn({ spawnedAt: performance.now() - 2_000, pid: 505 })
    await expect(watcher.runtime).rejects.toThrow(/deadline/i)
  } finally {
    watcher.dispose()
    cleanup()
  }
})

test('aborting rejects the runtime wait and disposal settles an unresolved wait', async () => {
  const { home, cleanup } = makeHome()
  const controller = new AbortController()
  const watcher = watchReplacementRuntime({ home, signal: controller.signal, timeoutMs: 5_000 })
  try {
    watcher.expectSpawn({ spawnedAt: performance.now(), pid: 606 })
    const aborted = watcher.runtime.then(() => undefined, (error: unknown) => error)
    controller.abort()
    expect(String(await aborted)).toMatch(/abort/i)

    const disposed = watchReplacementRuntime({ home, signal: new AbortController().signal, timeoutMs: 5_000 })
    try {
      disposed.expectSpawn({ spawnedAt: performance.now(), pid: 607 })
      const rejected = disposed.runtime.then(() => undefined, (error: unknown) => error)
      disposed.dispose()
      expect(String(await rejected)).toMatch(/dispos/i)
    } finally {
      disposed.dispose()
    }
  } finally {
    watcher.dispose()
    cleanup()
  }
})
test('rejects when the home-directory watcher cannot be created', async () => {
  const { home, cleanup } = makeHome()
  rmSync(home, { recursive: true, force: true })
  const watcher = watchReplacementRuntime({ home, signal: new AbortController().signal, timeoutMs: 5_000 })
  try {
    await expect(watcher.runtime).rejects.toThrow(/ENOENT|no such file/i)
  } finally {
    watcher.dispose()
    cleanup()
  }
})
