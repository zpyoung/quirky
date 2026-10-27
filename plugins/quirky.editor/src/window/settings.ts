import { useEffect, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'

export type EditorSettings = {
  autoSave: boolean
  autoSaveDelay: number
  wordWrap: boolean
  fontFamily: string
  previewTabs: boolean
  markdownSpellcheck: boolean
  markdownReviewTools: boolean
  showGitIgnored: boolean
  followSymlinkedDirectories: boolean
  fontZoomLevel: number
  minimap: boolean
  activityBarPosition: 'top' | 'side'
  sidebarWidth: number
}

function readEditorSettings(context: UiPluginContext): EditorSettings {
  const autoSave = context.getSetting('editorAutoSave')
  const autoSaveDelay = context.getSetting('editorAutoSaveDelayMs')
  const wordWrap = context.getSetting('editorWordWrap')
  const fontFamily = context.getSetting('editorFontFamily')
  const previewTabs = context.getSetting('editorPreviewTabsEnabled')
  const markdownSpellcheck = context.getSetting('richMarkdownSpellcheckEnabled')
  const markdownReviewTools = context.getSetting('markdownReviewToolsEnabled')
  const showGitIgnored = context.getSetting('showGitIgnoredFiles')
  const followSymlinkedDirectories = context.getSetting('followSymlinkedDirectories')
  const fontZoomLevel = context.getSetting('editorFontZoomLevel')
  const minimap = context.getSetting('editorMinimapEnabled')
  const activityBarPosition = context.getSetting('activityBarPosition')
  const sidebarWidth = context.getSetting('editorSidebarWidth')
  if (
    typeof autoSave !== 'boolean' || typeof autoSaveDelay !== 'number' || typeof wordWrap !== 'boolean' ||
    typeof fontFamily !== 'string' || typeof previewTabs !== 'boolean' || typeof markdownSpellcheck !== 'boolean' ||
    typeof markdownReviewTools !== 'boolean' || typeof showGitIgnored !== 'boolean' ||
    typeof followSymlinkedDirectories !== 'boolean' || typeof fontZoomLevel !== 'number' || typeof minimap !== 'boolean' ||
    (activityBarPosition !== 'top' && activityBarPosition !== 'side') || typeof sidebarWidth !== 'number'
  ) {
    throw new Error('Editor settings are missing or have invalid types.')
  }
  return {
    autoSave,
    autoSaveDelay,
    wordWrap,
    fontFamily,
    previewTabs,
    markdownSpellcheck,
    markdownReviewTools,
    showGitIgnored,
    followSymlinkedDirectories,
    fontZoomLevel,
    minimap,
    activityBarPosition,
    sidebarWidth
  }
}

export function useEditorSettings(context: UiPluginContext) {
  const [settings, setSettings] = useState(() => readEditorSettings(context))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const reload = () => {
      try {
        setSettings(readEditorSettings(context))
        setError(null)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    }
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'setting.changed' && event.id.startsWith('setting:quirky.editor/')) reload()
    })
    reload()
    return unsubscribe
  }, [context])

  return { settings, error }
}

export async function setEditorSetting(context: UiPluginContext, name: string, value: boolean | number | string): Promise<void> {
  await context.call('setting.set', { id: `setting:quirky.editor/${name}`, value })
}
