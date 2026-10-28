import { useEffect, useState } from 'react'
import { RpcErrorCode, type UiPluginContext, type Worktree } from '@quirky/protocol'
import { isRecord } from './loop-status'
import type { AutomationAvailabilitySnapshot, AutomationAvailabilityStatus } from './report'

function availabilityError(error: unknown): AutomationAvailabilityStatus {
  if (isRecord(error) && error.code === RpcErrorCode.MethodNotFound) return 'unavailable'
  return 'error'
}

function definitionAvailability(error: unknown): AutomationAvailabilityStatus {
  if (isRecord(error) && error.code === RpcErrorCode.NotFound) return 'missing'
  return availabilityError(error)
}

async function readDefinition(context: UiPluginContext, automationId: string): Promise<AutomationAvailabilityStatus> {
  try {
    const value = await context.call('quirky.automations/show', { id: automationId })
    return isRecord(value) && value.id === automationId ? 'available' : 'error'
  } catch (error) {
    return definitionAvailability(error)
  }
}

async function readRunHistory(
  context: UiPluginContext,
  automationId: string,
  runId: string,
  isCurrent: () => boolean
): Promise<AutomationAvailabilityStatus | null> {
  let cursor: string | null = null
  const seenCursors = new Set<string>()
  try {
    while (isCurrent()) {
      const page = await context.call('quirky.automations/runs', {
        automationId,
        limit: 100,
        ...(cursor === null ? {} : { cursor })
      })
      if (!isCurrent()) return null
      if (!isRecord(page) || !Array.isArray(page.runs) || !(page.nextCursor === null || typeof page.nextCursor === 'string')) return 'error'
      for (const run of page.runs) {
        if (!isRecord(run) || typeof run.id !== 'string' || run.automationId !== automationId) return 'error'
        if (run.id === runId) return 'available'
      }
      if (page.nextCursor === null) return 'missing'
      if (page.nextCursor.length === 0 || seenCursors.has(page.nextCursor)) return 'error'
      seenCursors.add(page.nextCursor)
      cursor = page.nextCursor
    }
    return null
  } catch (error) {
    return availabilityError(error)
  }
}

function provenanceOf(worktree: Worktree | null): { automationId: string; runId: string } | null {
  const provenance = worktree?.automationProvenance
  return provenance?.kind === 'created-by-automation'
    ? { automationId: provenance.automationId, runId: provenance.runId }
    : null
}

/** Reads one expanded card's stored targets only; each request is invalidated on collapse, replacement, or plugin events. */
export function useAutomationAvailability(
  context: UiPluginContext,
  expandedWorktree: Worktree | null
): AutomationAvailabilitySnapshot | null {
  const [current, setCurrent] = useState<AutomationAvailabilitySnapshot | null>(null)
  const provenance = provenanceOf(expandedWorktree)
  const worktreeId = expandedWorktree?.id ?? null
  const automationId = provenance?.automationId ?? null
  const runId = provenance?.runId ?? null

  useEffect(() => {
    if (worktreeId === null || automationId === null || runId === null) {
      setCurrent(null)
      return
    }
    let active = true
    let request = 0
    const refresh = () => {
      const ticket = ++request
      const isCurrent = () => active && ticket === request
      setCurrent({ worktreeId, automationId, runId, definition: 'checking', runHistory: 'checking' })
      void readDefinition(context, automationId).then((definition) => {
        if (!isCurrent()) return
        setCurrent((previous) => previous?.worktreeId === worktreeId && previous.automationId === automationId && previous.runId === runId
          ? { ...previous, definition }
          : previous)
      })
      void readRunHistory(context, automationId, runId, isCurrent).then((runHistory) => {
        if (runHistory === null || !isCurrent()) return
        setCurrent((previous) => previous?.worktreeId === worktreeId && previous.automationId === automationId && previous.runId === runId
          ? { ...previous, runHistory }
          : previous)
      })
    }
    refresh()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'plugin.changed') {
        refresh()
        return
      }
      if (event.type !== 'quirky.automations/changed' || !isRecord(event.data) || event.data.automationId !== automationId) return
      refresh()
    })
    return () => {
      active = false
      request++
      unsubscribe()
    }
  }, [context, worktreeId, automationId, runId])

  if (worktreeId === null || automationId === null || runId === null) return null
  return current?.worktreeId === worktreeId && current.automationId === automationId && current.runId === runId
    ? current
    : { worktreeId, automationId, runId, definition: 'checking', runHistory: 'checking' }
}
