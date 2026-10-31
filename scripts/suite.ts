#!/usr/bin/env bun
/**
 * The project's test run. A failing test file gets one more run on its own: one that passes alone
 * failed only under load, so it's reported as flaky and the run passes; one that fails again, a
 * failure that can't be pinned to a file, or more failing files than the limit fails the run.
 * Flaky files are appended to `<git common dir>/build-loop/flakes.log` when the build loop is set up.
 *
 * When `<git common dir>/build-loop/remote-tests.json` names a host (`{"host": "user@box", "jobs": 4}`),
 * optionally with an `overflow` host of the same shape, the run moves off this machine. It picks one
 * host at the start: the first, or the overflow host when the first is down or full. A run from a land
 * stays on a full first host. If no host can be reached the run stops before any test starts.
 * On the chosen host the working tree is copied to a fresh folder there and each test
 * file runs in its own process, `jobs` at a time, each holding one of `slots` machine-wide locks there
 * so several runs at once share the host's cores (`slots` defaults to 8). Files start slowest first,
 * by the times logged in `~/test-slots/durations.log` there. A run from the integration or verify
 * worktree is a land, which holds the land lock while it runs, so it can use every slot while other
 *   runs share one. Files listed in scripts/test-on-macos.txt still run here, alongside. A host lost
 *   during the run stops it.
 * Before local tests, the CLI installs frozen dependencies when the current directory has a
 * `package.json`; standalone test directories without a manifest need no install. The remote worker
 * already installs them in its fresh checkout.
 * `QUIRKY_TEST_LOCAL=1` skips the host.
 *
 *   bun scripts/suite.ts packages apps plugins
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { Store } from '../packages/daemon/src/store'
import { createProcessScope, type ProcessScope } from './test-support/process-scope'

export type SuiteResult = { ok: boolean; flaky: string[] }
export type Host = { host: string; jobs?: number; slots?: number }
type Remote = Host & { overflow?: Host }
export type HostState = 'free' | 'full' | 'down'
export type HostChoice = { host: Host; note?: string } | { error: string }
type Run = (cwd: string, args: string[]) => Promise<{ code: number; output: string }>

export const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/
const RESULT_PREFIX = 'suite-result '
const FILE_PROFILE_PREFIX = 'suite-file '
const SLOT_BUSY = 75
const MACOS_LIST = 'scripts/test-on-macos.txt'

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
  stdin?: string,
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
      stdin: stdin === undefined ? 'ignore' as const : new Blob([stdin]),
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
    if (profile && !(cmd[0] === 'flock' && code === SLOT_BUSY)) {
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
  withTestHome((env, scope) => exec(['bun', 'test', ...args], cwd, echo, undefined, scope, env, profileFile))
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
      const { code, output } = await exec(cmd, cwd, false, undefined, scope, env)
      return { code, output, timedOut }
    } finally {
      clearTimeout(timer)
    }
  })
}
const asPath = (file: string) => (isAbsolute(file) ? file : `./${file}`)

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

/** One `bun test` process over `args`, with the junit report naming the files to rerun. */
export async function runSuite(cwd: string, args: string[], limit = 5): Promise<SuiteResult> {
  const scratch = mkdtempSync(join(tmpdir(), 'suite-'))
  const report = join(scratch, 'junit.xml')
  try {
    const first = await bunTest(cwd, [...args, '--reporter=junit', `--reporter-outfile=${report}`])
    if (first.code === 0) return { ok: true, flaky: [] }
    const { files, count } = failures(report)
    // a file that fails to load is missing from the report but still counted as a fail, with an error line
    const failed = Number(/^\s*(\d+) fail$/m.exec(first.output)?.[1] ?? NaN)
    if (files.length === 0 || failed !== count || /^\s*\d+ errors?$/m.test(first.output)) return { ok: false, flaky: [] }
    return await rerunAlone(cwd, files, args.filter((arg) => arg.startsWith('-')), limit)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
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

/** How many of the host's slots a run may take: all of them, or one while a land runs and this isn't it. */
export function usableSlots(slots: number, priority: boolean, landRunning: boolean): number {
  return priority || !landRunning ? slots : 1
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Whether a land's run is going on this machine; markers left by dead runs are removed. */
function landRunning(dir: string): boolean {
  let running = false
  for (const name of readdirSync(dir)) {
    const pid = /^land-(\d+)$/.exec(name)?.[1]
    if (!pid) continue
    if (alive(Number(pid))) running = true
    else rmSync(join(dir, name), { force: true })
  }
  return running
}

/** `files` with the slowest first, by the last time logged for each; a file never logged counts as slowest. */
export function slowestFirst(files: string[], log: string): string[] {
  const last = new Map<string, number>()
  if (existsSync(log)) {
    for (const line of readFileSync(log, 'utf8').split('\n')) {
      const [file, ms] = line.split(' ')
      if (file && ms) last.set(file, Number(ms))
    }
    if (statSync(log).size > 1_000_000) writeFileSync(log, [...last].map(([file, ms]) => `${file} ${ms}\n`).join(''))
  }
  const time = (file: string) => last.get(file) ?? Number.MAX_SAFE_INTEGER
  return [...files].sort((a, b) => time(b) - time(a))
}

const slotDir = () => join(homedir(), 'test-slots')
const underLock = (lock: string, args: string[]) => ['flock', '-n', '-E', String(SLOT_BUSY), lock, 'bun', 'test', ...args]

/** Runs `attempt` holding one of the `slots` locks shared by every run on this machine, waiting until one is free. */
async function holdingSlot<T extends { code: number }>(slots: number, priority: boolean, attempt: (lock: string) => Promise<T>): Promise<T> {
  const dir = slotDir()
  // a process scope starts a guardian process, so probe a slot with a bare flock before paying for one
  const free = (lock: string) => Bun.spawnSync(['flock', '-n', '-E', String(SLOT_BUSY), lock, 'true']).exitCode === 0
  for (;;) {
    const usable = usableSlots(slots, priority, !priority && landRunning(dir))
    const start = Math.floor(Math.random() * usable)
    for (let i = 0; i < usable; i++) {
      const lock = join(dir, `${(start + i) % usable}.lock`)
      if (!free(lock)) continue
      const result = await attempt(lock)
      if (result.code !== SLOT_BUSY) return result
    }
    await Bun.sleep(1000)
  }
}

/** `bun test` that first takes one of `slots` locks shared by every run on this machine, logging each file's time to `log`. */
function slotted(slots: number, priority: boolean, log: string): Run {
  const dir = slotDir()
  mkdirSync(dir, { recursive: true })
  if (priority) {
    const marker = join(dir, `land-${process.pid}`)
    writeFileSync(marker, '')
    process.on('exit', () => rmSync(marker, { force: true }))
  }
  return async (cwd, args) => {
    let began = 0
    const result = await holdingSlot(slots, priority, (lock) => {
      began = Date.now()
      return withTestHome((env, scope) => exec(underLock(lock, args), cwd, false, undefined, scope, env, args.at(-1)))
    })
    appendFileSync(log, `${args.at(-1)?.replace(/^\.\//, '')} ${Date.now() - began}\n`)
    return result
  }
}

/** `bunTestFile` for a host's worker: it shares the host's cores with other runs through the same `slots` locks. */
export function slottedTestFile(slots: number): typeof bunTestFile {
  mkdirSync(slotDir(), { recursive: true })
  return (cwd, args, limitMs) => holdingSlot(slots, false, (lock) => timedRun(cwd, underLock(lock, args), limitMs))
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

/** Whether the workers in a host's `ps` listing already take all of its `slots`. */
export function hostLoad(processes: string, slots: number): HostState {
  let jobs = 0
  for (const match of processes.matchAll(/^bun scripts\/suite\.ts --worker --jobs (\d+)/gm)) jobs += Number(match[1])
  return jobs >= slots ? 'full' : 'free'
}

/** The host a run should use, or why none can be used. Each host is checked at most once, first host first. */
export async function chooseHost(remote: Remote, land: boolean, state: (host: Host) => Promise<HostState>): Promise<HostChoice> {
  const first = await state(remote)
  if (first === 'free' || (first === 'full' && land)) return { host: remote }
  const overflow = remote.overflow
  const second = overflow ? await state(overflow) : 'down'
  if (overflow && second !== 'down') return { host: overflow, note: `${remote.host} is ${first}, so this run uses ${overflow.host}` }
  if (first === 'full') {
    const reason = overflow ? ` and overflow is unavailable because ${overflow.host} is down` : ''
    return { host: remote, note: `${remote.host} is full${reason}, so this run queues` }
  }
  const hosts = overflow ? `${remote.host} and ${overflow.host} are` : `${remote.host} is`
  return { error: `${hosts} unreachable, so no tests ran. Set QUIRKY_TEST_LOCAL=1 to run everything on this machine.` }
}

const sshTo = (host: string) => ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', host]

async function hostState({ host, slots }: Host): Promise<HostState> {
  const { code, output } = await exec([...sshTo(host), 'ps -eo args'], process.cwd(), false)
  return code === 0 ? hostLoad(output, slots ?? 8) : 'down'
}

function remoteConfig(cwd: string): Remote | undefined {
  if (process.env.QUIRKY_TEST_LOCAL) return undefined
  const common = gitCommonDir(cwd)
  const file = common && join(common, 'build-loop', 'remote-tests.json')
  return file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Remote) : undefined
}

/** The host this checkout's non-land runs should use right now; undefined when none is configured. */
export async function hostFor(cwd: string): Promise<HostChoice | undefined> {
  const remote = remoteConfig(cwd)
  return remote && chooseHost(remote, false, hostState)
}

/**
 * Copies the working tree to a fresh folder on `host`, installs dependencies and runs `command` there
 * with `stdin`, then removes the folder. Undefined when the copy failed.
 */
export async function runInHostCopy(cwd: string, host: string, command: string, stdin: string, echo = true): Promise<{ code: number; output: string } | undefined> {
  const ssh = sshTo(host)
  const dir = `runs/${Date.now()}-${process.pid}`
  const scratch = mkdtempSync(join(tmpdir(), 'suite-remote-'))
  try {
    const tree = Bun.spawnSync(['git', 'ls-files', '-co', '--exclude-standard', '-z'], { cwd }).stdout.toString().split('\0')
    const present = [...new Set(tree)].filter((file) => file && existsSync(join(cwd, file)) && statSync(join(cwd, file)).isFile())
    writeFileSync(join(scratch, 'files'), present.join('\0'))
    if ((await exec([...ssh, `mkdir -p ${dir}`], cwd, false)).code !== 0) return undefined
    const copy = await exec(['rsync', '-a', '--from0', `--files-from=${join(scratch, 'files')}`, '-e', 'ssh -o BatchMode=yes', './', `${host}:${dir}/`], cwd, false)
    if (copy.code !== 0) {
      console.error(copy.output)
      return undefined
    }
    const script = `export PATH="$HOME/.bun/bin:$PATH" && cd ${dir} && bun install --frozen-lockfile >/dev/null && ${command}`
    return await exec([...ssh, script], cwd, echo, stdin)
  } finally {
    await exec([...ssh, `rm -rf ${dir}`], cwd, false)
    rmSync(scratch, { recursive: true, force: true })
  }
}

/** Runs `files` on the host; undefined when the host or the copy failed, as opposed to a test. */
async function runRemote(cwd: string, remote: Host, files: string[], flags: string[], land: boolean): Promise<SuiteResult | undefined> {
  const quoted = flags.map((flag) => `'${flag.replaceAll("'", `'\\''`)}'`).join(' ')
  const profileExport = process.env.QUIRKY_TEST_PROFILE === '1' ? 'export QUIRKY_TEST_PROFILE=1 && ' : ''
  const command = `${profileExport}bun scripts/suite.ts --worker --jobs ${land ? (remote.slots ?? 8) : (remote.jobs ?? 4)} --slots ${remote.slots ?? 8} --land ${land ? 1 : 0} ${quoted}`
  const run = await runInHostCopy(cwd, remote.host, command, files.join('\n'))
  const line = run?.output.split('\n').find((text) => text.startsWith(RESULT_PREFIX))
  return line ? (JSON.parse(line.slice(RESULT_PREFIX.length)) as SuiteResult) : undefined
}

async function installLocalDependencies(cwd: string): Promise<boolean> {
  if (!existsSync(join(cwd, 'package.json'))) return true
  return (await exec(['bun', 'install', '--frozen-lockfile'], cwd)).code === 0
}

async function main(argv: string[]): Promise<boolean> {
  const cwd = process.cwd()
  if (argv[0] === '--worker') {
    const value = (name: string) => Number(argv[argv.indexOf(name) + 1])
    const flags = argv.slice(7)
    const log = join(homedir(), 'test-slots', 'durations.log')
    const files = slowestFirst((await new Response(Bun.stdin.stream()).text()).split('\n').filter(Boolean), log)
    const result = await runFiles(cwd, files, flags, value('--jobs'), 5, slotted(value('--slots'), value('--land') === 1, log))
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(result)}\n`)
    return result.ok
  }
  const remote = remoteConfig(cwd)
  if (!remote) {
    if (!(await installLocalDependencies(cwd))) return false
    if (process.env.QUIRKY_TEST_PROFILE === '1') {
      const flags = argv.filter((arg) => arg.startsWith('-'))
      return (await runFiles(cwd, discover(cwd, argv), flags, 1)).ok
    }
    return (await runSuite(cwd, argv)).ok
  }
  const flags = argv.filter((arg) => arg.startsWith('-'))
  const macos = macosOnly(join(cwd, MACOS_LIST))
  const files = discover(cwd, argv)
  const here = files.filter((file) => macos.has(file))
  const there = files.filter((file) => !macos.has(file))
  const runLocal = async (files: string[]): Promise<SuiteResult> => {
    if (files.length === 0) return { ok: true, flaky: [] }
    if (!(await installLocalDependencies(cwd))) return { ok: false, flaky: [] }
    return runFiles(cwd, files, flags, 1)
  }
  if (there.length === 0) return (await runLocal(here)).ok
  const land = ['integration', 'verify'].includes(basename(cwd)) && basename(dirname(cwd)) === 'build-loop'
  const choice = await chooseHost(remote, land, hostState)
  if ('error' in choice) {
    console.error(choice.error)
    return false
  }
  if (choice.note) console.log(choice.note)
  console.log(`running ${there.length} test files on ${choice.host.host} and ${here.length} macOS-only files here`)
  const runAway = async (): Promise<SuiteResult> => {
    const result = await runRemote(cwd, choice.host, there, flags, land)
    if (result) return result
    console.error(`\n${choice.host.host} couldn't finish the tests, so this run stops`)
    process.exit(1)
  }
  const [away, local] = await Promise.all([runAway(), runLocal(here)])
  if (away.flaky.length > 0) recordFlakes(cwd, away.flaky)
  return away.ok && local.ok
}

if (import.meta.main) process.exitCode = (await main(Bun.argv.slice(2))) ? 0 : 1
