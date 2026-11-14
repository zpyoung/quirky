import { watch as watchDirectory, type FSWatcher } from 'node:fs'
import { basename } from 'node:path'
import { readRuntime, runtimeFilePath, type RuntimeInfo } from '@quirky/protocol/node'
import type { DaemonSpawn } from '../soak/world.ts'

export function watchReplacementRuntime(options: {
  home: string
  signal: AbortSignal
  timeoutMs: number
}): {
  expectSpawn(spawn: DaemonSpawn): void
  runtime: Promise<RuntimeInfo>
  dispose(): void
} {
  const { promise: runtime, resolve, reject } = Promise.withResolvers<RuntimeInfo>()
  const runtimeName = basename(runtimeFilePath(options.home))
  let watcher: FSWatcher | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let expectedPid: number | undefined
  let settled = false

  const close = () => {
    if (timeout !== undefined) {
      clearTimeout(timeout)
      timeout = undefined
    }
    options.signal.removeEventListener('abort', onAbort)
    watcher?.close()
    watcher = undefined
  }

  const fail = (error: unknown) => {
    if (settled) return
    settled = true
    close()
    reject(error)
  }

  const onAbort = () => {
    const reason = options.signal.reason
    fail(reason instanceof Error ? reason : new Error('replacement runtime watch aborted'))
  }

  const readExpectedRuntime = () => {
    if (settled || expectedPid === undefined) return
    const candidate = readRuntime(options.home)
    if (candidate?.pid !== expectedPid) return
    settled = true
    close()
    resolve(candidate)
  }

  if (options.signal.aborted) {
    onAbort()
  } else {
    options.signal.addEventListener('abort', onAbort, { once: true })
    try {
      watcher = watchDirectory(options.home, (_eventType, filename) => {
        if (filename !== null && basename(filename.toString()) !== runtimeName) return
        readExpectedRuntime()
      })
      watcher.on('error', fail)
    } catch (error) {
      fail(error)
    }
  }

  return {
    expectSpawn(spawn) {
      if (settled) return
      if (expectedPid !== undefined) {
        fail(new Error('replacement spawn was already registered'))
        return
      }
      if (!Number.isSafeInteger(spawn.pid) || spawn.pid <= 0 || !Number.isFinite(spawn.spawnedAt)) {
        fail(new Error('replacement spawn notification is invalid'))
        return
      }

      expectedPid = spawn.pid
      readExpectedRuntime()
      if (settled) return

      const remainingMs = spawn.spawnedAt + options.timeoutMs - performance.now()
      if (remainingMs <= 0) {
        fail(new Error(`runtime.json for replacement PID ${spawn.pid} missed the startup deadline`))
        return
      }
      timeout = setTimeout(() => {
        fail(new Error(`runtime.json for replacement PID ${spawn.pid} missed the startup deadline`))
      }, remainingMs)
    },
    runtime,
    dispose() {
      fail(new Error('replacement runtime watch disposed before runtime publication'))
    }
  }
}
