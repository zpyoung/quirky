import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Badge, Button, ControlIcon, ListRow, Popover, SectionHeader, TextField } from '@quirky/ui'
import { modeLabel, type Picks, type TurnSettings } from './controls'

const DEFAULT = 'Default'

export type SettingsSection = 'model' | 'effort' | 'mode'

const SEARCH_THRESHOLD = 8

const chipButton = { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-4)', borderRadius: 'var(--ui-radius-window)' } satisfies CSSProperties
const panel = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-4)', padding: 'var(--ui-space-8)', minWidth: 'calc(var(--ui-length-unit) * 240)' } satisfies CSSProperties
const segments = { display: 'flex', gap: 'var(--ui-space-2)', flexWrap: 'wrap' } satisfies CSSProperties
const switchRow = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--ui-space-8)', padding: 'var(--ui-space-4) var(--ui-space-8)' } satisfies CSSProperties
const switchGroup = { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-6)' } satisfies CSSProperties
const badgeButton = { display: 'inline-flex', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit' } satisfies CSSProperties
const badgeInner = { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-2)' } satisfies CSSProperties

const track = (on: boolean, disabled: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  width: 'calc(var(--ui-space-16) * 2)',
  height: 'var(--ui-space-16)',
  padding: 0,
  border: 'none',
  borderRadius: 'var(--ui-radius-window)',
  background: on ? 'var(--ui-accent)' : 'var(--ui-border)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : undefined
})
const knob = (on: boolean): CSSProperties => ({
  width: 'var(--ui-space-12)',
  height: 'var(--ui-space-12)',
  marginInlineStart: 'var(--ui-space-2)',
  borderRadius: '50%',
  background: 'var(--ui-surface)',
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

/**
 * The toolbar chip naming the next turn's model and effort. It opens one popover with the model list,
 * effort, permission mode and Plan; every choice applies at once through `onPicks`, and unsupported
 * ones stay visible, disabled, with the reason on hover. `open` and `section` let a `/` command open
 * it at a given section.
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
  const [search, setSearch] = useState('')
  const searchable = settings.modelList.length > SEARCH_THRESHOLD
  const query = search.trim().toLowerCase()
  const models = searchable && query ? settings.modelList.filter((entry) => entry.label.toLowerCase().includes(query)) : settings.modelList

  useEffect(() => {
    if (!open) {
      setSearch('')
      return
    }
    if (!section) return
    const first = body.current?.querySelector<HTMLElement>(`[data-section="${section}"] button:not(:disabled)`)
    first?.focus()
  }, [open, section])

  return (
    <div ref={anchor} style={{ display: 'inline-flex' }}>
      <Button style={chipButton} aria-haspopup="dialog" aria-expanded={open} onClick={() => onOpenChange(!open)}>
        {chipLabel(settings)}
        <ControlIcon name="caret-down" />
      </Button>
      <Popover open={open} label="Turn settings" anchor={anchor} onClose={() => onOpenChange(false)}>
        <div ref={body} style={panel}>
          <div data-section="model">
            <SectionHeader title="Model" />
            {searchable && <TextField label="Search models" value={search} onChange={(event) => setSearch(event.target.value)} />}
            {settings.unlisted && settings.model !== null && <ListRow compact selected title={settings.model} />}
            {models.map((entry) => (
              <ListRow
                key={entry.value}
                compact
                selected={entry.value === settings.model}
                disabled={settings.modelReason !== undefined}
                mainTitle={settings.modelReason}
                title={entry.label}
                onClick={() => onPicks({ ...picks, model: entry.value, effort: null })}
              />
            ))}
          </div>
          <div data-section="effort">
            <SectionHeader title="Effort" />
            <div style={segments} role="radiogroup" aria-label="Effort" title={settings.effortReason}>
              {settings.choices.map((choice) => (
                <Button
                  key={choice.value}
                  role="radio"
                  aria-checked={choice.value === settings.effort}
                  variant={choice.value === settings.effort ? 'primary' : 'secondary'}
                  disabled={settings.effortReason !== undefined}
                  title={settings.effortReason}
                  onClick={() => onPicks({ ...picks, effort: choice.value })}
                >
                  {choice.label}
                </Button>
              ))}
              {settings.choices.length === 0 && (
                <Button role="radio" aria-checked="false" disabled title={settings.effortReason}>Effort</Button>
              )}
            </div>
          </div>
          <div data-section="mode">
            <SectionHeader title="Permissions" />
            {settings.modes.map((name) => (
              <ListRow
                key={name}
                compact
                selected={name === settings.mode}
                title={modeLabel(name)}
                onClick={() => onPicks({ ...picks, mode: name })}
              />
            ))}
            {settings.modes.length === 0 && <ListRow compact disabled mainTitle={settings.modeReason} title="Permission mode" />}
          </div>
          <div style={switchRow} title={settings.planReason}>
            <span id="plan-switch-label">Plan mode</span>
            <span style={switchGroup}>
              <span>{picks.plan ? 'On' : 'Off'}</span>
              <button
                type="button"
                role="switch"
                aria-checked={picks.plan}
                aria-labelledby="plan-switch-label"
                disabled={settings.planReason !== undefined}
                style={track(picks.plan, settings.planReason !== undefined)}
                onClick={() => onPicks({ ...picks, plan: !picks.plan })}
              >
                <span style={knob(picks.plan)} />
              </button>
            </span>
          </div>
        </div>
      </Popover>
    </div>
  )
}

/** The badges for a permission mode or Plan that is not the default; each ✕ returns it to the default. */
export function ModeBadges({ settings, picks, onPicks }: { settings: TurnSettings; picks: Picks; onPicks: (picks: Picks) => void }) {
  const mode = settings.mode
  const defaultMode = settings.defaultMode
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
          aria-label={`Return permissions to ${modeLabel(defaultMode)}`}
          title={`Click to go back to ${modeLabel(defaultMode)}`}
          onClick={() => onPicks({ ...picks, mode: defaultMode })}
        >
          <Badge tone="needs-you">
            <span style={badgeInner}>{modeLabel(mode)} <ControlIcon name="x" /></span>
          </Badge>
        </button>
      )}
    </>
  )
}
