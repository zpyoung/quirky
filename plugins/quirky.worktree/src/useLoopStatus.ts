import { useEffect, useMemo, useRef, useState } from 'react'
import type { UiPluginContext, Worktree } from '@quirky/protocol'
import { isRecord, layoutHostedLoopIds, parseLoopSummaries, selectLoopProjections, type LoopAvailabilityStatus, type LoopStatusSnapshot, type LoopSummary } from './loop-status'

const LOOPS_PLUGIN = 'quirky.loops'
const PLUGIN_LIST = 'plugin.list'
const SUMMARIES = 'quirky.loops/summaries'
const TERMINAL_WORKSPACE = 'quirky.terminal/workspace'
const LOOP_CHANGED = 'quirky.loops/changed'
const TERMINAL_LAYOUT_CHANGED = 'quirky.terminal/layout'

function loopsPluginIsActive(value: unknown): boolean {
  if (!Array.isArray(value)) throw new Error('The plugin list returned invalid data.')
  for (const plugin of value) {
    if (!isRecord(plugin) || typeof plugin.id !== 'string' || typeof plugin.state !== 'string') {
      throw new Error('The plugin list returned invalid data.')
    }
    if (plugin.id === LOOPS_PLUGIN) return plugin.state === 'active'
  }
  return false
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return 'Loop status is unavailable.'
}

/** Loads one shared compact snapshot and its existing hosted-view evidence for the sidebar. */
export function useLoopStatus(context: UiPluginContext, worktrees: readonly Worktree[], loaded: boolean): LoopStatusSnapshot {
  const catalogSignature = JSON.stringify([...new Set(worktrees.map((worktree) => worktree.id))].sort())
  const catalogIds = useMemo(() => new Set(JSON.parse(catalogSignature) as string[]), [catalogSignature])
  const catalogIdsRef = useRef<ReadonlySet<string>>(catalogIds)
  catalogIdsRef.current = catalogIds

  const [snapshot, setSnapshot] = useState<LoopStatusSnapshot>(() => ({ status: 'loading', error: null, byWorktree: new Map() }))
  const refreshSchedulerRef = useRef<() => void>(() => undefined)
  const lastCatalogSignatureRef = useRef<string | null>(null)

  useEffect(() => {
    if (!loaded) {
      setSnapshot({ status: 'loading', error: null, byWorktree: new Map() })
      refreshSchedulerRef.current = () => undefined
      return
    }
    setSnapshot({ status: 'loading', error: null, byWorktree: new Map() })
    let disposed = false
    let active = false
    let connected = true
    let availabilityPending = false
    let availabilityVersion = 0
    let refreshVersion = 0
    let availabilityQueued = false
    let refreshQueued = false
    let summaries: LoopSummary[] = []
    let stopFeatureListeners: (() => void) | null = null

    const publish = (
      status: LoopAvailabilityStatus,
      error: string | null,
      fresh: boolean,
      layouts: ReadonlyMap<string, ReadonlySet<string> | null> = new Map()
    ) => {
      if (disposed) return
      setSnapshot({ status, error, byWorktree: selectLoopProjections(summaries, layouts, fresh, catalogIdsRef.current) })
    }

    const refresh = async (): Promise<void> => {
      if (disposed || !active || !connected || availabilityPending) return
      const ticket = ++refreshVersion
      const isCurrent = () => !disposed && active && connected && !availabilityPending && ticket === refreshVersion
      try {
        const nextSummaries = parseLoopSummaries(await context.call(SUMMARIES, {}))
        if (!isCurrent()) return
        summaries = nextSummaries

        const worktreeIds = [...new Set(nextSummaries
          .filter((summary) => catalogIdsRef.current.has(summary.worktreeId))
          .map((summary) => summary.worktreeId))]
        const layoutRows = await Promise.all(worktreeIds.map(async (worktreeId) => {
          try {
            const layout = await context.call(TERMINAL_WORKSPACE, { workspace: worktreeId })
            return [worktreeId, layoutHostedLoopIds(layout, worktreeId)] as const
          } catch {
            return [worktreeId, null] as const
          }
        }))
        if (!isCurrent()) return
        publish('available', null, true, new Map(layoutRows))
      } catch (error) {
        if (!isCurrent()) return
        publish('unavailable', errorMessage(error), false)
      }
    }

    const scheduleRefresh = () => {
      if (disposed || !active || !connected || availabilityPending) return
      refreshVersion += 1
      if (refreshQueued) return
      refreshQueued = true
      queueMicrotask(() => {
        refreshQueued = false
        if (!disposed) void refresh()
      })
    }
    refreshSchedulerRef.current = scheduleRefresh

    const startFeatureListeners = () => {
      if (stopFeatureListeners) return
      stopFeatureListeners = context.subscribe((event) => {
        if (event.type === LOOP_CHANGED || event.type === TERMINAL_LAYOUT_CHANGED) scheduleRefresh()
      })
    }

    const stopFeatures = () => {
      stopFeatureListeners?.()
      stopFeatureListeners = null
    }

    const setActive = (next: boolean) => {
      if (active === next) return
      active = next
      if (next) startFeatureListeners()
      else stopFeatures()
    }

    const checkAvailability = async (): Promise<void> => {
      if (disposed || !connected) return
      const ticket = ++availabilityVersion
      availabilityPending = true
      refreshVersion += 1
      try {
        const available = loopsPluginIsActive(await context.call(PLUGIN_LIST))
        if (disposed || ticket !== availabilityVersion) return
        availabilityPending = false
        if (!available) {
          setActive(false)
          refreshVersion += 1
          summaries = []
          publish('disabled', null, false)
          return
        }
        const wasActive = active
        setActive(true)
        if (!wasActive && summaries.length === 0) publish('loading', null, false)
        await refresh()
      } catch (error) {
        if (disposed || ticket !== availabilityVersion) return
        availabilityPending = false
        setActive(false)
        refreshVersion += 1
        publish('unavailable', errorMessage(error), false)
      }
    }

    const scheduleAvailabilityCheck = () => {
      if (disposed) return
      availabilityVersion += 1
      refreshVersion += 1
      if (active) publish('unavailable', null, false)
      if (!connected || availabilityQueued) return
      availabilityPending = true
      availabilityQueued = true
      queueMicrotask(() => {
        availabilityQueued = false
        if (!disposed) void checkAvailability()
      })
    }

    const unsubscribePlugin = context.subscribe((event) => {
      if (event.type === 'plugin.changed') scheduleAvailabilityCheck()
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (disposed) return
      if (status === 'reconnecting') {
        connected = false
        availabilityVersion += 1
        availabilityPending = false
        refreshVersion += 1
        if (active) publish('unavailable', 'Connection unavailable.', false)
        return
      }
      connected = true
      scheduleAvailabilityCheck()
    })

    void checkAvailability()

    return () => {
      disposed = true
      active = false
      availabilityVersion += 1
      refreshVersion += 1
      refreshSchedulerRef.current = () => undefined
      stopFeatures()
      unsubscribePlugin()
      unsubscribeConnection()
    }
  }, [context, loaded])

  useEffect(() => {
    if (!loaded) {
      lastCatalogSignatureRef.current = null
      return
    }
    if (lastCatalogSignatureRef.current === null) {
      lastCatalogSignatureRef.current = catalogSignature
      return
    }
    if (lastCatalogSignatureRef.current === catalogSignature) return
    lastCatalogSignatureRef.current = catalogSignature
    refreshSchedulerRef.current()
  }, [catalogSignature, loaded])

  return snapshot
}
