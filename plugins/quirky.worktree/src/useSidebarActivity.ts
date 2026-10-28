import { useCallback, useEffect, useRef, useState } from 'react'
import { RpcErrorCode, type UiPluginContext } from '@quirky/protocol'

export type ActivityWindow = 'all' | 'live-only' | 'today' | 'week' | 'month' | 'custom'
export type ActivityPreferences = {
  workspaceActivityWindow: ActivityWindow
  workspaceActivityCustomDays: number
  alwaysShowDefaultBranchWorkspace: boolean
  workspaceActivityWindowBeforeLiveOnly: Exclude<ActivityWindow, 'live-only'>
  hideCompletedReviewWorkspaces: boolean
  hidePassingCheckWorkspaces: boolean
  hideAutomationCreated: boolean
}
export type ActivityPreferencePatch = Partial<Pick<
  ActivityPreferences,
  | 'workspaceActivityWindow'
  | 'workspaceActivityCustomDays'
  | 'alwaysShowDefaultBranchWorkspace'
  | 'hideCompletedReviewWorkspaces'
  | 'hidePassingCheckWorkspaces'
  | 'hideAutomationCreated'
>>
export type SidebarActivityState = {
  client: string
  preferences: ActivityPreferences
  active: { worktreeId: string; instanceId: string } | null
  visits: Record<string, number>
  exits: Record<string, number>
}
export type SidebarProjection = SidebarActivityState & {
  visibleIds: string[]
  hiddenIds: string[]
  hiddenCount: number
  filterCount: number
  automationHiddenIds: string[]
  automationHiddenCount: number
  reviewHiddenIds: string[]
  reviewHiddenCount: number
  workspaces: Array<{
    worktreeId: string
    activityAt: number
    live: boolean | null
    reason: 'selected' | 'all' | 'recent' | 'old' | 'live' | 'sleeping' | 'main' | 'folder' | 'unknown'
    error?: string
    reviewReason?: 'completed' | 'passing' | 'unknown'
    reviewError?: string
  }>
}
export type ActivityStatus = 'loading' | 'available' | 'missing' | 'error'

type RefreshOptions = { activate?: boolean; reloadState?: boolean }
type Failure = { status: 'missing' | 'error'; message?: string; operation?: 'load' | 'update' }

function isMissingMethod(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === RpcErrorCode.MethodNotFound
}

function isHostingReviewEvent(type: string): boolean {
  return type.startsWith('quirky.hosting/')
}

function isRefreshEvent(type: string): boolean {
  return type === 'plugin.changed' ||
    type.startsWith('quirky.repo/') ||
    type.startsWith('quirky.worktree/') ||
    type.startsWith('quirky.session/') ||
    type.startsWith('quirky.sidebar-extras/') ||
    isHostingReviewEvent(type) ||
    type.startsWith('setting.') ||
    type.startsWith('setting/') ||
    type.startsWith('settings/') ||
    type === 'ui.layout'
}

export function useSidebarActivity(context: UiPluginContext, selectedWorktree: string | null, loaded: boolean) {
  const [status, setStatus] = useState<ActivityStatus>('loading')
  const [projection, setProjection] = useState<SidebarProjection | null>(null)
  const reviewFiltersActive = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const statusRef = useRef<ActivityStatus>('loading')
  const selectedRef = useRef(selectedWorktree)
  const lastActivated = useRef<string | null | undefined>(undefined)
  const loadedRef = useRef(false)
  const stateLoaded = useRef(false)
  const latest = useRef(0)
  const pending = useRef(false)
  const pendingActivation = useRef(false)
  const pendingState = useRef(false)
  const runner = useRef<Promise<void> | null>(null)
  const refreshRef = useRef<(options?: RefreshOptions) => Promise<void>>(async () => {})
  selectedRef.current = selectedWorktree
  loadedRef.current = loaded
  if (projection) {
    reviewFiltersActive.current =
      projection.preferences.hideCompletedReviewWorkspaces || projection.preferences.hidePassingCheckWorkspaces
  }

  const setStatusValue = useCallback((next: ActivityStatus) => {
    statusRef.current = next
    setStatus(next)
  }, [])

  const reportFailure = useCallback((failure: Failure) => {
    setProjection(null)
    if (failure.status === 'missing') {
      setError(null)
      setStatusValue('missing')
      return
    }
    const message = failure.message ?? 'unknown error'
    setError(message)
    setStatusValue('error')
    context.log(`could not ${failure.operation === 'update' ? 'update' : 'load'} workspace activity filters: ${message}`)
  }, [context, setStatusValue])

  const refresh = useCallback((options: RefreshOptions = {}): Promise<void> => {
    if (!loadedRef.current) return Promise.resolve()
    if (statusRef.current === 'missing' && !options.reloadState) return Promise.resolve()

    latest.current++
    pending.current = true
    pendingActivation.current ||= options.activate === true || lastActivated.current !== selectedRef.current
    pendingState.current ||= options.reloadState === true
    if (runner.current) return runner.current

    const run = async () => {
      while (pending.current) {
        pending.current = false
        const activate = pendingActivation.current
        const loadState = pendingState.current
        const ticket = latest.current
        pendingActivation.current = false
        pendingState.current = false
        try {
          if (loadState || !stateLoaded.current) {
            await context.call('quirky.sidebar-extras/state')
            stateLoaded.current = true
          }
          if (activate) {
            const worktree = selectedRef.current
            await context.call('quirky.sidebar-extras/activate', { worktree })
            lastActivated.current = worktree
          }
          const next = await context.call('quirky.sidebar-extras/projection') as SidebarProjection
          if (ticket !== latest.current) continue
          setProjection(next)
          setError(null)
          setStatusValue('available')
        } catch (caught) {
          if (ticket !== latest.current) continue
          reportFailure(isMissingMethod(caught)
            ? { status: 'missing' }
            : { status: 'error', message: caught instanceof Error ? caught.message : String(caught) })
        }
      }
    }

    const task = run()
    runner.current = task
    void task.finally(() => {
      if (runner.current === task) runner.current = null
      if (pending.current) void refreshRef.current()
    })
    return task
  }, [context, reportFailure, setStatusValue])
  refreshRef.current = refresh

  const setPreferences = useCallback(async (patch: ActivityPreferencePatch) => {
    if (statusRef.current !== 'available') return false
    const request = ++latest.current
    try {
      await context.call('quirky.sidebar-extras/set', patch)
      await refresh()
      return statusRef.current === 'available'
    } catch (caught) {
      const missing = isMissingMethod(caught)
      const message = caught instanceof Error ? caught.message : String(caught)
      if (request === latest.current) {
        reportFailure(missing
          ? { status: 'missing' }
          : { status: 'error', message, operation: 'update' })
      } else if (!missing) {
        context.log(`could not update workspace activity filters: ${message}`)
        context.toast('Could not update workspace activity filters', message)
      }
      return false
    }
  }, [context, refresh, reportFailure])

  useEffect(() => {
    const unsubscribe = context.subscribe((event) => {
      if (!isRefreshEvent(event.type)) return
      if (isHostingReviewEvent(event.type) && !reviewFiltersActive.current) return
      if (event.type === 'plugin.changed') {
        stateLoaded.current = false
        setProjection(null)
        setError(null)
        setStatusValue('loading')
        void refresh({ reloadState: true, activate: true })
      } else {
        void refresh({ activate: event.type === 'quirky.worktree/changed' })
      }
    })
    const stopConnection = context.onConnection((connection) => {
      if (connection !== 'connected') return
      stateLoaded.current = false
      setProjection(null)
      setError(null)
      setStatusValue('loading')
      void refresh({ reloadState: true, activate: true })
    })
    return () => {
      unsubscribe()
      stopConnection()
      latest.current++
      pending.current = false
    }
  }, [context, refresh, setStatusValue])

  useEffect(() => {
    if (!loaded) return
    setProjection(null)
    setStatusValue('loading')
    void refresh({ reloadState: !stateLoaded.current, activate: true })
  }, [loaded, selectedWorktree, refresh, setStatusValue])

  const activityWindow = projection?.preferences.workspaceActivityWindow
  useEffect(() => {
    if (status !== 'available' || !activityWindow || activityWindow === 'all') return
    const timer = globalThis.setInterval(() => void refresh(), 60_000)
    return () => globalThis.clearInterval(timer)
  }, [status, activityWindow, refresh])

  return { status, projection, error, setPreferences, refresh }
}
