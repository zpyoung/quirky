import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discover, macosOnly, runFiles, runSuite, slowestFirst, usableSlots } from './suite'

let dir: string
let previousQuirkyHome: string | undefined
let previousTestProfile: string | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'suite-'))
  mkdirSync(join(dir, 'pkg'))
  previousQuirkyHome = process.env.QUIRKY_HOME
  previousTestProfile = process.env.QUIRKY_TEST_PROFILE
  const home = join(dir, 'home')
  process.env.QUIRKY_HOME = home
  mkdirSync(home)
  delete process.env.QUIRKY_TEST_PROFILE
})

afterEach(() => {
  if (previousQuirkyHome === undefined) delete process.env.QUIRKY_HOME
  else process.env.QUIRKY_HOME = previousQuirkyHome
  if (previousTestProfile === undefined) delete process.env.QUIRKY_TEST_PROFILE
  else process.env.QUIRKY_TEST_PROFILE = previousTestProfile
  rmSync(dir, { recursive: true, force: true })
})

const write = (name: string, body: string) =>
  writeFileSync(join(dir, 'pkg', name), `import { expect, test } from 'bun:test'\nimport { existsSync, writeFileSync } from 'node:fs'\n${body}\n`)

const passing = (name: string) => write(name, `test('ok', () => expect(1).toBe(1))`)
const broken = (name: string) => write(name, `test('broken', () => expect(1).toBe(2))`)
// fails the first time it runs and passes after, the way a load flake does
const flaky = (name: string) =>
  write(name, `test('flaky', () => {\n  const seen = existsSync(import.meta.path + '.ran')\n  writeFileSync(import.meta.path + '.ran', '')\n  expect(seen).toBe(true)\n})`)

const captureOutput = async <T>(run: () => Promise<T>) => {
  const chunks: string[] = []
  const write = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    return true
  }) as typeof process.stdout.write
  try {
    return { result: await run(), output: chunks.join('') }
  } finally {
    process.stdout.write = write
  }
}

test('a green suite passes without a rerun', async () => {
  passing('a.test.ts')
  expect(await runSuite(dir, ['pkg'])).toEqual({ ok: true, flaky: [] })
})

test('a file that fails in the suite and passes alone is reported as flaky', async () => {
  passing('a.test.ts')
  flaky('b.test.ts')
  expect(await runSuite(dir, ['pkg'])).toEqual({ ok: true, flaky: ['pkg/b.test.ts'] })
})

test('a file that fails again alone fails the run', async () => {
  flaky('a.test.ts')
  broken('b.test.ts')
  expect(await runSuite(dir, ['pkg'])).toEqual({ ok: false, flaky: [] })
})

test('a file that fails to load fails the run, since the report cannot name it', async () => {
  flaky('a.test.ts')
  write('b.test.ts', `throw new Error('load')`)
  expect(await runSuite(dir, ['pkg'])).toEqual({ ok: false, flaky: [] })
})

test('more failing files than the limit fail the run without a rerun', async () => {
  flaky('a.test.ts')
  flaky('b.test.ts')
  expect(await runSuite(dir, ['pkg'], 1)).toEqual({ ok: false, flaky: [] })
})

test('runFiles runs each file in its own process and reports one that passes alone as flaky', async () => {
  passing('a.test.ts')
  flaky('b.test.ts')
  expect(await runFiles(dir, ['pkg/a.test.ts', 'pkg/b.test.ts'], [], 2)).toEqual({ ok: true, flaky: ['pkg/b.test.ts'] })
}, 20_000)

// This fixture includes guarded child startup, an isolated retry and awaited process-tree cleanup.
test('runFiles fails on a file that fails again, including one that fails to load', async () => {
  passing('a.test.ts')
  write('b.test.ts', `throw new Error('load')`)
  expect(await runFiles(dir, ['pkg/a.test.ts', 'pkg/b.test.ts'], [], 2)).toEqual({ ok: false, flaky: [] })
}, 20_000)

test('runFiles with more failing files than the limit fails without a rerun', async () => {
  flaky('a.test.ts')
  flaky('b.test.ts')
  expect(await runFiles(dir, ['pkg/a.test.ts', 'pkg/b.test.ts'], [], 2, 1)).toEqual({ ok: false, flaky: [] })
})

test('runFiles profiles each file attempt only when enabled', async () => {
  write('profile-pass.test.ts', `test('does deterministic CPU work', () => {
  let sum = 0
  for (let i = 0; i < 10_000_000; i++) sum += i
  expect(sum).toBe(49_999_995_000_000)
})`)
  write('profile-retry.test.ts', `test('does CPU work and passes on retry', () => {
  let sum = 0
  for (let i = 0; i < 10_000_000; i++) sum += i
  const seen = existsSync(import.meta.path + '.ran')
  writeFileSync(import.meta.path + '.ran', '')
  expect(sum).toBe(49_999_995_000_000)
  expect(seen).toBe(true)
})`)
  process.env.QUIRKY_TEST_PROFILE = '1'

  const { result, output } = await captureOutput(() =>
    runFiles(dir, ['pkg/profile-pass.test.ts', 'pkg/profile-retry.test.ts'], [], 1))

  expect(result).toEqual({ ok: true, flaky: ['pkg/profile-retry.test.ts'] })
  const rows = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('suite-file '))
    .map((line) => JSON.parse(line.slice('suite-file '.length)) as {
      file: string
      wallMs: number
      userCpuMs: number
      systemCpuMs: number
      exitCode: number
    })
  expect(rows.map((row) => [row.file.split('/').at(-1), row.exitCode])).toEqual([
    ['profile-pass.test.ts', 0],
    ['profile-retry.test.ts', 1],
    ['profile-retry.test.ts', 0],
  ])
  for (const row of rows) {
    expect(row.file.startsWith('/')).toBe(false)
    expect(Number.isFinite(row.wallMs)).toBe(true)
    expect(row.wallMs).toBeGreaterThan(0)
    expect(row.wallMs).toBeLessThan(60_000)
    expect(Number.isFinite(row.userCpuMs)).toBe(true)
    expect(row.userCpuMs).toBeGreaterThanOrEqual(0)
    expect(row.userCpuMs).toBeLessThan(60_000)
    expect(Number.isFinite(row.systemCpuMs)).toBe(true)
    expect(row.systemCpuMs).toBeGreaterThanOrEqual(0)
    expect(row.userCpuMs + row.systemCpuMs).toBeGreaterThan(0)
    expect(row.systemCpuMs).toBeLessThan(60_000)
  }
}, 20_000)

test('runFiles emits no profile rows when profiling is disabled', async () => {
  passing('a.test.ts')
  const { result, output } = await captureOutput(() => runFiles(dir, ['pkg/a.test.ts'], [], 1))
  expect(result).toEqual({ ok: true, flaky: [] })
  expect(output).not.toContain('suite-file ')
})

test('the suite CLI profiles each selected file in local mode', async () => {
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
  passing('cli-a.test.ts')
  write('cli-b.test.ts', `test('does deterministic CPU work', () => {
  let sum = 0
  for (let i = 0; i < 1_000_000; i++) sum += i
  expect(sum).toBe(499_999_500_000)
})`)
  const child = Bun.spawn(['bun', join(import.meta.dir, 'suite.ts'), 'pkg/cli-a.test.ts', 'pkg/cli-b.test.ts', '--timeout=5000'], {
    cwd: dir,
    env: {
      ...process.env,
      QUIRKY_HOME: join(dir, 'home'),
      QUIRKY_TEST_LOCAL: '1',
      QUIRKY_TEST_PROFILE: '1',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, , exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(exitCode).toBe(0)
  const rows = stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith('suite-file '))
    .map((line) => JSON.parse(line.slice('suite-file '.length)) as { file: string; exitCode: number })
  expect(rows.map((row) => [row.file.split('/').at(-1), row.exitCode])).toEqual([
    ['cli-a.test.ts', 0],
    ['cli-b.test.ts', 0],
  ])
}, 20_000)

test('discover lists the tracked and untracked test files under the given paths, as bun would', () => {
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
  passing('a.test.ts')
  write('b.spec.tsx', '')
  write('helper.ts', '')
  mkdirSync(join(dir, 'other'))
  writeFileSync(join(dir, 'other/c.test.ts'), '')
  writeFileSync(join(dir, '.gitignore'), 'ignored/\n')
  mkdirSync(join(dir, 'ignored'))
  writeFileSync(join(dir, 'ignored/d.test.ts'), '')
  expect(discover(dir, ['pkg', '--timeout=1'])).toEqual(['pkg/a.test.ts', 'pkg/b.spec.tsx'])
  expect(discover(dir, [])).toEqual(['other/c.test.ts', 'pkg/a.test.ts', 'pkg/b.spec.tsx'])
})

test('macosOnly reads the first word of each line and skips comments and blanks', () => {
  writeFileSync(join(dir, 'list.txt'), '# why\n\npkg/a.test.ts  needs zsh\npkg/b.test.ts\n')
  expect(macosOnly(join(dir, 'list.txt'))).toEqual(new Set(['pkg/a.test.ts', 'pkg/b.test.ts']))
  expect(macosOnly(join(dir, 'missing.txt'))).toEqual(new Set())
})

test('a completed test run stops detached subprocess trees left by a test', async () => {
  const pidFile = join(dir, 'leftover.pid')
  write('leftover.test.ts', `test('starts a detached worker', () => {
    const child = Bun.spawn(['sleep', '60'], { detached: true, stdout: 'ignore', stderr: 'ignore' })
    writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
    writeFileSync((process.env.QUIRKY_HOME ?? ${JSON.stringify(dir)}) + '/pty.pid', String(child.pid))
    expect(child.pid).toBeGreaterThan(0)
  })`)
  let pid: number | undefined
  try {
    const result = await runSuite(dir, ['pkg'])
    pid = Number(await Bun.file(pidFile).text())
    expect(result.ok).toBe(true)
    const deadline = Date.now() + 5000
    const alive = () => {
      try { process.kill(pid!, 0); return true } catch { return false }
    }
    // Native process exit is observed by the OS; fake timers cannot drive it.
    while (alive() && Date.now() < deadline) await Bun.sleep(25)
    expect(alive()).toBe(false)
  } finally {
    pid ??= Number(await Bun.file(pidFile).text().catch(() => '0'))
    if (pid) {
      try { process.kill(-pid, 'SIGKILL') } catch {}
      try { process.kill(pid, 'SIGKILL') } catch {}
    }
  }
}, 15_000)

test('usableSlots leaves all but one slot to a land while one runs', () => {
  expect(usableSlots(6, false, false)).toBe(6)
  expect(usableSlots(6, false, true)).toBe(1)
  expect(usableSlots(6, true, true)).toBe(6)
  expect(usableSlots(1, false, true)).toBe(1)
})

test('slowestFirst orders by the last logged time, with unlogged files first', () => {
  const log = join(dir, 'durations.log')
  writeFileSync(log, 'a.test.ts 100\nb.test.ts 900\na.test.ts 2000\n')
  expect(slowestFirst(['a.test.ts', 'b.test.ts', 'new.test.ts'], log)).toEqual(['new.test.ts', 'a.test.ts', 'b.test.ts'])
  expect(slowestFirst(['b.test.ts', 'a.test.ts'], join(dir, 'missing.log'))).toEqual(['b.test.ts', 'a.test.ts'])
})
