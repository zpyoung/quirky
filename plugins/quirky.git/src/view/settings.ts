import { useCallback, useEffect, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'

const PLUGIN_ID = 'quirky.git'

/** The settings the diff view reads and its toolbar writes. */
export type SettingName =
  | 'diffDefaultView'
  | 'diffWordWrap'
  | 'diffShowWhitespace'
  | 'diffCollapseUnchanged'
  | 'combinedDiffFileTree'

export type DiffSettings = {
  sideBySide: boolean
  wrap: boolean
  showWhitespace: boolean
  collapseUnchanged: boolean
  fileTree: boolean
}

function read(context: UiPluginContext): DiffSettings {
  return {
    sideBySide: context.getSetting('diffDefaultView') === 'side-by-side',
    wrap: context.getSetting('diffWordWrap') === true,
    showWhitespace: context.getSetting('diffShowWhitespace') === true,
    collapseUnchanged: context.getSetting('diffCollapseUnchanged') === true,
    fileTree: context.getSetting('combinedDiffFileTree') === 'shown'
  }
}

function applyValue(settings: DiffSettings, name: string, value: unknown): DiffSettings {
  switch (name) {
    case 'diffDefaultView':
      return { ...settings, sideBySide: value === 'side-by-side' }
    case 'diffWordWrap':
      return { ...settings, wrap: value === true }
    case 'diffShowWhitespace':
      return { ...settings, showWhitespace: value === true }
    case 'diffCollapseUnchanged':
      return { ...settings, collapseUnchanged: value === true }
    case 'combinedDiffFileTree':
      return { ...settings, fileTree: value === 'shown' }
    default:
      return settings
  }
}

/**
 * The diff settings, live: they follow `setting.changed` events, and `setSetting` writes through
 * `setting.set` after updating the view at once so a toggle does not wait for the event.
 */
export function useDiffSettings(context: UiPluginContext): {
  settings: DiffSettings
  setSetting(name: SettingName, value: boolean | string): void
} {
  const [settings, setSettings] = useState(() => read(context))

  useEffect(() => {
    setSettings(read(context))
    return context.subscribe((event) => {
      if (event.type !== 'setting.changed') return
      const prefix = `setting:${PLUGIN_ID}/`
      if (event.id.startsWith(prefix)) setSettings((current) => applyValue(current, event.id.slice(prefix.length), event.value))
    })
  }, [context])

  const setSetting = useCallback(
    (name: SettingName, value: boolean | string) => {
      setSettings((current) => applyValue(current, name, value))
      context.call('setting.set', { id: `setting:${PLUGIN_ID}/${name}`, value }).catch((error) => {
        setSettings(read(context))
        context.toast('Setting failed', error instanceof Error ? error.message : String(error))
      })
    },
    [context]
  )

  return { settings, setSetting }
}
