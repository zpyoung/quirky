import { useState, type FormEvent } from 'react'
import { usePluginHost, usePluginState } from '../context'
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
  const host = usePluginHost()
  const plugin = usePluginState()
  const groups = settingsGroups(plugin.settings)
  const themes = themePicker(plugin.model?.themes ?? [], plugin.model?.theme.chosen ?? 'default')
  const [edits, setEdits] = useState<Record<string, DraftValue>>({})
  const [themeEdit, setThemeEdit] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const renderFields = (fields: SettingField[]) =>
    fields.map((field) => (
      <PluginField
        key={field.id}
        field={field}
        value={draftOf(field, edits, field.id)}
        error={fieldErrors[field.id]}
        onChange={(value) => setEdits({ ...edits, [field.id]: value })}
      />
    ))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
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
        {groups.length === 0 && themes.options.length <= 1 && <p className="muted pad">No settings to change.</p>}
        {groups.map((group) =>
          group.kind === 'plugin' ? (
            <fieldset key={`plugin:${group.plugin}`} className="settings-group">
              <legend>{group.plugin}</legend>
              {renderFields(group.fields)}
            </fieldset>
          ) : group.category !== undefined ? (
            <fieldset key={`category:${group.category}`} className="settings-group">
              <legend>{group.category}</legend>
              {group.sections.map((section) => (
                <div key={`section:${section.section ?? ''}`} className="settings-section">
                  {section.section !== undefined && <h3 className="settings-section-title">{section.section}</h3>}
                  {renderFields(section.fields)}
                </div>
              ))}
            </fieldset>
          ) : (
            group.sections.map((section) => (
              <fieldset key={`section:${section.section ?? ''}`} className="settings-group">
                <legend>{section.section}</legend>
                {renderFields(section.fields)}
              </fieldset>
            ))
          )
        )}
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
