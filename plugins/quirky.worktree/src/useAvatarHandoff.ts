import { useCallback, useEffect, useRef, useState } from 'react'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function handoffCommandId(value: unknown): string | null {
  const commands = objectRecord(value)?.commands
  if (!Array.isArray(commands)) return null
  for (const entry of commands) {
    const id = objectRecord(entry)?.id
    if (id === 'command:quirky.avatar/handoff' || id === 'quirky.avatar/handoff') return id
  }
  return null
}

/** Opens the avatar's hand-off sheet for the given worktrees, or null while this window has no hand-off command loaded. */
export function useAvatarHandoff(context: UiPluginContext): ((worktreeIds: string[]) => void) | null {
  const [commandId, setCommandId] = useState<string | null>(null)
  const latestLoad = useRef(0)
  const load = useCallback(async () => {
    const ticket = ++latestLoad.current
    try {
      const nextCommandId = handoffCommandId(await context.call('ui.contributions', {}))
      if (ticket !== latestLoad.current) return
      setCommandId(nextCommandId)
    } catch {
      if (ticket === latestLoad.current) setCommandId(null)
    }
  }, [context])

  useEffect(() => {
    void load()
    const unsubscribe = context.subscribe((event: QuirkyEvent) => {
      if (event.type === 'plugin.changed') void load()
    })
    const stopConnection = context.onConnection((status) => {
      if (status === 'connected') void load()
    })
    return () => {
      latestLoad.current += 1
      unsubscribe()
      stopConnection()
    }
  }, [context, load])

  const handoff = useCallback((worktreeIds: string[]) => {
    if (commandId === null) return
    void context.executeCommand(commandId, { worktreeIds }).catch((error: unknown) => {
      context.toast('Could not hand off to Avatar', error instanceof Error ? error.message : String(error))
    })
  }, [commandId, context])

  return commandId === null ? null : handoff
}
