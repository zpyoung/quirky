import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, PluginStore, ProcessRunner, RunOptions, RunResult } from '@quirky/protocol'
import { scanSourceContent } from '../../../scripts/spawn-lint'
import { ExplorerService, ignoredPaths } from '../src/daemon/explorer'
import type { FileInventory } from '../src/daemon/inventory'
import type { WorktreePaths } from '../src/daemon/paths'

const cap = 1_048_576
const roots: string[] = []
type Call = { argv: readonly string[]; options: RunOptions }

function result(stdoutText = '', rest: Partial<RunResult> = {}): RunResult {
  return { stdout: new TextEncoder().encode(stdoutText), stdoutText, stderr: '', exitCode: 0, signal: null, durationMs: 0, ...rest }
}

function recording(run: (call: Call, index: number) => Promise<RunResult> | RunResult = () => result()) {
  const calls: Call[] = []
  const runner: ProcessRunner = {
    async run(argv, options = {}) {
      const call = { argv, options }
      calls.push(call)
      return await run(call, calls.length - 1)
    }
  }
  return { runner, calls }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('editor git-ignore runner ownership', () => {
  test('keeps NUL paths and exact bounded, nonshared run options', async () => {
    const { runner, calls } = recording(() => result('line\nbreak\0é\0unfinished'))
    expect(await ignoredPaths(runner, '/fixture', ['a b', 'line\nbreak', 'é'])).toEqual(new Set(['line\nbreak', 'é']))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv).toEqual(['git', 'check-ignore', '-z', '--stdin'])
    expect(calls[0]!.options).toEqual({ cwd: '/fixture', input: 'a b\0line\nbreak\0é\0', timeoutMs: 5000, killGraceMs: 0, maxOutputBytes: cap, signal: expect.any(AbortSignal) })
  })

  for (const bytes of [cap - 1, cap, cap + 1]) {
    test(`batches ${bytes} UTF-8 bytes without splitting a path`, async () => {
      const first = 'é'.repeat((cap - 2) / 2)
      const paths = bytes === cap - 1 ? [first] : bytes === cap ? [first + 'x'] : [first, 'x']
      const { runner, calls } = recording(({ options }) => result(String(options.input)))
      expect(await ignoredPaths(runner, '/fixture', paths)).toEqual(new Set(paths))
      expect(calls).toHaveLength(bytes > cap ? 2 : 1)
      expect(calls.map(({ options }) => Buffer.byteLength(String(options.input))).reduce((sum, size) => sum + size, 0)).toBe(bytes)
      for (const { options } of calls) {
        expect(Buffer.byteLength(String(options.input))).toBeLessThanOrEqual(cap)
        expect(String(options.input).endsWith('\0')).toBe(true)
      }
      if (calls.length > 1) expect(calls[0]!.options.signal).not.toBe(calls[1]!.options.signal)
    })
  }

  test('keeps two paths in one batch when their NUL-delimited UTF-8 input fills the cap exactly', async () => {
    const paths = ['é'.repeat((cap - 4) / 2), 'ab']
    const input = `${paths.join('\0')}\0`
    const { runner, calls } = recording(({ options }) => result(String(options.input)))
    expect(Buffer.byteLength(input, 'utf8')).toBe(cap)
    expect(await ignoredPaths(runner, '/fixture', paths)).toEqual(new Set(paths))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv).toEqual(['git', 'check-ignore', '-z', '--stdin'])
    expect(calls[0]!.options.input).toBe(input)
  })

  test('omits an oversized path and does not spawn for empty input', async () => {
    const { runner, calls } = recording(({ options }) => result(String(options.input)))
    expect(await ignoredPaths(runner, '/fixture', [])).toEqual(new Set())
    expect(calls).toHaveLength(0)
    expect(await ignoredPaths(runner, '/fixture', ['x'.repeat(cap), 'ok'])).toEqual(new Set(['ok']))
    expect(calls.map(({ options }) => options.input)).toEqual(['ok\0'])
  })

  const failures: [string, Partial<RunResult> | Error][] = [
    ['exit 1', { exitCode: 1 }], ['exit 128', { exitCode: 128 }],
    ['spawn error', { spawnError: { code: 'ENOENT', message: 'missing git' } }],
    ['timeout', { stopped: 'timeout' }], ['aborted', { stopped: 'aborted' }], ['overflow', { stopped: 'overflow' }],
    ['stdout truncated', { truncated: { stdout: true, stderr: false } }],
    ['stderr truncated', { truncated: { stdout: false, stderr: true } }], ['rejection', new Error('read failed')]
  ]
  for (const [name, failure] of failures) {
    test(`discards ${name} output but continues later batches`, async () => {
      const first = 'x'.repeat(cap - 1)
      const { runner, calls } = recording((_call, index) => {
        if (index > 0) return result('later\0fragment')
        if (failure instanceof Error) throw failure
        return result('must-not-hide\0', failure)
      })
      expect(await ignoredPaths(runner, '/fixture', [first, 'later'])).toEqual(new Set(['later']))
      expect(calls).toHaveLength(2)
    })
  }

  test('accepts explicitly untruncated success but not its unterminated fragment', async () => {
    const { runner, calls } = recording(() => result('ok\0fragment', { truncated: { stdout: false, stderr: false } }))
    expect(await ignoredPaths(runner, '/fixture', ['ok'])).toEqual(new Set(['ok']))
    expect(calls).toHaveLength(1)
  })

  test('keeps the default whole-call deadline armed until the runner settles', async () => {
    const realSetTimeout = globalThis.setTimeout
    let fire: (() => void) | undefined
    const deadlines: number[] = []
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => {
      deadlines.push(ms)
      fire = callback
      return realSetTimeout(() => {}, 60_000)
    }) as typeof setTimeout)
    const { runner, calls } = recording(({ options }) => {
      const { promise, resolve } = Promise.withResolvers<RunResult>()
      options.signal!.addEventListener('abort', () => resolve(result('not-ignored\0')), { once: true })
      return promise
    })
    try {
      const pending = ignoredPaths(runner, '/fixture', ['not-ignored'])
      expect(calls).toHaveLength(1)
      expect(deadlines).toEqual([5000])
      expect(calls[0]!.options.signal!.aborted).toBe(false)
      fire!()
      expect(await pending).toEqual(new Set())
      expect(calls[0]!.options.signal!.aborted).toBe(true)
    } finally {
      timer.mockRestore()
    }
  })

  test('aborts an abort-only runner at a short whole-call deadline', async () => {
    const { runner, calls } = recording(({ options }) => {
      const { promise, resolve } = Promise.withResolvers<RunResult>()
      options.signal!.addEventListener('abort', () => resolve(result('not-ignored\0', { stopped: 'aborted' })), { once: true })
      return promise
    })
    expect(await ignoredPaths(runner, '/fixture', ['not-ignored'], 5)).toEqual(new Set())
    expect(calls).toHaveLength(1)
    expect(calls[0]!.options.timeoutMs).toBe(5)
    expect(calls[0]!.options.signal!.aborted).toBe(true)
  })

  test('ExplorerService marks and hides the runner-provided ignored paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quirky-explorer-process-'))
    roots.push(root)
    writeFileSync(join(root, 'hidden.txt'), '')
    writeFileSync(join(root, 'visible.txt'), '')
    const { runner, calls } = recording(() => result('hidden.txt\0'))
    const context = { process: runner, getSetting: () => undefined } as unknown as PluginContext
    const store = { get: () => null } as unknown as PluginStore
    const paths = {
      resolve: async () => ({ id: 'fixture', path: root }),
      path: async () => ({ path: root, relativePath: '.' })
    } as unknown as WorktreePaths
    const explorer = new ExplorerService(context, store, paths, {} as FileInventory, () => {})
    try {
      const shown = await explorer.call({ action: 'list', worktree: 'fixture', showIgnored: true })
      expect(shown.entries.map(({ name, ignored }) => ({ name, ignored }))).toEqual([{ name: 'hidden.txt', ignored: true }, { name: 'visible.txt', ignored: undefined }])
      const hidden = await explorer.call({ action: 'list', worktree: 'fixture', showIgnored: false })
      expect(hidden.entries.map(({ name }) => name)).toEqual(['visible.txt'])
      expect(calls).toHaveLength(2)
      for (const call of calls) {
        expect(call.options.cwd).toBe(root)
        expect(new Set(String(call.options.input).split('\0').filter(Boolean))).toEqual(new Set(['hidden.txt', 'visible.txt']))
      }
    } finally {
      explorer.dispose()
    }
  })

  test('migrated explorer stays outside the direct-spawn baseline', () => {
    const path = 'plugins/quirky.editor/src/daemon/explorer.ts'
    expect(scanSourceContent(path, readFileSync(path, 'utf8'))).toEqual([])
    expect(JSON.parse(readFileSync('scripts/spawn-lint-baseline.json', 'utf8'))[path]).toBeUndefined()
    const manifest = JSON.parse(readFileSync('plugins/quirky.editor/quirky-plugin.json', 'utf8'))
    const [major, minor] = manifest.apiVersion.split('.').map(Number)
    expect(major > 1 || (major === 1 && minor >= 6)).toBe(true)
  })
})
