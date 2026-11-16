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
  let deadline: number | undefined
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

  const deadlineError = (pid: number) => new Error(`runtime.json for replacement PID ${pid} missed the startup deadline`)

  const onAbort = () => {
    const reason = options.signal.reason
    fail(reason instanceof Error ? reason : new Error('replacement runtime watch aborted'))
  }

  const readExpectedRuntime = () => {
    if (settled || expectedPid === undefined) return
    if (deadline !== undefined && performance.now() >= deadline) {
      fail(deadlineError(expectedPid))
      return
    }
    const candidate = readRuntime(options.home)
    if (candidate?.pid !== expectedPid) return
    if (deadline !== undefined && performance.now() >= deadline) {
      fail(deadlineError(expectedPid))
      return
    }
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
      const expectedDeadline = spawn.spawnedAt + options.timeoutMs
      deadline = expectedDeadline
      readExpectedRuntime()
      if (settled) return

      const remainingMs = expectedDeadline - performance.now()
      if (remainingMs <= 0) {
        fail(deadlineError(spawn.pid))
        return
      }
      timeout = setTimeout(() => {
        fail(deadlineError(spawn.pid))
      }, remainingMs)
    },
    runtime,
    dispose() {
      fail(new Error('replacement runtime watch disposed before runtime publication'))
    }
  }
}
