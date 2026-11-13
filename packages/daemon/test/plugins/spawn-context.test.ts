import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PLUGIN_API_VERSION,
  type PluginContext,
  type QuirkyClient,
  type SpawnExit,
  type SpawnedProcess
} from '@quirky/protocol'
import { createProcessRunner, liveProcesses, type OwnedProcessRunner } from '../../../process/src/api'
import { startHarness, waitFor, type Harness } from '../helpers'
import { writePlugin } from './fixtures'

type ProcessFacade = PluginContext['process']

type Capture = {
  process?: ProcessFacade
  handles: SpawnedProcess[]
  activationHandle?: SpawnedProcess
  deactivationResult?: { stdout: string; exitCode: number | null; signal: string | null }
}

type FixtureOptions = {
  id: string
  apiVersion?: string
  activation?: 'startup' | 'lazy'
  failActivation?: boolean
  spawnInDeactivate?: boolean
  throwInDeactivate?: boolean
}

let harness: Harness | undefined
let home: string | undefined
let client: QuirkyClient | undefined
let kernelRunner: OwnedProcessRunner | undefined
const captureKey = `__g2_15_spawn_context_${randomUUID()}`
const trackedHandles = new Set<SpawnedProcess>()
const recordedPids = new Set<number>()
const descendantFiles: { leader: string; grandchild: string }[] = []

afterEach(async () => {
  const failures: unknown[] = []
  const attempt = async (action: () => void | Promise<void>) => {
    try {
      await action()
    } catch (error) {
      failures.push(error)
    }
  }

  const captures = (globalThis as unknown as Record<string, Record<string, Capture> | undefined>)[captureKey]
  for (const capture of Object.values(captures ?? {})) {
    for (const handle of capture.handles ?? []) trackedHandles.add(handle)
  }
  for (const handle of trackedHandles) {
    if (handle.pid !== null) recordedPids.add(handle.pid)
    await attempt(async () => { await handle.stop({ signal: 'SIGKILL' }) })
  }
  for (const paths of descendantFiles) {
    for (const path of [paths.leader, paths.grandchild]) {
      try {
        const pid = Number(readFileSync(path, 'utf8').trim())
        if (Number.isSafeInteger(pid) && pid > 0) recordedPids.add(pid)
      } catch {}
    }
  }
  for (const pid of recordedPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  await attempt(async () => kernelRunner?.dispose())
  await attempt(async () => harness?.cleanup())
  if (!harness && home) await attempt(() => rmSync(home!, { recursive: true, force: true }))

  delete (globalThis as unknown as Record<string, unknown>)[captureKey]
  harness = undefined
  home = undefined
  client = undefined
  kernelRunner = undefined
  trackedHandles.clear()
  recordedPids.clear()
  descendantFiles.length = 0
  if (failures.length > 0) throw new AggregateError(failures, 'spawn context test cleanup failed')
})

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function pluginSource(options: FixtureOptions): string {
  const id = JSON.stringify(options.id)
  const key = JSON.stringify(captureKey)
  const activate = options.failActivation
    ? [
        "const handle = context.process.spawn(['/bin/sleep', '30'], { timeoutMs: null })",
        'capture.handles.push(handle)',
        'capture.activationHandle = handle',
        "throw new Error('intentional activation failure')"
      ].join('\n  ')
    : ''
  const deactivate = options.spawnInDeactivate
    ? [
        "const handle = capture.process.spawn(['/bin/sh', '-c', 'printf bye'], { timeoutMs: 5000 })",
        'capture.handles.push(handle)',
        'const reader = handle.stdout.getReader()',
        'const decoder = new TextDecoder()',
        "let stdout = ''",
        'for (;;) {',
        '  const { value, done } = await reader.read()',
        '  if (done) break',
        '  stdout += decoder.decode(value, { stream: true })',
        '}',
        'stdout += decoder.decode()',
        'const result = await handle.exited',
        'capture.deactivationResult = { stdout, exitCode: result.exitCode, signal: result.signal }'
      ].join('\n  ')
    : ''
  const throwInDeactivate = options.throwInDeactivate
    ? "throw new Error('intentional deactivation failure')"
    : ''

  return `const captures = globalThis[${key}] ??= Object.create(null)
const capture = captures[${id}] ??= { handles: [] }
export async function activate(context) {
  capture.process = context.process
  ${activate}
}
export async function deactivate() {
  ${deactivate}
  ${throwInDeactivate}
}
`
}

async function boot(...plugins: FixtureOptions[]): Promise<void> {
  home = mkdtempSync(join(tmpdir(), 'spawn-context-'))
  const pluginRoot = join(home, 'plugins')
  mkdirSync(pluginRoot, { recursive: true })
  ;(globalThis as unknown as Record<string, unknown>)[captureKey] = Object.create(null)
  for (const options of plugins) {
    writePlugin(
      pluginRoot,
      {
        id: options.id,
        name: `Spawn fixture ${options.id}`,
        version: '1.0.0',
        apiVersion: options.apiVersion ?? PLUGIN_API_VERSION,
        main: 'main.ts',
        activation: options.activation ?? 'startup'
      },
      { 'main.ts': pluginSource(options) }
    )
  }
  harness = await startHarness({ home, builtinPluginsDir: pluginRoot })
  client = await harness.connect('cli')
}

function captureFor(id: string): Capture {
  const captures = (globalThis as unknown as Record<string, Record<string, Capture> | undefined>)[captureKey]
  const capture = captures?.[id]
  if (!capture) throw new Error(`missing in-process capture for ${id}`)
  for (const handle of capture.handles ?? []) trackedHandles.add(handle)
  return capture
}

function processFor(id: string): ProcessFacade {
  const process = captureFor(id).process
  if (!process) throw new Error(`missing process context for ${id}`)
  return process
}

function trackHandle(id: string, handle: SpawnedProcess): SpawnedProcess {
  trackedHandles.add(handle)
  const capture = captureFor(id)
  if (!capture.handles.includes(handle)) capture.handles.push(handle)
  if (handle.pid !== null) recordedPids.add(handle.pid)
  return handle
}

function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  if (!client) throw new Error('test harness is not connected')
  return client.callAny(method, params)
}

function syncError(action: () => unknown): unknown {
  let returned: unknown
  let thrown: unknown
  try {
    returned = action()
  } catch (error) {
    thrown = error
  }
  if (returned instanceof Promise) void returned.catch(() => {})
  return thrown
}

function pidFromFile(path: string): number {
  const pid = Number(readFileSync(path, 'utf8').trim())
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid pid in ${path}`)
  recordedPids.add(pid)
  return pid
}

function pidIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

async function waitForPidGone(pid: number): Promise<void> {
  await waitFor(() => pidIsGone(pid) ? true : false, 2_000)
}

function assertAbortedSigkill(exit: SpawnExit): void {
  expect(exit).toMatchObject({ stopped: 'aborted', signal: 'SIGKILL' })
}

describe('PluginContext.process.spawn lifecycle', () => {
  test('exposes run and spawn for API 1.0.0 and the current API floor', async () => {
    await boot(
      { id: 'acme.old', apiVersion: '1.0.0' },
      { id: 'acme.proc', apiVersion: PLUGIN_API_VERSION }
    )

    for (const id of ['acme.old', 'acme.proc']) {
      const process = processFor(id)
      expect(Object.keys(process)).toEqual(['run', 'spawn'])
      expect(Object.isFrozen(process)).toBe(true)
      expect(typeof process.run).toBe('function')
      expect(typeof process.spawn).toBe('function')
      expect('owner' in process).toBe(false)
      expect('live' in process).toBe(false)
      expect('dispose' in process).toBe(false)

      const result = await process.run(['/bin/sh', '-c', 'printf hi'])
      expect(result).toMatchObject({ stdoutText: 'hi', exitCode: 0, signal: null })
      expect(result).not.toHaveProperty('stopped')
      expect(result).not.toHaveProperty('spawnError')
    }
  })

  test('returns a streaming handle synchronously and keeps stdin open until requested', async () => {
    await boot({ id: 'acme.proc' })
    const process = processFor('acme.proc')
    const handle = trackHandle('acme.proc', process.spawn(['/bin/cat'], { stdin: 'pipe', timeoutMs: 5000 }))

    expect(handle).not.toBeInstanceOf(Promise)
    expect(handle.pid).toBeGreaterThan(0)
    expect(Number.isInteger(handle.pid)).toBe(true)
    expect(handle.stdout).toBeInstanceOf(ReadableStream)

    let exitSettled = false
    void handle.exited.then(() => { exitSettled = true })
    expect(await handle.write('ping\n')).toBe(true)
    const reader = handle.stdout.getReader()
    const chunks: Uint8Array[] = []
    let byteLength = 0
    while (byteLength < 5) {
      const { value, done } = await reader.read()
      if (done || !value) throw new Error('cat stdout ended before echoing input')
      chunks.push(value)
      byteLength += value.length
    }
    const bytes = new Uint8Array(byteLength)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    expect(new TextDecoder().decode(bytes)).toBe('ping\n')
    expect(exitSettled).toBe(false)

    await handle.closeInput()
    for (;;) {
      const { done } = await reader.read()
      if (done) break
    }
    const exit = await handle.exited
    expect(exit).toMatchObject({ exitCode: 0, signal: null })
    expect(exit).not.toHaveProperty('stopped')
    expect(exit).not.toHaveProperty('spawnError')
    expect(await handle.write('late')).toBe(false)
  })

  test('preserves synchronous validation and resolves start and abort failures as handles', async () => {
    await boot({ id: 'acme.proc' })
    const process = processFor('acme.proc')

    const argvError = syncError(() => process.spawn([], { timeoutMs: 1000 }))
    expect(argvError).toBeInstanceOf(TypeError)
    expect((argvError as Error | undefined)?.message).toBe('argv must name a command')

    const missingTimeoutError = syncError(() => {
      // @ts-expect-error runtime validation must reject an absent deadline.
      return process.spawn(['/bin/true'], {})
    })
    expect(missingTimeoutError).toBeInstanceOf(RangeError)
    expect((missingTimeoutError as Error | undefined)?.message).toBe('timeoutMs must be a positive finite number or null')

    const failedStart = trackHandle(
      'acme.proc',
      process.spawn(['/nonexistent/quirky-g2-15'], { timeoutMs: 1000 })
    )
    const failedStartRead = await failedStart.stdout.getReader().read()
    const failedStartWrite = await failedStart.write('x')
    const failedStartExit = await failedStart.exited
    expect(failedStart.pid).toBe(null)
    expect(failedStartRead.done).toBe(true)
    expect(failedStart.stderrTail()).toBe('')
    expect(failedStartWrite).toBe(false)
    expect(failedStartExit.exitCode).toBe(null)
    expect(failedStartExit.signal).toBe(null)
    expect(failedStartExit.spawnError?.code).toBe('ENOENT')
    expect(failedStartExit.spawnError?.message.length).toBeGreaterThan(0)

    const controller = new AbortController()
    controller.abort()
    const aborted = trackHandle(
      'acme.proc',
      process.spawn(['/bin/sleep', '30'], { timeoutMs: null, signal: controller.signal })
    )
    const abortedExit = await aborted.exited
    expect(aborted.pid).toBe(null)
    expect(abortedExit).toEqual({ exitCode: null, signal: null, stopped: 'aborted', durationMs: 0 })
    expect(liveProcesses().filter((entry) => entry.owner === 'acme.proc')).toEqual([])
  })

  test('unload disposes the activation, ends stdout, and leaves stale contexts disposed after reenable', async () => {
    await boot({ id: 'acme.proc' })
    const staleProcess = processFor('acme.proc')
    const handle = trackHandle('acme.proc', staleProcess.spawn(['/bin/sleep', '30'], { timeoutMs: null }))
    const pid = handle.pid!
    const owned = liveProcesses().filter((entry) => entry.owner === 'acme.proc')
    expect(owned).toHaveLength(1)
    expect(owned[0]).toMatchObject({ owner: 'acme.proc', command: '/bin/sleep', pid })

    const pendingRead = handle.stdout.getReader().read()

    await call('plugin.disable', { id: 'acme.proc' })
    expect(pidIsGone(pid)).toBe(true)
    const exit = await handle.exited
    expect(exit).toEqual({
      exitCode: null,
      signal: 'SIGKILL',
      stopped: 'aborted',
      durationMs: expect.any(Number)
    })
    expect(Number.isInteger(exit.durationMs)).toBe(true)
    expect(exit.durationMs).toBeGreaterThanOrEqual(0)
    expect(await pendingRead).toEqual({ done: true, value: undefined })
    expect(liveProcesses().filter((entry) => entry.owner === 'acme.proc')).toEqual([])

    const staleError = syncError(() => staleProcess.spawn(['/bin/true'], { timeoutMs: 1000 }))
    expect((staleError as Error | undefined)?.name).toBe('ProcessRunnerDisposedError')
    expect((staleError as Error | undefined)?.message).toBe('process runner "acme.proc" is disposed')

    await call('plugin.enable', { id: 'acme.proc' })
    const freshProcess = processFor('acme.proc')
    expect(freshProcess).not.toBe(staleProcess)
    const freshHandle = trackHandle('acme.proc', freshProcess.spawn(['/usr/bin/true'], { timeoutMs: 1000 }))
    const freshExit = await freshHandle.exited
    expect(freshExit).toMatchObject({ exitCode: 0, signal: null })
    expect(freshExit).not.toHaveProperty('stopped')

    const staleAgain = syncError(() => staleProcess.spawn(['/bin/true'], { timeoutMs: 1000 }))
    expect((staleAgain as Error | undefined)?.name).toBe('ProcessRunnerDisposedError')
    expect((staleAgain as Error | undefined)?.message).toBe('process runner "acme.proc" is disposed')
  })

  test('unload kills a shell-held descendant in the spawned process group', async () => {
    await boot({ id: 'acme.proc' })
    const leaderFile = join(home!, 'shell-leader.pid')
    const grandchildFile = join(home!, 'shell-grandchild.pid')
    descendantFiles.push({ leader: leaderFile, grandchild: grandchildFile })
    const command = `sleep 30 & echo $! > ${shellQuote(grandchildFile)}; echo $$ > ${shellQuote(leaderFile)}; wait`
    const handle = trackHandle(
      'acme.proc',
      processFor('acme.proc').spawn(['/bin/sh', '-c', command], { timeoutMs: null })
    )
    await waitFor(() => existsSync(leaderFile) && existsSync(grandchildFile))
    const leader = pidFromFile(leaderFile)
    const grandchild = pidFromFile(grandchildFile)
    expect(handle.pid).toBe(leader)

    await call('plugin.disable', { id: 'acme.proc' })
    await waitForPidGone(leader)
    await waitForPidGone(grandchild)
    assertAbortedSigkill(await handle.exited)
  })

  test('disabling one plugin does not dispose another plugin child', async () => {
    await boot({ id: 'acme.proc' }, { id: 'acme.other' })
    const process = processFor('acme.proc')
    const otherProcess = processFor('acme.other')
    const ownedHandle = trackHandle('acme.proc', process.spawn(['/bin/sleep', '30'], { timeoutMs: null }))
    const otherHandle = trackHandle('acme.other', otherProcess.spawn(['/bin/sleep', '30'], { timeoutMs: null }))
    const ownedPid = ownedHandle.pid!
    const otherPid = otherHandle.pid!

    await waitFor(() => liveProcesses().filter((entry) => entry.owner === 'acme.proc' || entry.owner === 'acme.other').length === 2)
    const otherBefore = liveProcesses().find((entry) => entry.owner === 'acme.other')
    expect(liveProcesses().filter((entry) => entry.owner === 'acme.proc')).toMatchObject([
      { owner: 'acme.proc', command: '/bin/sleep', pid: ownedPid }
    ])
    expect(otherBefore).toMatchObject({ owner: 'acme.other', command: '/bin/sleep', pid: otherPid })

    await call('plugin.disable', { id: 'acme.proc' })
    await waitForPidGone(ownedPid)
    expect(pidIsGone(otherPid)).toBe(false)
    expect(liveProcesses().map((entry) => entry.owner).sort()).toEqual(['acme.other'])
    expect(liveProcesses()[0]).toMatchObject({ owner: 'acme.other', command: '/bin/sleep', pid: otherPid })
  })

  test('deactivation can spawn and await a child before runner disposal', async () => {
    await boot({ id: 'acme.proc', spawnInDeactivate: true })
    await call('plugin.disable', { id: 'acme.proc' })
    const capture = captureFor('acme.proc')
    expect(capture.deactivationResult).toEqual({ stdout: 'bye', exitCode: 0, signal: null })
    expect(liveProcesses().filter((entry) => entry.owner === 'acme.proc')).toEqual([])
  })

  test('failed activation disposes a child spawned before the intentional failure', async () => {
    await boot({ id: 'acme.fails', activation: 'lazy', failActivation: true })
    let activationError: unknown
    try {
      await call('plugin.activate', { pluginId: 'acme.fails' })
    } catch (error) {
      activationError = error
    }
    const capture = captureFor('acme.fails')
    const handle = capture.activationHandle
    if (!handle) throw new Error('failed activation did not capture its spawned child')
    trackHandle('acme.fails', handle)
    const pid = handle.pid
    const exit = await handle.exited

    expect((activationError as Error | undefined)?.message).toContain('failed to activate')
    expect((activationError as Error | undefined)?.message).toContain('intentional activation failure')
    expect(pid).toBeGreaterThan(0)
    await waitForPidGone(pid!)
    assertAbortedSigkill(exit)
    expect(liveProcesses().filter((entry) => entry.owner === 'acme.fails')).toEqual([])
  })

  for (const throwInDeactivate of [false, true]) {
    test(`daemon shutdown stops plugin and kernel spawn handles${throwInDeactivate ? ' when deactivation throws' : ''}`, async () => {
      await boot({ id: 'acme.proc', throwInDeactivate })
      const pluginHandle = trackHandle(
        'acme.proc',
        processFor('acme.proc').spawn(['/bin/sleep', '30'], { timeoutMs: null })
      )
      const runner = createProcessRunner({ owner: 'kernel-test' })
      kernelRunner = runner
      const kernelHandle = runner.spawn(['/bin/sleep', '30'], { timeoutMs: null })
      trackedHandles.add(kernelHandle)
      if (kernelHandle.pid !== null) recordedPids.add(kernelHandle.pid)
      const pluginPid = pluginHandle.pid!
      const kernelPid = kernelHandle.pid!
      await waitFor(() => liveProcesses().filter((entry) => entry.owner === 'acme.proc' || entry.owner === 'kernel-test').length === 2)

      await harness!.daemon.stop()
      expect(pidIsGone(pluginPid)).toBe(true)
      expect(pidIsGone(kernelPid)).toBe(true)
      assertAbortedSigkill(await pluginHandle.exited)
      assertAbortedSigkill(await kernelHandle.exited)
      expect(liveProcesses()).toEqual([])
    })
  }
})
