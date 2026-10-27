import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Session } from '@quirky/protocol'
import { startAgentsE2E, type CliResult, type E2E, type FakeEvent } from '../support/e2e'

const CLI_MAIN = resolve(import.meta.dir, '../../../../packages/cli/src/main.ts')

type Start = Extract<FakeEvent, { type: 'start' }>

/** Runs the `quirky` CLI from `cwd`, which the daemon sees as the caller's folder. */
async function cliFrom(e2e: E2E, cwd: string, args: string[]): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, CLI_MAIN, ...args], {
    cwd,
    env: { PATH: `${e2e.fakebin}:/usr/bin:/bin`, HOME: e2e.userHome, QUIRKY_HOME: e2e.home },
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 20_000
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
    proc.exited
  ])
  return { code, stdout, stderr }
}

function parsed<T>(result: CliResult): T {
  if (result.code !== 0) throw new Error(`quirky exited ${result.code}: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout) as T
}

const newSession = async (e2e: E2E, agent: string, cwd = e2e.repo) => parsed<Session>(await cliFrom(e2e, cwd, ['session', 'new', '--agent', agent, '--json']))

const setProviderSession = async (e2e: E2E, session: string, id: string, transcript?: string) => {
  const result = await e2e.cli(['session', 'set-provider-session', session, id, ...(transcript === undefined ? [] : ['--transcript', transcript])])
  expect(result.code).toBe(0)
}

const resumeSession = async (e2e: E2E, session: string, extra: string[] = [], cwd = e2e.repo) =>
  parsed<Session>(await cliFrom(e2e, cwd, ['session', 'resume', session, '--json', ...extra]))

const listSessions = async (e2e: E2E) => parsed<Session[]>(await e2e.cli(['session', 'list', '--json']))

async function startOf(e2e: E2E, fake: string, sessionId: string): Promise<Start> {
  const events = await e2e.waitForFakeLog(
    fake,
    (log) => log.some((event) => event.type === 'start' && event.env.QUIRKY_SESSION_ID === sessionId),
    15_000
  )
  return events.find((event): event is Start => event.type === 'start' && event.env.QUIRKY_SESSION_ID === sessionId)!
}

const startCount = (e2e: E2E, fake: string) => e2e.fakeLog(fake).filter((event) => event.type === 'start').length

/** The argv with the agent-status hook's `--settings <file>` pair taken out, so assertions name only the agent's own arguments. */
function withoutHookSettings(argv: string[]): string[] {
  const at = argv.indexOf('--settings')
  return at === -1 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)]
}

describe('SC-30: the provider session is stored only if it is valid', () => {
  let e2e: E2E
  beforeEach(async () => {
    e2e = await startAgentsE2E({ fakes: { codex: true } })
  }, 30_000)
  afterEach(() => e2e.cleanup())

  test(
    'SC-30: a normal ID and a 512-character ID are stored, the rest are refused with the rule they break',
    async () => {
      const session = await newSession(e2e, 'codex')
      await setProviderSession(e2e, session.id, '0199a-thread')
      expect((await listSessions(e2e)).find((s) => s.id === session.id)?.providerSession).toEqual({ id: '0199a-thread', transcriptPath: null })

      const long = 'a'.repeat(512)
      await setProviderSession(e2e, session.id, long, '/t/rollout.jsonl')
      expect((await listSessions(e2e)).find((s) => s.id === session.id)?.providerSession).toEqual({ id: long, transcriptPath: '/t/rollout.jsonl' })

      const refused: [string, string][] = [
        ['', "provider session id can't be empty"],
        ['a'.repeat(513), "provider session id can't be longer than 512 characters"],
        ['a\nb', "provider session id can't contain control characters"]
      ]
      for (const [id, message] of refused) {
        const result = await e2e.cli(['session', 'set-provider-session', session.id, id])
        expect(result.code).not.toBe(0)
        expect(result.stderr).toContain(message)
      }
      // the CLI parser reads a bare -x as a flag, so the dash rule is reached after `--`
      const dashed = await e2e.cli(['session', 'set-provider-session', session.id, '--', '-x'])
      expect(dashed.code).not.toBe(0)
      expect(dashed.stderr).toContain("provider session id can't start with '-'")

      expect((await listSessions(e2e)).find((s) => s.id === session.id)?.providerSession?.id).toBe(long)
    },
    60_000
  )
})

describe('SC-31, SC-33: resume replays the launch record', () => {
  let e2e: E2E
  beforeEach(async () => {
    e2e = await startAgentsE2E({ fakes: { claude: true } })
  }, 30_000)
  afterEach(() => e2e.cleanup())

  test(
    "SC-31: resume replays the launch record, not today's defaults, in the original folder",
    async () => {
      expect((await e2e.cli(['agents', 'configure', 'claude', '--args=--model haiku'])).code).toBe(0)
      const first = await newSession(e2e, 'claude')
      expect(first.launch).toEqual({ command: 'claude', args: '--model haiku', env: {} })
      await setProviderSession(e2e, first.id, 'abc')

      expect((await e2e.cli(['agents', 'configure', 'claude', '--reset', 'args'])).code).toBe(0)
      const info = parsed<{ argsOverridden: boolean }>(await e2e.cli(['agents', 'get', 'claude', '--json']))
      expect(info.argsOverridden).toBe(false)

      const elsewhere = realpathSync(mkdtempSync('/tmp/qe-'))
      let resumed: Session
      try {
        resumed = await resumeSession(e2e, first.id, [], elsewhere)
      } finally {
        rmSync(elsewhere, { recursive: true, force: true })
      }

      expect(resumed).toMatchObject({
        agent: 'claude',
        kind: 'terminal',
        status: 'running',
        worktreeId: first.worktreeId,
        cwd: e2e.repo,
        resumedFrom: first.id,
        launch: { command: 'claude', args: '--model haiku', env: {} },
        providerSession: { id: 'abc', transcriptPath: null }
      })
      expect(resumed.id).not.toBe(first.id)

      const started = await startOf(e2e, 'claude', resumed.id)
      expect(started.cwd).toBe(e2e.repo)
      expect(started.argv.slice(0, 2)).toEqual(['--model', 'haiku'])
      expect(started.argv.slice(-2)).toEqual(['--resume', 'abc'])
      expect(started.argv).not.toContain('--dangerously-skip-permissions')
      expect(withoutHookSettings(started.argv)).toEqual(['--model', 'haiku', '--resume', 'abc'])

      const again = await resumeSession(e2e, resumed.id)
      const replayed = await startOf(e2e, 'claude', again.id)
      expect(withoutHookSettings(replayed.argv)).toEqual(['--model', 'haiku', '--resume', 'abc'])
      expect(again.launch).toEqual({ command: 'claude', args: '--model haiku', env: {} })

      const old = (await listSessions(e2e)).find((s) => s.id === first.id)
      expect(old).toMatchObject({
        launch: { command: 'claude', args: '--model haiku', env: {} },
        providerSession: { id: 'abc', transcriptPath: null },
        resumedFrom: null
      })
    },
    60_000
  )

  test(
    "SC-33: Claude's saved resume selector is replaced, not doubled",
    async () => {
      expect((await e2e.cli(['agents', 'configure', 'claude', '--args=--continue --model x -- extra'])).code).toBe(0)
      const first = await newSession(e2e, 'claude')
      const resumed = await resumeSession(e2e, first.id, ['--provider-session', 'abc'])
      const started = await startOf(e2e, 'claude', resumed.id)

      expect(started.argv).not.toContain('--continue')
      expect(started.argv.filter((arg) => arg === '--resume')).toHaveLength(1)
      expect(started.argv.indexOf('--resume')).toBeLessThan(started.argv.indexOf('--'))
      expect(withoutHookSettings(started.argv)).toEqual(['--model', 'x', '--resume', 'abc', '--', 'extra'])
    },
    60_000
  )
})

/** Every agent that resumes, by catalog ID: the commands to fake and the argv tail providers.md lists (`S` is the provider session, `T` the transcript). */
const RESUMABLE: { id: string; fakes: string[]; tail: string[] }[] = [
  { id: 'claude', fakes: ['claude'], tail: ['--resume', 'S'] },
  { id: 'codex', fakes: ['codex'], tail: ['resume', 'S'] },
  { id: 'grok', fakes: ['grok'], tail: ['--resume', 'S'] },
  { id: 'copilot', fakes: ['copilot'], tail: ['--resume=S'] },
  { id: 'opencode2', fakes: ['opencode2'], tail: ['--session', 'S'] },
  { id: 'opencode', fakes: ['opencode'], tail: ['--session', 'S'] },
  { id: 'mimo-code', fakes: ['mimo'], tail: ['--session', 'S'] },
  { id: 'muse', fakes: ['muse'], tail: ['resume', 'S'] },
  { id: 'dsh', fakes: ['dsh-tui', 'dsh'], tail: ['--resume', 'S'] },
  { id: 'qoder', fakes: ['qodercli'], tail: ['--resume', 'S'] },
  { id: 'qoder-cn', fakes: ['qoderclicn'], tail: ['--resume', 'S'] },
  { id: 'zcode', fakes: ['zcode'], tail: ['--resume', 'S'] },
  { id: 'pi', fakes: ['pi'], tail: ['--session', 'T'] },
  { id: 'omp', fakes: ['omp'], tail: ['--resume', 'T'] },
  { id: 'prime-agent', fakes: ['prime-agent'], tail: ['--resume', 'T'] },
  { id: 'gemini', fakes: ['gemini'], tail: ['--resume', 'S'] },
  { id: 'antigravity', fakes: ['agy'], tail: ['--conversation', 'S'] },
  { id: 'kiro', fakes: ['kiro-cli'], tail: ['--resume-id', 'S'] },
  { id: 'cursor', fakes: ['cursor-agent'], tail: ['--resume', 'S'] },
  { id: 'droid', fakes: ['droid'], tail: ['--resume', 'S'] },
  { id: 'kimi', fakes: ['kimi'], tail: ['--session', 'S'] },
  { id: 'qwen-code', fakes: ['qwen'], tail: ['--resume', 'S'] },
  { id: 'devin', fakes: ['devin'], tail: ['--resume', 'S'] },
  { id: 'codebuddy', fakes: ['codebuddy'], tail: ['--resume', 'S'] },
  { id: 'jcode', fakes: ['jcode'], tail: ['--resume', 'S'] }
]

describe('SC-32: each resumable agent gets its own resume arguments', () => {
  let e2e: E2E
  beforeAll(async () => {
    const fakes = Object.fromEntries(RESUMABLE.flatMap((row) => row.fakes).map((name) => [name, true as const]))
    e2e = await startAgentsE2E({ fakes })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test('SC-32: the table covers the 25 resumable agents the catalog lists', async () => {
    const listing = parsed<{ agents: { id: string; resumable: boolean }[] }>(await e2e.cli(['agents', 'list', '--json']))
    expect(listing.agents.filter((agent) => agent.resumable).map((agent) => agent.id).sort()).toEqual(RESUMABLE.map((row) => row.id).sort())
  }, 30_000)

  for (const row of RESUMABLE) {
    test(
      `SC-32: ${row.id} resumes with ${row.tail.join(' ')}`,
      async () => {
        const first = await newSession(e2e, row.id)
        await setProviderSession(e2e, first.id, 'S', 'T')
        const resumed = await resumeSession(e2e, first.id)
        expect(resumed).toMatchObject({ agent: row.id, resumedFrom: first.id })
        const started = await startOf(e2e, row.fakes[0]!, resumed.id)
        expect(started.argv.slice(-row.tail.length)).toEqual(row.tail)
      },
      30_000
    )
  }

  test(
    'SC-32: omp falls back to the provider session ID when there is no transcript',
    async () => {
      const first = await newSession(e2e, 'omp')
      await setProviderSession(e2e, first.id, 'S')
      const resumed = await resumeSession(e2e, first.id)
      const started = await startOf(e2e, 'omp', resumed.id)
      expect(started.argv.slice(-2)).toEqual(['--resume', 'S'])
    },
    30_000
  )

  test(
    'SC-32: pi, which resumes by transcript, is refused without one and starts nothing',
    async () => {
      const first = await newSession(e2e, 'pi')
      await startOf(e2e, 'pi', first.id)
      await setProviderSession(e2e, first.id, 'S')
      const before = startCount(e2e, 'pi')
      const result = await e2e.cli(['session', 'resume', first.id])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('pi needs a transcript path to resume')
      expect(startCount(e2e, 'pi')).toBe(before)
    },
    30_000
  )
})

describe('SC-34: fork opens a copy for the agents that fork by argument', () => {
  let e2e: E2E
  beforeEach(async () => {
    e2e = await startAgentsE2E({ fakes: { claude: true, codex: true, grok: true, pi: true, opencode: true } })
  }, 30_000)
  afterEach(() => e2e.cleanup())

  const forks: { agent: string; tail: string[] }[] = [
    { agent: 'claude', tail: ['--resume', 'S', '--fork-session'] },
    { agent: 'codex', tail: ['fork', 'S'] },
    { agent: 'grok', tail: ['--resume', 'S', '--fork-session'] },
    { agent: 'pi', tail: ['--fork', 'T'] }
  ]

  test(
    'SC-34: claude, codex, grok and pi sessions fork with their own arguments',
    async () => {
      for (const { agent, tail } of forks) {
        const first = await newSession(e2e, agent)
        await setProviderSession(e2e, first.id, 'S', 'T')
        const forked = await resumeSession(e2e, first.id, ['--fork'])
        expect(forked).toMatchObject({ agent, resumedFrom: first.id })
        const started = await startOf(e2e, agent, forked.id)
        expect(started.argv.slice(-tail.length)).toEqual(tail)
      }
    },
    60_000
  )

  test(
    "SC-34: an opencode session can't be forked and starts nothing",
    async () => {
      const first = await newSession(e2e, 'opencode')
      await startOf(e2e, 'opencode', first.id)
      await setProviderSession(e2e, first.id, 'S')
      const before = (await listSessions(e2e)).length
      const result = await e2e.cli(['session', 'resume', first.id, '--fork'])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain("opencode can't fork from Quirky yet")
      expect((await listSessions(e2e)).length).toBe(before)
      expect(startCount(e2e, 'opencode')).toBe(1)
    },
    30_000
  )
})

describe('SC-35: resume and fork are refused where they cannot work', () => {
  let e2e: E2E
  const extraRepos: string[] = []
  beforeEach(async () => {
    e2e = await startAgentsE2E({ fakes: { claude: true, codex: true, aider: true } })
  }, 30_000)
  afterEach(async () => {
    await e2e.cleanup()
    for (const dir of extraRepos.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function refused(session: string, message: string, extra: string[] = []): Promise<void> {
    const before = await listSessions(e2e)
    const result = await e2e.cli(['session', 'resume', session, ...extra])
    expect(result.code).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(message)
    expect((await listSessions(e2e)).map((s) => s.id)).toEqual(before.map((s) => s.id))
  }

  test(
    'SC-35: a plain shell session is refused for resume and for fork',
    async () => {
      const shell = await newSession(e2e, 'shell')
      await refused(shell.id, `session ${shell.id} is a shell, not an agent`)
      await refused(shell.id, `session ${shell.id} is a shell, not an agent`, ['--fork'])
    },
    30_000
  )

  test(
    "SC-35: aider can't resume and nothing starts",
    async () => {
      const aider = await newSession(e2e, 'aider')
      await startOf(e2e, 'aider', aider.id)
      await refused(aider.id, "aider can't resume sessions")
      expect(startCount(e2e, 'aider')).toBe(1)
    },
    30_000
  )

  test(
    'SC-35: a codex session with no provider session needs one passed in',
    async () => {
      const codex = await newSession(e2e, 'codex')
      await startOf(e2e, 'codex', codex.id)
      await refused(codex.id, `session ${codex.id} has no provider session; pass --provider-session`)
      expect(startCount(e2e, 'codex')).toBe(1)
    },
    30_000
  )

  test(
    'SC-35: a claude session whose folder was deleted is refused',
    async () => {
      const folder = realpathSync(mkdtempSync('/tmp/qd-'))
      extraRepos.push(folder)
      const git = Bun.spawnSync(['sh', '-c', 'git init -q -b main && git -c user.name=qa -c user.email=qa@example.test -c commit.gpgsign=false commit -q --allow-empty -m init'], {
        cwd: folder,
        env: { PATH: '/usr/bin:/bin', HOME: folder, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
      })
      expect(git.exitCode).toBe(0)
      expect((await e2e.cli(['repo', 'add', folder])).code).toBe(0)

      const claude = await newSession(e2e, 'claude', folder)
      expect(claude.cwd).toBe(folder)
      await startOf(e2e, 'claude', claude.id)
      await setProviderSession(e2e, claude.id, 'abc')
      rmSync(folder, { recursive: true, force: true })

      await refused(claude.id, `the session's folder ${folder} no longer exists`)
      expect(startCount(e2e, 'claude')).toBe(1)
    },
    60_000
  )
})
