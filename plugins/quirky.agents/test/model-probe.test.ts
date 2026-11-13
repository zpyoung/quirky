import { afterEach, describe, expect, test } from 'bun:test'
import { createProcessRunner, ProcessStalledError, type OwnedProcessRunner, type ProcessSpawner, type SpawnExit, type SpawnOptions, type SpawnedProcess, type StopOptions } from '../../../packages/process/src/api'
import {
  runCodexAppServerModelProbe,
  runModelProbe,
  runPiRpcModelProbe
} from '../src/model-probe'

const MAX_OUTPUT_BYTES = 256 * 1024
const KILL_GRACE_MS = 250
const ownedRunners: OwnedProcessRunner[] = []
const encoder = new TextEncoder()

function bytes(text: string): Uint8Array {
  return encoder.encode(text)
}

function outputStream(chunks: readonly (string | Uint8Array)[], terminal: 'close' | 'open' | Error = 'close'): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? bytes(chunk) : chunk)
      if (terminal === 'close') controller.close()
      else if (terminal instanceof Error) controller.error(terminal)
    }
  })
}

type HandleFixture = {
  stdout?: ReadableStream<Uint8Array>
  chunks?: readonly (string | Uint8Array)[]
  terminal?: 'close' | 'open' | Error
  exit?: SpawnExit | null
  stopExit?: SpawnExit
  pid?: number | null
  write?: (data: string | Uint8Array) => Promise<boolean>
  closeInput?: () => Promise<void>
}

function makeHandle(fixture: HandleFixture = {}) {
  let settleExit!: (exit: SpawnExit) => void
  const exited = new Promise<SpawnExit>((resolve) => { settleExit = resolve })
  const initialExit = fixture.exit === undefined ? null : fixture.exit
  if (initialExit !== null) settleExit(initialExit)
  const writes: string[] = []
  const stopCalls: StopOptions[] = []
  let closeInputCalls = 0
  const handle: SpawnedProcess = {
    pid: fixture.pid === undefined ? 123 : fixture.pid,
    stdout: fixture.stdout ?? outputStream(fixture.chunks ?? [], fixture.terminal ?? 'close'),
    stderr: outputStream([]),
    stderrTail: () => '',
    write(data) {
      writes.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
      return fixture.write ? fixture.write(data) : Promise.resolve(true)
    },
    closeInput() {
      closeInputCalls += 1
      return fixture.closeInput ? fixture.closeInput() : Promise.resolve()
    },
    exited,
    async stop(options = {}) {
      stopCalls.push(options)
      if (initialExit !== null) return initialExit
      settleExit(fixture.stopExit ?? { exitCode: null, signal: 'SIGTERM', stopped: 'stop', durationMs: 0 })
      return exited
    }
  }
  return {
    handle,
    writes,
    stopCalls,
    get closeInputCalls() { return closeInputCalls },
    settleExit
  }
}

function recordingSpawner(handle: SpawnedProcess) {
  const calls: { argv: string[]; options: SpawnOptions }[] = []
  const spawner: ProcessSpawner = {
    spawn(argv, options) {
      calls.push({ argv: [...argv], options })
      return handle
    }
  }
  return { spawner, calls }
}

const codexArgv = ['/opt/bin/codex', 'app-server']
const codexEnv = { CODEX_HOME: '/tmp/ch' }
const piArgv = ['/opt/bin/pi', '--mode', 'rpc', '--no-session']
const piEnv = { HOME: '/tmp/u' }
const cwd = '/tmp/work'
const plainOutput = '{"models":["sonnet"]}\n'
const codexOutput = [
  '{"id":1,"result":{"capabilities":{}}}\n',
  '{"id":2,"result":{"data":[],"nextCursor":null}}\n'
]
const piOutput = [
  '{"type":"response","id":"quirky-model-discovery-0","command":"get_available_models","success":true,"data":{"models":[{"id":"model-1","provider":"provider","name":"Model One","reasoning":true}]}}\n',
  '{"type":"response","id":"quirky-model-discovery-1","command":"set_model","success":true,"data":{"provider":"provider","id":"model-1"}}\n',
  '{"type":"response","id":"quirky-model-discovery-2","command":"get_available_thinking_levels","success":true,"data":{"levels":["low","high"]}}\n'
]

const probes = [
  {
    name: 'plain',
    output: [plainOutput],
    run: (spawner: ProcessSpawner, timeoutMs = 5_000) => runModelProbe(spawner, ['/opt/bin/claude', '--models'], timeoutMs)
  },
  {
    name: 'Codex app-server',
    output: codexOutput,
    run: (spawner: ProcessSpawner, timeoutMs = 5_000) => runCodexAppServerModelProbe(spawner, codexArgv, timeoutMs, codexEnv, cwd)
  },
  {
    name: 'Pi RPC',
    output: piOutput,
    run: (spawner: ProcessSpawner, timeoutMs = 5_000) => runPiRpcModelProbe(spawner, piArgv, timeoutMs, piEnv, cwd)
  }
] as const

const naturalExit: SpawnExit = { exitCode: 0, signal: null, durationMs: 4 }
const timeoutExit: SpawnExit = { exitCode: null, signal: 'SIGTERM', stopped: 'timeout', durationMs: 80 }
const abortedExit: SpawnExit = { exitCode: null, signal: 'SIGKILL', stopped: 'aborted', durationMs: 50 }

afterEach(async () => {
  await Promise.all(ownedRunners.splice(0).map((runner) => runner.dispose()))
})

describe('runModelProbe', () => {
  test('routes through ProcessSpawner with the exact options and preserves output', async () => {
    const fixture = makeHandle({ chunks: [plainOutput], exit: naturalExit })
    const { spawner, calls } = recordingSpawner(fixture.handle)

    expect(await runModelProbe(spawner, ['/opt/bin/claude', '--models'], 5_000)).toEqual({ ok: true, stdout: plainOutput })
    expect(calls).toEqual([{
      argv: ['/opt/bin/claude', '--models'],
      options: {
        cwd: process.cwd(), env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore',
        timeoutMs: 5_000, killGraceMs: KILL_GRACE_MS
      }
    }])
  })
  test('returns nonzero-exit when stdout closes after a failed process exit', async () => {
    const fixture = makeHandle({ chunks: [plainOutput], exit: { exitCode: 1, signal: null, durationMs: 4 } })
    const { spawner } = recordingSpawner(fixture.handle)

    expect(await runModelProbe(spawner, ['/opt/bin/claude', '--models'], 5_000)).toEqual({ ok: false, reason: 'nonzero-exit' })
  })
})

describe('runCodexAppServerModelProbe', () => {
  test('routes through ProcessSpawner with the exact options and completes model/list', async () => {
    const fixture = makeHandle({ chunks: codexOutput, stopExit: { exitCode: null, signal: 'SIGTERM', stopped: 'stop', durationMs: 4 } })
    const { spawner, calls } = recordingSpawner(fixture.handle)

    expect(await runCodexAppServerModelProbe(spawner, codexArgv, 5_000, codexEnv, cwd)).toEqual({
      ok: true,
      stdout: '{"data":[],"nextCursor":null}'
    })
    expect(calls).toEqual([{
      argv: codexArgv,
      options: {
        cwd, env: codexEnv, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
        timeoutMs: 5_000, killGraceMs: KILL_GRACE_MS
      }
    }])
    expect(fixture.stopCalls).toEqual([{ graceMs: KILL_GRACE_MS }])
    expect(fixture.closeInputCalls).toBeGreaterThan(0)
  })
  test('returns output-not-closed when stdin refuses the first request', async () => {
    const fixture = makeHandle({ chunks: codexOutput, write: () => Promise.resolve(false) })
    const { spawner } = recordingSpawner(fixture.handle)

    expect(await runCodexAppServerModelProbe(spawner, codexArgv, 5_000, codexEnv, cwd)).toEqual({
      ok: false,
      reason: 'output-not-closed'
    })
    expect(fixture.writes).toHaveLength(1)
  })

  test('returns nonzero-exit when the process exits before answering', async () => {
    const fixture = makeHandle({ terminal: 'open', exit: { exitCode: 3, signal: null, durationMs: 4 } })
    const { spawner } = recordingSpawner(fixture.handle)

    expect(await runCodexAppServerModelProbe(spawner, codexArgv, 5_000, codexEnv, cwd)).toEqual({
      ok: false,
      reason: 'nonzero-exit'
    })
  })
})

describe('runPiRpcModelProbe', () => {
  test('routes through ProcessSpawner and validates the complete RPC exchange', async () => {
    const fixture = makeHandle({ chunks: piOutput, exit: naturalExit })
    const { spawner, calls } = recordingSpawner(fixture.handle)

    expect(await runPiRpcModelProbe(spawner, piArgv, 5_000, piEnv, cwd)).toEqual({
      ok: true,
      stdout: '{"models":[{"id":"provider/model-1","label":"Model One","options":[{"id":"effort","choices":["low","high"]}]}]}'
    })
    expect(calls).toEqual([{
      argv: piArgv,
      options: {
        cwd, env: piEnv, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore',
        timeoutMs: 5_000, killGraceMs: KILL_GRACE_MS
      }
    }])
    expect(fixture.closeInputCalls).toBeGreaterThan(0)
    expect(fixture.stopCalls).toEqual([{ graceMs: KILL_GRACE_MS }])
  })

  test('requires a successful natural process exit after a complete RPC exchange', async () => {
    const fixture = makeHandle({ chunks: piOutput, exit: { exitCode: 2, signal: null, durationMs: 6 } })
    const { spawner } = recordingSpawner(fixture.handle)

    expect(await runPiRpcModelProbe(spawner, piArgv, 5_000, piEnv, cwd)).toEqual({ ok: false, reason: 'nonzero-exit' })
  })
  test('returns output-not-closed when stdin refuses the first request', async () => {
    const fixture = makeHandle({ chunks: piOutput, exit: naturalExit, write: () => Promise.resolve(false) })
    const { spawner } = recordingSpawner(fixture.handle)

    expect(await runPiRpcModelProbe(spawner, piArgv, 5_000, piEnv, cwd)).toEqual({
      ok: false,
      reason: 'output-not-closed'
    })
    expect(fixture.writes).toHaveLength(1)
  })

  test('returns malformed-output for a failed get_available_models response', async () => {
    const fixture = makeHandle({
      chunks: ['{"type":"response","id":"quirky-model-discovery-0","command":"get_available_models","success":false,"error":"no models"}\n'],
      exit: naturalExit
    })
    const { spawner } = recordingSpawner(fixture.handle)

    expect(await runPiRpcModelProbe(spawner, piArgv, 5_000, piEnv, cwd)).toEqual({
      ok: false,
      reason: 'malformed-output'
    })
  })
})

describe('probe outcome precedence', () => {
  for (const probe of probes) {
    test(`${probe.name} gives runner timeout precedence over valid output`, async () => {
      const fixture = makeHandle({ chunks: probe.output, exit: timeoutExit })
      const { spawner } = recordingSpawner(fixture.handle)
      expect(await probe.run(spawner)).toEqual({ ok: false, reason: 'timeout' })
    })

    test(`${probe.name} rejects valid output after runner disposal`, async () => {
      const fixture = makeHandle({ chunks: probe.output, exit: abortedExit })
      const { spawner } = recordingSpawner(fixture.handle)
      expect(await probe.run(spawner)).toEqual({ ok: false, reason: 'nonzero-exit' })
    })

    test(`${probe.name} reports start failures`, async () => {
      const thrownSpawner: ProcessSpawner = { spawn: () => { throw new Error('start failed') } }
      expect(await probe.run(thrownSpawner)).toEqual({ ok: false, reason: 'could-not-start' })

      const notStarted = makeHandle({
        pid: null,
        exit: { exitCode: null, signal: null, spawnError: { code: 'ENOENT', message: 'missing' }, durationMs: 0 }
      })
      const { spawner } = recordingSpawner(notStarted.handle)
      expect(await probe.run(spawner)).toEqual({ ok: false, reason: 'could-not-start' })
    })
  }

  test('plain probe drains and detects overflow after leader exit', async () => {
    const fixture = makeHandle({ chunks: [new Uint8Array(MAX_OUTPUT_BYTES + 1)], exit: naturalExit })
    const { spawner } = recordingSpawner(fixture.handle)

    expect(await runModelProbe(spawner, ['/opt/bin/claude', '--models'], 5_000)).toEqual({ ok: false, reason: 'too-much-output' })
    expect(fixture.stopCalls).toContainEqual({ graceMs: KILL_GRACE_MS })
  })

  test('Pi detects trailing overflow after the leader has exited', async () => {
    const fixture = makeHandle({ chunks: [...piOutput, new Uint8Array(MAX_OUTPUT_BYTES + 1)], exit: naturalExit })
    const { spawner } = recordingSpawner(fixture.handle)

    expect(await runPiRpcModelProbe(spawner, piArgv, 5_000, piEnv, cwd)).toEqual({ ok: false, reason: 'too-much-output' })
    expect(fixture.stopCalls).toContainEqual({ graceMs: KILL_GRACE_MS })
  })

  for (const [name, trailing] of [
    ['an unexpected response', '{"type":"response","id":"extra","command":"unexpected","success":true,"data":{}}\n'],
    ['an incomplete trailing record', '{"type":"event"']
  ] as const) {
    test(`Pi rejects ${name} after closeInput and preserves the protocol failure through cleanup`, async () => {
      const fixture = makeHandle({ chunks: [...piOutput, trailing] })
      const { spawner } = recordingSpawner(fixture.handle)

      expect(await runPiRpcModelProbe(spawner, piArgv, 5_000, piEnv, cwd)).toEqual({ ok: false, reason: 'malformed-output' })
      expect(fixture.closeInputCalls).toBeGreaterThan(0)
      expect(fixture.stopCalls).toContainEqual({ graceMs: KILL_GRACE_MS })
    })
  }

  for (const probe of probes) {
    for (const [label, error, reason] of [
      ['a stalled stdout stream', new ProcessStalledError('/fixture', 1), 'output-not-closed'],
      ['a broken stdout stream', new Error('read failed'), 'nonzero-exit']
    ] as const) {
      test(`${probe.name} maps ${label} to ${reason}`, async () => {
        const exit = probe.name === 'plain' ? naturalExit : null
        const fixture = makeHandle({ terminal: error, exit, stopExit: naturalExit })
        const { spawner } = recordingSpawner(fixture.handle)

        expect(await probe.run(spawner)).toEqual({ ok: false, reason })
      })
    }
  }

  for (const probe of probes.filter(({ name }) => name === 'Codex app-server' || name === 'Pi RPC')) {
    test(`${probe.name} does not wait for closeInput after a completed exchange`, async () => {
      const fixture = makeHandle({
        chunks: probe.output,
        exit: probe.name === 'Pi RPC' ? naturalExit : null,
        closeInput: () => new Promise<void>(() => {})
      })
      const { spawner } = recordingSpawner(fixture.handle)

      expect((await probe.run(spawner)).ok).toBe(true)
      expect(fixture.closeInputCalls).toBeGreaterThan(0)
    })

    test(`${probe.name} bounds hung write and closeInput calls by its deadline`, async () => {
      const fixture = makeHandle({
        terminal: 'open',
        write: () => new Promise<boolean>(() => {}),
        closeInput: () => new Promise<void>(() => {})
      })
      const { spawner } = recordingSpawner(fixture.handle)
      // This verifies the real local deadline bounds the whole exchange, including shutdown.
      const startedAt = Date.now()

      expect(await probe.run(spawner, 80)).toEqual({ ok: false, reason: 'timeout' })
      expect(Date.now() - startedAt).toBeLessThan(250)
      expect(fixture.stopCalls).toContainEqual({ graceMs: KILL_GRACE_MS })
    })
  }
})

test('owned process runner tracks a live probe and releases it when disposed', async () => {
  const runner = createProcessRunner({ owner: 'quirky.agents' })
  ownedRunners.push(runner)
  const argv = [process.execPath, '-e', `process.stdout.write(${JSON.stringify(plainOutput)}); setInterval(() => {}, 1000)`]
  const probe = runModelProbe(runner, argv, 5_000)

  expect(runner.live()).toHaveLength(1)
  expect(runner.live()[0]?.owner).toBe('quirky.agents')
  await runner.dispose()
  expect(await probe).toEqual({ ok: false, reason: 'nonzero-exit' })
  expect(runner.live()).toEqual([])
}, 10_000)
