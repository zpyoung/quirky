import { useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { object } from './model'
import type { AgentActivity } from './row-status'

const NO_ACTIVITY: ReadonlyMap<string, AgentActivity> = new Map()

function parseActivity(value: unknown): Map<string, AgentActivity> {
  const activity = new Map<string, AgentActivity>()
  const cards = object(value)?.cards
  if (!Array.isArray(cards)) return activity
  for (const card of cards) {
    const entry = object(card)
    const thread = object(entry?.thread)
    const bucket = entry?.bucket
    if (bucket !== 'attention' && bucket !== 'working') continue
    if (typeof thread?.worktreeId !== 'string' || typeof thread.agent !== 'string' || typeof thread.label !== 'string') continue
    const known = activity.get(thread.worktreeId)
    if (known?.bucket === 'attention' || (known && bucket === 'working')) continue
    activity.set(thread.worktreeId, { bucket, agent: thread.agent, label: thread.label })
  }
  return activity
}

/**
 * Agent activity per worktree, for the compact rows' dots. Only `attention` and `working` cards
 * count, and a worktree with both reports attention. It re-reads when the agent-status plugin
 * announces a change, and any failure, including that plugin being disabled, gives an empty map
 * with no error UI, because Tasks has to work without agent status.
 */
export function useAgentActivity(context: UiPluginContext): ReadonlyMap<string, AgentActivity> {
  const [activity, setActivity] = useState<ReadonlyMap<string, AgentActivity>>(NO_ACTIVITY)
  const generation = useRef(0)

  useEffect(() => {
    const read = async () => {
      const request = ++generation.current
      try {
        const next = parseActivity(await context.call('quirky.agent-status/dashboard', {}))
        if (request === generation.current) setActivity(next)
      } catch {
        if (request === generation.current) setActivity(NO_ACTIVITY)
      }
    }
    void read()
    const off = context.subscribe((event) => {
      if (event.type === 'quirky.agent-status/activityChanged') void read()
    })
    return () => {
      generation.current += 1
      off()
    }
  }, [context])

  return activity
}
