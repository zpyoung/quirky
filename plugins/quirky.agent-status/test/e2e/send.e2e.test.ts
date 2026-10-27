import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import { cliJson, newSession, sessionOf, startOf, startStatusE2E, waitFor, type FakeBehavior, type StatusE2E } from './support'

const SCALE = 'QUIRKY_TEST_AGENT_STATUS_TIME_SCALE'

let e2e: StatusE2E | undefined
afterEach(async () => {
  await e2e?.cleanup()
  e2e = undefined
})

/** A daemon whose send timings (submit delay, start window, polls) run at `scale` of production speed. */
const begin = (fakes: Record<string, FakeBehavior>, scale: number) => startStatusE2E({ fakes, extraEnv: { [SCALE]: String(scale) } })

const claude = (event: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: event, ...extra })
const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...extra })
const ask = { questions: [{ question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] }] }

const paste = (text: string) => `\x1b[200~${text}\x1b[201~`
const isEnter = (chunk: string) => chunk === '\r'

const CURSOR_MENU =
  ['Cursor Agent', '', ' $ npm install left-pad', '', ' Run this command?', ' Not in allowlist: npm install left-pad', ' → Run (once) (y)', '   Add Shell(npm) to allowlist? (tab)', '   Run Everything (shift+tab)', '   Skip & Tell the Agent What to Do (esc or n)'].join('\r\n') +
  '\r\n'

/** Everything the fake agent `fake` received on its input, one string per write it saw, oldest first. */
const typed = (root: StatusE2E, fake: string): string[] =>
  root
    .fakeLog(fake)
    .flatMap((event) => (event.type === 'input' ? [Buffer.from(event.b64, 'base64').toString('utf8')] : []))

const inputTimes = (root: StatusE2E, fake: string): number[] => root.fakeLog(fake).flatMap((event) => (event.type === 'input' ? [event.at] : []))

/** Runs `act(n)` once for each Enter the fake receives, n counting from 1, until `stop` is called. */
function onEnter(root: StatusE2E, fake: string, act: (n: number) => Promise<unknown>): { stop(): Promise<void> } {
  let stopped = false
  let handled = 0
  const loop = (async () => {
    while (!stopped) {
      const seen = typed(root, fake).filter(isEnter).length
      while (handled < seen) void act(++handled).catch(() => {})
      await Bun.sleep(10)
    }
  })()
  return {
    async stop() {
      stopped = true
      await loop
    }
  }
}

/** Calls `act` once the fake has received a bracketed paste. */
function onPaste(root: StatusE2E, fake: string, act: () => void): void {
  void (async () => {
    await waitFor(() => typed(root, fake).some((chunk) => chunk.startsWith('\x1b[200~')), 20_000, 'a paste')
    act()
  })().catch(() => {})
}

const getRow = (root: StatusE2E, session: string) => cliJson<{ state: string } | null>(root, ['agent-status', 'get', session])

const rowIs = (root: StatusE2E, session: string, state: string) =>
  waitFor(async () => (await getRow(root, session))?.state === state, 10_000, `a ${state} row`)

type Explained = { state: string; kind?: string; screen: { verdict: { rule: string } | null }; row: { because: { event?: string } | null; lead: { state: string } } | null }
const explain = (root: StatusE2E, session: string) => root.call('quirky.agent-status/explain', { session }) as Promise<Explained>

/** A started claude session whose last turn finished, so its row is done. */
async function idleClaude(root: StatusE2E) {
  const session = await newSession(root, 'claude')
  const agent = await startOf(root, 'claude', session.id)
  await root.shim('claude', session.id, claude('UserPromptSubmit', { prompt: 'earlier' }), { pid: agent.pid })
  await root.shim('claude', session.id, claude('Stop', { last_assistant_message: 'ok' }), { pid: agent.pid })
  await rowIs(root, session.id, 'done')
  return { session, agent }
}

/** The error a daemon call settles with. */
async function rejection(call: Promise<unknown>): Promise<RpcError> {
  try {
    await call
  } catch (error) {
    if (error instanceof RpcError) return error
    throw error
  }
  throw new Error('expected the call to fail')
}

const sendCall = (root: StatusE2E, session: string, text: string, extra: Record<string, unknown> = {}) =>
  root.call('quirky.agent-status/send', { session, text, ...extra }) as Promise<{ session: string; state: string; kind?: string; sentAt: number; startedAt: number }>

/** A failed `--json` CLI run: its exit code and the error it printed. */
async function cliFailure(root: StatusE2E, args: string[]) {
  const result = await root.cli([...args, '--json'])
  const printed = JSON.parse(result.stdout) as { error: { code: string; message: string; reason?: string } }
  return { exit: result.code, ...printed.error }
}

describe('SC-14: send types a prompt into an idle agent and waits for it to start', () => {
  test(
    'SC-14: one bracketed paste, then a separate Enter after the submit delay, then working',
    async () => {
      e2e = await begin({ claude: { raw: true } }, 0.4)
      const { session, agent } = await idleClaude(e2e)
      const answering = onEnter(e2e, 'claude', () => e2e!.shim('claude', session.id, claude('UserPromptSubmit', { prompt: 'fix the tests' }), { pid: agent.pid }))

      const result = await e2e.cli(['agent-status', 'send', session.id, 'fix the tests'])
      await answering.stop()

      expect(result).toEqual({ code: 0, stdout: `${session.id}: working\n`, stderr: '' })
      expect(typed(e2e, 'claude')).toEqual([paste('fix the tests'), '\r'])
      const [pastedAt, enteredAt] = inputTimes(e2e, 'claude')
      expect(enteredAt! - pastedAt!).toBeGreaterThanOrEqual(150)
      expect((await getRow(e2e, session.id))?.state).toBe('working')
    },
    60_000
  )
})

describe('SC-15: send refuses an agent waiting for approval and types nothing', () => {
  test(
    'SC-15: agent-blocked naming the tool call, exit 1, nothing written',
    async () => {
      e2e = await begin({ claude: { raw: true } }, 0.4)
      const session = await newSession(e2e, 'claude')
      const agent = await startOf(e2e, 'claude', session.id)
      await e2e.shim('claude', session.id, claude('PermissionRequest', bash('rm -rf build', { tool_use_id: 't1' })), { pid: agent.pid })
      await rowIs(e2e, session.id, 'waiting')

      const failure = await cliFailure(e2e, ['agent-status', 'send', session.id, 'carry on'])
      const text = await e2e.cli(['agent-status', 'send', session.id, 'carry on'])

      expect(failure).toMatchObject({ exit: 1, code: 'conflict', reason: 'agent-blocked' })
      expect(failure.message).toContain('waiting for approval of Bash: rm -rf build')
      expect(text.code).toBe(1)
      expect(text.stderr).toContain('waiting for approval of Bash: rm -rf build')
      await Bun.sleep(300)
      expect(typed(e2e, 'claude')).toEqual([])
    },
    60_000
  )
})

describe('SC-16: send refuses an approval menu the hooks did not report', () => {
  test(
    'SC-16: agent-blocked naming the cursor rule, nothing written',
    async () => {
      e2e = await begin({ 'cursor-agent': { raw: true } }, 0.4)
      const session = await newSession(e2e, 'cursor')
      const agent = await startOf(e2e, 'cursor-agent', session.id)
      await e2e.shim('cursor', session.id, claude('preToolUse', { tool_name: 'Shell', tool_input: { command: 'npm install left-pad' } }), { pid: agent.pid })
      await rowIs(e2e, session.id, 'working')
      e2e.print('cursor-agent', CURSOR_MENU)
      await waitFor(async () => (await explain(e2e!, session.id)).state === 'blocked', 15_000, 'the approval menu to be read')

      const failure = await rejection(sendCall(e2e, session.id, 'carry on'))

      expect(failure.code).toBe(RpcErrorCode.Conflict)
      expect(failure.data).toMatchObject({ reason: 'agent-blocked' })
      expect(failure.message).toContain('screen rule approval-menu')
      await Bun.sleep(300)
      expect(typed(e2e, 'cursor-agent')).toEqual([])
    },
    60_000
  )
})

describe('SC-17: a question is refused the same way', () => {
  test(
    'SC-17: agent-blocked saying what the agent asks, nothing written',
    async () => {
      e2e = await begin({ claude: { raw: true } }, 0.4)
      const session = await newSession(e2e, 'claude')
      const agent = await startOf(e2e, 'claude', session.id)
      await e2e.shim('claude', session.id, claude('UserPromptSubmit', { prompt: 'go' }), { pid: agent.pid })
      await e2e.shim('claude', session.id, claude('PreToolUse', { tool_name: 'AskUserQuestion', tool_input: ask, tool_use_id: 'q1' }), { pid: agent.pid })
      await rowIs(e2e, session.id, 'waiting')

      const failure = await rejection(sendCall(e2e, session.id, 'carry on'))

      expect(failure.code).toBe(RpcErrorCode.Conflict)
      expect(failure.data).toMatchObject({ reason: 'agent-blocked' })
      expect(failure.message).toContain('waiting for an answer to "Which branch?"')
      await Bun.sleep(300)
      expect(typed(e2e, 'claude')).toEqual([])
    },
    60_000
  )
})

describe('SC-18: a prompt that never starts fails as stalled', () => {
  test(
    'SC-18: prompt-stalled after the default window, then after --start-timeout-ms, the text having been typed',
    async () => {
      e2e = await begin({ claude: { raw: true } }, 0.4)
      const { session } = await idleClaude(e2e)

      const first = Date.now()
      const stalled = await cliFailure(e2e, ['agent-status', 'send', session.id, 'fix the tests'])
      const firstMs = Date.now() - first

      expect(stalled).toMatchObject({ exit: 1, code: 'conflict', reason: 'prompt-stalled' })
      expect(stalled.message).toContain('typed')
      expect(stalled.message).toContain('may still pick it up')
      expect(firstMs).toBeGreaterThanOrEqual(1900)
      expect(typed(e2e, 'claude')).toEqual([paste('fix the tests'), '\r'])

      const second = Date.now()
      const again = await e2e.cli(['agent-status', 'send', session.id, 'again', '--start-timeout-ms', '700'])
      const secondMs = Date.now() - second

      expect(again.code).toBe(1)
      expect(again.stderr).toContain('may still pick it up')
      expect(secondMs).toBeGreaterThanOrEqual(700)
      expect(secondMs).toBeLessThan(firstMs)
      expect(typed(e2e, 'claude')).toEqual([paste('fix the tests'), '\r', paste('again'), '\r'])
    },
    60_000
  )
})

describe('SC-19: a working agent gets the prompt', () => {
  test(
    'SC-19: the prompt is typed and send returns working without waiting for a start',
    async () => {
      e2e = await begin({ codex: { raw: true } }, 0.4)
      const session = await newSession(e2e, 'codex')
      const agent = await startOf(e2e, 'codex', session.id)
      await e2e.shim('codex', session.id, claude('UserPromptSubmit', { prompt: 'long job' }), { pid: agent.pid })
      await rowIs(e2e, session.id, 'working')

      const started = Date.now()
      const result = await sendCall(e2e, session.id, 'and also this')

      expect(result.state).toBe('working')
      expect(Date.now() - started).toBeLessThan(1900)
      expect(typed(e2e, 'codex')).toEqual([paste('and also this'), '\r'])
    },
    60_000
  )
})

describe('SC-20: a start that blocks counts as started', () => {
  test(
    'SC-20: send reports blocked with its kind',
    async () => {
      e2e = await begin({ claude: { raw: true } }, 0.4)
      const { session, agent } = await idleClaude(e2e)
      const answering = onEnter(e2e, 'claude', () => e2e!.shim('claude', session.id, claude('PermissionRequest', bash('npm test', { tool_use_id: 't1' })), { pid: agent.pid }))

      const result = await sendCall(e2e, session.id, 'run it')
      await answering.stop()

      expect(result).toMatchObject({ session: session.id, state: 'blocked', kind: 'approval' })
    },
    60_000
  )

  test(
    'SC-20: the CLI prints the session, blocked and the kind',
    async () => {
      e2e = await begin({ claude: { raw: true } }, 0.4)
      const { session, agent } = await idleClaude(e2e)
      const answering = onEnter(e2e, 'claude', () => e2e!.shim('claude', session.id, claude('PermissionRequest', bash('npm test', { tool_use_id: 't1' })), { pid: agent.pid }))

      const result = await e2e.cli(['agent-status', 'send', session.id, 'run it'])
      await answering.stop()

      expect(result).toEqual({ code: 0, stdout: `${session.id}: blocked (approval)\n`, stderr: '' })
    },
    60_000
  )
})

describe('SC-21: send refuses shells and exited sessions', () => {
  test(
    'SC-21: not-an-agent, session-exited and not-found, each exit 1, nothing written',
    async () => {
      e2e = await begin({ claude: { raw: true, exitAfterMs: 500 } }, 0.4)
      const shell = await newSession(e2e, 'shell')
      const gone = await newSession(e2e, 'claude')
      await waitFor(async () => (await sessionOf(e2e!, gone.id)).status === 'exited', 15_000, 'the claude session to exit')

      const asShell = await cliFailure(e2e, ['agent-status', 'send', shell.id, 'NOT-TYPED-SENTINEL'])
      const asExited = await cliFailure(e2e, ['agent-status', 'send', gone.id, 'NOT-TYPED-SENTINEL'])
      const asUnknown = await cliFailure(e2e, ['agent-status', 'send', 'nosuch', 'NOT-TYPED-SENTINEL'])

      expect(asShell).toMatchObject({ code: 'conflict', reason: 'not-an-agent' })
      expect(asExited).toMatchObject({ code: 'conflict', reason: 'session-exited' })
      expect(asUnknown.code).toBe('not-found')
      expect([asShell.exit, asExited.exit, asUnknown.exit]).toEqual([1, 1, 1])
      await Bun.sleep(300)
      const screen = await e2e.cli(['terminal', 'read', shell.id])
      expect(screen.stdout).not.toContain('NOT-TYPED-SENTINEL')
      expect(typed(e2e, 'claude')).toEqual([])
    },
    60_000
  )
})

describe('SC-22: sends to one session take turns', () => {
  test(
    'SC-22: one whole paste and its Enter arrive before any of the other send, and both succeed',
    async () => {
      e2e = await begin({ claude: { raw: true } }, 0.4)
      const { session, agent } = await idleClaude(e2e)
      const answering = onEnter(e2e, 'claude', () => e2e!.shim('claude', session.id, claude('UserPromptSubmit', { prompt: 'x' }), { pid: agent.pid }))

      const results = await Promise.all([sendCall(e2e, session.id, 'first'), sendCall(e2e, session.id, 'second')])
      await answering.stop()

      expect(results.map((result) => result.state)).toEqual(['working', 'working'])
      const stream = typed(e2e, 'claude').join('')
      expect([paste('first') + '\r' + paste('second') + '\r', paste('second') + '\r' + paste('first') + '\r']).toContain(stream)
    },
    60_000
  )
})

describe('SC-23: a multi-line prompt is one prompt', () => {
  test(
    'SC-23: both lines travel in one bracketed paste, followed by one Enter',
    async () => {
      e2e = await begin({ claude: { raw: true } }, 0.4)
      const { session, agent } = await idleClaude(e2e)
      const answering = onEnter(e2e, 'claude', () => e2e!.shim('claude', session.id, claude('UserPromptSubmit', { prompt: 'x' }), { pid: agent.pid }))

      await sendCall(e2e, session.id, 'line one\nline two')
      await answering.stop()

      expect(typed(e2e, 'claude')).toEqual([paste('line one\rline two'), '\r'])
    },
    60_000
  )
})

describe('SC-24: a nested helper does not count as a start', () => {
  test(
    "SC-24: the helper's prompt is ignored, the send stalls and the lead's last event still decides",
    async () => {
      e2e = await begin({ claude: { raw: true } }, 0.4)
      const session = await newSession(e2e, 'claude')
      const lead = await startOf(e2e, 'claude', session.id)
      const own = { pid: lead.pid }
      await e2e.shim('claude', session.id, claude('SessionStart', { source: 'startup', session_id: 'abc' }), own)
      await e2e.shim('claude', session.id, claude('UserPromptSubmit', { prompt: 'fix the tests', session_id: 'abc' }), own)
      await e2e.shim('claude', session.id, claude('Stop', { session_id: 'abc', last_assistant_message: 'ok' }), own)
      await rowIs(e2e, session.id, 'done')
      // the helper is another live process of the same agent, with its own provider session
      const answering = onEnter(e2e, 'claude', () => e2e!.shim('claude', session.id, claude('UserPromptSubmit', { prompt: 'summarize this', session_id: 'zzz' }), { pid: process.pid }))

      const failure = await rejection(sendCall(e2e, session.id, 'go on', { startTimeoutMs: 1500 }))
      await answering.stop()

      expect(failure.code).toBe(RpcErrorCode.Conflict)
      expect(failure.data).toMatchObject({ reason: 'prompt-stalled' })
      const explained = await explain(e2e, session.id)
      expect(explained.row?.because?.event).toBe('Stop')
      expect(explained.row?.lead.state).toBe('done')
      expect(await getRow(e2e, session.id)).toMatchObject({ state: 'done', prompt: 'fix the tests' })
    },
    60_000
  )
})

describe('SC-38: an approval that appears before Enter stops the Enter', () => {
  test(
    'SC-38: no Enter is written and send says the text was pasted but not submitted',
    async () => {
      e2e = await begin({ 'cursor-agent': { raw: true } }, 1)
      const session = await newSession(e2e, 'cursor')
      const agent = await startOf(e2e, 'cursor-agent', session.id)
      await e2e.shim('cursor', session.id, claude('beforeSubmitPrompt', { prompt: 'earlier' }), { pid: agent.pid })
      await e2e.shim('cursor', session.id, claude('stop', { status: 'completed' }), { pid: agent.pid })
      await rowIs(e2e, session.id, 'done')
      onPaste(e2e, 'cursor-agent', () => e2e!.print('cursor-agent', CURSOR_MENU))

      const failure = await rejection(sendCall(e2e, session.id, 'rm everything'))

      expect(failure.code).toBe(RpcErrorCode.Conflict)
      expect(failure.data).toMatchObject({ reason: 'agent-blocked' })
      expect(failure.message).toContain('pasted but not submitted')
      expect(failure.message).toContain('waiting for approval')
      await Bun.sleep(600)
      expect(typed(e2e, 'cursor-agent')).toEqual([paste('rm everything')])
    },
    60_000
  )
})

describe('SC-39: a retried Enter is never written into an approval', () => {
  /** A user rule file so a codex screen can show an approval; the built-in codex rules only know the plan menu. */
  const approvalRules = (root: StatusE2E) => {
    mkdirSync(join(root.home, 'agent-rules'), { recursive: true })
    const rules = {
      agent: 'codex',
      rules: [{ id: 'approval-prompt', state: 'blocked', kind: 'approval', region: 'screen', lastLines: 6, all: [{ contains: 'allow command?' }] }]
    }
    writeFileSync(join(root.home, 'agent-rules', 'codex.json'), JSON.stringify(rules))
  }

  test(
    'SC-39: one Enter is written, send reports blocked, and no retry follows',
    async () => {
      e2e = await begin({ codex: { raw: true } }, 1)
      approvalRules(e2e)
      const session = await newSession(e2e, 'codex')
      const agent = await startOf(e2e, 'codex', session.id)
      await e2e.shim('codex', session.id, claude('UserPromptSubmit', { prompt: 'earlier' }), { pid: agent.pid })
      await e2e.shim('codex', session.id, claude('Stop', { last_assistant_message: 'ok' }), { pid: agent.pid })
      await rowIs(e2e, session.id, 'done')
      const answering = onEnter(e2e, 'codex', async () => {
        await Bun.sleep(300)
        e2e!.print('codex', 'Allow command?\r\n  rm -rf build\r\n')
      })

      const result = await sendCall(e2e, session.id, 'rm everything')
      await answering.stop()

      expect(result).toMatchObject({ state: 'blocked', kind: 'approval' })
      // the retry would fall at 1200 ms after the first Enter
      await Bun.sleep(1800)
      expect(typed(e2e, 'codex')).toEqual([paste('rm everything'), '\r'])
    },
    60_000
  )

  test(
    'SC-39: with nothing on screen the Enter is retried once and no more',
    async () => {
      e2e = await begin({ codex: { raw: true } }, 1)
      const session = await newSession(e2e, 'codex')
      const agent = await startOf(e2e, 'codex', session.id)
      await e2e.shim('codex', session.id, claude('UserPromptSubmit', { prompt: 'earlier' }), { pid: agent.pid })
      await e2e.shim('codex', session.id, claude('Stop', { last_assistant_message: 'ok' }), { pid: agent.pid })
      await rowIs(e2e, session.id, 'done')

      const failure = await rejection(sendCall(e2e, session.id, 'hello', { startTimeoutMs: 2500 }))

      expect(failure.data).toMatchObject({ reason: 'prompt-stalled' })
      expect(typed(e2e, 'codex')).toEqual([paste('hello'), '\r', '\r'])
    },
    60_000
  )
})

describe('SC-40: a turn that starts and ends inside the submit window still counts', () => {
  test(
    'SC-40: send reports idle, not a stall',
    async () => {
      // a large scale widens the poll after a start, so the Stop lands inside it whatever the shim's own latency
      e2e = await begin({ claude: { raw: true } }, 5)
      const { session, agent } = await idleClaude(e2e)
      const answering = onEnter(e2e, 'claude', async () => {
        await e2e!.shim('claude', session.id, claude('UserPromptSubmit', { prompt: 'quick' }), { pid: agent.pid })
        await e2e!.shim('claude', session.id, claude('Stop', { last_assistant_message: 'done' }), { pid: agent.pid })
      })

      const result = await sendCall(e2e, session.id, 'quick')
      await answering.stop()

      expect(result.state).toBe('idle')
      expect(typed(e2e, 'claude')).toEqual([paste('quick'), '\r'])
    },
    60_000
  )
})
