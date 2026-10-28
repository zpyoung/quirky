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

type Props = {
  projection: SidebarProjection | null
  error: string | null
  setPreferences(patch: ActivityPreferencePatch): Promise<boolean>
}

export function ActivityFilters({ projection, error, setPreferences }: Props) {
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
  if (!projection && !error) return null

  return (
    <div className="workspace-activity-controls">
      {projection && (
        <button
          className="workspace-options-button"
          type="button"
          aria-expanded={open}
          aria-label="Workspace options"
          onClick={() => setOpen((value) => !value)}
        >
          Workspace options<span className="badge" aria-label={`${badge} active filter${badge === 1 ? '' : 's'}`}>{badge}</span>
        </button>
      )}
      {open && projection && preferences && (
        <div className="workspace-options" role="group" aria-label="Filters">
          <div className="workspace-filter-options" role="group" aria-label="Workspace activity window">
            {WINDOWS.map((option) => (
              <button
                type="button"
                key={option.value}
                aria-pressed={window === option.value}
                className={window === option.value ? 'active' : undefined}
                onClick={() => void setPreferences({ workspaceActivityWindow: option.value })}
              >
                {option.label}
              </button>
            ))}
          </div>
          {window === 'custom' && (
            <label className="workspace-custom-days">
              <span>Custom days</span>
              <input
                type="text"
                inputMode="numeric"
                aria-label="Custom days"
                value={days}
                onChange={updateDays}
                onBlur={commitDays}
                onKeyDown={onDaysKeyDown}
              />
            </label>
          )}
          {window === 'custom' && daysError && <p className="form-error" role="alert">{daysError}</p>}
          {window === 'live-only' && (
            <label className="workspace-default-branch">
              <input
                type="checkbox"
                checked={preferences.alwaysShowDefaultBranchWorkspace}
                onChange={(event) => void setPreferences({ alwaysShowDefaultBranchWorkspace: event.currentTarget.checked })}
              />
              <span>Except default branch</span>
            </label>
          )}
          <label>
            <input
              type="checkbox"
              checked={preferences.hideCompletedReviewWorkspaces}
              onChange={(event) => void setPreferences({ hideCompletedReviewWorkspaces: event.currentTarget.checked })}
            />
            <span>Hide merged/closed reviews</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={preferences.hidePassingCheckWorkspaces}
              onChange={(event) => void setPreferences({ hidePassingCheckWorkspaces: event.currentTarget.checked })}
            />
            <span>Hide passing checks</span>
          </label>
          <label>
            <input
              type="checkbox"
              checked={preferences.hideAutomationCreated ?? false}
              onChange={(event) => void setPreferences({ hideAutomationCreated: event.currentTarget.checked })}
            />
            <span>Hide automation-created</span>
          </label>
          <button
            className="workspace-clear-filters"
            type="button"
            onClick={() => void setPreferences({
              workspaceActivityWindow: 'all',
              hideCompletedReviewWorkspaces: false,
              hidePassingCheckWorkspaces: false,
              hideAutomationCreated: false
            })}
          >
            Clear filters
          </button>
        </div>
      )}
      {projection && projection.hiddenCount > 0 && (
        <button className="workspace-hidden-count" type="button" onClick={() => void setPreferences({ workspaceActivityWindow: 'all' })}>
          Show {projection.hiddenCount} hidden {projection.hiddenCount === 1 ? 'workspace' : 'workspaces'}
        </button>
      )}
      {projection && projection.automationHiddenCount > 0 && (
        <p className="workspace-hidden-count" role="status">
          {projection.automationHiddenCount} automation-created {projection.automationHiddenCount === 1 ? 'workspace' : 'workspaces'} hidden
        </p>
      )}
      {error && <p className="workspace-activity-error" role="alert">Workspace activity filters unavailable: {error}</p>}
    </div>
  )
}
