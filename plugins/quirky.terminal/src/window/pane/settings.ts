import type { UiPluginContext } from '@quirky/protocol'

export type OptionAsAlt = 'auto' | 'both' | 'left' | 'right' | 'off'
export type LinkClickSetting = 'actions' | 'open' | 'terminal'

/** The terminal settings a pane reads, keyed by their setting IDs in the manifest. */
export type PaneSettings = {
  'font-family': string
  'font-size': number
  'font-weight': number
  'font-weight-bold': number
  'line-height': number
  'cursor-style': 'block' | 'bar' | 'underline'
  'cursor-blink': boolean
  scrollback: number
  'word-separators': string
  'option-as-alt': OptionAsAlt
  'jis-yen-backslash': boolean
  'copy-on-select': boolean
  'trim-gutter-on-copy': boolean
  'allow-osc52': boolean
  'right-click-paste': boolean
  'focus-follows-mouse': boolean
  'scroll-sensitivity': number
  'fast-scroll-sensitivity': number
  'gpu-acceleration': 'auto' | 'on' | 'off'
  'minimum-contrast': number
  'inactive-pane-opacity': number
  'padding-x': number
  'padding-y': number
  'background-opacity': number
  'link-click': LinkClickSetting
  'link-middle-click': LinkClickSetting
}

/** Orca's defaults, which are also the manifest defaults. */
export const DEFAULT_PANE_SETTINGS: PaneSettings = {
  'font-family': 'SF Mono',
  'font-size': 14,
  'font-weight': 500,
  'font-weight-bold': 700,
  'line-height': 1,
  'cursor-style': 'block',
  'cursor-blink': true,
  scrollback: 2000,
  'word-separators': " ()[]{}',\"`",
  'option-as-alt': 'auto',
  'jis-yen-backslash': false,
  'copy-on-select': false,
  'trim-gutter-on-copy': true,
  'allow-osc52': true,
  'right-click-paste': false,
  'focus-follows-mouse': false,
  'scroll-sensitivity': 1.15,
  'fast-scroll-sensitivity': 5,
  'gpu-acceleration': 'auto',
  'minimum-contrast': 1,
  'inactive-pane-opacity': 0.9,
  'padding-x': 4,
  'padding-y': 4,
  'background-opacity': 1,
  'link-click': 'actions',
  'link-middle-click': 'open'
}

export const FONT_SIZE_MIN = 8
export const FONT_SIZE_MAX = 32

/** Reads every pane setting from the plugin's settings, keeping the default for any the daemon doesn't know yet. */
export function readPaneSettings(context: Pick<UiPluginContext, 'getSetting'>): PaneSettings {
  const settings: Record<string, unknown> = { ...DEFAULT_PANE_SETTINGS }
  for (const id of Object.keys(DEFAULT_PANE_SETTINGS)) {
    try {
      const value = context.getSetting(id)
      if (value !== undefined && value !== null) settings[id] = value
    } catch {
      // an unknown setting keeps its default
    }
  }
  return settings as PaneSettings
}

/** The CSS font stack for a family setting: the family first, then the platform monospace fallbacks. */
export function fontStack(family: string): string {
  const trimmed = family.trim()
  const fallback = 'ui-monospace, SFMono-Regular, Menlo, monospace'
  if (!trimmed) return fallback
  const head = trimmed.includes(',') || /^['"]/.test(trimmed) || !/\s/.test(trimmed) ? trimmed : `"${trimmed}"`
  return `${head}, ${fallback}`
}

/** `base` moved by `delta` px and held to the zoom range. */
export function zoomed(base: number, delta: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, base + delta))
}
