import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { Button, FormRow, SectionHeader, SelectField, TextField, uiTokens } from '@quirky/ui'
import { BUILT_IN_SOUNDS, SOUND_ROW, SUBTITLE, SWITCH_ROWS } from './copy'
import { Switch } from './controls'
import type { NotificationsStore } from './model'

const pageStyle: CSSProperties = {
  display: 'flex',
  flex: 1,
  flexDirection: 'column',
  minHeight: 0,
  overflowY: 'auto'
}

const contentStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: `var(${uiTokens.space[16]})`,
  marginInline: 'auto',
  padding: `var(${uiTokens.space[24]})`,
  width: '100%'
}

const introStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: `var(${uiTokens.space[4]})`
}

const subtitleStyle: CSSProperties = {
  color: `var(${uiTokens.color.muted})`,
  fontSize: `var(${uiTokens.font.body})`,
  margin: 0
}

const settingsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column'
}

const settingRowStyle: CSSProperties = {
  borderTop: `var(${uiTokens.dimension.borderWidth}) solid var(${uiTokens.color.border})`,
  paddingBlock: `var(${uiTokens.space[12]})`
}

const soundControlsStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: `var(${uiTokens.space[8]})`
}

const customRowStyle: CSSProperties = {
  alignItems: 'center',
  display: 'flex',
  flexWrap: 'wrap',
  gap: `var(${uiTokens.space[8]})`
}

const customPathStyle: CSSProperties = {
  color: `var(${uiTokens.color.muted})`,
  fontSize: `var(${uiTokens.font.body})`,
  overflowWrap: 'anywhere'
}

const customCodeStyle: CSSProperties = {
  fontFamily: 'ui-monospace, Menlo, monospace',
  fontSize: `var(${uiTokens.font.mono})`,
  overflowWrap: 'anywhere'
}

const pathRowStyle: CSSProperties = {
  alignItems: 'center',
  display: 'grid',
  gap: `var(${uiTokens.space[8]})`,
  gridTemplateColumns: 'minmax(0, 1fr) auto'
}

const actionsStyle: CSSProperties = {
  borderTop: `var(${uiTokens.dimension.borderWidth}) solid var(${uiTokens.color.border})`,
  display: 'flex',
  justifyContent: 'flex-end',
  paddingTop: `var(${uiTokens.space[12]})`
}

const rangeStyle: CSSProperties = {
  accentColor: `var(${uiTokens.color.accent})`,
  appearance: 'auto',
  background: `var(${uiTokens.color.transparent})`,
  border: 0,
  padding: 0,
  width: '100%'
}

function Row({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div data-setting={id} style={settingRowStyle}>
      {children}
    </div>
  )
}

/** A range input that shows its draft while dragging and saves once, when the change is committed. */
function VolumeSlider({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (volume: number) => void }) {
  const id = `${useId()}-notification-sound-volume`
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  const commit = useRef(onCommit)
  commit.current = onCommit

  useEffect(() => setDraft(value), [value])
  useEffect(() => {
    const input = ref.current
    if (!input) return
    const onChange = () => commit.current(Number(input.value))
    input.addEventListener('change', onChange)
    return () => input.removeEventListener('change', onChange)
  }, [])

  return (
    <FormRow label="Notification sound volume" htmlFor={id} help={`${draft}%`}>
      <input
        ref={ref}
        id={id}
        type="range"
        min={0}
        max={100}
        step={5}
        aria-label="Notification sound volume"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(Number(event.target.value))}
        style={rangeStyle}
      />
    </FormRow>
  )
}

function CustomPath({ initial, error, busy, onUse }: { initial: string; error: string | null; busy: boolean; onUse: (path: string) => void }) {
  const [draft, setDraft] = useState(initial)
  const path = draft.trim()
  return (
    <div style={pathRowStyle}>
      <TextField
        label="Custom sound file path"
        placeholder="/absolute/path/to/sound.wav"
        spellCheck={false}
        value={draft}
        aria-invalid={error !== null}
        error={error ?? undefined}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => event.key === 'Enter' && path !== '' && onUse(path)}
      />
      <Button type="button" disabled={busy || path === ''} onClick={() => onUse(path)}>
        Use
      </Button>
    </div>
  )
}

/** Settings > Notifications: the switches, the sound controls and the test button over the plugin's declared settings. */
export function NotificationsView({ store }: { store: NotificationsStore }) {
  const { values, customOpen, customError, busy } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const idPrefix = useId()
  const off = !values.enabled
  const isCustom = values.sound === 'custom'
  const selected = customOpen || isCustom ? 'custom' : values.sound
  const customLabel = values.customSoundPath === '' ? 'Choose Custom File' : 'Change Custom File'
  const switchRow = (row: (typeof SWITCH_ROWS)[number]) => {
    const id = `${idPrefix}-${row.name}`
    const disabled = off && row.name !== 'enabled' && row.name !== 'showMenuBarIcon'
    return (
      <Row key={row.name} id={row.name}>
        <FormRow label={row.title} htmlFor={id} help={row.description}>
          <Switch
            checked={values[row.name]}
            label={row.title}
            disabled={disabled}
            onChange={(checked) => void store.set(row.name, checked)}
          />
        </FormRow>
      </Row>
    )
  }
  const [enabled, agent, bell, terminal, suppress, menuBar] = SWITCH_ROWS.map(switchRow)

  return (
    <div style={pageStyle}>
      <div style={contentStyle}>
        <div style={introStyle}>
          <SectionHeader title="Notifications" />
          <p style={subtitleStyle}>{SUBTITLE}</p>
        </div>
        <div style={settingsStyle}>
          {enabled}
          {agent}
          {bell}
          {terminal}
          <Row id="sound">
            <div style={soundControlsStyle}>
              <SelectField
                aria-label={SOUND_ROW.title}
                label={SOUND_ROW.title}
                help={SOUND_ROW.description}
                value={selected}
                disabled={off}
                onChange={(event) => void store.chooseSound(event.target.value)}
              >
                {BUILT_IN_SOUNDS.map((sound) => (
                  <option key={sound.value} value={sound.value}>
                    {sound.label}
                  </option>
                ))}
                <option disabled>──────────</option>
                <option value="custom">{customLabel}</option>
              </SelectField>
              {isCustom && (
                <div style={customRowStyle}>
                  <span style={customPathStyle}>
                    Custom: <code style={customCodeStyle}>{values.customSoundPath}</code>
                  </span>
                  {!customOpen && (
                    <Button type="button" disabled={off} onClick={() => store.openCustom()}>
                      Change
                    </Button>
                  )}
                </div>
              )}
              {customOpen && <CustomPath initial={values.customSoundPath} error={customError} busy={busy} onUse={(path) => void store.useCustom(path)} />}
              {values.sound !== 'system' && <VolumeSlider value={values.volume} disabled={off} onCommit={(volume) => void store.set('volume', volume)} />}
            </div>
          </Row>
          {suppress}
          {menuBar}
        </div>
        <div style={actionsStyle}>
          <Button variant="primary" type="button" disabled={off || busy} onClick={() => void store.sendTest()}>
            Send Test Notification
          </Button>
        </div>
      </div>
    </div>
  )
}
