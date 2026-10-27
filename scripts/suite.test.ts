import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discover, macosOnly, runFiles, runSuite, slowestFirst, usableSlots } from './suite'
import { createProcessScope, type ProcessScope } from './test-support/process-scope'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'suite-'))
  mkdirSync(join(dir, 'pkg'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const write = (name: string, body: string) =>
  writeFileSync(join(dir, 'pkg', name), `import { expect, test } from 'bun:test'\nimport { existsSync, writeFileSync } from 'node:fs'\n${body}\n`)

const passing = (name: string) => write(name, `test('ok', () => expect(1).toBe(1))`)
const broken = (name: string) => write(name, `test('broken', () => expect(1).toBe(2))`)
// fails the first time it runs and passes after, the way a load flake does
const flaky = (name: string) =>
  write(name, `test('flaky', () => {\n  const seen = existsSync(import.meta.path + '.ran')\n  writeFileSync(import.meta.path + '.ran', '')\n  expect(seen).toBe(true)\n})`)

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

test('actual bun test processes get isolated homes and clean them up', async () => {
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

  expect(await runFiles(dir, ['pkg/home.test.ts'], [], 1)).toEqual({ ok: true, flaky: [] })
  const second = JSON.parse(readFileSync(report, 'utf8')) as { home: string; quirkyHome: string }
  expect(second.home).not.toBe(first.home)
  expect(second.quirkyHome).not.toBe(first.quirkyHome)
  expect(existsSync(second.home)).toBe(false)
  expect(existsSync(second.quirkyHome)).toBe(false)
  expect(process.env.HOME ?? null).toBe(parentHome)
  expect(process.env.QUIRKY_HOME ?? null).toBe(parentQuirkyHome)
}, 30_000)

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
