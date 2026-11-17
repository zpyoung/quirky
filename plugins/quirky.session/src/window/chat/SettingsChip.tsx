import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { Badge, Button, ContextMenuList, ControlIcon, Popover, type ContextMenuItem } from '@quirky/ui'
import type { Picks, TurnSettings } from './controls'

const DEFAULT = 'Default'

export type SettingsSection = 'model' | 'effort' | 'mode'

type Panel = 'summary' | 'model' | 'mode'
type RowName = 'model' | 'effort' | 'mode' | 'plan'

const SEARCH_THRESHOLD = 8
const PLAN_DESCRIPTION = 'Read only until you approve a plan'

const chipButton = { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-4)', borderRadius: 'var(--ui-radius-window)' } satisfies CSSProperties
const panel = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-2)' } satisfies CSSProperties
const row = { minHeight: 'var(--ui-row-single)', boxSizing: 'border-box' } satisfies CSSProperties
const offRow = { color: 'var(--ui-muted)', cursor: 'default' } satisfies CSSProperties
const rowText = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-2)', flex: '1 1 auto', minWidth: 0 } satisfies CSSProperties
const rowValue = { color: 'var(--ui-muted)', whiteSpace: 'nowrap' } satisfies CSSProperties
const dangerValue = { ...rowValue, color: 'var(--ui-failing)' } satisfies CSSProperties
const stepper = { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-2)' } satisfies CSSProperties
const stepButton = { display: 'inline-flex', padding: 0, border: 'none', background: 'none', color: 'var(--ui-muted)', cursor: 'pointer' } satisfies CSSProperties
const heading = { fontWeight: 600, flex: '1 1 auto' } satisfies CSSProperties
const scroller = { maxHeight: 'calc(var(--ui-length-unit) * 288)', overflowY: 'auto' } satisfies CSSProperties
const search = { position: 'sticky', top: 0, zIndex: 1, margin: '0 0 var(--ui-space-4)' } satisfies CSSProperties
const searchInput = { flex: '1 1 auto', minWidth: 0, paddingInlineStart: 0, border: 'none', background: 'none' } satisfies CSSProperties
const hint = { display: 'flex', flexWrap: 'wrap', gap: 'var(--ui-space-4) var(--ui-space-12)', marginTop: 'var(--ui-space-4)', paddingTop: 'var(--ui-space-6)', borderTop: 'var(--ui-border-width) solid var(--ui-border)', color: 'var(--ui-muted)', fontSize: 'var(--ui-font-section)' } satisfies CSSProperties
const empty = { padding: 'var(--ui-space-8)' } satisfies CSSProperties
const badgeButton = { display: 'inline-flex', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit' } satisfies CSSProperties
const badgeInner = { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-2)' } satisfies CSSProperties

const track = (on: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  flex: '0 0 auto',
  width: 'calc(var(--ui-space-16) * 2)',
  height: 'var(--ui-space-16)',
  borderRadius: 'var(--ui-radius-window)',
  background: on ? 'var(--ui-accent)' : 'var(--ui-border)'
})
const knob = (on: boolean): CSSProperties => ({
  width: 'var(--ui-space-12)',
  height: 'var(--ui-space-12)',
  marginInlineStart: 'var(--ui-space-2)',
  borderRadius: '50%',
  background: on ? 'var(--ui-surface)' : 'var(--ui-muted)',
  transform: on ? 'translateX(var(--ui-space-16))' : undefined
})

/**
 * The closed chip's text: model and effort, or the model alone when the agent has no effort. A setting
 * the session launched without reads "Default", since the agent then runs on its own choice.
 */
export function chipLabel(settings: TurnSettings): string {
  const model =
    settings.model === null ? (settings.modelReason === undefined ? DEFAULT : undefined)
    : settings.modelList.find((entry) => entry.value === settings.model)?.label ?? settings.model
  const effort =
    settings.effortReason !== undefined ? undefined
    : settings.effort === '' ? DEFAULT
    : settings.choices.find((entry) => entry.value === settings.effort)?.label
  if (model === DEFAULT && effort === DEFAULT) return DEFAULT
  return [model, effort].filter((part): part is string => typeof part === 'string' && part !== '').join(' · ') || 'Settings'
}

const enabledRows = (root: HTMLElement | null): HTMLElement[] =>
  [...(root?.querySelectorAll<HTMLElement>('[data-settings-row]') ?? [])].filter((element) => !(element as HTMLButtonElement).disabled && element.getAttribute('aria-disabled') !== 'true')

/** A summary row naming one setting and its current value; choosing it opens that setting's list. */
function SummaryRow({ name, label, value, reason, danger, onOpen }: { name: 'model' | 'mode'; label: string; value: string; reason: string | undefined; danger?: boolean; onOpen: () => void }) {
  return (
    <button type="button" className="qt-menu-item" style={row} data-settings-row={name} data-opens={name} disabled={reason !== undefined} title={reason} onClick={onOpen}>
      <span style={rowText}>
        <span>{label}</span>
        {reason !== undefined && <span className="ui-help-text">{reason}</span>}
      </span>
      {reason === undefined && <span style={danger ? dangerValue : rowValue}>{value}</span>}
      <ControlIcon name="caret-right" />
    </button>
  )
}

/**
 * The toolbar chip naming the next turn's model and effort. It opens a summary of every turn setting
 * with its current value: Model and Permissions open their own list (models get a search field past 8
 * entries), Effort steps in place with the arrow keys, and Plan mode is a switch. Every choice applies
 * at once through `onPicks`. Unsupported settings stay visible, disabled, with the reason shown under
 * them. `open` and `section` let a `/` command open it at a given setting.
 */
export function SettingsChip({
  settings,
  picks,
  onPicks,
  open,
  section,
  onOpenChange
}: {
  settings: TurnSettings
  picks: Picks
  onPicks: (picks: Picks) => void
  open: boolean
  section: SettingsSection | null
  onOpenChange: (open: boolean) => void
}) {
  const anchor = useRef<HTMLDivElement>(null)
  const body = useRef<HTMLDivElement>(null)
  const searchField = useRef<HTMLInputElement>(null)
  const focusNext = useRef<RowName | null>(null)
  const planLabel = useId()
  const planDescription = useId()
  const [view, setView] = useState<Panel>('summary')
  const [query, setQuery] = useState('')
  const searchable = settings.modelList.length > SEARCH_THRESHOLD
  const needle = query.trim().toLowerCase()
  const models = searchable && needle ? settings.modelList.filter((entry) => entry.label.toLowerCase().includes(needle)) : settings.modelList
  const modeOff = settings.modeReason ?? (settings.modes.length === 0 ? 'No permission modes' : undefined)
  const effortIndex = settings.choices.findIndex((choice) => choice.value === settings.effort)
  const effortLabel = settings.choices[effortIndex]?.label
  const effortOff = settings.effortReason !== undefined
  const modelName = settings.model === null ? DEFAULT : settings.modelList.find((entry) => entry.value === settings.model)?.label ?? settings.model
  const effortName = effortLabel ?? (settings.effort === '' ? DEFAULT : settings.effort)

  const onShowList = (next: 'model' | 'mode', typed = '') => {
    setQuery(typed)
    setView(next)
  }
  const onShowSummary = () => {
    focusNext.current = view === 'summary' ? null : view
    setQuery('')
    setView('summary')
  }

  useEffect(() => {
    if (!open) {
      setView('summary')
      setQuery('')
      return
    }
    if (section === 'model' && settings.modelReason === undefined) setView('model')
    else if (section === 'mode' && modeOff === undefined) setView('mode')
    else focusNext.current = section
  }, [open, section])

  useEffect(() => {
    if (!open) return
    if (view === 'model' && searchable) {
      const field = searchField.current
      field?.focus()
      field?.setSelectionRange(field.value.length, field.value.length)
      return
    }
    if (view !== 'summary') return
    const rows = enabledRows(body.current)
    const wanted = focusNext.current
    focusNext.current = null
    ;(rows.find((element) => element.dataset.settingsRow === wanted) ?? rows[0])?.focus()
  }, [open, view])

  useEffect(() => {
    if (!open || view === 'summary') return
    // runs ahead of the Popover's document listener, so Escape steps back a level instead of closing
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || !body.current?.contains(document.activeElement)) return
      event.stopPropagation()
      event.preventDefault()
      onShowSummary()
    }
    window.addEventListener('keydown', escape, true)
    return () => window.removeEventListener('keydown', escape, true)
  }, [open, view])

  const onStepEffort = (direction: 1 | -1) => {
    const next = settings.choices[Math.min(settings.choices.length - 1, Math.max(0, effortIndex + direction))]
    if (next && next.value !== settings.effort) onPicks({ ...picks, effort: next.value })
  }

  const onSummaryKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = enabledRows(body.current)
    const target = event.target as HTMLElement
    const at = rows.indexOf(target)
    const focusAt = (index: number) => {
      event.preventDefault()
      rows[(index + rows.length) % rows.length]?.focus()
    }
    const opens = target.dataset.opens
    if (event.key === 'ArrowDown') focusAt(at + 1)
    else if (event.key === 'ArrowUp') focusAt(at < 0 ? rows.length - 1 : at - 1)
    else if (event.key === 'Home') focusAt(0)
    else if (event.key === 'End') focusAt(rows.length - 1)
    else if (event.key === 'ArrowRight' && (opens === 'model' || opens === 'mode')) {
      event.preventDefault()
      onShowList(opens)
    } else if (searchable && settings.modelReason === undefined && event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      onShowList('model', event.key)
    }
  }

  const onEffortKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (effortOff || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
    event.preventDefault()
    event.stopPropagation()
    onStepEffort(event.key === 'ArrowRight' ? 1 : -1)
  }

  const modelItems: ContextMenuItem[] = [
    ...(settings.unlisted && settings.model !== null ? [{ id: settings.model, label: settings.model, checked: true }] : []),
    ...models.map((entry) => ({ id: entry.value, label: entry.label, checked: entry.value === settings.model }))
  ]
  const modeItems: ContextMenuItem[] = settings.modes.map((name, index) => {
    const danger = settings.isDangerous(name)
    const description = settings.modeDescription(name) ?? (danger ? 'Acts without asking for approval' : undefined)
    return {
      id: name,
      label: settings.modeLabel(name),
      ...(description === undefined ? {} : { detail: description }),
      checked: name === settings.mode,
      danger,
      separatorBefore: danger && index > 0 && !settings.isDangerous(settings.modes[index - 1]!)
    }
  })

  const onPickRow = (item: ContextMenuItem) => {
    const id = item.id
    if (id !== undefined && view === 'model' && id !== settings.model) onPicks({ ...picks, model: id, effort: null })
    if (id !== undefined && view === 'mode' && id !== settings.mode) onPicks({ ...picks, mode: id })
    onShowSummary()
  }

  const searchHeader: ReactNode = (
    <div className="ui-popup__search" style={search}>
      <ControlIcon name="magnifying-glass" />
      <input
        ref={searchField}
        className="ui-text-field__input"
        style={searchInput}
        aria-label="Search models"
        placeholder={`Search ${settings.modelList.length} models`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
    </div>
  )

  const summary = (
    <div style={panel} onKeyDown={onSummaryKeyDown}>
      <SummaryRow name="model" label="Model" value={modelName} reason={settings.modelReason} onOpen={() => onShowList('model')} />
      <div
        role="slider"
        tabIndex={effortOff ? -1 : 0}
        aria-label="Effort"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, settings.choices.length - 1)}
        aria-valuenow={Math.max(0, effortIndex)}
        aria-valuetext={effortOff ? settings.effortReason : effortName}
        aria-disabled={effortOff || undefined}
        title={settings.effortReason}
        className="qt-menu-item"
        style={effortOff ? { ...row, ...offRow } : row}
        data-settings-row="effort"
        onKeyDown={onEffortKeyDown}
      >
        <span style={rowText}>
          <span>Effort</span>
          {effortOff && <span className="ui-help-text">{settings.effortReason}</span>}
        </span>
        {!effortOff && (
          <span style={stepper}>
            <button type="button" tabIndex={-1} style={stepButton} aria-label="Less effort" disabled={effortIndex <= 0} onClick={() => onStepEffort(-1)}>
              <ControlIcon name="caret-left" />
            </button>
            <span style={rowValue}>{effortName}</span>
            <button type="button" tabIndex={-1} style={stepButton} aria-label="More effort" disabled={effortIndex >= settings.choices.length - 1} onClick={() => onStepEffort(1)}>
              <ControlIcon name="caret-right" />
            </button>
          </span>
        )}
      </div>
      <SummaryRow name="mode" label="Permissions" value={settings.modeLabel(settings.mode)} reason={modeOff} danger={settings.isDangerous(settings.mode)} onOpen={() => onShowList('mode')} />
      <div className="qt-menu-separator" role="separator" />
      <button
        type="button"
        role="switch"
        aria-checked={picks.plan}
        aria-labelledby={planLabel}
        aria-describedby={planDescription}
        disabled={settings.planReason !== undefined}
        title={settings.planReason}
        className="qt-menu-item"
        style={row}
        data-settings-row="plan"
        onClick={() => onPicks({ ...picks, plan: !picks.plan })}
      >
        <span style={rowText}>
          <span id={planLabel}>Plan mode</span>
          <span id={planDescription} className="ui-help-text">{settings.planReason ?? PLAN_DESCRIPTION}</span>
        </span>
        <span style={track(picks.plan)} aria-hidden="true">
          <span style={knob(picks.plan)} />
        </span>
      </button>
      <div style={hint} aria-hidden="true">
        <span>↑↓ move</span>
        {!effortOff && <span>←→ effort</span>}
        <span>↵ open</span>
        {searchable && settings.modelReason === undefined && <span>type to find a model</span>}
      </div>
    </div>
  )

  const title = view === 'model' ? 'Model' : 'Permissions'
  // ArrowLeft has to move the caret in the search field, so a searchable list steps back only by Escape
  const searching = view === 'model' && searchable
  const list = (
    <div style={panel}>
      <button type="button" className="qt-menu-item" style={row} aria-label={`${title}, back to all settings`} onClick={onShowSummary}>
        <ControlIcon name="caret-left" />
        <span style={heading}>{title}</span>
        {searching && <span style={rowValue}>{settings.modelList.length}</span>}
      </button>
      <div className="ui-menu-panel" style={scroller}>
        <ContextMenuList
          key={view}
          items={view === 'model' ? modelItems : modeItems}
          label={view === 'model' ? 'Models' : 'Permission modes'}
          header={searching ? searchHeader : undefined}
          onBack={searching ? undefined : onShowSummary}
          highlightFirst
          onChoose={onPickRow}
          onClose={() => onOpenChange(false)}
        />
      </div>
      {view === 'model' && modelItems.length === 0 && <div className="ui-help-text" style={empty}>No models match</div>}
    </div>
  )

  return (
    <div ref={anchor} style={{ display: 'inline-flex' }}>
      <Button style={chipButton} aria-haspopup="dialog" aria-expanded={open} onClick={() => onOpenChange(!open)}>
        {chipLabel(settings)}
        <ControlIcon name="caret-down" />
      </Button>
      <Popover open={open} label="Turn settings" anchor={anchor} onClose={() => onOpenChange(false)}>
        <div ref={body}>{view === 'summary' ? summary : list}</div>
      </Popover>
    </div>
  )
}

/**
 * The badges for a permission mode or Plan that is not the default; each ✕ returns it to the default.
 * A mode that lets the agent act without asking gets the failing tone and says so, so it is never missed.
 */
export function ModeBadges({ settings, picks, onPicks }: { settings: TurnSettings; picks: Picks; onPicks: (picks: Picks) => void }) {
  const mode = settings.mode
  const defaultMode = settings.defaultMode
  const dangerous = settings.isDangerous(mode)
  return (
    <>
      {picks.plan && (
        <button type="button" style={badgeButton} aria-label="Turn off Plan mode" title="Click to turn off plan mode" onClick={() => onPicks({ ...picks, plan: false })}>
          <Badge tone="accent">
            <span style={badgeInner}>Plan <ControlIcon name="x" /></span>
          </Badge>
        </button>
      )}
      {defaultMode !== null && mode !== '' && mode !== defaultMode && (
        <button
          type="button"
          style={badgeButton}
          aria-label={`Return permissions to ${settings.modeLabel(defaultMode)}`}
          title={
            dangerous
              ? `${settings.modeLabel(mode)} is on: the agent acts without asking for approval. Click to go back to ${settings.modeLabel(defaultMode)}`
              : `Click to go back to ${settings.modeLabel(defaultMode)}`
          }
          data-dangerous={dangerous ? 'true' : undefined}
          onClick={() => onPicks({ ...picks, mode: defaultMode })}
        >
          <Badge tone={dangerous ? 'failing' : 'needs-you'}>
            <span style={badgeInner}>{settings.modeLabel(mode)} <ControlIcon name="x" /></span>
          </Badge>
        </button>
      )}
    </>
  )
}
