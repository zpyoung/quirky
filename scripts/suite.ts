#!/usr/bin/env bun
/**
 * The project's test run: `bun test` with the given arguments, then each failing file once more on
 * its own. A file that passes alone failed only under load, so it's reported as flaky and the run
 * passes; one that fails again, a failure the report can't name, or more failing files than the
 * limit fails the run. Flaky files are also appended to `<git common dir>/build-loop/flakes.log`
 * when the build loop is set up, so repeat offenders can be fixed.
 *
 *   bun scripts/suite.ts packages apps plugins
 */
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

export type SuiteResult = { ok: boolean; flaky: string[] }

async function tee(stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream): Promise<string> {
  const decoder = new TextDecoder()
  let text = ''
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text
    out.write(value)
    text += decoder.decode(value, { stream: true })
  }
}

async function bunTest(cwd: string, args: string[]): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(['bun', 'test', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([tee(child.stdout, process.stdout), tee(child.stderr, process.stderr)])
  return { code: await child.exited, output: out + err }
}

/** Files with a failing test in a junit report, and how many tests failed in all. */
function failures(report: string): { files: string[]; count: number } {
  const xml = existsSync(report) ? readFileSync(report, 'utf8') : ''
  const files = new Set<string>()
  let count = 0
  for (const match of xml.matchAll(/<testcase\b[^>]*\bfile="([^"]+)"[^>]*>\s*<failure\b/g)) {
    files.add(match[1])
    count++
  }
  return { files: [...files], count }
}

function recordFlakes(cwd: string, files: string[]): void {
  const common = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
  const dir = join(common.stdout.toString().trim(), 'build-loop')
  if (common.exitCode !== 0 || !existsSync(dir)) return
  const stamp = new Date().toISOString()
  appendFileSync(join(dir, 'flakes.log'), files.map((file) => `${stamp} ${file}\n`).join(''))
}

export async function runSuite(cwd: string, args: string[], limit = 5): Promise<SuiteResult> {
  const scratch = mkdtempSync(join(tmpdir(), 'suite-'))
  const report = join(scratch, 'junit.xml')
  try {
    const first = await bunTest(cwd, [...args, '--reporter=junit', `--reporter-outfile=${report}`])
    if (first.code === 0) return { ok: true, flaky: [] }
    const { files, count } = failures(report)
    // a file that fails to load is missing from the report but still counted as a fail, with an error line
    const failed = Number(/^\s*(\d+) fail$/m.exec(first.output)?.[1] ?? NaN)
    const unnamed = failed !== count || /^\s*\d+ errors?$/m.test(first.output)
    if (files.length === 0 || unnamed || files.length > limit) return { ok: false, flaky: [] }
    const flags = args.filter((arg) => arg.startsWith('-'))
    console.error(`\nrerunning ${files.length} failing file(s) alone: ${files.join(', ')}`)
    for (const file of files) {
      const alone = await bunTest(cwd, [...flags, isAbsolute(file) ? file : `./${file}`])
      if (alone.code !== 0) return { ok: false, flaky: [] }
    }
    console.error(`\npassed alone, so failed only under load: ${files.join(', ')}`)
    recordFlakes(cwd, files)
    return { ok: true, flaky: files }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

if (import.meta.main) {
  const { ok } = await runSuite(process.cwd(), Bun.argv.slice(2))
  process.exit(ok ? 0 : 1)
}
