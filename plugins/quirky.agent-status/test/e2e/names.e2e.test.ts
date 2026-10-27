import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import { cliJson, newSession, sessionOf, startOf, startStatusE2E, waitFor, type CliResult, type StatusE2E } from './support'

type ErrorLine = { error: { code: string; message: string; reason?: string } }

/** The `--json` error a failed CLI call printed. */
const errorOf = (result: CliResult): ErrorLine['error'] => (JSON.parse(result.stdout) as ErrorLine).error

const nameArgs = (session: string, ...rest: string[]) => ['session', 'name', session, ...rest]

/** A running claude session; its fake process is what ends it, because a shell that exits has its session closed with its pane. */
async function newClaude(e2e: StatusE2E): Promise<{ session: Session; pid: number }> {
  const session = await newSession(e2e, 'claude')
  return { session, pid: (await startOf(e2e, 'claude', session.id)).pid }
}

/** Ends the agent process and waits until the daemon records its session as exited. */
async function endAgent(e2e: StatusE2E, session: string, pid: number): Promise<void> {
  process.kill(pid, 'SIGTERM')
  await waitFor(async () => (await sessionOf(e2e, session)).status === 'exited', 15_000, 'the agent to exit')
}

const typedInto = (e2e: StatusE2E) =>
  e2e
    .fakeLog('claude')
    .filter((event) => event.type === 'input')
    .map((event) => Buffer.from((event as { b64: string }).b64, 'base64').toString('utf8'))
    .join('')

describe('SC-32: a named session is addressed by its name', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E({ fakes: { claude: { raw: true } }, extraEnv: { QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: '0.2' } })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'explain, send, wait, get and close each act on the session that session new --name created',
    async () => {
      const created = await cliJson<Session>(e2e, ['session', 'new', '--agent', 'claude', '--name', 'reviewer'])
      expect(created.name).toBe('reviewer')
      const agent = await startOf(e2e, 'claude', created.id)

      const explained = await cliJson<{ session: string; name: string | null; agent: string }>(e2e, ['agent-status', 'explain', 'reviewer'])
      expect(explained).toMatchObject({ session: created.id, name: 'reviewer', agent: 'claude' })

      const sending = e2e.cli(['agent-status', 'send', 'reviewer', 'hello there', '--start-timeout-ms', '20000'])
      await waitFor(() => /hello there[\s\S]*\r/.test(typedInto(e2e)), 15_000, 'the prompt and its Enter to reach the agent')
      await e2e.shim('claude', created.id, { hook_event_name: 'UserPromptSubmit', prompt: 'hello there' }, { pid: agent.pid })
      const sent = await sending
      expect(sent).toMatchObject({ code: 0, stdout: `${created.id}: working\n` })

      await e2e.shim('claude', created.id, { hook_event_name: 'Stop', last_assistant_message: 'done' }, { pid: agent.pid })
      const waited = await e2e.cli(['agent-status', 'wait', 'reviewer', '--until', 'idle', '--timeout-ms', '15000'])
      expect(waited).toMatchObject({ code: 0, stdout: 'reviewer: idle\n' })

      const got = await cliJson<Session>(e2e, ['session', 'get', 'reviewer'])
      expect(got).toMatchObject({ id: created.id, name: 'reviewer' })
      const listed = await cliJson<Session[]>(e2e, ['session', 'list'])
      expect(listed.find((session) => session.id === created.id)?.name).toBe('reviewer')
      const table = await e2e.cli(['session', 'list'])
      expect(table.stdout.split('\n')[0]).toMatch(/^ID\s+NAME\s+AGENT/)
      expect(table.stdout).toMatch(new RegExp(`${created.id}\\s+reviewer\\s+claude`))

      const closed = await e2e.cli(['session', 'close', 'reviewer'])
      expect(closed).toMatchObject({ code: 0, stdout: 'closed reviewer\n' })
      const gone = await e2e.cli(['session', 'get', created.id, '--json'])
      expect(gone.code).toBe(1)
      expect(errorOf(gone).code).toBe('not-found')
      const byName = await e2e.cli(['session', 'get', 'reviewer', '--json'])
      expect(byName.code).toBe(1)
      expect(errorOf(byName).code).toBe('not-found')
    },
    90_000
  )
})

describe('SC-33: naming and clearing a running session', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E()
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'session name lowercases the name and --clear removes it',
    async () => {
      const session = await newSession(e2e, 'shell')
      expect(session.name).toBeNull()

      const named = await cliJson<Session>(e2e, nameArgs(session.id, 'Builder'))
      expect(named).toMatchObject({ id: session.id, name: 'builder' })
      expect(await sessionOf(e2e, session.id)).toMatchObject({ name: 'builder' })
      const text = await e2e.cli(nameArgs(session.id, 'Builder'))
      expect(text.code).toBe(0)
      expect(text.stdout).toMatch(/^name: builder$/m)

      const cleared = await cliJson<Session>(e2e, nameArgs(session.id, '--clear'))
      expect(cleared).toMatchObject({ id: session.id, name: null })
      expect((await sessionOf(e2e, session.id)).name).toBeNull()
      const byOldName = await e2e.cli(['session', 'get', 'builder', '--json'])
      expect(byOldName.code).toBe(1)
      expect(errorOf(byOldName).code).toBe('not-found')
    },
    60_000
  )
})

describe('SC-34: names that are refused', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E()
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'each bad name fails with invalid-params and the rule it broke, and the session keeps its name',
    async () => {
      const session = await newSession(e2e, 'shell')
      await cliJson<Session>(e2e, nameArgs(session.id, 'keeper'))

      const cases: { label: string; name: string; message: RegExp }[] = [
        { label: 'empty', name: '', message: /empty/ },
        { label: '65 characters', name: 'a'.repeat(65), message: /longer than 64 characters/ },
        { label: 'has space', name: 'has space', message: /can only contain letters, digits/ },
        { label: '-lead', name: '-lead', message: /must start with a letter or digit/ },
        { label: 's_reviewer', name: 's_reviewer', message: /can't start with 's_'/ },
        { label: 'build/1', name: 'build/1', message: /can only contain letters, digits/ }
      ]
      for (const { label, name, message } of cases) {
        const refused = await e2e.cli([...nameArgs(session.id), '--json', '--', name])
        expect({ label, code: refused.code }).toEqual({ label, code: 1 })
        const error = errorOf(refused)
        expect({ label, code: error.code }).toEqual({ label, code: 'invalid-params' })
        expect(error.message).toMatch(message)
        expect((await sessionOf(e2e, session.id)).name).toBe('keeper')
      }
    },
    60_000
  )
})

describe('SC-35: a running session\'s name can\'t be taken; an exited one\'s can', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E({ fakes: { claude: { raw: true } } })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'the first claim fails with name-taken naming A; after A exits the name moves to B',
    async () => {
      const { session: a, pid } = await newClaude(e2e)
      const { session: b } = await newClaude(e2e)
      await cliJson<Session>(e2e, nameArgs(a.id, 'reviewer'))

      const taken = await e2e.cli([...nameArgs(b.id, 'Reviewer'), '--json'])
      expect(taken.code).toBe(1)
      const error = errorOf(taken)
      expect(error).toMatchObject({ code: 'conflict', reason: 'name-taken' })
      expect(error.message).toContain(a.id)
      expect((await sessionOf(e2e, b.id)).name).toBeNull()
      expect((await sessionOf(e2e, a.id)).name).toBe('reviewer')

      await endAgent(e2e, a.id, pid)
      expect((await sessionOf(e2e, a.id)).name).toBe('reviewer')

      const moved = await cliJson<Session>(e2e, nameArgs(b.id, 'reviewer'))
      expect(moved).toMatchObject({ id: b.id, name: 'reviewer' })
      expect(await sessionOf(e2e, a.id)).toMatchObject({ status: 'exited', name: null })
      expect(await sessionOf(e2e, b.id)).toMatchObject({ name: 'reviewer' })
      expect((await cliJson<Session>(e2e, ['session', 'get', 'reviewer'])).id).toBe(b.id)
    },
    90_000
  )
})

describe('SC-36: an exited session keeps its name until it moves', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E({ fakes: { claude: { raw: true } } })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'explain by the name explains the exited session',
    async () => {
      const { session: a, pid } = await newClaude(e2e)
      await cliJson<Session>(e2e, nameArgs(a.id, 'reviewer'))
      await endAgent(e2e, a.id, pid)

      const explained = await cliJson<{ session: string; name: string | null; state: string; summary: string; exit?: { code: number | null } }>(e2e, [
        'agent-status',
        'explain',
        'reviewer'
      ])
      expect(explained).toMatchObject({ session: a.id, name: 'reviewer', state: 'exited' })
      expect(explained.summary).toMatch(/^exited: the process ended/)
      expect(explained.exit).toBeDefined()

      const text = await e2e.cli(['agent-status', 'explain', 'reviewer'])
      expect(text.code).toBe(0)
      expect(text.stdout.split('\n')[0]).toMatch(/^exited: the process ended/)
    },
    60_000
  )
})

describe('SC-37: names survive a daemon restart', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E()
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'session get by name finds the stored session after the daemon restarts',
    async () => {
      const session = await newSession(e2e, 'shell')
      await cliJson<Session>(e2e, nameArgs(session.id, 'Nightly'))

      await e2e.restartDaemon()

      const found = await cliJson<Session>(e2e, ['session', 'get', 'nightly'])
      expect(found).toMatchObject({ id: session.id, name: 'nightly' })
      const listed = await cliJson<Session[]>(e2e, ['session', 'list'])
      expect(listed.find((entry) => entry.id === session.id)?.name).toBe('nightly')
    },
    90_000
  )
})
