import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GitCompare, GitStatus, UiPluginContext, Worktree } from '@quirky/protocol'
import { conflictBlocks } from '../view/conflict-markers'
import { dataOf, messageOf } from './format'
import { readWindowStatus, subscribeWindowStatus } from '../status-resource'

export const STATUS_POLL_MS = 3000
export const COMPARE_POLL_MS = 30_000

export type ViewMode = 'list' | 'tree'

const VIEW_MODES: readonly ViewMode[] = ['list', 'tree']
const COMPARE_BASES = ['repository-default', 'branch-upstream'] as const

/** The settings the panel reads; each falls back to its default when the setting is missing or invalid. */
export type PanelSettings = { viewMode: ViewMode; compareBase: string; aiEnabled: boolean }

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
export function useSettings(context: UiPluginContext): [PanelSettings, (mode: ViewMode, current?: () => boolean) => void] {
  const [settings, setSettings] = useState(() => readSettings(context))
  const writeVersion = useRef(0)
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
    (mode: ViewMode, current?: () => boolean) => {
      const version = ++writeVersion.current
      setSettings((prev) => ({ ...prev, viewMode: mode }))
      context.call('setting.set', { id: VIEW_MODE_ID, value: mode }).catch((error: unknown) => {
        if (version !== writeVersion.current || (current !== undefined && !current())) return
        context.toast('Could not change the view', messageOf(error), { kind: 'error' })
        setSettings(readSettings(context))
      })
    },
    [context]
  )
  return [settings, setViewMode]
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const MARKER_READS_AT_ONCE = 8

/** Finds marker-free conflicts and files that the text conflict editor cannot open. */
async function findConflictReadiness(context: UiPluginContext, worktree: string, status: GitStatus) {
  const markersGone = new Set<string>()
  const unreadableConflicts = new Set<string>()
  const unresolved = status.entries.filter((e) => e.conflict?.state === 'unresolved' && !e.submodule)
  let next = 0
  const worker = async () => {
    while (next < unresolved.length) {
      const entry = unresolved[next++]!
      try {
        const file = (await context.call('quirky.git/conflictFile', { worktree, path: entry.path, peek: true })) as { content: string | null }
        if (file.content === null || conflictBlocks(file.content).length === 0) markersGone.add(entry.path)
      } catch (error) {
        if (dataOf(error).reason === 'not-allowed') {
          markersGone.add(entry.path)
          unreadableConflicts.add(entry.path)
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MARKER_READS_AT_ONCE, unresolved.length) }, worker))
  return { markersGone, unreadableConflicts }
}

export type StatusData = {
  status: GitStatus | null
  /** A failure other than the folder refusal; the last good status stays. */
  error: string | null
  /** The sentence for a workspace opened as a folder, which has no git features. */
  unavailable: string | null
  markersGone: ReadonlySet<string>
  unreadableConflicts: ReadonlySet<string>
  /** Reads the status now; resolves to it, or null when the read failed. */
  refresh(): Promise<GitStatus | null>
}

const NO_PATHS: ReadonlySet<string> = new Set()

/**
 * Shares bounded status reads with the other Git surfaces. Equal snapshots and readiness sets
 * keep their existing object identities so an unchanged repository does not re-render.
 */
export function useStatus(context: UiPluginContext, worktree: string): StatusData {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [markersGone, setMarkersGone] = useState<ReadonlySet<string>>(NO_PATHS)
  const [unreadableConflicts, setUnreadableConflicts] = useState<ReadonlySet<string>>(NO_PATHS)
  const newest = useRef(0)
  const alive = useRef(true)
  const refreshes = useRef(new Set<AbortController>())
  const processing = useRef<{ status: GitStatus; promise: Promise<void> } | null>(null)

  const applyStatus = useCallback((next: GitStatus): Promise<void> => {
    if (!alive.current) return Promise.resolve()
    const pending = processing.current
    if (pending?.status === next) return pending.promise

    const ticket = ++newest.current
    const promise = findConflictReadiness(context, worktree, next).then((readiness) => {
      if (!alive.current || ticket !== newest.current) return
      setStatus((previous) => (same(previous, next) ? previous : next))
      setMarkersGone((previous) =>
        same([...previous].sort(), [...readiness.markersGone].sort()) ? previous : readiness.markersGone)
      setUnreadableConflicts((previous) =>
        same([...previous].sort(), [...readiness.unreadableConflicts].sort()) ? previous : readiness.unreadableConflicts)
      setError(null)
      setUnavailable(null)
    })
    const current = { status: next, promise }
    processing.current = current
    void promise.then(
      () => {
        if (processing.current === current) processing.current = null
      },
      () => {
        if (processing.current === current) processing.current = null
      }
    )
    return promise
  }, [context, worktree])

  const onStatus = useCallback((result: { status: GitStatus | null; error: unknown | null }) => {
    if (!alive.current) return
    if (result.status !== null) {
      void applyStatus(result.status)
      return
    }
    if (result.error === null) return
    newest.current += 1
    if (dataOf(result.error).reason === 'folder-workspace') setUnavailable(messageOf(result.error))
    else setError(messageOf(result.error))
  }, [applyStatus])

  const refresh = useMemo(() => {
    async function refresh(): Promise<GitStatus | null> {
      newest.current += 1
      processing.current = null
      const controller = new AbortController()
      refreshes.current.add(controller)
      try {
        const next = await readWindowStatus(context, worktree, { fresh: true, signal: controller.signal })
        if (!alive.current || controller.signal.aborted) return null
        await applyStatus(next)
        return next
      } catch {
        return null
      } finally {
        refreshes.current.delete(controller)
      }
    }
    return refresh
  }, [applyStatus, context, worktree])

  useEffect(() => {
    alive.current = true
    const unsubscribe = subscribeWindowStatus(context, worktree, STATUS_POLL_MS, onStatus)
    return () => {
      alive.current = false
      newest.current += 1
      for (const controller of refreshes.current) controller.abort()
      refreshes.current.clear()
      unsubscribe()
    }
  }, [context, onStatus, worktree])

  return { status, error, unavailable, markersGone, unreadableConflicts, refresh }
}

export type CompareData = {
  compare: GitCompare | null
  /** The compare call itself failed (not an unready compare, which is a result). */
  error: string | null
  /** A comparison for the current status/base trigger has not arrived. */
  pending: boolean
  refresh(): Promise<void>
}

/**
 * Branch compare: read once `enabled` (the status has arrived), every 30 seconds, whenever
 * `trigger` changes (HEAD or the upstream commit moved, or the base setting changed) and when
 * `refresh` is called.
 */
export function useCompare(context: UiPluginContext, worktree: string, trigger: string, enabled: boolean): CompareData {
  const [loaded, setLoaded] = useState<{ compare: GitCompare; trigger: string } | null>(null)
  const compare = loaded?.compare ?? null
  const [error, setError] = useState<string | null>(null)
  const newest = useRef(0)
  const alive = useRef(true)

  const refresh = useCallback(async function refresh(): Promise<void> {
    const ticket = ++newest.current
    try {
      const next = (await context.call('quirky.git/compare', { worktree })) as GitCompare
      if (!alive.current || ticket !== newest.current) return
      setLoaded((prev) => prev?.trigger === trigger && same(prev.compare, next) ? prev : { compare: next, trigger })
      setError(null)
    } catch (e) {
      if (alive.current && ticket === newest.current) setError(messageOf(e))
    }
  }, [context, worktree, trigger])

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

  return { compare, error, pending: enabled && loaded?.trigger !== trigger, refresh }
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
