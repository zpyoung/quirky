import { useState, type FormEvent } from 'react'
import { useConnection, usePluginHost, usePluginState } from '../context'
import { Button, Dialog, EmptyState, FormRow, SectionHeader, SelectField, TextField } from '../design-system'
import { settingsGroups, themePicker, type SettingField } from '../plugins/settingsGroups'
import { changedSettings, draftOf, type DraftValue } from '../plugins/settingsDraft'
import { PluginSlot } from '../plugins/PluginSlot'

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
  if (control.kind === 'checkbox') {
    return (
      <FormRow label={field.title} htmlFor={field.id} help={field.description} error={error}>
        <input
          id={field.id}
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
        />
      </FormRow>
    )
  }
  if (control.kind === 'number') {
    return (
      <TextField
        id={field.id}
        label={field.title}
        help={field.description}
        error={error}
        type="number"
        step="any"
        min={control.min}
        max={control.max}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      />
    )
  }
  if (control.kind === 'select') {
    return (
      <SelectField
        id={field.id}
        label={field.title}
        help={field.description}
        error={error}
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      >
        {control.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </SelectField>
    )
  }
  return (
    <TextField
      id={field.id}
      label={field.title}
      help={field.description}
      error={error}
      value={String(value)}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const host = usePluginHost()
  const plugin = usePluginState()
  const connection = useConnection()
  const settingsViews = (plugin.model?.views ?? []).filter((view) => view.settings === true)
  const groups = settingsGroups(plugin.settings)
  const settingsSections = plugin.model?.settingsSections ?? []
  const themes = themePicker(plugin.model?.themes ?? [], plugin.model?.theme.chosen ?? 'default')
  const [edits, setEdits] = useState<Record<string, DraftValue>>({})
  const [themeEdit, setThemeEdit] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [navigationError, setNavigationError] = useState<string | null>(null)
  const settingsCommands = plugin.model?.commands.filter((command) => command.id === `command:${command.plugin}/open-settings`) ?? []
  const [openingCommand, setOpeningCommand] = useState<string | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)

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
  const openPluginSettings = async (id: string) => {
    setOpeningCommand(id)
    setCommandError(null)
    try {
      await host.runCommandForResult(id)
      onClose()
    } catch (error) {
      setOpeningCommand(null)
      setCommandError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <Dialog
      open
      title="Settings"
      onClose={onClose}
      scrollBody
      actions={
        <div className="ui-cluster">
          <Button form="settings-form" type="button" onClick={onClose}>Cancel</Button>
          <Button form="settings-form" type="submit" variant="primary" disabled={busy}>Save</Button>
        </div>
      }
    >
      <form id="settings-form" className="ui-stack" onSubmit={submit}>
        {groups.length === 0 && settingsViews.length === 0 && settingsSections.length === 0 && themes.options.length <= 1 && (
          <EmptyState message="No settings to change." />
        )}
        {settingsViews.length > 0 && (
          <section className="ui-stack" role="group" aria-label="Plugin settings">
            <SectionHeader title="Plugin settings" className="ui-settings-group-heading" />
            <div className="ui-stack">
              {settingsViews.map((view) => (
                <Button
                  key={view.id}
                  type="button"
                  disabled={busy || view.module === null}
                  title={view.module === null ? 'This settings view has no active UI module.' : view.title}
                  onClick={async () => {
                    setBusy(true)
                    setNavigationError(null)
                    try { await connection.callAny('ui.view.open', { id: view.id }); onClose() }
                    catch (error) { setNavigationError(error instanceof Error ? error.message : 'Could not open plugin settings.') }
                    finally { setBusy(false) }
                  }}
                >
                  {view.title}
                </Button>
              ))}
            </div>
            {navigationError && <p className="ui-error-text" role="alert">{navigationError}</p>}
          </section>
        )}
        {groups.map((group) =>
          group.kind === 'plugin' ? (
            <section key={`plugin:${group.plugin}`} className="ui-stack" role="group" aria-label={group.title}>
              <SectionHeader title={group.title} className="ui-settings-group-heading" />
              {renderFields(group.fields)}
            </section>
          ) : group.category !== undefined ? (
            <section key={`category:${group.category}`} className="ui-stack" role="group" aria-label={group.category}>
              <SectionHeader title={group.category} className="ui-settings-group-heading" />
              {group.sections.map((section) => (
                <div key={`section:${section.section ?? ''}`} className="ui-stack">
                  {section.section !== undefined && <SectionHeader title={section.section} />}
                  {renderFields(section.fields)}
                </div>
              ))}
            </section>
          ) : (
            group.sections.map((section) => (
              <section
                key={`section:${section.section ?? ''}`}
                className="ui-stack"
                role="group"
                aria-label={section.section ?? 'Settings'}
              >
                <SectionHeader title={section.section ?? 'Settings'} className="ui-settings-group-heading" />
                {renderFields(section.fields)}
              </section>
            ))
          )
        )}
        {settingsSections.map((section) => (
          <section key={section.id} className="ui-stack" role="group" aria-label={section.title}>
            <SectionHeader title={section.title} className="ui-settings-group-heading" />
            {section.description && <p className="ui-text-muted">{section.description}</p>}
            <PluginSlot id={section.id} />
          </section>
        ))}
        {themes.options.length > 1 && (
          <section className="ui-stack" role="group" aria-label="Appearance">
            <SectionHeader title="Appearance" className="ui-settings-group-heading" />
            <SelectField
              id="settings-theme"
              label="Theme"
              error={fieldErrors.theme}
              value={themeEdit ?? themes.selected}
              onChange={(event) => setThemeEdit(event.target.value)}
            >
              {themes.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.title}
                </option>
              ))}
            </SelectField>
          </section>
        )}
        {settingsCommands.length > 0 && (
          <section className="ui-stack" role="group" aria-label="Plugin settings commands">
            <SectionHeader title="Plugin settings" className="ui-settings-group-heading" />
            <p className="ui-text-muted">Open a plugin’s dedicated settings view.</p>
            <div className="ui-stack">
              {settingsCommands.map((command) => (
                <Button
                  key={command.id}
                  type="button"
                  data-settings-command={command.id}
                  disabled={busy || openingCommand !== null}
                  onClick={() => void openPluginSettings(command.id)}
                >
                  {openingCommand === command.id ? 'Opening…' : command.title}
                </Button>
              ))}
            </div>
            {commandError && <p className="ui-error-text" role="alert">{commandError}</p>}
          </section>
        )}
      </form>
    </Dialog>
  )
}
