import { useEffect, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import type { ProjectGroup, Repo, WorktreeStatus } from '@quirky/protocol'
import { Button, Checkbox, Popover, TextField } from '@quirky/ui'
import { ACTIVITY_WINDOWS, type ActivityWindow, type Tag, type ViewFilter } from './view-types'

export const ACTIVITY_WINDOW_LABELS: Record<ActivityWindow, string> = {
  all: 'All',
  'live-only': 'Live only',
  today: 'Past 24 hours',
  week: 'Past 7 days',
  month: 'Past 30 days',
  custom: 'Custom'
}

type Choice = { id: string; label: string }

export type FilterCatalog = {
  tags: readonly Tag[]
  sections: readonly Pick<ProjectGroup, 'id' | 'name'>[]
  repos: readonly Repo[]
  statuses: readonly Choice[]
}

/** One active filter as the filter line names it, with the filter that results from removing it. */
export type FilterChip = { key: string; label: string; remove(filter: ViewFilter): ViewFilter }

/**
 * The filters the filter line names: tags, sections, projects, statuses and the activity filters.
 * The Hide switches for archived, CLI-created and similar worktrees are standing choices that the
 * hidden count already reports, so they never count as an active filter.
 */
export function filterChips(filter: ViewFilter, catalog: FilterCatalog): FilterChip[] {
  const chips: FilterChip[] = []
  const names = (ids: readonly string[], pool: readonly Choice[]) => ids.flatMap((id) => pool.find((item) => item.id === id) ?? [])
  const list = <K extends 'tagIds' | 'sectionIds' | 'repoIds' | 'statuses'>(key: K, prefix: string, pool: readonly Choice[]) => {
    for (const item of names(filter[key], pool)) {
      chips.push({
        key: `${key}:${item.id}`,
        label: `${prefix}: ${item.label}`,
        remove: (current) => ({ ...current, [key]: (current[key] as string[]).filter((id) => id !== item.id) })
      })
    }
  }
  list('tagIds', 'tag', catalog.tags.map((tag) => ({ id: tag.id, label: tag.name })))
  list('sectionIds', 'section', catalog.sections.map((section) => ({ id: section.id, label: section.name })))
  list('repoIds', 'project', catalog.repos.map((repo) => ({ id: repo.id, label: repo.displayName ?? repo.name })))
  list('statuses', 'status', catalog.statuses)
  const activity = filter.activity
  if (activity.workspaceActivityWindow !== 'all') {
    chips.push({
      key: 'activity-window',
      label: activity.workspaceActivityWindow === 'custom'
        ? `activity: past ${activity.workspaceActivityCustomDays} days`
        : `activity: ${ACTIVITY_WINDOW_LABELS[activity.workspaceActivityWindow].toLowerCase()}`,
      remove: (current) => ({ ...current, activity: { ...current.activity, workspaceActivityWindow: 'all' } })
    })
  }
  const hides: Array<[keyof ViewFilter['activity'], string]> = [
    ['hideCompletedReviewWorkspaces', 'merged/closed reviews hidden'],
    ['hidePassingCheckWorkspaces', 'passing checks hidden'],
    ['hideAutomationCreated', 'automation-created hidden']
  ]
  for (const [field, label] of hides) {
    if (activity[field] === true) {
      chips.push({ key: field, label, remove: (current) => ({ ...current, activity: { ...current.activity, [field]: false } }) })
    }
  }
  return chips
}

/** The filter with every line-named filter removed; the Hide switches stay as they are. */
export function clearedFilter(filter: ViewFilter): ViewFilter {
  return {
    ...filter,
    tagIds: [],
    sectionIds: [],
    repoIds: [],
    statuses: [],
    activity: {
      ...filter.activity,
      workspaceActivityWindow: 'all',
      hideCompletedReviewWorkspaces: false,
      hidePassingCheckWorkspaces: false,
      hideAutomationCreated: false
    }
  }
}

type Props = FilterCatalog & {
  anchor: RefObject<HTMLElement | null>
  filter: ViewFilter
  /** Why the activity projection is unavailable, when it is. */
  activityError?: string | null
  onChange(next: ViewFilter): void
  onClear(): void
  onClose(): void
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="worktree-tree-filter__group" role="group" aria-label={label}>
      <span className="worktree-tree-filter__heading">{label}</span>
      {children}
    </div>
  )
}

/** Picks the filter of the view on screen. Every change applies at once; there is no Apply step. */
export function FilterMenu({ anchor, filter, activityError = null, tags, sections, repos, statuses, onChange, onClear, onClose }: Props) {
  const activity = filter.activity
  const [days, setDays] = useState(String(activity.workspaceActivityCustomDays))
  const [daysError, setDaysError] = useState<string | null>(null)
  useEffect(() => {
    setDays(String(activity.workspaceActivityCustomDays))
    setDaysError(null)
  }, [activity.workspaceActivityCustomDays])

  const toggle = (key: 'tagIds' | 'sectionIds' | 'repoIds' | 'statuses', id: string, checked: boolean) => {
    const current = filter[key] as string[]
    const next = checked ? [...new Set([...current, id])] : current.filter((item) => item !== id)
    onChange({ ...filter, [key]: next } as ViewFilter)
  }
  const setActivity = (patch: Partial<ViewFilter['activity']>) => onChange({ ...filter, activity: { ...activity, ...patch } })
  const setWindow = (window: ActivityWindow) => {
    const before = window === 'live-only'
      ? activity.workspaceActivityWindow === 'live-only'
        ? activity.workspaceActivityWindowBeforeLiveOnly
        : activity.workspaceActivityWindow
      : window
    setActivity({ workspaceActivityWindow: window, workspaceActivityWindowBeforeLiveOnly: before as Exclude<ActivityWindow, 'live-only'> })
  }
  const commitDays = () => {
    const value = days.trim()
    const count = Number(value)
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count <= 0) {
      setDaysError('Enter a positive whole number of days.')
      return
    }
    setDaysError(null)
    if (count !== activity.workspaceActivityCustomDays) setActivity({ workspaceActivityCustomDays: count })
  }
  const onDaysKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    commitDays()
  }
  const hide = (label: string, key: 'hideCliCreated' | 'hideOtherDesktopClients' | 'hideDefaultBranch' | 'hideDetachedHead' | 'hideArchived') => (
    <Checkbox label={label} checked={filter[key]} onChange={(checked) => onChange({ ...filter, [key]: checked })} />
  )

  return (
    <Popover open label="Filter" anchor={anchor} onClose={onClose}>
      <div className="ui-stack worktree-tree-filter">
        <Group label="Tags">
          {tags.length === 0 ? <p className="ui-help-text">No tags yet.</p> : tags.map((tag) => (
            <span className="worktree-tree-filter__choice" key={tag.id}>
              <Checkbox label={tag.name} checked={filter.tagIds.includes(tag.id)} onChange={(checked) => toggle('tagIds', tag.id, checked)} />
              <span className="ui-swatch" data-color={tag.color ?? 'grey'} aria-hidden="true" />
            </span>
          ))}
        </Group>
        {sections.length > 0 && (
          <Group label="Sections">
            {sections.map((section) => (
              <Checkbox key={section.id} label={section.name} checked={filter.sectionIds.includes(section.id)} onChange={(checked) => toggle('sectionIds', section.id, checked)} />
            ))}
          </Group>
        )}
        {repos.length > 0 && (
          <Group label="Projects">
            {repos.map((repo) => (
              <Checkbox key={repo.id} label={repo.displayName ?? repo.name} checked={filter.repoIds.includes(repo.id)} onChange={(checked) => toggle('repoIds', repo.id, checked)} />
            ))}
          </Group>
        )}
        <Group label="Status">
          {statuses.map((status) => (
            <Checkbox key={status.id} label={status.label} checked={filter.statuses.includes(status.id as WorktreeStatus)} onChange={(checked) => toggle('statuses', status.id, checked)} />
          ))}
        </Group>
        <Group label="Activity">
          <label className="worktree-tree-filter__select">
            <span>Activity window</span>
            <select className="ui-text-field__input" aria-label="Activity window" value={activity.workspaceActivityWindow} onChange={(event) => setWindow(event.currentTarget.value as ActivityWindow)}>
              {ACTIVITY_WINDOWS.map((window) => <option key={window} value={window}>{ACTIVITY_WINDOW_LABELS[window]}</option>)}
            </select>
          </label>
          {activity.workspaceActivityWindow === 'custom' && (
            <TextField
              id="worktree-tree-filter-custom-days"
              label="Custom days"
              type="text"
              inputMode="numeric"
              value={days}
              onChange={(event) => {
                setDays(event.target.value)
                if (daysError) setDaysError(null)
              }}
              onBlur={commitDays}
              onKeyDown={onDaysKeyDown}
              error={daysError ?? undefined}
            />
          )}
          {activity.workspaceActivityWindow === 'live-only' && (
            <Checkbox label="Except default branch" checked={activity.alwaysShowDefaultBranchWorkspace} onChange={(checked) => setActivity({ alwaysShowDefaultBranchWorkspace: checked })} />
          )}
        </Group>
        {activityError && <p className="ui-error-text" role="alert">Workspace activity filters unavailable: {activityError}</p>}
        <Group label="Hide">
          <Checkbox label="Merged/closed reviews" checked={activity.hideCompletedReviewWorkspaces} onChange={(checked) => setActivity({ hideCompletedReviewWorkspaces: checked })} />
          <Checkbox label="Passing checks" checked={activity.hidePassingCheckWorkspaces} onChange={(checked) => setActivity({ hidePassingCheckWorkspaces: checked })} />
          <Checkbox label="Automation-created" checked={activity.hideAutomationCreated} onChange={(checked) => setActivity({ hideAutomationCreated: checked })} />
          {hide('CLI-created', 'hideCliCreated')}
          {hide('Other desktop clients', 'hideOtherDesktopClients')}
          {hide('Default branch', 'hideDefaultBranch')}
          {hide('Detached HEAD', 'hideDetachedHead')}
          {hide('Archived', 'hideArchived')}
        </Group>
        <div className="worktree-tree-filter__footer">
          <Button type="button" onClick={onClear}>Clear filters</Button>
          <span className="ui-help-text">Esc clears filters</span>
        </div>
      </div>
    </Popover>
  )
}
