import type { PluginContext, PluginStore, StoreMigration } from '@quirky/protocol'

export const migrations: StoreMigration[] = ['CREATE TABLE done (name TEXT PRIMARY KEY)']

const OLD_SWITCH = 'setting:quirky.agent-status/notifications'
const AGENT_TASK_COMPLETE = 'setting:quirky.notifications/agentTaskComplete'
const ONCE = 'agent-status-switch'

/**
 * Carries an old "notifications off" over to Agent Task Complete the first time this plugin runs.
 * The old setting is no longer declared, so only its stored value is read. A failed carry-over is
 * retried at the next start.
 */
export function carryOverOldSwitch(context: PluginContext, store: PluginStore): void {
  if (store.get('SELECT 1 FROM done WHERE name = ?', ONCE)) return
  if (context.storedSettingValue(OLD_SWITCH) === false) {
    void context
      .call('setting.set', { id: AGENT_TASK_COMPLETE, value: false })
      .then(() => store.run('INSERT OR IGNORE INTO done (name) VALUES (?)', ONCE))
      .catch((error) => context.log(`could not carry over the old notifications switch: ${error instanceof Error ? error.message : String(error)}`))
    return
  }
  store.run('INSERT OR IGNORE INTO done (name) VALUES (?)', ONCE)
}
