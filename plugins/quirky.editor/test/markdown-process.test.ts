import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { PluginCaller, ProcessSpawner, SpawnExit, SpawnOptions, SpawnedProcess, StopOptions } from '@quirky/protocol'
import { createProcessRunner, type OwnedProcessRunner } from '../../../packages/process/src/api'
import { scanSourceContent } from '../../../scripts/spawn-lint'
import type { EditorServices } from '../src/types'
import { chooseMarkdownImage, confirmNativeReplacement } from '../src/markdown/native'
import { choosePdfDestination, exportPdfWithChrome, runProcess } from '../src/markdown/pdf'
import { createMarkdownMethods } from '../src/markdown/service'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const TAIL = 8192
const roots: string[] = []
const runners: OwnedProcessRunner[] = []
const originalChromePath = process.env.CHROME_PATH
const originalQuirkyHome = process.env.QUIRKY_HOME

type SpawnCall = { argv: string[]; options: SpawnOptions }
type FakePlan = {
  exit?: SpawnExit
  exitPromise?: Promise<SpawnExit>
  stdout?: ReadableStream<Uint8Array>
  stderr?: string
  onStop?: (options: StopOptions, resolveExit: (exit: SpawnExit) => void) => void
}
type FakeRun = { handle: SpawnedProcess; stops: StopOptions[] }

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'quirky-markdown-process-'))
  roots.push(root)
  return root
}

function setChromePath(root: string): string {
  const path = join(root, 'chrome-fixture')
  writeFileSync(path, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  chmodSync(path, 0o700)
  process.env.CHROME_PATH = path
  return path
}

function textStream(...chunks: string[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index++]
      if (chunk === undefined) controller.close()
      else controller.enqueue(Buffer.from(chunk))
    }
  })
}
function byteStream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream({
    pull(controller) {
      const chunk = chunks[index++]
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    }
  })
}

function controlledStream(): { stream: ReadableStream<Uint8Array>; close(): void; fail(error: Error): void } {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  return {
    stream: new ReadableStream<Uint8Array>({ start(value) { controller = value } }),
    close() { controller?.close() },
    fail(error) { controller?.error(error) }
  }
}

function fakeHandle(plan: FakePlan, runs: FakeRun[]): SpawnedProcess {
  const deferred = Promise.withResolvers<SpawnExit>()
  const exited = plan.exitPromise ?? (plan.exit === undefined ? deferred.promise : Promise.resolve(plan.exit))
  const stops: StopOptions[] = []
  const run: FakeRun = {
    stops,
    handle: undefined as unknown as SpawnedProcess
  }
  const handle: SpawnedProcess = {
    pid: 123,
    stdout: plan.stdout ?? textStream(),
    stderrTail: () => plan.stderr ?? '',
    write: async () => true,
    closeInput: async () => {},
    exited,
    stop: async (options) => {
      const selected = options ?? {}
      stops.push(selected)
      plan.onStop?.(selected, (exit) => deferred.resolve(exit))
      return await exited
    }
  }
  run.handle = handle
  runs.push(run)
  return handle
}

function recordingSpawner(
  makePlan: (argv: readonly string[], options: SpawnOptions, runs: FakeRun[]) => FakePlan,
  calls: SpawnCall[] = [],
  runs: FakeRun[] = []
): ProcessSpawner {
  return {
    spawn(argv, options) {
      calls.push({ argv: [...argv], options })
      return fakeHandle(makePlan(argv, options, runs), runs)
    }
  }
}

function pdfBytes(): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(256, 0x78), Buffer.from('\n%%EOF\n')])
}

function outputPathFrom(argv: readonly string[], prefix: string): string {
  const value = argv.find((argument) => argument.startsWith(prefix))
  if (!value) throw new Error(`Missing process argument ${prefix}`)
  return value.slice(prefix.length)
}

function exportFixture(
  plan: (renderedPdf: string, runs: FakeRun[]) => FakePlan,
  settings: { existing?: boolean; timeoutMs?: number; pollIntervalMs?: number } = {}
): {
  root: string
  outputPath: string
  calls: SpawnCall[]
  runs: FakeRun[]
  promise: Promise<{ path: string; size: number }>
} {
  const root = temporaryRoot()
  setChromePath(root)
  const outputPath = join(root, 'report.pdf')
  if (settings.existing !== false) writeFileSync(outputPath, 'existing destination bytes')
  const calls: SpawnCall[] = []
  const runs: FakeRun[] = []
  const runner = recordingSpawner((argv, _options, activeRuns) => {
    const renderedPdf = outputPathFrom(argv, '--print-to-pdf=')
    return plan(renderedPdf, activeRuns)
  }, calls, runs)
  const promise = exportPdfWithChrome(runner, {
    title: 'report.md',
    html: '<p>fixture</p>',
    outputPath,
    replaceExisting: settings.existing !== false
  }, {
    timeoutMs: settings.timeoutMs ?? 60_000,
    pollIntervalMs: settings.pollIntervalMs ?? 5
  })
  return { root, outputPath, calls, runs, promise }
}

function expectSpawnConfiguration(call: SpawnCall, timeoutMs: number, home: string, signal?: AbortSignal): void {
  const profile = outputPathFrom(call.argv, '--user-data-dir=')
  const renderedPdf = outputPathFrom(call.argv, '--print-to-pdf=')
  const temp = dirname(profile)
  expect(call.argv).toEqual([
    process.env.CHROME_PATH!,
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    `--user-data-dir=${profile}`,
    `--print-to-pdf=${renderedPdf}`,
    '--print-to-pdf-no-header',
    `file://${join(temp, 'document.html')}`
  ])
  expect(call.options).toMatchObject({
    timeoutMs,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'tail',
    stderrTailBytes: TAIL * 4,
    killGraceMs: 0,
    ...(signal === undefined ? {} : { signal })
  })
  expect(call.options.env).toEqual({ ...process.env, HOME: home, USERPROFILE: home })
}

function expectCleaned(fixture: { root: string; outputPath: string; calls: SpawnCall[] }): void {
  expect(fixture.calls).toHaveLength(1)
  const profile = outputPathFrom(fixture.calls[0]!.argv, '--user-data-dir=')
  const temp = dirname(profile)
  expect(existsSync(temp)).toBe(false)
  expect(readdirSync(fixture.root).filter((entry) => entry.startsWith('.report.pdf.') && entry.endsWith('.tmp'))).toEqual([])
}

function assertPdfPublished(path: string): void {
  expect(existsSync(path)).toBe(true)
  expect(readFileSync(path).subarray(0, 5).toString('ascii')).toBe('%PDF-')
  expect(readFileSync(path).subarray(-2048).toString('latin1')).toMatch(/%%EOF\s*$/)
}

function assertDestinationPreserved(path: string): void {
  expect(readFileSync(path, 'utf8')).toBe('existing destination bytes')
}

function deactivationTestScript(resultPath: string): string {
  return `
import { expect, mock, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
const events = []
const coreDisposal = Promise.withResolvers()
class FakeCore {
  services = {}
  methods = {}
  projectPublic(_name, value) { return value }
  async restore() {}
  async dispose() {
    events.push('core-dispose-start')
    await coreDisposal.promise
    events.push('core-dispose-end')
  }
}
mock.module('../src/daemon/service', () => ({ EditorDaemon: FakeCore }))
mock.module('../src/markdown/service', () => ({
  createMarkdownMethods: () => ({ methods: {}, dispose() { events.push('markdown-dispose') } })
}))
mock.module('../src/notebook/service', () => ({
  createNotebookMethods: () => ({ methods: {}, dispose() { events.push('notebook-dispose') } })
}))
mock.module('../src/viewers/service', () => ({
  createViewerMethods: () => ({ methods: {}, dispose() { events.push('viewer-dispose') } })
}))
test('Markdown disposal begins before core cleanup is awaited', async () => {
  // This subprocess isolates Bun module mocks and the plugin module's lifecycle state.
  const main = await import('../main')
  await main.activate({ pluginId: 'quirky.editor', subscribe: () => () => {}, provide() {} })
  const pending = main.deactivate()
  expect(events.slice(0, 2)).toEqual(['markdown-dispose', 'core-dispose-start'])
  coreDisposal.resolve()
  await pending
  expect(events.slice(0, 3)).toEqual(['markdown-dispose', 'core-dispose-start', 'core-dispose-end'])
  writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify(events))
})
`
}

afterEach(async () => {
  try {
    for (const runner of runners.splice(0)) await runner.dispose()
  } finally {
    try {
      for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
    } finally {
      if (originalChromePath === undefined) delete process.env.CHROME_PATH
      else process.env.CHROME_PATH = originalChromePath
      if (originalQuirkyHome === undefined) delete process.env.QUIRKY_HOME
      else process.env.QUIRKY_HOME = originalQuirkyHome
    }
  }
})

describe('Markdown process output and failures', () => {
  test('uses the injected spawner, bounded stderr tail, and an incremental UTF-8 stdout tail', async () => {
    const calls: SpawnCall[] = []
    const runs: FakeRun[] = []
    const multibyte = Buffer.from('é🙂')
    const runner = recordingSpawner(() => ({
      stdout: byteStream(
        Buffer.from('x'.repeat(TAIL - 4)),
        Buffer.from('y'),
        multibyte.subarray(0, 3),
        multibyte.subarray(3)
      ),
      stderr: `${'d'.repeat(TAIL - 1)}é🙂`,
      exit: { exitCode: 0, signal: null, durationMs: 1 }
    }), calls, runs)
    const result = await runProcess(runner, 'fixture-command', ['arg'], { timeoutMs: 1234 })
    const expected = `${'x'.repeat(TAIL - 4)}yé🙂`
    expect(result.stdout).toBe(expected)
    expect(result.stderr).toBe(`${'d'.repeat(TAIL - 3)}é🙂`)
    expect(result.code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!).toMatchObject({
      argv: ['fixture-command', 'arg'],
      options: { timeoutMs: 1234, stdin: 'ignore', stdout: 'pipe', stderr: 'tail', stderrTailBytes: TAIL * 4, killGraceMs: 0 }
    })
  })

  test('keeps exact N−1, N and N+1 character tails', async () => {
    for (const length of [TAIL - 1, TAIL, TAIL + 1]) {
      const calls: SpawnCall[] = []
      const runner = recordingSpawner(() => ({
        stdout: textStream('a'.repeat(length)),
        stderr: 'b'.repeat(length),
        exit: { exitCode: 0, signal: null, durationMs: 1 }
      }), calls)
      const result = await runProcess(runner, 'fixture', [], { timeoutMs: 100 })
      expect(result.stdout).toBe('a'.repeat(Math.min(length, TAIL)))
      expect(result.stderr).toBe('b'.repeat(Math.min(length, TAIL)))
      expect(calls).toHaveLength(1)
      expect(calls[0]!.argv).toEqual(['fixture'])
    }
  })

  test('waits for both exit and stdout while retaining ordinary nonzero results', async () => {
    const calls: SpawnCall[] = []
    const stream = controlledStream()
    const exit = Promise.withResolvers<SpawnExit>()
    const runs: FakeRun[] = []
    const runner = recordingSpawner(() => ({ exitPromise: exit.promise, stdout: stream.stream }), calls, runs)
    let settled = false
    const pending = runProcess(runner, 'fixture', [], { timeoutMs: 200 }).finally(() => { settled = true })
    stream.close()
    await Promise.resolve()
    expect(settled).toBe(false)
    exit.resolve({ exitCode: 7, signal: null, durationMs: 1 })
    expect((await pending).code).toBe(7)
    expect(calls).toHaveLength(1)
  })

  test('maps missing executables and synchronous spawn throws to errors', async () => {
    const missingCalls: SpawnCall[] = []
    const missing = recordingSpawner(() => ({
      exit: { exitCode: null, signal: null, spawnError: { code: 'ENOENT', message: 'missing fixture' }, durationMs: 1 }
    }), missingCalls)
    await expect(runProcess(missing, 'missing', [], { timeoutMs: 50 })).rejects.toThrow('missing fixture')
    expect(missingCalls).toHaveLength(1)

    const thrownCalls: SpawnCall[] = []
    const thrown: ProcessSpawner = {
      spawn(argv, options) {
        thrownCalls.push({ argv: [...argv], options })
        throw new Error('synchronous fixture failure')
      }
    }
    await expect(runProcess(thrown, 'throwing', [], { timeoutMs: 50 })).rejects.toThrow('synchronous fixture failure')
    expect(thrownCalls).toHaveLength(1)
  })

  test('classifies runner and whole-call timeouts, aborts, and unowned stops', async () => {
    const timedCalls: SpawnCall[] = []
    const timed = recordingSpawner(() => ({
      exit: { exitCode: null, signal: 'SIGKILL', stopped: 'timeout', durationMs: 1 }
    }), timedCalls)
    await expect(runProcess(timed, 'timed', [], { timeoutMs: 40 })).rejects.toThrow('Process timed out after 40 ms.')
    expect(timedCalls).toHaveLength(1)

    const stalledCalls: SpawnCall[] = []
    const held = controlledStream()
    const stoppedRuns: FakeRun[] = []
    const stalled = recordingSpawner((_argv, _options, activeRuns) => ({
      stdout: held.stream,
      exit: { exitCode: 0, signal: null, durationMs: 1 },
      onStop(_options, resolveExit) {
        held.close()
        resolveExit({ exitCode: 0, signal: null, durationMs: 1 })
      }
    }), stalledCalls, stoppedRuns)
    await expect(runProcess(stalled, 'held-output', [], { timeoutMs: 20 })).rejects.toThrow('Process timed out after 20 ms.')
    expect(stalledCalls).toHaveLength(1)
    expect(stoppedRuns[0]!.stops).toContainEqual({ signal: 'SIGKILL', graceMs: 0 })

    const abortCalls: SpawnCall[] = []
    const abortRuns: FakeRun[] = []
    const abortPlanStream = controlledStream()
    const abortController = new AbortController()
    const aborting = recordingSpawner(() => ({
      stdout: abortPlanStream.stream,
      onStop(_options, resolveExit) {
        abortPlanStream.close()
        resolveExit({ exitCode: null, signal: 'SIGKILL', stopped: 'aborted', durationMs: 1 })
      }
    }), abortCalls, abortRuns)
    const abortPending = runProcess(aborting, 'aborted', [], { timeoutMs: 100, signal: abortController.signal })
    abortController.abort()
    await expect(abortPending).rejects.toThrow('Process was aborted.')
    expect(abortCalls).toHaveLength(1)
    expect(abortRuns[0]!.stops).toContainEqual({ signal: 'SIGKILL', graceMs: 0 })

    const stoppedCalls: SpawnCall[] = []
    const stopped = recordingSpawner(() => ({
      exit: { exitCode: null, signal: 'SIGTERM', stopped: 'stop', durationMs: 1 }
    }), stoppedCalls)
    await expect(runProcess(stopped, 'stopped', [], { timeoutMs: 100 })).rejects.toThrow('Process was stopped.')
    expect(stoppedCalls).toHaveLength(1)
  })

  test('kills and rejects a stdout read failure instead of treating it as EOF', async () => {
    const failure = new Error('stdout read failed')
    const stream = controlledStream()
    const calls: SpawnCall[] = []
    const runs: FakeRun[] = []
    const runner = recordingSpawner(() => ({
      stdout: stream.stream,
      onStop(_options, resolveExit) { resolveExit({ exitCode: null, signal: 'SIGKILL', stopped: 'stop', durationMs: 1 }) }
    }), calls, runs)
    const pending = runProcess(runner, 'bad-output', [], { timeoutMs: 100 })
    stream.fail(failure)
    await expect(pending).rejects.toBe(failure)
    expect(calls).toHaveLength(1)
    expect(runs[0]!.stops[0]).toEqual({ signal: 'SIGKILL', graceMs: 0 })
  })
})

describe('Markdown PDF publication gate', () => {
  test('publishes a complete artifact only after an owned graceful completion stop', async () => {
    const timeline: string[] = []
    const fixture = exportFixture((renderedPdf) => ({
      onStop(options, resolveExit) {
        timeline.push('stop-requested')
        expect(existsSync(renderedPdf)).toBe(true)
        expect(options).toEqual({ graceMs: 2000 })
        resolveExit({ exitCode: null, signal: 'SIGTERM', stopped: 'stop', durationMs: 1 })
      },
      stdout: textStream()
    }))
    expect(existsSync(outputPathFrom(fixture.calls[0]!.argv, '--print-to-pdf='))).toBe(false)
    writeFileSync(outputPathFrom(fixture.calls[0]!.argv, '--print-to-pdf='), pdfBytes())
    timeline.unshift('artifact-written')
    const result = await fixture.promise
    expect(timeline).toEqual(['artifact-written', 'stop-requested'])
    expect(fixture.calls).toHaveLength(1)
    expectSpawnConfiguration(fixture.calls[0]!, 60_000, dirname(outputPathFrom(fixture.calls[0]!.argv, '--user-data-dir=')))
    assertPdfPublished(fixture.outputPath)
    expect(result).toEqual({ path: fixture.outputPath, size: pdfBytes().length })
    expect(fixture.runs[0]!.stops).toEqual([{ graceMs: 2000 }])
    expectCleaned(fixture)
  })

  test('publishes a complete artifact after an unstopped exit 0 before the first poll', async () => {
    const fixture = exportFixture((renderedPdf) => {
      writeFileSync(renderedPdf, pdfBytes())
      return { exit: { exitCode: 0, signal: null, durationMs: 1 }, stdout: textStream() }
    })
    const result = await fixture.promise
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.runs[0]!.stops).toEqual([])
    assertPdfPublished(fixture.outputPath)
    expect(result.size).toBe(pdfBytes().length)
    expectCleaned(fixture)
    expectSpawnConfiguration(fixture.calls[0]!, 60_000, dirname(outputPathFrom(fixture.calls[0]!.argv, '--user-data-dir=')))
  })

  test('rejects a complete artifact after an ordinary nonzero exit', async () => {
    const fixture = exportFixture((renderedPdf) => {
      writeFileSync(renderedPdf, pdfBytes())
      return { exit: { exitCode: 3, signal: null, durationMs: 1 }, stdout: textStream() }
    })
    await expect(fixture.promise).rejects.toThrow('Chrome PDF export failed: exit code 3')
    expect(fixture.calls).toHaveLength(1)
    assertDestinationPreserved(fixture.outputPath)
    expectCleaned(fixture)
  })

  test('rejects a partial artifact after a nonzero exit', async () => {
    const fixture = exportFixture((renderedPdf) => {
      writeFileSync(renderedPdf, Buffer.from('%PDF- partial'))
      return { exit: { exitCode: 2, signal: null, durationMs: 1 }, stdout: textStream() }
    })
    await expect(fixture.promise).rejects.toThrow('Chrome PDF export failed: exit code 2')
    expect(fixture.calls).toHaveLength(1)
    assertDestinationPreserved(fixture.outputPath)
    expectCleaned(fixture)
  })

  test('rejects a complete artifact created between polls when the whole-call deadline expires', async () => {
    const fixture = exportFixture(() => ({
      onStop(_options, resolveExit) { resolveExit({ exitCode: null, signal: 'SIGKILL', stopped: 'stop', durationMs: 1 }) },
      stdout: textStream()
    }), { timeoutMs: 30, pollIntervalMs: 10_000 })
    await Promise.resolve()
    writeFileSync(outputPathFrom(fixture.calls[0]!.argv, '--print-to-pdf='), pdfBytes())
    await expect(fixture.promise).rejects.toThrow('Process timed out after 30 ms.')
    expect(fixture.calls).toHaveLength(1)
    assertDestinationPreserved(fixture.outputPath)
    expect(fixture.runs[0]!.stops).toContainEqual({ signal: 'SIGKILL', graceMs: 0 })
    expectCleaned(fixture)
  })

  test('rejects a partial artifact on timeout', async () => {
    const fixture = exportFixture(() => ({
      onStop(_options, resolveExit) { resolveExit({ exitCode: null, signal: 'SIGKILL', stopped: 'stop', durationMs: 1 }) },
      stdout: textStream()
    }), { timeoutMs: 20 })
    writeFileSync(outputPathFrom(fixture.calls[0]!.argv, '--print-to-pdf='), Buffer.from('%PDF-partial'))
    await expect(fixture.promise).rejects.toThrow('Process timed out after 20 ms.')
    expect(fixture.calls).toHaveLength(1)
    assertDestinationPreserved(fixture.outputPath)
    expectCleaned(fixture)
  })

  test('rejects a spawn error without publishing', async () => {
    const fixture = exportFixture(() => ({
      exit: { exitCode: null, signal: null, spawnError: { code: 'ENOENT', message: 'Chrome fixture missing' }, durationMs: 1 },
      stdout: textStream()
    }))
    await expect(fixture.promise).rejects.toThrow('Chrome fixture missing')
    expect(fixture.calls).toHaveLength(1)
    assertDestinationPreserved(fixture.outputPath)
    expectCleaned(fixture)
  })

  test('rejects direct runner disposal with a complete artifact before any owned stop', async () => {
    const fixture = exportFixture((renderedPdf) => {
      writeFileSync(renderedPdf, pdfBytes())
      return { exit: { exitCode: null, signal: 'SIGKILL', stopped: 'aborted', durationMs: 1 }, stdout: textStream() }
    })
    await expect(fixture.promise).rejects.toThrow('Process was aborted.')
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.runs[0]!.stops).toEqual([])
    assertDestinationPreserved(fixture.outputPath)
    expectCleaned(fixture)
  })

  test('rejects runner disposal with a partial artifact', async () => {
    const fixture = exportFixture((renderedPdf) => {
      writeFileSync(renderedPdf, Buffer.from('%PDF-partial'))
      return { exit: { exitCode: null, signal: 'SIGKILL', stopped: 'aborted', durationMs: 1 }, stdout: textStream() }
    })
    await expect(fixture.promise).rejects.toThrow('Process was aborted.')
    expect(fixture.calls).toHaveLength(1)
    assertDestinationPreserved(fixture.outputPath)
    expectCleaned(fixture)
  })

  test('rejects a stdout read error even with a complete artifact and exit 0', async () => {
    const failure = new Error('Chrome stdout failed')
    const stream = controlledStream()
    const fixture = exportFixture((renderedPdf) => {
      writeFileSync(renderedPdf, pdfBytes())
      stream.fail(failure)
      return {
        exit: { exitCode: 0, signal: null, durationMs: 1 },
        stdout: stream.stream,
        onStop(_options, resolveExit) { resolveExit({ exitCode: 0, signal: null, durationMs: 1 }) }
      }
    })
    await expect(fixture.promise).rejects.toBe(failure)
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.runs[0]!.stops[0]).toEqual({ signal: 'SIGKILL', graceMs: 0 })
    assertDestinationPreserved(fixture.outputPath)
    expectCleaned(fixture)
  })

  test('rejects invalid artifacts, an owned-stop race with a nonzero exit, and a read error after owned stop', async () => {
    const invalid = exportFixture((renderedPdf) => {
      writeFileSync(renderedPdf, Buffer.alloc(256, 0x61))
      return { exit: { exitCode: 0, signal: null, durationMs: 1 }, stdout: textStream() }
    })
    await expect(invalid.promise).rejects.toThrow('Chrome output is not a valid PDF file.')
    expect(invalid.calls).toHaveLength(1)
    assertDestinationPreserved(invalid.outputPath)
    expectCleaned(invalid)

    const raced = exportFixture((renderedPdf) => {
      writeFileSync(renderedPdf, pdfBytes())
      return {
        stdout: textStream(),
        onStop(_options, resolveExit) { resolveExit({ exitCode: 4, signal: null, durationMs: 1 }) }
      }
    })
    await expect(raced.promise).rejects.toThrow('Chrome PDF export failed: exit code 4')
    expect(raced.calls).toHaveLength(1)
    expect(raced.runs[0]!.stops).toEqual([{ graceMs: 2000 }])
    assertDestinationPreserved(raced.outputPath)
    expectCleaned(raced)

    const failure = new Error('read failed after stop')
    const held = controlledStream()
    const afterStop = exportFixture((renderedPdf) => {
      writeFileSync(renderedPdf, pdfBytes())
      let stopCount = 0
      return {
        stdout: held.stream,
        onStop(_options, resolveExit) {
          stopCount += 1
          if (stopCount === 1) {
            held.fail(failure)
            resolveExit({ exitCode: null, signal: 'SIGTERM', stopped: 'stop', durationMs: 1 })
          }
        }
      }
    })
    await expect(afterStop.promise).rejects.toBe(failure)
    expect(afterStop.calls).toHaveLength(1)
    expect(afterStop.runs[0]!.stops[0]).toEqual({ graceMs: 2000 })
    assertDestinationPreserved(afterStop.outputPath)
    expectCleaned(afterStop)
  })
})

describe('Markdown feature disposal and native dialogs', () => {
  test('aborts an export synchronously on feature disposal during owned-stop grace', async () => {
    const root = temporaryRoot()
    setChromePath(root)
    const outputPath = join(root, 'report.pdf')
    const stopEntered = Promise.withResolvers<void>()
    const calls: SpawnCall[] = []
    const runs: FakeRun[] = []
    const runner = recordingSpawner((argv) => {
      writeFileSync(outputPathFrom(argv, '--print-to-pdf='), pdfBytes())
      return {
        stdout: textStream(),
        onStop(options, resolveExit) {
          if (options.graceMs === 2000) stopEntered.resolve()
          else resolveExit({ exitCode: 0, signal: null, stopped: 'stop', durationMs: 1 })
        }
      }
    }, calls, runs)
    const buffer = {
      id: 'buffer-1', kind: 'markdown', mode: 'rich', content: '# Fixture', draft: null,
      relativePath: 'report.md', name: 'report.md', root, worktreeId: 'worktree-1', readOnly: false
    }
    const host = {
      context: { process: runner, error: (_kind: string, message: string) => new Error(message) },
      get: () => buffer,
      resolve: async () => ({ id: 'worktree-1', path: root }),
      path: async (_worktree: string, relativePath: string) => {
        const path = join(root, relativePath)
        mkdirSync(dirname(path), { recursive: true })
        return path
      },
      onClose: () => () => {}
    } as unknown as EditorServices
    const methods = createMarkdownMethods(host)
    const pending = methods.methods.markdown({ action: 'exportPdf', bufferId: buffer.id, path: 'report.pdf' }, {} as PluginCaller)
    await stopEntered.promise
    methods.dispose()
    methods.dispose()
    expect((calls[0]!.options.signal as AbortSignal).aborted).toBe(true)
    await expect(pending).rejects.toThrow('Process was aborted.')
    const rendered = outputPathFrom(calls[0]!.argv, '--print-to-pdf=')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.options.signal).toBeInstanceOf(AbortSignal)
    expect(runs[0]!.stops).toEqual([{ graceMs: 2000 }, { signal: 'SIGKILL', graceMs: 0 }])
    expect(existsSync(outputPath)).toBe(false)
    expect(existsSync(dirname(rendered))).toBe(false)
    expect(readdirSync(root).filter((entry) => entry.startsWith('.report.pdf.') && entry.endsWith('.tmp'))).toEqual([])

    await expect(methods.methods.markdown({ action: 'exportPdf', bufferId: buffer.id, path: 'report.pdf' }, {} as PluginCaller)).rejects.toThrow('Process was aborted.')
    expect(calls).toHaveLength(1)
  })
  test('main deactivation starts Markdown disposal before a held core disposer', async () => {
    const root = temporaryRoot()
    const scriptPath = join(import.meta.dir, 'markdown-main-deactivation.fixture.test.ts')
    const resultPath = join(root, 'deactivation-order.json')
    const runner = createProcessRunner({ owner: 'markdown-deactivation-order' })
    runners.push(runner)
    const previousHome = process.env.QUIRKY_HOME
    process.env.QUIRKY_HOME = root
    try {
      writeFileSync(scriptPath, deactivationTestScript(resultPath))
      const result = await runProcess(runner, process.execPath, ['test', scriptPath], { timeoutMs: 15_000, home: root })
      expect(result.code).toBe(0)
      expect(JSON.parse(readFileSync(resultPath, 'utf8'))).toEqual([
        'markdown-dispose',
        'core-dispose-start',
        'core-dispose-end',
        'notebook-dispose',
        'viewer-dispose'
      ])
    } finally {
      rmSync(scriptPath, { force: true })
      if (previousHome === undefined) delete process.env.QUIRKY_HOME
      else process.env.QUIRKY_HOME = previousHome
    }
  })


  test('routes native chooser and replacement helpers through the recording spawner', async () => {
    if (process.platform !== 'darwin') {
      const calls: SpawnCall[] = []
      const runner = recordingSpawner(() => ({ exit: { exitCode: 0, signal: null, durationMs: 1 } }), calls)
      await expect(choosePdfDestination(runner, 'guide.md')).rejects.toThrow('A native PDF save dialog is available only on macOS')
      await expect(chooseMarkdownImage(runner)).rejects.toThrow('A native image chooser is available only on macOS')
      expect(await confirmNativeReplacement(runner, '/tmp/guide.pdf')).toBe(false)
      expect(calls).toEqual([])
      return
    }

    const calls: SpawnCall[] = []
    let index = 0
    const runner = recordingSpawner(() => {
      index += 1
      return {
        stdout: textStream(index === 1 ? '/tmp/guide.pdf\n' : index === 2 ? '/tmp/image.png\n' : 'button returned:Replace\n'),
        exit: { exitCode: 0, signal: null, durationMs: 1 }
      }
    }, calls)
    const signal = new AbortController().signal
    expect(await choosePdfDestination(runner, 'guide.md', signal)).toBe('/tmp/guide.pdf')
    expect(await chooseMarkdownImage(runner)).toBe('/tmp/image.png')
    expect(await confirmNativeReplacement(runner, '/tmp/guide.pdf', signal)).toBe(true)
    expect(calls.map(({ argv }) => argv)).toEqual([
      ['osascript', '-e', 'POSIX path of (choose file name with prompt "Export Markdown as PDF" default name "guide.pdf" )'],
      ['osascript', '-e', 'POSIX path of (choose file with prompt "Import an image into this Markdown document")'],
      ['osascript', '-e', 'display dialog "/tmp/guide.pdf already exists. Replace it?" buttons {"Cancel", "Replace"} default button "Replace" cancel button "Cancel"']
    ])
    expect(calls.map(({ options }) => options.timeoutMs)).toEqual([300_000, 300_000, 300_000])
    expect(calls[0]!.options.signal).toBe(signal)
    expect(calls[2]!.options.signal).toBe(signal)
  })

  test('maps native cancellation and preserves dialog errors after process classification', async () => {
    if (process.platform !== 'darwin') return
    const calls: SpawnCall[] = []
    let index = 0
    const runner = recordingSpawner(() => {
      index += 1
      return {
        stderr: index === 1 ? 'User cancelled' : index === 2 ? '' : index === 3 ? '-128' : index === 4 ? 'button returned:Cancel' : index === 5 ? 'Save failed' : 'Replace failed',
        stdout: textStream(index === 2 ? 'User canceled' : index === 4 ? 'detail' : ''),
        exit: { exitCode: index === 1 ? 1 : 2, signal: null, durationMs: 1 }
      }
    }, calls)
    expect(await choosePdfDestination(runner, 'guide.md')).toBeNull()
    expect(await chooseMarkdownImage(runner)).toBeNull()
    expect(await confirmNativeReplacement(runner, '/tmp/guide.pdf')).toBe(false)
    await expect(chooseMarkdownImage(runner)).rejects.toThrow('Could not open the image chooser: button returned:Cancel')
    await expect(choosePdfDestination(runner, 'guide.md')).rejects.toThrow('Could not open the PDF save dialog: Save failed')
    await expect(confirmNativeReplacement(runner, '/tmp/guide.pdf')).rejects.toThrow('Could not confirm replacement: Replace failed')
    expect(calls).toHaveLength(6)

    const timeoutCalls: SpawnCall[] = []
    const timeout = recordingSpawner(() => ({
      stderr: 'User canceled',
      exit: { exitCode: null, signal: 'SIGKILL', stopped: 'timeout', durationMs: 1 }
    }), timeoutCalls)
    await expect(chooseMarkdownImage(timeout)).rejects.toThrow('Process timed out after 300000 ms.')
    expect(timeoutCalls).toHaveLength(1)

    const abortCalls: SpawnCall[] = []
    const aborted = recordingSpawner(() => ({
      stderr: 'User canceled',
      exit: { exitCode: null, signal: 'SIGKILL', stopped: 'aborted', durationMs: 1 }
    }), abortCalls)
    await expect(chooseMarkdownImage(aborted)).rejects.toThrow('Process was aborted.')
    expect(abortCalls).toHaveLength(1)

    const readFailure = new Error('dialog stdout read failed')
    const stream = controlledStream()
    const readCalls: SpawnCall[] = []
    const broken = recordingSpawner(() => ({
      stderr: 'User canceled',
      stdout: stream.stream,
      exit: { exitCode: 0, signal: null, durationMs: 1 },
      onStop() {}
    }), readCalls)
    const pending = chooseMarkdownImage(broken)
    stream.fail(readFailure)
    await expect(pending).rejects.toBe(readFailure)
    expect(readCalls).toHaveLength(1)
  })
})

describe('large Markdown command output', () => {
  const MiB = 1024 * 1024
  const outputSize = 64 * MiB

  function largeOutputFixture(interleaved: boolean): string {
    return `
const { once } = require('node:events')
const chunkSize = 64 * 1024
const total = ${outputSize}
const out = Buffer.alloc(chunkSize, 0x6f)
const err = Buffer.alloc(chunkSize, 0x65)
async function write(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, 'drain')
}
async function finish(stream, marker) {
  if (!stream.write(marker)) await once(stream, 'drain')
}
async function main() {
  if (${interleaved}) {
    for (let offset = 0; offset < total; offset += chunkSize) {
      await write(process.stdout, out)
      await write(process.stderr, err)
    }
  } else {
    for (let offset = 0; offset < total; offset += chunkSize) await write(process.stdout, out)
    for (let offset = 0; offset < total; offset += chunkSize) await write(process.stderr, err)
  }
  await finish(process.stdout, 'OUT-END')
  await finish(process.stderr, 'ERR-END')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
`
  }

  for (const interleaved of [false, true]) {
    test(`drains 64 MiB per stream without overflow (${interleaved ? 'interleaved' : 'sequential'})`, async () => {
      const root = temporaryRoot()
      const script = join(root, 'large-output.cjs')
      writeFileSync(script, largeOutputFixture(interleaved))
      const runner = createProcessRunner({ owner: `markdown-output-${interleaved ? 'interleaved' : 'sequential'}` })
      runners.push(runner)
      const calls: SpawnCall[] = []
      const exits: Promise<SpawnExit>[] = []
      const recording: ProcessSpawner = {
        spawn(argv, options) {
          calls.push({ argv: [...argv], options })
          const handle = runner.spawn(argv, options)
          exits.push(handle.exited)
          return handle
        }
      }
      const previousHome = process.env.QUIRKY_HOME
      process.env.QUIRKY_HOME = root
      try {
        const result = await runProcess(recording, process.execPath, [script], { timeoutMs: 60_000, home: root })
        const expectedStdout = `${'o'.repeat(TAIL - 'OUT-END'.length)}OUT-END`
        const expectedStderr = `${'e'.repeat(TAIL - 'ERR-END'.length)}ERR-END`
        expect(result.code).toBe(0)
        expect((await exits[0]!).stopped).toBeUndefined()
        expect(result.stdout).toBe(expectedStdout)
        expect(result.stderr).toBe(expectedStderr)
        expect(calls).toHaveLength(1)
        expect(calls[0]!.options).toMatchObject({
          timeoutMs: 60_000,
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'tail',
          stderrTailBytes: TAIL * 4,
          killGraceMs: 0
        })
        console.log(`Markdown fixture consumed ${2 * (outputSize + 'OUT-END'.length)} bytes${interleaved ? ' interleaved' : ''}`)
      } finally {
        if (previousHome === undefined) delete process.env.QUIRKY_HOME
        else process.env.QUIRKY_HOME = previousHome
      }
    })
  }
})

test('migrated Markdown process sources have no direct spawns or baseline allowance and retain the API floor', () => {
  const migratedFiles = [
    'plugins/quirky.editor/main.ts',
    'plugins/quirky.editor/src/markdown/pdf.ts',
    'plugins/quirky.editor/src/markdown/native.ts',
    'plugins/quirky.editor/src/markdown/service.ts'
  ]
  for (const file of migratedFiles) {
    expect(scanSourceContent(file, readFileSync(resolve(REPO_ROOT, file), 'utf8'))).toEqual([])
  }
  const baseline = JSON.parse(readFileSync(resolve(REPO_ROOT, 'scripts/spawn-lint-baseline.json'), 'utf8')) as Record<string, number>
  for (const file of migratedFiles) expect(baseline[file]).toBeUndefined()
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'plugins/quirky.editor/quirky-plugin.json'), 'utf8')) as { apiVersion: string }
  const version = manifest.apiVersion.split('.').map(Number)
  const floor = [1, 6, 0]
  const comparison = version[0]! - floor[0]! || version[1]! - floor[1]! || version[2]! - floor[2]!
  expect(comparison).toBeGreaterThanOrEqual(0)
})
