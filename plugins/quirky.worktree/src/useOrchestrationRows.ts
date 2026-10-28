import { useEffect, useRef, useState } from 'react'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { hasInspectableWorkerRows, type OrchestrationWorkerRow } from './OrchestrationRows'

const ORCHESTRATION_PLUGIN = 'quirky.orchestration'
const WORKER_LIST = 'quirky.orchestration/workerList'
const PAGE_SIZE = 100
const REFRESH_MS = 15_000

type FleetPage = {
  workers: OrchestrationWorkerRow[]
  page: { nextCursor: string | null; snapshotId: string; total: number }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function parseWorkerRow(value: unknown): OrchestrationWorkerRow | null {
  if (!isRecord(value) || !isRecord(value.projection)) return null
  const projection = value.projection
  if (!isRecord(projection.liveness) || !isRecord(projection.evidence) || !isRecord(projection.stage)) return null
  const workspace = projection.workspace
  if (workspace !== null && (!isRecord(workspace) || typeof workspace.id !== 'string')) return null
  if (!['live', 'exited', 'unverifiable'].includes(String(projection.liveness.status)) ||
    typeof projection.liveness.reason !== 'string' && projection.liveness.reason !== null) return null
  if (!['fresh', 'stale', 'unavailable', 'redacted_restore'].includes(String(projection.evidence.liveStatus)) ||
    typeof projection.evidence.lastObservedAt !== 'string' && projection.evidence.lastObservedAt !== null) return null
  if (!['working', 'blocked', 'waiting', 'done', 'unknown'].includes(String(projection.stage.activity))) return null

  const resource = value.resource
  if (resource !== null && (!isRecord(resource) ||
    typeof resource.ownerDispatchId !== 'string' || typeof resource.ownershipState !== 'string' ||
    typeof resource.releaseState !== 'string' || typeof resource.worktreeId !== 'string' || typeof resource.sessionId !== 'string')) return null
  if (typeof value.dispatchId !== 'string' || typeof value.taskId !== 'string' || typeof value.runId !== 'string' ||
    typeof value.taskTitle !== 'string' || typeof value.displayName !== 'string' ||
    !nullableString(value.coordinatorSessionId) || !nullableString(value.parentSessionId) ||
    !nullableString(value.workerState) || !nullableString(value.agentTerminalHandle) ||
    typeof value.dispatchStatus !== 'string' || typeof value.terminalState !== 'string' ||
    typeof value.currentAssignment !== 'boolean') return null
  return value as unknown as OrchestrationWorkerRow
}

function parseFleetPage(value: unknown): FleetPage | null {
  if (!isRecord(value) || !Array.isArray(value.workers) || !isRecord(value.page)) return null
  const { nextCursor, snapshotId, total } = value.page
  if (!(nextCursor === null || typeof nextCursor === 'string') || typeof snapshotId !== 'string' ||
    !Number.isSafeInteger(total) || (total as number) < 0) return null
  const workers = value.workers.map(parseWorkerRow)
  if (workers.some((worker) => worker === null)) return null
  return { workers: workers as OrchestrationWorkerRow[], page: { nextCursor, snapshotId, total: total as number } }
}

function pluginIsActive(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.some((plugin) => isRecord(plugin) && plugin.id === ORCHESTRATION_PLUGIN && plugin.state === 'active')
}

async function loadSnapshot(context: UiPluginContext): Promise<OrchestrationWorkerRow[]> {
  let cursor: string | null = null
  let snapshotId: string | null = null
  let total: number | null = null
  let expectedPages = 1
  let pageCount = 0
  let rowCount = 0
  const cursors = new Set<string>()
  const dispatches = new Set<string>()
  const workers: OrchestrationWorkerRow[] = []

  while (true) {
    const params = cursor === null ? { limit: PAGE_SIZE } : { limit: PAGE_SIZE, cursor }
    const page = parseFleetPage(await context.call(WORKER_LIST, params))
    if (!page) throw new Error('The orchestration worker list returned an invalid page.')
    pageCount += 1
    if (snapshotId === null) {
      snapshotId = page.page.snapshotId
      total = page.page.total
      expectedPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    } else if (page.page.snapshotId !== snapshotId || page.page.total !== total) {
      throw new Error('The orchestration worker list changed snapshots while paging.')
    }
    rowCount += page.workers.length
    for (const worker of page.workers) {
      if (dispatches.has(worker.dispatchId)) continue
      dispatches.add(worker.dispatchId)
      workers.push(worker)
    }
    if (page.page.nextCursor === null) {
      if (rowCount !== total) throw new Error('The orchestration worker list ended before its snapshot was complete.')
      return workers
    }
    if (pageCount >= expectedPages || cursors.has(page.page.nextCursor)) {
      throw new Error('The orchestration worker list exceeded its bounded snapshot pages.')
    }
    cursors.add(page.page.nextCursor)
    cursor = page.page.nextCursor
  }
}

function isSessionEvent(event: QuirkyEvent): boolean {
  return event.type === 'quirky.session/changed' || event.type === 'quirky.session/removed'
}

/** Loads one shared bounded fleet snapshot and refreshes only while workers are present. */
export function useOrchestrationRows(context: UiPluginContext): OrchestrationWorkerRow[] {
  const [workers, setWorkers] = useState<OrchestrationWorkerRow[]>([])
  const [enabled, setEnabled] = useState(false)
  const enabledRef = useRef(false)
  const refreshRef = useRef<() => Promise<void>>(async () => undefined)

  useEffect(() => {
    let disposed = false
    let checkVersion = 0
    let refreshVersion = 0

    const refresh = async () => {
      if (disposed || !enabledRef.current) return
      const ticket = ++refreshVersion
      try {
        const rows = await loadSnapshot(context)
        if (!disposed && enabledRef.current && ticket === refreshVersion) setWorkers(rows)
      } catch {
        if (!disposed && enabledRef.current && ticket === refreshVersion) setWorkers([])
      }
    }
    refreshRef.current = refresh

    const checkAvailability = async () => {
      const ticket = ++checkVersion
      try {
        const plugins = await context.call('plugin.list')
        if (disposed || ticket !== checkVersion) return
        const available = pluginIsActive(plugins)
        if (!available) {
          if (enabledRef.current) {
            enabledRef.current = false
            refreshVersion += 1
            setWorkers([])
            setEnabled(false)
          }
          return
        }
        enabledRef.current = true
        setEnabled(true)
        await refresh()
      } catch {
        if (disposed || ticket !== checkVersion || !enabledRef.current) return
        enabledRef.current = false
        refreshVersion += 1
        setWorkers([])
        setEnabled(false)
      }
    }

    const unsubscribePlugin = context.subscribe((event) => {
      if (event.type === 'plugin.changed') void checkAvailability()
    })
    void checkAvailability()

    return () => {
      disposed = true
      enabledRef.current = false
      checkVersion += 1
      refreshVersion += 1
      refreshRef.current = async () => undefined
      unsubscribePlugin()
    }
  }, [context])

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let refreshQueued = false
    const scheduleRefresh = () => {
      if (refreshQueued) return
      refreshQueued = true
      queueMicrotask(() => {
        refreshQueued = false
        if (!disposed) void refreshRef.current()
      })
    }
    const unsubscribeSessions = context.subscribe((event) => {
      if (isSessionEvent(event)) scheduleRefresh()
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') void refreshRef.current()
    })
    return () => {
      disposed = true
      unsubscribeSessions()
      unsubscribeConnection()
    }
  }, [context, enabled])

  const hasRows = hasInspectableWorkerRows(workers)
  useEffect(() => {
    if (!enabled || !hasRows) return
    const timer = setInterval(() => void refreshRef.current(), REFRESH_MS)
    return () => clearInterval(timer)
  }, [enabled, hasRows])

  return workers
}
