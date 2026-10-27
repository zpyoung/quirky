import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitCompare, GitStatus, UiPluginContext, Worktree } from '@quirky/protocol'
import { conflictBlocks } from '../view/conflict-markers'
import { dataOf, messageOf } from './format'
import type { GroupOrder } from './sections'

export const STATUS_POLL_MS = 3000
export const COMPARE_POLL_MS = 30_000

export type ViewMode = 'list' | 'tree'

const GROUP_ORDERS: readonly GroupOrder[] = ['changes-first', 'staged-first', 'untracked-first']
const VIEW_MODES: readonly ViewMode[] = ['list', 'tree']
const COMPARE_BASES = ['repository-default', 'branch-upstream'] as const

/** The settings the panel reads; each falls back to its default when the setting is missing or invalid. */
export type PanelSettings = { groupOrder: GroupOrder; viewMode: ViewMode; compareBase: string; aiEnabled: boolean }

function read<T extends string>(context: UiPluginContext, name: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = context.getSetting(name)
    return allowed.includes(value as T) ? (value as T) : fallback
  } catch {
    return fallback
  }
}

/** Whether Source Control AI actions show; a setting that cannot be read counts as off. */
function readAiEnabled(context: UiPluginContext): boolean {
  try {
    return context.getSetting('ai-enabled') === true
  } catch {
    return false
  }
}

function readSettings(context: UiPluginContext): PanelSettings {
  return {
    groupOrder: read(context, 'groupOrder', GROUP_ORDERS, 'changes-first'),
    viewMode: read(context, 'viewMode', VIEW_MODES, 'list'),
    compareBase: read(context, 'compareBase', COMPARE_BASES, 'repository-default'),
    aiEnabled: readAiEnabled(context)
  }
}

const VIEW_MODE_ID = 'setting:quirky.git/viewMode'

/**
 * The panel's settings, re-read on `setting.changed`. `setViewMode` shows the new mode at once
 * and writes it through `setting.set`; a refused write puts the stored mode back.
 */
export function useSettings(context: UiPluginContext): [PanelSettings, (mode: ViewMode) => void] {
  const [settings, setSettings] = useState(() => readSettings(context))
  useEffect(() => {
    setSettings(readSettings(context))
    return context.subscribe((event) => {
      if (event.type === 'setting.changed' && event.id.startsWith('setting:quirky.git/')) {
        setSettings((prev) => {
          const next = readSettings(context)
          return JSON.stringify(prev) === JSON.stringify(next) ? prev : next
        })
      }
    })
  }, [context])
  const setViewMode = useCallback(
    (mode: ViewMode) => {
      setSettings((prev) => ({ ...prev, viewMode: mode }))
      context.call('setting.set', { id: VIEW_MODE_ID, value: mode }).catch((error: unknown) => {
        context.toast('Could not change the view', messageOf(error))
        setSettings(readSettings(context))
      })
    },
    [context]
  )
  return [settings, setViewMode]
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const MARKER_READS_AT_ONCE = 8

/** Paths of unresolved conflicts whose working copy holds no conflict markers (or no file at all). */
async function findMarkersGone(context: UiPluginContext, worktree: string, status: GitStatus): Promise<Set<string>> {
  const gone = new Set<string>()
  const unresolved = status.entries.filter((e) => e.conflict?.state === 'unresolved' && !e.submodule)
  let next = 0
  const worker = async () => {
    while (next < unresolved.length) {
      const entry = unresolved[next++]!
      try {
        const file = (await context.call('quirky.git/conflictFile', { worktree, path: entry.path, peek: true })) as { content: string | null }
        if (file.content === null || conflictBlocks(file.content).length === 0) gone.add(entry.path)
      } catch (error) {
        // binary or linked files have no text markers to wait for
        if (dataOf(error).reason === 'not-allowed') gone.add(entry.path)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MARKER_READS_AT_ONCE, unresolved.length) }, worker))
  return gone
}

export type StatusData = {
  status: GitStatus | null
  /** A failure other than the folder refusal; the last good status stays. */
  error: string | null
  /** The sentence for a workspace opened as a folder, which has no git features. */
  unavailable: string | null
  markersGone: ReadonlySet<string>
  /** Reads the status now; resolves to it, or null when the read failed. */
  refresh(): Promise<GitStatus | null>
}

const NO_PATHS: ReadonlySet<string> = new Set()

/**
 * Polls `quirky.git/status` every 3 seconds while mounted and again on this worktree's
 * `quirky.git/changed` events. An unchanged result keeps the previous object so nothing re-renders.
 */
export function useStatus(context: UiPluginContext, worktree: string): StatusData {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [markersGone, setMarkersGone] = useState<ReadonlySet<string>>(NO_PATHS)
  const newest = useRef(0)
  const alive = useRef(true)

  const refresh = useCallback(async (): Promise<GitStatus | null> => {
    const ticket = ++newest.current
    try {
      const next = (await context.call('quirky.git/status', { worktree })) as GitStatus
      const gone = await findMarkersGone(context, worktree, next)
      if (!alive.current || ticket !== newest.current) return next
      setStatus((prev) => (same(prev, next) ? prev : next))
      setMarkersGone((prev) => (same([...prev].sort(), [...gone].sort()) ? prev : gone))
      setError(null)
      setUnavailable(null)
      return next
    } catch (e) {
      if (!alive.current || ticket !== newest.current) return null
      if (dataOf(e).reason === 'folder-workspace') setUnavailable(messageOf(e))
      else setError(messageOf(e))
      return null
    }
  }, [context, worktree])

  useEffect(() => {
    alive.current = true
    void refresh()
    const timer = setInterval(() => void refresh(), STATUS_POLL_MS)
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.git/changed') return
      const id = (event.data as { worktreeId?: unknown } | undefined)?.worktreeId
      if (typeof id !== 'string' || id === worktree) void refresh()
    })
    return () => {
      alive.current = false
      clearInterval(timer)
      unsubscribe()
    }
  }, [context, worktree, refresh])

  return { status, error, unavailable, markersGone, refresh }
}

export type CompareData = {
  compare: GitCompare | null
  /** The compare call itself failed (not an unready compare, which is a result). */
  error: string | null
  refresh(): Promise<void>
}

/**
 * Branch compare: read once `enabled` (the status has arrived), every 30 seconds, whenever
 * `trigger` changes (HEAD or the upstream commit moved, or the base setting changed) and when
 * `refresh` is called.
 */
export function useCompare(context: UiPluginContext, worktree: string, trigger: string, enabled: boolean): CompareData {
  const [compare, setCompare] = useState<GitCompare | null>(null)
  const [error, setError] = useState<string | null>(null)
  const newest = useRef(0)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    const ticket = ++newest.current
    try {
      const next = (await context.call('quirky.git/compare', { worktree })) as GitCompare
      if (!alive.current || ticket !== newest.current) return
      setCompare((prev) => (same(prev, next) ? prev : next))
      setError(null)
    } catch (e) {
      if (alive.current && ticket === newest.current) setError(messageOf(e))
    }
  }, [context, worktree])

  useEffect(() => {
    alive.current = true
    let timer: ReturnType<typeof setInterval> | undefined
    if (enabled) {
      void refresh()
      timer = setInterval(() => void refresh(), COMPARE_POLL_MS)
    }
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [refresh, trigger, enabled])

  return { compare, error, refresh }
}

/** The absolute path of the worktree, for Copy Path and dragging; null until it resolves. */
export function useWorktreePath(context: UiPluginContext, worktree: string): string | null {
  const [path, setPath] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    context
      .call('quirky.worktree/resolve', { selector: worktree })
      .then((result) => {
        if (!cancelled) setPath((result as Worktree).path)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [context, worktree])
  return path
}
