import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { bunTestFile } from '../suite'
import { FILE_LIMIT_MS, FILES_AT_ONCE_CI, FILES_AT_ONCE_LOCAL, RERUN_LIMIT, rerunFailed, runTestFiles } from './runner'
import type { FileResult, Platform } from './types'

type Run = typeof bunTestFile

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const write = (name: string, body: string) => writeFileSync(join(dir, name), `import { expect, test } from 'bun:test'\nimport { existsSync, writeFileSync } from 'node:fs'\n${body}\n`)
const options = (files: string[], overrides: Partial<{ platform: Platform; jobs: number; limitMs: number; run: Run }> = {}) => ({
  cwd: dir,
  files,
  platform: 'linux' as const,
  jobs: 2,
  limitMs: 60_000,
  ...overrides
})
const sep = (file: string, classname: string, name: string) => [file, classname, name].join('\0')
const reportOf = (args: string[]) => args.find((arg) => arg.startsWith('--reporter-outfile='))!.slice('--reporter-outfile='.length)

/** A fake `bun test` that writes one report entry and exits as scripted per file. */
function fake(script: Record<string, { code: number; tests?: Record<string, 'pass' | 'fail'>; report?: boolean; timedOut?: boolean }>, seen: { reports: string[]; calls: string[] } = { reports: [], calls: [] }): Run {
  return async (_cwd, args) => {
    const file = args.find((arg) => !arg.startsWith('-'))!.replace(/^\.\//, '')
    const { code, tests = {}, report = true, timedOut = false } = script[file]
    seen.calls.push(file)
    seen.reports.push(reportOf(args))
    if (report) {
      const cases = Object.entries(tests).map(([name, status]) => (status === 'fail' ? `<testcase name="${name}" classname=""><failure message="x" /></testcase>` : `<testcase name="${name}" classname="" />`))
      writeFileSync(reportOf(args), `<testsuites><testsuite name="${file}">${cases.join('')}</testsuite></testsuites>`)
    }
    return { code, output: '', timedOut }
  }
}

test('the settings have the values the spec fixes', () => {
  expect([FILES_AT_ONCE_CI, FILES_AT_ONCE_LOCAL, FILE_LIMIT_MS, RERUN_LIMIT]).toEqual([3, 2, 600_000, 5])
})

test('runs real files: passing, failing, failing to load', async () => {
  write('pass.test.ts', `test('ok', () => expect(1).toBe(1))`)
  write('fail.test.ts', `test('good', () => {})\ntest('broken', () => expect(1).toBe(2))`)
  write('load.test.ts', `import './does-not-exist'\ntest('never', () => {})`)
  const files = ['pass.test.ts', 'fail.test.ts', 'load.test.ts']
  const results = await runTestFiles(options(files))
  expect(results.map((result) => result.file)).toEqual(files)
  const [pass, fail, load] = results
  expect(pass.first).toEqual({ exitCode: 0, fileError: null, tests: [{ key: sep('pass.test.ts', '', 'ok'), status: 'passed' }] })
  expect(fail.first.exitCode).not.toBe(0)
  expect(fail.first.fileError).toBeNull()
  expect(fail.first.tests).toEqual([
    { key: sep('fail.test.ts', '', 'good'), status: 'passed' },
    { key: sep('fail.test.ts', '', 'broken'), status: 'failed' }
  ])
  expect(load.first.exitCode).not.toBe(0)
  expect(load.first.fileError).toBe('no-report')
  expect(load.first.tests).toEqual([])
  for (const result of results) {
    expect(result.platform).toBe('linux')
    expect(result.durationMs).toBeGreaterThan(0)
    expect(result.rerun).toBeUndefined()
  }
}, 120_000)

test('a file that flakes through a marker fails first and passes on its rerun', async () => {
  const marker = join(dir, 'ran.marker')
  write('flaky.test.ts', `test('flaky', () => {\n  const seen = existsSync(${JSON.stringify(marker)})\n  writeFileSync(${JSON.stringify(marker)}, '')\n  expect(seen).toBe(true)\n})`)
  const run = await runTestFiles(options(['flaky.test.ts']))
  expect(run[0].first.tests[0].status).toBe('failed')
  const { results, skipped } = await rerunFailed(options(['flaky.test.ts']), run, 5)
  expect(skipped).toBe(false)
  expect(results[0].first).toEqual(run[0].first)
  expect(results[0].rerun).toEqual({ exitCode: 0, fileError: null, tests: [{ key: sep('flaky.test.ts', '', 'flaky'), status: 'passed' }] })
  expect(results[0].durationMs).toBe(run[0].durationMs)
}, 120_000)

test('a hung file times out and nothing it started is left running', async () => {
  const pidFile = join(dir, 'child.pid')
  write('hang.test.ts', `test('hang', async () => {\n  const child = Bun.spawn(['sleep', '300'])\n  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))\n  await new Promise(() => {})\n}, 120000)`)
  const began = performance.now()
  const [result] = await runTestFiles(options(['hang.test.ts'], { limitMs: 3000 }))
  expect(performance.now() - began).toBeLessThan(30_000)
  expect(result.first.fileError).toBe('timeout')
  expect(result.first.exitCode).not.toBe(0)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  expect(() => process.kill(pid, 0)).toThrow()
}, 120_000)

test('fileError follows the attempt', async () => {
  const run = fake({
    'ok.test.ts': { code: 0, tests: { a: 'pass' } },
    'failed.test.ts': { code: 1, tests: { a: 'fail' } },
    'timeout.test.ts': { code: 143, report: false, timedOut: true },
    'noreport.test.ts': { code: 1, report: false },
    'mismatch.test.ts': { code: 1, tests: { a: 'pass' } },
    'mismatch-empty.test.ts': { code: 1, tests: {} }
  })
  const files = Object.keys({ 'ok.test.ts': 0, 'failed.test.ts': 0, 'timeout.test.ts': 0, 'noreport.test.ts': 0, 'mismatch.test.ts': 0, 'mismatch-empty.test.ts': 0 })
  const results = await runTestFiles(options(files, { run }))
  expect(results.map((result) => result.first.fileError)).toEqual([null, null, 'timeout', 'no-report', 'exit-mismatch', 'exit-mismatch'])
  expect(results.map((result) => result.first.exitCode)).toEqual([0, 1, 143, 1, 1, 1])
})

test('keeps input order, bounds concurrency by jobs, and passes the limit through', async () => {
  const files = Array.from({ length: 7 }, (_, index) => `f${index}.test.ts`)
  let active = 0
  let peak = 0
  const limits: number[] = []
  const run: Run = async (_cwd, args, limitMs) => {
    limits.push(limitMs)
    active++
    peak = Math.max(peak, active)
    await Bun.sleep(30 - Number(/f(\d)/.exec(args[0])![1]) * 3)
    active--
    return { code: 0, output: '', timedOut: false }
  }
  const results = await runTestFiles(options(files, { jobs: 3, limitMs: 1234, run }))
  expect(results.map((result) => result.file)).toEqual(files)
  expect(peak).toBe(3)
  expect(new Set(limits)).toEqual(new Set([1234]))
})

test('hands the output of a failed attempt to log, and stays quiet about a clean one', async () => {
  const logged: string[] = []
  const run: Run = async (_cwd, args) => {
    const failed = args[0].includes('bad')
    return { code: failed ? 1 : 0, output: failed ? 'error: expected M' : 'all good', timedOut: false }
  }
  await runTestFiles({ ...options(['good.test.ts', 'bad.test.ts'], { run }), log: (text) => logged.push(text) })
  expect(logged).toEqual(['::group::bad.test.ts failed\nerror: expected M\n::endgroup::\n'])
})

test('every attempt writes its report to its own temp path and removes it', async () => {
  const seen = { reports: [] as string[], calls: [] as string[] }
  const run = fake({ 'a.test.ts': { code: 1, tests: { x: 'fail' } }, 'b.test.ts': { code: 0, tests: { x: 'pass' } } }, seen)
  const first = await runTestFiles(options(['a.test.ts', 'b.test.ts'], { run }))
  await rerunFailed(options(['a.test.ts', 'b.test.ts'], { run }), first, 5)
  expect(seen.reports).toHaveLength(3)
  expect(new Set(seen.reports).size).toBe(3)
  for (const report of seen.reports) expect(existsSync(report)).toBe(false)
})

test('runs relative files with a leading ./ and leaves absolute ones alone', async () => {
  const args: string[][] = []
  const run: Run = async (_cwd, given) => {
    args.push(given)
    return { code: 0, output: '', timedOut: false }
  }
  await runTestFiles(options(['rel/a.test.ts', '/abs/b.test.ts'], { run }))
  expect(args.map((given) => given[0])).toEqual(['./rel/a.test.ts', '/abs/b.test.ts'])
  expect(args[0]).toContain('--reporter=junit')
})

test('a rejected run is not swallowed as a test failure', async () => {
  const run: Run = async () => {
    throw new Error('scope broke')
  }
  await expect(runTestFiles(options(['a.test.ts'], { run }))).rejects.toThrow('scope broke')
})

const attempt = (code: number, status?: 'passed' | 'failed', fileError: FileResult['first']['fileError'] = null) => ({
  exitCode: code,
  fileError,
  tests: status ? [{ key: 'k', status }] : []
})
const result = (file: string, platform: Platform, first: FileResult['first']): FileResult => ({ file, platform, durationMs: 7, first })

test('reruns only files with a failed test or a fileError, one at a time, keeping the first attempt', async () => {
  const seen = { reports: [] as string[], calls: [] as string[] }
  const run = fake(
    {
      'bad.test.ts': { code: 0, tests: { a: 'pass' } },
      'err.test.ts': { code: 0, tests: { a: 'pass' } },
      'still.test.ts': { code: 1, tests: { a: 'fail' } }
    },
    seen
  )
  const before = [
    result('good.test.ts', 'linux', attempt(0, 'passed')),
    result('bad.test.ts', 'linux', attempt(1, 'failed')),
    result('err.test.ts', 'linux', attempt(1, undefined, 'no-report')),
    result('still.test.ts', 'linux', attempt(1, 'failed'))
  ]
  const { results, skipped } = await rerunFailed(options([], { run }), before, 5)
  expect(skipped).toBe(false)
  expect(seen.calls).toEqual(['bad.test.ts', 'err.test.ts', 'still.test.ts'])
  expect(results.map((entry) => entry.file)).toEqual(before.map((entry) => entry.file))
  expect(results[0]).toEqual(before[0])
  for (const [index, entry] of results.entries()) expect(entry.first).toEqual(before[index].first)
  expect(results[1].rerun).toEqual({ exitCode: 0, fileError: null, tests: [{ key: sep('bad.test.ts', '', 'a'), status: 'passed' }] })
  expect(results[3].rerun?.tests[0].status).toBe('failed')
  expect(results[1].durationMs).toBe(7)
  expect(before[1].rerun).toBeUndefined()
})

test('a rerun that times out records the timeout on the rerun only', async () => {
  const run = fake({ 'h.test.ts': { code: 143, report: false, timedOut: true } })
  const { results } = await rerunFailed(options([], { run }), [result('h.test.ts', 'linux', attempt(1, 'failed'))], 5)
  expect(results[0].first.fileError).toBeNull()
  expect(results[0].rerun?.fileError).toBe('timeout')
})

test('more failing files than the limit reruns nothing and says so', async () => {
  const seen = { reports: [] as string[], calls: [] as string[] }
  const run = fake({}, seen)
  const before = Array.from({ length: 3 }, (_, index) => result(`f${index}.test.ts`, 'linux', attempt(1, 'failed')))
  const out = await rerunFailed(options([], { run }), before, 2)
  expect(out.skipped).toBe(true)
  expect(out.results).toEqual(before)
  expect(seen.calls).toEqual([])
})

test('exactly the limit still reruns', async () => {
  const run = fake({ 'a.test.ts': { code: 0, tests: { x: 'pass' } }, 'b.test.ts': { code: 0, tests: { x: 'pass' } } })
  const before = ['a.test.ts', 'b.test.ts'].map((file) => result(file, 'linux', attempt(1, 'failed')))
  const out = await rerunFailed(options([], { run }), before, 2)
  expect(out.skipped).toBe(false)
  expect(out.results.every((entry) => entry.rerun !== undefined)).toBe(true)
})

test('the limit counts each platform group on its own', async () => {
  const seen = { reports: [] as string[], calls: [] as string[] }
  const run = fake({ 'm.test.ts': { code: 0, tests: { x: 'pass' } }, 'n.test.ts': { code: 0, tests: { x: 'pass' } } }, seen)
  const linux = ['l1.test.ts', 'l2.test.ts', 'l3.test.ts'].map((file) => result(file, 'linux', attempt(1, 'failed')))
  const macos = ['m.test.ts', 'n.test.ts'].map((file) => result(file, 'macos', attempt(1, 'failed')))
  const out = await rerunFailed(options([], { run }), [...linux, ...macos], 2)
  expect(out.skipped).toBe(true)
  expect(seen.calls).toEqual(['m.test.ts', 'n.test.ts'])
  expect(out.results.slice(0, 3)).toEqual(linux)
  expect(out.results.slice(3).every((entry) => entry.rerun?.fileError === null)).toBe(true)
})
