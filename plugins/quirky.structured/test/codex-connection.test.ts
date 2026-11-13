import { afterEach, describe, expect, test } from 'bun:test'
import type { ProcessSpawner, SpawnExit, SpawnedProcess } from '../../../packages/process/src/api'
import { CodexConnection, type CodexConnectionHandlers } from '../codex-connection'

function makeHandle(options: {
  stdout?: ReadableStream<Uint8Array>
  stderr?: string
  write?: SpawnedProcess['write']
  closeInput?: SpawnedProcess['closeInput']
  exited?: Promise<SpawnExit>
  stop?: SpawnedProcess['stop']
} = {}): SpawnedProcess {
  const exit = Promise.withResolvers<SpawnExit>()
  return {
    pid: null,
    stdout: options.stdout ?? new ReadableStream<Uint8Array>({ start() {} }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close() } }),
    stderrTail: () => options.stderr ?? '',
    write: options.write ?? (async () => true),
    closeInput: options.closeInput ?? (async () => {}),
    exited: options.exited ?? exit.promise,
    stop: options.stop ?? (async () => {
      const result: SpawnExit = { exitCode: null, signal: 'SIGTERM', stopped: 'stop', durationMs: 0 }
      exit.resolve(result)
      return result
    })
  }
}

let connections: CodexConnection[] = []

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()))
})

function connect(
  handle: SpawnedProcess,
  failures: Error[] = [],
  onFailure?: (error: Error) => void,
  spawn?: ProcessSpawner['spawn']
) {
  const handlers: CodexConnectionHandlers = {
    notification() {},
    serverRequest() {},
    failure(error) {
      failures.push(error)
      onFailure?.(error)
    }
  }
  const spawner: ProcessSpawner = { spawn: spawn ?? (() => handle) }
  const connection = new CodexConnection(spawner, 'codex-fixture', process.cwd(), {}, handlers)
  connections.push(connection)
  return connection
}

describe('Codex app-server connection process lifecycle', () => {
  test('fails once when stdin reports a closed pipe', async () => {
    const failures: Error[] = []
    const failure = Promise.withResolvers<Error>()
    const connection = connect(makeHandle({ write: async () => false }), failures, failure.resolve)

    connection.notify('x', {})
    const error = await failure.promise

    expect(error.message).toBe('Codex app-server stdin failed: the pipe is closed')
    await expect(connection.request('x', {})).rejects.toBe(error)
    expect(failures).toHaveLength(1)
  })

  test('close bounds its wait without awaiting writes or closeInput and shares repeated calls', async () => {
    const exit = Promise.withResolvers<SpawnExit>()
    const stopCalls: { options: Parameters<SpawnedProcess['stop']>[0]; at: number }[] = []
    const failures: Error[] = []
    const connection = connect(makeHandle({
      write: () => new Promise<boolean>(() => {}),
      closeInput: () => new Promise<void>(() => {}),
      exited: exit.promise,
      stop: async (options) => {
        stopCalls.push({ options, at: Date.now() })
        const result: SpawnExit = { exitCode: null, signal: 'SIGTERM', stopped: 'stop', durationMs: 0 }
        exit.resolve(result)
        return result
      }
    }), failures)

    const request = connection.request('x', {})
    const startedAt = Date.now()
    const firstClose = connection.close()
    let secondResolved = false
    const secondClose = connection.close().then(() => {
      secondResolved = true
    })
    await expect(request).rejects.toThrow('Codex app-server connection closed')
    await Promise.resolve()
    expect(secondResolved).toBe(false)
    await Promise.all([firstClose, secondClose])

    expect(stopCalls).toHaveLength(1)
    expect(stopCalls[0]?.options).toEqual({ graceMs: 2000 })
    expect(stopCalls[0]!.at - startedAt).toBeGreaterThanOrEqual(250)
    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(failures).toEqual([])
  })

  test('does not signal a child that exits after stdin closes', async () => {
    const exit = Promise.withResolvers<SpawnExit>()
    let exitedAt: number | undefined
    const stopCalls: number[] = []
    const handle = makeHandle({
      exited: exit.promise,
      closeInput: async () => {
        // Model a child that exits shortly after stdin closes.
        setTimeout(() => {
          exitedAt = Date.now()
          exit.resolve({ exitCode: 0, signal: null, durationMs: 20 })
        }, 20)
      },
      stop: async () => {
        stopCalls.push(Date.now())
        const result: SpawnExit = { exitCode: null, signal: 'SIGTERM', stopped: 'stop', durationMs: 0 }
        exit.resolve(result)
        return result
      }
    })
    const connection = connect(handle)
    const startedAt = Date.now()

    await connection.close()

    expect(Date.now() - startedAt).toBeLessThan(250)
    expect(stopCalls.every((at) => exitedAt !== undefined && at >= exitedAt)).toBe(true)
  })

  test('decodes UTF-8 split across chunks and exposes a bounded stderr tail', async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>
    const exit = Promise.withResolvers<SpawnExit>()
    const response = new TextEncoder().encode('{"id":1,"result":"é"}\n')
    const split = response.indexOf(0xc3) + 1
    const connection = connect(makeHandle({
      stdout: new ReadableStream<Uint8Array>({ start(controller) { output = controller } }),
      stderr: 'x'.repeat(16_385),
      write: async () => {
        output.enqueue(response.slice(0, split))
        output.enqueue(response.slice(split))
        return true
      },
      closeInput: async () => exit.resolve({ exitCode: 0, signal: null, durationMs: 0 }),
      exited: exit.promise
    }))

    await expect(connection.request('echo', {})).resolves.toBe('é')
    expect(connection.stderrTail).toBe('x'.repeat(16_384))
    await connection.close()
  })

  test('reports oversized frames and stdout read failures', async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>
    const failures: Error[] = []
    const failure = Promise.withResolvers<Error>()
    const response = new TextEncoder().encode(`{"id":1,"result":"${'x'.repeat(1024 * 1024)}"}\n`)
    const connection = connect(makeHandle({
      stdout: new ReadableStream<Uint8Array>({ start(controller) { output = controller } }),
      write: async () => {
        output.enqueue(response)
        return true
      }
    }), failures, failure.resolve)

    await expect(connection.request('large', {})).rejects.toThrow('Codex app-server frame exceeds the limit')
    expect((await failure.promise).message).toBe('Codex app-server frame exceeds the limit')
    expect(failures.map((error) => error.message)).toEqual(['Codex app-server frame exceeds the limit'])
    await connection.close()

    const readFailures: Error[] = []
    const readFailure = Promise.withResolvers<Error>()
    let failingOutput!: ReadableStreamDefaultController<Uint8Array>
    const readFailureConnection = connect(makeHandle({
      stdout: new ReadableStream<Uint8Array>({ start(controller) { failingOutput = controller } })
    }), readFailures, readFailure.resolve)
    const pending = readFailureConnection.request('read', {})
    failingOutput.error(new Error('read failed'))

    await expect(pending).rejects.toThrow('Codex app-server stdout failed: read failed')
    expect((await readFailure.promise).message).toBe('Codex app-server stdout failed: read failed')
    expect(readFailures.map((error) => error.message)).toEqual(['Codex app-server stdout failed: read failed'])
  })
})
