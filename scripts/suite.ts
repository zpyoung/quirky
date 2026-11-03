#!/usr/bin/env bun
/**
 * The project's test run, on this machine. Each test file runs in its own `bun test` process, two at a
 * time, so files that misbehave when they share a process (daemon tests next to happy-dom tests) can't
 * affect each other. A failing file gets one more run on its own: one that passes alone failed only
 * under load, so it's reported as flaky and the run passes; one that fails again, or more failing
 * files than the limit, fails the run. Flaky files are appended to
 * `<git common dir>/build-loop/flakes.log` when the build loop is set up.
 * Before any test runs, the CLI installs frozen dependencies when the current directory has a
 * `package.json`; standalone test directories without a manifest need no install.
 *
 *   bun scripts/suite.ts <dir> <dir> ...
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { Store } from '../packages/daemon/src/store'
import { createProcessScope, type ProcessScope } from './test-support/process-scope'

export type SuiteResult = { ok: boolean; flaky: string[] }
type Run = (cwd: string, args: string[]) => Promise<{ code: number; output: string }>

export const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/
const FILE_PROFILE_PREFIX = 'suite-file '
const LOCAL_JOBS = 2

async function tee(stream: ReadableStream<Uint8Array>, out: NodeJS.WriteStream | null): Promise<string> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text
    out?.write(value)
    text += decoder.decode(value, { stream: true })
  }
}

async function exec(
  cmd: string[],
  cwd: string,
  echo = true,
  scope: ProcessScope = createProcessScope(),
  env: NodeJS.ProcessEnv = process.env,
  profileFile?: string
): Promise<{ code: number; output: string }> {
  const profile = process.env.QUIRKY_TEST_PROFILE === '1' && profileFile
    ? { file: profileFile, began: performance.now() }
    : undefined
  try {
    const options = {
      cwd,
      env: { ...env, ...scope.env },
      stdin: 'ignore' as const,
      stdout: 'pipe' as const,
      stderr: 'pipe' as const
    }
    const child = scope.spawn(cmd, options)
    const streams = Promise.all([tee(child.stdout, echo ? process.stdout : null), tee(child.stderr, echo ? process.stderr : null)])
    const code = await child.exited
    // Bun reports wait4-style usage for the child and waited-for descendants, not guardian CPU or an all-host metric.
    // Its CPU counters are microseconds; convert to milliseconds like the wall clock below.
    const usage = profile ? child.resourceUsage() : undefined
    // A leaked child may still hold a pipe open. Reap the tree before waiting for EOF.
    await scope.cleanup()
    const [out, err] = await streams
    if (profile) {
      const file = isAbsolute(profile.file) ? relative(cwd, profile.file) : profile.file.replace(/^\.\//, '')
      process.stdout.write(`${FILE_PROFILE_PREFIX}${JSON.stringify({
        file,
        wallMs: performance.now() - profile.began,
        userCpuMs: Number(usage?.cpuTime.user ?? 0) / 1000,
        systemCpuMs: Number(usage?.cpuTime.system ?? 0) / 1000,
        exitCode: code
      })}\n`)
    }
    return { code, output: out + err }
  } finally {
    await scope.cleanup()
  }
}

async function withTestHome<T>(run: (env: NodeJS.ProcessEnv, scope: ProcessScope) => Promise<T>): Promise<T> {
  const scratch = mkdtempSync(join(tmpdir(), 'suite-home-'))
  try {
    const home = join(scratch, 'home')
    const quirkyHome = join(scratch, 'quirky')
    mkdirSync(home)
    mkdirSync(quirkyHome)
    const store = new Store(join(quirkyHome, 'quirky.db'))
    try {
      store.setSettingValue('setting:quirky.agent-status/hooks', false)
    } finally {
      store.close()
    }
    const scope = createProcessScope(quirkyHome)
    try {
      return await run({ ...process.env, HOME: home, QUIRKY_HOME: quirkyHome }, scope)
    } finally {
      await scope.cleanup()
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const bunTest = (cwd: string, args: string[], echo = true, profileFile?: string) =>
  withTestHome((env, scope) => exec(['bun', 'test', ...args], cwd, echo, scope, env, profileFile))
/**
 * One `bun test` run quietly inside its own test home. Past `limitMs` the whole process tree is reaped
 * through the scope's cleanup and `timedOut` is true, so nothing the run started outlives the call.
 */
export function bunTestFile(cwd: string, args: string[], limitMs: number): Promise<{ code: number; output: string; timedOut: boolean }> {
  return timedRun(cwd, ['bun', 'test', ...args], limitMs)
}

function timedRun(cwd: string, cmd: string[], limitMs: number): Promise<{ code: number; output: string; timedOut: boolean }> {
  return withTestHome(async (env, scope) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void scope.cleanup()
    }, limitMs)
    try {
      const { code, output } = await exec(cmd, cwd, false, scope, env)
      return { code, output, timedOut }
    } finally {
      clearTimeout(timer)
    }
  })
}
const asPath = (file: string) => (isAbsolute(file) ? file : `./${file}`)


function gitCommonDir(cwd: string): string | undefined {
  const result = Bun.spawnSync(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd })
  return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
}

function recordFlakes(cwd: string, files: string[]): void {
  const common = gitCommonDir(cwd)
  const dir = common && join(common, 'build-loop')
  if (!dir || !existsSync(dir)) return
  const stamp = new Date().toISOString()
  appendFileSync(join(dir, 'flakes.log'), files.map((file) => `${stamp} ${file}\n`).join(''))
}

/** Reruns `failed` alone, one at a time; the run passes only if every one of them now passes. */
async function rerunAlone(cwd: string, failed: string[], flags: string[], limit: number, profileFiles = false): Promise<SuiteResult> {
  if (failed.length > limit) return { ok: false, flaky: [] }
  console.error(`\nrerunning ${failed.length} failing file(s) alone: ${failed.join(', ')}`)
  for (const file of failed) if ((await bunTest(cwd, [...flags, asPath(file)], true, profileFiles ? file : undefined)).code !== 0) return { ok: false, flaky: [] }
  console.error(`\npassed alone, so failed only under load: ${failed.join(', ')}`)
  recordFlakes(cwd, failed)
  return { ok: true, flaky: failed }
}

/** Each file in its own `bun test` process, `jobs` at a time, printing only the failing ones. */
export async function runFiles(
  cwd: string,
  files: string[],
  flags: string[],
  jobs: number,
  limit = 5,
  run: Run = (dir, args) => bunTest(dir, args, false, args.at(-1))
): Promise<SuiteResult> {
  const failed: string[] = []
  const queue = [...files]
  let passed = 0
  const worker = async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      const { code, output } = await run(cwd, [...flags, asPath(file)])
      if (code === 0) passed++
      else {
        failed.push(file)
        process.stdout.write(`\n${file}: failed\n${output}\n`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker))
  console.log(`\n${files.length} test files: ${passed} passed, ${failed.length} failed`)
  return failed.length === 0 ? { ok: true, flaky: [] } : rerunAlone(cwd, failed.sort(), flags, limit, true)
}

/** The test files `bun test <args>` would run: tracked or untracked and not ignored, under any path argument. */
export function discover(cwd: string, args: string[]): string[] {
  const paths = args.filter((arg) => !arg.startsWith('-')).map((arg) => arg.replace(/^\.\//, ''))
  const listed = Bun.spawnSync(['git', 'ls-files', '-co', '--exclude-standard', '-z'], { cwd }).stdout.toString().split('\0')
  return [...new Set(listed)]
    .filter((file) => TEST_FILE.test(file) && !file.split('/').includes('node_modules'))
    .filter((file) => paths.length === 0 || paths.some((path) => file.includes(path)))
    .sort()
}

/** The files named in a list of macOS-only tests: the first word of each line that isn't a comment. */
export function macosOnly(list: string): Set<string> {
  if (!existsSync(list)) return new Set()
  const lines = readFileSync(list, 'utf8').split('\n').map((line) => line.trim())
  return new Set(lines.filter((line) => line && !line.startsWith('#')).map((line) => line.split(/\s+/)[0]))
}

async function installLocalDependencies(cwd: string): Promise<boolean> {
  if (!existsSync(join(cwd, 'package.json'))) return true
  return (await exec(['bun', 'install', '--frozen-lockfile'], cwd)).code === 0
}


async function main(argv: string[]): Promise<boolean> {
  const cwd = process.cwd()
  if (!(await installLocalDependencies(cwd))) return false
  const flags = argv.filter((arg) => arg.startsWith('-'))
  const jobs = process.env.QUIRKY_TEST_PROFILE === '1' ? 1 : LOCAL_JOBS
  return (await runFiles(cwd, discover(cwd, argv), flags, jobs)).ok
}

if (import.meta.main) process.exitCode = (await main(Bun.argv.slice(2))) ? 0 : 1
