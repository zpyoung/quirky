import { Badge, Button, Tabs, TextField } from '@quirky/ui'
import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import type { ActivityPreferencePatch, ActivityWindow, SidebarProjection } from './useSidebarActivity'
const WINDOWS: Array<{ value: ActivityWindow; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'live-only', label: 'Live only' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'custom', label: 'Custom' }
]
const WINDOW_TABS = WINDOWS.map(({ value, label }) => ({ id: value, label }))

type Props = {
  projection: SidebarProjection | null
  error: string | null
  loading?: boolean
  setPreferences(patch: ActivityPreferencePatch): Promise<boolean>
}

export function ActivityFilters({ projection, error, loading = false, setPreferences }: Props) {
  const [open, setOpen] = useState(false)
  const [daysDraft, setDaysDraft] = useState<{ value: string; basedOn: number } | null>(null)
  const [daysError, setDaysError] = useState<string | null>(null)
  const committing = useRef<string | null>(null)
  const preferences = projection?.preferences
  const window = preferences?.workspaceActivityWindow
  const storedDays = preferences?.workspaceActivityCustomDays
  const days = daysDraft && daysDraft.basedOn === storedDays ? daysDraft.value : String(storedDays ?? 30)
  const badge = projection?.filterCount ?? 0

  useEffect(() => {
    setDaysDraft(null)
    committing.current = null
    setDaysError(null)
  }, [storedDays])

  const commitDays = () => {
    const value = days.trim()
    if (committing.current === value) return
    const count = Number(value)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count <= 0) {
      setDaysError('Enter a positive whole number of days.')
      return
    }
    setDaysError(null)
    committing.current = value
    void setPreferences({ workspaceActivityCustomDays: count }).then((ok) => {
      if (!ok) committing.current = null
    })
  }

  const updateDays = (event: ChangeEvent<HTMLInputElement>) => {
    setDaysDraft({ value: event.target.value, basedOn: storedDays ?? 30 })
    committing.current = null
    if (daysError) setDaysError(null)
  }

  const onDaysKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commitDays()
  }
  if (!projection && !error && !loading) return null

  return (
    <div className="ui-stack">
      {projection && (
        <div className="ui-cluster ui-toolbar">
          <Button
            type="button"
            aria-expanded={open}
            aria-controls="workspace-activity-filter-options"
            onClick={() => setOpen((value) => !value)}
          >
            Activity filters <Badge label={`${badge} active filter${badge === 1 ? '' : 's'}`}>{badge}</Badge>
          </Button>
        </div>
      )}
      {open && projection && preferences && (
        <div id="workspace-activity-filter-options" className="ui-stack" role="group" aria-label="Activity filters">
          <Tabs
            label="Workspace activity window"
            items={WINDOW_TABS}
            value={window ?? 'all'}
            onChange={(value) => void setPreferences({ workspaceActivityWindow: value as ActivityWindow })}
          />
          {window === 'custom' && (
            <TextField
              id="workspace-activity-custom-days"
              label="Custom days"
              type="text"
              inputMode="numeric"
              value={days}
              onChange={updateDays}
              onBlur={commitDays}
              onKeyDown={onDaysKeyDown}
              error={daysError ?? undefined}
            />
          )}
          {window === 'live-only' && (
            <label className="ui-checkbox-label">
              <input
                type="checkbox"
                checked={preferences.alwaysShowDefaultBranchWorkspace}
                onChange={(event) => void setPreferences({ alwaysShowDefaultBranchWorkspace: event.currentTarget.checked })}
              />
              <span>Except default branch</span>
            </label>
          )}
          <label className="ui-checkbox-label">
            <input
              type="checkbox"
              checked={preferences.hideCompletedReviewWorkspaces}
              onChange={(event) => void setPreferences({ hideCompletedReviewWorkspaces: event.currentTarget.checked })}
            />
            <span>Hide merged/closed reviews</span>
          </label>
          <label className="ui-checkbox-label">
            <input
              type="checkbox"
              checked={preferences.hidePassingCheckWorkspaces}
              onChange={(event) => void setPreferences({ hidePassingCheckWorkspaces: event.currentTarget.checked })}
            />
            <span>Hide passing checks</span>
          </label>
          <label className="ui-checkbox-label">
            <input
              type="checkbox"
              checked={preferences.hideAutomationCreated ?? false}
              onChange={(event) => void setPreferences({ hideAutomationCreated: event.currentTarget.checked })}
            />
            <span>Hide automation-created</span>
          </label>
          <div className="ui-cluster ui-actions">
            <Button
              type="button"
              onClick={() => void setPreferences({
                workspaceActivityWindow: 'all',
                hideCompletedReviewWorkspaces: false,
                hidePassingCheckWorkspaces: false,
                hideAutomationCreated: false
              })}
            >
              Clear filters
            </Button>
          </div>
        </div>
      )}
      {projection && projection.hiddenCount > 0 && (
        <Button type="button" onClick={() => void setPreferences({ workspaceActivityWindow: 'all' })}>
          Show {projection.hiddenCount} hidden {projection.hiddenCount === 1 ? 'workspace' : 'workspaces'}
        </Button>
      )}
      {projection && projection.automationHiddenCount > 0 && (
        <p className="ui-text-muted" role="status">
          {projection.automationHiddenCount} automation-created {projection.automationHiddenCount === 1 ? 'workspace' : 'workspaces'} hidden
        </p>
      )}
      {loading && !projection && <p className="ui-text-muted" role="status">Loading workspace activity filters…</p>}
      {error && <p className="ui-error-text" role="alert">Workspace activity filters unavailable: {error}</p>}
    </div>
  )
}
