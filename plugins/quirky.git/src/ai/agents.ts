import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { messageOf } from '../panel/format'

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

/** Whether the custom command setting holds a command, so "Custom command" can run without any catalog agent. */
export function hasCustomCommand(context: UiPluginContext): boolean {
  try {
    return String(context.getSetting('ai-custom-command') ?? '').trim() !== ''
  } catch {
    return false
  }
}

export type Agents = {
  /** The last successfully read list, or null before the first successful read. */
  list: AgentList | null
  /** True once a read finished, whether or not it worked. */
  settled: boolean
  /** The latest read failure, cleared by a successful read. */
  error: string | null
  retry(): void
}

type AgentState = Omit<Agents, 'retry'>
async function readAgents(
  context: UiPluginContext,
  active: boolean,
  latest: MutableRefObject<number>,
  alive: MutableRefObject<boolean>,
  setState: Dispatch<SetStateAction<AgentState>>
): Promise<void> {
  if (!active || !alive.current) return
  const request = ++latest.current
  try {
    const result = (await context.call('quirky.agents/list', {})) as AgentList
    if (alive.current && request === latest.current) setState({ list: result, settled: true, error: null })
  } catch (error) {
    if (alive.current && request === latest.current) {
      setState((previous) => ({ ...previous, settled: true, error: messageOf(error) }))
    }
  }
}

/**
 * The agents Quirky can launch, read when `active` turns on and again whenever the agents
 * plugin announces a change. Stale reads never replace a newer result.
 */
export function useAgents(context: UiPluginContext, active: boolean): Agents {
  const [state, setState] = useState<AgentState>({ list: null, settled: false, error: null })
  const latest = useRef(0)
  const alive = useRef(false)

  function retry(): void {
    void readAgents(context, active, latest, alive, setState)
  }

  useEffect(() => {
    if (!active) return
    alive.current = true
    void readAgents(context, active, latest, alive, setState)
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.agents/changed') void readAgents(context, active, latest, alive, setState)
    })
    return () => {
      alive.current = false
      latest.current += 1
      unsubscribe()
    }
  }, [context, active, latest, alive, setState])

  return { ...state, retry }
}
