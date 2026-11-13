import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { EditorBuffer, EditorServices, FeatureMethods } from '../src/types'
import type { PluginCaller, PluginContext, ProcessSpawner, SpawnExit, SpawnOptions, SpawnedProcess, StopOptions } from '@quirky/protocol'
import { createProcessRunner, type OwnedProcessRunner } from '../../../packages/process/src/api'
import { scanSourceContent } from '../../../scripts/spawn-lint'
import { createNotebookMethods } from '../src/notebook/service'
import {
  describeCandidates,
  describePython,
  installIpykernel,
  runCommand,
  type PythonCandidate,
  type PythonEnvironment
} from '../src/notebook/python'

const roots: string[] = []
const features: Array<{ dispose(): void | Promise<void> }> = []
const ownedRunners: OwnedProcessRunner[] = []
const pythonProbe = [
  'import importlib.util, json, os, platform, sys, sysconfig',
  'managed = sys.prefix == getattr(sys, "base_prefix", sys.prefix) and os.path.isfile(os.path.join(sysconfig.get_path("stdlib"), "EXTERNALLY-MANAGED"))',
  'print(json.dumps({"path": sys.executable, "version": platform.python_version(), "ipykernel": importlib.util.find_spec("ipykernel") is not None, "pip": importlib.util.find_spec("pip") is not None, "externallyManaged": managed}))'
].join('; ')
const notebookText = JSON.stringify({
  cells: [],
  metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
  nbformat: 4,
  nbformat_minor: 5
})
const caller = {} as PluginCaller

async function disposeFeatures(): Promise<void> {
  for (const feature of features.splice(0)) await feature.dispose()
  for (const runner of ownedRunners.splice(0)) await runner.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
}

afterEach(disposeFeatures)

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-python-process-')))
  roots.push(root)
  return root
}

function makeExecutable(path: string): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '#!/bin/sh\nexit 0\n')
  chmodSync(path, 0o755)
  return path
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  return Promise.withResolvers<T>()
}
async function withProcessPlatform<T>(platform: 'darwin' | 'linux', run: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
  if (!descriptor || !('value' in descriptor)) throw new Error('process.platform must be a data property')
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: platform })
    return await run()
  } finally {
    Object.defineProperty(process, 'platform', descriptor)
  }
}

function streamFrom(chunks: Array<string | Uint8Array> = []): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk)
      controller.close()
    }
  })
}

const successfulExit: SpawnExit = { exitCode: 0, signal: null, durationMs: 1 }

type FakeHandlePlan = {
  chunks?: Array<string | Uint8Array>
  stdout?: ReadableStream<Uint8Array>
  exit?: SpawnExit
  exited?: Promise<SpawnExit>
  stderr?: string
  onStop?: (options: StopOptions | undefined) => SpawnExit | Promise<SpawnExit>
}

type FakeHandle = {
  handle: SpawnedProcess
  stopCalls(): number
  stopOptions(): StopOptions[]
  writeCalls(): number
  closeInputCalls(): number
}

function fakeHandle(plan: FakeHandlePlan = {}): FakeHandle {
  let stops = 0
  let writes = 0
  let closes = 0
  const stopOptions: StopOptions[] = []
  const exited = plan.exited ?? Promise.resolve(plan.exit ?? successfulExit)
  return {
    handle: {
      pid: 314,
      stdout: plan.stdout ?? streamFrom(plan.chunks),
      stderr: streamFrom([]),
      stderrTail: () => plan.stderr ?? '',
      write: async () => { writes++; return true },
      closeInput: async () => { closes++ },
      exited,
      stop: async (options) => {
        stops++
        stopOptions.push(options ?? {})
        return plan.onStop ? await plan.onStop(options) : await exited
      }
    },
    stopCalls: () => stops,
    stopOptions: () => stopOptions,
    writeCalls: () => writes,
    closeInputCalls: () => closes
  }
}

type SpawnCall = { argv: readonly string[]; options: SpawnOptions }
type SpawnFactory = (argv: readonly string[], options: SpawnOptions, index: number) => SpawnedProcess

function recordingSpawner(factory: SpawnFactory, calls: SpawnCall[] = []): { process: ProcessSpawner; calls: SpawnCall[] } {
  return {
    calls,
    process: {
      spawn(argv, options) {
        const ownedArgv = [...argv]
        calls.push({ argv: ownedArgv, options })
        return factory(ownedArgv, options, calls.length - 1)
      }
    }
  }
}

function assertPythonSpawn(
  call: SpawnCall | undefined,
  argv: string[],
  cwd: string,
  timeoutMs: number,
  tailCharacters = 256 * 1024
): void {
  expect(call?.argv).toEqual(argv)
  expect(call?.options).toMatchObject({
    cwd,
    timeoutMs,
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'tail',
    stderrTailBytes: tailCharacters * 4,
    killGraceMs: 0
  })
  expect(call?.options.env).toBe(process.env)
}

type ProbeOverrides = { ipykernel?: boolean; pip?: boolean; externallyManaged?: boolean }

function metadata(path: string, overrides: ProbeOverrides = {}): string {
  return `${JSON.stringify({
    path,
    version: '3.12.4',
    ipykernel: true,
    pip: true,
    externallyManaged: false,
    ...overrides
  })}\n`
}

function pythonResult(path: string, overrides: ProbeOverrides = {}, exit = successfulExit): SpawnedProcess {
  return fakeHandle({ chunks: [metadata(path, overrides)], exit }).handle
}

function featureHost(spawner: ProcessSpawner, root = temporaryRoot()): {
  root: string
  notebookPath: string
  host: EditorServices
  methods: FeatureMethods
} {
  const notebookPath = join(root, 'notes', 'analysis.ipynb')
  mkdirSync(dirname(notebookPath), { recursive: true })
  writeFileSync(notebookPath, notebookText)
  const buffer = {
    id: 'fixture-buffer',
    kind: 'notebook',
    worktreeId: 'fixture-worktree',
    relativePath: 'notes/analysis.ipynb',
    content: notebookText,
    draft: null
  } as unknown as EditorBuffer
  const context = {
    process: spawner,
    dir: root,
    home: join(root, 'home'),
    dataDir: join(root, 'data'),
    error: (_kind: string, message: string) => new Error(message)
  } as unknown as PluginContext
  const host = {
    context,
    get: () => buffer,
    resolve: async () => ({ id: 'fixture-worktree', path: root }),
    path: async (_worktreeId: string, relativePath: string) => join(root, relativePath),
    onClose: () => () => {},
    emit: () => {}
  } as unknown as EditorServices
  const methods = createNotebookMethods(host)
  features.push(methods)
  return { root, notebookPath, host, methods }
}

async function notebookCall(methods: FeatureMethods, params: Record<string, unknown>): Promise<unknown> {
  return await methods.methods.notebook!(params, caller)
}

describe('Python process runner integration', () => {
  test('uses the injected spawner, exact options, and default rolling stdout/stderr character tails', async () => {
    const cases = [
      { length: 256 * 1024 - 1, expected: 256 * 1024 - 1 },
      { length: 256 * 1024, expected: 256 * 1024 },
      { length: 256 * 1024 + 1, expected: 256 * 1024 }
    ]
    for (const item of cases) {
      const fake = fakeHandle({ chunks: ['x'.repeat(item.length)], stderr: 's'.repeat(item.length) })
      const calls: SpawnCall[] = []
      const spawner = recordingSpawner(() => fake.handle, calls)
      const result = await runCommand(spawner.process, '/fixture/python', ['-c', 'probe'], { cwd: '/fixture/work', timeoutMs: 1234 })
      expect(result).toEqual({ code: 0, stdout: 'x'.repeat(item.expected), stderr: 's'.repeat(item.expected) })
      assertPythonSpawn(calls[0], ['/fixture/python', '-c', 'probe'], '/fixture/work', 1234)
      expect(fake.writeCalls()).toBe(0)
      expect(fake.closeInputCalls()).toBe(0)
      expect(fake.stopCalls()).toBe(0)
    }
  })

  test('decodes stdout incrementally across UTF-8 boundaries and returns a character tail for both streams', async () => {
    const text = 'Aé🙂Z'
    const bytes = new TextEncoder().encode(text)
    const fake = fakeHandle({
      chunks: [bytes.slice(0, 2), bytes.slice(2, 4), bytes.slice(4)],
      stderr: 'discard🙂Z'
    })
    const calls: SpawnCall[] = []
    const spawner = recordingSpawner(() => fake.handle, calls)
    const result = await runCommand(spawner.process, 'python-fixture', ['-c', 'probe'], {
      cwd: '/fixture', timeoutMs: 50, tailCharacters: 3
    })
    expect(result.stdout).toBe('🙂Z')
    expect(result.stderr).toBe('🙂Z')
    assertPythonSpawn(calls[0], ['python-fixture', '-c', 'probe'], '/fixture', 50, 3)
  })

  test('flushes an incomplete UTF-8 sequence at EOF as a replacement character', async () => {
    const fake = fakeHandle({
      chunks: [new TextEncoder().encode('tail'), new Uint8Array([0xe2, 0x82])]
    })
    const calls: SpawnCall[] = []
    const spawner = recordingSpawner(() => fake.handle, calls)
    const result = await runCommand(spawner.process, 'python-fixture', ['-c', 'probe'], {
      cwd: '/fixture', timeoutMs: 50, tailCharacters: 32
    })

    expect(result).toEqual({ code: 0, stdout: 'tail\uFFFD', stderr: '' })
    assertPythonSpawn(calls[0], ['python-fixture', '-c', 'probe'], '/fixture', 50, 32)
    expect(fake.stopCalls()).toBe(0)
  })

  test('waits for exit after stdout ends and drains stdout after exit', async () => {
    const exit = deferred<SpawnExit>()
    const outputEnded = deferred<void>()
    const beforeExit = fakeHandle({
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('before'))
          controller.close()
          outputEnded.resolve()
        }
      }),
      exited: exit.promise
    })
    const first = runCommand(recordingSpawner(() => beforeExit.handle).process, 'fixture', [], { cwd: '/tmp', timeoutMs: 500 })
    await outputEnded.promise
    let firstSettled = false
    void first.then(() => { firstSettled = true })
    await Promise.resolve()
    expect(firstSettled).toBe(false)
    exit.resolve(successfulExit)
    expect(await first).toMatchObject({ code: 0, stdout: 'before' })

    let closeOutput!: () => void
    const stdout = new ReadableStream<Uint8Array>({ start(controller) { closeOutput = () => controller.close() } })
    const secondExit = Promise.resolve(successfulExit)
    const afterExit = fakeHandle({ stdout, exited: secondExit })
    const second = runCommand(recordingSpawner(() => afterExit.handle).process, 'fixture', [], { cwd: '/tmp', timeoutMs: 500 })
    let secondSettled = false
    void second.then(() => { secondSettled = true })
    await Promise.resolve()
    expect(secondSettled).toBe(false)
    closeOutput()
    expect(await second).toMatchObject({ code: 0, stdout: '' })
  })

  test('preserves spawn failures and reports stopped outcomes with Python-specific messages', async () => {
    const missing = fakeHandle({ exit: {
      exitCode: null, signal: null, spawnError: { code: 'ENOENT', message: 'python was not found' }, durationMs: 1
    } })
    await expect(runCommand(recordingSpawner(() => missing.handle).process, 'missing-python', [], { cwd: '/tmp', timeoutMs: 50 }))
      .rejects.toThrow('python was not found')

    const synchronous: ProcessSpawner = { spawn() { throw new Error('invalid spawn arguments') } }
    await expect(runCommand(synchronous, 'python-fixture', [], { cwd: '/tmp', timeoutMs: 50 }))
      .rejects.toThrow('invalid spawn arguments')

    const stopped: Array<{ reason: NonNullable<SpawnExit['stopped']>; message: string }> = [
      { reason: 'timeout', message: 'command timed out after 50 ms' },
      { reason: 'aborted', message: 'command was aborted' },
      { reason: 'stop', message: 'command was stopped' }
    ]
    for (const item of stopped) {
      const fake = fakeHandle({ exit: { exitCode: 0, signal: null, stopped: item.reason, durationMs: 1 } })
      await expect(runCommand(recordingSpawner(() => fake.handle).process, 'python-fixture', [], { cwd: '/tmp', timeoutMs: 50 }))
        .rejects.toThrow(item.message)
    }
  })

  test('stops with SIGKILL and rejects stdout read errors after cleanup', async () => {
    const readError = new Error('stdout fixture read failed')
    const broken = fakeHandle({
      stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.error(readError) } }),
      exit: { exitCode: null, signal: 'SIGTERM', stopped: 'stop', durationMs: 1 }
    })
    await expect(runCommand(recordingSpawner(() => broken.handle).process, 'fixture', [], { cwd: '/tmp', timeoutMs: 500 }))
      .rejects.toBe(readError)
    expect(broken.stopCalls()).toBe(1)
    expect(broken.stopOptions()).toEqual([{ signal: 'SIGKILL' }])
  })

  test('keeps a whole-call deadline through stdout drain even after a clean exit', async () => {
    let closeOutput!: () => void
    const stdout = new ReadableStream<Uint8Array>({ start(controller) { closeOutput = () => controller.close() } })
    const fake = fakeHandle({
      stdout,
      exit: successfulExit,
      onStop: () => {
        closeOutput()
        return successfulExit
      }
    })
    const result = runCommand(recordingSpawner(() => fake.handle).process, 'fixture', [], { cwd: '/tmp', timeoutMs: 20 })
    await expect(result).rejects.toThrow('command timed out after 20 ms')
    expect(fake.stopCalls()).toBe(1)
    expect(fake.stopOptions()).toEqual([{ signal: 'SIGKILL' }])
  })

  for (const interleaved of [false, true]) {
    test(`retains exact 262144-character tails after 64 MiB per stream (${interleaved ? 'interleaved' : 'sequential'})`, async () => {
      const runner = createProcessRunner({ owner: `quirky-editor-python-tail-${interleaved ? 'interleaved' : 'sequential'}` })
      ownedRunners.push(runner)
      const calls: SpawnCall[] = []
      let stdoutConsumed = 0
      const childScript = `
const { once } = require('node:events')
const block = Buffer.alloc(64 * 1024, 120)
async function write(stream, bytes) {
  if (!stream.write(bytes)) await once(stream, 'drain')
}
async function fill(stream) {
  for (let index = 0; index < 1024; index++) await write(stream, block)
}
if (${interleaved}) {
  for (let index = 0; index < 1024; index++) {
    await write(process.stdout, block)
    await write(process.stderr, block)
  }
} else {
  await fill(process.stdout)
  await fill(process.stderr)
}
await write(process.stdout, Buffer.from('PYTHON-STDOUT-END'))
await write(process.stderr, Buffer.from('PYTHON-STDERR-END'))
`
      const spawner: ProcessSpawner = {
        spawn(argv, options) {
          calls.push({ argv: [...argv], options })
          const child = runner.spawn(argv, options)
          const reader = child.stdout.getReader()
          const counted = new ReadableStream<Uint8Array>({
            async pull(controller) {
              const next = await reader.read()
              if (next.done) {
                reader.releaseLock()
                controller.close()
                return
              }
              stdoutConsumed += next.value.byteLength
              controller.enqueue(next.value)
            },
            async cancel(reason) {
              await reader.cancel(reason)
              reader.releaseLock()
            }
          })
          return { ...child, stdout: counted }
        }
      }
      const markerOut = 'PYTHON-STDOUT-END'
      const markerErr = 'PYTHON-STDERR-END'
      const result = await runCommand(spawner, process.execPath, ['-e', childScript], { cwd: process.cwd(), timeoutMs: 30_000 })
      const expectedOutBytes = 64 * 1024 * 1024 + Buffer.byteLength(markerOut)
      const expectedErrBytes = 64 * 1024 * 1024 + Buffer.byteLength(markerErr)
      expect(result.code).toBe(0)
      expect(result.stdout).toBe('x'.repeat(256 * 1024 - markerOut.length) + markerOut)
      expect(result.stderr).toBe('x'.repeat(256 * 1024 - markerErr.length) + markerErr)
      expect(stdoutConsumed).toBe(expectedOutBytes)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.argv).toEqual([process.execPath, '-e', childScript])
      expect(calls[0]?.options.stderrTailBytes).toBe(1024 * 1024)
      expect(calls[0]?.options.killGraceMs).toBe(0)
      console.log(`64 MiB fixture consumed: stdout=${stdoutConsumed} bytes, stderr drained=${expectedErrBytes} bytes (${interleaved ? 'interleaved' : 'sequential'})`)
    })
  }
})

describe('Python discovery and notebook setup', () => {
  test('passes the supplied spawner to describe and omits unusable candidates', async () => {
    const root = temporaryRoot()
    const first = makeExecutable(join(root, 'python-good'))
    const second = makeExecutable(join(root, 'python-bad'))
    const calls: SpawnCall[] = []
    const spawner = recordingSpawner((argv) => {
      if (argv[0] === first) return pythonResult(first)
      return fakeHandle({ chunks: ['probe failed'], exit: { exitCode: 1, signal: null, durationMs: 1 } }).handle
    }, calls)

    const result = await describeCandidates(spawner.process, [
      { path: first, name: 'good', source: 'workspace' },
      { path: second, name: 'bad', source: 'path' },
      { path: join(root, 'missing'), name: 'missing', source: 'path' }
    ])

    expect(result).toEqual([{
      path: first,
      name: basename(first),
      version: '3.12.4',
      source: 'workspace',
      hasIpykernel: true,
      hasPip: true,
      externallyManaged: false
    }])
    expect(calls).toHaveLength(2)
    assertPythonSpawn(calls[0], [first, '-c', pythonProbe], process.cwd(), 10_000)
    assertPythonSpawn(calls[1], [second, '-c', pythonProbe], process.cwd(), 10_000)
  })

  test('preserves metadata validation, incomplete metadata, and unusable executable errors', async () => {
    const root = temporaryRoot()
    const python = makeExecutable(join(root, 'python'))
    const malformed = recordingSpawner(() => fakeHandle({ chunks: ['not-json\n'] }).handle)
    await expect(describePython(malformed.process, python)).rejects.toThrow('Python did not return a valid version description:')

    const incomplete = recordingSpawner(() => fakeHandle({ chunks: ['{"path":"/tmp/python","version":"3.12"}\n'] }).handle)
    await expect(describePython(incomplete.process, python)).rejects.toThrow('Python returned an incomplete version description')
    await expect(describePython(incomplete.process, join(root, 'not-executable'))).rejects.toThrow(`Python is not executable: ${join(root, 'not-executable')}`)
  })

  test('uses the feature host runner for candidate listing, metadata description, and selection', async () => {
    const root = temporaryRoot()
    const candidate = makeExecutable(join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'))
    const calls: SpawnCall[] = []
    const spawner = recordingSpawner((argv) => pythonResult(argv[0]!), calls)
    const feature = featureHost(spawner.process, root)
    const oldPath = process.env.PATH
    process.env.PATH = ''
    try {
      const candidates = await notebookCall(feature.methods, { action: 'environments', bufferId: 'fixture-buffer' }) as { environments: PythonCandidate[]; probed: boolean }
      expect(candidates).toMatchObject({ probed: false })
      expect(candidates.environments.map((entry) => entry.path)).toContain(candidate)
      expect(calls).toHaveLength(0)

      const probed = await notebookCall(feature.methods, { action: 'environments', bufferId: 'fixture-buffer', runWorkspaceInterpreters: true }) as { environments: PythonEnvironment[]; probed: boolean }
      expect(probed.probed).toBe(true)
      expect(probed.environments.map((entry) => entry.path)).toContain(candidate)
      assertPythonSpawn(calls[0], [candidate, '-c', pythonProbe], process.cwd(), 10_000)

      const described = await notebookCall(feature.methods, { action: 'describe', bufferId: 'fixture-buffer', path: candidate }) as { environment: PythonEnvironment }
      expect(described.environment.path).toBe(candidate)
      assertPythonSpawn(calls[1], [candidate, '-c', pythonProbe], process.cwd(), 10_000)

      const selected = await notebookCall(feature.methods, { action: 'select', bufferId: 'fixture-buffer', python: candidate }) as { selected: boolean; environment: PythonEnvironment }
      expect(selected.selected).toBe(true)
      assertPythonSpawn(calls[2], [candidate, '-c', pythonProbe], process.cwd(), 10_000)
      expect(calls).toHaveLength(3)
    } finally {
      if (oldPath === undefined) delete process.env.PATH
      else process.env.PATH = oldPath
    }
  })

  test('installs ipykernel through one runner without retry and preserves the UI command', async () => {
    const root = temporaryRoot()
    const python = makeExecutable(join(root, 'python'))
    let installed = false
    const calls: SpawnCall[] = []
    const spawner = recordingSpawner((argv) => {
      if (argv[1] === '-c') {
        return pythonResult(argv[0]!, installed ? {} : { ipykernel: false, pip: false })
      }
      if (argv[1] === '-m' && argv[2] === 'ensurepip') return fakeHandle({ chunks: ['ensured'] }).handle
      if (argv[1] === '-m' && argv[2] === 'pip') {
        installed = true
        return fakeHandle({ chunks: ['installed'] }).handle
      }
      throw new Error(`unexpected command: ${argv.join(' ')}`)
    }, calls)
    const feature = featureHost(spawner.process, root)
    await notebookCall(feature.methods, { action: 'trust', bufferId: 'fixture-buffer', granted: true })
    const result = await notebookCall(feature.methods, { action: 'install', bufferId: 'fixture-buffer', python }) as {
      status: string; environment: PythonEnvironment; command: string
    }

    expect(result.status).toBe('installed')
    expect(result.environment.hasIpykernel).toBe(true)
    expect(result.command).toBe(`'${python}' -m pip install -U ipykernel`)
    expect(calls).toHaveLength(4)
    assertPythonSpawn(calls[0], [python, '-c', pythonProbe], process.cwd(), 10_000)
    assertPythonSpawn(calls[1], [python, '-m', 'ensurepip'], root, 600_000)
    assertPythonSpawn(calls[2], [python, '-m', 'pip', 'install', '-U', 'ipykernel'], root, 600_000)
    assertPythonSpawn(calls[3], [python, '-c', pythonProbe], process.cwd(), 10_000)
  })

  test('keeps install refusal and verification failures explicit without retrying writes', async () => {
    const root = temporaryRoot()
    const pythonPath = makeExecutable(join(root, 'python'))
    const managed = {
      path: pythonPath, name: 'python', version: '3.12.4', source: 'selected' as const,
      hasIpykernel: false, hasPip: true, externallyManaged: true
    }
    const unused = recordingSpawner(() => { throw new Error('externally managed Python must not spawn') })
    await expect(installIpykernel(unused.process, managed, root)).rejects.toThrow(
      'This Python is externally managed; create a workspace virtual environment instead.'
    )
    expect(unused.calls).toHaveLength(0)

    const managedCalls: SpawnCall[] = []
    const managedHost = featureHost(recordingSpawner(
      (argv) => pythonResult(argv[0]!, { externallyManaged: true, pip: false }),
      managedCalls
    ).process)
    await notebookCall(managedHost.methods, { action: 'trust', bufferId: 'fixture-buffer', granted: true })
    const refusal = await notebookCall(managedHost.methods, {
      action: 'install', bufferId: 'fixture-buffer', python: pythonPath
    })
    expect(refusal).toEqual({
      status: 'venv-required',
      error: 'This Python is externally managed; create a workspace virtual environment instead.'
    })
    expect(managedCalls).toHaveLength(1)
    assertPythonSpawn(managedCalls[0], [pythonPath, '-c', pythonProbe], process.cwd(), 10_000)

    const selected = { ...managed, externallyManaged: false }
    const installFailureCalls: SpawnCall[] = []
    const installFailure = recordingSpawner((argv) => {
      if (argv[1] === '-m') return fakeHandle({ chunks: ['pip failed'], exit: { exitCode: 1, signal: null, durationMs: 1 } }).handle
      throw new Error(`unexpected verification: ${argv.join(' ')}`)
    }, installFailureCalls)
    await expect(installIpykernel(installFailure.process, selected, root)).rejects.toThrow(
      `'${pythonPath}' -m pip install -U ipykernel\npip failed`
    )
    expect(installFailureCalls).toHaveLength(1)
    assertPythonSpawn(installFailureCalls[0], [pythonPath, '-m', 'pip', 'install', '-U', 'ipykernel'], root, 600_000)

    const verifyCalls: SpawnCall[] = []
    const verificationFailure = recordingSpawner((argv) => argv[1] === '-c'
      ? pythonResult(argv[0]!, { ipykernel: false })
      : fakeHandle({ chunks: ['install output'] }).handle, verifyCalls)
    await expect(installIpykernel(verificationFailure.process, selected, root)).rejects.toThrow(
      'ipykernel installation did not verify: '
    )
    expect(verifyCalls).toHaveLength(2)
    assertPythonSpawn(verifyCalls[0], [pythonPath, '-m', 'pip', 'install', '-U', 'ipykernel'], root, 600_000)
    assertPythonSpawn(verifyCalls[1], [pythonPath, '-c', pythonProbe], process.cwd(), 10_000)
  })

  test('creates a venv, installs missing ipykernel, and reports the joined UI command', async () => {
    const root = temporaryRoot()
    const selectedPath = makeExecutable(join(root, 'selected-python'))
    const venvPath = join(root, '.venv')
    const venvPython = join(venvPath, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
    let installed = false
    const calls: SpawnCall[] = []
    const spawner = recordingSpawner((argv) => {
      if (argv[1] === '-c') {
        if (argv[0] === venvPython) {
          return pythonResult(venvPython, installed ? {} : { ipykernel: false, pip: false })
        }
        return pythonResult(argv[0]!)
      }
      if (argv[1] === '-m' && argv[2] === 'venv') {
        makeExecutable(venvPython)
        return fakeHandle({ chunks: ['created'] }).handle
      }
      if (argv[1] === '-m' && argv[2] === 'ensurepip') {
        return fakeHandle({ chunks: ['ensured'] }).handle
      }
      if (argv[1] === '-m' && argv[2] === 'pip') {
        installed = true
        return fakeHandle({ chunks: ['installed'] }).handle
      }
      throw new Error(`unexpected command: ${argv.join(' ')}`)
    }, calls)
    const feature = featureHost(spawner.process, root)
    await notebookCall(feature.methods, { action: 'trust', bufferId: 'fixture-buffer', granted: true })
    const result = await notebookCall(feature.methods, { action: 'venv', bufferId: 'fixture-buffer', python: selectedPath }) as {
      status: string; path: string; environment: PythonEnvironment; command: string
    }

    expect(result).toMatchObject({
      status: 'created',
      path: venvPath,
      environment: { path: venvPython, hasIpykernel: true, hasPip: true }
    })
    expect(result.command).toBe(
      `'${selectedPath}' -m venv '${venvPath}' && '${venvPython}' -m pip install -U ipykernel`
    )
    expect(calls).toHaveLength(6)
    assertPythonSpawn(calls[0], [selectedPath, '-c', pythonProbe], process.cwd(), 10_000)
    assertPythonSpawn(calls[1], [selectedPath, '-m', 'venv', venvPath], root, 120_000)
    assertPythonSpawn(calls[2], [venvPython, '-c', pythonProbe], process.cwd(), 10_000)
    assertPythonSpawn(calls[3], [venvPython, '-m', 'ensurepip'], root, 600_000)
    assertPythonSpawn(calls[4], [venvPython, '-m', 'pip', 'install', '-U', 'ipykernel'], root, 600_000)
    assertPythonSpawn(calls[5], [venvPython, '-c', pythonProbe], process.cwd(), 10_000)
  })

  test('preserves venv creation stderr and stdout failures without describing or installing', async () => {
    const failures = [
      { stdout: 'creation stdout', stderr: ' creation stderr \n', detail: 'creation stderr' },
      { stdout: ' creation stdout \n', stderr: '   ', detail: 'creation stdout' }
    ]
    for (const failure of failures) {
      const root = temporaryRoot()
      const selectedPath = makeExecutable(join(root, 'selected-python'))
      const venvPath = join(root, '.venv')
      const calls: SpawnCall[] = []
      const spawner = recordingSpawner((argv) => {
        if (argv[1] === '-c') return pythonResult(argv[0]!)
        if (argv[1] === '-m' && argv[2] === 'venv') {
          return fakeHandle({
            chunks: [failure.stdout],
            stderr: failure.stderr,
            exit: { exitCode: 1, signal: null, durationMs: 1 }
          }).handle
        }
        throw new Error(`unexpected command: ${argv.join(' ')}`)
      }, calls)
      const feature = featureHost(spawner.process, root)
      await notebookCall(feature.methods, { action: 'trust', bufferId: 'fixture-buffer', granted: true })

      await expect(notebookCall(feature.methods, {
        action: 'venv', bufferId: 'fixture-buffer', python: selectedPath
      })).rejects.toThrow(`virtual environment creation failed: ${failure.detail}`)
      expect(calls).toHaveLength(2)
      assertPythonSpawn(calls[0], [selectedPath, '-c', pythonProbe], process.cwd(), 10_000)
      assertPythonSpawn(calls[1], [selectedPath, '-m', 'venv', venvPath], root, 120_000)
    }
  })
})

describe('Python interpreter chooser', () => {
  test('uses the feature host runner, a 300000 ms deadline, and an 8192-character tail', async () => {
    const root = temporaryRoot()
    const python = makeExecutable(join(root, 'picked-python'))
    const calls: SpawnCall[] = []
    const spawner = recordingSpawner((argv) => argv[0] === 'osascript'
      ? fakeHandle({ chunks: [` ${python}\n`] }).handle
      : pythonResult(argv[0]!), calls)
    const feature = featureHost(spawner.process)

    await withProcessPlatform('darwin', async () => {
      const result = await notebookCall(feature.methods, { action: 'select', bufferId: 'fixture-buffer', browse: true }) as {
        selected: boolean; environment: PythonEnvironment
      }
      expect(result.selected).toBe(true)
      expect(result.environment.path).toBe(python)
      expect(calls).toHaveLength(2)
      expect(calls[0]?.argv).toEqual(['osascript', '-e', 'POSIX path of (choose file with prompt "Select Python interpreter")'])
      expect(calls[0]?.options).toMatchObject({
        cwd: dirname(feature.notebookPath), timeoutMs: 300_000, env: process.env,
        stdin: 'ignore', stdout: 'pipe', stderr: 'tail', stderrTailBytes: 32_768, killGraceMs: 0
      })
      expect(calls[0]?.options.env).toBe(process.env)
      assertPythonSpawn(calls[1], [python, '-c', pythonProbe], process.cwd(), 10_000)
    })
  })

  test('refuses Python browsing on Linux without invoking the runner', async () => {
    const calls: SpawnCall[] = []
    const spawner = recordingSpawner(() => {
      throw new Error('Linux chooser refusal must not spawn a child')
    }, calls)
    const feature = featureHost(spawner.process)

    await withProcessPlatform('linux', async () => {
      await expect(notebookCall(feature.methods, { action: 'select', bufferId: 'fixture-buffer', browse: true }))
        .rejects.toThrow('Browse for Python is supported on macOS; pass an explicit interpreter path on this host.')
      expect(calls).toHaveLength(0)
    })
  })

  test('preserves the previous selection on cancellation and maps other chooser failures', async () => {
    const root = temporaryRoot()
    const python = makeExecutable(join(root, 'previous-python'))
    let chooserExit: SpawnExit = { exitCode: 1, signal: null, durationMs: 1 }
    let chooserStdout = ''
    let chooserStderr = ' User cancelled \n'
    const calls: SpawnCall[] = []
    const spawner = recordingSpawner((argv) => {
      if (argv[0] === 'osascript') return fakeHandle({ chunks: [chooserStdout], stderr: chooserStderr, exit: chooserExit }).handle
      return pythonResult(argv[0]!)
    }, calls)
    const feature = featureHost(spawner.process)

    await withProcessPlatform('darwin', async () => {
      const previous = await notebookCall(feature.methods, { action: 'select', bufferId: 'fixture-buffer', python }) as { environment: PythonEnvironment }
      const cancelled = await notebookCall(feature.methods, { action: 'select', bufferId: 'fixture-buffer', browse: true })
      expect(cancelled).toEqual({ cancelled: true, selected: previous.environment })
      expect(calls[1]?.argv).toEqual(['osascript', '-e', 'POSIX path of (choose file with prompt "Select Python interpreter")'])
      expect(calls[1]?.options.timeoutMs).toBe(300_000)
      expect(calls[1]?.options.stderrTailBytes).toBe(32_768)

      chooserStderr = '  chooser is unavailable  \n'
      await expect(notebookCall(feature.methods, { action: 'select', bufferId: 'fixture-buffer', browse: true }))
        .rejects.toThrow('chooser is unavailable')
      expect(calls[2]?.argv[0]).toBe('osascript')

      chooserStderr = ''
      chooserStdout = ''
      await expect(notebookCall(feature.methods, { action: 'select', bufferId: 'fixture-buffer', browse: true }))
        .rejects.toThrow('The Python file chooser failed.')
      expect(calls[3]?.argv[0]).toBe('osascript')

      chooserExit = { exitCode: 0, signal: null, stopped: 'timeout', durationMs: 1 }
      chooserStderr = 'cancelled'
      await expect(notebookCall(feature.methods, { action: 'select', bufferId: 'fixture-buffer', browse: true }))
        .rejects.toThrow('command timed out after 300000 ms')
      expect(calls[4]?.options.timeoutMs).toBe(300_000)

      chooserExit = { exitCode: 1, signal: null, durationMs: 1 }
      chooserStderr = ' User CANCELLED \n'
      const uppercaseCancelled = await notebookCall(feature.methods, { action: 'select', bufferId: 'fixture-buffer', browse: true })
      expect(uppercaseCancelled).toEqual({ cancelled: true, selected: previous.environment })
      expect(calls[5]?.argv).toEqual(['osascript', '-e', 'POSIX path of (choose file with prompt "Select Python interpreter")'])
      expect(calls[5]?.options.timeoutMs).toBe(300_000)
    })
  })
})

describe('Python migration guardrails', () => {
  test('the migrated Python files have no direct-spawn hits or baseline entries and keep API floor 1.6.0', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
    const pythonPath = 'plugins/quirky.editor/src/notebook/python.ts'
    const servicePath = 'plugins/quirky.editor/src/notebook/service.ts'
    for (const path of [pythonPath, servicePath]) {
      const source = readFileSync(join(root, path), 'utf8')
      expect(scanSourceContent(path, source)).toEqual([])
    }
    const baseline = JSON.parse(readFileSync(join(root, 'scripts/spawn-lint-baseline.json'), 'utf8')) as Record<string, number>
    expect(baseline).not.toHaveProperty(pythonPath)
    expect(baseline).not.toHaveProperty(servicePath)

    const manifest = JSON.parse(readFileSync(join(root, 'plugins/quirky.editor/quirky-plugin.json'), 'utf8')) as { apiVersion: string }
    const actual = manifest.apiVersion.split('.').map(Number)
    const minimum = [1, 6, 0]
    let comparison = 0
    for (let index = 0; index < minimum.length; index++) {
      const difference = (actual[index] ?? 0) - minimum[index]!
      if (difference !== 0) {
        comparison = difference
        break
      }
    }
    expect(comparison).toBeGreaterThanOrEqual(0)
  })
})
