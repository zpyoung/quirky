import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { Badge, Button, ControlIcon, ListRow, Popover, SectionHeader, TextField } from '@quirky/ui'
import { modeLabel, type Picks, type TurnSettings } from './controls'

export type SettingsSection = 'model' | 'effort' | 'mode'

const SEARCH_THRESHOLD = 8

const chipButton = { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-4)', borderRadius: 'var(--ui-radius-window)' } satisfies CSSProperties
const panel = { display: 'flex', flexDirection: 'column', gap: 'var(--ui-space-4)', padding: 'var(--ui-space-8)', minWidth: 'calc(var(--ui-length-unit) * 240)' } satisfies CSSProperties
const segments = { display: 'flex', gap: 'var(--ui-space-2)', flexWrap: 'wrap' } satisfies CSSProperties
const badgeButton = { display: 'inline-flex', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'inherit', font: 'inherit' } satisfies CSSProperties
const badgeInner = { display: 'inline-flex', alignItems: 'center', gap: 'var(--ui-space-2)' } satisfies CSSProperties
const hint = { margin: 'var(--ui-space-4) var(--ui-space-8) 0', color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' } satisfies CSSProperties
const modeNote = { color: 'var(--ui-muted)', fontSize: 'var(--ui-font-label)' } satisfies CSSProperties

const MODE_NOTES: Record<string, string> = {
  default: 'asks before edits',
  acceptEdits: 'edits without asking',
  auto: "Claude decides what's safe",
  plan: 'read-only, plan first'
}
const CYCLE_HINT = 'Shift+Tab in the composer cycles these'
const AUTO_HINT = 'Shift+Tab skips unavailable modes. Approving a plan uses Accept edits instead of Auto.'

/** The closed chip's text: model and effort, or the model alone when the agent has no effort. */
export function chipLabel(settings: TurnSettings): string {
  const model = settings.modelList.find((entry) => entry.value === settings.model)?.label ?? settings.model
  const effort = settings.effortReason === undefined ? settings.choices.find((entry) => entry.value === settings.effort)?.label : undefined
  return [model, effort].filter((part): part is string => typeof part === 'string' && part !== '').join(' · ') || 'Settings'
}

/**
 * The toolbar chip naming the next turn's model and effort. It opens one popover with the model list,
 * effort and the mode list (Ask, Accept edits, Auto, Plan); every choice applies at once through `onPicks`, and unsupported
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
            <SectionHeader title="Mode" />
            {settings.modes.map((name) => (
              <ListRow
                key={name}
                compact
                selected={name === settings.mode}
                disabled={settings.modeReasons[name] !== undefined}
                mainTitle={settings.modeReasons[name]}
                title={modeLabel(name)}
                trailing={<span style={modeNote}>{MODE_NOTES[name]}</span>}
                onClick={() => onPicks({ ...picks, mode: name })}
              />
            ))}
            {settings.modeReasons.default === undefined && (
              <p style={hint}>{settings.modeReasons.auto === undefined ? CYCLE_HINT : AUTO_HINT}</p>
            )}
          </div>
        </div>
      </Popover>
    </div>
  )
}

/** The badge for a mode other than Ask: Plan in the accent tone, the rest as a warning; its ✕ returns to Ask. */
export function ModeBadges({ settings, picks, onPicks }: { settings: TurnSettings; picks: Picks; onPicks: (picks: Picks) => void }) {
  const { mode, defaultMode } = settings
  if (mode === '' || mode === defaultMode) return null
  const plan = mode === 'plan'
  return (
    <button
      type="button"
      style={badgeButton}
      aria-label={plan ? 'Turn off Plan mode' : `Return permissions to ${modeLabel(defaultMode)}`}
      title={plan ? `Click to leave plan mode for ${modeLabel(defaultMode)}` : `Click to go back to ${modeLabel(defaultMode)}`}
      onClick={() => onPicks({ ...picks, mode: defaultMode })}
    >
      <Badge tone={plan ? 'accent' : 'needs-you'}>
        <span style={badgeInner}>{modeLabel(mode)} <ControlIcon name="x" /></span>
      </Badge>
    </button>
  )
}
