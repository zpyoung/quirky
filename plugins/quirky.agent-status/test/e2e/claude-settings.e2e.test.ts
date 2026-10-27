import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import { newSession, startOf, startStatusE2E, type FakeBehavior, type StatusE2E } from './support'

const AT_1_0_60 = ['PreToolUse', 'PostToolUse', 'Stop', 'SubagentStop', 'UserPromptSubmit']
const FULL_SET = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'TeammateIdle',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PostCompact',
  'SessionEnd'
]

describe('SC-28: Claude settings carry only the events the installed version knows', () => {
  let e2e: StatusE2E
  beforeAll(async () => {
    e2e = await startStatusE2E({ fakes: { claude: { version: { stdout: '1.0.60 (Claude Code)' } } } })
  }, 60_000)
  afterAll(() => e2e.cleanup())

  /** Parses the one effective JSON settings argument before any argument terminator. */
  function settingsFrom(argv: string[]): { hooks: Record<string, unknown[]>; statusLine?: Record<string, unknown>; [key: string]: unknown } {
    const terminator = argv.indexOf('--')
    const beforeTerminator = terminator < 0 ? argv : argv.slice(0, terminator)
    expect(beforeTerminator.filter((argument) => argument === '--settings')).toHaveLength(1)
    const at = beforeTerminator.indexOf('--settings')
    return JSON.parse(beforeTerminator[at + 1]!) as {
      hooks: Record<string, unknown[]>
      statusLine?: Record<string, unknown>
      [key: string]: unknown
    }
  }

  /** Launches a claude session and returns the event keys in its effective inline settings JSON. */
  async function launchedEvents(): Promise<string[]> {
    const session = await newSession(e2e, 'claude')
    const started = await startOf(e2e, 'claude', session.id)
    const settings = settingsFrom(started.argv)
    return Object.keys(settings.hooks).sort()
  }


  /** A new daemon on the same homes with the fake claude reporting `version`; the version is kept for the life of a daemon. */
  async function relaunchWith(behavior: FakeBehavior) {
    e2e.addFake('claude', behavior)
    await e2e.restartDaemon()
  }

  test(
    'claude 1.0.60, 2.1.300 and an unreadable version each get their own event set, while existing ~/.claude settings remain unchanged',
    async () => {
      const userSettings = `{
  "theme": "user-owned",
  "statusLine": { "type": "command", "command": "user-statusline" }
}
`
      e2e.put('.claude/settings.json', userSettings)
      expect(await launchedEvents()).toEqual([...AT_1_0_60].sort())

      await relaunchWith({ version: { stdout: '2.1.300 (Claude Code)' } })
      const full = await launchedEvents()
      expect(full).toEqual([...FULL_SET].sort())
      expect(full).not.toContain('PreCompact')

      await relaunchWith({ version: { stdout: '', exitCode: 1 } })
      expect(await launchedEvents()).toEqual([...AT_1_0_60, 'SessionStart'].sort())

      expect(e2e.read('.claude/settings.json')).toBe(userSettings)
    },
    90_000
  )
  test(
    'create and resume merge CLI JSON and file settings with managed hooks into one option',
    async () => {
      await e2e.cleanup()
      e2e = await startStatusE2E({ fakes: { claude: { version: { stdout: '2.1.300 (Claude Code)' } } } })
      const inline = {
        statusLine: { type: 'command', command: 'custom-statusline', padding: 4 },
        theme: 'inline',
        hooks: { Notification: [{ hooks: [{ type: 'command', command: 'user-notification' }] }] }
      }
      const path = e2e.put('claude-cli-settings.json', { statusLine: { format: 'unicode' }, fileSetting: true })
      const args = `--settings='${JSON.stringify(inline)}' --settings ${path}`
      await e2e.call('quirky.agents/configure', { agent: 'claude', args })

      const first = await newSession(e2e, 'claude')
      const firstStart = await startOf(e2e, 'claude', first.id)
      const firstSettings = settingsFrom(firstStart.argv)
      expect(firstSettings).toMatchObject({
        statusLine: { type: 'command', command: 'custom-statusline', padding: 4, format: 'unicode' },
        theme: 'inline',
        fileSetting: true,
        hooks: { Notification: [{ hooks: [{ type: 'command', command: 'user-notification' }] }] }
      })
      expect(firstSettings.hooks.Stop).toBeDefined()
      expect(first.launch?.args).toBe(args)

      await e2e.call('quirky.session/setProviderSession', { session: first.id, id: 'provider-session' })
      const resumed = (await e2e.call('quirky.session/resume', { session: first.id })) as Session
      const resumedStart = await startOf(e2e, 'claude', resumed.id)
      expect(settingsFrom(resumedStart.argv)).toEqual(firstSettings)
      expect(resumed.launch).toEqual(first.launch)
    },
    90_000
  )
})
