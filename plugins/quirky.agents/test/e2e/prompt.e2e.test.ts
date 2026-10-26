import { afterEach, expect, test } from 'bun:test'
import { startAgentsE2E, type E2E, type FakeBehavior, type FakeEvent } from '../support/e2e'

const BRACKETED_PASTE_ON = '\u001b[?2004h'
const TIME_SCALE = 0.1

let e2e: E2E | undefined
afterEach(async () => {
  await e2e?.cleanup()
  e2e = undefined
})

/** A fake that enables bracketed paste, prints a prompt line and goes quiet. */
const pasteFake: FakeBehavior = {
  raw: true,
  steps: [
    { afterMs: 50, write: BRACKETED_PASTE_ON },
    { afterMs: 10, write: '> \r\n' }
  ]
}

/** A fake whose output satisfies Codex's composer signal. */
const codexComposerFake: FakeBehavior = {
  raw: true,
  steps: [{ afterMs: 50, write: `${BRACKETED_PASTE_ON}› codex\r\n` }]
}

function startOf(events: FakeEvent[]): Extract<FakeEvent, { type: 'start' }> {
  const found = events.find((event) => event.type === 'start')
  if (found?.type !== 'start') throw new Error('the fake never started')
  return found
}

const inputChunks = (events: FakeEvent[]) =>
  events.flatMap((event) => (event.type === 'input' ? [{ text: Buffer.from(event.b64, 'base64').toString('utf8'), at: event.at }] : []))

const inputOf = (events: FakeEvent[]) =>
  inputChunks(events)
    .map((chunk) => chunk.text)
    .join('')

function createParams(prompt: string, agent: string, extra: Record<string, unknown> = {}) {
  return { worktree: `path:${e2e!.repo}`, agent, prompt, ...extra }
}

type SessionRecord = { id: string; status: string; promptDelivery: string | null; agent: string }

async function listed(sessionId: string): Promise<SessionRecord> {
  const result = await e2e!.cli(['session', 'list', '--json'])
  expect(result.code).toBe(0)
  const found = (JSON.parse(result.stdout) as SessionRecord[]).find((session) => session.id === sessionId)
  if (!found) throw new Error(`session ${sessionId} not listed`)
  return found
}

test(
  'SC-18: argv agents get the prompt literally on the command line',
  async () => {
    e2e = await startAgentsE2E({ fakes: { claude: true, codex: true, grok: true }, timeScale: TIME_SCALE })
    const cases = [
      { agent: 'claude', prompt: `it's "done"; echo $HOME`, tail: [`it's "done"; echo $HOME`] },
      { agent: 'codex', prompt: 'line one\nline two', tail: ['line one\nline two'] },
      { agent: 'grok', prompt: '--help', tail: ['--', '--help'] }
    ]
    for (const { agent, prompt, tail } of cases) {
      // a value starting with `-` must be attached with `=` or the parser reads it as a flag
      const promptArgs = prompt.startsWith('-') ? [`--prompt=${prompt}`] : ['--prompt', prompt]
      const created = await e2e.cli(['session', 'new', '--agent', agent, ...promptArgs, '--json'])
      expect(created.code).toBe(0)
      const session = JSON.parse(created.stdout) as SessionRecord
      expect(session.promptDelivery).toBe('command-line')

      const events = await e2e.waitForFakeLog(agent, (log) => log.some((event) => event.type === 'start'), 15_000)
      expect(startOf(events).argv.slice(-tail.length)).toEqual(tail)

      await Bun.sleep(300)
      expect(inputChunks(e2e.fakeLog(agent))).toEqual([])
      expect((await listed(session.id)).promptDelivery).toBe('command-line')
    }
  },
  60_000
)

test(
  'SC-19: flag modes put the prompt after their flag',
  async () => {
    e2e = await startAgentsE2E({ fakes: { opencode: true, gemini: true, copilot: true, hermes: true }, timeScale: TIME_SCALE })
    const prompt = 'fix the bug'
    const sessions: Record<string, SessionRecord> = {}
    for (const agent of ['opencode', 'gemini', 'copilot', 'hermes']) {
      sessions[agent] = (await e2e.call('quirky.session/create', createParams(prompt, agent))) as SessionRecord
      expect(sessions[agent]!.promptDelivery).toBe('command-line')
    }

    const argvOf = async (agent: string) => {
      const events = await e2e!.waitForFakeLog(agent, (log) => log.some((event) => event.type === 'start'), 15_000)
      return startOf(events)
    }
    expect((await argvOf('opencode')).argv.slice(-2)).toEqual(['--prompt', prompt])
    expect((await argvOf('gemini')).argv.slice(-2)).toEqual(['--prompt-interactive', prompt])
    expect((await argvOf('copilot')).argv.slice(-2)).toEqual(['-i', prompt])

    const hermes = await argvOf('hermes')
    expect(hermes.argv[0]).toBe('chat')
    expect(hermes.argv).toContain(`--query=${prompt}`)
    expect(hermes.argv.at(-1)).toBe('--tui')
    expect(hermes.env.HERMES_QUIRKY_STARTUP_QUERY).toBeUndefined()

    for (const agent of Object.keys(sessions)) expect(inputChunks(e2e.fakeLog(agent))).toEqual([])
  },
  60_000
)

test(
  'SC-26: a draft prompt is left in the input',
  async () => {
    e2e = await startAgentsE2E({ fakes: { claude: true, goose: pasteFake }, timeScale: TIME_SCALE })
    const prompt = 'look at #5'

    const claude = (await e2e.call('quirky.session/create', createParams(prompt, 'claude', { submitPrompt: false }))) as SessionRecord
    expect(claude.promptDelivery).toBe('command-line')
    const claudeStart = startOf(await e2e.waitForFakeLog('claude', (log) => log.some((event) => event.type === 'start'), 15_000))
    expect(claudeStart.argv.slice(-2)).toEqual(['--prefill', prompt])

    const goose = (await e2e.call('quirky.session/create', createParams(prompt, 'goose', { submitPrompt: false, waitForPrompt: true }))) as SessionRecord
    expect(goose.promptDelivery).toBe('pasted')
    // the 500 ms Enter delay has long passed on the scaled clock by now
    await Bun.sleep(500 * TIME_SCALE + 400)
    expect(inputOf(e2e.fakeLog('goose'))).toBe(`\u001b[200~${prompt}\u001b[201~`)
    expect(inputChunks(e2e.fakeLog('claude'))).toEqual([])
    expect((await listed(goose.id)).promptDelivery).toBe('pasted')
  },
  60_000
)

test(
  'SC-27: a prompt over 128 KiB is pasted instead of carried',
  async () => {
    e2e = await startAgentsE2E({ fakes: { codex: codexComposerFake }, timeScale: TIME_SCALE })
    const prompt = 'abcdefghij'.repeat(20_480)
    expect(Buffer.byteLength(prompt)).toBe(200 * 1024)

    const session = (await e2e.call('quirky.session/create', createParams(prompt, 'codex', { waitForPrompt: true }))) as SessionRecord
    expect(session.promptDelivery).toBe('pasted')

    const events = await e2e.waitForFakeLog('codex', (log) => inputOf(log).includes('\u001b[201~'), 15_000)
    const argv = startOf(events).argv
    expect(argv.join(' ')).not.toContain('abcdefghij')
    expect(argv.join(' ').length).toBeLessThan(500)

    const input = inputOf(events)
    const pasteEnd = input.indexOf('\u001b[201~')
    expect(input.startsWith('\u001b[200~')).toBe(true)
    expect(input.slice('\u001b[200~'.length, pasteEnd)).toBe(prompt)
    expect(input.indexOf('\u001b[200~', 1)).toBe(-1)
  },
  60_000
)

test(
  'SC-37: Claude Agent Teams runs Claude with in-process teammates',
  async () => {
    e2e = await startAgentsE2E({ fakes: { claude: pasteFake }, timeScale: TIME_SCALE })
    const prompt = 'plan the release'
    const created = await e2e.cli(['session', 'new', '--agent', 'claude-agent-teams', `--prompt=${prompt}`, '--wait', '--json'])
    expect(created.code).toBe(0)
    const session = JSON.parse(created.stdout) as SessionRecord
    expect(session.agent).toBe('claude-agent-teams')
    expect(session.promptDelivery).toBe('pasted')

    const events = await e2e.waitForFakeLog('claude', (log) => inputOf(log).includes('\u001b[201~'), 15_000)
    const start = startOf(events)
    expect(start.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS).toBe('1')
    expect(start.argv.slice(0, 3)).toEqual(['--teammate-mode', 'in-process', '--dangerously-skip-permissions'])
    expect(start.argv).not.toContain(prompt)
    expect(inputOf(events).startsWith(`\u001b[200~${prompt}\u001b[201~`)).toBe(true)
  },
  60_000
)
