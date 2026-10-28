import type { ITheme } from '@xterm/xterm'
import { GRAPHITE_TERMINAL_PALETTES, TERMINAL_ANSI_KEYS, type TerminalAppearanceMode, type TerminalPalette } from '@quirky/protocol'
import type { PaneSettings } from './settings'

const TANGO = ['#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
  '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec'] as const
const TANGO_ANSI = Object.fromEntries(TERMINAL_ANSI_KEYS.map((key, index) => [key, TANGO[index]])) as
  Pick<TerminalPalette, (typeof TERMINAL_ANSI_KEYS)[number]>
const ALLOWED = new Set<string>([
  'background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground', ...TERMINAL_ANSI_KEYS
])
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i

export type TerminalAppearance = { colors: TerminalPalette; warning?: string }

function palette(appearance: TerminalAppearanceMode, tango: boolean): TerminalPalette {
  const graphite = GRAPHITE_TERMINAL_PALETTES[appearance]
  if (!tango) return graphite
  return {
    ...graphite,
    ...TANGO_ANSI,
    ...(appearance === 'light'
      ? { background: '#ffffff', foreground: '#2e3436', cursor: '#2e3436' }
      : { background: '#2e3436', foreground: '#d3d7cf', cursor: '#d3d7cf' })
  }
}

/** JSON is color data only: no CSS expressions, URLs, prototype keys or partial invalid palettes. */
function customPalette(raw: string): Partial<ITheme> {
  if (raw.length > 4096) throw new Error('custom palette exceeds 4096 characters')
  const parsed: unknown = JSON.parse(raw)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('custom palette must be a JSON object')
  const colors: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (!ALLOWED.has(key) || typeof value !== 'string' || !HEX.test(value)) throw new Error(`invalid custom terminal color ${key}`)
    colors[key] = value
  }
  return colors
}

/** A terminal palette does not mutate the application theme or any other visible surface. */
export function resolveTerminalAppearance(settings: PaneSettings, inherited: TerminalPalette, systemLight: boolean): TerminalAppearance {
  const mode = settings['theme-mode'] ?? 'inherit'
  if (mode === 'inherit') return { colors: { ...inherited } }

  const appearance: TerminalAppearanceMode = mode === 'light' ? 'light' : mode === 'dark' ? 'dark' : systemLight ? 'light' : 'dark'
  const selected = appearance === 'light' ? settings['theme-light'] : settings['theme-dark']
  const colors = palette(appearance, selected === 'tango')
  if (selected !== 'custom') return { colors }
  try {
    return { colors: Object.assign({ ...colors }, customPalette(appearance === 'light' ? settings['theme-custom-light'] : settings['theme-custom-dark'])) }
  } catch (error) {
    return { colors, warning: error instanceof Error ? error.message : 'invalid custom terminal palette' }
  }
}
