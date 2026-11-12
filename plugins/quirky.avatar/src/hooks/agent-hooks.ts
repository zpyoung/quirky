import type { QuirkyEvent } from '@quirky/protocol'
import type { AvatarApp } from '../contracts'
import {
  installCodexHooks,
  installPiExtensions,
  isRealHomeInTest,
  removeCodexHooks,
  removePiExtensions,
  type AgentEnv
} from './install'

/** Keeps agent gate files aligned with detection and the hook setting without removing them on shutdown. */
export type AgentHooks = {
  /** Installs for present agents, or removes owned hooks when switched off; serialized and never rejects. */
  sync(): Promise<void>
  /** Resolves after all currently queued synchronization has settled. */
  idle(): Promise<void>
  /** Stops following settings and prevents later synchronization from touching agent files. */
  dispose(): void
}

const AGENT_HOOKS_SETTING = 'setting:quirky.avatar/agent-hooks'
const JUDGMENT_TIMEOUT_SETTING = 'setting:quirky.avatar/judgment-timeout-seconds'

type AgentListing = { agents?: unknown }
type ListedAgent = { id?: unknown; installed?: unknown; enabled?: unknown }

function presentAgents(listing: unknown): Set<string> {
  if (typeof listing !== 'object' || listing === null || Array.isArray(listing)) return new Set()

  const entries = (listing as AgentListing).agents
  if (!Array.isArray(entries)) return new Set()

  const agents = new Set<string>()
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const agent = entry as ListedAgent
    if (typeof agent.id !== 'string') continue
    if (agent.installed === true && agent.enabled !== false) agents.add(agent.id)
  }
  return agents
}

/** Follows live hook settings while keeping installation failures isolated between agent families. */
export function createAgentHooks(deps: { app: AvatarApp; agentEnv: AgentEnv }): AgentHooks {
  const { app, agentEnv } = deps
  let disposed = false
  let tail: Promise<void> = Promise.resolve()

  const logFailure = (prefix: string, error: unknown): void => {
    try {
      app.context.log(`${prefix}${error instanceof Error ? error.message : String(error)}`)
    } catch {
    }
  }

  const syncOne = async (): Promise<void> => {
    if (disposed || isRealHomeInTest(agentEnv)) return

    let switchedOff = false
    try {
      switchedOff = app.context.getSetting('agent-hooks') === false
    } catch {
    }

    if (switchedOff) {
      try {
        removeCodexHooks(agentEnv)
      } catch (error) {
        logFailure('avatar gate: could not remove the Codex hooks: ', error)
      }
      try {
        removePiExtensions(agentEnv)
      } catch (error) {
        logFailure('avatar gate: could not remove the pi and omp extension: ', error)
      }
      return
    }

    let listing: unknown
    try {
      listing = await app.context.call('quirky.agents/list', {})
    } catch (error) {
      logFailure('avatar gate: could not list agents: ', error)
      return
    }

    if (disposed) return

    const agents = presentAgents(listing)
    if (agents.has('codex')) {
      try {
        installCodexHooks(agentEnv, app.settings().judgmentTimeoutSeconds)
      } catch (error) {
        logFailure('avatar gate: could not install the Codex hooks: ', error)
      }
    }

    const piAgents = (['pi', 'omp'] as const).filter((agent) => agents.has(agent))
    if (piAgents.length > 0) {
      try {
        installPiExtensions(agentEnv, piAgents)
      } catch (error) {
        logFailure('avatar gate: could not install the pi and omp extension: ', error)
      }
    }
  }

  const sync = (): Promise<void> => {
    const next = tail.then(syncOne, syncOne).catch(() => undefined)
    tail = next
    return next
  }

  const unsubscribe = app.context.subscribe((event: QuirkyEvent) => {
    if (event.type !== 'setting.changed') return
    if (event.id !== AGENT_HOOKS_SETTING && event.id !== JUDGMENT_TIMEOUT_SETTING) return
    if (disposed) return
    return sync()
  })

  return {
    sync,
    idle: () => tail,
    dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
    }
  }
}
