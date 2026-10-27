import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cliJson, newSession, PRESENCE_JOB, sessionOf, startOf, startStatusE2E, waitFor, type StatusE2E, type Start } from './support'

type Row = {
  sessionId: string
  agent: string
  state: string
  display: string
  label: string
  detail: string
  progress: number | null
  programStatus?: unknown
  stateStartedAt: number
  evidenceAt: number
  outcome?: string
  source: string
  children: unknown[]
  prompt: string | null
}

const claude = (event: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: event, ...extra })

/** `agent-status get` takes the session as `--session`; there is no positional form. */
const getArgs = (session: string) => ['agent-status', 'get', '--session', session]

/** The `--resume` pair a resumed claude was started with. */
const resumeArgs = (argv: string[]) => argv.slice(argv.indexOf('--resume'), argv.indexOf('--resume') + 2)

describe('SC-12: the provider session and transcript are captured from the hook shim', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E({ fakes: { claude: true } })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'SessionStart and Stop store provider session abc once, and resume starts claude with --resume abc',
    async () => {
      const session = await newSession(e2e, 'claude')
      const first = await startOf(e2e, 'claude', session.id)
      expect((await sessionOf(e2e, session.id)).providerSession).toBeNull()

      const captured = { session_id: 'abc', transcript_path: '/tmp/t/abc.jsonl' }
      const started = await e2e.shim('claude', session.id, claude('SessionStart', { source: 'startup', ...captured }), { pid: first.pid })
      expect(started).toEqual({ code: 0, stdout: '{}\n' })
      await waitFor(async () => (await sessionOf(e2e, session.id)).providerSession, 10_000, 'the provider session')
      const stored = (await sessionOf(e2e, session.id)).providerSession
      expect(stored).toEqual({ id: 'abc', transcriptPath: '/tmp/t/abc.jsonl' })

      await e2e.shim('claude', session.id, claude('Stop', { last_assistant_message: 'done', ...captured }), { pid: first.pid })
      await waitFor(async () => (await cliJson<Row | null>(e2e, getArgs(session.id)))?.state === 'done', 10_000, 'the Stop to land')
      expect((await sessionOf(e2e, session.id)).providerSession).toEqual(stored)

      const resumed = await cliJson<{ id: string }>(e2e, ['session', 'resume', session.id])
      expect(resumed.id).not.toBe(session.id)
      const second = await startOf(e2e, 'claude', resumed.id)
      expect(resumeArgs(second.argv)).toEqual(['--resume', 'abc'])
      expect(second.argv.slice(-2)).toEqual(['--resume', 'abc'])
    },
    60_000
  )
})

/** Types `claude` into a shell session and returns the fake agent process that starts under it. */
async function runClaudeIn(e2e: StatusE2E, sessionId: string): Promise<Start> {
  await e2e.call('quirky.terminal/write', { session: sessionId, data: 'claude\r' })
  return startOf(e2e, 'claude', sessionId)
}

const isGone = (pid: number) => {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

const rowOf = (e2e: StatusE2E, session: string) => cliJson<Row | null>(e2e, getArgs(session))

describe('SC-19: an agent that exits without saying so', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E({ fakes: { claude: true } })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'a killed agent process ends its row at the next presence probe and the shell session reads running',
    async () => {
      const shell = await newSession(e2e, 'shell')
      const agent = await runClaudeIn(e2e, shell.id)
      await e2e.shim('claude', shell.id, claude('UserPromptSubmit', { prompt: 'go' }), { pid: agent.pid })
      await waitFor(async () => (await rowOf(e2e, shell.id))?.state === 'working', 10_000, 'a working row')
      expect((await sessionOf(e2e, shell.id)).status).toBe('working')

      await e2e.call('job.run', { id: PRESENCE_JOB })
      expect((await rowOf(e2e, shell.id))?.state).toBe('working')

      process.kill(agent.pid, 'SIGKILL')
      await waitFor(() => isGone(agent.pid), 5000, 'the agent process to die')
      await e2e.call('job.run', { id: PRESENCE_JOB })

      await waitFor(async () => (await rowOf(e2e, shell.id)) === null, 10_000, 'the row to end')
      expect(await sessionOf(e2e, shell.id)).toMatchObject({ status: 'running', agentStatus: null })
    },
    60_000
  )
})

describe('SC-33: list and get', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E({ fakes: { claude: true } })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'list has one entry with the summary, get returns the whole row, and get for a shell prints null',
    async () => {
      const working = await newSession(e2e, 'claude')
      const agent = await startOf(e2e, 'claude', working.id)
      const shell = await newSession(e2e, 'shell')
      await e2e.shim('claude', working.id, claude('UserPromptSubmit', { prompt: 'fix the tests' }), { pid: agent.pid })

      const listed = await waitFor(async () => {
        const rows = await cliJson<Row[]>(e2e, ['agent-status', 'list'])
        return rows.length > 0 ? rows : undefined
      }, 10_000, 'the row in list')
      expect(listed).toHaveLength(1)
      expect(listed[0]).toEqual({
        sessionId: working.id,
        agent: 'claude',
        state: 'working',
        display: 'working',
        label: 'Working',
        detail: 'fix the tests',
        progress: null,
        stateStartedAt: expect.any(Number),
        evidenceAt: expect.any(Number),
        restoredUnconfirmed: false
      } as unknown as Row)

      const row = await rowOf(e2e, working.id)
      expect(row).toMatchObject({
        sessionId: working.id,
        agent: 'claude',
        state: 'working',
        display: 'working',
        label: 'Working',
        prompt: 'fix the tests',
        source: 'hook',
        children: [],
        stateStartedAt: listed[0]!.stateStartedAt,
        evidenceAt: listed[0]!.evidenceAt
      })
      expect(row).not.toHaveProperty('outcome')

      const none = await e2e.cli([...getArgs(shell.id), '--json'])
      expect(none.code).toBe(0)
      expect(JSON.parse(none.stdout)).toBeNull()
      expect(await cliJson<Row[]>(e2e, ['agent-status', 'list'])).toHaveLength(1)

      await e2e.shim('claude', working.id, claude('Stop', { last_assistant_message: 'All green' }), { pid: agent.pid })
      await waitFor(async () => (await rowOf(e2e, working.id))?.outcome === 'success', 10_000, 'the Stop to land')

      // a program reporting its own progress with OSC 7501 gives a shell session a row too
      await e2e.call('quirky.terminal/write', { session: shell.id, data: `printf '\\033]7501;state=working:progress=40\\007'\r` })
      const shellRow = await waitFor(async () => (await cliJson<Row[]>(e2e, ['agent-status', 'list'])).find((entry) => entry.sessionId === shell.id), 10_000, 'the program-status row')
      expect(shellRow).toMatchObject({ display: 'working', progress: 40 })
      expect(await rowOf(e2e, shell.id)).toMatchObject({ source: 'program-status', programStatus: { state: 'working', progress: 40 } })
    },
    60_000
  )
})
