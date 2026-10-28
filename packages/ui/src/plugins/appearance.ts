import {
  DARK_THEME,
  DEFAULT_THEME,
  LIGHT_THEME,
  THEME_TOKENS,
  type ThemeInfo,
  type ThemeToken,
  type UiModel
} from '@quirky/protocol'

export type ThemeAppearance = 'dark' | 'light'

const SEMANTIC_ALIASES: readonly [name: string, token: ThemeToken][] = [
  ['--ui-rail', 'bg'],
  ['--ui-surface', 'bg-raised'],
  ['--ui-selected', 'bg-active'],
  ['--ui-border', 'border'],
  ['--ui-text', 'text'],
  ['--ui-muted', 'muted'],
  ['--ui-accent', 'accent'],
  ['--ui-working', 'green'],
  ['--ui-needs-you', 'amber'],
  ['--ui-failing', 'danger']
]

function valueForToken(
  themeVariables: Record<string, string>,
  palette: ThemeInfo | null,
  token: ThemeToken
): string {
  return palette?.colors[token] ?? themeVariables[`--${token}`] ?? DEFAULT_THEME.colors[token]
}

/** Applies the model's active theme, resolving only `default` against the window's system preference. */
export function applyThemeAppearance(
  root: HTMLElement,
  model: Pick<UiModel, 'themes' | 'theme'>,
  themeVariables: Record<string, string>,
  systemAppearance: ThemeAppearance
): void {
  const activeTheme = model.themes.find((candidate) => candidate.id === model.theme.active) ?? DEFAULT_THEME
  const followsSystem = activeTheme.id === DEFAULT_THEME.id
  const appearance = followsSystem ? systemAppearance : activeTheme.appearance
  const palette = followsSystem ? (appearance === 'dark' ? DARK_THEME : LIGHT_THEME) : null
  const style = root.style

  for (const token of THEME_TOKENS) {
    style.setProperty(`--${token}`, valueForToken(themeVariables, palette, token))
  }
  for (const [name, token] of SEMANTIC_ALIASES) {
    style.setProperty(name, valueForToken(themeVariables, palette, token))
  }
  root.dataset.theme = appearance
  style.colorScheme = appearance
}
