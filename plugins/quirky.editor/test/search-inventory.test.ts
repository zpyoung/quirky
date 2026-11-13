import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, ProcessSpawner, SpawnExit, SpawnOptions, SpawnedProcess } from '@quirky/protocol'
import { createProcessRunner, ProcessStalledError, type OwnedProcessRunner } from '../../../packages/process/src/api'
import { ContentsSearch } from '../src/daemon/search'
import { FileInventory } from '../src/daemon/inventory'
import { WorktreePaths } from '../src/daemon/paths'

const roots: string[] = []
const runners: OwnedProcessRunner[] = []

type SpawnCall = { argv: readonly string[]; options: SpawnOptions }

afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'quirky-editor-search-inventory-'))
  roots.push(root)
  return root
}

function contextFor(root: string, spawner: ProcessSpawner): PluginContext {
  return {
    process: spawner,
    call: async () => ({ id: 'fixture-worktree', path: root }),
    error: (_kind: string, message: string) => new Error(message)
  } as unknown as PluginContext
}

function realRunnerContext(root: string, owner: string, calls: SpawnCall[]): PluginContext {
  const runner = createProcessRunner({ owner })
  runners.push(runner)
  const process: ProcessSpawner = {
    spawn(argv, options) {
      calls.push({ argv: [...argv], options })
      return runner.spawn(argv, options)
    }
  }
  return contextFor(root, process)
}

function matchLine(path: string, text = 'needle'): string {
  return `${JSON.stringify({
    type: 'match',
    data: {
      path: { text: path },
      lines: { text },
      line_number: 1,
      submatches: [{ match: { text: 'needle' }, start: 0, end: 6 }]
    }
  })}\n`
}

type FakeHandleOptions = {
  chunks?: string[]
  stdout?: ReadableStream<Uint8Array>
  readError?: Error
  keepOpen?: boolean
  stderr?: string
  exit?: SpawnExit
  exitOnStop?: boolean
  stopExit?: SpawnExit
  onStop?: () => void
}

function fakeHandle(options: FakeHandleOptions = {}): { handle: SpawnedProcess; stopCalls(): number } {
  let stops = 0
  const exit = options.exit ?? { exitCode: 0, signal: null, durationMs: 1 }
  const deferredExit = Promise.withResolvers<SpawnExit>()
  const exited = options.exitOnStop ? deferredExit.promise : Promise.resolve(exit)
  let chunkIndex = 0
  const stdout = options.stdout ?? new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = options.chunks?.[chunkIndex++]
      if (chunk !== undefined) controller.enqueue(Buffer.from(chunk))
      else if (options.readError !== undefined) controller.error(options.readError)
      else if (options.keepOpen !== true) controller.close()
    }
  })
  return {
    handle: {
      pid: 123,
      stdout,
      stderrTail: () => options.stderr ?? '',
      write: async () => true,
      closeInput: async () => {},
      exited,
      stop: async () => {
        stops++
        options.onStop?.()
        if (options.exitOnStop) {
          deferredExit.resolve(options.stopExit ?? { exitCode: null, signal: 'SIGTERM', stopped: 'stop', durationMs: 1 })
        }
        return await exited
      }
    },
    stopCalls: () => stops
  }
}

function fakeSpawner(makeHandle: () => { handle: SpawnedProcess; stopCalls(): number }, calls: SpawnCall[] = []): ProcessSpawner {
  return {
    spawn(argv, options) {
      calls.push({ argv: [...argv], options })
      return makeHandle().handle
    }
  }
}


describe('editor daemon search and inventory process spawning', () => {
  test('search uses the shared spawner with its deadline and stderr tail', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'needle.txt'), 'needle\n')
    const calls: SpawnCall[] = []
    const context = realRunnerContext(root, 'search-inventory-search-spawn', calls)
    const search = new ContentsSearch(context, new WorktreePaths(context))

    const result = await search.call({ action: 'run', query: 'needle', worktree: 'fixture-worktree' })

    expect(result).toMatchObject({ totalMatches: 1, error: null, truncated: false, loading: false })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv[0]).toBe('rg')
    expect(calls[0]?.options).toMatchObject({ timeoutMs: 15_000, cwd: realpathSync(root), stderrTailBytes: 24_576 })
    expect(calls[0]?.options).not.toHaveProperty('stdin')
    expect(calls[0]?.options).not.toHaveProperty('stdout')
  })

  test('search preserves result limits, regex diagnostics, exit rules and stopped outcomes', async () => {
    const root = temporaryRoot()
    writeFileSync(join(root, 'one.txt'), 'needle\n')
    writeFileSync(join(root, 'two.txt'), 'needle\n')
    const runnerCalls: SpawnCall[] = []
    const realContext = realRunnerContext(root, 'search-inventory-search-rules', runnerCalls)
    const limited = await new ContentsSearch(realContext, new WorktreePaths(realContext)).call({
      action: 'run', query: 'needle', worktree: 'fixture-worktree', maxResults: 1
    })
    expect(limited).toMatchObject({ totalMatches: 1, truncated: true, error: null })
    const invalid = await new ContentsSearch(realContext, new WorktreePaths(realContext)).call({
      action: 'run', query: '(', useRegex: true, worktree: 'fixture-worktree'
    })
    expect(invalid.error).toBe('Invalid regular expression: (')

    const cases: { label: string; options: FakeHandleOptions; expected: Record<string, unknown> }[] = [
      {
        label: 'missing executable',
        options: { exit: { exitCode: null, signal: null, spawnError: { code: 'ENOENT', message: 'x' }, durationMs: 1 } },
        expected: { error: 'ripgrep (rg) is required for contents search; install ripgrep and retry' }
      },
      {
        label: 'other startup error',
        options: { exit: { exitCode: null, signal: null, spawnError: { code: 'EACCES', message: 'permission denied' }, durationMs: 1 } },
        expected: { error: 'permission denied' }
      },
      {
        label: 'deadline',
        options: { chunks: [matchLine('a.txt')], exit: { exitCode: null, signal: 'SIGTERM', stopped: 'timeout', durationMs: 1 } },
        expected: { totalMatches: 1, truncated: true, error: null }
      },
      {
        label: 'aborted',
        options: { exit: { exitCode: null, signal: 'SIGTERM', stopped: 'aborted', durationMs: 1 } },
        expected: { totalMatches: 0, truncated: false, error: null }
      },
      {
        label: 'no matches',
        options: { exit: { exitCode: 1, signal: null, durationMs: 1 } },
        expected: { totalMatches: 0, error: null }
      },
      {
        label: 'nonzero exit',
        options: { exit: { exitCode: 2, signal: null, durationMs: 1 }, stderr: 'boom' },
        expected: { error: 'boom' }
      }
    ]
    for (const entry of cases) {
      const fake = fakeHandle(entry.options)
      const context = contextFor(root, fakeSpawner(() => fake))
      const result = await new ContentsSearch(context, new WorktreePaths(context)).call({
        action: 'run', query: 'needle', worktree: 'fixture-worktree'
      })
      expect(result).toMatchObject(entry.expected)
      expect(result.loading).toBe(false)
    }
  })

  test('search stops at result and output limits', async () => {
    const root = temporaryRoot()
    const resultLimited = fakeHandle({ chunks: [matchLine('a.txt'), matchLine('a.txt')], exitOnStop: true })
    const resultContext = contextFor(root, fakeSpawner(() => resultLimited))
    const result = await new ContentsSearch(resultContext, new WorktreePaths(resultContext)).call({
      action: 'run', query: 'needle', worktree: 'fixture-worktree', maxResults: 1
    })
    expect(result).toMatchObject({ totalMatches: 1, truncated: true, error: null })
    expect(resultLimited.stopCalls()).toBe(1)

    const outputLimited = fakeHandle({ chunks: ['x'.repeat(16 * 1024 * 1024 + 1)], exitOnStop: true })
    const outputContext = contextFor(root, fakeSpawner(() => outputLimited))
    const outputResult = await new ContentsSearch(outputContext, new WorktreePaths(outputContext)).call({
      action: 'run', query: 'needle', worktree: 'fixture-worktree'
    })
    expect(outputResult).toMatchObject({ truncated: true, error: null })
    expect(outputLimited.stopCalls()).toBe(1)
  })

  test('cancel stops the handle and waits for stdout and exit without reporting a read error', async () => {
    const root = temporaryRoot()
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined
    const fake = fakeHandle({
      stdout: new ReadableStream<Uint8Array>({ start(value) { controller = value } }),
      exitOnStop: true,
      onStop: () => controller?.error(new Error('read failed'))
    })
    const { promise: started, resolve: didStart } = Promise.withResolvers<void>()
    const context = contextFor(root, {
      spawn() {
        didStart()
        return fake.handle
      }
    })
    const search = new ContentsSearch(context, new WorktreePaths(context))
    const pending = search.call({ action: 'run', query: 'needle', worktree: 'fixture-worktree' })
    await started

    const cancelState = await search.call({ action: 'cancel', worktree: 'fixture-worktree' })
    const result = await pending

    expect(fake.stopCalls()).toBe(1)
    expect(cancelState.loading).toBe(false)
    expect(result).toMatchObject({ loading: false, error: null })
  })

  test('search reports read failures as incomplete and keeps only whole match lines', async () => {
    const root = temporaryRoot()
    const partial = '{"type":"match","data":'
    for (const error of [new ProcessStalledError('rg', 1), new Error('read failed')]) {
      const fake = fakeHandle({
        chunks: [matchLine('a.txt'), partial],
        readError: error,
        exitOnStop: true
      })
      const context = contextFor(root, fakeSpawner(() => fake))
      const result = await new ContentsSearch(context, new WorktreePaths(context)).call({
        action: 'run', query: 'needle', worktree: 'fixture-worktree'
      })
      expect(result).toMatchObject({
        totalMatches: 1,
        truncated: true,
        loading: false,
        error: 'Search results are incomplete: ripgrep output could not be read to its end',
        files: [{ relativePath: 'a.txt' }]
      })
      expect(fake.stopCalls()).toBe(1)
    }
  })

  test('inventory uses the shared spawner with its deadline and stderr tail', async () => {
    const root = temporaryRoot()
    for (const name of ['a', 'b', 'c']) writeFileSync(join(root, name), name)
    const calls: SpawnCall[] = []
    const context = realRunnerContext(root, 'search-inventory-inventory-spawn', calls)
    const result = await new FileInventory(context).list(root)

    expect({ paths: [...result.paths].sort(), truncated: result.truncated }).toEqual({ paths: ['a', 'b', 'c'], truncated: false })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv[0]).toBe('rg')
    expect(calls[0]?.options).toMatchObject({ timeoutMs: 30_000, cwd: root, stderrTailBytes: 24_576 })
  })

  test('inventory byte cutoff keeps only complete names and distinguishes exact EOF', async () => {
    const root = temporaryRoot()
    const stream = ['a\0b', 'b\0ccc\0']
    const cases = [
      { maxBytes: 7, paths: ['a', 'bb'], truncated: true, stop: true },
      { maxBytes: 5, paths: ['a', 'bb'], truncated: true, stop: true },
      { maxBytes: 9, paths: ['a', 'bb', 'ccc'], truncated: false, stop: false }
    ]
    for (const entry of cases) {
      const fake = fakeHandle({ chunks: stream, exitOnStop: entry.stop })
      const context = contextFor(root, fakeSpawner(() => fake))
      const result = await new FileInventory(context, { maxBytes: entry.maxBytes }).list(root)
      expect(result).toEqual({ paths: entry.paths, truncated: entry.truncated })
      expect(fake.stopCalls()).toBe(entry.stop ? 1 : 0)
    }
  })

  test('inventory deadline returns only names completed before the timeout', async () => {
    const root = temporaryRoot()
    const fake = fakeHandle({
      chunks: ['a\0bb\0cc'],
      exit: { exitCode: null, signal: 'SIGTERM', stopped: 'timeout', durationMs: 1 }
    })
    const context = contextFor(root, fakeSpawner(() => fake))

    const result = await new FileInventory(context).list(root)

    expect(result).toEqual({ paths: ['a', 'bb'], truncated: true })
    expect(fake.stopCalls()).toBe(0)
  })

  test('inventory keeps clean EOF rules and maps other exit outcomes', async () => {
    const root = temporaryRoot()
    const clean = fakeHandle({ chunks: ['a\0bb'], exit: { exitCode: 0, signal: null, durationMs: 1 } })
    const cleanContext = contextFor(root, fakeSpawner(() => clean))
    expect(await new FileInventory(cleanContext).list(root)).toEqual({ paths: ['a', 'bb'], truncated: false })

    const empty = fakeHandle({ exit: { exitCode: 1, signal: null, durationMs: 1 } })
    const emptyContext = contextFor(root, fakeSpawner(() => empty))
    expect(await new FileInventory(emptyContext).list(root)).toEqual({ paths: [], truncated: false })

    const failed = fakeHandle({ exit: { exitCode: 2, signal: null, durationMs: 1 }, stderr: 'boom' })
    const failedContext = contextFor(root, fakeSpawner(() => failed))
    await expect(new FileInventory(failedContext).list(root)).rejects.toThrow(
      'ripgrep (rg) could not list worktree files: boom'
    )

    const missing = fakeHandle({
      exit: { exitCode: null, signal: null, spawnError: { code: 'ENOENT', message: 'x' }, durationMs: 1 }
    })
    const missingContext = contextFor(root, fakeSpawner(() => missing))
    await expect(new FileInventory(missingContext).list(root)).rejects.toThrow(
      'ripgrep (rg) is required for file inventory and contents search; install ripgrep and retry'
    )
  })

  test('inventory rejects read failures and does not cache a partial listing', async () => {
    const root = temporaryRoot()
    for (const error of [new ProcessStalledError('rg', 1), new Error('read failed')]) {
      const broken = fakeHandle({ chunks: ['a\0'], readError: error, exitOnStop: true })
      const complete = fakeHandle({ chunks: ['b\0'], exit: { exitCode: 0, signal: null, durationMs: 1 } })
      let calls = 0
      const context = contextFor(root, {
        spawn() {
          calls++
          return calls === 1 ? broken.handle : complete.handle
        }
      })
      const inventory = new FileInventory(context)

      await expect(inventory.list(root)).rejects.toThrow(
        'ripgrep (rg) could not list worktree files: its output could not be read to its end'
      )
      expect(broken.stopCalls()).toBe(1)
      expect(await inventory.list(root)).toEqual({ paths: ['b'], truncated: false })
      expect(calls).toBe(2)
    }
  })
})
