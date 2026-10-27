import { afterEach, describe, expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import { startAgentsE2E, type E2E, type FakeBehavior, type FakeEvent } from '../../quirky.agents/test/support/e2e'
import { SUPPRESSION_PROMPT } from '../src/core/claude-flags'

type Start = Extract<FakeEvent, { type: 'start' }>

let e2e: E2E | undefined

afterEach(async () => {
  await e2e?.cleanup()
  e2e = undefined
})

const claudeVersion = (stdout: string, exitCode = 0): FakeBehavior => ({ version: { stdout, exitCode } })

async function start(fakes: Record<string, FakeBehavior | true>): Promise<E2E> {
  e2e = await startAgentsE2E({ fakes })
  return e2e
}

async function newSession(harness: E2E, agent: string): Promise<Session> {
  const result = await harness.cli(['session', 'new', '--agent', agent, '--json'])
  if (result.code !== 0) throw new Error(`session new exited ${result.code}: ${result.stderr || result.stdout}`)
  return JSON.parse(result.stdout) as Session
}

/** The fake's launch for one session; a `--version` probe is logged as another event type and never matches. */
async function launchOf(harness: E2E, fake: string, sessionId: string): Promise<Start> {
  const events = await harness.waitForFakeLog(
    fake,
    (log) => log.some((event) => event.type === 'start' && event.env.QUIRKY_SESSION_ID === sessionId),
    15_000
  )
  return events.find((event): event is Start => event.type === 'start' && event.env.QUIRKY_SESSION_ID === sessionId)!
}

const count = (argv: string[], flag: string) => argv.filter((arg) => arg === flag).length

function expectBothPairsOnce(argv: string[]): void {
  expect(count(argv, '--disallowedTools')).toBe(1)
  expect(argv[argv.indexOf('--disallowedTools') + 1]).toBe('AskUserQuestion')
  expect(count(argv, '--append-system-prompt')).toBe(1)
  expect(argv[argv.indexOf('--append-system-prompt') + 1]).toBe(SUPPRESSION_PROMPT)
}

function expectNeitherPair(argv: string[]): void {
  expect(argv).not.toContain('--disallowedTools')
  expect(argv).not.toContain('AskUserQuestion')
  expect(argv).not.toContain('--append-system-prompt')
  expect(argv).not.toContain(SUPPRESSION_PROMPT)
}

describe('claude sessions use quirky ask', () => {
  test(
    'SC-25: a Claude launch gets the two suppression flag pairs once, and a codex launch gets neither',
    async () => {
      const harness = await start({ claude: claudeVersion('2.1.0 (Claude Code)'), codex: true })

      const claude = await newSession(harness, 'claude')
      const launched = await launchOf(harness, 'claude', claude.id)
      expect(SUPPRESSION_PROMPT).toBe('When you need to ask the user a question, run quirky ask (see quirky ask --help) instead of asking in chat.')
      expectBothPairsOnce(launched.argv)

      const codex = await newSession(harness, 'codex')
      const other = await launchOf(harness, 'codex', codex.id)
      expectNeitherPair(other.argv)
    },
    60_000
  )

  test(
    'SC-26: a Claude older than the floor launches without either pair',
    async () => {
      const harness = await start({ claude: claudeVersion('1.0.50') })
      const session = await newSession(harness, 'claude')
      expectNeitherPair((await launchOf(harness, 'claude', session.id)).argv)
    },
    60_000
  )

  test(
    'SC-26: a Claude whose --version exits 1 launches without either pair',
    async () => {
      const harness = await start({ claude: claudeVersion('2.1.0 (Claude Code)', 1) })
      const session = await newSession(harness, 'claude')
      expectNeitherPair((await launchOf(harness, 'claude', session.id)).argv)
    },
    60_000
  )

  test(
    'SC-26: flags already configured in an alias form are not doubled',
    async () => {
      const harness = await start({ claude: claudeVersion('2.1.0 (Claude Code)') })
      const configured = await harness.cli(['agents', 'configure', 'claude', '--args=--disallowed-tools=Bash --append-system-prompt-file p.md'])
      expect(configured.code).toBe(0)

      const session = await newSession(harness, 'claude')
      const { argv } = await launchOf(harness, 'claude', session.id)
      expect(argv).toContain('--disallowed-tools=Bash')
      expect(argv).toContain('--append-system-prompt-file')
      expectNeitherPair(argv)
    },
    60_000
  )

  test(
    'SC-26: a resumed Claude session carries each pair once',
    async () => {
      const harness = await start({ claude: claudeVersion('2.1.0 (Claude Code)') })
      const first = await newSession(harness, 'claude')
      await launchOf(harness, 'claude', first.id)
      const stored = await harness.cli(['session', 'set-provider-session', first.id, 'abc'])
      expect(stored.code).toBe(0)

      const resume = await harness.cli(['session', 'resume', first.id, '--json'])
      if (resume.code !== 0) throw new Error(`session resume exited ${resume.code}: ${resume.stderr || resume.stdout}`)
      const resumed = JSON.parse(resume.stdout) as Session

      const { argv } = await launchOf(harness, 'claude', resumed.id)
      expect(argv.slice(-2)).toEqual(['--resume', 'abc'])
      expectBothPairsOnce(argv)
    },
    60_000
  )
})
