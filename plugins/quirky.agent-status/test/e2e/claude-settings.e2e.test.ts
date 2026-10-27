import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  /** Launches a claude session and returns the hook events in the `--settings` file it was given. */
  async function launchedEvents(): Promise<string[]> {
    const session = await newSession(e2e, 'claude')
    const started = await startOf(e2e, 'claude', session.id)
    const at = started.argv.indexOf('--settings')
    expect(at).toBeGreaterThanOrEqual(0)
    const file = started.argv[at + 1]!
    expect(file.startsWith(join(e2e.home, 'plugin-data', 'quirky.agent-status'))).toBe(true)
    const settings = JSON.parse(readFileSync(file, 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> }
    for (const entries of Object.values(settings.hooks)) {
      expect(entries[0]!.hooks[0]!.command).toContain('"$QUIRKY_HOME/bin/quirky-hook" claude; exit 0')
    }
    return Object.keys(settings.hooks).sort()
  }

  /** A new daemon on the same homes with the fake claude reporting `version`; the version is kept for the life of a daemon. */
  async function relaunchWith(behavior: FakeBehavior) {
    e2e.addFake('claude', behavior)
    await e2e.restartDaemon()
  }

  test(
    'claude 1.0.60, 2.1.300 and an unreadable version each get their own event set, and ~/.claude is never written',
    async () => {
      expect(await launchedEvents()).toEqual([...AT_1_0_60].sort())

      await relaunchWith({ version: { stdout: '2.1.300 (Claude Code)' } })
      const full = await launchedEvents()
      expect(full).toEqual([...FULL_SET].sort())
      expect(full).not.toContain('PreCompact')

      await relaunchWith({ version: { stdout: '', exitCode: 1 } })
      expect(await launchedEvents()).toEqual([...AT_1_0_60, 'SessionStart'].sort())

      expect(existsSync(join(e2e.userHome, '.claude'))).toBe(false)
    },
    90_000
  )
})
