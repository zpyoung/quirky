import { readFile } from 'node:fs/promises'
import { getAppEnvironment } from '../../../shared/app-environment'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import {
  activateAgentStateRules,
  BUNDLED_AGENT_STATE_RULES,
  getActiveAgentStateRules,
  overlayOnBundledAgentStateRules,
  type ActiveAgentStateRules,
  type AgentStateRulesSource
} from './active-agent-state-rules'
import { parseAgentStateRulesBundle, type AgentStateRulesBundle } from './agent-state-rules-bundle'

type OverrideSettings = Pick<GlobalSettings, 'agentStateRulesPath'>

export type AgentStateRulesOverrideDeps = {
  readSettings: () => OverrideSettings
  /** Called when the active version or source changes, for diagnostics and crash reports. */
  onActivated: (rules: { version: number; source: AgentStateRulesSource }) => void
}

function warn(message: string): void {
  console.warn(`[agent-state-rules] ${message}`)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function readOverrideBundle(path: string): Promise<AgentStateRulesBundle | null> {
  const label = `override ${path}`
  try {
    const parsed = parseAgentStateRulesBundle(await readFile(path, 'utf8'))
    if (!parsed.ok) {
      warn(`${label} rejected: ${parsed.error}`)
      return null
    }
    return parsed.bundle
  } catch (error) {
    warn(`${label} unreadable: ${describeError(error)}`)
    return null
  }
}

/**
 * Keeps the active agent state rules at the bundled in-tree rules, or at a local override file
 * when `agentStateRulesPath` is set. Nothing is downloaded; a rejected override keeps the
 * bundled rules active.
 */
export class AgentStateRulesOverride {
  // Why an identity per start: a settings change restarts while an earlier read may still be
  // pending, and a superseded one must not change the active rules.
  private run: object | null = null

  constructor(private readonly deps: AgentStateRulesOverrideDeps) {}

  /** Loads the override file. Re-run it when the setting it reads changes. */
  async start(): Promise<void> {
    const run = {}
    this.run = run
    const overridePath = this.deps.readSettings().agentStateRulesPath
    const override = overridePath ? await readOverrideBundle(overridePath) : null
    if (this.run !== run) {
      return
    }
    this.activate(override)
  }

  stop(): void {
    this.run = null
  }

  private activate(override: AgentStateRulesBundle | null): void {
    const previous = getActiveAgentStateRules()
    const next: ActiveAgentStateRules = override
      ? {
          files: overlayOnBundledAgentStateRules(override.files),
          version: override.version,
          source: 'override'
        }
      : BUNDLED_AGENT_STATE_RULES
    activateAgentStateRules(next)
    if (previous.version !== next.version || previous.source !== next.source) {
      this.deps.onActivated({ version: next.version, source: next.source })
    }
  }
}

type SettingsStore = {
  getSettings: () => OverrideSettings
  onSettingsChanged: (listener: (updates: Partial<GlobalSettings>) => void) => unknown
}

/** Applies the local override on this host, and again whenever the setting changes. */
export function startAgentStateRulesOverride(
  store: SettingsStore,
  onActivated: AgentStateRulesOverrideDeps['onActivated']
): void {
  const environment = getAppEnvironment()
  const override = new AgentStateRulesOverride({
    readSettings: () => store.getSettings(),
    onActivated
  })
  void override.start()
  store.onSettingsChanged((updates) => {
    if ('agentStateRulesPath' in updates) {
      void override.start()
    }
  })
  environment.onWillQuit(() => override.stop())
}
