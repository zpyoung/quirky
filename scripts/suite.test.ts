import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chooseHost, discover, hostLoad, macosOnly, runFiles, runSuite, slowestFirst, usableSlots, type HostState } from './suite'
import { createProcessScope, type ProcessScope } from './test-support/process-scope'

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
}, 30_000)

test('a file that fails in the suite and passes alone is reported as flaky', async () => {
  passing('a.test.ts')
  flaky('b.test.ts')
  expect(await runSuite(dir, ['pkg'])).toEqual({ ok: true, flaky: ['pkg/b.test.ts'] })
}, 30_000)

test('a file that fails again alone fails the run', async () => {
  flaky('a.test.ts')
  broken('b.test.ts')
  expect(await runSuite(dir, ['pkg'])).toEqual({ ok: false, flaky: [] })
}, 30_000)

test('a file that fails to load fails the run, since the report cannot name it', async () => {
  flaky('a.test.ts')
  write('b.test.ts', `throw new Error('load')`)
  expect(await runSuite(dir, ['pkg'])).toEqual({ ok: false, flaky: [] })
}, 30_000)

test('more failing files than the limit fail the run without a rerun', async () => {
  flaky('a.test.ts')
  flaky('b.test.ts')
  expect(await runSuite(dir, ['pkg'], 1)).toEqual({ ok: false, flaky: [] })
}, 30_000)

test('runFiles runs each file in its own process and reports one that passes alone as flaky', async () => {
  passing('a.test.ts')
  flaky('b.test.ts')
  expect(await runFiles(dir, ['pkg/a.test.ts', 'pkg/b.test.ts'], [], 2)).toEqual({ ok: true, flaky: ['pkg/b.test.ts'] })
}, 30_000)

// This fixture includes guarded child startup, an isolated retry and awaited process-tree cleanup.
test('runFiles fails on a file that fails again, including one that fails to load', async () => {
  passing('a.test.ts')
  write('b.test.ts', `throw new Error('load')`)
  expect(await runFiles(dir, ['pkg/a.test.ts', 'pkg/b.test.ts'], [], 2)).toEqual({ ok: false, flaky: [] })
}, 30_000)

test('runFiles with more failing files than the limit fails without a rerun', async () => {
  flaky('a.test.ts')
  flaky('b.test.ts')
  expect(await runFiles(dir, ['pkg/a.test.ts', 'pkg/b.test.ts'], [], 2, 1)).toEqual({ ok: false, flaky: [] })
}, 30_000)

test('actual bun test processes run unprofiled with isolated homes and clean them up', async () => {
  const report = join(dir, 'home.json')
  const parentHome = process.env.HOME ?? null
  const parentQuirkyHome = process.env.QUIRKY_HOME ?? null
  write('home.test.ts', `import { Database } from 'bun:sqlite'
test('has an isolated home', () => {
  const home = process.env.HOME
  const quirkyHome = process.env.QUIRKY_HOME
  expect(home).toBeTruthy()
  expect(quirkyHome).toBeTruthy()
  expect(home).not.toBe(${JSON.stringify(parentHome)})
  expect(quirkyHome).not.toBe(${JSON.stringify(parentQuirkyHome)})
  expect(home).not.toBe(quirkyHome)
  expect(existsSync(home!)).toBe(true)
  expect(existsSync(quirkyHome!)).toBe(true)
  const db = new Database(quirkyHome! + '/quirky.db', { readonly: true })
  try {
    const setting = db.query('SELECT value FROM setting_values WHERE id = ?').get('setting:quirky.agent-status/hooks') as { value: string } | null
    expect(setting && JSON.parse(setting.value)).toBe(false)
  } finally {
    db.close()
  }
  writeFileSync(${JSON.stringify(report)}, JSON.stringify({ home, quirkyHome }))
})`)

  expect(await runSuite(dir, ['pkg'])).toEqual({ ok: true, flaky: [] })
  const first = JSON.parse(readFileSync(report, 'utf8')) as { home: string; quirkyHome: string }
  expect(first.home).not.toBe(parentHome)
  expect(first.quirkyHome).not.toBe(parentQuirkyHome)
  expect(existsSync(first.home)).toBe(false)
  expect(existsSync(first.quirkyHome)).toBe(false)
  expect(process.env.HOME ?? null).toBe(parentHome)
  expect(process.env.QUIRKY_HOME ?? null).toBe(parentQuirkyHome)

  const { result: fileResult, output } = await captureOutput(() =>
    runFiles(dir, ['pkg/home.test.ts'], [], 1))
  expect(fileResult).toEqual({ ok: true, flaky: [] })
  expect(output).not.toContain('suite-file ')
  const second = JSON.parse(readFileSync(report, 'utf8')) as { home: string; quirkyHome: string }
  expect(second.home).not.toBe(first.home)
  expect(second.quirkyHome).not.toBe(first.quirkyHome)
  expect(existsSync(second.home)).toBe(false)
  expect(existsSync(second.quirkyHome)).toBe(false)
  expect(process.env.HOME ?? null).toBe(parentHome)
  expect(process.env.QUIRKY_HOME ?? null).toBe(parentQuirkyHome)
}, 30_000)

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
}, 30_000)

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

test('the CLI installs frozen workspace runtime dependencies before local tests', async () => {
  const fixture = mkdtempSync(join(tmpdir(), 'suite-cli-'))
  const home = join(fixture, 'home')
  let scope: ProcessScope | undefined
  try {
    mkdirSync(home)
    mkdirSync(join(fixture, 'pkg'))
    mkdirSync(join(fixture, 'packages', 'runtime'), { recursive: true })
    writeFileSync(join(fixture, 'package.json'), JSON.stringify({
      name: 'suite-cli-fixture',
      private: true,
      type: 'module',
      workspaces: ['packages/*'],
      dependencies: { 'suite-fixture-runtime': 'workspace:*' }
    }))
    writeFileSync(join(fixture, 'packages/runtime/package.json'), JSON.stringify({
      name: 'suite-fixture-runtime',
      version: '1.0.0',
      main: 'index.ts'
    }))
    writeFileSync(join(fixture, 'packages/runtime/index.ts'), `export const runtimeValue = 'installed'`)
    writeFileSync(join(fixture, 'bun.lock'), JSON.stringify({
      lockfileVersion: 2,
      configVersion: 1,
      workspaces: {
        '': {
          name: 'suite-cli-fixture',
          dependencies: { 'suite-fixture-runtime': 'workspace:*' }
        },
        'packages/runtime': {
          name: 'suite-fixture-runtime',
          version: '1.0.0'
        }
      },
      packages: {}
    }))
    writeFileSync(join(fixture, 'pkg/runtime.test.ts'), `
import { expect, test } from 'bun:test'
import { runtimeValue } from 'suite-fixture-runtime'

test('resolves a declared workspace runtime dependency', () => {
  expect(runtimeValue).toBe('installed')
})
`)

    scope = createProcessScope(join(fixture, 'quirky-home'))
    const cli = scope.spawn([process.execPath, join(import.meta.dir, 'suite.ts'), 'pkg'], {
      cwd: fixture,
      env: { ...process.env, HOME: home },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [code, stdout, stderr] = await Promise.all([
      cli.exited,
      new Response(cli.stdout).text(),
      new Response(cli.stderr).text()
    ])
    expect(code, `${stdout}${stderr}`).toBe(0)
  } finally {
    try {
      await scope?.cleanup()
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  }
}, 30_000)

const ovh = { host: 'quirkyci@ovh', jobs: 4, slots: 4 }
const gcloud = { host: 'quirkyci@gcloud', jobs: 8, slots: 16 }
const withOverflow = { ...ovh, overflow: gcloud }

/** Runs chooseHost against fixed host states and records which hosts it checked. */
async function choose(remote: typeof ovh & { overflow?: typeof gcloud }, states: Record<string, HostState>, land = false) {
  const checked: string[] = []
  const choice = await chooseHost(remote, land, async ({ host }) => {
    checked.push(host)
    return states[host]
  })
  return { choice, checked }
}

test('a run stays on the first host when it has room, without checking the overflow host', async () => {
  const { choice, checked } = await choose(withOverflow, { 'quirkyci@ovh': 'free', 'quirkyci@gcloud': 'down' })
  expect(choice).toEqual({ host: withOverflow })
  expect(checked).toEqual(['quirkyci@ovh'])
})

test('a run overflows when the first host is full and the overflow host is up', async () => {
  const { choice } = await choose(withOverflow, { 'quirkyci@ovh': 'full', 'quirkyci@gcloud': 'free' })
  expect(choice).toEqual({ host: gcloud, note: 'quirkyci@ovh is full, so this run uses quirkyci@gcloud' })
})

test('a run queues on the first host when it is full and the overflow host is down', async () => {
  const { choice } = await choose(withOverflow, { 'quirkyci@ovh': 'full', 'quirkyci@gcloud': 'down' })
  expect(choice).toEqual({ host: withOverflow, note: 'quirkyci@ovh is full and overflow is unavailable because quirkyci@gcloud is down, so this run queues' })
})

test('a run overflows when the first host is down', async () => {
  const { choice } = await choose(withOverflow, { 'quirkyci@ovh': 'down', 'quirkyci@gcloud': 'full' })
  expect(choice).toEqual({ host: gcloud, note: 'quirkyci@ovh is down, so this run uses quirkyci@gcloud' })
})

test('a run stops when every host is down, naming them and the way to run locally', async () => {
  const { choice } = await choose(withOverflow, { 'quirkyci@ovh': 'down', 'quirkyci@gcloud': 'down' })
  if (!('error' in choice)) throw new Error('expected an error')
  expect(choice.error).toContain('quirkyci@ovh')
  expect(choice.error).toContain('quirkyci@gcloud')
  expect(choice.error).toContain('QUIRKY_TEST_LOCAL=1')
})

test('a land stays on a full first host, where it already takes priority', async () => {
  const { choice, checked } = await choose(withOverflow, { 'quirkyci@ovh': 'full', 'quirkyci@gcloud': 'free' }, true)
  expect(choice).toEqual({ host: withOverflow })
  expect(checked).toEqual(['quirkyci@ovh'])
})

test('a land follows the overflow rules when the first host is down', async () => {
  const { choice } = await choose(withOverflow, { 'quirkyci@ovh': 'down', 'quirkyci@gcloud': 'free' }, true)
  expect(choice).toEqual({ host: gcloud, note: 'quirkyci@ovh is down, so this run uses quirkyci@gcloud' })
})

test('with one host configured, a full host queues the run and a down host stops it', async () => {
  expect((await choose(ovh, { 'quirkyci@ovh': 'full' })).choice).toEqual({ host: ovh, note: 'quirkyci@ovh is full, so this run queues' })
  const { choice } = await choose(ovh, { 'quirkyci@ovh': 'down' })
  if (!('error' in choice)) throw new Error('expected an error')
  expect(choice.error).toContain('quirkyci@ovh')
  expect(choice.error).toContain('QUIRKY_TEST_LOCAL=1')
})

test('hostLoad counts jobs of running workers against the slots, ignoring the shells that started them', () => {
  const worker = 'bun scripts/suite.ts --worker --jobs 4 --slots 4 --land 0 --timeout=5000'
  const shell = `bash -c export PATH="$HOME/.bun/bin:$PATH" && cd runs/1 && bun install --frozen-lockfile >/dev/null && ${worker}`
  expect(hostLoad(`COMMAND\nsshd: quirkyci\n${shell}\n`, 4)).toBe('free')
  expect(hostLoad(`COMMAND\n${shell}\n${worker}\nbun test ./a.test.ts\n`, 4)).toBe('full')
  expect(hostLoad(`${worker.replace('--jobs 4', '--jobs 2')}\n`, 16)).toBe('free')
  expect(hostLoad(`${worker.replace('--jobs 4', '--jobs 2')}\n${worker.replace('--jobs 4', '--jobs 2')}\n`, 4)).toBe('full')
})

/** Runs the suite CLI in a throwaway repo whose `ssh` is the given script and whose config names two hosts. */
async function cliWithFakeSsh(ssh: string, files: Record<string, string>, macosList = '') {
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir })
  mkdirSync(join(dir, 'scripts'), { recursive: true })
  mkdirSync(join(dir, 'bin'))
  mkdirSync(join(dir, '.git', 'build-loop'))
  writeFileSync(join(dir, '.git', 'build-loop', 'remote-tests.json'), JSON.stringify({ ...ovh, overflow: gcloud }))
  writeFileSync(join(dir, 'scripts', 'test-on-macos.txt'), macosList)
  writeFileSync(join(dir, 'bin', 'ssh'), `#!/bin/sh\n${ssh}\n`, { mode: 0o755 })
  for (const [file, body] of Object.entries(files)) writeFileSync(join(dir, file), body)
  const child = Bun.spawn(['bun', join(import.meta.dir, 'suite.ts'), 'pkg'], {
    cwd: dir,
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, QUIRKY_TEST_LOCAL: '' },
    stdout: 'pipe',
    stderr: 'pipe'
  })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { code, output: out + err }
}

const marksRun = (marker: string) => `import { test } from 'bun:test'\nimport { writeFileSync } from 'node:fs'\ntest('runs', () => writeFileSync(${JSON.stringify(marker)}, ''))\n`

test('the CLI starts no test when every host is down, including macOS-only files', async () => {
  const marker = join(dir, 'ran')
  const { code, output } = await cliWithFakeSsh('exit 255', { 'pkg/a.test.ts': marksRun(marker), 'pkg/mac.test.ts': marksRun(marker) }, 'pkg/mac.test.ts  needs macOS\n')
  expect(code).toBe(1)
  expect(output).toContain('quirkyci@ovh and quirkyci@gcloud are unreachable')
  expect(existsSync(marker)).toBe(false)
}, 30_000)

test('the CLI stops with an error when the chosen host fails after being picked', async () => {
  const marker = join(dir, 'ran')
  const ssh = `case "$*" in *'ps -eo args'*) exit 0 ;; *'rm -rf'*) exit 0 ;; *) exit 1 ;; esac`
  const { code, output } = await cliWithFakeSsh(ssh, { 'pkg/a.test.ts': marksRun(marker) })
  expect(code).toBe(1)
  expect(output).toContain("quirkyci@ovh couldn't finish the tests, so this run stops")
  expect(existsSync(marker)).toBe(false)
}, 30_000)

test('the CLI needs no host for a run of only macOS-only files', async () => {
  const marker = join(dir, 'ran')
  const { code } = await cliWithFakeSsh('exit 255', { 'pkg/mac.test.ts': marksRun(marker) }, 'pkg/mac.test.ts  needs macOS\n')
  expect(code).toBe(0)
  expect(existsSync(marker)).toBe(true)
}, 30_000)
