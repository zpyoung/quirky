import { useState, type FormEvent } from 'react'
import { useAppState, useConnection, useDispatch, usePluginHost, usePluginState } from '../context'
import {
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
  toSettingsPatch,
  type SettingsDraft
} from '../lib/settingsForm'
import { settingsGroups, themePicker, type SettingField } from '../plugins/settingsGroups'
import { changedSettings, draftOf, type DraftValue } from '../plugins/settingsDraft'
import { Dialog } from './Dialog'

function PluginField({
  field,
  value,
  error,
  onChange
}: {
  field: SettingField
  value: DraftValue
  error?: string
  onChange: (value: DraftValue) => void
}) {
  const { control } = field
  const input =
    control.kind === 'checkbox' ? (
      <input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)} />
    ) : control.kind === 'number' ? (
      <input
        type="number"
        step="any"
        min={control.min}
        max={control.max}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      />
    ) : control.kind === 'select' ? (
      <select value={String(value)} onChange={(event) => onChange(event.target.value)}>
        {control.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    ) : (
      <input value={String(value)} onChange={(event) => onChange(event.target.value)} />
    )
  return (
    <>
      <label className={control.kind === 'checkbox' ? 'check-row' : undefined} title={field.description}>
        {control.kind === 'checkbox' ? (
          <>
            {input}
            {field.title}
          </>
        ) : (
          <>
            {field.title}
            {input}
          </>
        )}
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </>
  )
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const { settings } = useAppState()
  const connection = useConnection()
  const dispatch = useDispatch()
  const host = usePluginHost()
  const plugin = usePluginState()
  const groups = settingsGroups(plugin.settings)
  const themes = themePicker(plugin.model?.themes ?? [], plugin.model?.theme.chosen ?? 'default')
  const [edits, setEdits] = useState<Record<string, DraftValue>>({})
  const [themeEdit, setThemeEdit] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState<SettingsDraft>({
    worktreesRoot: settings?.worktreesRoot ?? '',
    terminalScrollback: String(settings?.terminalScrollback ?? 2000),
    notifications: settings?.notifications ?? true
  })
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const result = toSettingsPatch(draft)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    setBusy(true)
    const saved = await connection.attempt('settings.set', result.patch, 'Could not save settings')
    setBusy(false)
    if (!saved) return
    dispatch({ type: 'settings', settings: saved })

    const changes = changedSettings(plugin.settings, edits)
    const theme = themeEdit !== null && themeEdit !== themes.selected ? themeEdit : undefined
    if (Object.keys(changes).length === 0 && theme === undefined) {
      onClose()
      return
    }
    setBusy(true)
    const { errors } = await host.saveSettings({ settings: changes, theme })
    setBusy(false)
    setFieldErrors(errors)
    if (Object.keys(errors).length === 0) onClose()
  }

  return (
    <Dialog title="Settings" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label>
          Worktrees folder
          <input
            autoFocus
            value={draft.worktreesRoot}
            onChange={(event) => setDraft({ ...draft, worktreesRoot: event.target.value })}
          />
        </label>
        <label>
          Terminal scrollback (lines)
          <input
            type="number"
            min={SCROLLBACK_MIN}
            max={SCROLLBACK_MAX}
            value={draft.terminalScrollback}
            onChange={(event) => setDraft({ ...draft, terminalScrollback: event.target.value })}
          />
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={draft.notifications}
            onChange={(event) => setDraft({ ...draft, notifications: event.target.checked })}
          />
          Notifications
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {groups.map((group) => (
          <fieldset key={group.plugin} className="settings-group">
            <legend>{group.plugin}</legend>
            {group.fields.map((field) => (
              <PluginField
                key={field.id}
                field={field}
                value={draftOf(field, edits, field.id)}
                error={fieldErrors[field.id]}
                onChange={(value) => setEdits({ ...edits, [field.id]: value })}
              />
            ))}
          </fieldset>
        ))}
        {themes.options.length > 1 && (
          <>
            <label>
              Theme
              <select value={themeEdit ?? themes.selected} onChange={(event) => setThemeEdit(event.target.value)}>
                {themes.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.title}
                  </option>
                ))}
              </select>
            </label>
            {fieldErrors.theme && (
              <p className="form-error" role="alert">
                {fieldErrors.theme}
              </p>
            )}
          </>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Dialog>
  )
}
