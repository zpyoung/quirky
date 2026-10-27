#!/usr/bin/env bun
/**
 * The project's test run. A failing test file gets one more run on its own: one that passes alone
 * failed only under load, so it's reported as flaky and the run passes; one that fails again, a
 * failure that can't be pinned to a file, or more failing files than the limit fails the run.
 * Flaky files are appended to `<git common dir>/build-loop/flakes.log` when the build loop is set up.
 *
 * When `<git common dir>/build-loop/remote-tests.json` names a host (`{"host": "user@box", "jobs": 4}`),
 * the run moves off this machine: the working tree is copied to a fresh folder there and each test
 * file runs in its own process, `jobs` at a time, each holding one of `slots` machine-wide locks there
 * so several runs at once share the host's cores (`slots` defaults to 8). Files listed in scripts/test-on-macos.txt still run
 * here, alongside. If the host can't be reached the whole run falls back to this machine.
 * `QUIRKY_TEST_LOCAL=1` skips the host.
 *
 *   bun scripts/suite.ts packages apps plugins
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { Store } from '../packages/daemon/src/store'

export type SuiteResult = { ok: boolean; flaky: string[] }
type Remote = { host: string; jobs?: number; slots?: number }
type Run = (cwd: string, args: string[]) => Promise<{ code: number; output: string }>

const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/
const RESULT_PREFIX = 'suite-result '
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
  env: NodeJS.ProcessEnv = process.env
): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(cmd, { cwd, env, stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([tee(child.stdout, echo ? process.stdout : null), tee(child.stderr, echo ? process.stderr : null)])
  return { code: await child.exited, output: out + err }
}

async function withTestHome<T>(run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
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
    return await run({ ...process.env, HOME: home, QUIRKY_HOME: quirkyHome })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const bunTest = (cwd: string, args: string[], echo = true) =>
  withTestHome((env) => exec(['bun', 'test', ...args], cwd, echo, undefined, env))
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
async function rerunAlone(cwd: string, failed: string[], flags: string[], limit: number): Promise<SuiteResult> {
  if (failed.length > limit) return { ok: false, flaky: [] }
  console.error(`\nrerunning ${failed.length} failing file(s) alone: ${failed.join(', ')}`)
  for (const file of failed) if ((await bunTest(cwd, [...flags, asPath(file)])).code !== 0) return { ok: false, flaky: [] }
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
  run: Run = (dir, args) => bunTest(dir, args, false)
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
  return failed.length === 0 ? { ok: true, flaky: [] } : rerunAlone(cwd, failed.sort(), flags, limit)
}

/** `bun test` that first takes one of `slots` locks shared by every run on this machine. */
function slotted(slots: number): Run {
  const dir = join(homedir(), 'test-slots')
  mkdirSync(dir, { recursive: true })
  const BUSY = 75
  return async (cwd, args) => {
    for (;;) {
      const start = Math.floor(Math.random() * slots)
      for (let i = 0; i < slots; i++) {
        const lock = join(dir, `${(start + i) % slots}.lock`)
        const result = await withTestHome((env) => exec(['flock', '-n', '-E', String(BUSY), lock, 'bun', 'test', ...args], cwd, false, undefined, env))
        if (result.code !== BUSY) return result
      }
      await Bun.sleep(500)
    }
  }
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

function remoteConfig(cwd: string): Remote | undefined {
  if (process.env.QUIRKY_TEST_LOCAL) return undefined
  const common = gitCommonDir(cwd)
  const file = common && join(common, 'build-loop', 'remote-tests.json')
  return file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Remote) : undefined
}

/** Runs `files` on the host; undefined when the host or the copy failed, as opposed to a test. */
async function runRemote(cwd: string, remote: Remote, files: string[], flags: string[]): Promise<SuiteResult | undefined> {
  const ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', remote.host]
  const dir = `runs/${Date.now()}-${process.pid}`
  const scratch = mkdtempSync(join(tmpdir(), 'suite-remote-'))
  try {
    const tree = Bun.spawnSync(['git', 'ls-files', '-co', '--exclude-standard', '-z'], { cwd }).stdout.toString().split('\0')
    const present = [...new Set(tree)].filter((file) => file && existsSync(join(cwd, file)) && statSync(join(cwd, file)).isFile())
    writeFileSync(join(scratch, 'files'), present.join('\0'))
    if ((await exec([...ssh, `mkdir -p ${dir}`], cwd, false)).code !== 0) return undefined
    const copy = await exec(['rsync', '-a', '--from0', `--files-from=${join(scratch, 'files')}`, '-e', 'ssh -o BatchMode=yes', './', `${remote.host}:${dir}/`], cwd, false)
    if (copy.code !== 0) {
      console.error(copy.output)
      return undefined
    }
    const quoted = flags.map((flag) => `'${flag.replaceAll("'", `'\\''`)}'`).join(' ')
    const script = `export PATH="$HOME/.bun/bin:$PATH" && cd ${dir} && bun install --frozen-lockfile >/dev/null && bun scripts/suite.ts --worker --jobs ${remote.jobs ?? 4} --slots ${remote.slots ?? 8} ${quoted}`
    const run = await exec([...ssh, script], cwd, true, files.join('\n'))
    const line = run.output.split('\n').find((text) => text.startsWith(RESULT_PREFIX))
    return line ? (JSON.parse(line.slice(RESULT_PREFIX.length)) as SuiteResult) : undefined
  } finally {
    await exec([...ssh, `rm -rf ${dir}`], cwd, false)
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function main(argv: string[]): Promise<boolean> {
  const cwd = process.cwd()
  if (argv[0] === '--worker') {
    const value = (name: string) => Number(argv[argv.indexOf(name) + 1])
    const flags = argv.slice(5)
    const files = (await new Response(Bun.stdin.stream()).text()).split('\n').filter(Boolean)
    const result = await runFiles(cwd, files, flags, value('--jobs'), 5, slotted(value('--slots')))
    console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`)
    return result.ok
  }
  const remote = remoteConfig(cwd)
  if (!remote) return (await runSuite(cwd, argv)).ok
  const flags = argv.filter((arg) => arg.startsWith('-'))
  const macos = macosOnly(join(cwd, MACOS_LIST))
  const files = discover(cwd, argv)
  const here = files.filter((file) => macos.has(file))
  const there = files.filter((file) => !macos.has(file))
  console.log(`running ${there.length} test files on ${remote.host} and ${here.length} macOS-only files here`)
  const [away, local] = await Promise.all([runRemote(cwd, remote, there, flags), runFiles(cwd, here, flags, 1)])
  if (away) return away.ok && local.ok
  console.error(`\n${remote.host} couldn't run the tests, so they run here instead`)
  return (await runFiles(cwd, there, flags, 1)).ok && local.ok
}

if (import.meta.main) process.exit((await main(Bun.argv.slice(2))) ? 0 : 1)
