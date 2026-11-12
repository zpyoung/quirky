import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLUGIN_API_VERSION, type QuirkyClient, type RunResult } from '@quirky/protocol'
import { createProcessRunner, liveProcesses, type OwnedProcessRunner } from '../../../process/src/api'
import { startHarness, waitFor, type Harness } from '../helpers'
import { writePlugin } from './fixtures'

let harness: Harness | undefined
let home: string | undefined
let marker: string | undefined
let client: QuirkyClient | undefined
let kernelRunner: OwnedProcessRunner | undefined
const recordedPids = new Set<number>()
const childFiles = new Map<string, { leader: string; grandchild: string }>()

type FixtureOptions = {
  id: string
  apiVersion?: string
  activationFails?: boolean
  runInDeactivate?: boolean
  staleAfterDeactivate?: boolean
  throwInDeactivate?: boolean
}

afterEach(async () => {
  try {
    for (const paths of childFiles.values()) {
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
    try {
      await kernelRunner?.dispose()
    } catch {}
    try {
      await harness?.cleanup()
    } catch {}
    if (!harness && home) {
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {}
    }
  } finally {
    harness = undefined
    home = undefined
    marker = undefined
    client = undefined
    kernelRunner = undefined
    recordedPids.clear()
    childFiles.clear()
  }
})

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function pluginSource(options: FixtureOptions, markerPath: string, leaderPath: string, grandchildPath: string): string {
  const childCommand = `sleep 300 & echo $! > ${shellQuote(grandchildPath)}; echo $$ > ${shellQuote(leaderPath)}; wait`
  const heldArgv = JSON.stringify(['/bin/sh', '-c', childCommand])
  const activation = options.activationFails
    ? [
        `held = context.process.run(${heldArgv}, { timeoutMs: 600_000 })`,
        `void held.then((result) => report({ type: 'held-result', result }), (error) => report({ type: 'held-error', message: String(error) }))`,
        'await waitForChildPids()',
        "throw new Error('activation fixture failure')"
      ].join('\n  ')
    : [
        "context.provide('method:" + options.id + "/run', async () => {",
        "  const result = await context.process.run(['/bin/sh', '-c', 'printf hi'])",
        "  report({ type: 'run-result', result })",
        '  return result',
        '})',
        "context.provide('method:" + options.id + "/shape', () => {",
        '  const runner = context.process',
        '  const shape = { keys: Object.keys(runner), frozen: Object.isFrozen(runner), hasSpawn: \'spawn\' in runner, hasDispose: \'dispose\' in runner, hasLive: \'live\' in runner }',
        "  report({ type: 'shape', shape })",
        '  return shape',
        '})',
        "context.provide('method:" + options.id + "/hold', () => {",
        `  held = context.process.run(${heldArgv}, { timeoutMs: 600_000 })`,
        `  void held.then((result) => report({ type: 'held-result', result }), (error) => report({ type: 'held-error', message: String(error) }))`,
        '  return { started: true }',
        '})'
      ].join('\n  ')
  const deactivation: string[] = []
  if (options.runInDeactivate) {
    deactivation.push(
      "const result = await activeContext.process.run(['/bin/sh', '-c', 'printf bye'])",
      "report({ type: 'deactivate-result', result })"
    )
  }
  if (options.staleAfterDeactivate) {
    deactivation.push(`if (held) void held.then(async () => {
      try {
        await activeContext.process.run(['/bin/echo', 'again'])
        report({ type: 'stale-result', succeeded: true })
      } catch (error) {
        report({ type: 'stale-result', name: error?.name ?? '', message: error instanceof Error ? error.message : String(error) })
      }
    })`)
  }
  if (options.throwInDeactivate) deactivation.push("throw new Error('fixture deactivate failure')")

  return `import { appendFileSync, existsSync } from 'node:fs'
const markerPath = ${JSON.stringify(markerPath)}
const leaderPath = ${JSON.stringify(leaderPath)}
const grandchildPath = ${JSON.stringify(grandchildPath)}
const report = (entry) => appendFileSync(markerPath, JSON.stringify({ plugin: ${JSON.stringify(options.id)}, ...entry }) + '\\n')
const waitForChildPids = async () => {
  const deadline = Date.now() + 2_000
  while (!existsSync(leaderPath) || !existsSync(grandchildPath)) {
    if (Date.now() >= deadline) throw new Error('fixture child did not write pid files')
    // Poll the real child-written pid files; a process launch cannot use fake timers.
    await Bun.sleep(5)
  }
}
let activeContext
let held
export async function activate(context) {
  activeContext = context
  ${activation}
}
export async function deactivate() {
  ${deactivation.join('\n  ')}
}
`
}

function writeProcessPlugin(root: string, markerPath: string, options: FixtureOptions): void {
  const leader = join(root, `${options.id}.leader.pid`)
  const grandchild = join(root, `${options.id}.grandchild.pid`)
  childFiles.set(options.id, { leader, grandchild })
  writePlugin(
    root,
    {
      id: options.id,
      name: `Process fixture ${options.id}`,
      version: '1.0.0',
      apiVersion: options.apiVersion ?? PLUGIN_API_VERSION,
      main: 'main.ts',
      activation: options.activationFails ? 'lazy' : 'startup',
      contributes: { method: [{ id: 'run' }, { id: 'shape' }, { id: 'hold' }] }
    },
    { 'main.ts': pluginSource(options, markerPath, leader, grandchild) }
  )
}

async function boot(...plugins: FixtureOptions[]): Promise<{ client: QuirkyClient }> {
  home = mkdtempSync(join(tmpdir(), 'process-context-'))
  const pluginRoot = join(home, 'plugins')
  mkdirSync(pluginRoot, { recursive: true })
  marker = join(home, 'process-marker.log')
  for (const options of plugins) writeProcessPlugin(pluginRoot, marker, options)
  harness = await startHarness({ home, builtinPluginsDir: pluginRoot })
  client = await harness.connect('cli')
  return { client: client! }
}

function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return client!.callAny(method, params)
}

function readEvents(plugin: string): Record<string, unknown>[] {
  if (!marker || !existsSync(marker)) return []
  return readFileSync(marker, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => event.plugin === plugin)
}

function eventOf(plugin: string, type: string): Record<string, unknown> | undefined {
  return readEvents(plugin).find((event) => event.type === type)
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

async function hold(plugin: string): Promise<{ leader: number; grandchild: number }> {
  await call(`${plugin}/hold`)
  const paths = childFiles.get(plugin)!
  await waitFor(() => existsSync(paths.leader) && existsSync(paths.grandchild))
  const leader = pidFromFile(paths.leader)
  const grandchild = pidFromFile(paths.grandchild)
  await waitFor(() => liveProcesses().some((entry) => entry.owner === plugin && entry.pid === leader))
  return { leader, grandchild }
}

describe('PluginContext.process lifecycle', () => {
  test('runs a command and exposes only a frozen run method', async () => {
    await boot({ id: 'acme.proc' })
    const result = await call('acme.proc/run') as Record<string, unknown>
    expect(result).toMatchObject({ stdoutText: 'hi', exitCode: 0, signal: null })
    expect(result).not.toHaveProperty('stopped')
    expect(result).not.toHaveProperty('spawnError')

    const shape = await call('acme.proc/shape')
    expect(shape).toEqual({
      keys: ['run'],
      frozen: true,
      hasSpawn: false,
      hasDispose: false,
      hasLive: false
    })
  })

  test('disabling waits for the process tree, abort result, and stale context rejection before reenable', async () => {
    await boot({ id: 'acme.proc', staleAfterDeactivate: true })
    const { leader, grandchild } = await hold('acme.proc')
    const owned = liveProcesses().filter((entry) => entry.owner === 'acme.proc')
    expect(owned).toHaveLength(1)
    expect(owned[0]).toMatchObject({ command: '/bin/sh', pid: leader })

    await call('plugin.disable', { id: 'acme.proc' })
    expect(pidIsGone(leader)).toBe(true)
    await waitFor(() => pidIsGone(grandchild), 2_000)
    const heldResult = await waitFor(() => eventOf('acme.proc', 'held-result') ?? false, 2_000)
    expect(heldResult.result).toMatchObject({ stopped: 'aborted', exitCode: null, signal: 'SIGKILL' })
    expect(liveProcesses().filter((entry) => entry.owner === 'acme.proc')).toEqual([])

    const stale = await waitFor(() => eventOf('acme.proc', 'stale-result') ?? false, 2_000)
    expect(stale).toMatchObject({
      name: 'ProcessRunnerDisposedError',
      message: 'process runner "acme.proc" is disposed'
    })

    await call('plugin.enable', { id: 'acme.proc' })
    const result = await call('acme.proc/run') as Record<string, unknown>
    expect(result).toMatchObject({ stdoutText: 'hi', exitCode: 0, signal: null })
    expect(result).not.toHaveProperty('stopped')
    expect(result).not.toHaveProperty('spawnError')
  })

  test('deactivate can run a command before its runner is disposed', async () => {
    await boot({ id: 'acme.proc', runInDeactivate: true })
    await call('plugin.disable', { id: 'acme.proc' })
    const deactivation = eventOf('acme.proc', 'deactivate-result')
    expect(deactivation?.result).toMatchObject({ stdoutText: 'bye', exitCode: 0 })
  })

  test('a failed activation kills its held child and removes its owner entry', async () => {
    const { client: testClient } = await boot({ id: 'acme.fails', activationFails: true })
    const activation = testClient.callAny('plugin.activate', { pluginId: 'acme.fails' })
    const paths = childFiles.get('acme.fails')!
    await waitFor(() => existsSync(paths.leader) && existsSync(paths.grandchild))
    const leader = pidFromFile(paths.leader)
    const grandchild = pidFromFile(paths.grandchild)

    await expect(activation).rejects.toThrow(/failed to activate/i)
    expect(pidIsGone(leader)).toBe(true)
    await waitFor(() => pidIsGone(grandchild), 2_000)
    expect(liveProcesses().filter((entry) => entry.owner === 'acme.fails')).toEqual([])
  })

  test('disabling one plugin leaves another plugin child running', async () => {
    await boot({ id: 'acme.proc' }, { id: 'acme.other' })
    await hold('acme.proc')
    const other = await hold('acme.other')

    await call('plugin.disable', { id: 'acme.proc' })
    expect(pidIsGone(other.leader)).toBe(false)
    expect(liveProcesses().filter((entry) => entry.owner === 'acme.other')).toMatchObject([
      { owner: 'acme.other', command: '/bin/sh', pid: other.leader }
    ])
  })

  test('daemon stop kills plugin and kernel runner children', async () => {
    await boot({ id: 'acme.proc' })
    const plugin = await hold('acme.proc')
    const runner = createProcessRunner({ owner: 'kernel-test' })
    kernelRunner = runner
    const kernelRun = runner.run(['/bin/sleep', '300'], { timeoutMs: 600_000 })
    void kernelRun.catch(() => {})
    await waitFor(() => liveProcesses().some((entry) => entry.owner === 'kernel-test'))
    const kernel = liveProcesses().find((entry) => entry.owner === 'kernel-test')!
    recordedPids.add(kernel.pid)

    await harness!.daemon.stop()
    expect(pidIsGone(plugin.leader)).toBe(true)
    expect(pidIsGone(kernel.pid)).toBe(true)
    expect(liveProcesses()).toEqual([])
    await expect(kernelRun).resolves.toMatchObject({ stopped: 'aborted' })
  })

  test('daemon stop kills every child even when deactivate throws', async () => {
    await boot({ id: 'acme.proc', throwInDeactivate: true })
    const plugin = await hold('acme.proc')
    const runner = createProcessRunner({ owner: 'kernel-test' })
    kernelRunner = runner
    const kernelRun = runner.run(['/bin/sleep', '300'], { timeoutMs: 600_000 })
    void kernelRun.catch(() => {})
    await waitFor(() => liveProcesses().some((entry) => entry.owner === 'kernel-test'))
    const kernel = liveProcesses().find((entry) => entry.owner === 'kernel-test')!
    recordedPids.add(kernel.pid)

    await harness!.daemon.stop()
    expect(pidIsGone(plugin.leader)).toBe(true)
    expect(pidIsGone(kernel.pid)).toBe(true)
    expect(liveProcesses()).toEqual([])
  })

  test('a plugin declaring API 1.0.0 can use context.process.run', async () => {
    await boot({ id: 'acme.proc', apiVersion: '1.0.0' })
    const result = await call('acme.proc/run') as Record<string, unknown>
    expect(result).toMatchObject({ stdoutText: 'hi', exitCode: 0, signal: null })
    expect(result).not.toHaveProperty('stopped')
    expect(result).not.toHaveProperty('spawnError')
  })
})
