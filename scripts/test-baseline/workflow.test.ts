import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { CLI_FILES_LIMITS } from '../parity/cli-files-limits'
import { discover, macosOnly } from '../suite'
import { createProcessScope } from '../test-support/process-scope'

type Step = {
  id?: string
  name?: string
  uses?: string
  run?: string
  if?: string | boolean
  with?: Record<string, unknown>
  env?: Record<string, string>
  'timeout-minutes'?: number
  'continue-on-error'?: boolean
}
type Job = {
  name?: string
  if?: string | boolean
  needs?: string | string[]
  permissions?: Record<string, string>
  env?: Record<string, string>
  'timeout-minutes'?: number
  steps?: Step[]
}
type Workflow = {
  on: Record<string, unknown>
  concurrency: { group: string; 'cancel-in-progress': string | boolean }
  permissions?: Record<string, string>
  jobs: Record<string, Job>
}

type StepStatus = 'success' | 'failure' | 'skipped'
type UploadCall = {
  id: string
  name: string
  path: string
  retentionDays: unknown
  ifNoFilesFound: unknown
  overwrite: boolean
  outcome: StepStatus
  conclusion: StepStatus
}
type UploadSimulationOptions = {
  resultsPresent: boolean
  failedAttempts?: ReadonlySet<number>
  partialArtifactOnFailure?: boolean
  cancelled?: boolean
  cancelAfterAttempt?: number
  shardFailed?: boolean
}
type UploadedArtifact = { path: string; attempt: number; partial: boolean }

const path = join(import.meta.dir, '../../.github/workflows/tests.yml')
const source = await Bun.file(path).text()
const workflow = Bun.YAML.parse(source) as Workflow

const jobs = workflow.jobs
const steps = (name: string): Step[] => jobs[name]!.steps ?? []
const runs = (name: string): string[] => steps(name).flatMap(step => (step.run ? [step.run] : []))
const allRuns = Object.keys(jobs).flatMap(runs)
const needsOf = (name: string): string[] => [jobs[name]!.needs ?? []].flat()
const effectivePermissions = (name: string): Record<string, string> => jobs[name]!.permissions ?? workflow.permissions ?? {}
const norm = (expr: unknown): string => String(expr).replace(/\$\{\{|\}\}/g, '').replace(/\s+/g, ' ').trim()

const resultUploadSteps = (job: string): (Step & { id: string })[] =>
  steps(job).filter(step => /^upload_results_[123]$/.test(step.id ?? '')) as (Step & { id: string })[]

const shouldRunResultUpload = (
  expression: unknown,
  state: {
    cancelled: boolean
    resultsPresent: boolean
    outcomes: Map<string, StepStatus>
    conclusions: Map<string, StepStatus>
  },
): boolean => {
  const condition = norm(expression)
  if (condition === "!cancelled() && hashFiles('results/*.json') != ''") {
    return !state.cancelled && state.resultsPresent
  }
  const retry = condition.match(/^!cancelled\(\) && steps\.(upload_results_[12])\.(outcome|conclusion) == 'failure'$/)
  if (!retry) throw new Error(`Unsupported result-upload condition: ${condition}`)
  const status = retry[2] === 'outcome' ? state.outcomes : state.conclusions
  return !state.cancelled && status.get(retry[1]!) === 'failure'
}

const simulateResultUploads = (job: string, options: UploadSimulationOptions) => {
  const outcomes = new Map<string, StepStatus>()
  const conclusions = new Map<string, StepStatus>()
  const attempts: UploadCall[] = []
  const artifacts = new Map<string, UploadedArtifact>()
  let cancelled = options.cancelled ?? false
  let jobFailed = options.shardFailed ?? false

  for (const step of resultUploadSteps(job)) {
    const id = step.id
    if (!shouldRunResultUpload(step.if, { cancelled, resultsPresent: options.resultsPresent, outcomes, conclusions })) {
      outcomes.set(id, 'skipped')
      conclusions.set(id, 'skipped')
      continue
    }

    const attempt = Number(id.slice(-1))
    const name = String(step.with?.name)
    const path = String(step.with?.path)
    const previous = artifacts.get(name)
    const overwrite = step.with?.overwrite === true
    let outcome: StepStatus
    if (previous && !overwrite) {
      outcome = 'failure'
    } else if (options.failedAttempts?.has(attempt)) {
      outcome = 'failure'
      if (options.partialArtifactOnFailure) artifacts.set(name, { path, attempt, partial: true })
    } else {
      outcome = 'success'
      artifacts.set(name, { path, attempt, partial: false })
    }
    const conclusion: StepStatus = outcome === 'failure' && step['continue-on-error'] === true ? 'success' : outcome
    if (outcome === 'failure' && conclusion === 'failure') jobFailed = true

    outcomes.set(id, outcome)
    conclusions.set(id, conclusion)
    attempts.push({
      id,
      name,
      path,
      retentionDays: step.with?.['retention-days'],
      ifNoFilesFound: step.with?.['if-no-files-found'],
      overwrite,
      outcome,
      conclusion,
    })
    if (options.cancelAfterAttempt === attempt) cancelled = true
  }

  return { attempts, artifacts, jobFailed }
}

const JOBS_OK = "${{ needs.plan.result != 'failure' && needs.plan.result != 'cancelled' && needs.linux.result != 'failure' && needs.linux.result != 'cancelled' && needs.macos.result != 'failure' && needs.macos.result != 'cancelled' }}"

describe('tests.yml triggers and defaults', () => {
  test('runs on pull requests, pushes to main and manual dispatch', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['pull_request', 'push', 'workflow_dispatch'])
    expect((workflow.on.push as { branches: string[] }).branches).toEqual(['main'])
  })

  test('a pull request reruns when labelled, and full-suite asks the plan for every test', () => {
    expect((workflow.on.pull_request as { types: string[] }).types).toEqual(['opened', 'synchronize', 'reopened', 'labeled'])
    const plan = steps('plan').find(step => step.name === 'Plan the run')!
    expect(plan.env?.FULL_SUITE).toBe("${{ contains(github.event.pull_request.labels.*.name, 'full-suite') }}")
    expect(plan.run).toContain('--full "$FULL_SUITE"')
  })

  test('cancels superseded runs on pull requests only', () => {
    expect(workflow.concurrency.group).toBe('tests-${{ github.ref }}')
    expect(norm(workflow.concurrency['cancel-in-progress'])).toBe("github.event_name == 'pull_request'")
  })

  test('defaults the token to read-only contents', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
  })

  test('never uses pull_request_target', () => {
    expect(source).not.toContain('pull_request_target')
  })
})

describe('job graph', () => {
  test('defines the unit jobs and independent speed evidence job', () => {
    expect(Object.keys(jobs).sort()).toEqual(['linux', 'macos', 'plan', 'speed', 'tests'])
  })

  test('needs match the job table', () => {
    expect(needsOf('plan')).toEqual([])
    expect(needsOf('linux')).toEqual(['plan'])
    expect(needsOf('macos')).toEqual(['plan'])
    expect([...needsOf('tests')].sort()).toEqual(['linux', 'macos', 'plan', 'speed'])
    expect(needsOf('speed')).toEqual([])
  })

  test('the Tests job is named Tests and always runs', () => {
    expect(jobs.tests!.name).toBe('Tests')
    expect(jobs.tests!.if).toBe('always()')
  })

  test('test jobs skip when the plan selects nothing for them', () => {
    expect(String(jobs.linux!.if)).toContain("needs.plan.outputs.linux_shards != '[]'")
    expect(String(jobs.macos!.if)).toContain("needs.plan.outputs.has_macos == 'true'")
  })

  test('every test job reruns its own failures, so no job waits on all the shards to rerun them', () => {
    for (const name of ['linux', 'macos']) {
      const shard = runs(name).filter(script => script.includes('cli.ts run-shard'))
      expect(shard).toHaveLength(1)
    }
    expect(allRuns.filter(script => /cli\.ts rerun\b/.test(script))).toEqual([])
  })

  test('linux shards install their test tools from a cache keyed on the runner image', () => {
    const cache = steps('linux').find(step => step.uses?.startsWith('actions/cache@'))!
    const name = steps('linux').find(step => step.id === 'tools')!
    expect(name.run).toContain('$ImageOS-$ImageVersion')
    expect(cache.with?.key).toBe('${{ steps.tools.outputs.key }}')
    const install = steps('linux').find(step => step.name === 'Install test tools')!
    expect(steps('linux').indexOf(install)).toBeGreaterThan(steps('linux').indexOf(cache))
    expect(install.run).toContain('apt-get install -y --download-only zsh ripgrep')
    expect(install.run).toContain('dpkg -i')
  })
})

describe('sandboxed Linux browser acceptance', () => {
  const prepare = () => steps('linux').find(step => step.name === 'Prepare sandboxed Chrome')

  test('prepares a real browser before any Linux shard, without changing macOS setup', () => {
    const step = prepare()
    expect(step).toBeDefined()
    expect(step?.if).toBeUndefined()
    expect((step as Step & { 'continue-on-error'?: boolean })?.['continue-on-error']).toBeUndefined()
    expect(steps('linux').indexOf(step!)).toBeLessThan(steps('linux').findIndex(item => item.name === 'Run shard'))
    expect(steps('macos').some(item => item.name === 'Prepare sandboxed Chrome')).toBe(false)
  })

  test('probes every supported Linux executable in order and fails when none exists', () => {
    const script = prepare()?.run ?? ''
    expect(script).toContain('set -euo pipefail')
    const candidates = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    let previous = -1
    for (const candidate of candidates) {
      const index = script.indexOf(candidate)
      expect(index).toBeGreaterThan(previous)
      previous = index
    }
    expect(script).toContain('[ -x "$candidate" ]')
    expect(script).toContain('[ -z "$chrome" ]')
    expect(script).toContain('exit 1')
    expect(script).toContain('"$chrome" --version')
  })

  test('bounds a sandboxed headless document smoke and cleans up its process group and private roots', () => {
    const script = prepare()?.run ?? ''
    for (const required of [
      '--signal=TERM', '--kill-after=5s', '20s', '60s',
      '--headless', '--dump-dom', '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
      'mktemp -d', 'HOME="$root/home"', 'XDG_CONFIG_HOME="$root/config"', 'XDG_CACHE_HOME="$root/cache"',
      '--user-data-dir="$root/profile"', 'quirky-linux-chrome', 'grep -q',
      'trap cleanup EXIT', 'kill -TERM -- "-$smoke_pid"', 'kill -KILL -- "-$smoke_pid"',
      'for attempt in {1..50}', 'wait "$smoke_pid"', 'rm -rf "$root"',
    ]) expect(script).toContain(required)
    expect(script).not.toMatch(/--no-sandbox|--disable-setuid-sandbox|QUIRKY_BROWSER_CHROME|apt-get|curl|wget/)
  })

  test('changes only the disposable Linux runner user-namespace restriction when enabled', () => {
    const script = prepare()?.run ?? ''
    expect(script).toContain('restriction=/proc/sys/kernel/apparmor_restrict_unprivileged_userns')
    expect(script).toContain('[ -f "$restriction" ]')
    expect(script).toContain('$(cat "$restriction")')
    expect(script).toContain('sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0')
    expect(script.match(/sudo sysctl[^\n]*/g)).toEqual(['sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0'])
  })

  type SmokeResult = { exit: number; result: 'ok' | 'timeout' | 'chrome-exit' | 'missing-marker' }
  type FixtureTrace =
    | { type: 'timeout'; requested: string; signal: string; killAfter: string; command: string[]; pid: number; shellPid: number }
    | { type: 'chrome'; phase: 'version'; executable: string; home: string; pid: number }
    | {
        type: 'chrome'
        phase: 'smoke'
        executable: string
        pid: number
        root: string
        home: string
        config: string
        cache: string
        profile: string
        previousRootRemoved: boolean
        previousProcessGone: boolean
        descendantPid?: number
        previousDescendantGone: boolean
      }

  const runPreparation = async (
    mode: string,
    expected: { code: number; version: number | null; attempts: readonly SmokeResult[]; signal?: 'SIGTERM' | 'SIGINT'; lingering?: boolean },
  ) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-chrome-preparation-')))
    const bin = join(root, 'bin')
    const runnerTemp = join(root, 'runner-temp')
    const home = join(root, 'home')
    const tracePath = join(root, 'trace.jsonl')
    const chrome = join(bin, 'chrome')
    const executionTrace = join(root, 'execution.log')
    const scope = createProcessScope()
    try {
      for (const directory of [bin, runnerTemp, home]) mkdirSync(directory)
      writeFileSync(tracePath, '')
      // The YAML shell and its timeout stand-in run outside Bun's fake-timer clock.
      const timeout = join(bin, 'timeout')
      const deadline = join(root, 'deadline.ts')
      writeFileSync(deadline, `#!${process.execPath}
const args = process.argv.slice(2)
let signal = ''
let killAfter = ''
while (args[0]?.startsWith('--')) {
  const option = args.shift()
  if (option.startsWith('--signal=')) signal = option.slice('--signal='.length)
  if (option.startsWith('--kill-after=')) killAfter = option.slice('--kill-after='.length)
}
const requested = args.shift()
const tracePath = process.env.CHROME_PREPARATION_TRACE
const event = { type: 'timeout', requested, signal, killAfter, command: args, pid: Number(process.env.CHROME_TIMEOUT_PID), shellPid: Number(process.env.CHROME_SHELL_PID) }
require('node:fs').appendFileSync(tracePath, JSON.stringify(event) + '\\n')
if (process.env.CHROME_RECORD_ONLY === '1') process.exit(0)
const seconds = Number(requested?.replace(/s$/, ''))
if (!Number.isFinite(seconds) || seconds <= 0) process.exit(2)
const child = Bun.spawn(args, { stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })
let expired = false
let killTimer
const timer = setTimeout(() => {
  expired = true
  child.kill('SIGTERM')
  killTimer = setTimeout(() => child.kill('SIGKILL'), 50)
}, seconds * 50)
const code = await child.exited
clearTimeout(timer)
if (killTimer) clearTimeout(killTimer)
process.exit(expired ? 124 : code)
`)
      writeFileSync(timeout, `#!/bin/bash
export CHROME_TIMEOUT_PID=$$ CHROME_SHELL_PID=$PPID
${process.platform === 'linux' ? `
CHROME_RECORD_ONLY=1 "${process.execPath}" "${deadline}" "$@"
while [[ "$1" == --* ]]; do shift; done
seconds="\${1%s}"
shift
exec /usr/bin/timeout --signal=TERM --kill-after=0.1s "$(awk "BEGIN {print $seconds / 20}")s" "$@"
` : `
exec python3 -c 'import os,sys; os.setpgid(0,0); os.execv(sys.argv[1],sys.argv[1:])' "${process.execPath}" "${deadline}" "$@"
`}`)
      writeFileSync(chrome, `#!${process.execPath}
const mode = process.env.CHROME_PREPARATION_CASE
const tracePath = process.env.CHROME_PREPARATION_TRACE
async function appendEvent(event) {
  require('node:fs').appendFileSync(tracePath, JSON.stringify(event) + '\\n')
}
if (process.argv.includes('--version')) {
  await appendEvent({ type: 'chrome', phase: 'version', executable: process.argv[1], home: process.env.HOME, pid: process.pid })
  if (mode === 'slow-version') await Bun.sleep(6 * 50)
  if (mode === 'version-failure') process.exit(7)
  console.log('Owned Chrome stand-in')
} else {
  const previousEvents = (await Bun.file(tracePath).text()).trim().split('\\n').filter(Boolean).map(JSON.parse)
  const previousSmokes = previousEvents.filter(event => event.type === 'chrome' && event.phase === 'smoke')
  const attempt = previousSmokes.length + 1
  const home = process.env.HOME
  const root = home.slice(0, home.lastIndexOf('/'))
  const profileArg = process.argv.find(argument => argument.startsWith('--user-data-dir='))
  const previous = previousSmokes.at(-1)
  const processGone = pid => {
    if (!pid) return true
    const state = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(pid)]).stdout.toString().trim()
    return !state || state.startsWith('Z')
  }
  let descendantPid
  if (process.platform === 'linux' && process.env.CHROME_LINGERING === '1') {
    const descendant = Bun.spawn([process.execPath, '-e', 'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)'], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'inherit',
    })
    const ready = descendant.stdout.getReader()
    await ready.read()
    await ready.cancel()
    descendant.unref()
    descendantPid = descendant.pid
  }
  let previousProcessGone = true
  if (previous) {
    try {
      process.kill(previous.pid, 0)
      previousProcessGone = false
    } catch (error) {
      previousProcessGone = error.code !== 'EPERM'
    }
  }
  await appendEvent({
    type: 'chrome',
    phase: 'smoke',
    executable: process.argv[1],
    pid: process.pid,
    root,
    home,
    config: process.env.XDG_CONFIG_HOME,
    cache: process.env.XDG_CACHE_HOME,
    profile: profileArg?.slice('--user-data-dir='.length),
    previousRootRemoved: previous ? !require('node:fs').existsSync(previous.root) : true,
    previousProcessGone,
    descendantPid,
    previousDescendantGone: !previous || processGone(previous.descendantPid),
  })
  if (mode === 'slow-start') {
    await Bun.sleep(25 * 50)
    console.log('<p>quirky-linux-chrome</p>')
  } else if ((mode === 'timeout-recovery' || mode === 'cancellation') && attempt === 1) {
    console.log('<p>quirky-linux-chrome from stale attempt</p>')
    process.stderr.write('timeout diagnostic 1\\n')
    await Bun.sleep(10_000)
  } else if (mode === 'timeout-all' || mode === 'cancellation') {
    process.stderr.write('timeout diagnostic ' + attempt + '\\n')
    await Bun.sleep(10_000)
  } else if (mode === 'smoke-failure') {
    process.stderr.write('owned failure ' + attempt + '\\n')
    process.exit(9)
  } else if (mode === 'exit-137') {
    process.stderr.write('owned failure ' + attempt + '\\n')
    process.exit(137)
  } else if (mode === 'missing-marker' || (mode === 'marker-recovery' && attempt === 1)) {
    console.log('<p>wrong document</p>')
  } else {
    console.log('<p>quirky-linux-chrome</p>')
  }
}
`)
      const sudo = join(bin, 'sudo')
      writeFileSync(sudo, '#!/bin/sh\nprintf "unexpected sudo invocation\\n" >&2\nexit 91\n')
      for (const executable of [timeout, chrome, sudo]) chmodSync(executable, 0o700)
      const candidate = mode === 'missing-browser' ? join(root, 'missing-chrome') : chrome
      const script = prepare()!.run!
        .replace(/\/usr\/bin\/(?:google-chrome(?:-stable)?|chromium(?:-browser)?)/g, candidate)
        .replace('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', join(root, 'absent-restriction'))
      const harness = 'bash -x -c "$1" 2>"$CHROME_EXECUTION_TRACE"; status=$?; if [ "$status" -eq 0 ]; then printf "SHARD_SENTINEL\\n"; fi; exit "$status"'
      const child = scope.spawn(['bash', '-c', harness, 'workflow-step-then-shard', script], {
        env: {
          ...process.env,
          ...scope.env,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
          HOME: home,
          QUIRKY_HOME: home,
          XDG_CONFIG_HOME: home,
          XDG_CACHE_HOME: home,
          XDG_DATA_HOME: home,
          RUNNER_TEMP: runnerTemp,
          CHROME_PREPARATION_CASE: mode,
          CHROME_PREPARATION_TRACE: tracePath,
          CHROME_EXECUTION_TRACE: executionTrace,
          CHROME_LINGERING: expected.lingering ? '1' : '0',
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
        },
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const output = Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      const { promise: watchdogExpired, reject: rejectWatchdog } = Promise.withResolvers<never>()
      // Bound the real Bash child; fake timers do not control this subprocess.
      const watchdog = setTimeout(() => {
        child.kill('SIGKILL')
        rejectWatchdog(new Error('Chrome preparation fixture exceeded 20 seconds'))
      }, 20_000)
      // Poll subprocess readiness, not elapsed time: Bash/GNU timeout cannot use Bun fake timers.
      const cancellation = expected.signal ? (async () => {
        while (true) {
          const events = (await Bun.file(tracePath).text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as FixtureTrace)
          if (events.filter(event => event.type === 'chrome' && event.phase === 'smoke').length === 2) {
            const deadline = events.filter((event): event is Extract<FixtureTrace, { type: 'timeout' }> => event.type === 'timeout').at(-1)!
            process.kill(deadline.shellPid, expected.signal)
            return
          }
          if (child.exitCode !== null) throw new Error('Preparation exited before cancellation reached its second smoke')
          await Bun.sleep(10)
        }
      })() : Promise.resolve()
      const [[code, stdout, shellStderr]] = await Promise.race([Promise.all([output, cancellation]), watchdogExpired]).finally(() => clearTimeout(watchdog))
      const execution = await Bun.file(executionTrace).text()
      const stderr = shellStderr + execution.split('\n').filter(line => !/^\++ /.test(line)).join('\n')
      const trace = (await Bun.file(tracePath).text()).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as FixtureTrace)
      const timeoutCalls = trace.filter((event): event is Extract<FixtureTrace, { type: 'timeout' }> => event.type === 'timeout')
      const chromeCalls = trace.filter((event): event is Extract<FixtureTrace, { type: 'chrome' }> => event.type === 'chrome')
      const versions = chromeCalls.filter((event): event is Extract<FixtureTrace, { type: 'chrome'; phase: 'version' }> => event.phase === 'version')
      const smokes = chromeCalls.filter((event): event is Extract<FixtureTrace, { type: 'chrome'; phase: 'smoke' }> => event.phase === 'smoke')
      expect(code).toBe(expected.code)
      expect(stderr).not.toContain('unexpected sudo invocation')
      expect(versions).toHaveLength(expected.version === null ? 0 : 1)
      expect(versions.every(event => event.executable === chrome && !relative(root, event.home).startsWith('..'))).toBe(true)
      expect(smokes).toHaveLength(expected.attempts.length)
      expect(smokes.every(event => event.executable === chrome)).toBe(true)
      expect(timeoutCalls.map(event => ({
        requested: event.requested,
        signal: event.signal,
        killAfter: event.killAfter,
        phase: event.command.includes('--version') ? 'version' : 'smoke',
      }))).toEqual([
        ...(expected.version === null ? [] : [{ requested: '20s', signal: 'TERM', killAfter: '5s', phase: 'version' }]),
        ...expected.attempts.map(() => ({ requested: '60s', signal: 'TERM', killAfter: '5s', phase: 'smoke' })),
      ])
      expect(timeoutCalls.every(event => event.command.includes(chrome))).toBe(true)
      const versionLines = stdout.match(/^Chrome version probe: \d+s \(exit \d+\)$/gm) ?? []
      expect(versionLines).toHaveLength(expected.version === null ? 0 : 1)
      if (expected.version !== null) expect(versionLines[0]).toContain(`(exit ${expected.version})`)
      const attemptLines = stdout.match(/^Chrome sandbox smoke attempt \d+\/3: \d+s \(exit \d+, result (?:ok|timeout|chrome-exit|missing-marker)\)$/gm) ?? []
      expect(attemptLines).toHaveLength(expected.attempts.length)
      expected.attempts.forEach((attempt, index) => {
        expect(attemptLines[index]?.startsWith(`Chrome sandbox smoke attempt ${index + 1}/3: `)).toBe(true)
        expect(attemptLines[index]?.endsWith(` (exit ${attempt.exit}, result ${attempt.result})`)).toBe(true)
      })
      const totalLines = stdout.match(/^Chrome sandbox smoke total: \d+s \(\d+ attempts, exit \d+\)$/gm) ?? []
      expect(totalLines).toHaveLength(expected.attempts.length ? 1 : 0)
      if (expected.attempts.length) {
        expect(totalLines[0]).toContain(`(${expected.attempts.length} attempts, exit ${expected.code})`)
      }
      expect(stdout.match(/^SHARD_SENTINEL$/gm) ?? []).toHaveLength(expected.code === 0 ? 1 : 0)
      const privatePaths = smokes.flatMap(event => [event.home, event.config, event.cache, event.profile])
      expect(new Set(smokes.map(event => event.root)).size).toBe(smokes.length)
      expect(new Set(privatePaths).size).toBe(smokes.length * 4)
      for (const event of smokes) {
        expect(event.root.startsWith(`${runnerTemp}/`)).toBe(true)
        expect(event.home).toBe(join(event.root, 'home'))
        expect(event.config).toBe(join(event.root, 'config'))
        expect(event.cache).toBe(join(event.root, 'cache'))
        expect(event.profile).toBe(join(event.root, 'profile'))
        expect(!relative(event.root, event.home).startsWith('..')).toBe(true)
        expect(existsSync(event.root)).toBe(false)
      }
      smokes.slice(1).forEach(event => {
        expect(event.previousRootRemoved).toBe(true)
        expect(event.previousProcessGone).toBe(true)
        expect(event.previousDescendantGone).toBe(true)
      })
      for (const event of smokes) {
        if (event.descendantPid) {
          const state = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(event.descendantPid)]).stdout.toString().trim()
          expect(!state || state.startsWith('Z')).toBe(true)
        }
      }
      let activePid = ''
      for (const line of execution.split('\n')) {
        const assigned = line.match(/^\+ smoke_pid=(\d*)$/)
        if (assigned) activePid = assigned[1]!
        const signalled = line.match(/^\+ kill -(?:TERM|KILL|0) -- -(\d+)$/)
        if (signalled) {
          expect(activePid).not.toBe('')
          expect(signalled[1]).toBe(activePid)
        }
      }
      expect(readdirSync(runnerTemp)).toEqual([])
      return { code, stdout, stderr, trace, smokes }
    } finally {
      try {
        await scope.cleanup()
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  }

  test('keeps the version deadline at 20 seconds and lets a logical 25-second first start finish within 60 seconds', async () => {
    const result = await runPreparation('slow-start', {
      code: 0,
      version: 0,
      attempts: [{ exit: 0, result: 'ok' }],
    })
    expect(result.smokes).toHaveLength(1)
    expect(result.stderr).toBe('')
  }, 30_000)

  test('retries a timeout in a fresh root without allowing stale DOM output to qualify the retry', async () => {
    const result = await runPreparation('timeout-recovery', {
      code: 0,
      version: 0,
      attempts: [{ exit: 124, result: 'timeout' }, { exit: 0, result: 'ok' }],
    })
    expect(result.stderr).toContain('Chrome sandbox smoke attempt 1/3')
    expect(result.stderr).toContain('timeout diagnostic 1')
    expect(result.smokes[0]!.root).not.toBe(result.smokes[1]!.root)
    expect(result.smokes[1]!.previousRootRemoved).toBe(true)
    expect(result.smokes[1]!.previousProcessGone).toBe(true)
  }, 30_000)

  test('retries an exit-zero smoke whose own document is missing the marker', async () => {
    const result = await runPreparation('marker-recovery', {
      code: 0,
      version: 0,
      attempts: [{ exit: 1, result: 'missing-marker' }, { exit: 0, result: 'ok' }],
    })
    expect(result.stderr).toContain('Chrome sandbox smoke attempt 1/3: expected quirky-linux-chrome marker missing')
  }, 30_000)

  test('stops after three timeouts and preserves their attempt-attributed diagnostics', async () => {
    const result = await runPreparation('timeout-all', {
      code: 124,
      version: 0,
      attempts: Array.from({ length: 3 }, () => ({ exit: 124, result: 'timeout' as const })),
    })
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(result.stderr).toContain(`Chrome sandbox smoke attempt ${attempt}/3`)
      expect(result.stderr).toContain(`timeout diagnostic ${attempt}`)
    }
  }, 30_000)

  test('retries nonzero Chrome exits and returns the final failure with all diagnostics', async () => {
    const result = await runPreparation('smoke-failure', {
      code: 9,
      version: 0,
      attempts: Array.from({ length: 3 }, () => ({ exit: 9, result: 'chrome-exit' as const })),
    })
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(result.stderr).toContain(`Chrome sandbox smoke attempt ${attempt}/3`)
      expect(result.stderr).toContain(`owned failure ${attempt}`)
    }
  }, 30_000)

  test('fails closed after three successful exits without the marker and reports every missing marker', async () => {
    const result = await runPreparation('missing-marker', {
      code: 1,
      version: 0,
      attempts: Array.from({ length: 3 }, () => ({ exit: 1, result: 'missing-marker' as const })),
    })
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(result.stderr).toContain(`Chrome sandbox smoke attempt ${attempt}/3: expected quirky-linux-chrome marker missing`)
    }
  }, 30_000)

  test('preserves 137 after exhausting timeout-classified smoke exits', async () => {
    const result = await runPreparation('exit-137', {
      code: 137,
      version: 0,
      attempts: Array.from({ length: 3 }, () => ({ exit: 137, result: 'timeout' as const })),
    })
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(result.stderr).toContain(`Chrome sandbox smoke attempt ${attempt}/3`)
      expect(result.stderr).toContain(`owned failure ${attempt}`)
    }
  }, 30_000)

  for (const [mode, expected] of [
    ['slow-version', { code: 0, version: 0, attempts: [{ exit: 0, result: 'ok' }] }],
    ['missing-browser', { code: 1, version: null, attempts: [] }],
    ['version-failure', { code: 7, version: 7, attempts: [] }],
  ] as const) {
    test(`preserves the ${mode} browser-discovery compatibility case`, async () => {
      const result = await runPreparation(mode, expected)
      if (mode === 'missing-browser') {
        expect(result.stderr).toBe('No installed Chrome or Chromium executable found\n')
      } else {
        expect(result.stderr).toBe('')
      }
      if (mode === 'slow-version') expect(result.stdout).toContain('SHARD_SENTINEL')
    }, 30_000)
  }

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    test(`cancels the second smoke with ${signal} without retrying or leaving owned processes`, async () => {
      await runPreparation('cancellation', {
        code: signal === 'SIGTERM' ? 143 : 130,
        version: 0,
        attempts: [{ exit: 124, result: 'timeout' }, { exit: signal === 'SIGTERM' ? 143 : 130, result: 'chrome-exit' }],
        signal,
        lingering: process.platform === 'linux',
      })
    }, 30_000)
  }

  test.skipIf(process.platform !== 'linux')('reaps TERM-ignoring descendants before retry and after a successful smoke', async () => {
    await runPreparation('timeout-recovery', {
      code: 0,
      version: 0,
      attempts: [{ exit: 124, result: 'timeout' }, { exit: 0, result: 'ok' }],
      lingering: true,
    })
  }, 30_000)
})

describe('Linux Playwright browser provisioning', () => {
  test('installs the full Chromium bundle before shards without changing smoke or other jobs', () => {
    const linux = steps('linux')
    const dependencies = linux.find(step => step.run === 'bun install --frozen-lockfile')!
    const configure = linux.find(step => step.name === 'Set Playwright browser path')!
    const install = linux.find(step => step.name === 'Install Playwright Chromium')!
    const prepare = linux.find(step => step.name === 'Prepare sandboxed Chrome')!
    const shard = linux.find(step => step.name === 'Run shard')!

    for (const job of Object.values(jobs)) {
      for (const value of Object.values(job.env ?? {})) {
        expect(value).not.toMatch(/\$\{\{[^}]*\brunner\./)
      }
    }
    expect(configure).toBeDefined()
    expect(configure.run).toBe('echo "PLAYWRIGHT_BROWSERS_PATH=$RUNNER_TEMP/quirky-playwright" >> "$GITHUB_ENV"')
    expect(linux.indexOf(configure)).toBeLessThan(linux.indexOf(install))
    expect(linux.indexOf(configure)).toBeLessThan(linux.indexOf(shard))
    expect(configure.if).toBeUndefined()
    expect(configure['continue-on-error']).toBeUndefined()
    expect(install.run).toBe('bun node_modules/playwright/cli.js install chromium')
    expect(linux.indexOf(install)).toBeGreaterThan(linux.indexOf(dependencies))
    expect(linux.indexOf(install)).toBeLessThan(linux.indexOf(shard))
    expect(install.if).toBeUndefined()
    expect(install['continue-on-error']).toBeUndefined()
    expect(install.run).not.toMatch(/--only-shell|--no-shell/)
    expect(prepare).toBeDefined()
    expect(linux.indexOf(prepare)).toBeLessThan(linux.indexOf(shard))
    expect(jobs.linux!['timeout-minutes']).toBe(30)

    expect(jobs.macos!.env?.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined()
    expect(steps('macos').some(step => step.run?.includes('playwright/cli.js install chromium'))).toBe(false)
    expect(jobs.speed!.env?.PLAYWRIGHT_BROWSERS_PATH).toBeUndefined()
    expect(steps('speed').some(step => step.run === 'bun node_modules/playwright/cli.js install chromium')).toBe(true)
  })

  test('keeps the bundle path stable in fresh Bun children with different homes', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-playwright-path-')))
    const browsers = join(root, 'runner-temp', 'quirky-playwright')
    const homes = [join(root, 'home-one'), join(root, 'home-two')]
    const projectRoot = join(import.meta.dir, '../..')
    try {
      for (const home of homes) mkdirSync(home)
      const runnerTemp = join(root, 'runner-temp')
      const githubEnv = join(root, 'github-env')
      const configure = steps('linux').find(step => step.name === 'Set Playwright browser path')!
      const setup = Bun.spawnSync(['bash', '-eu', '-c', configure.run!], {
        env: { ...process.env, QUIRKY_HOME: root, RUNNER_TEMP: runnerTemp, GITHUB_ENV: githubEnv },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      expect(setup.exitCode).toBe(0)
      const exported = readFileSync(githubEnv, 'utf8').trim()
      expect(exported).toBe(`PLAYWRIGHT_BROWSERS_PATH=${browsers}`)
      const browserPath = exported.slice('PLAYWRIGHT_BROWSERS_PATH='.length)
      const executableForHome = (home: string): string => {
        const child = Bun.spawnSync([
          process.execPath,
          '-e',
          'import { chromium } from "playwright"; process.stdout.write(chromium.executablePath())',
        ], {
          cwd: projectRoot,
          env: {
            ...process.env,
            HOME: home,
            QUIRKY_HOME: home,
            PLAYWRIGHT_BROWSERS_PATH: browserPath,
            BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        expect(child.exitCode).toBe(0)
        return child.stdout.toString().trim()
      }
      const [first, second] = homes.map(executableForHome)
      expect(first).not.toBe('')
      expect(first).toBe(second)
      expect(first.startsWith(`${browsers}/`)).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('Linux test coverage routing', () => {
  const root = join(import.meta.dir, '../..')
  const retained = [
    'plugins/quirky.terminal/test/artifacts-api.test.ts',
    'plugins/quirky.terminal/test/artifacts.test.ts',
    'plugins/quirky.terminal/test/emulator.test.ts',
    'packages/cli/test/open.e2e.test.ts',
    'apps/desktop/test/allow-label-hosts.test.ts',
    'scripts/parity/cli-files.test.ts',
  ]
  const movable = [
    'plugins/quirky.terminal/test/e2e.test.ts',
    'plugins/quirky.terminal/test/e2e-ui/features-pane.test.ts',
    'plugins/quirky.editor/test/markdown.test.ts',
    'plugins/quirky.browser/test/automation.test.ts',
    'plugins/quirky.browser/test/wait-navigation.test.ts',
    'plugins/quirky.browser/test/pane.test.ts',
    'plugins/quirky.browser/test/design-runtime.test.ts',
    'plugins/quirky.browser/test/extras-api.test.ts',
    'plugins/quirky.browser/test/extras-automation.test.ts',
    'plugins/quirky.browser/test/extras-cli.test.ts',
    'plugins/quirky.browser/test/import.test.ts',
    'plugins/quirky.browser/test/pane-address.test.ts',
    'plugins/quirky.browser/test/pane-profile-switch.test.ts',
    'plugins/quirky.browser/test/pane-watch-state.test.ts',
    'plugins/quirky.mobile/test/browser-watch.test.ts',
    'apps/mobile/test/session-tabs.test.tsx',
    'plugins/quirky.mobile/test/page-bridge-lifecycle.test.ts',
    'scripts/parity/browser.test.ts',
    'scripts/parity/browser-pane.test.ts',
  ]
  const refusals = [
    'scripts/linux-platform-refusals.test.ts',
    'plugins/quirky.vault/test/actions.test.ts',
    'plugins/quirky.vault/test/cli.test.ts',
    'plugins/quirky.vault/test/window-parity.test.ts',
    'plugins/quirky.worktree/test/vm-environments.test.ts',
  ]

  test('keeps only actual native-platform acceptance and the CLI-files ownership exception on macOS', () => {
    expect([...macosOnly(join(root, 'scripts/test-on-macos.txt'))].sort()).toEqual([...retained].sort())
  })

  test('discovers every movable acceptance and refusal file without a platform or CI exclusion', () => {
    const discovered = new Set(discover(root, []))
    const macos = macosOnly(join(root, 'scripts/test-on-macos.txt'))
    const excluded = macosOnly(join(root, 'scripts/test-not-on-ci.txt'))
    for (const file of [...movable, ...refusals]) {
      expect(discovered.has(file)).toBe(true)
      expect(macos.has(file)).toBe(false)
      expect(excluded.has(file)).toBe(false)
    }
  })
})

describe('token scope', () => {
  test('no write permission on plan, linux or macos', () => {
    for (const name of ['plan', 'linux', 'macos', 'speed']) {
      expect(Object.values(effectivePermissions(name)).filter(level => level === 'write')).toEqual([])
    }
  })

  test('plan adds only actions: read', () => {
    expect(effectivePermissions('plan')).toEqual({ contents: 'read', actions: 'read' })
  })

  test('only the Tests job writes, and only to pull requests and issues', () => {
    const writes = Object.entries(effectivePermissions('tests')).filter(([, level]) => level === 'write')
    expect(writes.map(([scope]) => scope).sort()).toEqual(['issues', 'pull-requests'])
  })

  test('macos allows both CLI-files attempts while linux keeps its 30 minute limit and no fail-fast', () => {
    expect(jobs.macos!['timeout-minutes']).toBe(60)
    expect(jobs.linux!['timeout-minutes']).toBe(30)
    const linux = jobs.linux as Job & { strategy: { 'fail-fast': boolean; matrix: { shard: string } } }
    expect(linux.strategy['fail-fast']).toBe(false)
    expect(linux.strategy.matrix.shard).toBe('${{ fromJSON(needs.plan.outputs.linux_shards) }}')
  })

  test('macos encloses both CLI-files attempts and reserves setup, result publication and finalization', () => {
    const uploads = resultUploadSteps('macos')
    expect(uploads.map(step => step.id)).toEqual(['upload_results_1', 'upload_results_2', 'upload_results_3'])
    for (const step of uploads) expect(step['timeout-minutes']).toBe(5)
    const uploadsMs = uploads.reduce((sum, step) => sum + step['timeout-minutes']! * 60_000, 0)
    const requiredMs = 600_000 + 2 * CLI_FILES_LIMITS.fileMs + uploadsMs + 120_000
    expect(requiredMs).toBe(3_300_000)
    expect(jobs.macos!['timeout-minutes']! * 60_000).toBeGreaterThanOrEqual(requiredMs)
  })

  test('no run script interpolates anything but the jobs-ok expression', () => {
    for (const script of allRuns) {
      const expressions = script.match(/\$\{\{[^}]*\}\}/g) ?? []
      expect(expressions.filter(expression => expression !== JOBS_OK)).toEqual([])
    }
  })
})

describe('the Tests job', () => {
  test('never installs dependencies', () => {
    for (const script of runs('tests')) expect(script).not.toMatch(/\bbun\s+(install|i)\b/)
  })

  test('passes the jobs-ok expression to verdict and keeps its exit code for last', () => {
    const verdict = steps('tests').find(step => step.run?.includes('cli.ts verdict'))!
    expect(verdict.env?.JOBS_OK).toBe(JOBS_OK)
    expect(verdict.run).toContain('--jobs-ok "$JOBS_OK" --speed speed')
    expect((verdict as Step & { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true)

    const verdictIndex = steps('tests').indexOf(verdict)
    const failStep = steps('tests').findIndex(step => String(step.if).includes('outcome'))
    expect(failStep).toBeGreaterThan(verdictIndex)
    expect(failStep).toBe(steps('tests').length - 1)
    expect(steps('tests')[failStep]!.run).toContain('exit 1')
  })

  test('tolerates a missing plan or results artifact', () => {
    const downloads = steps('tests').filter(step => step.uses?.startsWith('actions/download-artifact@'))
    expect(downloads.length).toBeGreaterThanOrEqual(2)
    for (const download of downloads) expect(download.with).toHaveProperty('pattern')
    expect(runs('tests').join('\n')).toContain('mkdir -p plan')
  })

  test('publishes the baseline by sha, 14 days, on push only', () => {
    const upload = steps('tests').find(step => step.uses?.startsWith('actions/upload-artifact@') && String(step.with?.name).startsWith('test-baseline-'))!
    expect(upload.with!.name).toBe('test-baseline-${{ github.sha }}')
    expect(upload.with!['retention-days']).toBe(14)
    expect(String(upload.if)).toContain("github.event_name == 'push'")
    expect(String(upload.if)).toContain("hashFiles('out/baseline.json') != ''")
  })

  test('files and closes issues from the baseline on push only', () => {
    const open = steps('tests').find(step => step.run?.includes('cli.ts issues') && step.run.includes('--only open'))!
    const close = steps('tests').find(step => step.run?.includes('cli.ts issues') && step.run.includes('--only close'))!
    expect(open.run).toContain('--plan plan --baseline out/baseline.json')
    expect(close.run).toContain('--plan plan --baseline out/baseline.json')
    for (const step of [open, close]) {
      expect(String(step.if)).toContain("github.event_name == 'push'")
      expect(String(step.if)).toContain("hashFiles('out/baseline.json') != ''")
    }
  })

  test('opens issues, then publishes the baseline, then closes issues, with the fail step last', () => {
    const list = steps('tests')
    const open = list.findIndex(step => step.run?.includes('cli.ts issues') && step.run.includes('--only open'))
    const upload = list.findIndex(step => String(step.with?.name).startsWith('test-baseline-'))
    const close = list.findIndex(step => step.run?.includes('cli.ts issues') && step.run.includes('--only close'))
    expect(open).toBeGreaterThanOrEqual(0)
    expect(upload).toBeGreaterThan(open)
    expect(close).toBeGreaterThan(upload)
    expect(list.findIndex(step => String(step.if).includes('outcome'))).toBe(list.length - 1)
    expect(list.length - 1).toBeGreaterThan(close)

    for (const index of [open, upload, close]) {
      expect(String(list[index]!.if)).not.toMatch(/\b(always|failure|cancelled|success)\(\)/)
      expect((list[index] as Step & { 'continue-on-error'?: boolean })['continue-on-error']).toBeUndefined()
    }
    expect(list.filter(step => step.run?.includes('cli.ts issues'))).toHaveLength(2)
  })

  test('workflow_dispatch never publishes a baseline, files issues or closes them', () => {
    const gated = steps('tests').filter(
      step => String(step.with?.name).startsWith('test-baseline-') || step.run?.includes('cli.ts issues'),
    )
    expect(gated).toHaveLength(3)
    for (const step of gated) expect(String(step.if)).not.toContain('workflow_dispatch')
  })

  test('reports on pull requests through the step summary and one marked comment', () => {
    const script = runs('tests').join('\n')
    expect(script).toContain('$GITHUB_STEP_SUMMARY')
    expect(script).toContain('<!-- test-baseline-verdict -->')
    const comment = steps('tests').find(step => step.run?.includes('gh api'))!
    expect(String(comment.if)).toContain("github.event_name == 'pull_request'")
  })
})

describe('artifacts', () => {
  const uploads = Object.keys(jobs).flatMap(name =>
    steps(name).filter(step => step.uses?.startsWith('actions/upload-artifact@')).map(step => ({ job: name, step })),
  )

  test('each job writes the artifact the table names', () => {
    const named = (job: string) => uploads.filter(upload => upload.job === job).map(upload => String(upload.step.with?.name))
    expect(named('plan')).toEqual(['test-plan'])
    expect(named('linux')).toEqual(Array(3).fill('test-results-linux-${{ matrix.shard }}'))
    expect(named('macos')).toEqual(Array(3).fill('test-results-macos'))
    expect(named('tests')).toEqual(['test-baseline-${{ github.sha }}'])
    expect(named('speed')).toEqual(['speed-run', 'speed-baseline-${{ github.sha }}'])
  })

  test('everything but the baseline keeps one day', () => {
    for (const { step } of uploads) {
      const retained = /^(test-baseline-|speed-)/.test(String(step.with?.name))
      expect(step.with?.['retention-days']).toBe(retained ? 14 : 1)
    }
  })
})

describe('result upload retry ladder', () => {
  const resultJobs = [
    { name: 'linux', artifact: 'test-results-linux-${{ matrix.shard }}' },
    { name: 'macos', artifact: 'test-results-macos' },
  ] as const
  const expectedIds = ['upload_results_1', 'upload_results_2', 'upload_results_3']
  const expectedConditions = [
    "!cancelled() && hashFiles('results/*.json') != ''",
    "!cancelled() && steps.upload_results_1.outcome == 'failure'",
    "!cancelled() && steps.upload_results_2.outcome == 'failure'",
  ]

  test('keeps the three parsed uploads bounded and identical per platform', () => {
    for (const { name, artifact } of resultJobs) {
      const ladder = resultUploadSteps(name)
      expect(ladder.map(step => step.id)).toEqual(expectedIds)
      expect(ladder.map(step => step.uses)).toEqual(Array(3).fill('actions/upload-artifact@v4'))
      expect(ladder.map(step => norm(step.if))).toEqual(expectedConditions)
      expect(ladder.map(step => step['timeout-minutes'])).toEqual([5, 5, 5])
      expect(ladder.map(step => step['continue-on-error'])).toEqual([true, true, undefined])
      expect(ladder.map(step => step.with?.name)).toEqual(Array(3).fill(artifact))
      expect(ladder.map(step => step.with?.path)).toEqual(Array(3).fill('results/'))
      expect(ladder.map(step => step.with?.['retention-days'])).toEqual([1, 1, 1])
      expect(ladder.map(step => step.with?.['if-no-files-found'])).toEqual(Array(3).fill('error'))
      expect(ladder.map(step => step.with?.overwrite)).toEqual([undefined, true, true])
      const shard = steps(name).find(step => step.run?.includes('cli.ts run-shard'))!
      expect(steps(name).indexOf(ladder[0]!)).toBeGreaterThan(steps(name).indexOf(shard))
    }

    const downloads = steps('tests').filter(step => step.uses?.startsWith('actions/download-artifact@'))
    expect(downloads.some(step => step.with?.pattern === 'test-results-*')).toBe(true)
  })

  test('retries a partial first upload using outcome and skips the third after recovery', () => {
    for (const { name, artifact } of resultJobs) {
      const result = simulateResultUploads(name, {
        resultsPresent: true,
        failedAttempts: new Set([1]),
        partialArtifactOnFailure: true,
      })
      expect(result.attempts.map(call => call.id)).toEqual(expectedIds.slice(0, 2))
      expect(result.attempts.map(call => call.outcome)).toEqual(['failure', 'success'])
      expect(result.attempts[0]?.conclusion).toBe('success')
      expect(result.attempts.map(call => call.name)).toEqual([artifact, artifact])
      expect(result.attempts.map(call => call.path)).toEqual(['results/', 'results/'])
      expect(result.attempts[1]?.overwrite).toBe(true)
      expect(result.artifacts.get(artifact)).toEqual({ path: 'results/', attempt: 2, partial: false })
      expect(result.jobFailed).toBe(false)
    }
  })

  test('recovers on the third upload after two transient failures', () => {
    for (const { name, artifact } of resultJobs) {
      const result = simulateResultUploads(name, {
        resultsPresent: true,
        failedAttempts: new Set([1, 2]),
        partialArtifactOnFailure: true,
      })
      expect(result.attempts.map(call => call.id)).toEqual(expectedIds)
      expect(result.attempts.map(call => call.outcome)).toEqual(['failure', 'failure', 'success'])
      expect(result.attempts.map(call => call.conclusion)).toEqual(['success', 'success', 'success'])
      expect(result.artifacts.get(artifact)).toEqual({ path: 'results/', attempt: 3, partial: false })
      expect(result.jobFailed).toBe(false)
    }
  })

  test('runs only the first upload when it succeeds', () => {
    for (const { name } of resultJobs) {
      const result = simulateResultUploads(name, { resultsPresent: true })
      expect(result.attempts.map(call => call.id)).toEqual(['upload_results_1'])
      expect(result.attempts[0]?.outcome).toBe('success')
      expect(result.jobFailed).toBe(false)
    }
  })

  test('fails hard when all three uploads fail', () => {
    for (const { name } of resultJobs) {
      const result = simulateResultUploads(name, {
        resultsPresent: true,
        failedAttempts: new Set([1, 2, 3]),
        partialArtifactOnFailure: true,
      })
      expect(result.attempts.map(call => call.id)).toEqual(expectedIds)
      expect(result.attempts.map(call => call.outcome)).toEqual(['failure', 'failure', 'failure'])
      expect(result.attempts.map(call => call.conclusion)).toEqual(['success', 'success', 'failure'])
      expect(result.jobFailed).toBe(true)
    }
  })

  test('cancellation prevents an upload ladder from starting or continuing', () => {
    for (const { name } of resultJobs) {
      const alreadyCancelled = simulateResultUploads(name, { resultsPresent: true, cancelled: true })
      expect(alreadyCancelled.attempts).toEqual([])

      const cancelledAfterFirst = simulateResultUploads(name, {
        resultsPresent: true,
        failedAttempts: new Set([1]),
        partialArtifactOnFailure: true,
        cancelAfterAttempt: 1,
      })
      expect(cancelledAfterFirst.attempts.map(call => call.id)).toEqual(['upload_results_1'])
    }
  })

  test('uploads result JSON after a shard failure without clearing the job failure', () => {
    for (const { name } of resultJobs) {
      const result = simulateResultUploads(name, { resultsPresent: true, shardFailed: true })
      expect(result.attempts.map(call => call.id)).toEqual(['upload_results_1'])
      expect(result.attempts[0]?.outcome).toBe('success')
      expect(result.jobFailed).toBe(true)
    }
  })

  test('skips uploads with no result JSON and keeps the existing incomplete-run checks', () => {
    for (const { name } of resultJobs) {
      const result = simulateResultUploads(name, { resultsPresent: false, shardFailed: true })
      expect(result.attempts).toEqual([])
      expect(result.jobFailed).toBe(true)
    }
    expect(steps('tests').some(step => step.with?.pattern === 'test-results-*')).toBe(true)
    expect(steps('tests').find(step => step.run?.includes('cli.ts verdict'))?.if).toBe('always()')
    expect(String(steps('tests').at(-1)?.if)).toContain('outcome')
  })
})

describe('speed evidence', () => {
  test('runs the guarded timer experiment before both browser measurements with shared evidence outside smoke output', () => {
    const speed = steps('speed')
    const isolate = speed.find(step => step.name === 'Isolate speed checks')!
    const configure = speed.find(step => step.name === 'Configure runner latency experiment')
    expect(configure).toBeDefined()
    expect(isolate.run).toContain('echo "QUIRKY_SPEED_RUNNER_LATENCY=$RUNNER_TEMP/speed-runner-latency.json" >> "$GITHUB_ENV"')
    expect(configure!.run).toBe('bun scripts/speed/runner-latency.ts --configure --out "$QUIRKY_SPEED_RUNNER_LATENCY"')
    expect(speed.indexOf(isolate)).toBeLessThan(speed.indexOf(configure!))
    for (const name of ['Check real-daemon smoke', 'Measure speed']) {
      expect(speed.indexOf(configure!)).toBeLessThan(speed.findIndex(step => step.name === name))
    }
    expect(allRuns.filter(run => run.includes('runner-latency.ts --configure'))).toHaveLength(1)
    expect(configure!.run).not.toContain('sudo')
    expect(configure!.run).not.toContain('defaults write')
  })

  test('compares a prepared base on the same runner after the solo benchmark', () => {
    expect(jobs.speed).toMatchObject({ 'runs-on': 'macos-15', 'timeout-minutes': 60 })
    expect(jobs.speed!.if).toBeUndefined()
    const headInstall = steps('speed').find(step => step.run === 'bun install --frozen-lockfile')
    expect(headInstall).toBeDefined()
    expect(steps('speed').indexOf(headInstall!)).toBeLessThan(steps('speed').findIndex(step => step.name === 'Check real-daemon smoke'))
    const prepare = steps('speed').find(step => step.name === 'Prepare speed base')!
    expect((prepare as Step & { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true)
    expect(prepare.env).toEqual({
      EVENT_NAME: '${{ github.event_name }}',
      HEAD_SHA: '${{ github.event.pull_request.head.sha || github.sha }}',
    })
    expect(prepare.run).toContain('if [ "$EVENT_NAME" = "pull_request" ]')
    expect(prepare.run).toContain('git merge-base "$HEAD_SHA" origin/main')
    expect(prepare.run).toContain('git rev-parse "$HEAD_SHA^"')
    expect(prepare.run).toContain('git worktree add --detach "$RUNNER_TEMP/speed-base" "$BASE_SHA"')
    expect(prepare.run).toContain('(cd "$RUNNER_TEMP/speed-base" && bun install --frozen-lockfile)')
    expect(prepare.run!.indexOf('git worktree add')).toBeLessThan(prepare.run!.indexOf('bun install --frozen-lockfile'))
    expect(prepare.run!.indexOf('bun install --frozen-lockfile')).toBeLessThan(prepare.run!.indexOf('>> "$GITHUB_ENV"'))

    const measure = steps('speed').find(step => step.name === 'Measure speed')!
    expect(measure.run).toContain('measure_args=(--out speed --samples 20)')
    expect(measure.run).toContain('if [ -n "${SPEED_BASE_ROOT:-}" ]')
    expect(measure.run).toContain('measure_args+=(--base-root "$SPEED_BASE_ROOT" --base-basis "$SPEED_BASE_BASIS")')
    expect(measure.run).toContain('bun scripts/speed.ts "${measure_args[@]}"')
    expect(steps('speed').indexOf(prepare)).toBeLessThan(steps('speed').indexOf(measure))

    const commands = runs('speed').join('\n')
    expect(commands).toContain('QUIRKY_SPEED_IMAGE_VERSION=')
    expect(commands).toContain('bun node_modules/playwright/cli.js install chromium')
    expect(commands).toContain('bun test scripts/speed/run.e2e.test.ts')
    expect(commands.indexOf('bun test scripts/speed/run.e2e.test.ts')).toBeLessThan(commands.indexOf('bun scripts/speed.ts'))
    expect(commands).not.toContain('run-shard')
    expect(effectivePermissions('speed')).toEqual({ contents: 'read' })
  })

  test('compares local paired evidence without a GitHub token', () => {
    const compare = steps('speed').find(step => step.name === 'Compare speed')!
    expect(compare.run).toBe('bun scripts/speed/ci.ts compare --current speed/report.json --pair speed/pair.json --out speed --head "$HEAD_SHA"')
    expect(compare.env).toEqual({ HEAD_SHA: '${{ github.event.pull_request.head.sha || github.sha }}' })
    expect(compare.env).not.toHaveProperty('GH_TOKEN')
  })

  test('always retains partial evidence and publishes only qualified main evidence', () => {
    const evidence = steps('speed').find(step => step.with?.name === 'speed-run')!
    expect(evidence.if).toBe('always()')
    const baseline = steps('speed').find(step => String(step.with?.name).startsWith('speed-baseline-'))!
    expect(String(baseline.if)).toContain("github.event_name == 'push'")
    expect(String(baseline.if)).toContain("steps.qualify.outputs.qualified == 'true'")
    expect(baseline.with?.path).toBe('speed/report.json')
    const qualify = steps('speed').find(step => step.id === 'qualify')!
    expect(qualify.run).toContain('validateReport')
    expect(qualify.run).toContain('parseArtifactJson')
    expect(qualify.run).not.toContain('.json()')
    expect(qualify.run).toContain('qualified')
  })

  test('keeps speed downloads advisory and outside unit results, with main summaries', () => {
    const download = steps('tests').find(step => step.with?.pattern === 'speed-run')!
    expect(download.with?.path).toBe('speed')
    expect(download.if).toBe('always()')
    expect(steps('tests').find(step => step.id === 'verdict')?.if).toBe('always()')
    expect(steps('tests').find(step => step.name === 'Ensure a comment exists')?.run).toContain('### Speed')
    expect((download as Step & { 'continue-on-error'?: boolean })['continue-on-error']).toBe(true)
    const summary = steps('tests').find(step => step.run?.includes('cat out/comment.md'))!
    expect(summary.if).toBe('always()')
    expect(steps('speed').some(step => step.run?.includes('scripts/speed/ci.ts compare'))).toBe(true)
    expect(allRuns.filter(script => script.includes('gh api --method POST'))).toHaveLength(1)
  })
})

describe('bun flags the design rejects', () => {
  test('no run step uses --parallel, --isolate, --shard, --timings or --changed', () => {
    for (const raw of allRuns) {
      // run-shard's own --shard picks a plan shard; Bun's flag of that name is what's banned
      const script = raw.replace(/(cli\.ts run-shard[^\n]*?)--shard\b/g, '$1')
      for (const flag of ['--parallel', '--isolate', '--shard', '--timings', '--changed']) {
        expect(script).not.toMatch(new RegExp(`${flag}(?![\\w-])`))
      }
    }
  })
})
