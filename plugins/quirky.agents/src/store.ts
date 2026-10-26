import type { PluginStore, StoreMigration } from '@quirky/protocol'
import { EMPTY_CONFIG, type AgentConfig } from './core/types'

type Row = { agent: string; disabled: number; command: string | null; args: string | null; env: string | null }

/** The store's schema; migration 1 creates the per-agent override table. */
export const agentMigrations: StoreMigration[] = [
  `CREATE TABLE agent_config (
    agent TEXT PRIMARY KEY,
    disabled INTEGER NOT NULL DEFAULT 0,
    command TEXT,
    args TEXT,
    env TEXT
  )`
]

function parseEnv(text: string | null): Record<string, string> | null {
  if (text === null) return null
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
    return Object.fromEntries(Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
  } catch {
    return null
  }
}

const toConfig = (row: Row): AgentConfig => ({
  disabled: row.disabled !== 0,
  command: row.command,
  args: row.args,
  env: parseEnv(row.env)
})

/** Whether two configs say the same thing; the key order of `env` does not matter. */
export function sameConfig(left: AgentConfig, right: AgentConfig): boolean {
  const envOf = (config: AgentConfig) => (config.env === null ? null : JSON.stringify(Object.entries(config.env).sort()))
  return (
    left.disabled === right.disabled &&
    left.command === right.command &&
    left.args === right.args &&
    envOf(left) === envOf(right)
  )
}

/** The user's saved overrides, one row per agent that has any. */
export class AgentConfigStore {
  constructor(private readonly store: PluginStore) {}

  get(id: string): AgentConfig {
    const row = this.store.get<Row>('SELECT * FROM agent_config WHERE agent = ?', id)
    return row ? toConfig(row) : { ...EMPTY_CONFIG }
  }

  all(): Map<string, AgentConfig> {
    const configs = new Map<string, AgentConfig>()
    for (const row of this.store.all<Row>('SELECT * FROM agent_config')) configs.set(row.agent, toConfig(row))
    return configs
  }

  /** Saves `config`, or deletes the row when it is no different from having none. */
  put(id: string, config: AgentConfig): void {
    if (sameConfig(config, EMPTY_CONFIG)) {
      this.store.run('DELETE FROM agent_config WHERE agent = ?', id)
      return
    }
    this.store.run(
      `INSERT INTO agent_config (agent, disabled, command, args, env) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(agent) DO UPDATE SET disabled = excluded.disabled, command = excluded.command,
         args = excluded.args, env = excluded.env`,
      id,
      config.disabled ? 1 : 0,
      config.command,
      config.args,
      config.env === null ? null : JSON.stringify(config.env)
    )
  }
}
