import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { bunTestFile } from '../suite'
import { parseJunit } from './junit'
import type { Attempt, FileError, FileResult, Platform } from './types'

export const FILES_AT_ONCE_CI = 3
export const FILE_LIMIT_MS = 600_000
export const TEST_LIMIT_MS = 30_000
export const RERUN_LIMIT = 5
export const ALONE_OUTPUT_TAIL_BYTES = 16_384

/** What a run needs: the files to run from `cwd`, how many at once, and how long each may take. */
export type RunOptions = {
  cwd: string
  files: string[]
  platform: Platform
  jobs: number
  limitMs: number
  fileLimits?: ReadonlyMap<string, number>
  run?: typeof bunTestFile
  log?: (text: string) => void
  alone?: ReadonlySet<string>
}

type Outcome = { attempt: Attempt; durationMs: number }

function fileErrorOf(timedOut: boolean, code: number, hasReport: boolean, failed: boolean): FileError {
  if (timedOut) return 'timeout'
  if (code === 0 || failed) return null
  return hasReport ? 'exit-mismatch' : 'no-report'
}

function outputTailOnLineBoundary(output: string): string {
  let start = output.length
  let tailBytes = 0
  while (start > 0) {
    const contentEnd = output.charCodeAt(start - 1) === 10 ? start - 1 : start
    const lineStart = (contentEnd === 0 ? -1 : output.lastIndexOf('\n', contentEnd - 1)) + 1
    const lineBytes = Buffer.byteLength(output.slice(lineStart, start), 'utf8')
    if (tailBytes + lineBytes > ALONE_OUTPUT_TAIL_BYTES) break
    tailBytes += lineBytes
    start = lineStart
  }
  return output.slice(start)
}

async function attemptFile(opts: RunOptions, file: string): Promise<Outcome> {
  const scratch = mkdtempSync(join(tmpdir(), 'test-baseline-'))
  const report = join(scratch, 'junit.xml')
  try {
    const began = performance.now()
    const run = opts.run ?? bunTestFile
    const limitMs = opts.fileLimits?.get(file) ?? opts.limitMs
    const { code, output, timedOut } = await run(
      opts.cwd,
      [isAbsolute(file) ? file : `./${file}`, '--reporter=junit', `--reporter-outfile=${report}`, `--timeout=${TEST_LIMIT_MS}`],
      limitMs
    )
    const durationMs = performance.now() - began
    if (code !== 0 || timedOut) opts.log?.(`::group::${file} failed\n${output}\n::endgroup::\n`)
    const xml = existsSync(report) ? readFileSync(report, 'utf8') : ''
    const tests = parseJunit(xml, file)
    const failed = tests.some((test) => test.status === 'failed')
    if (opts.alone?.has(file) && code === 0 && !timedOut && !failed) {
      opts.log?.(`::group::${file} passed alone\n${outputTailOnLineBoundary(output)}\n::endgroup::\n`)
    }
    return { attempt: { exitCode: code, fileError: fileErrorOf(timedOut, code, xml.trim() !== '', failed), tests }, durationMs }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Runs each listed file alone first, then the rest up to `opts.jobs` at a time, returning one result
 * per file in input order. Test failures, load failures and timeouts are recorded, never thrown.
 */
export async function runTestFiles(opts: RunOptions): Promise<FileResult[]> {
  const results: FileResult[] = new Array(opts.files.length)
  let next = 0
  const worker = async (listed: boolean) => {
    for (let index = next++; index < opts.files.length; index = next++) {
      const file = opts.files[index]
      if (listed ? !opts.alone?.has(file) : opts.alone?.has(file)) continue
      const { attempt, durationMs } = await attemptFile(opts, file)
      results[index] = { file, platform: opts.platform, durationMs, first: attempt }
    }
  }
  if (opts.alone?.size) {
    await worker(true)
    next = 0
  }
  await Promise.all(Array.from({ length: Math.max(1, opts.jobs) }, () => worker(false)))
  return results
}

const needsRerun = (result: FileResult) =>
  result.rerun === undefined && (result.first.fileError !== null || result.first.tests.some((test) => test.status === 'failed'))

/**
 * Runs each file with a failed test or a `fileError` a second time, alone and one at a time, filling in
 * its `rerun`. A platform group with more such files than `limit` is left as it was and `skipped` is
 * true, so a broken run isn't retried wholesale. Results keep their order and their first attempt.
 */
export async function rerunFailed(opts: RunOptions, results: FileResult[], limit: number): Promise<{ results: FileResult[]; skipped: boolean }> {
  const failed = results.filter(needsRerun)
  const over = new Set<Platform>()
  for (const platform of new Set(failed.map((result) => result.platform))) {
    if (failed.filter((result) => result.platform === platform).length > limit) over.add(platform)
  }
  const out: FileResult[] = []
  for (const result of results) {
    if (!needsRerun(result) || over.has(result.platform)) {
      out.push(result)
      continue
    }
    const { attempt } = await attemptFile({ ...opts, platform: result.platform }, result.file)
    out.push({ ...result, rerun: attempt })
  }
  return { results: out, skipped: over.size > 0 }
}
