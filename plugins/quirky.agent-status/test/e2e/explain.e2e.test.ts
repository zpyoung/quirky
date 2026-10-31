import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Explanation } from '../../src/explain'
import type { RuleFile, RuleListing } from '../../src/rules/types'
import { cliJson, newSession, startOf, startStatusE2E, waitFor, type StatusE2E } from './support'

type Row = { sessionId: string; state: string; source: string; evidenceAt: number; because?: { source: string; rule: string; event?: string; at: number } }

/** The fake agents answer to their command names; cursor's is `cursor-agent`. */
const RAW = { raw: true } as const
const FAKES = { claude: RAW, codex: RAW, 'cursor-agent': RAW, gemini: RAW, aider: RAW }

const claude = (event: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: event, ...extra })
const bash = (command: string, extra: Record<string, unknown> = {}) => ({ tool_name: 'Bash', tool_input: { command }, ...extra })

const CLEAR = '\x1b[2J\x1b[H'
const titleOf = (title: string) => `\x1b]0;${title}\x07`
const drawn = (lines: string[], title?: string) => `${CLEAR}${title === undefined ? '' : titleOf(title)}${lines.join('\r\n')}`

const CURSOR_MENU = [
  ' ⬢ Cursor Agent',
  '',
  ' → run the install',
  '',
  '',
  ' $ npm install left-pad',
  '',
  ' Run this command?',
  ' Not in allowlist: npm install left-pad',
  ' → Run (once) (y)',
  '   Add Shell(npm) to allowlist? (tab)',
  '   Run Everything (shift+tab)',
  '   Skip & Tell the Agent What to Do (esc or n)'
]
const CURSOR_PLAIN = ['$ ready']
const CODEX_PLAN_MENU = [
  '• Proposed Plan',
  '',
  '  1. Extract the parser',
  '  2. Add tests',
  '',
  '  Implement this plan?',
  '',
  '› 1. Yes, implement this plan   Switch to Default and start coding.',
  '  2. No, stay in Plan mode      Continue planning with the model.',
  '',
  '  enter select · esc back'
]
const CODEX_HEADER = [
  '╭──────────────────────────────────────────────╮',
  '│ >_ OpenAI Codex (v0.157.0)                   │',
  '│                                              │',
  '│ model:     gpt-5.5   /model to change        │',
  '│ directory: ~/repo                            │',
  '╰──────────────────────────────────────────────╯',
  '',
  '› Ask Codex to do anything'
]
const CLAUDE_REST = ['● Done. I renamed the helper and updated its two callers.', '', '  ? for shortcuts']

const explainOf = (e2e: StatusE2E, session: string, at?: number) =>
  e2e.call('quirky.agent-status/explain', { session, ...(at === undefined ? {} : { at }) }) as Promise<Explanation>

/** Polls explain until `ready` holds, so a screen or title just printed has reached the daemon. */
async function explainUntil(e2e: StatusE2E, session: string, ready: (explained: Explanation) => boolean, what: string): Promise<Explanation> {
  return waitFor(async () => {
    const explained = await explainOf(e2e, session)
    return ready(explained) ? explained : undefined
  }, 20_000, what)
}

/** Waits until the session's visible screen holds `marker`. */
const screenHas = (e2e: StatusE2E, session: string, marker: string) =>
  waitFor(async () => {
    const screen = (await e2e.call('quirky.terminal/read', { session, lines: 0 })) as { lines: string[] }
    return screen.lines.some((line) => line.includes(marker))
  }, 15_000, `the screen to show ${marker}`)

const rowOf = (e2e: StatusE2E, session: string) => cliJson<Row | null>(e2e, ['agent-status', 'get', session])

const cliLines = (stdout: string) => stdout.split('\n').filter(Boolean)

const userRules = (e2e: StatusE2E, agent: string) => join(e2e.home, 'agent-rules', `${agent}.json`)

/** Writes a user rule file (an object as JSON, a string as is) and returns its path. */
function writeUserRules(e2e: StatusE2E, agent: string, body: unknown): string {
  mkdirSync(join(e2e.home, 'agent-rules'), { recursive: true })
  const path = userRules(e2e, agent)
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body))
  return path
}

describe('SC-1 to SC-4: explain names the evidence behind a state', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E({ fakes: FAKES, extraEnv: { QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: '0.5' } })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'SC-1: explain names the hook event behind a blocked Claude session',
    async () => {
      const session = await newSession(e2e, 'claude')
      const agent = await startOf(e2e, 'claude', session.id)
      await e2e.shim('claude', session.id, claude('UserPromptSubmit', { prompt: 'fix the tests' }), { pid: agent.pid })
      await e2e.shim('claude', session.id, claude('PermissionRequest', bash('npm test', { tool_use_id: 't1' })), { pid: agent.pid })
      const row = await waitFor(async () => {
        const found = await rowOf(e2e, session.id)
        return found?.state === 'waiting' ? found : undefined
      }, 10_000, 'the waiting row')
      const at = row.evidenceAt + 6000

      const text = await e2e.cli(['agent-status', 'explain', session.id, '--at', String(at)])
      expect(text.code).toBe(0)
      const lines = cliLines(text.stdout)
      expect(lines[0]).toBe('blocked: waiting for approval of Bash: npm test')
      expect(lines[1]).toBe('because: claude PermissionRequest → waiting (hook) 6s ago')
      expect(lines[2]).toBe('row: waiting, shown as waiting, source hook, fresh, last evidence 6s ago, detail Bash: npm test')
      expect(lines.some((line) => line.startsWith('fold:'))).toBe(false)
      expect(lines.at(-1)).toMatch(/^screen: no rule matched \(built-in .*[/\\]claude\.json\)$/)

      const json = await cliJson<Explanation>(e2e, ['agent-status', 'explain', session.id, '--at', String(at)])
      expect(json).toMatchObject({
        session: session.id,
        agent: 'claude',
        state: 'blocked',
        kind: 'approval',
        decidedBy: 'row',
        summary: 'blocked: waiting for approval of Bash: npm test',
        row: {
          state: 'waiting',
          display: 'waiting',
          detail: 'Bash: npm test',
          source: 'hook',
          fresh: true,
          ageMs: 6000,
          because: { source: 'hook', event: 'PermissionRequest', rule: 'claude PermissionRequest → waiting', at: row.evidenceAt }
        },
        screen: { verdict: null, ignored: [], origin: { kind: 'built-in' } }
      })
      expect(json.screen.origin).toMatchObject({ path: expect.stringMatching(/claude\.json$/) })
    },
    60_000
  )

  test(
    'SC-2: explain shows the fold that keeps a finished lead working',
    async () => {
      const session = await newSession(e2e, 'claude')
      const agent = await startOf(e2e, 'claude', session.id)
      await e2e.shim('claude', session.id, claude('UserPromptSubmit', { prompt: 'go' }), { pid: agent.pid })
      await e2e.shim('claude', session.id, claude('SubagentStart', { agent_id: 'a1' }), { pid: agent.pid })
      await e2e.shim('claude', session.id, claude('Stop', { last_assistant_message: 'launched' }), { pid: agent.pid })
      await waitFor(async () => {
        const explained = await explainOf(e2e, session.id)
        return explained.row?.lead.state === 'done'
      }, 10_000, 'the lead to finish')

      const explained = await explainOf(e2e, session.id)

      expect(explained).toMatchObject({
        state: 'working',
        decidedBy: 'row',
        row: { state: 'working', lead: { state: 'done' }, children: { agent: 1, shell: 0, cron: 0 } }
      })
      expect(explained.row!.lead.since).toBeGreaterThan(0)
      const text = await e2e.cli(['agent-status', 'explain', session.id])
      expect(cliLines(text.stdout).find((line) => line.startsWith('fold:'))).toMatch(/the lead is done since .*; 1 agent still running keep the row working/)
    },
    60_000
  )

  test(
    'SC-3: explain says a silent row is no longer trusted',
    async () => {
      const session = await newSession(e2e, 'codex')
      const agent = await startOf(e2e, 'codex', session.id)
      await e2e.shim('codex', session.id, claude('UserPromptSubmit', { prompt: 'go' }), { pid: agent.pid })
      const row = await waitFor(async () => {
        const found = await rowOf(e2e, session.id)
        return found?.state === 'working' ? found : undefined
      }, 10_000, 'the working row')

      const explained = await explainOf(e2e, session.id, row.evidenceAt + 34 * 60_000)

      expect(explained).toMatchObject({
        state: 'unknown',
        decidedBy: 'none',
        row: { display: 'unverifiable', label: 'No recent update', fresh: false, because: { event: 'UserPromptSubmit' } },
        summary: 'unknown: last evidence (hook event UserPromptSubmit) is 34 minutes old, past the 30 minutes limit, and no screen rule matched'
      })
      expect(explained.screen).toMatchObject({ verdict: null, origin: { kind: 'built-in' } })
    },
    60_000
  )

  describe('SC-4: explain names title, OSC 7501 and inferred evidence', () => {
    test(
      '(a) a title that reads as needs-attention',
      async () => {
        const session = await newSession(e2e, 'gemini')
        await startOf(e2e, 'gemini', session.id)
        e2e.print('gemini', titleOf('✋ gemini'))
        await waitFor(async () => (await rowOf(e2e, session.id))?.source === 'title', 10_000, 'the title row')

        const explained = await explainOf(e2e, session.id)

        expect(explained).toMatchObject({
          state: 'blocked',
          kind: 'approval',
          row: { source: 'title', because: { source: 'title', rule: 'title "✋ gemini" → permission' } }
        })
        const lines = cliLines((await e2e.cli(['agent-status', 'explain', session.id])).stdout)
        expect(lines[1]).toMatch(/^because: title "✋ gemini" → permission \(title\) \d+s ago$/)
      },
      60_000
    )

    test(
      '(b) an OSC 7501 report of a blocked permission',
      async () => {
        const shell = await newSession(e2e, 'shell')
        await e2e.call('quirky.terminal/write', { session: shell.id, data: `printf '\\033]7501;state=blocked:kind=permission\\007'\r` })
        await waitFor(async () => (await rowOf(e2e, shell.id))?.source === 'program-status', 10_000, 'the program-status row')

        const explained = await explainOf(e2e, shell.id)

        expect(explained).toMatchObject({
          state: 'blocked',
          kind: 'approval',
          row: { source: 'program-status', because: { source: 'program-status', rule: 'OSC 7501 blocked/permission → waiting' } }
        })
        const lines = cliLines((await e2e.cli(['agent-status', 'explain', shell.id])).stdout)
        expect(lines[1]).toMatch(/^because: OSC 7501 blocked\/permission → waiting \(program-status\) \d+s ago$/)
      },
      60_000
    )

    test(
      '(c) an interrupt inferred from Ctrl+C reads as idle',
      async () => {
        const session = await newSession(e2e, 'claude')
        const agent = await startOf(e2e, 'claude', session.id)
        await e2e.shim('claude', session.id, claude('UserPromptSubmit', { prompt: 'long task' }), { pid: agent.pid })
        await waitFor(async () => (await rowOf(e2e, session.id))?.state === 'working', 10_000, 'the working row')
        await e2e.call('quirky.terminal/write', { session: session.id, data: '\x03' })
        await waitFor(async () => (await rowOf(e2e, session.id))?.source === 'inference', 10_000, 'the inferred interrupt')

        const explained = await explainOf(e2e, session.id)

        expect(explained).toMatchObject({
          state: 'idle',
          decidedBy: 'row',
          row: { source: 'inference', because: { source: 'inference', rule: 'Ctrl+C settled with no hook → interrupted' } }
        })
        const lines = cliLines((await e2e.cli(['agent-status', 'explain', session.id])).stdout)
        expect(lines[0]).toBe('idle')
        expect(lines[1]).toMatch(/^because: Ctrl\+C settled with no hook → interrupted \(inference\) \d+s ago$/)
      },
      60_000
    )
  })
})

describe('SC-5 and SC-6: sessions without a row, exited, unknown, and a screen that outranks a hook', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E({ fakes: { ...FAKES, aider: { raw: true, exitAfterMs: 600, exitCode: 3 } }, extraEnv: { QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: '0.5' } })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'SC-5: explain with no row, an exited session and an unknown one',
    async () => {
      const cursor = await newSession(e2e, 'cursor')
      await startOf(e2e, 'cursor-agent', cursor.id)
      e2e.print('cursor-agent', drawn(CURSOR_PLAIN))
      await screenHas(e2e, cursor.id, '$ ready')

      const none = await e2e.cli(['agent-status', 'explain', cursor.id])
      expect(none.code).toBe(0)
      const noneLines = cliLines(none.stdout)
      expect(noneLines[0]).toBe('unknown: no hook, title or OSC 7501 report has arrived, and no screen rule matched')
      expect(noneLines).toContain('row: none')
      expect(noneLines.at(-1)).toMatch(/^screen: no rule matched \(built-in .*[/\\]cursor\.json\)$/)
      expect(await cliJson<Explanation>(e2e, ['agent-status', 'explain', cursor.id])).toMatchObject({
        state: 'unknown',
        decidedBy: 'none',
        row: null,
        agent: 'cursor',
        screen: { verdict: null, origin: { kind: 'built-in' } }
      })

      const gone = await newSession(e2e, 'aider')
      await startOf(e2e, 'aider', gone.id)
      await waitFor(async () => (await cliJson<{ status: string }>(e2e, ['session', 'get', gone.id])).status === 'exited', 15_000, 'the session to exit')
      const exited = await e2e.cli(['agent-status', 'explain', gone.id])
      expect(exited.code).toBe(0)
      expect(cliLines(exited.stdout)[0]).toBe('exited: the process ended with code 3')
      expect(await cliJson<Explanation>(e2e, ['agent-status', 'explain', gone.id])).toMatchObject({
        state: 'exited',
        decidedBy: 'session',
        exit: { code: 3, signal: null }
      })

      const missing = await e2e.cli(['agent-status', 'explain', 'nosuch'])
      expect(missing.code).toBe(1)
      expect(missing.stdout).toBe('')
      expect(missing.stderr).toContain('no such session: nosuch')
    },
    60_000
  )

  test(
    'SC-6: a screen approval menu outranks a working hook row',
    async () => {
      const session = await newSession(e2e, 'cursor')
      const agent = await startOf(e2e, 'cursor-agent', session.id)
      await e2e.shim('cursor', session.id, claude('preToolUse', { tool_name: 'Shell', tool_input: { command: 'rm -rf build' } }), { pid: agent.pid })
      await waitFor(async () => (await rowOf(e2e, session.id))?.state === 'working', 10_000, 'the working row')
      e2e.print('cursor-agent', drawn(CURSOR_MENU))

      const explained = await explainUntil(e2e, session.id, (found) => found.state === 'blocked', 'the menu to read as blocked')

      expect(explained).toMatchObject({
        state: 'blocked',
        kind: 'approval',
        decidedBy: 'rule',
        row: { state: 'working', display: 'working' },
        screen: { verdict: { rule: 'approval-menu', state: 'blocked', kind: 'approval', origin: { kind: 'built-in' } } },
        summary: 'blocked: waiting for approval (screen rule approval-menu)'
      })
      const text = cliLines((await e2e.cli(['agent-status', 'explain', session.id])).stdout)
      expect(text.find((line) => line.startsWith('screen:'))).toMatch(/^screen: rule approval-menu matched, blocked approval \(built-in .*[/\\]cursor\.json\)$/)
      expect(text.find((line) => line.startsWith('row:'))).toContain('working')
    },
    60_000
  )
})

describe('SC-8: built-in rules catch what hooks cannot', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E({ fakes: FAKES, extraEnv: { QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: '0.5' } })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'cursor menu, codex plan menu, claude rest title and gemini permission title give blocked, blocked, idle and blocked with no hook row',
    async () => {
      const cursor = await newSession(e2e, 'cursor')
      const codex = await newSession(e2e, 'codex')
      const claudeSession = await newSession(e2e, 'claude')
      const gemini = await newSession(e2e, 'gemini')
      for (const [fake, session] of [['cursor-agent', cursor], ['codex', codex], ['claude', claudeSession], ['gemini', gemini]] as const) await startOf(e2e, fake, session.id)

      e2e.print('cursor-agent', drawn(CURSOR_MENU, 'Cursor Agent'))
      e2e.print('codex', drawn(CODEX_PLAN_MENU, '~/repo'))
      e2e.print('claude', drawn(CLAUDE_REST, '✳ Claude Code'))
      e2e.print('gemini', titleOf('✋ gemini'))

      expect(await explainUntil(e2e, cursor.id, (found) => found.state === 'blocked', 'the cursor menu')).toMatchObject({
        state: 'blocked',
        kind: 'approval',
        decidedBy: 'rule',
        screen: { verdict: { rule: 'approval-menu' } }
      })
      expect(await explainUntil(e2e, codex.id, (found) => found.state === 'blocked', 'the codex menu')).toMatchObject({
        state: 'blocked',
        kind: 'question',
        decidedBy: 'rule',
        screen: { verdict: { rule: 'plan-implement-menu' } }
      })
      expect(await explainUntil(e2e, claudeSession.id, (found) => found.state === 'idle', 'the claude rest title')).toMatchObject({
        state: 'idle',
        decidedBy: 'rule',
        screen: { verdict: { rule: 'rest-title' } }
      })
      expect(await explainUntil(e2e, gemini.id, (found) => found.state === 'blocked', 'the gemini permission title')).toMatchObject({
        state: 'blocked',
        kind: 'approval',
        decidedBy: 'rule',
        screen: { verdict: { rule: 'permission-title' } }
      })
    },
    60_000
  )

  test(
    'a built-in rule file exists for each of the twelve agents',
    async () => {
      const listings = await cliJson<RuleListing[]>(e2e, ['agent-status', 'rules', 'list'])
      const builtIn = listings.filter((listing) => listing.origin?.kind === 'built-in').map((listing) => listing.agent)
      for (const agent of ['claude', 'codex', 'cursor', 'gemini', 'opencode', 'opencode2', 'pi', 'omp', 'prime-agent', 'cline', 'antigravity', 'hermes']) {
        expect(builtIn).toContain(agent)
      }
    },
    60_000
  )
})

describe('SC-9 and SC-10: user rule files', () => {
  let e2e: StatusE2E
  let session: string
  beforeAll(async () => {
    e2e = await startStatusE2E({ fakes: FAKES, extraEnv: { QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: '0.5' } })
    session = (await newSession(e2e, 'codex')).id
    await startOf(e2e, 'codex', session)
  }, 60_000)
  afterAll(() => e2e.cleanup())

  const held = { agent: 'codex', rules: [{ id: 'held', state: 'blocked', kind: 'question', region: 'screen', all: [{ contains: 'custom marker' }] }] }

  test(
    'SC-9: a user file overrides the whole set without a restart',
    async () => {
      e2e.print('codex', drawn(CODEX_HEADER, '~/repo'))
      expect(await explainUntil(e2e, session, (found) => found.state === 'idle', 'the built-in idle verdict')).toMatchObject({
        decidedBy: 'rule',
        screen: { verdict: { rule: 'header-ready', origin: { kind: 'built-in' } } }
      })

      const path = writeUserRules(e2e, 'codex', held)
      e2e.print('codex', drawn(['custom marker']))
      expect(await explainUntil(e2e, session, (found) => found.state === 'blocked', 'the user rule')).toMatchObject({
        kind: 'question',
        decidedBy: 'rule',
        screen: { verdict: { rule: 'held', origin: { kind: 'user', path } } }
      })
      const lines = cliLines((await e2e.cli(['agent-status', 'explain', session])).stdout)
      expect(lines.find((line) => line.startsWith('screen:'))).toBe(`screen: rule held matched, blocked question (user ${path})`)

      e2e.print('codex', drawn(CODEX_HEADER, '~/repo'))
      expect(await explainUntil(e2e, session, (found) => found.screen.verdict === null && found.state === 'unknown', 'no verdict from the idle screen')).toMatchObject({
        screen: { verdict: null, origin: { kind: 'user', path } }
      })

      rmSync(path)
      expect(await explainUntil(e2e, session, (found) => found.state === 'idle', 'the built-in rules back')).toMatchObject({
        screen: { verdict: { rule: 'header-ready', origin: { kind: 'built-in' } } }
      })
    },
    60_000
  )

  test.each([
    ['not JSON', 'this is not json', 'not valid JSON'],
    ['missing rules', { agent: 'codex' }, 'rules'],
    ['a repeated group', { agent: 'codex', rules: [{ id: 'bad', state: 'working', region: 'screen', all: [{ regex: '(a+)+$' }] }] }, 'repeats a group that can match in more than one way'],
    ['a backreference', { agent: 'codex', rules: [{ id: 'bad', state: 'working', region: 'screen', all: [{ regex: '(x)\\1' }] }] }, 'backreference'],
    ['an unknown state', { agent: 'codex', rules: [{ id: 'bad', state: 'asleep', region: 'screen', all: [{ contains: 'x' }] }] }, 'state']
  ] as const)(
    'SC-10: an invalid user file is ignored with a warning (%s)',
    async (_name, body, reason) => {
      e2e.print('codex', drawn(CODEX_HEADER, '~/repo'))
      const path = writeUserRules(e2e, 'codex', body)
      try {
        const explained = await explainUntil(e2e, session, (found) => found.state === 'idle', 'the built-in rules to apply')
        expect(explained.screen.verdict).toMatchObject({ rule: 'header-ready', origin: { kind: 'built-in' } })
        expect(explained.screen.ignored).toHaveLength(1)
        expect(explained.screen.ignored[0]).toMatchObject({ origin: { kind: 'user', path } })
        expect(explained.screen.ignored[0]!.reason).toContain(reason)

        const warnings = cliLines((await e2e.cli(['agent-status', 'explain', session])).stdout).filter((line) => line.startsWith('warning:'))
        expect(warnings).toEqual([`warning: ignored user ${path}: ${explained.screen.ignored[0]!.reason}`])

        const listing = (await cliJson<RuleListing[]>(e2e, ['agent-status', 'rules', 'list'])).find((entry) => entry.agent === 'codex')!
        expect(listing.origin).toMatchObject({ kind: 'built-in' })
        expect(listing.ignored).toHaveLength(1)
        expect(listing.ignored[0]!.reason).toContain(reason)
        const listed = cliLines((await e2e.cli(['agent-status', 'rules', 'list'])).stdout)
        expect(listed).toContain(`  ignored user ${path}: ${listing.ignored[0]!.reason}`)
      } finally {
        rmSync(path, { force: true })
      }
    },
    60_000
  )
})

describe('SC-11 and SC-12: plugin rules, rules list and rules show', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E({ fakes: FAKES, extraEnv: { QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: '0.5' } })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  test(
    'SC-11: a plugin ships rules, and the user still wins',
    async () => {
      const dir = join(e2e.userHome, 'plugin-src', 'acme-rules')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'quirky-plugin.json'),
        JSON.stringify({
          id: 'acme-rules',
          apiVersion: '1.0.0',
          name: 'Acme rules',
          version: '1.0.0',
          contributes: {
            'agent-rules': [{ id: 'aider', description: 'Aider rules from a plugin', rules: [{ id: 'busy', state: 'working', region: 'screen', all: [{ contains: 'aider is busy' }] }] }]
          }
        })
      )
      const installed = await e2e.cli(['plugin', 'install', dir, '--yes'])
      expect(installed.code).toBe(0)

      const session = await newSession(e2e, 'aider')
      await startOf(e2e, 'aider', session.id)
      e2e.print('aider', drawn(['aider is busy']))
      const fromPlugin = await explainUntil(e2e, session.id, (found) => found.screen.verdict !== null, 'the plugin rule')
      expect(fromPlugin).toMatchObject({ state: 'working', decidedBy: 'rule', screen: { verdict: { rule: 'busy', origin: { kind: 'plugin', plugin: 'acme-rules', contribution: 'aider' } } } })
      const text = cliLines((await e2e.cli(['agent-status', 'explain', session.id])).stdout)
      expect(text.find((line) => line.startsWith('screen:'))).toBe('screen: rule busy matched, working (plugin acme-rules aider)')
      const listed = cliLines((await e2e.cli(['agent-status', 'rules', 'list'])).stdout)
      expect(listed).toContain('aider  plugin acme-rules  aider  1 rules')

      const path = writeUserRules(e2e, 'aider', { agent: 'aider', rules: [{ id: 'mine', state: 'working', region: 'screen', all: [{ contains: 'aider is busy' }] }] })
      const fromUser = await explainUntil(e2e, session.id, (found) => found.screen.origin?.kind === 'user', 'the user rule')
      expect(fromUser).toMatchObject({ state: 'working', screen: { verdict: { rule: 'mine', origin: { kind: 'user', path } } } })
    },
    60_000
  )

  test(
    'SC-12: rules list and show',
    async () => {
      const claudePath = writeUserRules(e2e, 'claude', 'nope')

      const listed = await e2e.cli(['agent-status', 'rules', 'list'])
      expect(listed.code).toBe(0)
      const lines = cliLines(listed.stdout)
      const cursorLine = lines.find((line) => line.startsWith('cursor  '))
      expect(cursorLine).toMatch(/^cursor {2}built-in {2}.*[/\\]cursor\.json {2}3 rules$/)
      expect(lines.find((line) => line.startsWith('codex  '))).toMatch(/^codex {2}built-in {2}.*[/\\]codex\.json {2}2 rules$/)
      const claudeAt = lines.findIndex((line) => line.startsWith('claude  '))
      expect(lines[claudeAt]).toMatch(/^claude {2}built-in {2}.*[/\\]claude\.json {2}3 rules$/)
      expect(lines[claudeAt + 1]).toMatch(new RegExp(`^ {2}ignored user ${claudePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: not valid JSON`))

      const json = await cliJson<RuleListing[]>(e2e, ['agent-status', 'rules', 'list'])
      expect(json.find((entry) => entry.agent === 'cursor')).toMatchObject({ origin: { kind: 'built-in' }, rules: 3, ignored: [] })
      expect(json.find((entry) => entry.agent === 'claude')).toMatchObject({ origin: { kind: 'built-in' }, rules: 3, ignored: [{ origin: { kind: 'user', path: claudePath } }] })
      expect(json.map((entry) => entry.agent)).toEqual([...json.map((entry) => entry.agent)].sort())

      const shown = await e2e.cli(['agent-status', 'rules', 'show', 'cursor'])
      expect(shown.code).toBe(0)
      const shownLines = cliLines(shown.stdout)
      expect(shownLines[0]).toMatch(/^cursor {2}built-in .*[/\\]cursor\.json {2}Cursor Agent detection rules/)
      expect(shownLines.slice(1).map((line) => line.split('  ')[0])).toEqual(['approval-menu', 'prompt-busy', 'prompt-idle'])
      expect(shownLines[1]).toMatch(/^approval-menu {2}blocked approval {2}screen last 8 {2}/)
      const shownJson = await cliJson<{ agent: string; origin: { kind: string; path: string }; set: RuleFile }>(e2e, ['agent-status', 'rules', 'show', 'cursor'])
      expect(shownJson).toMatchObject({ agent: 'cursor', origin: { kind: 'built-in' }, set: { agent: 'cursor' } })
      expect(shownJson.origin.path).toMatch(/quirky\.agent-status[/\\]rules[/\\]cursor\.json$/)
      expect(shownJson.set.rules.map((rule) => rule.id)).toEqual(['approval-menu', 'prompt-busy', 'prompt-idle'])

      const none = await e2e.cli(['agent-status', 'rules', 'show', 'nosuchagent'])
      expect(none.code).toBe(1)
      expect(none.stderr).toContain('no detection rules for nosuchagent')
    },
    60_000
  )
})

describe('SC-13: rules are never downloaded', () => {
  let e2e: StatusE2E
  let proxy: Bun.TCPSocketListener<undefined>
  let connections = 0
  beforeAll(async () => {
    proxy = Bun.listen({
      hostname: '127.0.0.1',
      port: 0,
      socket: {
        open(socket) {
          connections += 1
          socket.end()
        },
        data() {}
      }
    })
    const address = `http://127.0.0.1:${proxy.port}`
    e2e = await startStatusE2E({
      fakes: FAKES,
      extraEnv: {
        QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: '0.5',
        HTTP_PROXY: address,
        HTTPS_PROXY: address,
        http_proxy: address,
        https_proxy: address,
        ALL_PROXY: address
      }
    })
  }, 60_000)
  afterAll(async () => {
    proxy?.stop(true)
    await e2e?.cleanup()
  })

  test(
    'listing, reading, overriding and reloading rules opens no network connection and every rule comes from a local file',
    async () => {
      const session = await newSession(e2e, 'codex')
      await startOf(e2e, 'codex', session.id)
      e2e.print('codex', drawn(CODEX_HEADER, '~/repo'))

      const listed = await cliJson<RuleListing[]>(e2e, ['agent-status', 'rules', 'list'])
      expect(listed.length).toBeGreaterThanOrEqual(12)
      for (const entry of listed) expect(entry.origin).toMatchObject({ kind: 'built-in', path: expect.stringMatching(/\.json$/) })
      expect((await e2e.cli(['agent-status', 'rules', 'show', 'codex'])).code).toBe(0)

      expect(await explainUntil(e2e, session.id, (found) => found.state === 'idle', 'the built-in rule')).toMatchObject({ screen: { verdict: { rule: 'header-ready', origin: { kind: 'built-in' } } } })
      const path = writeUserRules(e2e, 'codex', { agent: 'codex', rules: [{ id: 'held', state: 'blocked', kind: 'question', region: 'screen', all: [{ contains: 'custom marker' }] }] })
      e2e.print('codex', drawn(['custom marker']))
      expect(await explainUntil(e2e, session.id, (found) => found.state === 'blocked', 'the user rule')).toMatchObject({ screen: { verdict: { rule: 'held', origin: { kind: 'user', path } } } })
      rmSync(path)
      e2e.print('codex', drawn(CODEX_HEADER, '~/repo'))
      expect(await explainUntil(e2e, session.id, (found) => found.state === 'idle', 'the built-in rule again')).toMatchObject({ screen: { verdict: { origin: { kind: 'built-in' } } } })

      expect(connections).toBe(0)
    },
    60_000
  )
})
