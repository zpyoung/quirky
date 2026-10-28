import { useEffect, useState } from 'react'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'

const PLUGIN_ID = 'quirky.terminal-dock'

type Settings = { enabled: boolean; autoOpen: boolean }
type SettingName = keyof Settings

function readSettings(context: UiPluginContext): Settings {
  return {
    enabled: context.getSetting('enabled') === true,
    autoOpen: context.getSetting('autoOpen') === true
  }
}

function settingName(id: string): SettingName | null {
  const prefix = `setting:${PLUGIN_ID}/`
  if (!id.startsWith(prefix)) return null
  const name = id.slice(prefix.length)
  return name === 'enabled' || name === 'autoOpen' ? name : null
}

export function DockSettings({ context }: { context: UiPluginContext }) {
  const [settings, setSettings] = useState(() => readSettings(context))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    try {
      setSettings(readSettings(context))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
    return context.subscribe((event) => {
      if (event.type !== 'setting.changed') return
      const name = settingName(event.id)
      if (name === null) return
      const value = event.value === true
      setSettings((current) => ({ ...current, [name]: value }))
    })
  }, [context])

  const change = (name: SettingName, value: boolean) => {
    setSettings((current) => ({ ...current, [name]: value }))
    setError(null)
    context.call('setting.set', { id: `setting:${PLUGIN_ID}/${name}`, value }).catch((reason: unknown) => {
      try {
        setSettings(readSettings(context))
      } catch {
        // Keep the last reported values when settings cannot be read back.
      }
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }

  return (
    <section className="qtd-settings" aria-labelledby="qtd-settings-title">
      <h1 id="qtd-settings-title">Terminal dock</h1>
      <p>Compose prompts below supported agent terminals without typing into the agent interface.</p>
      <label className="qtd-setting-row">
        <input
          type="checkbox"
          aria-label="Terminal dock (Experimental)"
          checked={settings.enabled}
          onChange={(event) => change('enabled', event.currentTarget.checked)}
        />
        <span>Terminal dock <span className="qtd-settings-experimental">Experimental</span></span>
      </label>
      <label className="qtd-setting-row qtd-settings-auto-open">
        <input
          type="checkbox"
          aria-label="Open automatically for recognized agents (Experimental)"
          checked={settings.autoOpen}
          disabled={!settings.enabled}
          onChange={(event) => change('autoOpen', event.currentTarget.checked)}
        />
        <span>Open automatically for recognized agents <span className="qtd-settings-experimental">Experimental</span></span>
      </label>
      {error !== null && <p className="qtd-notice" role="alert">Could not save Terminal dock settings: {error}</p>}
    </section>
  )
}
