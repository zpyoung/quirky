import { useEffect, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'

/** One agent as `quirky.agents/list` reports it, with the fields the AI actions need. */
export type AgentInfo = { id: string; label: string; installed: boolean; enabled: boolean; isDefault: boolean; canGenerate: boolean }

export type AgentList = { defaultAgent: string; agents: AgentInfo[] }

/** Whether a launch can start the agent: detected on this machine and not switched off. */
export const isUsable = (agent: AgentInfo): boolean => agent.installed && agent.enabled

/** The agents a commit message can come from: usable ones that have a one-shot shape. */
export const generators = (list: AgentList): AgentInfo[] => list.agents.filter((agent) => isUsable(agent) && agent.canGenerate)

/** The agent a dialog starts on: the default agent when it is among `choices`, else the first one, else none. */
export function initialAgent(list: AgentList, choices: AgentInfo[]): string {
  return choices.find((agent) => agent.id === list.defaultAgent)?.id ?? choices[0]?.id ?? ''
}

export type Agents = {
  /** Null until the first read finishes, and after a read that failed. */
  list: AgentList | null
  /** True once a read finished, whether or not it worked. */
  settled: boolean
}

/**
 * The agents Quirky can launch, read when `active` turns on and again whenever the agents
 * plugin announces a change.
 */
export function useAgents(context: UiPluginContext, active: boolean): Agents {
  const [state, setState] = useState<Agents>({ list: null, settled: false })
  useEffect(() => {
    if (!active) return
    let alive = true
    const read = async () => {
      try {
        const result = (await context.call('quirky.agents/list', {})) as AgentList
        if (alive) setState({ list: result, settled: true })
      } catch {
        if (alive) setState((prev) => (prev.settled ? prev : { list: null, settled: true }))
      }
    }
    void read()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.agents/changed') void read()
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [context, active])
  return state
}
