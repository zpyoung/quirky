import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FixtureInfo } from './contracts.ts'
import { fixtureOwnership, parseFixtureArgs, seedEnvironment, UsageError } from './fixture.ts'

const FIXTURE_SCRIPT = join(import.meta.dir, 'fixture.ts')

describe('parseFixtureArgs', () => {
  test('start defaults to the dark theme with nothing to open', () => {
    expect(parseFixtureArgs(['start', '/tmp/out'])).toEqual({ kind: 'start', out: '/tmp/out', theme: 'dark', open: [] })
  })

  test('start takes a theme and repeated --open ids in order', () => {
    expect(
      parseFixtureArgs(['start', '/tmp/out', '--theme', 'light', '--open', 'panel:a/b', '--open', 'view:c/d'])
    ).toEqual({ kind: 'start', out: '/tmp/out', theme: 'light', open: ['panel:a/b', 'view:c/d'] })
  })

  test('seed takes an out dir and a script path', () => {
    expect(parseFixtureArgs(['seed', '/tmp/out', '/tmp/seed.sh'])).toEqual({
      kind: 'seed',
      out: '/tmp/out',
      script: '/tmp/seed.sh'
    })
  })

  test('stop takes an out dir', () => {
    expect(parseFixtureArgs(['stop', '/tmp/out'])).toEqual({ kind: 'stop', out: '/tmp/out' })
  })

  test('relative paths resolve against the working directory', () => {
    expect(parseFixtureArgs(['stop', 'rel/out'])).toEqual({ kind: 'stop', out: join(process.cwd(), 'rel/out') })
  })

  test.each([
    ['no arguments', []],
    ['an unknown subcommand', ['launch', '/tmp/out']],
    ['start without an out dir', ['start']],
    ['start with a bad theme', ['start', '/tmp/out', '--theme', 'sepia']],
    ['start with an empty --open', ['start', '/tmp/out', '--open', '']],
    ['start with an unknown flag', ['start', '/tmp/out', '--verbose']],
    ['start with a second positional', ['start', '/tmp/out', '/tmp/other']],
    ['seed without a script', ['seed', '/tmp/out']],
    ['seed with a flag', ['seed', '/tmp/out', '/tmp/seed.sh', '--theme', 'dark']],
    ['stop without an out dir', ['stop']],
    ['stop with a second positional', ['stop', '/tmp/out', '/tmp/other']]
  ])('rejects %s', (_name, argv) => {
    expect(() => parseFixtureArgs(argv)).toThrow(UsageError)
  })
})

describe('seedEnvironment', () => {
  const info: FixtureInfo = {
    url: 'http://127.0.0.1:1/#token=t',
    port: 1,
    home: '/tmp/fixture-home',
    pid: 1,
    repos: {
      primary: '/tmp/fixture-home/projects/ui-review-fixture',
      worktrees: { 'ui-review-ready': '/tmp/fixture-home/worktrees/ready', 'ui-review-notes': '/tmp/fixture-home/worktrees/notes' },
      projects: { 'ui-review-fixture': '/tmp/fixture-home/projects/ui-review-fixture', 'harbor-api': '/tmp/fixture-home/projects/harbor-api' }
    }
  }
  const leaked = ['QUIRKY_SESSION_ID', 'QUIRKY_WORKTREE_ID', 'QUIRKY_HOOK_URL', 'QUIRKY_HOOK_TOKEN', 'GITHUB_TOKEN']

  test('drops the caller session and keeps HOME and QUIRKY_HOME inside the fixture home', () => {
    const saved = Object.fromEntries(leaked.map((key) => [key, process.env[key]]))
    for (const key of leaked) process.env[key] = 'from-the-caller'
    try {
      const env = seedEnvironment(info, '/repo')
      for (const key of leaked) expect(env[key]).toBeUndefined()
      expect(Object.keys(env).filter((key) => key.startsWith('QUIRKY_HOOK_'))).toEqual([])
      expect(env.HOME.startsWith('/tmp/fixture-home')).toBe(true)
      expect(env.QUIRKY_HOME.startsWith('/tmp/fixture-home')).toBe(true)
    } finally {
      for (const key of leaked) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
  })

  test('names the repo, worktrees, projects and quirky command for the seed script', () => {
    const env = seedEnvironment(info, '/repo')
    expect(env.REDESIGN_REPO).toBe(info.repos.primary)
    expect(env.REDESIGN_WORKTREE_UI_REVIEW_READY).toBe('/tmp/fixture-home/worktrees/ready')
    expect(env.REDESIGN_WORKTREE_UI_REVIEW_NOTES).toBe('/tmp/fixture-home/worktrees/notes')
    expect(env.REDESIGN_PROJECT_HARBOR_API).toBe('/tmp/fixture-home/projects/harbor-api')
    expect(env.REDESIGN_QUIRKY).toBe(`${process.execPath} /repo/packages/cli/src/main.ts`)
    expect(env.GIT_AUTHOR_NAME).toBe('Redesign Fixture')
    expect(env.GIT_AUTHOR_EMAIL).toBe('redesign-fixture@localhost')
    expect(env.GIT_COMMITTER_NAME).toBe('Redesign Fixture')
    expect(env.GIT_COMMITTER_EMAIL).toBe('redesign-fixture@localhost')
  })
})

describe('fixtureOwnership', () => {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (n: number) => String(n).padStart(2, '0')
  const ps = (startMs: number, command: string) => {
    const d = new Date(startMs)
    const lstart = `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${d.getFullYear()}`
    return `${lstart} ${command}\n`
  }
  const mtime = new Date(2026, 10, 5, 10, 30, 0).getTime()
  const start = '/usr/local/bin/bun /repo/scripts/redesign/fixture.ts start /tmp/fix --theme dark'

  test('a fixture start that began before fixture.json was written is owned', () => {
    expect(fixtureOwnership(ps(mtime - 60_000, start), mtime)).toBe('owned')
  })

  test('the same command started after fixture.json was written is a reused pid', () => {
    expect(fixtureOwnership(ps(mtime + 5_000, start), mtime)).toBe('stale')
  })

  test('a sibling fixture whose out dir extends this one is stale when it started later', () => {
    const sibling = '/usr/local/bin/bun /repo/scripts/redesign/fixture.ts start /tmp/fix-after'
    expect(fixtureOwnership(ps(mtime + 5_000, sibling), mtime)).toBe('stale')
  })

  test('a command that is not a fixture start is stale', () => {
    expect(fixtureOwnership(ps(mtime - 60_000, 'sleep 30'), mtime)).toBe('stale')
    expect(fixtureOwnership(ps(mtime - 60_000, '/usr/local/bin/bun /repo/scripts/redesign/fixture.ts stop /tmp/fix'), mtime)).toBe('stale')
  })

  test.each([['empty output', ''], ['no start time', 'bun scripts/redesign/fixture.ts start /tmp/fix\n'], ['garbled output', 'not ps output at all']])(
    'unparseable ps output (%s) is unknown',
    (_name, output) => {
      expect(fixtureOwnership(output, mtime)).toBe('unknown')
    }
  )
})

const out = mkdtempSync(join(tmpdir(), 'redesign-fixture-'))
let started: ReturnType<typeof Bun.spawn> | undefined

afterAll(() => {
  started?.kill('SIGKILL')
  rmSync(out, { recursive: true, force: true })
})

async function run(args: string[], env: Record<string, string | undefined> = process.env) {
  const child = Bun.spawn([process.execPath, FIXTURE_SCRIPT, ...args], { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'inherit' })
  const stdout = await new Response(child.stdout).text()
  return { code: await child.exited, stdout }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (started?.exitCode !== null && started?.exitCode !== undefined) throw new Error(`the fixture exited with ${started.exitCode}`)
    if (Date.now() > deadline) throw new Error(`no ${path} after ${timeoutMs} ms`)
    await Bun.sleep(100)
  }
}

describe('seed and stop without a fixture', () => {
  test('seed exits 2 when fixture.json is missing', async () => {
    const result = await run(['seed', join(out, 'nowhere'), join(out, 'seed.sh')])
    expect(result.code).toBe(2)
    expect(JSON.parse(result.stdout)).toEqual({ error: `no fixture.json in ${join(out, 'nowhere')}` })
  })

  test('a usage error prints a JSON error and exits 2', async () => {
    const result = await run(['launch', out])
    expect(result.code).toBe(2)
    expect(JSON.parse(result.stdout)).toEqual({ error: 'first argument must be start, seed or stop' })
  })

  test('stop leaves an unrelated process alone when fixture.json is stale', async () => {
    const stale = join(out, 'stale')
    mkdirSync(stale)
    const bystander = Bun.spawn(['sleep', '30'])
    try {
      const info: FixtureInfo = { url: '', port: 1, home: join(stale, 'home'), pid: bystander.pid, repos: { primary: '', worktrees: {}, projects: {} } }
      writeFileSync(join(stale, 'fixture.json'), JSON.stringify(info))
      const result = await run(['stop', stale])
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({ stopped: false, stale: true })
      expect(existsSync(join(stale, 'fixture.json'))).toBe(false)
      expect(bystander.exitCode).toBeNull()
      expect(() => process.kill(bystander.pid, 0)).not.toThrow()
    } finally {
      bystander.kill('SIGKILL')
    }
  })

  test('stop with no fixture.json reports stopped false and exits 0', async () => {
    const result = await run(['stop', join(out, 'nowhere')])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ stopped: false })
  })
})

// builds the renderer and registers Git fixtures, so this takes far longer than bun's default timeout
test(
  'start, seed and stop drive one isolated fixture',
  async () => {
    started = Bun.spawn([process.execPath, FIXTURE_SCRIPT, 'start', out, '--theme', 'light'], {
      cwd: process.cwd(),
      stdout: 'pipe',
      stderr: 'inherit'
    })
    const path = join(out, 'fixture.json')
    let home: string | undefined
    try {
      await waitForFile(path, 240_000)
      const info = JSON.parse(readFileSync(path, 'utf8')) as FixtureInfo
      home = info.home
      expect(info.pid).toBe(started.pid)
      expect(info.home).not.toBe(process.env.QUIRKY_HOME)
      const paths = [info.repos.primary, ...Object.values(info.repos.worktrees), ...Object.values(info.repos.projects)]
      expect(Object.keys(info.repos.worktrees)).toEqual(expect.arrayContaining(['ui-review-ready', 'ui-review-notes']))
      expect(Object.keys(info.repos.projects).sort()).toEqual(['harbor-api', 'ledger-web', 'ui-review-fixture'])
      for (const path of paths) expect(existsSync(path)).toBe(true)
      // macOS reaches the temp dir through both /var and /private/var
      expect(realpathSync(info.repos.primary).startsWith(realpathSync(info.home))).toBe(true)
      const page = await fetch(info.url)
      expect(page.status).toBe(200)

      const script = join(out, 'seed.sh')
      writeFileSync(
        script,
        [
          'set -e',
          'cd "$REDESIGN_REPO"',
          'echo seeded > redesign-seed.txt',
          'git add redesign-seed.txt',
          'git commit -q -m "redesign seed"',
          'echo "${QUIRKY_SESSION_ID-unset}" > "$HOME/session-id.txt"',
          ''
        ].join('\n')
      )
      const seeded = await run(['seed', out, script], { ...process.env, QUIRKY_SESSION_ID: 'caller-session' })
      expect(seeded.code).toBe(0)
      expect(JSON.parse(seeded.stdout)).toEqual({ seeded: true, exitCode: 0 })
      const log = Bun.spawnSync(['git', '-C', info.repos.primary, 'log', '--format=%s'], { stdout: 'pipe' })
      expect(log.stdout.toString()).toContain('redesign seed')
      expect(readFileSync(join(info.home, 'session-id.txt'), 'utf8').trim()).toBe('unset')

      const failing = join(out, 'fail.sh')
      writeFileSync(failing, 'exit 3\n')
      const failed = await run(['seed', out, failing])
      expect(failed.code).toBe(1)
      expect(JSON.parse(failed.stdout)).toEqual({ seeded: false, exitCode: 3 })
    } finally {
      const stopped = await run(['stop', out])
      if (home !== undefined) expect(existsSync(home)).toBe(false)
      expect(JSON.parse(stopped.stdout)).toEqual({ stopped: true })
      expect(existsSync(path)).toBe(false)
    }
  },
  300_000
)
