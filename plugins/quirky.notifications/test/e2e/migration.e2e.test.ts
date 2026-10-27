import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { startNotificationsE2E, waitFor, type NotificationsE2E } from './support'

const OLD_SWITCH = 'setting:quirky.agent-status/notifications'
const AGENT_TASK_COMPLETE = 'setting:quirky.notifications/agentTaskComplete'
const ENABLED = 'setting:quirky.notifications/enabled'

let n: NotificationsE2E
beforeAll(async () => {
  n = await startNotificationsE2E()
}, 90_000)
afterAll(() => n?.cleanup())

const settingValue = async (id: string) => ((await n.call('setting.get', { id })) as { value: unknown }).value

/**
 * Returns the home to its state before the notifications plugin first ran: the plugin's carry-over
 * flag and its own settings are dropped, then `seed` writes what an older Quirky would have left.
 */
function rewindToFirstRun(seed: (main: Database) => void): void {
  const main = new Database(join(n.e2e.home, 'quirky.db'))
  try {
    main.query('DELETE FROM setting_values WHERE id IN (?, ?, ?)').run(OLD_SWITCH, AGENT_TASK_COMPLETE, ENABLED)
    seed(main)
  } finally {
    main.close()
  }
  const plugin = new Database(join(n.e2e.home, 'plugin-data', 'quirky.notifications', 'store.db'))
  try {
    plugin.query('DELETE FROM done').run()
  } finally {
    plugin.close()
  }
}

async function restart(): Promise<void> {
  await n.e2e.restartDaemon()
  await n.reconnect()
}

describe('an old notifications switch carries over', () => {
  test(
    'SC-51: a stored false for the agent-status switch turns Agent Task Complete off, and an agent finish still marks',
    async () => {
      expect(await settingValue(AGENT_TASK_COMPLETE)).toBe(true)
      rewindToFirstRun((main) =>
        main
          .query('INSERT INTO setting_values (id, value, updated_at) VALUES (?, ?, ?)')
          .run(OLD_SWITCH, 'false', Date.now())
      )

      await restart()

      await waitFor(async () => (await settingValue(AGENT_TASK_COMPLETE)) === false, 15_000, 'Agent Task Complete to turn off')
      expect(await settingValue(ENABLED)).toBe(true)
      const listed = await n.json<{ id: string }[]>(['setting', 'list'])
      expect(listed.map((setting) => setting.id)).not.toContain(OLD_SWITCH)
      expect(listed.map((setting) => setting.id)).toContain(AGENT_TASK_COMPLETE)

      const wt = await n.worktree('sc51-a')
      const s = await n.claude(wt)
      const from = n.events.length
      await n.finish(s, 'done')
      const decided = await n.decision({ sessionId: s.id }, from)
      expect(decided.result).toBe('source-disabled')
      expect((await n.sessionRecord(s.id)).unread).toBe('agent')
      expect(n.notifies(from)).toEqual([])
    },
    120_000
  )

  test(
    'SC-51: v1\'s notifications: false arrives the same way',
    async () => {
      await n.e2e.cli(['setting', 'reset', AGENT_TASK_COMPLETE])
      expect(await settingValue(AGENT_TASK_COMPLETE)).toBe(true)
      rewindToFirstRun((main) => {
        main.query("INSERT OR REPLACE INTO settings (key, value) VALUES ('notifications', 'false')").run()
        main.query("DELETE FROM ui_state WHERE key = 'v1SettingsMigrated'").run()
      })

      await restart()

      await waitFor(async () => (await settingValue(AGENT_TASK_COMPLETE)) === false, 15_000, 'Agent Task Complete to turn off')
      expect(await settingValue(ENABLED)).toBe(true)
    },
    120_000
  )
})
