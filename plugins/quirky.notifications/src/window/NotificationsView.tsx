import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { BUILT_IN_SOUNDS, SOUND_ROW, SUBTITLE, SWITCH_ROWS } from './copy'
import { Switch } from './controls'
import type { NotificationsStore } from './model'

function Row({ id, title, description, dimmed, children, extra }: { id: string; title: string; description: string; dimmed: boolean; children: ReactNode; extra?: ReactNode }) {
  return (
    <div data-setting={id} className={`notif-row${dimmed ? ' notif-dim' : ''}`}>
      <div className="notif-main">
        <div className="notif-text">
          <div className="notif-label">{title}</div>
          <p className="notif-desc">{description}</p>
        </div>
        <div className="notif-control">{children}</div>
      </div>
      {extra}
    </div>
  )
}

/** A range input that shows its draft while dragging and saves once, when the change is committed. */
function VolumeSlider({ value, disabled, onCommit }: { value: number; disabled: boolean; onCommit: (volume: number) => void }) {
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
    <div className="notif-volume">
      <input
        ref={ref}
        type="range"
        min={0}
        max={100}
        step={5}
        aria-label="Notification sound volume"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(Number(event.target.value))}
      />
      <span>{draft}%</span>
    </div>
  )
}

function CustomPath({ initial, error, busy, onUse }: { initial: string; error: string | null; busy: boolean; onUse: (path: string) => void }) {
  const [draft, setDraft] = useState(initial)
  const path = draft.trim()
  return (
    <div className="notif-path">
      <div className="notif-path-row">
        <input
          type="text"
          aria-label="Custom sound file path"
          placeholder="/absolute/path/to/sound.wav"
          spellCheck={false}
          value={draft}
          aria-invalid={error !== null}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && path !== '' && onUse(path)}
        />
        <button type="button" disabled={busy || path === ''} onClick={() => onUse(path)}>
          Use
        </button>
      </div>
      {error !== null && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** Settings > Notifications: the switches, the sound controls and the test button over the plugin's declared settings. */
export function NotificationsView({ store }: { store: NotificationsStore }) {
  const { values, customOpen, customError, busy } = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const off = !values.enabled
  const isCustom = values.sound === 'custom'
  const selected = customOpen || isCustom ? 'custom' : values.sound
  const customLabel = values.customSoundPath === '' ? 'Choose Custom File' : 'Change Custom File'
  const switchRow = (row: (typeof SWITCH_ROWS)[number]) => {
    const dimmed = off && row.name !== 'enabled' && row.name !== 'showMenuBarIcon'
    return (
      <Row key={row.name} id={row.name} title={row.title} description={row.description} dimmed={dimmed}>
        <Switch checked={values[row.name]} label={row.title} disabled={dimmed} onChange={(checked) => void store.set(row.name, checked)} />
      </Row>
    )
  }
  const [enabled, agent, bell, terminal, suppress, menuBar] = SWITCH_ROWS.map(switchRow)

  return (
    <div className="notif-page">
      <div className="notif-column">
        <header>
          <h1>Notifications</h1>
          <p className="notif-desc">{SUBTITLE}</p>
        </header>
        {enabled}
        {agent}
        {bell}
        {terminal}
        <Row
          id="sound"
          title={SOUND_ROW.title}
          description={SOUND_ROW.description}
          dimmed={off}
          extra={
            <>
              {isCustom && (
                <div className="notif-custom-row">
                  <span className="notif-custom">
                    Custom: <code>{values.customSoundPath}</code>
                  </span>
                  {!customOpen && (
                    <button type="button" disabled={off} onClick={() => store.openCustom()}>
                      Change
                    </button>
                  )}
                </div>
              )}
              {customOpen && <CustomPath initial={values.customSoundPath} error={customError} busy={busy} onUse={(path) => void store.useCustom(path)} />}
              {values.sound !== 'system' && <VolumeSlider value={values.volume} disabled={off} onCommit={(volume) => void store.set('volume', volume)} />}
            </>
          }
        >
          <select aria-label={SOUND_ROW.title} value={selected} disabled={off} onChange={(event) => void store.chooseSound(event.target.value)}>
            {BUILT_IN_SOUNDS.map((sound) => (
              <option key={sound.value} value={sound.value}>
                {sound.label}
              </option>
            ))}
            <option disabled>──────────</option>
            <option value="custom">{customLabel}</option>
          </select>
        </Row>
        {suppress}
        {menuBar}
        <div className="notif-actions">
          <button type="button" className={off ? 'notif-dim' : undefined} disabled={off || busy} onClick={() => void store.sendTest()}>
            Send Test Notification
          </button>
        </div>
      </div>
    </div>
  )
}
