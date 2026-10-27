import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { cliJson, installAgents, newSession, startOf, startStatusE2E, waitFor, type CliResult, type StatusE2E } from './support'

const claude = (event: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: event, ...extra })
const permission = { tool_name: 'Bash', tool_input: { command: 'npm test' } }

/** True while `pending` is still unsettled after `ms`. */
const stillRunning = (pending: Promise<unknown>, ms: number) => Promise.race([pending.then(() => false, () => false), Bun.sleep(ms).then(() => true)])

const timed = async (run: () => Promise<CliResult>) => {
  const startedAt = Date.now()
  const result = await run()
  return { ...result, ms: Date.now() - startedAt }
}

const wait = (e2e: StatusE2E, session: string, ...args: string[]) => timed(() => e2e.cli(['agent-status', 'wait', session, ...args]))

/** The text a session's fake agent has been sent, one entry per write. */
const inputsOf = (e2e: StatusE2E, fake: string) =>
  e2e
    .fakeLog(fake)
    .flatMap((event) => (event.type === 'input' ? [Buffer.from(event.b64, 'base64').toString()] : []))

/** Starts a claude session, posts UserPromptSubmit so its row is working, and returns it with the agent's pid. */
async function workingSession(e2e: StatusE2E) {
  const session = await newSession(e2e, 'claude')
  const { pid } = await startOf(e2e, 'claude', session.id)
  await e2e.shim('claude', session.id, claude('UserPromptSubmit', { prompt: 'go' }), { pid })
  await waitFor(async () => (await rowState(e2e, session.id)) === 'working', 10_000, 'a working row')
  return { id: session.id, pid }
}

const rowState = async (e2e: StatusE2E, session: string) => (await cliJson<{ state: string } | null>(e2e, ['agent-status', 'get', session]))?.state

describe('waits on a claude session driven by hooks', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E({ fakes: { claude: { raw: true } } })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'SC-25: wait until the agent finishes returns idle when Stop arrives, and blocked when an approval does',
    async () => {
      const session = await newSession(e2e, 'claude')
      const { pid } = await startOf(e2e, 'claude', session.id)

      const sending = e2e.cli(['agent-status', 'send', session.id, 'fix the tests'])
      await waitFor(() => inputsOf(e2e, 'claude').some((input) => input.endsWith('\r')), 15_000, 'the Enter send writes')
      await e2e.shim('claude', session.id, claude('UserPromptSubmit', { prompt: 'fix the tests' }), { pid })
      const sent = await sending
      expect(sent).toMatchObject({ code: 0, stdout: `${session.id}: working\n` })

      const finishing = wait(e2e, session.id)
      expect(await stillRunning(finishing, 1200)).toBe(true)
      await e2e.shim('claude', session.id, claude('Stop', { last_assistant_message: 'done' }), { pid })
      const finished = await finishing
      expect(finished).toMatchObject({ code: 0, stdout: `${session.id}: idle\n` })

      await e2e.shim('claude', session.id, claude('UserPromptSubmit', { prompt: 'and again' }), { pid })
      await waitFor(async () => (await rowState(e2e, session.id)) === 'working', 10_000, 'the second turn')
      const asking = timed(() => e2e.cli(['agent-status', 'wait', session.id, '--json']))
      expect(await stillRunning(asking, 800)).toBe(true)
      await e2e.shim('claude', session.id, claude('PermissionRequest', permission), { pid })
      const blocked = await asking
      expect(blocked.code).toBe(0)
      expect(JSON.parse(blocked.stdout)).toMatchObject({ status: 'matched', state: 'blocked', kind: 'approval', decidedBy: 'row' })
    },
    90_000
  )

  test(
    'SC-26: a state already reached returns at once',
    async () => {
      const idle = await workingSession(e2e)
      await e2e.shim('claude', idle.id, claude('Stop', { last_assistant_message: 'done' }), { pid: idle.pid })
      await waitFor(async () => (await rowState(e2e, idle.id)) === 'done', 10_000, 'the Stop to land')
      const reached = await wait(e2e, idle.id, '--until', 'idle', '--timeout-ms', '30000')
      expect(reached).toMatchObject({ code: 0, stdout: `${idle.id}: idle\n` })
      expect(reached.ms).toBeLessThan(10_000)

      const asking = await workingSession(e2e)
      await e2e.shim('claude', asking.id, claude('PermissionRequest', permission), { pid: asking.pid })
      await waitFor(async () => (await rowState(e2e, asking.id)) === 'waiting', 10_000, 'the approval to land')
      const blocked = await wait(e2e, asking.id, '--until', 'working,blocked', '--timeout-ms', '30000', '--json')
      expect(blocked.code).toBe(0)
      expect(JSON.parse(blocked.stdout)).toMatchObject({ status: 'matched', state: 'blocked', kind: 'approval', decidedBy: 'row' })
      expect(blocked.ms).toBeLessThan(10_000)
    },
    60_000
  )

  test(
    'SC-27: a timeout exits 1 with the last state',
    async () => {
      const working = await workingSession(e2e)

      const json = await wait(e2e, working.id, '--until', 'idle', '--timeout-ms', '3000', '--json')
      expect(json.code).toBe(1)
      expect(JSON.parse(json.stdout)).toMatchObject({ status: 'timeout', state: 'working' })
      expect(json.ms).toBeGreaterThanOrEqual(2900)
      expect(json.ms).toBeLessThan(15_000)

      const text = await wait(e2e, working.id, '--until', 'idle', '--timeout-ms', '1000')
      expect(text.code).toBe(1)
      expect(text.stdout).toBe(`timed out after 1s; ${working.id} is working\n`)
    },
    60_000
  )

  test(
    'SC-27: a wait longer than one method call spans several calls and exits 0 when the agent ends',
    async () => {
      const working = await workingSession(e2e)
      const waiting = wait(e2e, working.id, '--until', 'idle', '--timeout-ms', '150000')
      // a method call lasts at most 60 s, so the wait must be re-issued at least once before this Stop
      expect(await stillRunning(waiting, 63_000)).toBe(true)
      await e2e.shim('claude', working.id, claude('Stop', { last_assistant_message: 'done' }), { pid: working.pid })
      const finished = await waiting
      expect(finished).toMatchObject({ code: 0, stdout: `${working.id}: idle\n` })
      expect(finished.ms).toBeGreaterThanOrEqual(62_000)
    },
    120_000
  )

  test(
    'SC-28: an exited session fails a default wait with session-exited and ends an exited wait with 0',
    async () => {
      const failing = await workingSession(e2e)
      const defaultWait = wait(e2e, failing.id, '--json')
      expect(await stillRunning(defaultWait, 800)).toBe(true)
      process.kill(failing.pid, 'SIGTERM')
      const failed = await defaultWait
      expect(failed.code).toBe(1)
      expect(JSON.parse(failed.stdout)).toMatchObject({ error: { code: 'conflict', reason: 'session-exited' } })

      const ending = await workingSession(e2e)
      const exitedWait = wait(e2e, ending.id, '--until', 'exited')
      expect(await stillRunning(exitedWait, 800)).toBe(true)
      process.kill(ending.pid, 'SIGTERM')
      expect(await exitedWait).toMatchObject({ code: 0, stdout: `${ending.id}: exited\n` })
    },
    60_000
  )
})

const BUSY = '\x1b[2J\x1b[H⠋ Thinking...\r\n'
const COMPOSER = `\x1b[2J\x1b[H${['Done. I updated the config.', '─'.repeat(24), '❯ Ask anything...', '─'.repeat(24), '● Plan ○ Act (tab)'].join('\r\n')}\r\n`

describe('SC-29: a hookless agent follows its screen rules', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E({ fakes: { cline: { raw: true } }, extraEnv: { QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: '0.5' } })
    await installAgents(e2e, ['cline'])
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'wait --until idle returns the cline composer rule once the composer has shown quietly',
    async () => {
      const session = await newSession(e2e, 'cline')
      await startOf(e2e, 'cline', session.id)
      expect(await e2e.call('quirky.agent-status/get', { session: session.id })).toBeNull()

      e2e.print('cline', BUSY)
      const busy = (await e2e.call('quirky.agent-status/wait', { session: session.id, until: ['idle'], timeoutMs: 1500 })) as { status: string; state: string }
      expect(busy).toMatchObject({ status: 'pending', state: 'unknown' })

      const waiting = e2e.call('quirky.agent-status/wait', { session: session.id, until: ['idle'], timeoutMs: 20_000 })
      await Bun.sleep(300)
      const printedAt = Date.now()
      e2e.print('cline', COMPOSER)
      const reached = (await waiting) as { status: string; state: string; decidedBy: string; rule?: string }
      expect(reached).toMatchObject({ status: 'matched', state: 'idle', decidedBy: 'rule', rule: 'composer-ready' })
      // the rule asks for 1000 ms of quiet; the test scale halves it
      expect(Date.now() - printedAt).toBeGreaterThanOrEqual(400)
    },
    60_000
  )
})

const LONG_LINE = `start ${'a'.repeat(100)} end`
const filler = (count: number) => Array.from({ length: count }, (_, index) => `filler ${index}`).join('\r\n')

describe('output waits', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E({
      fakes: {
        claude: { raw: true, steps: [{ afterMs: 100, write: 'build: 3 tests\r\n' }] },
        codex: { raw: true },
        gemini: { raw: true, steps: [{ afterMs: 2500, write: 'final: ok\r\n' }], exitAfterMs: 2550 },
        opencode: { raw: true, exitAfterMs: 1500 }
      }
    })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  const output = (session: string, ...args: string[]) => timed(() => e2e.cli(['agent-status', 'wait', session, '--output', ...args]))

  test(
    'SC-30: wait for output that matches a pattern',
    async () => {
      const session = await newSession(e2e, 'claude')
      await startOf(e2e, 'claude', session.id)
      await waitFor(async () => (await output(session.id, 'build: 3 tests', '--timeout-ms', '200')).code === 0, 15_000, 'the screen to show the build line')

      const existing = await output(session.id, 'tests', '--timeout-ms', '30000')
      expect(existing).toMatchObject({ code: 0, stdout: 'build: 3 tests\n' })
      expect(existing.ms).toBeLessThan(10_000)

      const counted = output(session.id, 'All (\\d+) passed', '--timeout-ms', '30000')
      expect(await stillRunning(counted, 1000)).toBe(true)
      e2e.print('claude', 'All 12 passed\r\n')
      expect(await counted).toMatchObject({ code: 0, stdout: 'All 12 passed\ngroup 1: 12\n' })

      e2e.print('claude', 'ALL 13 PASSED\r\n')
      await waitFor(async () => (await output(session.id, '13 PASSED', '--timeout-ms', '200')).code === 0, 15_000, 'the shouted line')
      const lowered = await output(session.id, 'all 13', '--ignore-case', '--timeout-ms', '10000')
      expect(lowered).toMatchObject({ code: 0, stdout: 'ALL 13 PASSED\n' })
      const exact = await output(session.id, 'all 13', '--timeout-ms', '1000')
      expect(exact.code).toBe(1)

      e2e.print('claude', `${LONG_LINE}\r\n`)
      await waitFor(async () => (await output(session.id, ' end$', '--timeout-ms', '200')).code === 0, 15_000, 'the long line to be drawn')
      const wrapped = await output(session.id, 'start a+ end', '--timeout-ms', '10000')
      expect(wrapped).toMatchObject({ code: 0, stdout: `${LONG_LINE}\n` })
    },
    90_000
  )

  test(
    'SC-31: recent scrollback, bad patterns, timeouts and exits',
    async () => {
      const session = await newSession(e2e, 'codex')
      await startOf(e2e, 'codex', session.id)

      e2e.print('codex', `needle-a\r\n${filler(150)}\r\n`)
      await waitFor(async () => (await output(session.id, 'filler 149', '--timeout-ms', '200')).code === 0, 15_000, 'the first scroll')
      expect(await output(session.id, 'needle-a', '--timeout-ms', '5000')).toMatchObject({ code: 0, stdout: 'needle-a\n' })

      e2e.print('codex', `needle-b\r\n${filler(250)}\r\n`)
      await waitFor(async () => (await output(session.id, 'filler 249', '--timeout-ms', '200')).code === 0, 15_000, 'the second scroll')
      expect((await output(session.id, 'needle-b', '--timeout-ms', '1000')).code).toBe(1)
      expect(await output(session.id, 'needle-b', '--lines', '300', '--timeout-ms', '5000')).toMatchObject({ code: 0, stdout: 'needle-b\n' })

      // a session that does not exist shows the pattern is rejected before the daemon is asked
      for (const [pattern, problem] of [
        ['([a-z', 'does not compile'],
        ['(a+)+$', 'repeats a group that can match in more than one way']
      ] as const) {
        const bad = await output('nosuch', pattern)
        expect(bad.code).toBe(2)
        expect(bad.stderr).toContain(problem)
        await expect(e2e.call('quirky.agent-status/waitOutput', { session: session.id, pattern, timeoutMs: 1000 })).rejects.toMatchObject({ code: -32602 })
      }

      const unmatched = await output(session.id, 'no such line anywhere', '--timeout-ms', '2000', '--json')
      expect(unmatched.code).toBe(1)
      expect(JSON.parse(unmatched.stdout)).toEqual({ status: 'timeout', pattern: 'no such line anywhere' })
      expect(unmatched.ms).toBeGreaterThanOrEqual(1900)
      const unmatchedText = await output(session.id, 'no such line anywhere', '--timeout-ms', '1000')
      expect(unmatchedText.stdout).toBe('timed out after 1s; no line matched no such line anywhere\n')

      const last = await newSession(e2e, 'gemini')
      const printing = await output(last.id, 'final: ok', '--timeout-ms', '30000')
      expect(printing).toMatchObject({ code: 0, stdout: 'final: ok\n' })
      await waitFor(async () => (await e2e.cli(['session', 'get', last.id, '--json'])).stdout.includes('"exited"'), 15_000, 'the gemini session to exit')

      const silent = await newSession(e2e, 'opencode')
      const never = await output(silent.id, 'never printed', '--timeout-ms', '30000', '--json')
      expect(never.code).toBe(1)
      expect(JSON.parse(never.stdout)).toMatchObject({ error: { code: 'conflict', reason: 'session-exited' } })
    },
    120_000
  )
})

describe('SC-41: a pattern that runs too long is cut off', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E({ fakes: { claude: { raw: true, steps: [{ afterMs: 100, write: `${'a'.repeat(150)}!\r\n` }] } } })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'a slow rule file is ignored with the reason, a slow wait pattern is invalid-params, and the daemon keeps answering',
    async () => {
      const dir = join(e2e.home, 'agent-rules')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, 'claude.json')
      writeFileSync(file, JSON.stringify({ agent: 'claude', rules: [{ id: 'slow', state: 'working', region: 'screen', all: [{ regex: 'a+a+a+a+$' }] }] }))

      const session = await newSession(e2e, 'claude')
      await startOf(e2e, 'claude', session.id)
      await waitFor(async () => (await e2e.cli(['agent-status', 'wait', session.id, '--output', 'a!$', '--timeout-ms', '200'])).code === 0, 15_000, 'the long run of a to be drawn')

      const [explained, other] = await Promise.all([e2e.cli(['agent-status', 'explain', session.id]), e2e.cli(['session', 'list', '--json'])])
      expect(other.code).toBe(0)
      expect(explained.code).toBe(0)
      expect(explained.stdout).toContain(`warning: ignored user ${file}: a pattern ran longer than 250 ms`)
      expect(explained.stdout).toContain('screen: no rule matched (built-in')

      const listed = await e2e.cli(['agent-status', 'rules', 'list'])
      expect(listed.code).toBe(0)
      expect(listed.stdout).toContain(`  ignored user ${file}: a pattern ran longer than 250 ms`)
      const listings = await cliJson<{ agent: string; origin: { kind: string } | null; ignored: { origin: { kind: string; path: string }; reason: string }[] }[]>(e2e, ['agent-status', 'rules', 'list'])
      expect(listings.find((entry) => entry.agent === 'claude')).toMatchObject({
        origin: { kind: 'built-in' },
        ignored: [{ origin: { kind: 'user', path: file }, reason: 'a pattern ran longer than 250 ms' }]
      })

      const slow = await timed(() => e2e.cli(['agent-status', 'wait', session.id, '--output', 'a+a+a+a+$', '--timeout-ms', '10000', '--json']))
      expect(slow.code).toBe(1)
      const failure = JSON.parse(slow.stdout) as { error: { code: string; message: string } }
      expect(failure.error.code).toBe('invalid-params')
      expect(failure.error.message).toContain('pattern is too slow')
      expect(failure.error.message).toContain('a+a+a+a+$')
      expect(slow.ms).toBeLessThan(8000)

      expect((await e2e.cli(['session', 'list'])).code).toBe(0)
      expect(await e2e.cli(['agent-status', 'wait', session.id, '--output', 'a!$', '--timeout-ms', '5000'])).toMatchObject({ code: 0 })
    },
    90_000
  )
})
